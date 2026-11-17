/**
 * 순유동성(/liquidity) 화면 — 부호·변화 표시(QA-627)와 작업대 배치(KPI 띠·패널 차트 — P5a).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// 차트는 받은 이름·격자만 봅니다(jsdom은 크기가 없어 그림을 그리지 않음).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineSeries: ({ ariaLabel, grid, height }: { ariaLabel?: string; grid?: boolean; height?: number }) => (
    <div data-chart="line" data-name={ariaLabel ?? ""} data-grid={grid ? "yes" : "no"} data-height={height ?? ""} />
  ),
}));

import LiquidityPage from "../liquidity/page";

/** 줄 처음·공백·여는 괄호 뒤의 ASCII 하이픈 음수 부호(lib/format withMinusSign이 바꾸는 자리) — 날짜·코드의 하이픈은 걸리지 않습니다. */
const ASCII_MINUS = /(^|[\s(])-(?=[\d.])/;

const liquidity = (overrides: Record<string, unknown> = {}) => ({
  available: true, isEstimated: false, collectedAtKst: "2026-11-04 19:34 KST", ageSeconds: 60, stale: false,
  rows: [
    { date: "2026-10-27", netLiquidityT: 5.74, walclT: 6.74, wtregenB: 990.1, rrpB: 0.5 },
    { date: "2026-11-03", netLiquidityT: 5.745, walclT: 6.745, wtregenB: 999.7, rrpB: 0.427 },
  ],
  latest: { date: "2026-11-03", netLiquidityT: 5.745, previousT: 5.74, deltaT: 0.0047, pct: 0.08, walclT: 6.745, tgaB: 999.7, rrpB: 0.427 },
  momentum: { change4w: -0.048, change12w: -0.094 },
  ...overrides,
});

let body: Record<string, unknown> = liquidity();

beforeEach(() => {
  body = liquidity();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/liquidity")) return Promise.resolve(body);
    if (path.startsWith("/api/macro/usdkrw")) return Promise.resolve({ available: true, rate: 1339.28, lastTs: "2026-11-04 20:19 KST" });
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

describe("QA-627 4주·12주 변화의 음수 부호", () => {
  // 수정 전에는 4주·12주 변화 값('-480.0억 달러')과 원화 환산('약 -64.285조 원'·'약 -125.9조 원')이 ASCII 하이픈이었다 — 같은 화면 순유동성 변화 줄은 −(U+2212).
  it("4주·12주 변화 값과 그 원화 환산의 음수가 −(U+2212)다", async () => {
    render(<LiquidityPage />);

    expect(await screen.findByText("−480.0억 달러")).toBeTruthy();
    expect(screen.getByText("−940.0억 달러")).toBeTruthy();
    expect(screen.getByText(/약 −64\.285조 원/)).toBeTruthy();
    expect(screen.queryAllByText(ASCII_MINUS).map((node) => node.textContent)).toEqual([]);
  });
});

describe("순유동성 KPI 띠(P5a)", () => {
  /** KPI 띠 타일(이름 있는 묶음) — 띠는 이름 있는 영역 '순유동성 요약'. */
  const tiles = () => within(screen.getByRole("region", { name: "순유동성 요약" })).getAllByRole("group");

  it("여섯 타일이 순유동성·총자산·TGA·RRP·4주·12주 차례이고, 순유동성 타일에 변화 칩·출처 줄·원화 메모가 있다", async () => {
    render(<LiquidityPage />);
    await screen.findByRole("region", { name: "순유동성 요약" });

    expect(tiles().map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "순유동성 (Net Liquidity)", "연준 총자산 (WALCL)", "재무부 일반계정 (TGA)", "역레포 (ON RRP)", "4주 변화", "12주 변화",
    ]);
    const net = tiles()[0];
    expect(within(net).getByText("5.745조 달러")).toBeTruthy();
    // 전주 대비 +0.0047조 = +47.0억 달러 — 변화 칩(▲·읽어 주는 '상승')과 단위, 캡션.
    expect(within(net).getByText("상승")).toBeTruthy();
    expect(within(net).getByText("+47.0")).toBeTruthy();
    expect(within(net).getByText("억 달러")).toBeTruthy();
    expect(within(net).getByText("전주 대비")).toBeTruthy();
    expect(within(net).getByText(/FRED \(공식\)/).textContent).toContain("2026-11-03");
    expect(within(net).getByText(/원\/달러 1,339\.28 기준/)).toBeTruthy();
    // 값 자체가 변화량인 4주·12주는 칩 없이 부호(−)로.
    expect(within(tiles()[4]).queryByText("하락")).toBeNull();
    expect(within(tiles()[4]).getByText("−480.0억 달러")).toBeTruthy();
    expect(within(tiles()[2]).getByText(/TGA 증가 = 시장에서 자금 흡수/)).toBeTruthy();
  });

  it("추정치 모드면 여섯 타일 모두 '추정' 배지이고 위험 안내 상자도 그대로다", async () => {
    body = liquidity({ isEstimated: true });
    render(<LiquidityPage />);
    await screen.findByRole("region", { name: "순유동성 요약" });

    for (const tile of tiles()) {
      expect(within(tile).getByText("추정")).toBeTruthy();
    }
    expect(screen.getByText(/추정치 모드입니다/)).toBeTruthy();
  });

  it("모르는 값은 '—'(0으로 채우지 않음)이고 모멘텀이 없으면 그 두 타일이 없다", async () => {
    body = liquidity({
      latest: { date: "2026-11-03", netLiquidityT: null, previousT: null, deltaT: null, pct: null, walclT: 6.745, tgaB: null, rrpB: 0.427 },
      momentum: undefined,
    });
    render(<LiquidityPage />);
    await screen.findByRole("region", { name: "순유동성 요약" });

    expect(tiles()).toHaveLength(4);
    expect(within(tiles()[0]).getByText("—")).toBeTruthy();
    expect(within(tiles()[0]).queryByText("전주 대비")).toBeNull();
    expect(within(tiles()[2]).getByText("—")).toBeTruthy();
  });

  it("큰 추이 차트는 격자와 이름, 구성 항목 작은 차트 셋은 격자 없이 이름만, 범례 견본은 고대비에서 남는다", async () => {
    const { container } = render(<LiquidityPage />);
    await screen.findByRole("region", { name: "순유동성 요약" });

    const charts = [...container.querySelectorAll<HTMLElement>("[data-chart]")];
    expect(charts.map((chart) => [chart.dataset.name, chart.dataset.grid])).toEqual([
      ["순유동성 추이 (조 달러)", "yes"],
      ["연준 총자산 (WALCL) 추이 (조 달러)", "no"],
      ["재무부 일반계정 (TGA) 추이 (억 달러)", "no"],
      ["역레포 (ON RRP) 추이 (억 달러)", "no"],
    ]);
    const swatches = [...container.querySelectorAll<HTMLElement>("h3")].map((heading) => heading.previousElementSibling as HTMLElement);
    expect(swatches).toHaveLength(3);
    for (const swatch of swatches) {
      expect(swatch.className.split(/\s+/)).toContain("forced-color-adjust-none");
    }
  });
});
