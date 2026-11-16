/**
 * 상관(/correlation) 화면 — 상관계수와 고른 쌍의 뜻(추정 배지 등).
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
async function coefficientTile(): Promise<HTMLElement> {
  return (await screen.findByText("상관계수 (변화)")).parentElement as HTMLElement;
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
