/**
 * 기관 상세 대상 머리 — 이름을 받기 전·받지 못했을 때 'CIK …'를 두 번 적지 않는다(QA-583). 응답은 모두 합성 값입니다.
 *
 * 기관 이름은 포트폴리오 응답에만 있어, 받기 전·읽기 실패·추적하지 않는 CIK에서는 제목(h1)이 자리표시 'CIK …'입니다. 그런데 식별자 태그
 * 'CIK …'(고정폭)를 늘 넘겨 같은 글이 제목과 태그로 두 번 나왔고, 390에서는 태그가 둘째 줄로 내려가 머리가 한 줄 높았습니다. 종목·지표 상세는
 * 이름이 코드 그대로면 태그를 두지 않습니다(d6571bf3) — 기관 상세도 같은 규칙입니다.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SessionUser } from "@/lib/types";

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
const CIK = "1234567";
const PORTFOLIO = endpoints.institution.portfolio(CIK, 8, 30);

beforeEach(() => {
  api.apiGetShared.mockReset();
});
afterEach(cleanup);

function renderScreen() {
  render(
    <SessionUserProvider user={MEMBER}>
      <InstitutionDetailScreen cik={CIK} />
    </SessionUserProvider>,
  );
}

/** h1 'CIK …'가 든 대상 머리. */
async function header() {
  return (await screen.findByRole("heading", { level: 1, name: `CIK ${CIK}` })).closest("header") as HTMLElement;
}

describe("기관 상세 대상 머리 — 자리표시 이름이면 CIK 태그 없음 (QA-583)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 두 경우 모두 머리 안 'CIK 1234567' 글이 2개(h1과 태그 안 font-mono span)였습니다.
  it.fails("포트폴리오 읽기가 실패하면 머리의 'CIK …'는 제목 한 번(고정폭 태그 없음)", async () => {
    api.apiGetShared.mockImplementation((path: string) => (path === PORTFOLIO ? Promise.reject(new Error("13F 저장본을 읽지 못했습니다.")) : new Promise(() => {})));
    renderScreen();
    const head = await header();
    await waitFor(() => expect(within(head).getByText("13F 저장본을 읽지 못했습니다.")).toBeTruthy());
    expect(within(head).getAllByText(`CIK ${CIK}`)).toHaveLength(1);
    expect(head.querySelectorAll(".font-mono")).toHaveLength(0);
  });

  it.fails("불러오는 중에도 머리의 'CIK …'는 제목 한 번(고정폭 태그 없음)", async () => {
    api.apiGetShared.mockImplementation(() => new Promise(() => {}));
    renderScreen();
    const head = await header();
    expect(within(head).getByRole("status", { name: "13F 포트폴리오를 불러오는 중" })).toBeTruthy();
    expect(within(head).getAllByText(`CIK ${CIK}`)).toHaveLength(1);
    expect(head.querySelectorAll(".font-mono")).toHaveLength(0);
  });
});
