import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobCancelledError, describeJobTime, nextPaint, useJob } from "@/lib/job";

describe("job engine", () => {
  it("runs a job and exposes progress plus the result", async () => {
    const { result } = renderHook(() => useJob<number>());
    let output: number | null = null;
    await act(async () => {
      output = await result.current.run(async ({ report }) => {
        report(40, "Halfway");
        return 7;
      });
    });
    expect(output).toBe(7);
    expect(result.current.status).toBe("success");
    expect(result.current.result).toBe(7);
    expect(result.current.percent).toBe(100);
    expect(result.current.busy).toBe(false);
  });

  it("normalises errors into user language", async () => {
    const { result } = renderHook(() => useJob<void>());
    await act(async () => {
      await result.current.run(async () => {
        throw new Error("Array buffer allocation failed");
      });
    });
    expect(result.current.status).toBe("error");
    expect(result.current.error).toMatch(/ran out of memory/i);
  });

  it("treats JobCancelledError as cancellation, not failure", async () => {
    const { result } = renderHook(() => useJob<void>());
    await act(async () => {
      await result.current.run(async () => {
        throw new JobCancelledError();
      });
    });
    expect(result.current.status).toBe("cancelled");
    expect(result.current.error).toBe("");

    const second = renderHook(() => useJob<void>());
    await act(async () => {
      await second.result.current.run(async ({ throwIfCancelled }) => {
        throwIfCancelled();
        expect(true).toBe(true);
      });
    });
    expect(second.result.current.status).toBe("success");
  });

  it("cancels a running job and ignores its late result", async () => {
    const { result } = renderHook(() => useJob<number>());
    let settle: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let pending: Promise<number | null> = Promise.resolve(null);
    act(() => {
      pending = result.current.run(async () => {
        await gate;
        return 99;
      });
    });
    expect(result.current.status).toBe("running");
    act(() => result.current.cancel());
    expect(result.current.status).toBe("cancelled");
    await act(async () => {
      settle?.();
      await pending;
    });
    expect(result.current.result).toBeNull();
  });

  it("retries the last task", async () => {
    const { result } = renderHook(() => useJob<void>());
    const task = vi.fn(async () => {
      throw new Error("nope");
    });
    await act(async () => {
      await result.current.run(task);
    });
    expect(task).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.retry();
      await nextPaint();
    });
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("formats elapsed/ETA copy and resolves nextPaint", async () => {
    expect(describeJobTime({ elapsedMs: 400, etaMs: null, status: "running" })).toBe("<1s elapsed");
    expect(describeJobTime({ elapsedMs: 12_400, etaMs: 8_000, status: "running" })).toBe("12s elapsed · about 8s left");
    expect(describeJobTime({ elapsedMs: 12_400, etaMs: 8_000, status: "success" })).toBe("");
    await expect(nextPaint()).resolves.toBeUndefined();
  });
});
