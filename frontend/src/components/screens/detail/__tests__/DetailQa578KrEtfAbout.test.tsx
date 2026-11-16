/**
 * 종목 상세 '회사 소개'의 영문 원문 안내(QA-578). 응답은 합성 값입니다(수집기 quote_from_naver와 같은 모양 — 종목 코드·이름만 실제).
 *
 * 국내 ETF는 수집기가 네이버 integration 설명(한국어)을 profile.summary에 넣고 WISEfn을 부르지 않아 summaryKo가 없습니다(docs/API.md '국내 ETF는
 * 네이버 개요(summary)'). 회사 소개 패널은 summaryKo가 없으면 summary를 늘 Yahoo 영문이라고 보고 '한국어 개요가 없어 Yahoo 영문 원문을 보입니다.'를
 * 붙여, 출처를 '네이버 증권'으로 적은 같은 패널에 한국어 글을 'Yahoo 영문 원문'이라고 적었습니다. 종목 팝업(lib/detail quickProfile)은 이미 미국
 * 종목일 때만 영문이라고 적습니다 — 상세 화면도 같은 규칙(isEnglishProfile)을 씁니다.
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
const NOTICE = "한국어 개요가 없어 Yahoo 영문 원문을 보입니다.";
const SUMMARY = "KODEX 200은 코스피200 지수를 추종하는 상장지수펀드입니다(시험용 글).";

/** 국내 ETF 시세 — 개요 글은 summary(네이버 한국어), summaryKo·koSource 없음. */
const ETF: DetailQuote = {
  market: "kr", code: "069500", yahooSymbol: "069500.KS", name: "KODEX 200", exchange: "코스피", currency: "KRW", kind: "etf",
  price: 40000, previousClose: 39800, change: 200, changePct: 0.5, asOf: null, marketState: "CLOSE", stats: [],
  profile: { sector: null, industry: null, country: "대한민국", website: null, employees: null, summary: SUMMARY },
  consensus: null, research: [], source: { label: "네이버 증권", url: "https://m.stock.naver.com/domestic/stock/069500" }, error: null, fetchedAt: null,
};

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

describe("회사 소개 — 영문 원문 안내 (QA-578)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 국내 ETF 회사 소개에 '한국어 개요가 없어 Yahoo 영문 원문을 보입니다.'가 붙었습니다.
  it("국내 ETF의 한국어 개요(summary — 네이버)에는 Yahoo 영문 안내를 붙이지 않는다", async () => {
    reads[endpoints.detail.quote("kr", "069500")] = { available: true, quote: ETF };
    render(
      <SessionUserProvider user={MEMBER}>
        <StockDetailScreen market="kr" code="069500" />
      </SessionUserProvider>,
    );
    const about = (await screen.findByRole("heading", { name: "회사 소개" })).closest("section") as HTMLElement;
    expect(within(about).getByText(SUMMARY)).toBeTruthy();
    expect(within(about).queryByText(NOTICE)).toBeNull();
  });
});
