/**
 * 13F 포트폴리오(/institutions) 화면의 요청 지킴 — 작업대 개편(P5b 포트폴리오 갈래)이 화면을 다시 짜도 읽는 경로·횟수·시점이 그대로인지 봅니다.
 *
 * - 열 때 기관 목록·포트폴리오(기본 버크셔 0001067983 · 8분기 · 상위 30)·원/달러를 한 번씩, 응답을 기다리지 않고 함께 부름.
 * - 자동 갱신은 원/달러 하나(120초 — 공용 환율 훅 useUsdKrw). 걸린 타이머를 하나씩 불러 어느 경로를 다시 읽는지 봅니다.
 * - 기관·조회 분기 수·표시 종목 수를 바꾸면 바뀐 조건의 포트폴리오만 한 번 더(기관 목록·환율은 다시 읽지 않음).
 *
 * 개편 전 코드에서 통과시켜 두고, 개편 커밋들이 그대로 통과해야 합니다(계획 §4-2 '요청 지킴 시험'). 검사 칸처럼 개편이 새로 만드는 조작의 '+0' 사례는
 * 그 조작을 만드는 커밋에서 더합니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트를 재지 못해 그림은 뺍니다(요청만 봄).
vi.mock("@/components/charts", () => ({
  MultiLineSeries: () => null,
  WeightHeatmap: () => null,
}));

import { endpoints } from "@/lib/endpoints";
import type { PortfolioResponse } from "@/lib/types";
import InstitutionsPage from "../institutions/page";

const BERKSHIRE = "0001067983";
const NPS = "0001608046";

const INSTITUTIONS = endpoints.institution.institutions;
const PORTFOLIO = endpoints.institution.portfolio(BERKSHIRE, "8", "30");
const USDKRW = endpoints.macro.usdkrw;

/** 경로 → 응답(정확히 일치). 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};
let intervals: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  reads = {};
  signal.token = 0;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  intervals = vi.spyOn(globalThis, "setInterval");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 부른 경로 목록(부른 차례 그대로). */
const calledPaths = () => (api.apiGetShared.mock.calls as unknown as [string][]).map(([path]) => path);
/** 경로마다 부른 횟수. */
function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const path of calledPaths()) out[path] = (out[path] ?? 0) + 1;
  return out;
}

/**
 * 1분 이상 간격의 타이머(자동 갱신)를 하나씩 불러 다시 읽은 경로를 모읍니다 — 간격 → 그 타이머가 읽은 경로 목록(정렬).
 * 1분 미만 타이머(화면 안 시계 등)는 자동 갱신이 아니라 보지 않습니다.
 */
async function refreshTimers(): Promise<Record<number, string[]>> {
  const out: Record<number, string[]> = {};
  const calls = intervals.mock.calls as unknown as [() => void, number][];
  for (const [callback, delay] of calls) {
    if (typeof delay !== "number" || delay < 60_000) continue;
    const before = calledPaths().length;
    await act(async () => callback());
    const added = calledPaths().slice(before);
    out[delay] = [...(out[delay] ?? []), ...added].sort();
  }
  return out;
}

function portfolio(cik: string): PortfolioResponse {
  return {
    available: true, cik,
    quarters: [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 1000, holdingCount: 2 }],
    latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 1000 },
    holdings: [
      { name: "SYNTHETIC ALPHA CO", cusip: "000000101", class: "COM", value: 600, shares: 60, weight: 60, weightDiff: 1.5, sharesDiff: 5, action: "비중 확대 (Added)" },
      { name: "SYNTHETIC BETA CO", cusip: "000000102", class: "COM", value: 400, shares: 40, weight: 40, weightDiff: -1.5, sharesDiff: -5, action: "비중 축소 (Reduced)" },
    ],
    weightHistory: { dates: ["2026-06-30"], series: { "SYNTHETIC ALPHA CO": [60], "SYNTHETIC BETA CO": [40] } },
  };
}

/** 기관 둘(합성 이름)·버크셔 포트폴리오·환율이 오는 화면. */
function answerAll() {
  reads[INSTITUTIONS] = {
    institutions: [
      { key: "brk", name: "가상 버크셔", cik: BERKSHIRE, desc: "합성 기관 설명 하나" },
      { key: "nps", name: "가상 연기금", cik: NPS, desc: "합성 기관 설명 둘" },
    ],
  };
  reads[PORTFOLIO] = portfolio(BERKSHIRE);
  reads[USDKRW] = { available: true, rate: 1400, lastTs: "2026-11-18 09:00" };
}

describe("13F 포트폴리오 화면의 요청", () => {
  it("열 때 기관 목록·포트폴리오(버크셔·8분기·상위 30)·원/달러를 한 번씩 함께 부르고, 자동 갱신은 원/달러만 120초마다", async () => {
    render(<InstitutionsPage />);
    // 셋 모두 끝나지 않는 요청인데도 함께 나갑니다 — 기관 목록을 받은 뒤에 포트폴리오를 부르지 않습니다.
    await waitFor(() => expect(calledPaths()).toHaveLength(3));
    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [PORTFOLIO]: 1, [USDKRW]: 1 });

    expect(await refreshTimers()).toEqual({ 120_000: [USDKRW] });
  });

  it("기관을 바꾸면 그 기관의 포트폴리오만 한 번 더 — 기관 목록·원/달러는 다시 읽지 않는다", async () => {
    answerAll();
    render(<InstitutionsPage />);
    await screen.findByText("SYNTHETIC ALPHA CO");

    fireEvent.change(screen.getByLabelText("분석할 기관"), { target: { value: NPS } });

    const next = endpoints.institution.portfolio(NPS, "8", "30");
    await waitFor(() => expect(counts()[next]).toBe(1));
    await act(async () => {});
    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [PORTFOLIO]: 1, [USDKRW]: 1, [next]: 1 });
  });

  it("조회 분기 수를 바꾸면 그 조건의 포트폴리오만 한 번 더", async () => {
    answerAll();
    render(<InstitutionsPage />);
    await screen.findByText("SYNTHETIC ALPHA CO");

    fireEvent.change(screen.getByLabelText("조회 분기 수"), { target: { value: "4" } });

    const next = endpoints.institution.portfolio(BERKSHIRE, "4", "30");
    await waitFor(() => expect(counts()[next]).toBe(1));
    await act(async () => {});
    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [PORTFOLIO]: 1, [USDKRW]: 1, [next]: 1 });
  });

  it("표시 종목 수를 바꾸면 그 조건의 포트폴리오만 한 번 더", async () => {
    answerAll();
    render(<InstitutionsPage />);
    await screen.findByText("SYNTHETIC ALPHA CO");

    fireEvent.change(screen.getByLabelText("표시 종목 수"), { target: { value: "50" } });

    const next = endpoints.institution.portfolio(BERKSHIRE, "8", "50");
    await waitFor(() => expect(counts()[next]).toBe(1));
    await act(async () => {});
    expect(counts()).toEqual({ [INSTITUTIONS]: 1, [PORTFOLIO]: 1, [USDKRW]: 1, [next]: 1 });
  });
});
