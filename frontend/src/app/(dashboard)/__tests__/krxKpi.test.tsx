/**
 * 국내 파생(/krx) KPI 띠와 표(작업대 P7 — 실행 명세 §7 7행 'KRX: KPI 넘침 고침').
 *
 * - 옛 지표 칸(Metric) 격자 셋 → KPI 띠 셋('선물 요약'·'장중 수급 가속도'·'증시 규모'). 등락·증감은 공용 변화 칩(▲▼·sr 글·부호 −), 모르는 값은 '—'과 사유
 *   (베이시스 '데이터 미제공'), 판정 불가는 중립 잉크, 추정치 모드면 타일마다 추정 배지.
 * - 투자주체별 선물 수급·현물선물 표: 순매수 계약·금액(오르내린 값이 아님)은 본문 잉크 + −(등락색 없음), 방향 판정 글도 등락색 없음.
 * - 그림 넷의 구체 이름(이중 축 둘은 그대로 — 이름만).
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
vi.mock("@/components/charts", () => {
  const named = ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />;
  return { SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" }, LineSeries: named, MultiLineSeries: named, SignedBars: named };
});

import { endpoints } from "@/lib/endpoints";
import KrxPage from "../krx/page";

const LATEST = {
  date: "2026-11-18", contractName: "KOSPI200 선물 12월물", futuresClose: 412.35, changePct: -1.25, changePctReported: -1.25,
  openInterest: 301234, oiChange: -1500, oiChange5dAvg: -320, marketBasis: null, basisState: "베이시스 모름", basisNote: null,
  marketPhase: "판정 불가 (등락률 없음)", cotOiIndex: 40,
};

function reads(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    [endpoints.positioning.krxFutures(60)]: { available: true, isEstimated: false, latest: LATEST, rows: [LATEST] },
    [endpoints.positioning.krxInvestorTrend]: {
      available: true, unit: "계약", dataDate: "2026-11-18", measure: "CONTRACT",
      rows: [{ investor: "외국인 합계", netToday: -2500, net5d: 1200, net20d: -8000, stance: "매도 우위(Short)" }],
    },
    [endpoints.positioning.krxIntraday(30)]: {
      available: true, foreignCurrent: -3200, foreignChange: -400, institutionCurrent: 1500, institutionChange: 250,
      flowStatus: "외국인 매도 가속", referenceTime: "10:30", latestTime: "11:00", dataDate: "2026-11-18",
    },
    [endpoints.positioning.krxSpotFutures]: {
      available: true, spotDate: "2026-11-18", futuresDate: "2026-11-18", sameDay: true,
      rows: [{ key: "foreign", label: "외국인", spotToday: 1, spot5: -5e10, spot20: 1e11, futuresToday: 1, futures5: -300, futures20: 900,
        verdictToday: "동반 순매도", verdict5: "동반 순매도", verdict20: "현물 매수 · 선물 매도" }],
    },
    [endpoints.publicData.marketTotals(180)]: {
      available: true, latestBasDt: "2026-11-17",
      markets: [{ market: "KOSPI", marketCap: [{ date: "2026-11-17", value: 2.1e15 }], tradingValue: [{ date: "2026-11-17", value: 1.2e13 }] }],
    },
    ...over,
  };
}

function serve(map: Record<string, unknown>) {
  api.apiGetShared.mockImplementation((path: string) => (path in map ? Promise.resolve(map[path]) : new Promise(() => {})));
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  serve(reads());
});
afterEach(() => cleanup());

describe("국내 파생 — KPI 띠", () => {
  it("선물 요약: 종가 하락 변화 칩·미결제약정 증감 계약·베이시스 '—' + 데이터 미제공·판정 불가 중립", async () => {
    render(<KrxPage />);
    const strip = await screen.findByRole("region", { name: "선물 요약" });
    const close = within(strip).getByRole("group", { name: "선물 종가" });
    expect(close.textContent).toContain("412.35");
    expect(within(close).getByText("하락")).toBeTruthy();
    expect(close.textContent).toContain("−1.25%");
    const oi = within(strip).getByRole("group", { name: "미결제약정 (OI)" });
    expect(oi.textContent).toContain("301,234");
    expect(oi.textContent).toContain("계약");
    expect(oi.textContent).toContain("5일 평균 증감 −320");
    const basis = within(strip).getByRole("group", { name: "시장 베이시스" });
    expect(within(basis).getByText("데이터 미제공")).toBeTruthy();
    expect(within(basis).getByText("값 없음")).toBeTruthy();
    const phase = within(strip).getByRole("group", { name: "4대 국면 판정" });
    expect(within(phase).getByText("판정 불가 (등락률 없음)").className).toContain("text-neutral");
    expect(within(strip).queryAllByText("추정", { selector: "span.font-medium" })).toHaveLength(0);
  });

  it("추정치 모드면 선물 요약 타일마다 추정 배지(위험 안내 상자도 그대로)", async () => {
    serve(reads({
      [endpoints.positioning.krxFutures(60)]: {
        available: true, isEstimated: true, estimateNotice: "KODEX 200 기반 추정치입니다.", latest: { ...LATEST, marketPhase: "강세 (가격↑·OI↑)" }, rows: [LATEST],
      },
    }));
    render(<KrxPage />);
    const strip = await screen.findByRole("region", { name: "선물 요약" });
    expect(screen.getByText("KODEX 200 기반 추정치입니다.")).toBeTruthy();
    // 추정 배지(점선 테두리 태그 안 '추정' 글) — 출처 글의 '추정치'와 따로 셉니다.
    for (const tile of within(strip).getAllByRole("group")) {
      expect(within(tile).getByText("추정", { selector: "span.font-medium" }), tile.getAttribute("aria-label") ?? "").toBeTruthy();
    }
  });

  it("장중 수급 가속도·증시 규모 띠 — 누적은 잉크 + −, 최근 30분 변화는 변화 칩, 모르는 시장은 '—'", async () => {
    render(<KrxPage />);
    const intraday = await screen.findByRole("region", { name: "장중 수급 가속도" });
    const foreign = within(intraday).getByRole("group", { name: "외국인 누적 순매수" });
    expect(foreign.textContent).toContain("−3,200");
    expect(within(foreign).getByText("하락")).toBeTruthy();
    expect(foreign.textContent).toContain("최근 30분");
    const totals = await screen.findByRole("region", { name: "증시 규모" });
    expect(within(totals).getByRole("group", { name: "KOSDAQ 시가총액" }).textContent).toBe("KOSDAQ 시가총액—값 없음");
  });
});

describe("국내 파생 — 표와 그림", () => {
  it("선물 수급·현물선물 표: 순매수는 잉크 + −(등락색 없음), 방향 판정 글도 등락색 없음", async () => {
    render(<KrxPage />);
    const trend = await screen.findByRole("region", { name: "투자주체별 선물 수급 (좌우 스크롤)" });
    const row = within(trend).getByText("외국인 합계").closest("tr") as HTMLTableRowElement;
    expect([row.cells[1].textContent, row.cells[2].textContent, row.cells[3].textContent]).toEqual(["−2,500", "+1,200", "−8,000"]);
    expect(row.innerHTML).not.toMatch(/text-(up|down)/);
    const spot = await screen.findByRole("region", { name: "현물·선물 수급 동조 (좌우 스크롤)" });
    const spotRow = within(spot).getByText("외국인").closest("tr") as HTMLTableRowElement;
    expect(spotRow.cells[1].textContent).toBe("−500.0억 원");
    expect(spotRow.cells[2].textContent).toBe("−300");
    expect(spotRow.innerHTML).not.toMatch(/text-(up|down)/);
  });

  it("그림 넷에 구체 이름", async () => {
    render(<KrxPage />);
    await screen.findByRole("region", { name: "선물 요약" });
    for (const name of [
      "선물 종가(왼쪽 축)와 미결제약정(오른쪽 축, 계약) 추이",
      "한국판 COT OI Index 추이(0~100)",
      "투자주체별 KOSPI200 선물 20일 누적 순매수(계약)",
    ]) {
      expect(screen.getByRole("img", { name }), name).toBeTruthy();
    }
  });
});
