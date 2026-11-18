/**
 * 새로 고침·바로 연 주소의 #절 맞추기(hooks/useHashAlign — 작업대 P6, SectionIndex alignHashOnLoad).
 *
 *  - 주소의 해시가 목차 칸이면 처음 그린 뒤 그 닻으로 옮긴다(scrollIntoView) — 목차 밖 해시·해시 없음·꺼짐이면 아무것도 하지 않는다
 *  - 닻이 아직 없으면 생길 때(MutationObserver) 옮긴다
 *  - 닻(과 조상)의 크기가 바뀌면(ResizeObserver — 위쪽 절이 자람) 다시 맞추고, 사용자 입력(wheel·touchstart·keydown·pointerdown)이나 10초 뒤 그친다
 */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HASH_ALIGN_MAX_MS, useHashAlign } from "../useHashAlign";

const IDS = ["paper-frame-current", "paper-frame-versions", "paper-frame-proposals"];

let scrolled: string[] = [];
/** 걸린 ResizeObserver 콜백(관찰 대상이 여럿이어도 한 번 — 닻과 조상을 함께 봄). */
let resize = new Set<() => void>();

beforeEach(() => {
  scrolled = [];
  resize = new Set();
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolled.push(this.id);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: () => void;
      constructor(callback: () => void) {
        this.callback = callback;
      }
      observe() {
        resize.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        resize.delete(this.callback);
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/");
});

function Page({ enabled = true, ready = true }: { enabled?: boolean; ready?: boolean }) {
  useHashAlign(IDS, enabled);
  return (
    <main>
      <div id="paper-frame-current">지금 판</div>
      {ready ? <div id="paper-frame-versions">판 이력</div> : null}
    </main>
  );
}

const fireResize = () => act(() => resize.forEach((callback) => callback()));

describe("useHashAlign", () => {
  it("주소의 해시가 목차 칸이면 처음 그린 뒤 그 닻으로 옮긴다", () => {
    window.history.replaceState(null, "", "/paper/us/framework#paper-frame-versions");
    render(<Page />);
    expect(scrolled).toEqual(["paper-frame-versions"]);
  });

  it("목차 밖 해시·해시 없음·꺼짐이면 옮기지 않는다", () => {
    window.history.replaceState(null, "", "/paper/us/framework#main");
    render(<Page />);
    cleanup();
    window.history.replaceState(null, "", "/paper/us/framework");
    render(<Page />);
    cleanup();
    window.history.replaceState(null, "", "/paper/us/framework#paper-frame-versions");
    render(<Page enabled={false} />);
    expect(scrolled).toEqual([]);
    expect(resize.size).toBe(0);
  });

  it("닻이 아직 없으면 생길 때 옮긴다", async () => {
    window.history.replaceState(null, "", "/paper/us/framework#paper-frame-versions");
    const { rerender } = render(<Page ready={false} />);
    expect(scrolled).toEqual([]);
    rerender(<Page ready />);
    // MutationObserver 콜백은 마이크로태스크로 옵니다.
    await act(async () => {});
    expect(scrolled).toEqual(["paper-frame-versions"]);
  });

  it("위가 자라면(ResizeObserver) 다시 맞추고, 사용자 입력이 오면 그친다", () => {
    window.history.replaceState(null, "", "/paper/us/framework#paper-frame-versions");
    render(<Page />);
    fireResize();
    fireResize();
    expect(scrolled).toHaveLength(3);
    act(() => {
      window.dispatchEvent(new Event("wheel"));
    });
    fireResize();
    expect(scrolled).toHaveLength(3);
    expect(resize.size).toBe(0);
  });

  it.each(["touchstart", "keydown", "pointerdown"])("%s도 맞춤을 그친다", (type) => {
    window.history.replaceState(null, "", "/paper/us/framework#paper-frame-current");
    render(<Page />);
    act(() => {
      window.dispatchEvent(new Event(type));
    });
    fireResize();
    expect(scrolled).toEqual(["paper-frame-current"]);
  });

  it("10초가 지나면 그친다", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    window.history.replaceState(null, "", "/paper/us/framework#paper-frame-current");
    render(<Page />);
    fireResize();
    expect(scrolled).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(HASH_ALIGN_MAX_MS);
    });
    fireResize();
    expect(scrolled).toHaveLength(2);
  });

  it("화면을 떠나면(언마운트) 듣기를 모두 거둔다", () => {
    window.history.replaceState(null, "", "/paper/us/framework#paper-frame-current");
    const remove = vi.spyOn(window, "removeEventListener");
    const { unmount } = render(<Page />);
    unmount();
    expect(resize.size).toBe(0);
    expect(remove.mock.calls.map(([type]) => type).sort()).toEqual(expect.arrayContaining(["keydown", "pointerdown", "touchstart", "wheel"]));
  });
});
