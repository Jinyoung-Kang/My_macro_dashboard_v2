/**
 * COT(/cot) 화면 — 요약 표·극단 성적의 부호·등락 표시(QA-629)와 작업대 배치(자산 고르기 표·KPI 띠·공용 표 — P5a).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// 차트는 받은 이름·격자·계열 색만 봅니다(jsdom은 크기가 없어 그림을 그리지 않음).
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: ({ ariaLabel, grid, series }: { ariaLabel?: string; grid?: boolean; series: { color: string }[] }) => (
    <div data-chart="lines" data-name={ariaLabel ?? ""} data-grid={grid ? "yes" : "no"} data-colors={series.map((entry) => entry.color).join(",")} />
  ),
}));

import CotPage from "../cot/page";

/** 줄 처음·공백·여는 괄호 뒤의 ASCII 하이픈 음수 부호(lib/format withMinusSign이 바꾸는 자리) — 날짜의 하이픈은 걸리지 않습니다. */
const ASCII_MINUS = /(^|[\s(])-(?=[\d.])/;
const S_AND_P = "S&P 500 E-Mini";

const summary = (asset: string, category: string, overrides: Record<string, unknown> = {}) => ({
  asset, category, available: true, date: "2026-10-27", ncNet: -134368, commNet: 17301, nrNet: -2500,
  change1w: -8303, change4w: 8131, change13w: -117172, percentile: 34.94, ageDays: 21, error: null, ...overrides,
});

const sideSummary = (mean: number | null, winRate: number | null, count = 13) => ({ count, mean, median: mean, winRate, best: 8.97, worst: -4.66 });

const BODIES: Record<string, unknown> = {
  "/api/cot/assets": { assets: [
    { name: S_AND_P, code: "13874A", category: "주식" },
    { name: "금", code: "088691", category: "원자재" },
  ] },
  "/api/cot/overview": { available: true, collectedAtKst: "2026-11-04 19:36 KST", ageSeconds: 60, assets: [
    summary("금", "원자재", { ncNet: 186451, commNet: -215624, change1w: 13414, change4w: 32181 }),
    summary(S_AND_P, "주식"),
  ] },
  "/api/cot/asset": { asset: S_AND_P, code: "13874A", available: true, rows: [
    { date: "2026-10-20", ncNet: -142671, commNet: 20000, nrNet: 122671 },
    { date: "2026-10-27", ncNet: -134368, commNet: 17301, nrNet: -2500 },
  ], summary: summary(S_AND_P, "주식") },
  "/api/cot/extremes": {
    available: true, asset: S_AND_P, percentile: 95, lookbackWeeks: 52, priceProxy: "SPY", priceProxyLabel: "SPDR S&P 500 ETF",
    proxyNotice: "대용 가격입니다.", priceFrom: "2024-11-04", priceTo: "2026-11-03",
    sides: [{ side: "극단 롱", rule: "비상업 순포지션이 과거 52주 중 상위 95% 이상",
      h4: sideSummary(-2.1, 30.77), h13: sideSummary(5.08, 90), baseline4: sideSummary(-1.21, 63.37, 101), baseline13: sideSummary(4.17, 78.26, 92) }],
    recentEvents: [
      { date: "2026-08-18", side: "극단 롱", net: -10560, percentile: 98.11, return4w: -1.53, return13w: null },
      { date: "2026-07-21", side: "극단 롱", net: 16784, percentile: 100, return4w: 3.3, return13w: 3.81 },
    ],
  },
};

/** 그 글이 든 표 행(tbody tr) 가운데 첫째 — 자산 이름은 고르기·패널 제목에도 나와 표 행 안의 것만 봅니다. */
function rowOf(text: string): HTMLElement {
  const row = screen.getAllByText(text).map((node) => node.closest("tbody tr")).find(Boolean);
  if (!row) throw new Error(`표 행을 찾지 못함: ${text}`);
  return row as HTMLElement;
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(BODIES).find((prefix) => path.startsWith(prefix));
    return key ? Promise.resolve(BODIES[key]) : new Promise(() => {});
  });
});

afterEach(() => cleanup());

describe("QA-629 COT 순포지션·변화·극단 성적의 부호와 방향", () => {
  // 수정 전에는 요약 표 1주·4주 변화가 색과 ASCII '-'뿐이고(읽어 주는 방향 글 없음), 순포지션 둘이 ASCII '-'였다. 순포지션 색(하락 파랑)은 뜻이라 그대로 둔다.
  it("요약 표의 변화 둘은 변화 칩, 순포지션은 −(U+2212)이고 스마트머니 순포지션의 색은 그대로다", async () => {
    render(<CotPage />);
    await waitFor(() => expect(rowOf("2026-10-27")).toBeTruthy());

    const row = rowOf("주식");
    expect(within(row).getByText("하락")).toBeTruthy();
    expect(within(row).getByText("상승")).toBeTruthy();
    expect(within(row).getByText("−8,303")).toBeTruthy();
    const ncNet = within(row).getByText("−134,368");
    expect(ncNet.closest(".text-down")).toBeTruthy();
    expect(within(row).queryAllByText(ASCII_MINUS).map((node) => node.textContent)).toEqual([]);
    const gold = rowOf("원자재");
    expect(within(gold).getByText("−215,624")).toBeTruthy();
    expect(within(gold).getAllByText("상승")).toHaveLength(2);
  });

  // 수정 전에는 극단 성적 표의 평균 수익률·최근 신호의 이후 수익률이 색과 ASCII '-'뿐이고, 순포지션·중앙값·비교 값·고른 자산 요약 값이 ASCII '-'였다.
  it("극단 성적의 수익률은 변화 칩이고, 화면 어디에도 ASCII 음수 부호가 없다", async () => {
    render(<CotPage />);
    await screen.findByRole("heading", { name: "최근 극단 신호" });

    const recent = rowOf("2026-08-18");
    expect(within(recent).getByText("하락")).toBeTruthy();
    expect(within(recent).getByText("−1.53%")).toBeTruthy();
    expect(within(recent).getByText("−10,560")).toBeTruthy();
    const fourWeeks = rowOf("4주 뒤");
    expect(within(fourWeeks).getByText("하락")).toBeTruthy();
    expect(screen.queryAllByText(ASCII_MINUS).map((node) => node.textContent)).toEqual([]);
  });
});

describe("COT 작업대 배치(P5a)", () => {
  const summaryTable = () => screen.getByRole("table", { name: "자산별 요약" });
  const rowNamed = (name: string) => within(summaryTable()).getByRole("button", { name }).closest("tr")!;

  it("요약 표의 자산 이름은 단추이고, 고른 자산(처음 S&P 500 E-Mini) 행이 aria-current, 단추는 추이 패널을 가리킨다", async () => {
    render(<CotPage />);
    await waitFor(() => expect(within(summaryTable()).getAllByRole("rowheader")).toHaveLength(2));

    expect(rowNamed(S_AND_P).getAttribute("aria-current")).toBe("true");
    expect(rowNamed("금").getAttribute("aria-current")).toBeNull();
    const button = within(summaryTable()).getByRole("button", { name: "금" });
    const target = document.getElementById(button.getAttribute("aria-controls") ?? "");
    expect(target).toBeTruthy();
    expect(within(target!).getByRole("heading", { name: `포지셔닝 추이 — ${S_AND_P}` })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "자산별 요약" }).parentElement?.textContent).toContain("2개");
    // 누름 자리 — 한 글자 이름('금')도 좁은 화면 폭 44px(lg 미만)·넓은 화면 높이·폭 24px(결정 8), 기준일·'n일 전 공시'는 각자 한 줄(하이픈 뒤에서 꺾지 않음).
    expect(button.className.split(/\s+/)).toEqual(expect.arrayContaining(["min-h-11", "min-w-11", "lg:min-h-6", "lg:min-w-6"]));
    expect(within(rowNamed("금")).getByText("2026-10-27").parentElement?.className).toContain("whitespace-nowrap");
  });

  it("자산 이름을 누르면 '자산' 고르기·추이 패널 제목·고른 행이 함께 그 자산으로 바뀐다", async () => {
    render(<CotPage />);
    const select = (await screen.findByLabelText("자산")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));

    // 처음에는 바꿨다는 상태 글이 없다(고른 자산 단추 자신이 aria-current).
    expect(within(summaryTable()).getByRole("button", { name: S_AND_P }).getAttribute("aria-current")).toBe("true");
    const status = screen.getAllByRole("status").find((element) => element.className.includes("sr-only"))!;
    expect(status.textContent).toBe("");

    fireEvent.click(within(summaryTable()).getByRole("button", { name: "금" }));

    expect(select.value).toBe("금");
    expect(screen.getByRole("heading", { name: "포지셔닝 추이 — 금" })).toBeTruthy();
    expect(rowNamed("금").getAttribute("aria-current")).toBe("true");
    expect(rowNamed(S_AND_P).getAttribute("aria-current")).toBeNull();
    expect(within(summaryTable()).getByRole("button", { name: "금" }).getAttribute("aria-current")).toBe("true");
    expect(within(summaryTable()).getByRole("button", { name: S_AND_P }).getAttribute("aria-current")).toBeNull();
    // 좁은 화면은 아래 패널이 화면 밖이라, 바뀐 것을 상태 글로 알린다.
    expect(status.textContent).toBe("아래 포지셔닝 추이 패널을 금 자산으로 바꿨습니다.");

    // 고르기로 바꾸면 표의 고른 행도 따라옴(같은 상태).
    fireEvent.change(select, { target: { value: S_AND_P } });
    expect(rowNamed(S_AND_P).getAttribute("aria-current")).toBe("true");
  });

  it("고른 자산 KPI 띠 넷 — 스마트머니 순포지션(−·1주 변화 칩·출처 줄과 기준일)·상업 헤저·소액/비보고·3년 백분위(%)", async () => {
    render(<CotPage />);
    const strip = await screen.findByRole("region", { name: `${S_AND_P} 포지셔닝 요약` });

    const tiles = within(strip).getAllByRole("group");
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual(["스마트머니 순포지션", "상업 헤저 순포지션", "소액/비보고", "3년 표본 백분위"]);
    expect(within(tiles[0]).getByText("−134,368")).toBeTruthy();
    expect(within(tiles[0]).getByText("하락")).toBeTruthy();
    expect(within(tiles[0]).getByText("−8,303")).toBeTruthy();
    expect(within(tiles[0]).getByText("1주")).toBeTruthy();
    expect(within(tiles[0]).getByText(/CFTC Commitments of Traders/).textContent).toContain("2026-10-27");
    expect(within(tiles[2]).getByText("−2,500")).toBeTruthy();
    expect(within(tiles[3]).getByText("34.9%")).toBeTruthy();
    expect(within(tiles[3]).getByText("100%에 가까울수록 역사적 최대 롱")).toBeTruthy();
  });

  it("순포지션 추이 차트는 이름 '{자산} 순포지션 추이'·격자, 색 셋 그대로, 계약 코드", async () => {
    const { container } = render(<CotPage />);
    await screen.findByRole("region", { name: `${S_AND_P} 포지셔닝 요약` });

    const chart = container.querySelector<HTMLElement>("[data-chart='lines']")!;
    expect(chart.dataset.name).toBe(`${S_AND_P} 순포지션 추이`);
    expect(chart.dataset.grid).toBe("yes");
    expect(chart.dataset.colors).toBe("#3987e5,#d95926,#8B949E");
    expect(screen.getByText("계약 코드 13874A")).toBeTruthy();
  });

  it("극단 성적 — 대용 가격 안내는 중립 상자, 쪽마다 12·16px 상자·h3·이름 있는 공용 표, 최근 신호는 조밀 표", async () => {
    render(<CotPage />);
    const recent = await screen.findByRole("table", { name: "최근 극단 신호" });

    expect(screen.getByText(/종가를 대용으로/).closest(".bg-surface-2")).toBeTruthy();
    const side = screen.getByRole("heading", { name: "극단 롱" }).parentElement!;
    expect(side.className.split(/\s+/)).toEqual(expect.arrayContaining(["p-3", "lg:p-4"]));
    expect(within(side).getByRole("table", { name: "극단 롱 이후 성적" })).toBeTruthy();
    // 조밀 표 — 넓은 화면 행 28px(칸 위 여백 4px).
    expect(within(recent).getAllByRole("cell")[0].className).toContain("lg:pt-1 ");
    // 아직 지나지 않은 13주는 '—'(0으로 채우지 않음).
    expect(within(rowOf("2026-08-18")).getByText("—")).toBeTruthy();
  });
});

// QA-654: 자산별 요약 패널은 읽는 동안 '불러오는 중' 한 줄(패널 189px)뿐이라, 값이 오면 표(1024 513px·1440 465px)로 자라 아래 추이 패널(화면 안 — 위 끝 351px)과
// 극단 성적 패널을 밀었습니다. 기준 `a5cdae2f`와 같은 원인이지만 P5a 배치(머리가 낮아 내용이 32px 위 — 밀리는 패널이 화면 안에 더 많이 걸림)와 결정 8(표 안
// 이름 단추 24px — 줄 +4px)로 1440 첫 적재 CLS가 0.2125 → 0.2337 → 0.2417이 되었습니다(자기 빌드 + QA API, 다섯 번 모두 같은 값 — 흔들림 아님).
// 읽는 동안 자산 여섯 줄(수집기 COT_ASSETS — 자리일 뿐 보이는 수가 아님)의 표 꼴 자리로 패널 높이를 잡아야 합니다.
describe("QA-654 자산별 요약 패널은 읽는 동안 표 꼴 자리로 높이를 잡는다", () => {
  it.fails("요약을 읽는 동안 자산 여섯 줄의 글 없는 자리(읽기에서 빠짐)와 이름 있는 읽는 중 상태 — 숫자 없음", () => {
    // 모든 요청이 끝나지 않음 — 화면을 처음 연 직후(읽는 중).
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    render(<CotPage />);
    const panel = screen.getByRole("heading", { name: "자산별 요약" }).closest("section") as HTMLElement;
    const rows = panel.querySelectorAll("[data-cot-pending-row]");
    expect(rows).toHaveLength(6);
    expect(within(panel).getByRole("status", { name: "자산별 요약을 불러오는 중" })).toBeTruthy();
    expect(rows[0].closest("[aria-hidden='true']")).not.toBeNull();
    expect(panel.textContent).not.toMatch(/\d/);
  });
});
