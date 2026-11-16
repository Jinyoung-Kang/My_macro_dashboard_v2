/**
 * 종목 상세 대상 머리의 종류 태그 — 지수·환율·선물 심볼은 '지수'·'환율'·'선물', 주식·ETF·국내는 '종목'(2026-11-16 결정 7). 응답은 모두 합성 값입니다.
 *
 * 태그가 늘 '종목'이라 S&P 500(^GSPC)·원/달러(KRW=X)·미국채 2년물 선물(ZT=F)도 'S&P 500 [종목]'이었고, 바로 아래 보조 글('SNP · 지수 · USD')과
 * 말이 달랐습니다. 시세의 종류(Yahoo quoteType)를 따르고, 시세 전·실패(종류 없음)는 코드 꼴(^·=X·=F)로 정합니다. 아이콘은 그대로입니다.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { DetailMarket, DetailQuote, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { StockDetailScreen } from "../StockDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});
afterEach(cleanup);

function quote(code: string, kind: string | null, name: string, market: DetailMarket = "us"): DetailQuote {
  return {
    market, code, yahooSymbol: market === "kr" ? `${code}.KS` : code, name, exchange: "SNP", currency: market === "kr" ? "KRW" : "USD", kind,
    price: 100, previousClose: 99, change: 1, changePct: 1.01, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED", stats: [], profile: null,
    consensus: null, research: [], source: { label: "Yahoo Finance", url: "https://finance.yahoo.com/" }, error: null, fetchedAt: "2026-11-16T07:00:00+00:00",
  };
}

function renderStock(market: DetailMarket, code: string) {
  render(
    <SessionUserProvider user={MEMBER}>
      <StockDetailScreen market={market} code={code} />
    </SessionUserProvider>,
  );
}

/** 대상 머리의 태그 글(이름 h1 뒤 — 종류 태그가 먼저, 그다음 고정폭 식별자 태그). */
function headerTags(name: string): string[] {
  const heading = screen.getByRole("heading", { level: 1, name });
  return [...(heading.parentElement as HTMLElement).children].filter((child) => child !== heading).map((child) => child.textContent ?? "");
}

describe("종목 상세 — 대상 머리 종류 태그(결정 7)", () => {
  it.each([
    ["^GSPC", "INDEX", "S&P 500", "지수"],
    ["KRW=X", "CURRENCY", "USD/KRW", "환율"],
    ["ZT=F", "FUTURE", "2-Year T-Note Futures", "선물"],
    ["AAPL", "EQUITY", "Apple Inc.", "종목"],
    ["SPY", "ETF", "SPDR S&P 500 ETF Trust", "종목"],
  ])("%s(시세 종류 %s) → '%s' 머리의 종류 태그 '%s'", async (code, kind, name, label) => {
    reads = { [endpoints.detail.quote("us", code)]: { available: true, quote: quote(code, kind, name) } };
    renderStock("us", code);
    await screen.findByRole("heading", { level: 1, name });
    expect(headerTags(name)).toEqual([label, code]);
  });

  it("시세를 읽기 전에는 코드 꼴로 — ^ 지수, =X 환율, =F 선물, 그 밖은 종목", async () => {
    for (const [code, label] of [["^N225", "지수"], ["EURUSD=X", "환율"], ["GC=F", "선물"], ["MSFT", "종목"]]) {
      renderStock("us", code);
      // 이름이 없으면 제목이 코드 그대로라 식별자 태그는 두지 않음 — 종류 태그 하나
      expect(headerTags(code)).toEqual([label]);
      cleanup();
    }
  });

  it("시세 읽기가 실패하거나 종류가 없는 응답이면 코드 꼴로", async () => {
    reads = { [endpoints.detail.quote("us", "^GSPC")]: new Error("시세 서버가 응답하지 않습니다.") };
    renderStock("us", "^GSPC");
    const header = screen.getByRole("heading", { level: 1, name: "^GSPC" }).closest("header") as HTMLElement;
    await waitFor(() => expect(within(header).getByText("시세 서버가 응답하지 않습니다.")).toBeTruthy());
    expect(headerTags("^GSPC")).toEqual(["지수"]);
    cleanup();

    // 수집기는 Yahoo 연결 실패에도 available:true + quote{kind:null, error}를 줌(QA 스택에서 본 꼴)
    reads = { [endpoints.detail.quote("us", "KRW=X")]: { available: true, quote: { ...quote("KRW=X", null, "USD/KRW"), name: null, error: "Yahoo 연결 실패" } } };
    renderStock("us", "KRW=X");
    const fxHeader = screen.getByRole("heading", { level: 1, name: "KRW=X" }).closest("header") as HTMLElement;
    await waitFor(() => expect(within(fxHeader).getByText(/Yahoo 연결 실패/)).toBeTruthy());
    expect(headerTags("KRW=X")).toEqual(["환율"]);
  });

  it("국내 종목은 늘 '종목'(ETF 포함)", async () => {
    reads = { [endpoints.detail.quote("kr", "069500")]: { available: true, quote: quote("069500", "etf", "KODEX 200", "kr") } };
    renderStock("kr", "069500");
    await screen.findByRole("heading", { level: 1, name: "KODEX 200" });
    expect(headerTags("KODEX 200")).toEqual(["종목", "069500"]);
  });
});
