/**
 * QA-970(작업대 P8 후속 검토 — 사용자 승인 범위 '읽는 중 자리표시만'): QA-964가 한국 실제 계좌 탭에 둔 큰 자리표시(개요를 읽는 동안의 탭 줄 꼴 자리,
 * 실제 계좌를 읽는 동안의 요약 카드 꼴 자리)가 읽기가 실패한 뒤 '다시 시도'로 다시 읽는 동안에도 다시 나와, 오류 상자와 번갈아 높이가 오르내렸습니다.
 * 같은 갈래의 보유·결정 자리는 실패 뒤에는 한 줄입니다(hooks/useApi `firstLoadPending` — QA-655·895 규약).
 *
 * 기대: 처음 읽는 동안(값도 앞선 실패도 없음)만 큰 자리표시, 실패 뒤 다시 읽는 동안은 예전 읽는 중 한 줄. 요청 경로·끄기 단추·쓰기는 그대로입니다
 * (realTradeScreen·경계 시험). 값은 모두 합성 값입니다(실제 계좌 자료 아님).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));
vi.mock("next/navigation", () => ({ usePathname: () => null }));

import PaperScreen from "@/components/screens/paper/PaperScreen";

/** 이 경로로 시작하는 읽기는 처음 한 번 실패하고, 그 뒤(다시 시도)는 끝나지 않음. 그 밖의 읽기는 모두 끝나지 않음. */
function failOnceThenPending(prefix: string, message: string) {
  let failed = false;
  api.apiGetShared.mockImplementation((path: string) => {
    if (String(path).startsWith(prefix) && !failed) {
      failed = true;
      return Promise.reject(new Error(message));
    }
    return new Promise(() => {});
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/kr/real");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QA-970 실패 뒤 다시 읽는 동안은 큰 자리표시 대신 한 줄", () => {
  // 수정 전(재현 커밋에서는 it.fails): 다시 시도로 다시 읽는 동안 요약 카드 꼴 자리(타일 다섯)가 다시 나왔습니다.
  it.fails("실제 계좌 — 실패 뒤 다시 시도하는 동안 요약 카드 꼴 자리 없이 읽는 중 한 줄", async () => {
    failOnceThenPending("/api/brokerage/account", "실제 계좌 응답 500");
    render(<PaperScreen market="KR" initialTab="real" />);
    expect(document.querySelector('[data-pending="summary"]')).not.toBeNull();   // 처음 읽는 동안은 큰 자리(QA-964 그대로)
    expect(await screen.findByText(/실제 계좌를 읽지 못했습니다 — 실제 계좌 응답 500/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "다시 시도" })));
    expect(screen.queryByText(/실제 계좌를 읽지 못했습니다/)).toBeNull();
    expect(screen.getByText("실제 계좌를 읽는 중…")).toBeTruthy();
    expect(document.querySelector('[data-pending="summary"]')).toBeNull();
  });

  // 수정 전(재현 커밋에서는 it.fails): 개요를 다시 읽는 동안 탭 줄 꼴 자리가 다시 나왔습니다.
  it.fails("모의 개요 — 실패 뒤 다시 시도하는 동안 탭 줄 꼴 자리 없이 '장부를 읽는 중…' 한 줄", async () => {
    failOnceThenPending("/api/paper/overview", "개요 응답 500");
    render(<PaperScreen market="KR" initialTab="real" />);
    expect(screen.getByRole("status", { name: "장부를 읽는 중" })).toBeTruthy();   // 처음 읽는 동안은 탭 줄 꼴 자리(QA-964 그대로)
    expect(await screen.findByText("개요 응답 500")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "다시 시도" })));
    expect(screen.queryByText("개요 응답 500")).toBeNull();
    expect(screen.getByText("장부를 읽는 중…")).toBeTruthy();
    expect(screen.queryByRole("status", { name: "장부를 읽는 중" })).toBeNull();
  });
});
