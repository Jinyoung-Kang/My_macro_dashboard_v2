/**
 * 순유동성(/liquidity) 화면 — 부호·변화 표시(QA-627).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

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
  it.fails("4주·12주 변화 값과 그 원화 환산의 음수가 −(U+2212)다", async () => {
    render(<LiquidityPage />);

    expect(await screen.findByText("−480.0억 달러")).toBeTruthy();
    expect(screen.getByText("−940.0억 달러")).toBeTruthy();
    expect(screen.getByText(/약 −64\.285조 원/)).toBeTruthy();
    expect(screen.queryAllByText(ASCII_MINUS).map((node) => node.textContent)).toEqual([]);
  });
});
