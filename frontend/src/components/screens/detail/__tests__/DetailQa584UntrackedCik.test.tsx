/**
 * 기관 상세 — 앞 0 없는 CIK 주소와 추적하지 않는 CIK(QA-584). 응답은 모두 합성 값입니다.
 *
 * - 주소의 CIK는 숫자 1~10자리를 그대로 넘겨, 같은 기관의 앞 0 없는 주소(/institutions/1608046)가 백엔드에서 400이었습니다 — 10자리로 채워 읽습니다.
 * - 추적하지 않는 CIK의 400 응답 문구는 API 호출자를 위한 글('(/api/sec13f/institutions 목록의 cik를 쓰세요)')인데 머리와 보유 탭에 그대로 나왔고,
 *   다시 해도 같은 400인데 '다시 시도'가 있었습니다. 400이면 화면 글('이 대시보드가 추적하는 13F 기관이 아닙니다')과 기관 목록 링크를 보이고
 *   다시 시도를 두지 않습니다. 서버·연결 실패(5xx·0)는 지금처럼 오류와 다시 시도(QA-190)입니다.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
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
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import InstitutionDetailPage from "@/app/(dashboard)/institutions/[cik]/page";
import { InstitutionDetailScreen } from "../InstitutionDetailScreen";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
/** AI 요약을 쓸 수 있는 회원 — 무료 회원은 요약 카드가 등급 안내라 부르지 않는 까닭(idleText)이 보이지 않습니다. */
const PRO: SessionUser = { email: "p@test.local", role: "MEMBER", tier: "PRO" };
const UNTRACKED = "0000000001";
/** 백엔드 Institutions.requireKnownCik의 400 문구(API 호출자를 위한 글). */
const BACKEND_400 = `추적하지 않는 기관 CIK입니다: ${UNTRACKED} (/api/sec13f/institutions 목록의 cik를 쓰세요)`;

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

const renderAs = (page: ReactElement) => render(<SessionUserProvider user={MEMBER}>{page}</SessionUserProvider>);
const requested = () => api.apiGetShared.mock.calls.map(([path]) => path as string);

/** lib/api의 실제 ApiError(상태 코드 칸) — 이 파일은 lib/api를 흉내 내므로 실제 모듈에서 가져옵니다. */
async function apiError(message: string, status: number): Promise<Error> {
  const { ApiError } = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return new ApiError(message, status);
}

describe("기관 상세 — 앞 0 없는 CIK와 추적하지 않는 CIK (QA-584)", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 portfolio?cik=1608046을 읽었습니다(백엔드 400 — 같은 기관인데).
  it("앞 0 없는 주소(/institutions/1608046)는 10자리 CIK(0001608046)로 포트폴리오를 읽는다", async () => {
    reads[endpoints.institution.portfolio("0001608046", 8, 30)] = {
      available: true, cik: "0001608046", institution: { name: "합성 연금 (Synthetic Pension)", desc: "" }, quarters: [], holdings: [],
    };
    renderAs(await InstitutionDetailPage({ params: Promise.resolve({ cik: "1608046" }) }));
    expect(await screen.findByRole("heading", { level: 1, name: "합성 연금 (Synthetic Pension)" })).toBeTruthy();
    expect(requested()).toContain(endpoints.institution.portfolio("0001608046", 8, 30));
    expect(requested()).not.toContain(endpoints.institution.portfolio("1608046", 8, 30));
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 머리와 보유 탭에 백엔드 문구('/api/sec13f/institutions …')가 그대로, 보유 탭에 '다시 시도'가 있었습니다.
  it("추적하지 않는 CIK(400)는 화면 글과 기관 목록 링크 — 백엔드 문구·다시 시도 없음", async () => {
    reads[endpoints.institution.portfolio(UNTRACKED, 8, 30)] = await apiError(BACKEND_400, 400);
    renderAs(<InstitutionDetailScreen cik={UNTRACKED} />);
    const header = (await screen.findByRole("heading", { level: 1, name: `CIK ${UNTRACKED}` })).closest("header") as HTMLElement;
    await waitFor(() => expect(within(header).getByText(/이 대시보드가 추적하는 13F 기관이 아닙니다/)).toBeTruthy());
    expect(within(header).getByText(`이 대시보드가 추적하는 13F 기관이 아닙니다(CIK ${UNTRACKED}).`)).toBeTruthy();
    expect(within(header).getByRole("link", { name: "추적하는 13F 기관 목록" }).getAttribute("href")).toBe("/institutions");
    fireEvent.click(screen.getByRole("tab", { name: "보유 종목" }));
    const holdings = screen.getByRole("heading", { level: 2, name: "상위 보유 종목" }).closest("section") as HTMLElement;
    expect(within(holdings).getByText(/추적하는 13F 기관이 아닙니다/)).toBeTruthy();
    expect(screen.queryByText(/\/api\/sec13f/)).toBeNull();
    expect(screen.queryAllByRole("button", { name: "다시 시도" })).toHaveLength(0);
    // 연결 패널의 정보 검색·EDGAR 링크는 남김(실제로 있는 미추적 공시자의 출구)
    expect(screen.getByRole("link", { name: /SEC EDGAR 13F 공시/ })).toBeTruthy();
  });

  // 머리가 '추적하는 13F 기관이 아닙니다'라고 중립으로 알리는데 기본으로 열리는 개요 탭(차트 패널·AI 요약)과 뉴스 탭은 읽기 실패로 적었습니다.
  // 수정 전(재현 커밋에서는 it.fails)에는 '13F 포트폴리오를 읽지 못해 추이를 그리지 않습니다.'·'기관 이름을 받지 못해 요약하지 않습니다.'·
  // '기관 이름을 받지 못해 뉴스를 찾지 않습니다.'였습니다.
  it("추적하지 않는 CIK(400)는 개요 탭 차트·AI 요약과 뉴스 탭도 '추적하지 않는 기관' 글 — 읽기 실패 글 없음", async () => {
    reads[endpoints.institution.portfolio(UNTRACKED, 8, 30)] = await apiError(BACKEND_400, 400);
    render(
      <SessionUserProvider user={PRO}>
        <InstitutionDetailScreen cik={UNTRACKED} />
      </SessionUserProvider>,
    );
    const chart = (await screen.findByRole("region", { name: "분기별 13F 보고 평가액" })) as HTMLElement;
    await waitFor(() => expect(within(chart).getByText("추적하지 않는 기관이라 13F 추이가 없습니다.")).toBeTruthy());
    expect(screen.getByText("추적하지 않는 기관이라 요약하지 않습니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    expect(screen.getByText("추적하지 않는 기관이라 뉴스를 찾지 않습니다.")).toBeTruthy();
    expect(screen.queryByText(/읽지 못해|받지 못해/)).toBeNull();
  });

  it("서버 실패(500)는 지금처럼 보유 탭에 오류와 다시 시도(QA-190)", async () => {
    const path = endpoints.institution.portfolio(UNTRACKED, 8, 30);
    reads[path] = await apiError("13F 저장본을 읽지 못했습니다.", 500);
    renderAs(<InstitutionDetailScreen cik={UNTRACKED} />);
    await waitFor(() => expect(screen.getAllByText("13F 저장본을 읽지 못했습니다.").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("tab", { name: "보유 종목" }));
    const holdings = screen.getByRole("heading", { level: 2, name: "상위 보유 종목" }).closest("section") as HTMLElement;
    fireEvent.click(within(holdings).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(requested().filter((entry) => entry === path)).toHaveLength(2));
  });
});
