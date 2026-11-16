/**
 * 지표 상세 — 뜻이 다른 티커(미국채 2년물 ZT=F)를 대상 식별자로 보이지 않는다(QA-589). 응답은 모두 합성 값입니다.
 *
 * 2년물 카드 값은 TradingView 수익률(%)인데 수집기 카탈로그의 티커 ZT=F는 Yahoo 2년물 선물 가격입니다. 화면은 이미 '뜻이 다른 티커'로 차트를
 * 그리지 않고(INDICATOR_NO_CHART) 연결에서도 빼는데, 대상 머리의 고정폭 식별자 태그와 속성 '티커' 줄은 ZT=F를 이 지표의 식별자로 보였습니다.
 * 같은 규칙으로 머리 태그에서 빼고, 속성 '티커' 줄은 값(수집기 경고가 가리키는 이름)을 두되 이 카드 값의 출처가 아니라고 적습니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { macroOverview } from "@/lib/__tests__/homeFixtures";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { IndicatorDetailScreen } from "../IndicatorDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const NOTE = "Yahoo 선물 가격 — 이 카드 값(수익률)의 출처가 아님";

beforeEach(() => {
  const overview = macroOverview();
  overview.categories.push({
    id: "ust",
    title: "미국 국채 수익률",
    items: [
      // 카드 값 출처는 실제 저장본처럼 TradingView(수집기 us02y) — 출처가 없으면 출처 배지가 티커로 'Yahoo Finance (ZT=F)'를 지어 냅니다.
      { key: "us02y", name: "미국채 2년물 수익률(%)", ticker: "ZT=F", source: "TradingView Scanner", status: "ok", priceStr: "3.512", market: "ust" },
      { key: "us10y", name: "미국채 10년물 수익률(%)", ticker: "^TNX", status: "ok", priceStr: "4.105", market: "ust" },
      { key: "us30y", name: "미국채 30년물 수익률(%)", ticker: "^TYX", status: "ok", priceStr: "4.712", market: "ust" },
    ],
  });
  const reads: Record<string, unknown> = { [endpoints.macro.overview(false)]: overview, "/api/calendar/kr-holidays": { available: true, years: {} } };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(cleanup);

function renderIndicator(key: string) {
  render(
    <SessionUserProvider user={MEMBER}>
      <IndicatorDetailScreen indicatorKey={key} />
    </SessionUserProvider>,
  );
}

const row = (label: string) => {
  const props = screen.getByRole("heading", { level: 2, name: "속성" }).closest("section") as HTMLElement;
  return within(props).getByText(label).closest("div") as HTMLElement;
};

describe("뜻이 다른 티커는 대상 식별자가 아님 (QA-589)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 us02y 머리 태그가 ['지표', 'ZT=F'](ZT=F는 고정폭)이고 속성 '티커' 줄에 note가 없었습니다.
  it("us02y — 머리에 ZT=F 태그 없음, 속성 '티커' 줄은 ZT=F(고정폭)와 출처가 아니라는 note", async () => {
    renderIndicator("us02y");
    const header = (await screen.findByRole("heading", { level: 1, name: "미국채 2년물 수익률(%)" })).closest("header") as HTMLElement;
    expect(within(header).queryByText("ZT=F")).toBeNull();
    expect(header.querySelectorAll(".font-mono")).toHaveLength(0);
    const ticker = row("티커");
    expect(within(ticker).getByText("ZT=F").className).toContain("font-mono");
    expect(within(ticker).getByText(NOTE)).toBeTruthy();
  });

  it("us10y — 머리 식별자 태그 '^TNX' 그대로(고정폭), '티커' 줄 note 없음", async () => {
    renderIndicator("us10y");
    const header = (await screen.findByRole("heading", { level: 1, name: "미국채 10년물 수익률(%)" })).closest("header") as HTMLElement;
    expect(within(header).getByText("^TNX").className).toContain("font-mono");
    expect(within(row("티커")).queryByText(NOTE)).toBeNull();
  });

  // 같은 범주 목록(오른쪽 칸)도 같은 화면군의 표면 — 머리 태그에서 뺀 ZT=F를 '^TYX · 미국 국채'와 같은 문법의 보조 글로 적으면 다시 이 지표의 식별자로 보입니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 us10y 화면의 2년물 줄 보조 글이 'ZT=F · 미국 국채'였습니다.
  it.fails("같은 범주 목록 — 2년물 줄 보조 글은 시장 이름만(ZT=F 없음), 다른 줄은 '티커 · 시장' 그대로", async () => {
    renderIndicator("us10y");
    const panel = (await screen.findByRole("heading", { level: 2, name: "미국 국채 수익률 — 같은 범주" })).closest("section") as HTMLElement;
    const items = within(panel).getAllByRole("listitem");
    const us02y = items.find((item) => item.textContent?.includes("미국채 2년물")) as HTMLElement;
    const us30y = items.find((item) => item.textContent?.includes("미국채 30년물")) as HTMLElement;
    expect(us02y.textContent).not.toContain("ZT=F");
    expect(within(us02y).getByText("미국 국채")).toBeTruthy();
    expect(within(us30y).getByText("^TYX · 미국 국채")).toBeTruthy();
  });
});
