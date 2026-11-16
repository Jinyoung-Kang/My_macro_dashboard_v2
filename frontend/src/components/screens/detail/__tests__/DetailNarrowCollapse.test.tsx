/**
 * 상세 세 화면 — 좁은 화면(lg 미만)에서 왼쪽 속성 칸을 처음에 접는다(2026-11-16 결정 2, SplitPane collapseLeft). 응답은 모두 합성 값입니다.
 *
 * lg 미만은 한 칸이라 대상 머리 → 왼쪽 속성 → 가운데 탭 차례이고, 왼쪽 속성(종목은 핵심 지표 12줄·회사 개요·의견)이 탭·차트를 첫 화면 밖으로 밀었습니다
 * (390 종목 상세 탭 줄 y≈1,490, 지표 y≈791, 기관 y≈847). 화면마다 그 칸을 펼치기 단추 하나 뒤로 접고(이름은 그 칸의 패널 이름), 넓은 화면(lg 이상)은
 * 클래스로 늘 펼칩니다(jsdom은 배치를 계산하지 않으므로 클래스·속성으로 봅니다 — 실제 y는 브라우저 측정).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
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
const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

function quote(overrides: Partial<DetailQuote> = {}): DetailQuote {
  return {
    market: "us", code: "SYNQ", yahooSymbol: "SYNQ", name: "Synthetic Corp", exchange: "NasdaqGS", currency: "USD", kind: "EQUITY",
    price: 10, previousClose: 9.5, change: 0.5, changePct: 5.26, asOf: "2026-11-14T21:00:00+00:00", marketState: "CLOSED",
    stats: [{ key: "marketCap", label: "시가총액", value: 1_000_000_000, text: null, unit: "money" }],
    profile: { sector: "Technology", industry: "Software", country: "United States", website: null, employees: 100, summary: null },
    consensus: null, research: [], source: { label: "Yahoo Finance", url: "https://finance.yahoo.com/quote/SYNQ" }, error: null,
    fetchedAt: "2026-11-16T07:00:00+00:00", ...overrides,
  };
}

/** 펼치기 단추가 가리키는 칸 — 단추 바로 뒤 형제이고, 그 안에 `heading` 패널이 있다. */
function controlledColumn(name: string, heading: string) {
  const button = screen.getByRole("button", { name });
  const column = document.getElementById(button.getAttribute("aria-controls") ?? "") as HTMLElement;
  expect(column).not.toBeNull();
  expect(button.nextElementSibling).toBe(column);
  // 접어도 마운트된 채 — 안의 패널 제목이 DOM에 있음(요청 시점 그대로)
  expect(column.querySelector("h2")?.textContent).toBe(heading);
  return { button, column };
}

describe("상세 세 화면 — lg 미만에서 왼쪽 속성 칸을 처음에 접음(결정 2)", () => {
  it("종목 — '핵심 지표·회사 개요 펼치기'(회사 개요가 있을 때), 누르면 '접기'와 숨김 클래스 해제", async () => {
    reads = { [endpoints.detail.quote("us", "SYNQ")]: { available: true, quote: quote() } };
    renderAs(<StockDetailScreen market="us" code="SYNQ" />);
    await screen.findByRole("heading", { level: 1, name: "Synthetic Corp" });
    const { button, column } = controlledColumn("핵심 지표·회사 개요 펼치기", "핵심 지표");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(tokens(button)).toEqual(expect.arrayContaining(["min-h-11", "lg:hidden"]));
    expect(tokens(column)).toContain("max-lg:hidden");
    expect(column.textContent).toContain("회사 개요");
    // 단추 → 왼쪽 칸 → 가운데 탭(차례가 보이는 차례와 같음)
    const tablist = screen.getByRole("tablist", { name: "Synthetic Corp 내용" });
    expect(column.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "핵심 지표·회사 개요 접기" }).getAttribute("aria-expanded")).toBe("true");
    expect(tokens(column)).not.toContain("max-lg:hidden");
  });

  it("종목 — 회사 개요가 없으면(지수·시세 전) 단추 이름은 '핵심 지표'", async () => {
    reads = { [endpoints.detail.quote("us", "SYNQ")]: { available: true, quote: quote({ kind: "INDEX", profile: null }) } };
    renderAs(<StockDetailScreen market="us" code="SYNQ" />);
    await screen.findByRole("heading", { level: 1, name: "Synthetic Corp" });
    controlledColumn("핵심 지표 펼치기", "핵심 지표");
  });

  // 검토 지적(결정 반영 묶음): 시세 읽기 실패(500·시간 초과)의 '다시 시도'가 왼쪽 칸 '핵심 지표' 패널(QA-190)에만 있어, 칸을 접는 좁은 화면에서는
  // 펼치기 전에 다시 읽을 방법이 보이지 않았습니다(대상 머리에는 위험 안내 글뿐). 다시 시도는 늘 보이는 대상 머리에 하나만 두고(지표 상세 QA-588과
  // 같은 자리), 칸에는 까닭 글만 둡니다 — 넓은 화면에 다시 시도가 둘이 되지 않게.
  it("종목 — 시세 읽기 실패의 '다시 시도'는 접는 칸 밖(대상 머리)에 하나, 누르면 시세를 다시 읽음", async () => {
    const path = endpoints.detail.quote("us", "SYNQ");
    reads = { [path]: new Error("시세 서버가 응답하지 않습니다.") };
    renderAs(<StockDetailScreen market="us" code="SYNQ" />);
    const header = (await screen.findByRole("heading", { level: 1, name: "SYNQ" })).closest("header") as HTMLElement;
    const retry = await within(header).findByRole("button", { name: "다시 시도" });
    expect(within(header).getByText("시세 서버가 응답하지 않습니다.")).toBeTruthy();
    const { column } = controlledColumn("핵심 지표 펼치기", "핵심 지표");
    expect(column.contains(retry)).toBe(false);
    expect(within(column).queryByRole("button", { name: "다시 시도" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "다시 시도" })).toHaveLength(1);
    expect(column.textContent).toContain("시세를 읽지 못해 핵심 지표가 없습니다.");
    const calls = () => api.apiGetShared.mock.calls.filter(([requested]) => requested === path).length;
    const before = calls();
    fireEvent.click(retry);
    await waitFor(() => expect(calls()).toBe(before + 1));
  });

  it("지표 — '속성 펼치기'", async () => {
    reads = { [endpoints.macro.overview(false)]: macroOverview(), "/api/calendar/kr-holidays": { available: true, years: {} } };
    renderAs(<IndicatorDetailScreen indicatorKey="sp500" />);
    await screen.findByRole("heading", { level: 1, name: "S&P 500" });
    const { column } = controlledColumn("속성 펼치기", "속성");
    expect(tokens(column)).toContain("max-lg:hidden");
  });

  it("기관 — '속성 펼치기'(이름을 받기 전에도)", async () => {
    renderAs(<InstitutionDetailScreen cik="0001067983" />);
    await screen.findByRole("heading", { level: 1, name: "CIK 0001067983" });
    const { column } = controlledColumn("속성 펼치기", "속성");
    expect(tokens(column)).toContain("max-lg:hidden");
  });
});
