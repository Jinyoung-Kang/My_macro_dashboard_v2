/**
 * QA-601 — 셸 폭이 바뀌는 동안(왼쪽 메뉴 손잡이 끌기·접기 전환 150ms) 본문 차트의 폭을 잡아 둡니다.
 *
 * QA 스택(qa@99f161ae) 1440 /macro 접기는 5프레임(최대 간격 150ms·긴 작업 3개), 1024 /macro 끌기는 1배속 7fps였습니다. 셸 변수가 프레임마다 바뀌어
 * 본문 열 폭이 바뀌고, 공용 차트의 Recharts ResponsiveContainer가 프레임마다 크기 콜백을 받아 차트 전체를 다시 그렸기 때문입니다(10년 일별 선 5개 —
 * 한 번에 약 100ms). 그래서 끌기 문턱을 넘은 뒤부터 놓을 때까지, 그리고 접힘이 바뀐 뒤 전환 동안(NAV_MOTION_HOLD_MS) 차트를 감싼 상자를 잰 px 폭으로
 * 고정하고, 끝나면 100%로 되돌려 한 번만 다시 그리게 합니다.
 *
 * 왼쪽 메뉴(SideNav)와 공용 선 차트(LineChart)를 한 트리로 그려 봅니다. jsdom에는 크기가 없어 ResizeObserver 대역이 폭 600을 알리고, 차트를 감싼
 * 상자의 getBoundingClientRect도 600을 돌려줍니다(CSS와 무관하게 콜백이 오므로 '콜백을 무시함'이 아니라 '고정한 px 폭'을 봅니다).
 * 재현 커밋에서는 ResponsiveContainer를 감싼 상자가 없어(부모가 figure — style.width '') 세 시험 모두 it.fails였습니다. 다만 셋째(끄는 도중 메뉴만
 * 사라지면 풂)는 결함을 재현하지 않고 고침이 둔 장치의 정리를 봅니다 — 고침 전에는 고정 장치가 없어 첫 고정 단언에서 실패했을 뿐입니다(신호 쪽 정리는
 * SideNavResize '차트 폭 잡아 두기 신호'의 언마운트 사례가 봄). 세 시험 모두 증상(프레임마다 다시 그림)이 아니라 구현(고정한 px 폭)을 봅니다.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LineChart } from "@/components/charts";
import { resetNavCollapsedForTest } from "@/hooks/useNavCollapsed";
import { NAV_RESIZING_ATTR } from "@/hooks/useNavResize";
import { resetNavWidthForTest } from "@/hooks/useNavWidth";
import { NAV_MOTION_HOLD_MS } from "@/lib/navWidth";
import type { SessionUser } from "@/lib/types";

import { SideNav } from "../SideNav";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const SERIES = [{ key: "v", label: "순유동성" }];
const ROWS = [
  { date: "2026-01-02", v: 5.85 },
  { date: "2026-04-01", v: 5.9 },
  { date: "2026-07-01", v: 5.97 },
  { date: "2026-10-24", v: 6.0 },
];
const CHART_WIDTH = 600;

/**
 * 프레임 대역 — requestAnimationFrame이 맡긴 콜백을 번호로 쥐고 있다가 시험이 runFrames로 돌립니다. cancelAnimationFrame은 그 번호를 걷습니다
 * (걷힌 프레임은 돌지 않음 — 브라우저와 같음). 시험이 끝나면 tidy가 남은 프레임을 비웁니다(QA-974).
 */
const frames = new Map<number, FrameRequestCallback>();
let lastFrameId = 0;

function rect(width: number, height: number): DOMRect {
  return { left: 0, top: 0, x: 0, y: 0, width, height, right: width, bottom: height, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  frames.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback: FrameRequestCallback) => {
    lastFrameId += 1;
    frames.set(lastFrameId, callback);
    return lastFrameId;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
    frames.delete(id);
  });
  // jsdom 29에는 setPointerCapture가 없습니다(SideNavResize.test와 같은 대역).
  Object.defineProperty(Element.prototype, "setPointerCapture", { value: vi.fn(), configurable: true, writable: true });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ contentRect: { width: CHART_WIDTH, height: 240 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  // 차트를 감싼 상자(ResponsiveContainer를 품은 요소)만 폭 600 — 나머지는 jsdom 그대로(0).
  const original = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.querySelector(".recharts-responsive-container") ? rect(CHART_WIDTH, 240) : original.call(this);
  });
});

/**
 * 시험 하나의 뒷정리 — afterEach가 부르고, QA-974 시험은 '정리한 뒤'를 보려고 먼저 한 번 더 부릅니다(두 번 불러도 같음).
 *
 * 언마운트 뒤 프레임 대역에 남은 콜백을 한 번 돌려 비웁니다(QA-974). 남는 것은 차트 저장소(redux-toolkit 자동 묶음)가 미룬 알림입니다 — 화면 코드의
 * 프레임(끌기·차트 맞춤 확인)은 언마운트가 스스로 걷습니다. 알림이 돌면 함께 걸린 100ms 대체 타이머(Node setTimeout — 환경 해제 뒤에도 살아 있음)를
 * 스스로 걷어, 파일이 끝난 뒤 터질 타이머가 남지 않습니다. 알림은 걷을 때 대역의 프레임 번호와 (가짜 타이머를 쓴 시험이면) 가짜 타이머 번호를 쓰므로
 * 둘을 되돌리기 전에 돌립니다. 돌린 뒤에도 프레임이 남으면(프레임이 다음 프레임을 맡김) 나머지 정리를 마친 다음 시험을 실패시킵니다.
 */
function tidy() {
  cleanup();
  runFrames();
  const leftoverFrames = frames.size;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (Element.prototype as Partial<Element>).setPointerCapture;
  window.localStorage.clear();
  resetNavCollapsedForTest();
  resetNavWidthForTest();
  document.documentElement.removeAttribute(NAV_RESIZING_ATTR);
  expect(leftoverFrames).toBe(0);
}

afterEach(tidy);

function Page({ nav = true }: { nav?: boolean }) {
  return (
    <>
      {nav ? <SideNav pathname="/macro" user={MEMBER} /> : null}
      <LineChart data={ROWS} series={SERIES} />
    </>
  );
}

const handle = () => screen.getByRole("separator", { name: "왼쪽 메뉴 폭" });
const toggleButton = () => screen.getByRole("button", { name: "왼쪽 메뉴 접기" });
const down = (clientX: number) => fireEvent.pointerDown(handle(), { pointerId: 1, clientX, button: 0, isPrimary: true });
const move = (clientX: number) => fireEvent.pointerMove(handle(), { pointerId: 1, clientX, isPrimary: true });
const up = (clientX: number) => fireEvent.pointerUp(handle(), { pointerId: 1, clientX, button: 0, isPrimary: true });

function runFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  });
}

/** ResponsiveContainer를 바로 감싼 상자의 인라인 폭 — 고정하면 잰 px, 쉬면 ''(클래스의 100%). */
function heldWidth(container: HTMLElement): string {
  const responsive = container.querySelector(".recharts-responsive-container") as HTMLElement;
  return (responsive.parentElement as HTMLElement).style.width;
}

describe("QA-601: 셸 폭이 바뀌는 동안 차트 폭 잡아 두기", () => {
  // 재현 커밋 실패 값: AssertionError: expected '' to be '600px' — 감싼 상자가 없어 ResponsiveContainer의 부모가 figure였습니다.
  it("끌기 — 문턱(3px)을 넘으면 차트를 감싼 상자를 잰 폭(600px)으로 고정하고, 놓으면 풂", () => {
    const { container } = render(<Page />);
    expect(heldWidth(container)).toBe("");
    down(220);
    move(222);
    expect(heldWidth(container)).toBe("");
    move(260);
    expect(heldWidth(container)).toBe(`${CHART_WIDTH}px`);
    runFrames();
    move(300);
    runFrames();
    expect(heldWidth(container)).toBe(`${CHART_WIDTH}px`);
    up(300);
    expect(heldWidth(container)).toBe("");
    expect(window.localStorage.getItem("shell.navWidth")).toBe("300");
  });

  // 재현 커밋 실패 값: AssertionError: expected '' to be '600px'.
  it("접기 단추 — 누른 직후 고정하고 전환 유지 시간(NAV_MOTION_HOLD_MS)이 지나면 풂, 펼칠 때도 같음", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { container } = render(<Page />);
    fireEvent.click(toggleButton());
    expect(toggleButton().getAttribute("aria-pressed")).toBe("true");
    expect(heldWidth(container)).toBe(`${CHART_WIDTH}px`);
    act(() => vi.advanceTimersByTime(NAV_MOTION_HOLD_MS - 1));
    expect(heldWidth(container)).toBe(`${CHART_WIDTH}px`);
    act(() => vi.advanceTimersByTime(1));
    expect(heldWidth(container)).toBe("");

    fireEvent.click(toggleButton());
    expect(toggleButton().getAttribute("aria-pressed")).toBe("false");
    expect(heldWidth(container)).toBe(`${CHART_WIDTH}px`);
    act(() => vi.advanceTimersByTime(NAV_MOTION_HOLD_MS));
    expect(heldWidth(container)).toBe("");
  });

  // 장치 시험(결함 재현 아님 — 파일 머리말). 재현 커밋 실패 값: AssertionError: expected '' to be '600px'(첫 고정 단언 — '풂'에는 닿지 못함).
  it("끄는 도중 왼쪽 메뉴만 사라지면(로그아웃 등) 남은 차트의 고정을 풂", () => {
    const { container, rerender } = render(<Page />);
    down(220);
    move(260);
    runFrames();
    expect(heldWidth(container)).toBe(`${CHART_WIDTH}px`);
    rerender(<Page nav={false} />);
    expect(screen.queryByRole("separator")).toBeNull();
    expect(heldWidth(container)).toBe("");
  });
});

/** Recharts 저장소(redux-toolkit 자동 묶음)가 알림을 미룰 때 프레임과 함께 거는 대체 타이머의 시간(ms) — redux-toolkit 2.13.0 autoBatchEnhancer. */
const STORE_FALLBACK_TIMER_MS = 100;

/**
 * vitest가 시험 파일을 마친 뒤 하는 일(jsdom 전역을 globalThis에서 걷음 — 여기서는 cancelAnimationFrame 하나)을 흉내 내고, 대체 타이머가 돌 시간 동안
 * Node 타이머에서 난 잡히지 않은 오류의 글을 모읍니다. 수신기를 직접 달아 두는 동안에는 vitest가 그 오류를 '처리되지 않은 오류'로 세지 않습니다.
 */
async function uncaughtAfterEnvironmentTeardown(): Promise<string[]> {
  const errors: string[] = [];
  const onError = (error: unknown) => errors.push(String(error));
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  process.on("uncaughtException", onError);
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  try {
    await new Promise((resolve) => setTimeout(resolve, STORE_FALLBACK_TIMER_MS + 50));
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "cancelAnimationFrame", descriptor);
    process.off("uncaughtException", onError);
  }
  return errors;
}

/**
 * QA-974 — 이 파일이 끝난 뒤 차트 저장소의 대체 타이머가 남아 CI가 흔들렸습니다(main@261b6b2d 실행 44832833579 첫 시도: 시험 4,932개 통과 + 처리되지
 * 않은 오류 2건 `ReferenceError: cancelAnimationFrame is not defined` — redux-toolkit.modern.mjs:373, 다시 돌리면 통과).
 *
 * Recharts 3.10.1은 차트마다 Redux 저장소를 두고 자동 묶음(autoBatchEnhancer `raf` — redux-toolkit 기본 것과 Recharts 것 둘)으로 알림을 미룹니다:
 * `requestAnimationFrame(알림)`과 100ms 대체 타이머 `setTimeout(알림)`을 함께 걸고, 먼저 온 쪽이 전역 `cancelAnimationFrame`·`clearTimeout`으로
 * 다른 쪽을 걷습니다. 이 파일은 프레임을 대역(시험이 runFrames로 직접 돌림)으로 바꾸므로, 마지막 runFrames 뒤에 걸린 알림(다시 그리기·언마운트)은
 * 프레임으로는 끝내 돌지 않고 대체 타이머만 남습니다. 그 타이머는 jsdom이 아니라 Node의 것이라 vitest가 환경을 내려도(전역 cancelAnimationFrame
 * 삭제) 살아 있다가 100ms째에 터집니다. 작업자 프로세스가 그때까지 살아 있고(바쁜 CI) 다른 파일이 아직 도는 중이면 vitest가 종료 코드 1을 냅니다.
 */
describe("QA-974: 시험이 끝난 뒤 차트 저장소의 대체 타이머가 남지 않음", () => {
  // 재현 커밋 실패 값: AssertionError: expected [ …(6) ] to deeply equal [] — 여섯 모두 "ReferenceError: cancelAnimationFrame is not defined"
  // (앞 시험 '끌기'·'메뉴만 사라지면'이 남긴 타이머 둘씩 + 이 시험 둘 — 저장소마다 자동 묶음이 둘이라 둘씩. 이 시험만 돌리면 2건).
  it("정리한 뒤 jsdom 전역이 걷혀도 대체 타이머가 cancelAnimationFrame을 찾다 터지지 않음", async () => {
    render(<Page />);
    down(220);
    move(260);
    runFrames();
    tidy();
    expect(await uncaughtAfterEnvironmentTeardown()).toEqual([]);
  });
});
