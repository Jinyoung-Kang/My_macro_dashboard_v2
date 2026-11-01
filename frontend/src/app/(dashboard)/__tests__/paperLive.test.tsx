/**
 * 장중 평가 카드(LiveValuationCard) — 고정하는 규칙
 *  - 정규장이면 계좌별 순자산·출발 대비·오늘·기준 시각을 그리고, 행을 누르면 그 계좌의 종목 표
 *  - 서버가 새 시세를 요청한 응답이면(refreshRequested) 20초 뒤 한 번만 더 읽는다(되풀이 없음)
 *  - 간격 선택은 이 브라우저에 기억되고(기본 30분), 장 밖에서는 다시 읽지 않는다
 *  - 숨긴 탭에서는 '한 번 더'·'다음 개장' 깨우기가 읽지 않고, 다시 보일 때 한 번(QA-154)
 *  - 시계는 고정한다(QA-155) — 다음 개장 깨우기가 지금 시각으로 기다릴 시간을 정하므로, 진짜 시계면 돌린 때에 따라 결과가 달라진다
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { LiveValuationCard } from "@/components/screens/paper/LiveValuationCard";

const SESSION = {
  phase: "REGULAR", sessionDate: "2026-10-30", openAtKst: "2026-10-30 22:30 KST", closeAtKst: "2026-10-31 05:00 KST",
  nextOpenAtKst: "2026-11-02 23:30 KST",
};

function live(over: Record<string, unknown> = {}) {
  return {
    available: true, market: "US", currency: "USD", nowKst: "2026-10-30 23:59 KST", session: SESSION, isEstimated: true,
    quotes: { source: "Yahoo(yfinance) 1분봉", collectedAtKst: "2026-10-30 23:58 KST", refreshRequested: false, missing: [], error: null },
    books: [{
      code: "claude", label: "Claude 계좌", status: "ACTIVE", initialCash: 100000, cash: 10000, nav: 100000, returnPct: 0,
      previousNav: 99000, previousTradingDate: "2026-10-29", dayChangePct: 1.01, basis: "LIVE", basisAtKst: "2026-10-30 23:58 KST",
      liveCount: 1, positionCount: 1,
      positions: [{ ticker: "AAA", qty: 100, avgCost: 400, price: 420, priceAtKst: "2026-10-30 23:58 KST", priceBasis: "LIVE",
        value: 42000, weightPct: 42, returnPct: 5, previousClose: 410, dayChangePct: 2.44 }],
    }],
    ...over,
  };
}

/** 고정 시계 — 고정 응답의 지금(nowKst 2026-10-30 23:59 KST). 다음 개장(2026-11-02 23:30 KST)까지 하루가 넘게 남아 장 밖에서는 깨어나지 않습니다. */
const NOW = Date.UTC(2026, 9, 30, 14, 59);

beforeEach(() => {
  // Date까지 가짜로 두고 시각을 고정합니다(QA-155) — 카드의 다음 개장 깨우기가 진짜 벽시계를 읽지 않게.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(NOW);
  window.localStorage.clear();
  api.apiGetShared.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** 가짜 시계에서는 findBy가 기다리지 못합니다 — 시계를 조금 움직여 응답(약속)과 상태 갱신을 흘려보냅니다. */
async function settle(ms = 1) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

const liveCalls = () => api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith("/api/paper/live")).length;

describe("정규장", () => {
  it("계좌 줄과 기준 시각, 행을 누르면 종목 표", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live()));
    render(<LiveValuationCard />);

    await settle();
    expect(screen.getByText(/정규장 — 장중 1분봉 시세로 다시 평가/)).toBeTruthy();
    const table = screen.getByRole("table", { name: "계좌별 장중 평가" });
    expect(within(table).getByText("100,000.00 달러")).toBeTruthy();
    expect(within(table).getByText("+1.01%")).toBeTruthy();
    expect(within(table).getByText("10-29 확정 대비")).toBeTruthy();
    expect(within(table).getByText("장중 10-30 23:58")).toBeTruthy();
    expect(screen.getByText("정규장 동안 30분마다 다시 읽습니다(이 화면을 보는 동안만).")).toBeTruthy();

    fireEvent.click(within(table).getByText("Claude 계좌"));
    const positions = screen.getByRole("table", { name: "Claude 계좌 보유 종목 장중 평가" });
    expect(within(positions).getByText("AAA")).toBeTruthy();
    expect(within(positions).getByText("+2.44%")).toBeTruthy();
  });

  it("서버가 새 시세를 요청했으면 20초 뒤 한 번만 더 읽는다", async () => {
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve(live({ quotes: { source: null, collectedAtKst: null, refreshRequested: true, missing: [], error: null } })));
    render(<LiveValuationCard />);
    await settle();
    expect(screen.getByText(/정규장 —/)).toBeTruthy();
    expect(liveCalls()).toBe(1);

    await settle(20_000);
    expect(liveCalls()).toBe(2);
    // 다시 읽은 응답도 refreshRequested지만 또 예약하지 않습니다.
    await settle(60_000);
    expect(liveCalls()).toBe(2);
  });

  it("간격을 바꾸면 기억하고 그 간격으로 다시 읽는다", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live()));
    render(<LiveValuationCard />);
    await settle();
    expect(screen.getByText(/정규장 —/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("장중 평가 새로고침 간격"), { target: { value: "1" } });
    expect(window.localStorage.getItem("paper.liveRefreshMinutes")).toBe("1");
    await settle(60_000);
    expect(liveCalls()).toBe(2);
  });
});

describe("장 밖", () => {
  it("다시 읽지 않고 기준을 적는다", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live({ session: { ...SESSION, phase: "CLOSED" } })));
    render(<LiveValuationCard />);

    await settle();
    expect(screen.getByText(/휴장 — 장부의 마지막 관측치 기준/)).toBeTruthy();
    expect(screen.getByText("장 밖에서는 다시 읽지 않습니다 — 숫자는 아래 기준 시각의 값입니다.")).toBeTruthy();
    await settle(31 * 60_000);
    expect(liveCalls()).toBe(1);
  });
});

/**
 * 진짜 벽시계(Date) — 이 파일이 가짜 타이머를 걸기 전에 잡아 둡니다. QA-155 재현은 이것의 now만 바꿔 '벽시계가 그 시각인 날 이 파일을 돌린 것'을
 * 흉내 냅니다(카드가 읽는 Date가 이 진짜 Date면 그 시각을 받음).
 */
const WallClock = Date;
/** 2026-11-02 23:10 KST — 고정 응답의 다음 개장(2026-11-02 23:30 KST) 20분 전. */
const WALL_IN_OPEN_WINDOW = Date.UTC(2026, 10, 2, 14, 10);

describe("QA-155 장 밖 시험이 벽시계에 기대지 않는다(시험 흔들림)", () => {
  // 카드의 다음 개장 깨우기는 msUntilNextOpen(session, Date.now())로 기다릴 시간을 정합니다. 수정 전 이 파일은 Date를 가짜로 두지 않아(setTimeout·
  // setInterval만) 진짜 벽시계를 읽었고, 고정 응답의 다음 개장까지 31분이 안 남은 때(2026-11-02 23:00~23:31 KST) 돌리면 '장 밖' 시험이 31분을
  // 흘리는 동안 깨우기가 불려 두 번째 읽기가 나가 졌습니다. 벽시계의 now만 그 창 안으로 옮겨 같은 몸체를 돌립니다(재현 커밋에서는 it.fails).
  // 이제 이 파일은 Date도 가짜 시계(고정 NOW)라 진짜 벽시계가 어디 있든 같은 결과입니다.
  beforeEach(() => {
    vi.spyOn(WallClock, "now").mockReturnValue(WALL_IN_OPEN_WINDOW);
  });

  it("다음 개장 31분 안의 벽시계에서도 — 장 밖이면 31분 동안 다시 읽지 않는다", async () => {
    api.apiGetShared.mockImplementation(() => Promise.resolve(live({ session: { ...SESSION, phase: "CLOSED" } })));
    render(<LiveValuationCard />);

    await settle();
    expect(screen.getByText("장 밖에서는 다시 읽지 않습니다 — 숫자는 아래 기준 시각의 값입니다.")).toBeTruthy();
    await settle(31 * 60_000);
    expect(liveCalls()).toBe(1);
  });
});

describe("QA-154 숨긴 탭에서는 깨우지 않는다", () => {
  let visibility: DocumentVisibilityState;
  beforeEach(() => {
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });

  /** 탭을 숨기거나 다시 보이게 합니다(브라우저처럼 visibilitychange를 냄). */
  async function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  }

  // 카드의 '다음 개장 깨우기'·'20초 뒤 한 번 더'는 setTimeout으로 useApi의 reload를 부릅니다. reload(load)는 탭이 보이는지 보지 않아, 수정 전에는
  // 숨긴 탭에서도 /live 요청이 나갔습니다 — 정규장이면 서버가 그 요청으로 수집을 깨웁니다(시세는 화면을 볼 때만 받기로 한 결정과 어긋남).
  // 이제 타이머는 useVisibleWake로 부릅니다 — 숨긴 탭이면 미루고 다시 보일 때 한 번(재현 커밋에서는 it.fails).
  it("장 밖 — 다음 개장 깨우기는 숨긴 탭이면 읽지 않고, 다시 보이면 한 번 읽는다", async () => {
    // 고정 시계(10-30 23:59 KST)에서 다음 개장이 10-31 00:10 KST → 깨우기는 12분 뒤(개장 + 1분).
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve(live({ session: { ...SESSION, phase: "CLOSED", nextOpenAtKst: "2026-10-31 00:10 KST" } })));
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);

    await setVisibility("hidden");
    await settle(13 * 60_000);
    expect(liveCalls()).toBe(1);

    // 장 밖에는 자동 갱신 주기가 0이라 useApi가 탭 복귀 때 읽지 않습니다 — 미뤄 둔 깨우기를 카드가 한 번 읽습니다.
    await setVisibility("visible");
    await settle();
    expect(liveCalls()).toBe(2);
  });

  it("정규장 — 20초 뒤 한 번 더는 숨긴 탭이면 읽지 않고, 돌아오면 useApi의 복귀 읽기 한 번뿐(셋이 아님)", async () => {
    api.apiGetShared.mockImplementation(() =>
      Promise.resolve(live({ quotes: { source: null, collectedAtKst: null, refreshRequested: true, missing: [], error: null } })));
    render(<LiveValuationCard />);
    await settle();
    expect(liveCalls()).toBe(1);

    await setVisibility("hidden");
    await settle(20_000);
    expect(liveCalls()).toBe(1);

    await setVisibility("visible");
    await settle();
    expect(liveCalls()).toBe(2);
    await settle(60_000);
    expect(liveCalls()).toBe(2);
  });
});
