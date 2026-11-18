/**
 * QA-735 — 미국 기관 선정의 '구간 펼치기'가 후보 표(min-w-[1100px])의 펼침 행 `<td colSpan>` 안에 구간 표를 그려, 좁은 화면(390)에서 설명 글과 구간 표가
 * 표 폭만큼 넓어져 화면 밖으로 잘립니다(명세 §7-1 W13 '같은 꼴(colSpan 펼침)이 SelectionSection에도 있음 — QA 스택으로 확인해 같으면 같은 방식으로').
 * 자기 빌드 390(QA 스택 track-record, 버크셔 행): 설명 글 한 줄이 1,400px 폭(16px 높이)으로 332px 표 상자 안에 그려져 1,080px가 가로 넘김 밖.
 *
 * 펼친 구간(이름 있는 영역 '{기관} 구간')이 표 안(`table` 조상)에 있지 않고, 조상 어디에도 화면 폭(390px)보다 큰 최소 폭 클래스(min-w-[…px])가
 * 없어야 합니다. 여는 조작은 도우미 하나(지금은 행의 '구간 펼치기', 고친 뒤는 기관 칸의 '{기관} 구간 보기').
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => null }));

import PaperScreen from "@/components/screens/paper/PaperScreen";

const NAME = "버크셔 해서웨이 (Berkshire Hathaway)";
const TRACK = {
  available: true, computed: true, asOfDate: "2026-10-23", windowYears: 7, metric: "CAGR",
  criteria: { windowYears: 7, minPeriods: 24, minCoverage: 0.5, avgCoverage: 0.7 },
  candidates: [{
    cik: "0001067983", name: NAME, style: "가치·집중", rank: 1, eligible: true, ineligibleReason: null, collecting: false,
    cagrPct: 14.21, cumReturnPct: 152.3, spyCumReturnPct: 120.4, excessVsSpyPct: 31.9, volPct: 17.85, mddPct: -24.6, sharpe: 0.83,
    periodsUsed: 27, periodsTotal: 28, coverageMin: 0.613, coverageAvg: 0.874, firstFilingDate: "2019-11-14", lastFilingDate: "2026-08-14",
    storedQuarters: 30, complete: true, selected: true,
    periods: [{
      filingDate: "2026-05-15", reportDate: "2026-03-31", start: "2026-05-18", end: "2026-08-17", returnPct: 3.42, spyReturnPct: 2.1,
      coverage: 0.912, coveredTickers: 38, holdings: 42,
    }],
  }],
  selected: ["0001067983"], selectionHistory: [], limits: [],
  collection: { filers: 27, completeCount: 20, storedFilings: 700, targetFilings: 810, updatedAtKst: "2026-10-24 03:10" },
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (path.startsWith("/api/paper/overview")) return Promise.resolve({ available: true, initialized: true, limits: [], books: [], jobs: [] });
    if (path.startsWith("/api/paper/track-record")) return Promise.resolve(TRACK);
    return new Promise(() => {});
  });
});

afterEach(() => cleanup());

/** 기관 하나의 구간을 엽니다 — 고치기 전은 행의 '구간 펼치기', 고친 뒤는 기관 칸의 '{기관} 구간 보기'. */
function openPeriods(name: string) {
  const button = screen.queryByRole("button", { name: `${name} 구간 보기` })
    ?? screen.getAllByRole("button", { name: "구간 펼치기" })[0];
  fireEvent.click(button);
}

/** 조상 중 390px보다 넓은 최소 폭 클래스(min-w-[…px]) 목록. */
function wideAncestors(element: HTMLElement): string[] {
  const found: string[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    for (const token of node.className?.toString().split(/\s+/) ?? []) {
      const match = /^min-w-\[(\d+)px\]$/.exec(token);
      if (match && Number(match[1]) > 390) found.push(token);
    }
  }
  return found;
}

describe("QA-735 — 기관 선정 구간이 표 밖(검사 대화상자)에 그려진다", () => {
  it.fails("펼친 구간은 table 조상 안이 아니고, 조상 어디에도 390px보다 넓은 최소 폭이 없다", async () => {
    render(<PaperScreen initialTab="selection" />);
    await act(async () => {});
    await screen.findByText(NAME);
    openPeriods(NAME);
    const periods = screen.getByRole("region", { name: `${NAME} 구간` });
    expect(periods.closest("table")).toBeNull();
    expect(wideAncestors(periods)).toEqual([]);
  });
});
