/**
 * 매크로 카드 배지 — 개장 상태와 시세 지연을 배지 하나로, 지연이 아닌 알림만 따로(2026-10-20 사용자 요청).
 *
 * 예전 화면: 미국채 카드에 '실시간 · TradingView 참고'와 '마감'이, S&P 500에 '실시간'과 '마감'이 나란히 떠 서로 어긋나게
 * 읽혔습니다. 지연은 장이 열려 있을 때만 뜻이 있어 개장 배지에 붙이고, 참고 시세라는 성격은 출처 줄로 옮깁니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import MacroPage from "../macro/page";

const card = (over: Record<string, unknown>) => ({
  status: "ok", priceStr: "1.00", deltaStr: "+0.00 (+0.00%)", prevStr: "1.00", delta: 0, ...over,
});

const OVERVIEW = {
  available: true,
  collectedAtKst: "2026-10-20 19:54 KST",
  categories: [
    { id: "ust", title: "🏛️ 미국 국채 수익률", note: "실시간 · TradingView 참고", items: [
      card({ key: "us10y", name: "미국채 10년물 수익률(%)", market: "ust", delayMinutes: 0, isReference: true,
             note: "실시간 · TradingView 참고", source: "TradingView Scanner",
             lastTs: "2026-10-20 19:54 KST (TradingView 수집 시각)" }),
    ] },
    { id: "us_equity", title: "🇺🇸 미국 주가지수 및 선물", note: "종목마다 다름 — 카드 배지 참고", items: [
      card({ key: "sp500", name: "S&P 500", market: "nyse", delayMinutes: 0, note: "실시간",
             source: "Yahoo Finance (^GSPC)", lastTs: "2026-10-20 04:59 KST" }),
      card({ key: "sp500_fut", name: "S&P 500 선물 (ES)", market: "cme", delayMinutes: 10, note: "10분 지연",
             source: "Yahoo Finance (ES=F)", lastTs: "2026-10-20 19:44 KST" }),
    ] },
    { id: "asia_equity", title: "🌏 아시아 주요 주가지수", items: [
      card({ key: "nikkei_fut_scraped", name: "닛케이225 지수 (선물 대체)", market: "tse", delayMinutes: 0,
             isReference: true, note: "선물 조회 실패 · 지수 값", warning: "선물 조회 실패 · 지수 값",
             source: "TradingView Scanner", lastTs: "2026-10-20 거래일 기준 (TradingView · 장 밖)" }),
    ] },
  ],
};

beforeEach(() => {
  // 2026-10-20 19:54 KST = 뉴욕 06:54 — 미국 국채 전자거래·CME는 개장, 뉴욕 증시는 장 전(마감), 도쿄는 마감.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T10:54:00Z"));
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith("/api/macro/overview") ? Promise.resolve(OVERVIEW) : new Promise(() => {}));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("매크로 카드 배지", () => {
  it("장이 열려 있으면 '개장 · 지연'을 배지 하나로, 닫혀 있으면 '마감'만 — '실시간' 배지가 따로 뜨지 않는다", async () => {
    render(<MacroPage />);

    expect(await screen.findByText("개장 · 실시간")).toBeTruthy();          // 미국채(전자거래 시간)
    expect(screen.getByText("개장 · 10분 지연")).toBeTruthy();              // ES 선물
    expect(screen.getAllByText("마감").length).toBe(2);                       // S&P 500 지수, 닛케이(지수 값)
    expect(screen.queryByText("실시간")).toBeNull();
    expect(screen.queryByText("실시간 · TradingView 참고")).toBeNull();
  });

  it("참고 시세는 출처 줄에, 지연이 아닌 알림은 노란 배지로 따로", async () => {
    render(<MacroPage />);

    expect((await screen.findAllByText(/TradingView Scanner · 참고 시세/)).length).toBeGreaterThan(0);
    const notice = screen.getByText("선물 조회 실패 · 지수 값");
    expect(notice.className).toContain("text-warn");
  });

  it("이어받은 카드는 '이전 값' 배지 — 경고 기호는 이모지 글자가 아니라 장식 아이콘 + 낭독기용 '주의: '", async () => {
    const stale = { ...OVERVIEW, categories: [{ id: "ust", title: "미국 국채 수익률", items: [
      card({ key: "us10y", name: "미국채 10년물 수익률(%)", market: "ust", delayMinutes: 0, isStale: true, staleReason: "HTTP 429" }),
    ] }] };
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/macro/overview") ? Promise.resolve(stale) : new Promise(() => {}));
    render(<MacroPage />);

    const badge = await screen.findByText("이전 값");
    expect(badge.className).toContain("text-warn");
    expect(badge.getAttribute("title")).toContain("HTTP 429");
    expect(badge.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(badge.textContent).toBe("주의: 이전 값");
  });

  it("장단기 금리차 해석 기준의 '역전'은 경고 상태 글 — 기호 없이 '역전 (Inversion)'과 아이콘", async () => {
    const block = { longId: "DGS10", shortId: "DGS2", points: [], latest: 0.5, previous: 0.4 };
    const withSpreads = { ...OVERVIEW, spreads: {
      realtime: { longValue: null, shortValue: null }, official10y2y: block, official30y2y: block,
    } };
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/macro/overview") ? Promise.resolve(withSpreads) : new Promise(() => {}));
    render(<MacroPage />);

    const inversion = await screen.findByText("역전 (Inversion)");
    const status = inversion.parentElement as HTMLElement;
    expect(status.className).toContain("text-warn");
    expect(within(status).getByText("주의:").className).toContain("sr-only");
    expect(status.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("정상 (Normal)").querySelector("svg")).toBeNull();
  });

  it("카테고리 부제는 카드 지연의 요약 — 같으면 그 지연, 다르면 '종목마다 다름'", async () => {
    render(<MacroPage />);

    expect((await screen.findAllByText("시세: 실시간")).length).toBe(2);      // 미국채·아시아(지수 값 하나)
    expect(screen.getByText("시세: 종목마다 다름 — 카드 배지 참고")).toBeTruthy();
  });
});
