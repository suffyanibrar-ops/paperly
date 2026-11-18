import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyProcessingError } from "@/lib/security";

/* ------------------------------------------------------------------ *
 * Job engine
 *
 * One cooperative runner for every long operation in the app. It gives
 * tools a consistent progress/ETA/cancel/retry contract, normalises
 * errors into user language, and guarantees that a late completion can
 * never overwrite state from a newer run or an unmounted tool.
 * ------------------------------------------------------------------ */

export class JobCancelledError extends Error {
  constructor(message = "The operation was cancelled.") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export type JobStatus = "idle" | "running" | "success" | "error" | "cancelled";

export interface JobReporter {
  /** Aborted as soon as the user presses Cancel. */
  readonly signal: AbortSignal;
  /** True once Cancel has been pressed. */
  readonly cancelled: boolean;
  /** Report a 0–100 completion value plus optional copy. */
  report(percent: number | null, label?: string, detail?: string): void;
  /** Report `index / total` completion without doing the arithmetic yourself. */
  step(index: number, total: number, label?: string, detail?: string): void;
  /** Throw JobCancelledError when the user cancelled. Call between chunks. */
  throwIfCancelled(): void;
}

export interface JobState<T> {
  status: JobStatus;
  result: T | null;
  error: string;
  percent: number | null;
  label: string;
  detail: string;
  startedAt: number | null;
  finishedAt: number | null;
  /** Milliseconds since the current run started (updates twice a second). */
  elapsedMs: number;
  /** Rough remaining time in ms, or null when there is not enough signal. */
  etaMs: number | null;
}

export interface JobController<T> extends JobState<T> {
  busy: boolean;
  succeeded: boolean;
  failed: boolean;
  run: (task: (reporter: JobReporter) => Promise<T>) => Promise<T | null>;
  cancel: () => void;
  retry: () => void;
  reset: () => void;
}

function initialState<T>(): JobState<T> {
  return {
    status: "idle",
    result: null,
    error: "",
    percent: null,
    label: "",
    detail: "",
    startedAt: null,
    finishedAt: null,
    elapsedMs: 0,
    etaMs: null,
  };
}

/**
 * Run one cancellable job at a time.
 *
 * ```ts
 * const job = useJob<Uint8Array>();
 * const run = () => job.run(async ({ report, throwIfCancelled }) => {
 *   for (let i = 0; i < files.length; i++) {
 *     throwIfCancelled();
 *     await work(files[i]);
 *     report(((i + 1) / files.length) * 100, "Merging pages…");
 *   }
 *   return bytes;
 * });
 * ```
 */
export function useJob<T>(): JobController<T> {
  const [state, setState] = useState<JobState<T>>(initialState<T>);
  const [tick, setTick] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const runSeq = useRef(0);
  const mounted = useRef(true);
  const lastTask = useRef<((reporter: JobReporter) => Promise<T>) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  // A lightweight clock only runs while a job is active: no idle timers.
  useEffect(() => {
    if (state.status !== "running") return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(timer);
  }, [state.status]);

  const report = useCallback((seq: number, percent: number | null, label?: string, detail?: string) => {
    if (!mounted.current || seq !== runSeq.current) return;
    setState((prev) =>
      prev.status !== "running"
        ? prev
        : {
            ...prev,
            percent: percent === null ? prev.percent : Math.max(0, Math.min(100, percent)),
            label: label ?? prev.label,
            detail: detail ?? prev.detail,
          },
    );
  }, []);

  const run = useCallback(
    async (task: (reporter: JobReporter) => Promise<T>): Promise<T | null> => {
      // Starting a new run cancels any previous one cleanly.
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const seq = ++runSeq.current;
      lastTask.current = task;
      if (!mounted.current) return null;

      const startedAt = Date.now();
      setState({
        ...initialState<T>(),
        status: "running",
        startedAt,
        label: "Working locally…",
      });

      const reporter: JobReporter = {
        signal: controller.signal,
        get cancelled() {
          return controller.signal.aborted;
        },
        report: (percent, label, detail) => report(seq, percent, label, detail),
        step: (index, total, label, detail) => {
          const safeTotal = Math.max(1, total);
          report(seq, (Math.max(0, Math.min(index, safeTotal)) / safeTotal) * 100, label, detail);
        },
        throwIfCancelled: () => {
          if (controller.signal.aborted) throw new JobCancelledError();
        },
      };

      try {
        const result = await task(reporter);
        if (!mounted.current || seq !== runSeq.current) return null;
        const finishedAt = Date.now();
        setState({
          status: "success",
          result,
          error: "",
          percent: 100,
          label: "Done",
          detail: "",
          startedAt,
          finishedAt,
          elapsedMs: finishedAt - startedAt,
          etaMs: 0,
        });
        return result;
      } catch (error) {
        if (!mounted.current || seq !== runSeq.current) return null;
        const finishedAt = Date.now();
        if (controller.signal.aborted || error instanceof JobCancelledError) {
          setState({
            status: "cancelled",
            result: null,
            error: "",
            percent: null,
            label: "",
            detail: "",
            startedAt,
            finishedAt,
            elapsedMs: finishedAt - startedAt,
            etaMs: null,
          });
          return null;
        }
        setState({
          status: "error",
          result: null,
          error: friendlyProcessingError(error, "Something went wrong while processing this file."),
          percent: null,
          label: "",
          detail: "",
          startedAt,
          finishedAt,
          elapsedMs: finishedAt - startedAt,
          etaMs: null,
        });
        return null;
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [report],
  );

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    runSeq.current += 1;
    if (!mounted.current) return;
    setState((prev) =>
      prev.status === "running"
        ? { ...prev, status: "cancelled", percent: null, finishedAt: Date.now(), etaMs: null }
        : prev,
    );
  }, []);

  const retry = useCallback(() => {
    const task = lastTask.current;
    if (task) void run(task);
  }, [run]);

  const reset = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    runSeq.current += 1;
    lastTask.current = null;
    if (mounted.current) setState(initialState<T>());
  }, []);

  // `tick` is read so the component re-renders while the clock interval runs.
  void tick;
  const elapsedMs =
    state.status === "running" && state.startedAt
      ? Math.max(0, Date.now() - state.startedAt)
      : state.elapsedMs;
  const etaMs =
    state.status === "running" && state.percent !== null && state.percent > 2 && elapsedMs > 500
      ? Math.max(0, Math.round((elapsedMs * (100 - state.percent)) / state.percent))
      : null;

  return {
    ...state,
    elapsedMs,
    etaMs,
    busy: state.status === "running",
    succeeded: state.status === "success",
    failed: state.status === "error",
    run,
    cancel,
    retry,
    reset,
  };
}

/** Yield to the browser once so progress paint and Cancel clicks land. */
export function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/** Human copy for a job footer: "12.4s · about 8s left". */
export function describeJobTime(controller: Pick<JobController<unknown>, "elapsedMs" | "etaMs" | "status">): string {
  const seconds = (ms: number) => (ms < 1000 ? "<1s" : `${Math.round(ms / 1000)}s`);
  if (controller.status !== "running") return "";
  const elapsed = seconds(controller.elapsedMs);
  if (controller.etaMs && controller.etaMs > 1000) return `${elapsed} elapsed · about ${seconds(controller.etaMs)} left`;
  return `${elapsed} elapsed`;
}

/** Tool ids are accepted so callers can label diagnostics without extra state. */
export function jobDebugName(toolId?: string): string {
  return toolId ? `paperly.job.${toolId}` : "paperly.job";
}
