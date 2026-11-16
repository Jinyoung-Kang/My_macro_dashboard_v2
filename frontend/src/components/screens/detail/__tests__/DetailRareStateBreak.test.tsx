/**
 * 상세 화면의 드문 상태 문장 — 한글을 낱말 사이에서만 줄바꿈(break-keep — word-break: keep-all). 응답은 모두 합성 값입니다.
 *
 * 공용 글 부품의 같은 규칙(QA-568 — 패널 부제·속성 빈 글·상태 글 등)을 화면이 직접 그리는 문단에도 둡니다: 지표를 찾지 못한 화면의 안내, 시세를
 * 받지 않은 종목의 '핵심 지표' 문단, 13F 보유 기관 0건 안내 두 문단(앞 커밋 'style(frontend): 지표·종목 상세의 드문 상태 문장에도 …'이 붙인 것을
 * 구조로 고정), 추적하지 않는 기관의 분기 차트 문단(QA-584 후속). jsdom은 배치를 재지 못하므로 문단(과 그 조상)의 클래스를 대조하고, 실제
 * 줄바꿈은 QA 스택 브라우저로 쟀습니다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { holdersNoMatch } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { macroOverview } from "@/lib/__tests__/homeFixtures";
import type { DetailQuote, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { IndicatorDetailScreen } from "../IndicatorDetailScreen";
import { InstitutionDetailScreen } from "../InstitutionDetailScreen";
import { StockDetailScreen } from "../StockDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const QUERY = "SYNTHETIC ALPHA";

const QUOTE: DetailQuote = {
  market: "us", code: "SYNA", yahooSymbol: "SYNA", name: "Synthetic Alpha Inc.", exchange: "NasdaqGS", currency: "USD", kind: "EQUITY",
  price: 180, previousClose: 179, change: 1, changePct: 0.56, asOf: null, marketState: "CLOSED", stats: [], profile: null, consensus: null,
  research: [], source: { label: "합성 출처", url: "https://quote.example/SYNA" }, error: null, fetchedAt: null,
};

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

const renderAs = (page: ReactElement) => render(<SessionUserProvider user={MEMBER}>{page}</SessionUserProvider>);

/** 글 요소에서 문단(p)까지 올라가며 break-keep이 있는지 — word-break는 상속되므로 문단이나 그 안 어디에 있어도 됩니다. */
function keepsWords(text: string | RegExp): boolean {
  const element = screen.getByText(text);
  const paragraph = element.closest("p");
  if (!paragraph) throw new Error(`'${String(text)}'를 담은 문단이 없음`);
  for (let node: Element | null = element; node; node = node.parentElement) {
    if ((node.getAttribute("class") ?? "").split(/\s+/).includes("break-keep")) return true;
    if (node === paragraph) break;
  }
  return false;
}

describe("상세 화면의 드문 상태 문장 — 한글은 낱말 사이에서만 줄바꿈", () => {
  it("지표를 찾지 못한 화면의 안내 문단", async () => {
    reads[endpoints.macro.overview(false)] = macroOverview();
    renderAs(<IndicatorDetailScreen indicatorKey="nosuchkey" />);
    await screen.findByRole("heading", { level: 1, name: "지표를 찾지 못했습니다" });
    expect(keepsWords(/지표가 없습니다/)).toBe(true);
  });

  it("시세를 받지 않은 종목의 '핵심 지표' 문단", async () => {
    reads[endpoints.detail.quote("us", "SYNA")] = { available: false, message: "store_only 모드에서는 외부 시세를 조회하지 않습니다." };
    renderAs(<StockDetailScreen market="us" code="SYNA" />);
    await screen.findByText("시세를 받지 않아 핵심 지표가 없습니다.");
    expect(keepsWords("시세를 받지 않아 핵심 지표가 없습니다.")).toBe(true);
  });

  it("13F 보유 기관 0건 안내 두 문단", async () => {
    reads[endpoints.detail.quote("us", "SYNA")] = { available: true, quote: QUOTE };
    reads[endpoints.institution.guruHolders(QUERY)] = { available: true, query: QUERY, rows: [], totalMatches: 0, truncated: false };
    renderAs(<StockDetailScreen market="us" code="SYNA" />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유 기관" }));
    const noMatch = holdersNoMatch(QUERY);
    await screen.findByText(noMatch.title);
    expect([keepsWords(noMatch.title), keepsWords(noMatch.note)]).toEqual([true, true]);
  });

  it("추적하지 않는 기관의 분기 차트 문단", async () => {
    const { ApiError } = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
    reads[endpoints.institution.portfolio("0000000001", 8, 30)] = new ApiError("추적하지 않는 기관 CIK입니다: 0000000001", 400);
    renderAs(<InstitutionDetailScreen cik="0000000001" />);
    await screen.findByText("추적하지 않는 기관이라 13F 추이가 없습니다.");
    expect(keepsWords("추적하지 않는 기관이라 13F 추이가 없습니다.")).toBe(true);
  });
});
