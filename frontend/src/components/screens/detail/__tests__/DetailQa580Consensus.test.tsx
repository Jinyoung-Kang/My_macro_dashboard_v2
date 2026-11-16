/**
 * 종목 상세 '애널리스트 의견' 패널 — 받은 값만(QA-580). 응답은 모두 합성 값입니다(수집기 quote_from_yahoo·quote_from_naver와 같은 모양).
 *
 * 수집기는 지수·ETF·모르는 심볼에도 consensus를 값이 모두 null인 객체로 주고, 네이버(국내)는 의견 수를 늘 주지 않습니다. 패널은 consensus 객체가
 * 있으면 늘 그려, 지수·ETF에서 '—' 세 줄 패널이 되고 국내 종목에는 늘 비는 '의견 수' 줄이 있었습니다. 같은 왼쪽 칸의 회사 개요는 받은 값만
 * 줄로 둡니다(P4 '정한 것' 4) — 의견 패널도 같은 규칙입니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { DetailQuote, SessionUser } from "@/lib/types";

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

const BASE: DetailQuote = {
  market: "us", code: "^SYNI", yahooSymbol: "^SYNI", name: "Synthetic Index", exchange: "SNP", currency: "USD", kind: "INDEX",
  price: 100, previousClose: 99, change: 1, changePct: 1.01, asOf: null, marketState: "CLOSED", stats: [], profile: null,
  consensus: { targetMean: null, recommendation: null, analysts: null }, research: [], source: { label: "합성 출처", url: "https://quote.example/SYNI" },
  error: null, fetchedAt: null,
};

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

function renderStock(market: "us" | "kr", code: string, quote: DetailQuote) {
  reads[endpoints.detail.quote(market, code)] = { available: true, quote };
  render(
    <SessionUserProvider user={MEMBER}>
      <StockDetailScreen market={market} code={code} />
    </SessionUserProvider>,
  );
}

describe("애널리스트 의견 패널 — 받은 값만 (QA-580)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 지수 꼴(세 값 모두 null)에도 패널이 '—' 세 줄로 그려졌습니다.
  it("의견 값을 하나도 받지 못한 시세(지수·ETF·모르는 심볼 꼴)에는 패널을 그리지 않는다", async () => {
    renderStock("us", "^SYNI", BASE);
    await screen.findByRole("heading", { level: 1, name: "Synthetic Index" });
    await screen.findByRole("heading", { level: 2, name: "핵심 지표" });
    expect(screen.queryByRole("heading", { name: "애널리스트 의견" })).toBeNull();
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 국내 종목 패널에 늘 비는 '의견 수 —' 줄이 있었습니다.
  it("국내 종목은 평균 목표가·투자의견 두 줄(네이버가 주지 않는 '의견 수' 줄 없음)", async () => {
    renderStock("kr", "999991", {
      ...BASE, market: "kr", code: "999991", yahooSymbol: "999991.KS", name: "합성전자", exchange: "코스피", currency: "KRW", kind: "stock",
      consensus: { targetMean: 89000, recommendation: "4.00", analysts: null },
    });
    const panel = (await screen.findByRole("heading", { name: "애널리스트 의견" })).closest("section") as HTMLElement;
    expect(within(panel).getAllByRole("term").map((term) => term.textContent)).toEqual(["평균 목표가", "투자의견"]);
    expect(within(panel).getByText("89,000 원")).toBeTruthy();
  });
});
