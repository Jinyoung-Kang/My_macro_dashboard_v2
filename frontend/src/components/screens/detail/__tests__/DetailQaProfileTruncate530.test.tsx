/**
 * 종목 상세 '회사 개요' 값의 말줄임(QA-530). 응답은 모두 합성 값입니다(가상 회사).
 *
 * D1 QA 스택 확인(`stock-profile-value-truncate`)에서 1024의 옆 칸(값 칸 약 172px)에 영문 업종이 들어가면 '회사 개요' 값이 한 줄 말줄임(truncate)으로
 * 잘렸습니다. 같은 화면의 핵심 지표·애널리스트 의견(KeyStats)은 QA-455에서 말줄임을 없앴는데 회사 개요 표만 남아 있었습니다. 숫자·이름을 잘라 보이지
 * 않습니다(PRINCIPLES) — 값은 낱말 사이에서 줄을 바꾸고(break-keep) 칸보다 긴 낱말만 칸 안에서 끊습니다(wrap-anywhere). jsdom은 배치를 재지
 * 못하므로 고침이 세우는 구조(값 글에서 카드까지 말줄임·줄바꿈 금지 클래스가 없고 줄바꿈 규칙이 있음)를 대조하고, 실제 폭은 QA 스택 브라우저로 봅니다.
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

/** 1024 옆 칸(172px)보다 긴 영문 업종 — 낱말 사이에서 줄을 바꿔야 끝까지 보입니다. */
const INDUSTRY = "Semiconductor Equipment & Materials Distribution";

const QUOTE: DetailQuote = {
  market: "us", code: "SYNP", yahooSymbol: "SYNP", name: "Synthetic Profile Corp", exchange: "NASDAQ", currency: "USD", kind: "EQUITY",
  price: 10.5, previousClose: 10.4, change: 0.1, changePct: 0.96, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
  stats: [],
  profile: { sector: "Technology", industry: INDUSTRY, country: "United States", website: null, employees: 1200, summary: "Synthetic profile." },
  consensus: null, research: [], source: { label: "합성 출처", url: "https://quote.example/SYNP" }, error: null, fetchedAt: "2026-11-15T00:00:00+00:00",
};

/** 요소의 클래스 낱말(접두가 붙은 것은 따로 — 'truncate'와 'lg:truncate'는 다른 낱말). */
const classes = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/** element에서 stop(포함)까지 올라가는 조상 줄 — 말줄임·줄바꿈 금지는 조상 상자에서도 걸리므로 줄 전체를 봅니다. */
function chainTo(element: Element, stop: Element): Element[] {
  const chain: Element[] = [];
  for (let node: Element | null = element; node && stop.contains(node); node = node.parentElement) chain.push(node);
  return chain;
}

/** 값 글을 자르거나(말줄임·넘침 숨김) 한 줄로 묶는(줄바꿈 금지) 클래스 — 어느 폭 접두든. */
const CLIPS = /^(?:[a-z0-9]+:)*(?:truncate|text-ellipsis|text-clip|overflow-hidden|overflow-x-hidden|whitespace-nowrap|line-clamp-\d+)$/;

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.detail.quote("us", "SYNP") ? Promise.resolve({ available: true, quote: QUOTE }) : new Promise(() => {}),
  );
});
afterEach(cleanup);

describe("종목 상세 — '회사 개요' 값이 말줄임으로 잘리지 않는다(QA-530)", () => {
  // QA-530: 회사 개요 표의 값 칸(dd)이 'min-w-0 truncate'라 좁은 옆 칸에서 긴 영문 업종이 '…'로 잘렸습니다.
  // 수정 전 실패: 업종 값 글에서 카드까지의 줄에 'truncate'가 있음(재현 커밋에서는 it.fails).
  // 고침: 값 칸을 break-keep·wrap-anywhere로(말줄임 없음), 이름 칸은 줄지 않음(shrink-0).
  it("업종·섹터·나라·직원 수 값에서 카드까지 말줄임·줄바꿈 금지가 없고, 낱말 사이에서 줄을 바꾼다", async () => {
    render(
      <SessionUserProvider user={MEMBER}>
        <StockDetailScreen market="us" code="SYNP" />
      </SessionUserProvider>,
    );
    const card = (await screen.findByRole("heading", { name: "회사 개요" })).closest("section") as HTMLElement;

    // 결함을 직접 보는 단언 먼저(수정 전에는 여기서 실패).
    for (const text of [INDUSTRY, "기술", "미국", "1,200명"]) {
      const value = within(card).getByText(text);
      expect(chainTo(value, card).flatMap((node) => classes(node).filter((word) => CLIPS.test(word)))).toEqual([]);
      const chain = chainTo(value, card);
      expect(chain.some((node) => classes(node).includes("break-keep"))).toBe(true);
      expect(chain.some((node) => classes(node).includes("wrap-anywhere"))).toBe(true);
    }
  });
});
