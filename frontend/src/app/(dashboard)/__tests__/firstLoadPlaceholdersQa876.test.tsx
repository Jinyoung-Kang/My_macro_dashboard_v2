/**
 * 첫 적재 자리표시 — QA-876(작업대 P7 검토에서 찾음, 브라우저 CLS 측정).
 *
 * P7 화면 셋에서 첫 적재 레이아웃 이동(CLS)이 기준보다 커졌습니다(기준 → P7 끝, 1024): /status 0.0713 → 0.13, /ai/report 0.1562 → 0.1867,
 * /connections 0.2565 → 0.4107. 모두 데이터가 올 때 자리를 잡지 않은 칸이 커지며 아래 패널을 민 것입니다 — /status '수집 오류·경고 로그'(읽는 중 글 한 줄 →
 * KPI 띠 + 로그 상자 30rem, 189 → 709px), /ai/report '고른 엔진' 속성 목록(엔진 응답 뒤 자리 없이 들어옴), /connections '등록된 엔진' 패널(읽는 중 글 한 줄
 * → 패널 + 표).
 *
 * 기대(값이 온 뒤의 꼴로 자리를 잡음 — 상관 화면 CorrelationPending과 같은 방식, 요청 그대로):
 * - /status 로그 절: 읽는 동안 KPI 띠 '오류·경고 불러오는 중'(네 타일 — 값 자리 막대) + 로그 상자 높이 한도만큼의 자리 막대('실행 기록을 모으는 중').
 * - /ai/report: 엔진을 읽는 동안에도 '고른 엔진' 속성 세 줄(속도·모델·쓸 수 있는지)을 '—' + '불러오는 중'으로.
 * - /connections: 엔진을 읽는 동안 '등록된 엔진' 패널(제목·출처·부제)과 표 자리 막대('엔진 목록을 읽는 중').
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 세 사례 모두 'Unable to find …'(첫 사례 role=region '오류·경고 불러오는 중', 둘째 '고른 엔진', 셋째 heading '등록된 엔진').
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import AiReportPage from "../ai/report/page";
import { AiEngineSection } from "../connections/AiEngineSection";
import { IssuesPanel } from "../status/IssuesPanel";

beforeEach(() => {
  api.apiGetShared.mockReset();
  // 모든 읽기가 끝나지 않습니다 — 첫 적재(읽는 중)의 꼴을 봅니다.
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => cleanup());

describe("첫 적재 자리표시(QA-876)", () => {
  it("/status 로그 절: 읽는 동안 KPI 띠 네 타일 자리 + 로그 상자 높이 자리", async () => {
    render(<IssuesPanel />);
    await act(async () => {});
    const strip = screen.getByRole("region", { name: "오류·경고 불러오는 중" });
    expect(within(strip).getAllByRole("listitem")).toHaveLength(4);
    for (const label of ["현재 오류", "현재 경고", "최근 실패 유형", "누락 데이터셋"]) expect(within(strip).getByText(label)).toBeTruthy();
    const log = screen.getByRole("status", { name: "실행 기록을 모으는 중" });
    // 로그 상자 자리는 값이 온 뒤 로그 상자(높이 한도 30rem)에 가까운 높이 — 글 한 줄 자리가 아님.
    expect(Number.parseFloat((log.querySelector("[style]") as HTMLElement | null)?.style.height ?? "0")).toBeGreaterThanOrEqual(320);
  });

  it("/ai/report: 엔진을 읽는 동안에도 '고른 엔진' 세 줄 — '—' + '불러오는 중'", async () => {
    render(<AiReportPage />);
    await act(async () => {});
    const list = screen.getByText("고른 엔진").closest("section, div") as HTMLElement;
    for (const label of ["속도", "모델", "쓸 수 있는지"]) expect(within(list).getByText(label, { selector: "dt" })).toBeTruthy();
    expect(within(list).getAllByText("불러오는 중")).toHaveLength(3);
  });

  it("/connections: 엔진을 읽는 동안 '등록된 엔진' 패널과 표 자리", async () => {
    render(<AiEngineSection />);
    await act(async () => {});
    const panel = screen.getByRole("heading", { name: "등록된 엔진" }).closest("section") as HTMLElement;
    expect(within(panel).getByRole("status", { name: "엔진 목록을 읽는 중" })).toBeTruthy();
  });
});
