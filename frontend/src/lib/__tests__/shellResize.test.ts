/**
 * 셸 폭이 바뀌는 중인가(lib/shellResize — QA-601): 끌기(drag)와 전환(motion) 두 원천의 OR, 합친 값이 바뀔 때만 알림, 구독 해제.
 * 손잡이가 언제 켜고 끄는지는 shell/__tests__/SideNavResize.test, 차트가 폭을 잡아 두는 것은 charts/__tests__/wrappers.test·LineChart.test가 봅니다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isShellResizing, resetShellResizingForTest, setShellResizing, subscribeShellResizing } from "@/lib/shellResize";

afterEach(() => resetShellResizingForTest());

describe("셸 폭 신호", () => {
  it("처음에는 꺼짐 — 끌기나 전환 가운데 하나라도 켜지면 켜짐", () => {
    expect(isShellResizing()).toBe(false);
    setShellResizing("drag", true);
    expect(isShellResizing()).toBe(true);
    setShellResizing("drag", false);
    setShellResizing("motion", true);
    expect(isShellResizing()).toBe(true);
    setShellResizing("motion", false);
    expect(isShellResizing()).toBe(false);
  });

  it("두 원천의 OR — 끄는 도중 켠 전환의 타이머가 끝나도(motion 끔) 끌기가 이어지면 켜진 채, 알림은 합친 값이 바뀔 때만", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeShellResizing(listener);
    setShellResizing("drag", true);
    expect(listener).toHaveBeenCalledTimes(1);
    // 끌기 중 레일로 접힘 → 전환 켬 → 200ms 뒤 끔
    setShellResizing("motion", true);
    setShellResizing("motion", false);
    expect(isShellResizing()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    // 같은 값을 다시 정해도 알리지 않음
    setShellResizing("drag", true);
    expect(listener).toHaveBeenCalledTimes(1);
    setShellResizing("drag", false);
    expect(isShellResizing()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("구독을 풀면 더 알리지 않는다 — 다른 구독은 그대로", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeShellResizing(first);
    const unsubscribeSecond = subscribeShellResizing(second);
    unsubscribeFirst();
    setShellResizing("motion", true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    unsubscribeSecond();
    setShellResizing("motion", false);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
