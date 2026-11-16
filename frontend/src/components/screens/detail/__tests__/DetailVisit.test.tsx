/**
 * 상세 화면 방문 → 명령 팔레트의 '최근 연 대상'(P4 — 이 브라우저의 localStorage, 형식은 lib/palette). 응답은 모두 합성 값입니다.
 * 대상 이름을 읽은 뒤에만 넣고, 찾지 못함·읽기 실패·조회하지 않음·'CIK …' 자리표시 이름은 넣지 않습니다.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEntityCrumbForTest, useEntityCrumbLabel } from "@/hooks/useEntityCrumb";
import { resetRecentEntitiesForTest } from "@/hooks/useRecentEntities";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { RECENT_STORAGE_KEY, parseRecent, serializeRecent } from "@/lib/palette";
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

let reads: Record<string, unknown> = {};

beforeEach(() => {
  window.localStorage.clear();
  act(() => resetRecentEntitiesForTest());
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});
afterEach(() => {
  cleanup();
  act(() => resetEntityCrumbForTest());
});

const recent = () => parseRecent(window.localStorage.getItem(RECENT_STORAGE_KEY));

/** 빵부스러기 저장소(상세 화면이 넘긴 대상 이름) — 비었으면 빈 글. */
function CrumbProbe() {
  const crumb = useEntityCrumbLabel();
  return <output data-testid="crumb">{crumb?.label ?? ""}</output>;
}
const renderAs = (page: ReactElement) => render(<SessionUserProvider user={MEMBER}>{page}</SessionUserProvider>);

const QUOTE: DetailQuote = {
  market: "us", code: "SYNV", yahooSymbol: "SYNV", name: "Synthetic Visit Inc.", nameKo: "합성 방문", exchange: "NYSE", currency: "USD", kind: "EQUITY",
  price: 10, previousClose: 9.5, change: 0.5, changePct: 5.26, asOf: null, marketState: null, stats: [], profile: null, consensus: null, research: [],
  source: null, error: null, fetchedAt: null,
};

describe("상세 화면 방문 → 최근 연 대상", () => {
  it("종목 — 시세를 읽은 뒤 이름(한글 우선)·종목 줄·종목 상세 주소로", async () => {
    reads[endpoints.detail.quote("us", "SYNV")] = { available: true, quote: QUOTE };
    renderAs(<StockDetailScreen market="us" code="SYNV" />);
    await screen.findByRole("heading", { level: 1, name: "합성 방문" });
    await waitFor(() =>
      expect(recent()).toEqual([
        { kind: "ticker", label: "합성 방문", sub: "Synthetic Visit Inc. · SYNV · NYSE · 주식 · USD", href: "/s/us/SYNV", dest: "종목 상세" },
      ]),
    );
  });

  it("종목 — 조회하지 않음(store_only)·읽기 실패는 넣지 않는다", async () => {
    reads[endpoints.detail.quote("us", "SYNV")] = { available: false, message: "store_only 모드에서는 외부 시세를 조회하지 않습니다." };
    const first = renderAs(<StockDetailScreen market="us" code="SYNV" />);
    await screen.findAllByText("store_only 모드에서는 외부 시세를 조회하지 않습니다.");
    first.unmount();
    reads[endpoints.detail.quote("us", "SYNV")] = new Error("시세 서버가 응답하지 않습니다.");
    renderAs(<StockDetailScreen market="us" code="SYNV" />);
    await waitFor(() => expect(screen.getAllByText("시세 서버가 응답하지 않습니다.").length).toBeGreaterThan(0));
    expect(recent()).toEqual([]);
  });

  // QA-577: 수집기는 출처 연결 실패·요청 제한·정보 없는 심볼에도 available:true + quote{name:null, error}를 돌려줍니다. 화면이 quote 객체가 있는지만
  // 보고 방문을 넣어, 코드만 있는 항목(label·sub 모두 코드)이 같은 주소의 이름 있는 항목(팔레트가 넣은 것·앞선 정상 방문)을 덮었습니다
  // (P4 '정한 것' 7 — 이름을 읽은 뒤에만). 빵부스러기 저장소에도 코드가 이름으로 들어갔습니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 recent()가 [{label:'SYNV', sub:'SYNV · NYSE · 주식 · USD', …}]이고 빵부스러기 저장소가 'SYNV'였습니다.
  it.fails("종목 — 시세 객체는 왔지만 이름이 없으면(name:null + error) 넣지 않고, 같은 주소의 이름 있는 항목을 덮지 않는다 (QA-577)", async () => {
    const named = { kind: "ticker" as const, label: "합성 방문", sub: "Synthetic Visit Inc. · SYNV · 정보기술", href: "/s/us/SYNV", dest: "종목 상세" };
    window.localStorage.setItem(RECENT_STORAGE_KEY, serializeRecent([named]));
    act(() => resetRecentEntitiesForTest());
    reads[endpoints.detail.quote("us", "SYNV")] = {
      available: true,
      quote: { ...QUOTE, name: null, nameKo: null, price: null, change: null, changePct: null, error: "YahooNoResponse: 합성" },
    };
    render(
      <SessionUserProvider user={MEMBER}>
        <CrumbProbe />
        <StockDetailScreen market="us" code="SYNV" />
      </SessionUserProvider>,
    );
    await screen.findByText(/일부 값을 받지 못했습니다/);
    await act(async () => {});
    expect(recent()).toEqual([named]);
    expect(screen.getByTestId("crumb").textContent).toBe("");
  });

  it("지표 — 찾은 카드 이름·'범주 · 티커'로, 찾지 못한 키는 넣지 않는다", async () => {
    reads[endpoints.macro.overview(false)] = macroOverview();
    reads["/api/calendar/kr-holidays"] = { available: true, years: {} };
    const first = renderAs(<IndicatorDetailScreen indicatorKey="nope" />);
    await screen.findByRole("heading", { level: 1, name: "지표를 찾지 못했습니다" });
    expect(recent()).toEqual([]);
    first.unmount();

    renderAs(<IndicatorDetailScreen indicatorKey="usdkrw" />);
    await screen.findByRole("heading", { level: 1, name: "원/달러 (USD/KRW)" });
    await waitFor(() =>
      expect(recent()).toEqual([{ kind: "indicator", label: "원/달러 (USD/KRW)", sub: "통화 및 환율 · KRW=X", href: "/markets/i/usdkrw", dest: "지표 상세" }]),
    );
  });

  it("기관 — 이름을 받은 뒤에만('CIK …' 자리표시·읽기 실패는 넣지 않음)", async () => {
    let resolve: (body: unknown) => void = () => {};
    api.apiGetShared.mockImplementation((path: string) =>
      path === endpoints.institution.portfolio("0001067983", 8, 30) ? new Promise((done) => (resolve = done)) : new Promise(() => {}),
    );
    renderAs(<InstitutionDetailScreen cik="0001067983" />);
    await screen.findByRole("heading", { level: 1, name: "CIK 0001067983" });
    await act(async () => {});
    expect(recent()).toEqual([]);
    await act(async () => resolve({ available: true, cik: "0001067983", institution: { name: "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)" }, quarters: [], holdings: [] }));
    await waitFor(() =>
      expect(recent()).toEqual([
        { kind: "institution", label: "버크셔 해서웨이 (Berkshire Hathaway)", sub: "13F · CIK 0001067983", href: "/institutions/0001067983", dest: "기관 상세" },
      ]),
    );
    cleanup();

    window.localStorage.clear();
    act(() => resetRecentEntitiesForTest());
    reads = { [endpoints.institution.portfolio("1234567", 8, 30)]: new Error("추적하지 않는 기관입니다.") };
    api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.reject(reads[path]) : new Promise(() => {})));
    renderAs(<InstitutionDetailScreen cik="1234567" />);
    await waitFor(() => expect(screen.getAllByText("추적하지 않는 기관입니다.").length).toBeGreaterThan(0));
    expect(recent()).toEqual([]);
  });
});
