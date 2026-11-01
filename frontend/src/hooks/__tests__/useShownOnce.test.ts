/**
 * useShownOnce(QA-156) — 고정하는 규칙
 *  - 보이는 탭에서 마운트되면 처음부터 true
 *  - 숨긴 탭에서 마운트되면 false, 처음 보일 때 true — 그 뒤 다시 숨겨도 true
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useShownOnce } from "@/hooks/useShownOnce";

let visibility: DocumentVisibilityState;

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}

describe("useShownOnce", () => {
  it("보이는 탭에서 마운트되면 처음부터 true", () => {
    const { result } = renderHook(() => useShownOnce());
    expect(result.current).toBe(true);
  });

  it("숨긴 탭이면 false, 처음 보일 때 true — 다시 숨겨도 true", async () => {
    visibility = "hidden";
    const { result } = renderHook(() => useShownOnce());
    expect(result.current).toBe(false);
    await setVisibility("hidden");
    expect(result.current).toBe(false);

    await setVisibility("visible");
    expect(result.current).toBe(true);
    await setVisibility("hidden");
    expect(result.current).toBe(true);
  });
});
