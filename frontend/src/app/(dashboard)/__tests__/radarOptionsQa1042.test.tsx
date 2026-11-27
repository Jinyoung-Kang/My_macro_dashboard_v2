/**
 * QA-1042(성능 개선 3차 작업 D): 수급 레이더의 조회 조건 선택 상자 — 선택지 응답(GET /api/radar/options) 전에는 한 칸짜리 목록(KOSPI·외국인·순매수·당일)이라
 * 응답 뒤 상자가 넓어지며 좁은 화면에서 줄바꿈이 바뀌고 그 아래 패널을 밀었습니다(390폭 — QA에서 선택지를 운영과 같은 값으로 답하게 하면 0.003).
 * 응답 전에도 백엔드가 주는 것과 같은 목록(RadarService의 MARKETS·INVESTORS·TRADE_TYPES·INTERVALS 상수)을 둡니다 — 고를 수 있는지·안내 글은 응답을 따릅니다.
 * 수정 전(재현 커밋에서는 it.fails): 'expected [ "KOSPI" ] to deeply equal [ "KOSPI", "KOSDAQ" ]'.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  HorizontalBars: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
  SignedBars: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} />,
}));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";
import RadarPage from "../radar/page";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
/** 백엔드가 주는 선택지(운영 — 토스 키가 있어 여섯 주체 모두 받을 수 있음). */
const OPTIONS = {
  markets: ["KOSPI", "KOSDAQ"],
  investors: ["외국인", "기관", "개인", "연기금", "금융투자", "투신"],
  supportedInvestors: ["외국인", "기관", "개인", "연기금", "금융투자", "투신"],
  tradeTypes: ["순매수", "순매도"],
  intervals: ["TODAY", "DAYS_5", "DAYS_20"],
};

let options: Promise<unknown>;
beforeEach(() => {
  options = new Promise(() => {});
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path.startsWith("/api/radar/options") ? options : new Promise(() => {})));
});
afterEach(() => cleanup());

function labels(name: string): string[] {
  return Array.from((screen.getByLabelText(name) as HTMLSelectElement).options).map((option) => option.textContent ?? "");
}

function renderPage() {
  render(
    <SessionUserProvider user={MEMBER}>
      <RadarPage />
    </SessionUserProvider>,
  );
}

describe("QA-1042 수급 레이더 조회 조건의 응답 전 선택지", () => {
  it("선택지 응답이 오기 전에도 네 선택 상자의 목록은 응답 뒤와 같다 — 상자 폭이 달라지지 않음", async () => {
    renderPage();
    const before = { 시장: labels("시장"), "투자 주체": labels("투자 주체"), "매매 구분": labels("매매 구분"), "조회 기간": labels("조회 기간") };
    expect(before["시장"]).toEqual(["KOSPI", "KOSDAQ"]);
    expect(before["투자 주체"]).toEqual(["외국인", "기관", "개인", "연기금", "금융투자", "투신"]);
    expect(before["매매 구분"]).toEqual(["순매수", "순매도"]);
    expect(before["조회 기간"]).toHaveLength(3);

    cleanup();
    options = Promise.resolve(OPTIONS);
    renderPage();
    for (let round = 0; round < 4; round += 1) await act(async () => {});
    for (const name of Object.keys(before) as (keyof typeof before)[]) expect(labels(name)).toEqual(before[name]);
  });

  it("고를 수 있는지는 응답을 따른다 — 응답이 받을 수 없다고 한 주체만 '지원 안 함'", async () => {
    options = Promise.resolve({ ...OPTIONS, supportedInvestors: ["외국인", "기관"], unsupportedInvestorNote: "합성 안내" });
    renderPage();
    for (let round = 0; round < 4; round += 1) await act(async () => {});
    const select = screen.getByLabelText("투자 주체") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => [option.textContent, option.disabled])).toEqual([
      ["외국인", false], ["기관", false], ["개인 (지원 안 함)", true], ["연기금 (지원 안 함)", true], ["금융투자 (지원 안 함)", true], ["투신 (지원 안 함)", true],
    ]);
  });
});
