/**
 * QA-969(작업대 P8 후속 검토 — 사용자 승인 범위 '읽는 중 자리표시만'): 실제 매매 상태를 처음 읽는 동안 칸 안의 큰 자리표시(QA-964 — 약 620px)가 끄기 결과
 * 안내(ActionFeedback)보다 앞에 있어, 읽는 중에도 보이는 카드 머리 '실제 매매 끄기'를 누른 뒤의 성공 안내(role=status)와 실패 위험 배너('실제 매매를 끄지
 * 못했습니다 … 다시 누르세요'와 비상 순서)가 자리표시 아래로 밀려 좁은 화면에서 첫 화면 밖에 그려질 수 있었습니다(QA-964 전에는 읽는 중 글 한 줄 바로 아래).
 *
 * 기대: 끄기 결과 안내는 값이 온 뒤의 순서처럼 카드 머리 바로 아래(자리표시보다 앞)이고, 자리표시(타일 셋·표 둘 — QA-964의 첫 적재 이동 개선)는 그대로
 * 남습니다. 실패 배너는 알림 영역(role=alert) 안에 그려 낭독됩니다(글·쓰기 그대로). 요청 경로·끄기 단추·쓰기는 그대로입니다(realTradeScreen·경계 시험).
 * 값은 모두 합성 값입니다(실제 계좌 자료 아님).
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/kr/real");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  // 모든 읽기(개요·실제 매매 상태·실제 계좌)가 끝나지 않음 — 상태를 처음 읽는 중.
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** a가 문서 순서에서 b보다 앞인가. */
const precedes = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

function pendingShapeKept(region: HTMLElement) {
  expect(within(region).getByText("실제 매매 상태를 읽는 중…")).toBeTruthy();
  expect(region.querySelectorAll('[aria-hidden="true"] [data-pending="tile"]')).toHaveLength(3);
  expect(region.querySelectorAll('[aria-hidden="true"] [data-pending="table"]')).toHaveLength(2);
}

describe("QA-969 상태를 읽는 동안 끄기 결과 안내는 자리표시보다 앞", () => {
  // 수정 전(재현 커밋에서는 it.fails): 실패 배너가 자리표시(타일·표) 뒤에 그려졌고 알림 영역 밖이었습니다.
  it("끄기가 실패하면 위험 배너(알림 영역)가 자리표시 앞 — 자리표시는 그대로", async () => {
    api.apiPost.mockRejectedValue(new Error("요청 실패 (HTTP 500)"));
    render(<PaperScreen market="KR" initialTab="real" />);
    const region = screen.getByRole("region", { name: "실제 매매" });
    fireEvent.click(within(region).getByRole("button", { name: "실제 매매 끄기" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/realtrade/disable", { market: "KR" }, { timeoutMs: 20_000 }));

    const banner = await within(region).findByText(/실제 매매를 끄지 못했습니다 — 요청 실패 \(HTTP 500\)/);
    const tile = region.querySelector('[data-pending="tile"]');
    expect(tile).not.toBeNull();
    expect(precedes(banner, tile!)).toBe(true);
    expect(precedes(banner, within(region).getByText("실제 매매 상태를 읽는 중…"))).toBe(true);
    const alert = within(region).getByRole("alert");
    expect(alert.textContent).toContain("실제 매매를 끄지 못했습니다 — 요청 실패 (HTTP 500). 끄기 단추를 다시 누르세요.");
    expect(alert.textContent).toContain("POST /api/realtrade/disable");
    pendingShapeKept(region);
  });

  // 수정 전(재현 커밋에서는 it.fails): 성공 안내(role=status)도 자리표시 뒤였습니다.
  it("끄기가 받아들여지면 성공 안내(role=status)가 자리표시 앞 — 자리표시는 그대로", async () => {
    api.apiPost.mockResolvedValue({ ok: true, version: 4 });
    render(<PaperScreen market="KR" initialTab="real" />);
    const region = screen.getByRole("region", { name: "실제 매매" });
    fireEvent.click(within(region).getByRole("button", { name: "실제 매매 끄기" }));

    const notice = await within(region).findByText("새 주문 멈춤 — 이 기능의 미체결 주문 취소 중");
    const tile = region.querySelector('[data-pending="tile"]');
    expect(tile).not.toBeNull();
    expect(precedes(notice, tile!)).toBe(true);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    pendingShapeKept(region);
  });

  // 끄기를 누르지 않은 첫 적재는 QA-964 그대로(자리표시만, 안내 없음) — 고친 뒤에도 통과해야 하는 지킴 시험.
  it("끄기를 누르지 않았으면 안내 없이 자리표시만(QA-964 그대로)", () => {
    render(<PaperScreen market="KR" initialTab="real" />);
    const region = screen.getByRole("region", { name: "실제 매매" });
    pendingShapeKept(region);
    expect(within(region).queryByRole("alert")).toBeNull();
    expect(within(region).queryByText(/끄지 못했습니다/)).toBeNull();
  });
});
