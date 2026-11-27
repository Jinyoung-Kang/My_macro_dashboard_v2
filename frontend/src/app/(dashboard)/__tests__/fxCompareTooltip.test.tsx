/**
 * 매크로 '환율·달러인덱스 비교' 차트의 툴팁(2026-11-18 사용자 요구) — 그 날 값이 큰 차례로 줄을 놓고, 줄 글자는 선 색으로.
 *
 * 공용 선 차트의 선택 prop 둘(`tooltipOrder="value"`·`tooltipSeriesColors`)을 켰는지만 봅니다. 차례·색 자체(Recharts 툴팁에 넘기는 것, 대비가 모자란 보라만
 * 밝힘)는 components/charts/__tests__/seriesTooltip.test.tsx와 lib/__tests__/chartTooltip.test.ts가 봅니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트 크기가 0이라 그림이 없습니다 — 받은 이름·툴팁 prop만 그립니다.
vi.mock("@/components/charts", () => ({
  MultiLineSeries: ({ ariaLabel, tooltipOrder, tooltipSeriesColors }: { ariaLabel?: string; tooltipOrder?: string; tooltipSeriesColors?: boolean }) => (
    <figure aria-label={ariaLabel} data-tooltip-order={tooltipOrder ?? ""} data-tooltip-colors={String(Boolean(tooltipSeriesColors))} />
  ),
}));

import { FxCompareSection } from "../macro/FxCompareSection";

afterEach(() => cleanup());

/** 계열 하나(기준일 = 100) — 응답 모양 그대로(lib/types FxSeries). */
const fxSeries = (id: string, label: string, unit: string, last: number) => ({
  id, label, unit, ticker: null, available: true, latest: last, latestDate: "2026-11-17", baseDate: "2026-11-16", baseValue: 100,
  changePct: last - 100, points: [{ date: "2026-11-16", value: 100 }, { date: "2026-11-17", value: last }],
});

describe("환율·달러인덱스 비교 툴팁", () => {
  it("값이 큰 차례와 선 색 글자를 켠다", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith("/api/macro/fx")
        ? Promise.resolve({
            available: true,
            period: "1y",
            mode: "index",
            catalog: [{ id: "usdkrw", label: "원/달러", unit: "원", ticker: null }, { id: "dxy", label: "달러 인덱스", unit: "pt", ticker: null }],
            series: [fxSeries("usdkrw", "원/달러", "원", 101.2), fxSeries("dxy", "달러 인덱스", "pt", 99.4)],
          })
        : new Promise(() => {}),
    );
    render(<FxCompareSection />);

    const chart = await screen.findByRole("figure", { name: /환율·달러인덱스 비교/ });
    expect(chart.dataset.tooltipOrder).toBe("value");
    expect(chart.dataset.tooltipColors).toBe("true");
  });
});
