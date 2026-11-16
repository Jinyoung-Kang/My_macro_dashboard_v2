/**
 * 기관 상세 — 13F 포트폴리오 읽기의 서버·연결 실패(400이 아닌 실패)에서 '다시 시도'가 늘 보이는 대상 머리에 있다(QA-609). 응답은 모두 합성 값입니다.
 *
 * P4에서 상위 보유 종목이 가운데 '보유 종목' 탭으로 들어가면서(D1은 늘 보이는 카드), 화면의 유일한 '다시 시도'가 기본이 아닌 그 탭(hidden) 안에
 * 남았습니다 — 대상 머리는 위험 안내 글뿐이라 첫 화면('개요' 탭)에는 다시 읽을 방법이 보이지 않았습니다. 종목 상세(결정 2 검토 반영)·지표 상세(QA-588)와
 * 같은 자리(대상 머리 — 좁은 화면에서 처음에 접히는 왼쪽 칸 밖)에 하나 둡니다. 추적하지 않는 CIK(400)는 다시 시도가 없습니다(QA-584 — 별도 시험).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const CIK = "0001608046";
const PATH = endpoints.institution.portfolio(CIK, 8, 30);

let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    if (!(path in reads)) return new Promise(() => {});
    const body = reads[path];
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
  });
});
afterEach(cleanup);

/** lib/api의 실제 ApiError(상태 코드 칸) — 이 파일은 lib/api를 흉내 내므로 실제 모듈에서 가져옵니다. */
async function apiError(message: string, status: number): Promise<Error> {
  const { ApiError } = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return new ApiError(message, status);
}

/** 숨긴 탭(hidden 조상) 밖에 있는 것만 — jsdom은 배치를 재지 않아 hidden 속성으로 봅니다. */
const shown = (element: HTMLElement) => element.closest("[hidden]") === null;

describe("기관 상세 — 포트폴리오 서버 실패의 다시 시도는 대상 머리에 (QA-609)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 대상 머리 안 '다시 시도'가 0개였고, 하나뿐인 단추가 숨긴 '보유 종목' 탭 안에 있었습니다.
  it.fails("포트폴리오 500 — 기본 '개요' 탭 그대로 대상 머리에 '다시 시도' 하나, 숨긴 탭 밖 보이는 다시 시도도 하나, 누르면 다시 읽음", async () => {
    reads[PATH] = await apiError("합성 서버 오류", 500);
    render(
      <SessionUserProvider user={MEMBER}>
        <InstitutionDetailScreen cik={CIK} />
      </SessionUserProvider>,
    );
    const header = (await screen.findByRole("heading", { level: 1, name: `CIK ${CIK}` })).closest("header") as HTMLElement;
    await waitFor(() => expect(within(header).getByText("합성 서버 오류")).toBeTruthy());
    // 기본 탭은 '개요' 그대로(탭을 누르지 않음)
    expect(screen.getByRole("tab", { name: "개요" }).getAttribute("aria-selected")).toBe("true");
    const retries = within(header).getAllByRole("button", { name: "다시 시도" });
    expect(retries).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "다시 시도" }).filter(shown)).toHaveLength(1);
    const calls = () => api.apiGetShared.mock.calls.filter(([requested]) => requested === PATH).length;
    expect(calls()).toBe(1);
    fireEvent.click(retries[0]);
    await waitFor(() => expect(calls()).toBe(2));
  });
});
