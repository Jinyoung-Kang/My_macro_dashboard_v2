/**
 * 🧪 장중 평가 카드(LiveValuationCard) — 고정하는 규칙
 *  - 정규장이면 계좌별 순자산·출발 대비·오늘·기준 시각을 그리고, 행을 누르면 그 계좌의 종목 표
 *  - 서버가 새 시세를 요청한 응답이면(refreshRequested) 20초 뒤 한 번만 더 읽는다(되풀이 없음)
 *  - 간격 선택은 이 브라우저에 기억되고(기본 30분), 장 밖에서는 다시 읽지 않는다
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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
