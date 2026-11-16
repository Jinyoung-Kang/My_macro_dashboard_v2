/**
 * 지표 상세 — 매크로 개요 읽기 실패의 다시 시도(QA-588). 응답은 모두 합성 값입니다.
 *
 * 지표 상세는 읽는 것이 매크로 개요 하나라 실패하면 대상 머리만 그리는데, 그 자리표시가 다시 시도 자리가 없는 위험 안내(Banner)여서 화면 어디에도
 * 다시 읽는 조작이 없었습니다(탭을 바꾸거나 5분 주기·새로고침을 기다려야 함). 종목·기관 상세처럼 공용 오류 상자(ErrorState) + 다시 시도
 * (QA-190·QA-532와 같은 규칙)를 둡니다. 제목은 주소 키 그대로입니다(대상 머리 자리표시 규칙 — 종목 코드·'CIK …'와 같음).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { macroOverview } from "@/lib/__tests__/homeFixtures";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({ LineChart: ({ ariaLabel }: { ariaLabel?: string }) => <div role="img" aria-label={ariaLabel} /> }));

import { IndicatorDetailScreen } from "../IndicatorDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const OVERVIEW = endpoints.macro.overview(false);

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = { "/api/calendar/kr-holidays": { available: true, years: {} } };
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});
afterEach(cleanup);

const overviewCalls = () => api.apiGetShared.mock.calls.filter(([path]) => path === OVERVIEW).length;

describe("지표 상세 — 개요 읽기 실패 (QA-588)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 머리에 위험 안내(Banner — '주의: 합성 오류')만 있고 '다시 시도' 단추가 0개였습니다.
  it("공용 오류 상자와 '다시 시도' — 누르면 개요를 다시 읽어 지표를 그린다(제목은 그때까지 주소 키)", async () => {
    reads[OVERVIEW] = new Error("합성 오류");
    render(
      <SessionUserProvider user={MEMBER}>
        <IndicatorDetailScreen indicatorKey="sp500" />
      </SessionUserProvider>,
    );
    const header = (await screen.findByRole("heading", { level: 1, name: "sp500" })).closest("header") as HTMLElement;
    await waitFor(() => expect(within(header).getByText("합성 오류")).toBeTruthy());
    const retry = await within(header).findByRole("button", { name: "다시 시도" });
    expect(overviewCalls()).toBe(1);

    reads[OVERVIEW] = macroOverview();
    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { level: 1, name: "S&P 500" })).toBeTruthy();
    expect(overviewCalls()).toBe(2);
    expect(screen.queryByText("합성 오류")).toBeNull();
  });
});
