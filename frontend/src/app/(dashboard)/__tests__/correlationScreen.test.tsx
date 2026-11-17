/**
 * 상관(/correlation) 화면 — 칸 틀(비교할 지표 · KPI 띠와 차트 둘 · 고른 쌍)과 상관계수·고른 쌍의 뜻(추정 배지 등).
 *
 * 차트는 받은 이름·격자만 보려고 가짜로 바꿉니다(그림은 차트 시험 몫).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineSeries: ({ ariaLabel, grid, zeroLine, data }: { ariaLabel?: string; grid?: boolean; zeroLine?: boolean; data: unknown[] }) => (
    <div data-chart="line" data-label={ariaLabel ?? ""} data-grid={String(Boolean(grid))} data-zero={String(Boolean(zeroLine))} data-rows={data.length} />
  ),
  ScatterPlot: ({ data }: { data: unknown[] }) => <div data-chart="scatter" data-rows={data.length} />,
}));

import { endpoints } from "@/lib/endpoints";
import type { CorrelationResponse } from "@/lib/types";
import CorrelationPage from "../correlation/page";

/** 경로 → 응답(정확히 일치). 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const CORRELATION = endpoints.insight.correlation({ x: "liquidity:net", y: "etf:QQQ", window: "60", years: "3", mode: "change" });

/** 계산한 상관 응답 — 순유동성(X) ↔ QQQ(Y), 변화끼리. */
function correlation(overrides: Partial<CorrelationResponse> = {}): CorrelationResponse {
  return {
    available: true,
    x: { id: "liquidity:net", label: "연준 순유동성", group: "유동성", unit: "조 달러", source: "FRED (공식)" },
    y: { id: "etf:QQQ", label: "나스닥 100 (QQQ)", group: "ETF", unit: "달러", source: "Yahoo Finance" },
    mode: "change",
    window: 60,
    overall: -0.231,
    samples: 496,
    firstDate: "2023-11-17",
    lastDate: "2026-11-14",
    rolling: [{ date: "2026-11-13", value: -0.2 }, { date: "2026-11-14", value: -0.25 }],
    scatter: [{ date: "2026-11-14", x: 0.01, y: -0.3 }],
    notes: ["상관은 같이 움직였다는 뜻일 뿐, 어느 쪽이 원인인지는 말해 주지 않습니다."],
    ...overrides,
  };
}

/** 상관계수 칸 — 이름 글의 부모(지표 칸·KPI 띠 타일 모두 이름 줄 바로 위가 칸). */
/** 값이 온 뒤의 상관계수 타일 — 읽는 동안의 자리표시 띠('상관 요약 불러오는 중')에도 같은 이름이 있어 값 띠('상관 요약') 안에서 찾습니다. */
async function coefficientTile(): Promise<HTMLElement> {
  const strip = await screen.findByRole("region", { name: "상관 요약" });
  return within(strip).getByText("상관계수 (변화)").parentElement as HTMLElement;
}

describe("QA-634 추정 계열로 낸 상관에 '추정' 배지", () => {
  // 수정 전에는 응답의 x·y.isEstimated를 읽지 않아(SeriesRef에 칸이 없음) 추정 계열(KODEX 200 기반 KOSPI200 선물 등)로 낸 상관계수가
  // 확정치처럼 보였습니다 — 주의 글(notes) 한 줄만 있었습니다(PRINCIPLES '추정치는 isEstimated와 함께').
  it("X나 Y가 추정 계열이면 상관계수 칸에 '추정' 배지, 둘 다 공식 값이면 배지 없음", async () => {
    const estimated = correlation();
    reads[CORRELATION] = { ...estimated, y: { ...estimated.y, isEstimated: true } };
    const { unmount } = render(<CorrelationPage />);
    expect(within(await coefficientTile()).getByText("추정")).toBeTruthy();
    unmount();

    reads[CORRELATION] = correlation();
    render(<CorrelationPage />);
    expect(within(await coefficientTile()).queryByText("추정")).toBeNull();
  });
});

const SERIES = endpoints.insight.series;
const CATALOG = {
  series: [
    { id: "liquidity:net", label: "연준 순유동성", group: "유동성", unit: "조 달러", source: "FRED (공식)" },
    { id: "etf:QQQ", label: "나스닥 100 (QQQ)", group: "ETF", unit: "달러", source: "Yahoo Finance" },
    { id: "fred:NFCI", label: "시카고 연준 금융상황지수", group: "금융 여건", unit: "", source: "FRED (공식)" },
  ],
};

/** 이름(h3)으로 찾은 속성 목록에서 이름(dt)의 줄 — 값 칸(dd)을 돌려줍니다. */
function propertyValue(list: HTMLElement, label: string): HTMLElement {
  const term = within(list).getByText(label, { selector: "dt" });
  return term.nextElementSibling as HTMLElement;
}

describe("상관 화면의 칸 틀", () => {
  it("왼쪽 비교할 지표 → 가운데 KPI 띠·롤링·산점도 → 오른쪽 고른 쌍 차례", async () => {
    reads[SERIES] = CATALOG;
    reads[CORRELATION] = correlation();
    render(<CorrelationPage />);
    await screen.findByRole("region", { name: "상관 요약" });

    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["비교할 지표", "롤링 상관계수 (60 관측)", "산점도", "고른 쌍"]);
    // 고르기 다섯은 왼쪽 패널 안.
    const left = screen.getByRole("heading", { name: "비교할 지표" }).closest("section") as HTMLElement;
    for (const name of ["지표 X", "지표 Y", "비교 방식", "롤링 창", "조회 기간"]) {
      expect(within(left).getByLabelText(name)).toBeTruthy();
    }
  });

  it("계열 고르기는 묶음을 optgroup으로 빼 고른 값의 글이 이름만 — 왼쪽 칸은 15rem(가장 긴 이름이 고르기 안에서 잘리지 않게)", async () => {
    reads[SERIES] = CATALOG;
    reads[CORRELATION] = correlation();
    const { container } = render(<CorrelationPage />);
    await screen.findByRole("region", { name: "상관 요약" });
    const x = screen.getByRole("combobox", { name: "지표 X" }) as HTMLSelectElement;
    expect(x.querySelectorAll("optgroup").length).toBeGreaterThan(0);
    expect(x.options[x.selectedIndex].text).not.toContain(" · ");
    expect(x.options[x.selectedIndex].parentElement?.tagName).toBe("OPTGROUP");
    expect((container.querySelector(".lg\\:grid-cols-\\[15rem_minmax\\(0\\,1fr\\)\\]") as HTMLElement | null)).not.toBeNull();
  });

  it("KPI 띠 둘 — 상관계수(소수 셋째, 음수 −, 세기 글)·표본 수(개, 보조 글 계산 기간)", async () => {
    reads[CORRELATION] = correlation();
    render(<CorrelationPage />);
    const strip = await screen.findByRole("region", { name: "상관 요약" });
    const tiles = within(strip).getAllByRole("group");
    expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual(["상관계수 (변화)", "표본 수"]);
    expect(tiles[0].textContent).toContain("−0.231");
    expect(tiles[0].textContent).not.toContain("+");
    expect(within(tiles[0]).getByText("약하게 반대 방향으로 움직였습니다.")).toBeTruthy();
    expect(tiles[1].textContent).toContain("496개");
    // 보조 글은 날짜 마디가 줄바꿈 없는 묶음으로 갈려(keepDates — QA-663) 글 마디가 나뉘므로 글 전체로 봅니다.
    expect((tiles[1].querySelector("p.break-keep") as HTMLElement).textContent).toBe("2023-11-17 ~ 2026-11-14");
  });

  // QA-663: 상관 요약 띠에 keepDates가 없어 표본 수 보조 글의 계산 기간이 좁은 타일(1024~1279 lg 네 칸 칸 90~119px)에서 '2024-11-05 ~ 2026-11-|03'처럼
  // 날짜 안(하이픈 뒤)에서 꺾였습니다(QA 스택 1100·1180 메뉴 220). 두 날짜는 각각 줄바꿈 없는 묶음이어야 합니다(매크로·순유동성 띠와 같음).
  // 수정 전(재현 커밋에서는 it.fails) 보조 글 안에 span.whitespace-nowrap이 없었습니다.
  it("표본 수 보조 글의 두 날짜는 각각 줄바꿈 없는 묶음 — 날짜 마디 사이에서만 꺾는다 (QA-663)", async () => {
    reads[CORRELATION] = correlation();
    render(<CorrelationPage />);
    const strip = await screen.findByRole("region", { name: "상관 요약" });
    const samples = within(strip).getByRole("group", { name: "표본 수" });
    const dates = [...samples.querySelectorAll<HTMLElement>("p span.whitespace-nowrap")].map((span) => span.textContent);
    expect(dates).toEqual(["2023-11-17", "2026-11-14"]);
    expect((samples.querySelector("p.break-keep") as HTMLElement).textContent).toBe("2023-11-17 ~ 2026-11-14");
  });

  it("읽는 동안 가운데 칸은 값이 온 뒤와 같은 자리 — KPI 띠 둘(자리표시)·롤링 260px·산점도 360px 자리표시(패널 제목 그대로), 오면 값으로", async () => {
    render(<CorrelationPage />);
    const pending = await screen.findByRole("region", { name: "상관 요약 불러오는 중" });
    expect(within(pending).getAllByRole("status").map((status) => status.getAttribute("aria-label"))).toEqual(["상관계수 (변화) 불러오는 중", "표본 수 불러오는 중"]);
    const rolling = screen.getByRole("status", { name: "상관을 계산하는 중" });
    expect((rolling.querySelector("[style]") as HTMLElement).style.height).toBe("260px");
    expect((screen.getByRole("status", { name: "산점도를 그리는 중" }).querySelector("[style]") as HTMLElement).style.height).toBe("360px");
    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["비교할 지표", "롤링 상관계수 (60 관측)", "산점도", "고른 쌍"]);
  });

  it("상관계수를 계산하지 못했으면 0이 아니라 —와 '계산할 수 없습니다.'", async () => {
    reads[CORRELATION] = correlation({ overall: null });
    render(<CorrelationPage />);
    const tile = await coefficientTile();
    expect(tile.textContent).toContain("—");
    expect(tile.textContent).not.toMatch(/0\.000/);
    expect(within(tile).getByText("계산할 수 없습니다.")).toBeTruthy();
  });

  it("롤링 차트는 쌍 이름·창이 든 이름, 0선과 격자", async () => {
    reads[CORRELATION] = correlation();
    const { container } = render(<CorrelationPage />);
    await screen.findByRole("region", { name: "상관 요약" });
    const line = container.querySelector('[data-chart="line"]') as HTMLElement;
    expect(line.dataset.label).toBe("연준 순유동성 ↔ 나스닥 100 (QQQ) 롤링 상관계수 (60 관측)");
    expect(line.dataset.grid).toBe("true");
    expect(line.dataset.zero).toBe("true");
    expect(line.dataset.rows).toBe("2");
  });

  it("고른 쌍 — X·Y의 이름·묶음·단위·출처(추정 계열은 이름 옆 '추정', 단위 없는 계열은 —와 '단위 없음')와 비교 조건, 링크는 없다", async () => {
    const response = correlation();
    reads[CORRELATION] = { ...response, y: { ...response.y, unit: "", source: "KODEX 200 기반 추정", isEstimated: true } };
    render(<CorrelationPage />);
    await screen.findByRole("region", { name: "상관 요약" });
    const pair = screen.getByRole("heading", { name: "고른 쌍" }).closest("section") as HTMLElement;

    const xList = within(pair).getByRole("region", { name: "X 계열" });
    expect(propertyValue(xList, "이름").textContent).toBe("연준 순유동성");
    expect(propertyValue(xList, "묶음").textContent).toBe("유동성");
    expect(propertyValue(xList, "단위").textContent).toBe("조 달러");
    expect(propertyValue(xList, "출처").textContent).toBe("FRED (공식)");
    expect(within(xList).queryByText("추정")).toBeNull();

    const yList = within(pair).getByRole("region", { name: "Y 계열" });
    expect(within(propertyValue(yList, "이름")).getByText("추정")).toBeTruthy();
    expect(propertyValue(yList, "출처").textContent).toBe("KODEX 200 기반 추정");
    expect(propertyValue(yList, "단위").textContent).toContain("—");
    expect(within(propertyValue(yList, "단위")).getByText("단위 없음")).toBeTruthy();

    const compare = within(pair).getByRole("region", { name: "비교" });
    expect(propertyValue(compare, "방식").textContent).toBe("변화끼리 (권장)");
    expect(propertyValue(compare, "롤링 창").textContent).toBe("60 관측");
    expect(propertyValue(compare, "조회 기간").textContent).toBe("최근 3년");
    expect(propertyValue(compare, "계산 기간").textContent).toBe("2023-11-17 ~ 2026-11-14두 지표가 모두 값을 가진 날짜만 표본으로 셉니다.");
    expect(within(pair).queryAllByRole("link")).toHaveLength(0);
  });

  it("계산하지 못한 쌍도 계열 목록의 정의로 고른 쌍을 보인다", async () => {
    reads[SERIES] = CATALOG;
    reads[CORRELATION] = { available: false, message: "표본이 부족합니다.", mode: "change", window: 60, overall: null, samples: 0 };
    render(<CorrelationPage />);
    expect(await screen.findByText("표본이 부족합니다.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "상관 요약" })).toBeNull();

    const xSelect = screen.getByRole("combobox", { name: "지표 X" }) as HTMLSelectElement;
    expect(xSelect.value).toBe("liquidity:net");
    const pair = screen.getByRole("heading", { name: "고른 쌍" }).closest("section") as HTMLElement;
    expect(propertyValue(within(pair).getByRole("region", { name: "X 계열" }), "이름").textContent).toBe("연준 순유동성");
  });
});

// QA-655: 가운데 칸의 값 꼴 자리(KPI 띠 둘·롤링 260px·산점도 360px — P5a 검토 반영 `dbd86998`)를 '값 없이 읽는 중'이면 늘 그려, 첫 읽기가 실패한 뒤 다시
// 읽을 때마다(자동 갱신 5분·다시 시도·탭 복귀) 오류 상자와 그 자리가 번갈아 그려졌습니다(매크로 지표 패널과 같은 원인 — 검토 지적의 같은 꼴). 실패 뒤
// 다시 읽는 동안은 오류 상자와 비슷한 높이의 '상관을 계산하는 중…' 한 줄이어야 합니다(값 꼴 자리는 처음 읽는 동안과 고르기를 바꿔 다시 읽는 동안만).
describe("QA-655 첫 읽기가 실패한 뒤 다시 읽는 동안에는 가운데 칸 값 꼴 자리를 다시 그리지 않는다", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 다시 읽는 동안 KPI 띠 자리('상관 요약 불러오는 중')·차트 자리가 다시 그려졌습니다('expected <section …> to be null').
  it("실패 → 다시 읽는 중에 KPI 띠·차트 자리 없이 '상관을 계산하는 중…' 한 줄, 다시 실패하면 오류 상자", async () => {
    let calls = 0;
    let failAgain: () => void = () => {};
    api.apiGetShared.mockImplementation((path: string) => {
      if (path !== CORRELATION) return new Promise(() => {});
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("백엔드 API 오류 (503)"))
        : new Promise((_, reject) => { failAgain = () => reject(new Error("백엔드 API 오류 (503)")); });
    });
    render(<CorrelationPage />);
    fireEvent.click(await screen.findByRole("button", { name: "다시 시도" }));

    expect(calls).toBe(2);
    expect(screen.queryByRole("region", { name: "상관 요약 불러오는 중" })).toBeNull();
    expect(screen.queryByRole("status", { name: "상관을 계산하는 중" })).toBeNull();
    expect(screen.queryByRole("status", { name: "산점도를 그리는 중" })).toBeNull();
    expect(screen.getByText("상관을 계산하는 중…")).toBeTruthy();

    await act(async () => failAgain());
    expect(await screen.findByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});
