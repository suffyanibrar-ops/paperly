import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAllPreferences,
  clearPreferences,
  hasPreferences,
  listPreferenceScopes,
  readPreferences,
  usePreferences,
  useStickyFlag,
  writePreferences,
} from "@/lib/prefs";

const KEY = "paperly.prefs.v1.test";

beforeEach(() => {
  localStorage.clear();
});

describe("preference engine", () => {
  it("returns defaults when nothing is stored", () => {
    expect(readPreferences("test", { a: 1, b: "x" })).toEqual({ a: 1, b: "x" });
    expect(hasPreferences("test")).toBe(false);
  });

  it("merges stored values over new defaults", () => {
    writePreferences("test", { a: 2 });
    expect(readPreferences("test", { a: 1, b: "x" })).toEqual({ a: 2, b: "x" });
    expect(hasPreferences("test")).toBe(true);
  });

  it("ignores corrupted or future-version payloads", () => {
    localStorage.setItem(KEY, "not-json");
    expect(readPreferences("test", { a: 1 })).toEqual({ a: 1 });
    localStorage.setItem(KEY, JSON.stringify({ version: 99, value: { a: 5 } }));
    expect(readPreferences("test", { a: 1 })).toEqual({ a: 1 });
  });

  it("lists and clears every remembered scope", () => {
    writePreferences("one", { a: 1 });
    writePreferences("two", { b: 2 });
    expect(listPreferenceScopes().sort()).toEqual(["one", "two"]);
    expect(clearAllPreferences()).toBe(2);
    expect(listPreferenceScopes()).toEqual([]);
    expect(readPreferences("one", { a: 9 })).toEqual({ a: 9 });
  });

  it("clears a scope", () => {
    writePreferences("test", { a: 2 });
    clearPreferences("test");
    expect(hasPreferences("test")).toBe(false);
    expect(readPreferences("test", { a: 1 })).toEqual({ a: 1 });
  });

  it("updates, patches and resets through the hook", () => {
    const { result } = renderHook(() => usePreferences("test", { quality: 80, gray: false }));
    expect(result.current.changed).toBe(false);

    act(() => result.current.set("quality", 55));
    expect(result.current.value.quality).toBe(55);
    expect(result.current.changed).toBe(true);
    expect(readPreferences("test", { quality: 80, gray: false }).quality).toBe(55);

    act(() => result.current.patch({ quality: 70, gray: true }));
    expect(result.current.value).toEqual({ quality: 70, gray: true });

    act(() => result.current.reset());
    expect(result.current.value).toEqual({ quality: 80, gray: false });
    expect(result.current.changed).toBe(false);
  });

  it("syncs two hook instances on the same scope", async () => {
    const first = renderHook(() => usePreferences("sync", { level: "a" }));
    const second = renderHook(() => usePreferences("sync", { level: "a" }));
    act(() => first.result.current.set("level", "b"));
    await waitFor(() => expect(second.result.current.value.level).toBe("b"));
  });

  it("persists a sticky UI flag", () => {
    const { result } = renderHook(() => useStickyFlag("panel", false));
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(readPreferences("ui.panel", { on: false }).on).toBe(true);
  });
});
