/**
 * 종목 상세 — 시세 이름이 60자를 넘을 때의 주요 뉴스·AI 요약 검색어(QA-448). 응답은 모두 합성 값입니다(가상 회사 이름).
 *
 * 백엔드 GET /api/detail/news·POST /api/detail/summary는 검색어(q)와 요약 이름(label)을 앞뒤 공백을 뺀 60자까지만 받고(DetailService.MAX_QUERY — 넘으면 400),
 * 수집기는 Yahoo의 긴 이름(longName)을 먼저 씁니다. 화면이 이름 전체를 그대로 넘기면 '주요 뉴스' 카드가 오류 카드가 됩니다. 아래 가짜 API는
 * 백엔드와 같은 규칙(60자를 넘으면 400 문구로 거절)으로 답합니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const PRO: SessionUser = { email: "p@test.local", role: "MEMBER", tier: "PRO" };

/** 71자 — QA 스택 확인에 쓴 모의 이름과 같은 모양(낱말 '…Incorporated International'에서 60자를 넘음). */
const LONG_NAME = "Fictional Universal Financial Holdings Group Incorporated International";
/** 낱말 경계에서 60자 안으로 줄인 검색어. */
const CLAMPED = "Fictional Universal Financial Holdings Group Incorporated";
const LIMIT_TEXT = "검색어는 60자 이하로 입력하세요.";

const QUOTE: DetailQuote = {
  market: "us", code: "FUFH", yahooSymbol: "FUFH", name: LONG_NAME, exchange: "NYSE", currency: "USD", kind: "EQUITY",
  price: 10.5, previousClose: 10.4, change: 0.1, changePct: 0.96, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
  stats: [], profile: null, consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/FUFH" }, error: null,
  fetchedAt: "2026-11-15T00:00:00+00:00",
};

const NEWS = {
  available: true,
  news: {
    items: [{ title: "합성 기사 — 가상 금융 그룹 실적", url: "https://news.example/fufh-1", publisher: "Example Wire", publishedAt: "2026-11-14T20:00:00+00:00", source: "Google News" }],
    errors: {}, error: null, fetchedAt: "2026-11-15T00:00:00+00:00",
  },
};

/** 백엔드 DetailService.query와 같은 검사 — 앞뒤 공백을 뺀 길이(Java String.length — UTF-16 단위)가 60을 넘으면 400. */
function tooLong(text: string | null | undefined): boolean {
  return (text ?? "").trim().length > 60;
}

function newsQuery(path: string): string | null {
  return new URL(path, "http://test.local").searchParams.get("q");
}

const requested = () => api.apiGetShared.mock.calls.map(([path]) => path as string);

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path === endpoints.detail.quote("us", "FUFH")) return Promise.resolve({ available: true, quote: QUOTE });
    if (path.startsWith("/api/detail/news")) {
      return tooLong(newsQuery(path)) ? Promise.reject(Object.assign(new Error(LIMIT_TEXT), { status: 400 })) : Promise.resolve(NEWS);
    }
    return new Promise(() => {});
  });
  api.apiPost.mockImplementation((_path: string, body: { q?: string; label?: string }) =>
    tooLong(body.q) || tooLong(body.label)
      ? Promise.reject(Object.assign(new Error(LIMIT_TEXT), { status: 400 }))
      : Promise.resolve({ status: true, summary: "한 줄 요약: 합성 요약 [1]", model: "test", generatedAtKst: null, cached: false, sources: [{ n: 1, label: "합성 출처", url: null }], error: null }),
  );
});
afterEach(cleanup);

describe("종목 상세 — 60자를 넘는 시세 이름의 뉴스·AI 요약 검색어(QA-448)", () => {
  // QA-448: 시세 이름이 60자를 넘으면(Yahoo longName) 화면이 GET /api/detail/news?q=<이름 전체>를 불러 400을 받고 '주요 뉴스' 카드에
  // "검색어는 60자 이하로 입력하세요."와 '다시 시도'가 떴습니다. AI 요약(POST /api/detail/summary)의 q·label도 같은 60자 검사를 받습니다.
  // 수정 전 실패: 뉴스 요청의 q가 71자 이름 전체라 가짜 백엔드가 400으로 거절하고 카드에 오류 문구가 보임(재현 커밋에서는 it.fails).
  // 고침: lib/detail의 detailQuery로 낱말 경계에서 60자 안으로 줄여 보냄(지표·기관 상세도 같은 함수).
  it("뉴스 요청의 q는 낱말 경계에서 60자 안으로 줄인 이름이고, 카드에 기사가 보인다", async () => {
    render(
      <SessionUserProvider user={PRO}>
        <StockDetailScreen market="us" code="FUFH" />
      </SessionUserProvider>,
    );
    // 뉴스는 가운데 '뉴스' 탭(대상 문법 — P4) — 사용자가 탭을 열면 보입니다(요청은 탭과 상관없이 화면을 열 때).
    fireEvent.click(await screen.findByRole("tab", { name: "뉴스" }));
    const heading = await screen.findByRole("heading", { name: "주요 뉴스" });
    const card = heading.closest("section") as HTMLElement;
    await within(card).findByRole("link", { name: /합성 기사/ });
    expect(within(card).queryByText(LIMIT_TEXT)).toBeNull();

    const news = requested().filter((path) => path.startsWith("/api/detail/news"));
    expect(news.length).toBeGreaterThan(0);
    for (const path of news) expect(newsQuery(path)).toBe(CLAMPED);

    // 카드 머리의 '정보 검색' 링크도 같은 말로(NewsCard — 지표·기관 상세와 같게). 이름 전체를 넘기면 정보 검색 연결이 60글자에서 낱말 가운데로
    // 잘라 '…Incorporated In'이 되어 카드의 검색어와 달랐습니다(QA-448 검토 지적).
    const link = within(card).getByRole("link", { name: "정보 검색" });
    expect(link.getAttribute("href")).toBe(`/search?q=${encodeURIComponent(CLAMPED)}`);
    expect(link.getAttribute("title")).toBe(`‘${CLAMPED}’ 정보 검색 — 최근 2년의 기사·글`);
  });

  it("AI 요약 요청의 q·label도 같은 검색어로 60자 안 — 요약이 보인다", async () => {
    render(
      <SessionUserProvider user={PRO}>
        <StockDetailScreen market="us" code="FUFH" />
      </SessionUserProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: LONG_NAME });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AI 요약 만들기" }));
    });
    expect(api.apiPost).toHaveBeenCalledWith("/api/detail/summary", { market: "us", code: "FUFH", q: CLAMPED, label: CLAMPED });
    const card = screen.getByRole("heading", { name: "AI 요약" }).closest("section") as HTMLElement;
    expect(within(card).getByText("한 줄 요약: 합성 요약")).toBeTruthy();
  });
});
