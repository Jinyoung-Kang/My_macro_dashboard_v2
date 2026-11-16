/**
 * 기관 상세 보유 종목 탭의 개수 줄('N종목 가운데 비중 상위 30종목' — QA-585). 응답은 모두 합성 값이고, 모양은 실제 응답(GET /api/sec13f/portfolio
 * topN=30 — 백엔드가 비중 상위 30줄로 잘라 보냄, 전체 종목 수는 분기별 holdingCount)과 같습니다.
 *
 * 개수 줄은 응답 길이가 보이는 줄 수(30)보다 클 때만 나왔는데, 응답이 이미 30줄로 잘려 와 실제 데이터에서는 한 번도 나오지 않았습니다(552종목
 * 가운데 30줄이라는 표시가 탭에 없음). P4 검토의 '32줄 하네스'는 백엔드에서 나올 수 없는 응답 모양이었습니다. 전체 수는 최신 분기 holdingCount로
 * 셉니다 — 모르면(분기 없음·수 없음) 응답 길이로 짐작하지 않고 줄을 두지 않습니다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { Holding, PortfolioResponse, SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { InstitutionDetailScreen } from "../InstitutionDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const CIK = "0009999985";
const COUNT_LINE = /종목 가운데 비중 상위/;

const holding = (at: number, overrides: Partial<Holding> = {}): Holding => ({
  name: `SYNTHETIC HOLDING ${at + 1}`, cusip: `00000${String(at).padStart(4, "0")}`, class: "COM", value: 1e9 - at, shares: 1000, weight: 3,
  weightDiff: null, sharesDiff: null, action: "유지", ...overrides,
});

function portfolio(holdings: Holding[], quarters: PortfolioResponse["quarters"]): PortfolioResponse {
  return {
    available: true, cik: CIK, institution: { name: "합성 연금 (Synthetic Pension)", desc: "" }, quarters,
    latest: { reportDate: "2026-06-30", filingDate: "2026-08-14", totalValue: 30e9 }, holdings,
  };
}

let body: PortfolioResponse | null = null;

beforeEach(() => {
  body = null;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path === endpoints.institution.portfolio(CIK, 8, 30) && body ? Promise.resolve(body) : new Promise(() => {}),
  );
});
afterEach(cleanup);

async function openHoldings(response: PortfolioResponse) {
  body = response;
  render(
    <SessionUserProvider user={MEMBER}>
      <InstitutionDetailScreen cik={CIK} />
    </SessionUserProvider>,
  );
  fireEvent.click(await screen.findByRole("tab", { name: "보유 종목" }));
  await screen.findByRole("list", { name: "상위 보유 종목" });
}

const THIRTY = Array.from({ length: 30 }, (_, at) => holding(at));

describe("보유 종목 탭의 개수 줄 — 최신 분기 보유 종목 수 기준 (QA-585)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 응답 30줄(topN=30)이라 개수 줄이 없었습니다(30 > 30 거짓).
  it("(가)·(나) 실제 응답 모양(30줄 + holdingCount) — 최신 분기 수 '552종목 가운데 비중 상위 30종목', 천 단위 쉼표", async () => {
    await openHoldings(
      portfolio(THIRTY, [
        { filingDate: "2026-05-15", reportDate: "2026-03-31", totalValue: 29e9, holdingCount: 540 },
        { filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 30e9, holdingCount: 552 },
      ]),
    );
    expect(screen.getByText("552종목 가운데 비중 상위 30종목")).toBeTruthy();
    cleanup();

    await openHoldings(portfolio(THIRTY, [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 30e9, holdingCount: 4173 }]));
    expect(screen.getByText("4,173종목 가운데 비중 상위 30종목")).toBeTruthy();
  });

  it("(다) 보유 29 + 전량 매도 1 = 30줄(holdingCount 29) — 개수 줄 없음", async () => {
    const holdings = [...THIRTY.slice(0, 29), holding(29, { value: 0, shares: 0, weight: 0, action: "전량 매도 (Closed)" })];
    await openHoldings(portfolio(holdings, [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 30e9, holdingCount: 29 }]));
    expect(screen.queryByText(COUNT_LINE)).toBeNull();
  });

  it("(라) 분기가 없거나 보유 종목 수를 모르면 응답 길이로 짐작하지 않고 개수 줄 없음", async () => {
    await openHoldings(portfolio(THIRTY, []));
    expect(screen.queryByText(COUNT_LINE)).toBeNull();
    cleanup();

    await openHoldings(
      portfolio(THIRTY, [{ filingDate: "2026-08-14", reportDate: "2026-06-30", totalValue: 30e9, holdingCount: null as unknown as number }]),
    );
    expect(screen.queryByText(COUNT_LINE)).toBeNull();
  });
});
