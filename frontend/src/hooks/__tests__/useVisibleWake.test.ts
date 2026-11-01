/**
 * useVisibleWake(QA-154) — 고정하는 규칙
 *  - 탭이 보이면 바로 읽고, 숨겨져 있으면 읽지 않고 미뤄 둔다
 *  - 다시 보이면 미뤄 둔 것을 한 번만 읽는다(여러 번 깨워도, 여러 번 숨겼다 보여도 한 번)
 *  - 자동 갱신 주기가 있으면 미뤄 둔 것을 읽지 않는다(useApi의 복귀 읽기가 맡음 — 같은 요청이 둘 나가지 않게)
 *  - 언마운트하면 visibilitychange 리스너를 지운다
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useVisibleWake } from "@/hooks/useVisibleWake";

let visibility: DocumentVisibilityState;

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

async function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
}

describe("useVisibleWake", () => {
  it("탭이 보이면 바로 읽는다", () => {
    const read = vi.fn();
    const { result } = renderHook(() => useVisibleWake(read, 0));
    act(() => result.current());
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("숨겨져 있으면 읽지 않고, 다시 보이면 한 번 읽는다 — 여러 번 깨우고 여러 번 숨겼다 보여도 한 번", async () => {
    const read = vi.fn();
    const { result } = renderHook(() => useVisibleWake(read, 0));
    await setVisibility("hidden");
    act(() => result.current());
    act(() => result.current());
    expect(read).not.toHaveBeenCalled();

    await setVisibility("visible");
    expect(read).toHaveBeenCalledTimes(1);
    await setVisibility("hidden");
    await setVisibility("visible");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("깨우지 않았으면 탭이 다시 보여도 읽지 않는다", async () => {
    const read = vi.fn();
    renderHook(() => useVisibleWake(read, 0));
    await setVisibility("hidden");
    await setVisibility("visible");
    expect(read).not.toHaveBeenCalled();
  });

  it("자동 갱신 주기가 있으면 미뤄 둔 것을 읽지 않는다 — useApi가 복귀 때 읽음", async () => {
    const read = vi.fn();
    const { result, rerender } = renderHook(({ refreshMs }) => useVisibleWake(read, refreshMs), {
      initialProps: { refreshMs: 60_000 },
    });
    await setVisibility("hidden");
    act(() => result.current());
    await setVisibility("visible");
    expect(read).not.toHaveBeenCalled();

    // 미뤄 둔 표시는 그때 지워집니다 — 주기가 꺼진 뒤 다시 숨겼다 보여도 옛 깨우기를 읽지 않습니다.
    rerender({ refreshMs: 0 });
    await setVisibility("hidden");
    await setVisibility("visible");
    expect(read).not.toHaveBeenCalled();
  });

  it("언마운트하면 리스너를 지운다", async () => {
    const read = vi.fn();
    const remove = vi.spyOn(document, "removeEventListener");
    const { result, unmount } = renderHook(() => useVisibleWake(read, 0));
    await setVisibility("hidden");
    act(() => result.current());
    unmount();
    expect(remove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    await setVisibility("visible");
    expect(read).not.toHaveBeenCalled();
  });
});
