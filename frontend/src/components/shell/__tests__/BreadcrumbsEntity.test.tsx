/**
 * 넓은 화면 빵부스러기의 대상 이름(P4) — 상세 화면이 읽은 이름이 마지막 칸(지금 화면, aria-current="page")에 보입니다. 응답은 모두 합성 값입니다.
 * 셸 전체 시험(Shell.test)은 그대로 두고, 빵부스러기와 상세 화면을 함께 그려 봅니다 — 이름을 받기 전·찾지 못함은 주소의 식별자 그대로, 다른 주소면 무시.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { IndicatorDetailScreen } from "@/components/screens/detail/IndicatorDetailScreen";
import { InstitutionDetailScreen } from "@/components/screens/detail/InstitutionDetailScreen";
import { StockDetailScreen } from "@/components/screens/detail/StockDetailScreen";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { resetEntityCrumbForTest } from "@/hooks/useEntityCrumb";
import { endpoints } from "@/lib/endpoints";
import { macroOverview } from "@/lib/__tests__/homeFixtures";
import type { SessionUser } from "@/lib/types";
import { Breadcrumbs } from "../Breadcrumbs";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const CIK = "0009999995";
const PORTFOLIO = endpoints.institution.portfolio(CIK, 8, 30);

let portfolio: { resolve: (body: unknown) => void; reject: (error: Error) => void } | null = null;

beforeEach(() => {
  portfolio = null;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === PORTFOLIO ? new Promise((resolve, reject) => (portfolio = { resolve, reject })) : new Promise(() => {}),
  );
});
afterEach(() => {
  cleanup();
  act(() => resetEntityCrumbForTest());
});

const current = () => within(screen.getByRole("navigation", { name: "현재 위치" })).getByText((_, element) => element?.getAttribute("aria-current") === "page");

function renderAt(pathname: string) {
  return render(
    <SessionUserProvider user={MEMBER}>
      <Breadcrumbs pathname={pathname} user={MEMBER} />
      <InstitutionDetailScreen cik={CIK} />
    </SessionUserProvider>,
  );
}

describe("빵부스러기 — 상세 화면이 읽은 대상 이름", () => {
  it("이름을 받기 전은 'CIK …', 받으면 마지막 칸이 기관 이름(지금 화면 표시 그대로), 화면을 떠나면 다시 'CIK …'", async () => {
    const view = renderAt(`/institutions/${CIK}`);
    expect(current().textContent).toBe(`CIK ${CIK}`);
    await act(async () =>
      portfolio?.resolve({ available: true, cik: CIK, institution: { name: "🇺🇸 가상 연금 (Fictional Pension)", desc: "" }, quarters: [], holdings: [] }),
    );
    expect(current().textContent).toBe("가상 연금 (Fictional Pension)");
    expect(current().getAttribute("title")).toBe("가상 연금 (Fictional Pension)");
    // 앞 칸(기관 › 13F 포트폴리오)은 그대로 — 링크는 '13F 포트폴리오' 하나
    const nav = screen.getByRole("navigation", { name: "현재 위치" });
    // '기관'(→ /institutions)은 뒤 칸 '13F 포트폴리오'와 주소가 같아 글 칸입니다(QA-549).
    expect(within(nav).getAllByRole("link").map((link) => link.textContent)).toEqual(["13F 포트폴리오"]);

    // 상세 화면이 사라지면(다른 화면) 이름도 사라짐
    view.rerender(
      <SessionUserProvider user={MEMBER}>
        <Breadcrumbs pathname={`/institutions/${CIK}`} user={MEMBER} />
      </SessionUserProvider>,
    );
    expect(current().textContent).toBe(`CIK ${CIK}`);
  });

  it("포트폴리오를 읽지 못해 이름을 모르면 'CIK …' 그대로", async () => {
    renderAt(`/institutions/${CIK}`);
    await act(async () => portfolio?.reject(new Error("13F 저장본을 읽지 못했습니다.")));
    expect(current().textContent).toBe(`CIK ${CIK}`);
  });

  it("빵부스러기 주소가 다른 대상이면 넘긴 이름을 쓰지 않는다", async () => {
    renderAt("/institutions/1234");
    await act(async () =>
      portfolio?.resolve({ available: true, cik: CIK, institution: { name: "가상 연금 (Fictional Pension)", desc: "" }, quarters: [], holdings: [] }),
    );
    expect(current().textContent).toBe("CIK 1234");
  });

  it("종목은 시세를 읽은 뒤 종목 이름(한글 이름이 있으면 한글), 지표는 카드 이름", async () => {
    api.apiGetShared.mockImplementation((path: string) => {
      if (path === endpoints.detail.quote("kr", "005930")) {
        return Promise.resolve({
          available: true,
          quote: {
            market: "kr", code: "005930", yahooSymbol: "005930.KS", name: "삼성전자", exchange: "코스피", currency: "KRW", kind: "stock", price: 71200,
            previousClose: 72000, change: -800, changePct: -1.11, asOf: null, marketState: null, stats: [], profile: null, consensus: null, research: [],
            source: null, error: null, fetchedAt: null,
          },
        });
      }
      if (path === endpoints.macro.overview(false)) return Promise.resolve(macroOverview());
      return new Promise(() => {});
    });
    const stock = render(
      <SessionUserProvider user={MEMBER}>
        <Breadcrumbs pathname="/s/kr/005930" user={MEMBER} />
        <StockDetailScreen market="kr" code="005930" />
      </SessionUserProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: "삼성전자" });
    expect(current().textContent).toBe("삼성전자");
    stock.unmount();

    render(
      <SessionUserProvider user={MEMBER}>
        <Breadcrumbs pathname="/markets/i/usdkrw" user={MEMBER} />
        <IndicatorDetailScreen indicatorKey="usdkrw" />
      </SessionUserProvider>,
    );
    await screen.findByRole("heading", { level: 1, name: "원/달러 (USD/KRW)" });
    expect(current().textContent).toBe("원/달러 (USD/KRW)");
  });
});
