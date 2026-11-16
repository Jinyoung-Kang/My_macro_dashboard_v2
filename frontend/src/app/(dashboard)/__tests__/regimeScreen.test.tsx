/**
 * 국면(/regime) 화면 — 국면 이력 띠·판정 근거·판정 기록·판정 성과의 뜻.
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

import { regimeExpansion } from "@/lib/__tests__/homeFixtures";
import { endpoints } from "@/lib/endpoints";
import type { RegimeResponse } from "@/lib/types";
import RegimePage from "../regime/page";

/** 경로 → 응답(정확히 일치). 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

const REGIME = endpoints.insight.regime("5");
const REGIME_LOG = endpoints.insight.regimeLog(60);
const TRACK_SPY = endpoints.insight.regimeTrackRecord("SPY");

/** 하이픈(-)으로 쓴 음수 — 숫자 바로 앞의 '-'이고 앞 글자가 숫자·영문자가 아님(날짜 '2026-10-08'·이름 '10Y-3M'은 빼고). */
const ASCII_NEGATIVE = /(^|[^\dA-Za-z])-\d/;

async function panelTitled(name: string): Promise<HTMLElement> {
  return (await screen.findByRole("heading", { name })).closest("section") as HTMLElement;
}

/** 판정 기록 한 건 — 금리차·NFCI·순유동성 4주가 음수. */
function regimeLog() {
  return {
    available: true, startedOn: "2026-10-08", count: 1, recordHourKst: 18,
    entries: [{
      date: "2026-10-08", code: "LATE", label: "후퇴 경계 (Late cycle)", missing: [], ruleVersion: "regime-v1",
      inputs: {
        curve10y3m: { value: -0.12, asOf: "2026-10-08" },
        nfci: { value: -0.48, asOf: "2026-10-02" },
        hyOas: { value: 2.85, asOf: "2026-10-08" },
        liquidity4w: { value: -0.0254, asOf: "2026-10-08" },
      },
    }],
  };
}

/** 판정 성과 — 확장 국면 13주 뒤 평균·중앙값·기준 대비가 음수. */
function trackRecord() {
  const cell = { horizonWeeks: 13, count: 42, independent: 4, sufficient: true, mean: -1.2, median: -0.8, winRate: 40,
    best: 5, worst: -9, excessMean: -1.7 };
  const base = { horizonWeeks: 13, count: 140, independent: 11, sufficient: true, mean: -0.4, median: 0.2, winRate: 55, best: 12, worst: -9 };
  return {
    available: true, asset: "SPY", assetLabel: "S&P 500 (SPY)", assets: [{ ticker: "SPY", label: "S&P 500 (SPY)" }],
    horizons: [13], limits: ["과거 재현입니다."], evaluatedFrom: "2023-09-07", evaluatedTo: "2026-08-13", knownWeeks: 154,
    priceFrom: "2021-01-04", priceTo: "2026-11-14", minSamples: 10, minIndependent: 3, rule: "매주 목요일 판정.",
    start: [{ code: "EXPANSION", label: "확장 (Expansion)", weeks: 6, episodes: 6, cells: [cell] }],
    all: [{ code: "EXPANSION", label: "확장 (Expansion)", weeks: 60, episodes: 6, cells: [cell] }],
    baseline: [base],
  };
}

/** 국면 응답 + 주간 재현 넷과 구간 셋(최근 순). */
function withHistory(): RegimeResponse {
  return {
    ...regimeExpansion(),
    timeline: [
      { date: "2026-10-22", code: "UNKNOWN", label: "판정 불가" },
      { date: "2026-10-29", code: "LATE", label: "후퇴 경계 (Late cycle)" },
      { date: "2026-11-05", code: "EXPANSION", label: "확장 (Expansion)" },
      { date: "2026-11-12", code: "EXPANSION", label: "확장 (Expansion)" },
    ],
    episodes: [
      { code: "EXPANSION", label: "확장 (Expansion)", start: "2026-11-05", end: "2026-11-12", weeks: 2 },
      { code: "LATE", label: "후퇴 경계 (Late cycle)", start: "2026-10-29", end: "2026-10-29", weeks: 1 },
      { code: "UNKNOWN", label: "판정 불가", start: "2026-10-22", end: "2026-10-22", weeks: 1 },
    ],
  };
}

describe("QA-635 국면 이력 띠·범례 견본이 고대비에서 남는다", () => {
  // 수정 전에는 띠의 칸과 범례 견본을 바탕색(bg-ok/70 등)으로만 그려, 고대비(forced-colors)에서 바탕색이 지워지면 띠와 견본이 통째로 사라졌습니다
  // (D1 QA '바탕색만으로 그린 모양'의 국면 몫). 띠는 이름 없는 칸 259개라 낭독기에는 아무 뜻도 전하지 못했습니다.
  it("띠는 이름 있는 그림(기간·구간 수)이고 칸은 읽기에서 빠지며, 띠와 범례 견본은 고대비에서도 색 그대로", async () => {
    reads[REGIME] = withHistory();
    render(<RegimePage />);

    const band = await screen.findByRole("img", { name: /국면 이력 띠/ });
    expect(band.getAttribute("aria-label")).toBe("국면 이력 띠 — 2026-10-22 ~ 2026-11-12, 주간 판정 4번·구간 3개(최근 구간은 아래 표)");
    expect(band.className).toContain("forced-color-adjust-none");
    const cells = Array.from(band.children);
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.getAttribute("aria-hidden") === "true")).toBe(true);

    const legend = screen.getByRole("list", { name: "국면 이력 띠 범례" });
    const swatches = Array.from(legend.querySelectorAll("[data-band-swatch]"));
    // 네 국면 + 판정 불가.
    expect(swatches).toHaveLength(5);
    for (const swatch of swatches) {
      expect(swatch.getAttribute("aria-hidden")).toBe("true");
      expect(swatch.className).toContain("forced-color-adjust-none");
    }
    expect(within(legend).getByText("판정 불가")).toBeTruthy();
  });
});

describe("QA-636 국면 화면의 음수는 −(U+2212)", () => {
  // 수정 전에는 판정 근거 값(formatNumber)·판정 기록 근거(regimeInputCells — formatSigned·formatTrillionDelta)·판정 성과 수익률(formatPercent)이
  // 하이픈(-)으로 음수를 적어, 같은 국면 신호를 −로 적는 홈 국면 패널(QA-600)·변화 칩과 글자가 달랐습니다(명세 D4).
  it("판정 근거: NFCI 음수가 −로", async () => {
    reads[REGIME] = regimeExpansion();
    render(<RegimePage />);
    const panel = await panelTitled("판정 근거");
    await within(panel).findByText("시카고 연준 금융상황지수");
    expect(panel.textContent).not.toMatch(ASCII_NEGATIVE);
    expect(panel.textContent).toContain("−0.");
  });

  it("판정 기록: 근거 넷의 음수가 −로", async () => {
    reads[REGIME_LOG] = regimeLog();
    render(<RegimePage />);
    const panel = await panelTitled("판정 기록");
    await within(panel).findAllByText(/0\.48/);
    expect(panel.textContent).not.toMatch(ASCII_NEGATIVE);
    expect(panel.textContent).toContain("−0.48");
    expect(panel.textContent).toContain("−254.0억 달러");
  });

  it("판정 성과: 평균·중앙값·기준 대비·아무 때나의 음수가 −로", async () => {
    reads[TRACK_SPY] = trackRecord();
    render(<RegimePage />);
    const panel = await panelTitled("판정 성과");
    await within(panel).findAllByText(/1\.20%/);
    expect(panel.textContent).not.toMatch(ASCII_NEGATIVE);
    for (const text of ["−1.20%", "−0.80%", "−1.70%p", "−0.40%"]) expect(panel.textContent).toContain(text);
  });
});
