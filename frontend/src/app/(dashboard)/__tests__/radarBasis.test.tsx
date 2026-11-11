/**
 * 수급 레이더 순위의 실제 기간과 기준일(QA-397·QA-396).
 *
 * 기간(5일·20일)을 골라도 수집기가 하루치를 돌려줄 수 있습니다(이 투자주체의 기간 누적이 없거나 기간 조회 실패). 백엔드가 실제 기간
 * (`intervalType`)·요청 기간(`requestedIntervalType`)·경고를 내리면, 화면은 경고 띠와 함께 순위 카드에 **응답의** 기간을 적습니다.
 * 고른 값('5거래일')만 보이면 하루치 금액을 5일 누적으로 읽게 됩니다. 기준일(`dataDate`)이 오면 같은 줄에 적습니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import RadarPage from "../radar/page";

const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };

const RANKING = {
  available: true, market: "KOSPI", investor: "외국인", tradeType: "순매수", readMode: "auto",
  source: "KRX 정보데이터시스템 확정 (외국인, 2026-11-10)", sourceKind: "krx", isHistorical: false, historyDate: null,
  rows: [{ rank: 1, code: "005930", name: "삼성전자", price: 71000, changePct: 1.2, netAmountEok: 900.5 }],
};

function respond(ranking: Record<string, unknown>) {
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith("/api/radar/ranking") ? Promise.resolve(ranking) : new Promise(() => {}));
}

beforeEach(() => api.apiGetShared.mockReset());
afterEach(() => cleanup());

describe("레이더 순위의 실제 기간과 기준일", () => {
  it.fails("QA-397: 응답의 기간이 하루치로 바뀌었으면 경고와 함께 순위 카드에 '기간 당일'을 적는다", async () => {
    respond({
      ...RANKING, intervalType: "TODAY", requestedIntervalType: "DAYS_5", dataDate: "2026-11-10",
      warning: "요청한 기간(5거래일)의 누적을 받지 못해 하루치(당일) 순위입니다.",
    });
    render(<SessionUserProvider user={MEMBER}><RadarPage /></SessionUserProvider>);

    expect(await screen.findByText(/요청한 기간\(5거래일\)의 누적을 받지 못해/)).toBeTruthy();
    expect(screen.getByText("기간 당일 · 기준일 2026-11-10")).toBeTruthy();
  });

  it.fails("QA-396: 기준일을 모르는 응답이면 기간만 적는다(없는 날짜를 만들지 않음)", async () => {
    respond({ ...RANKING, intervalType: "DAYS_5", dataDate: null });
    render(<SessionUserProvider user={MEMBER}><RadarPage /></SessionUserProvider>);

    expect(await screen.findByText("기간 5거래일")).toBeTruthy();
    expect(screen.queryByText(/기준일/)).toBeNull();
  });
});
