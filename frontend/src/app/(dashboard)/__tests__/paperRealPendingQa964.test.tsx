/**
 * QA-964(작업대 P8 후속 — 사용자 승인 범위 '읽는 중 자리표시만'): 한국 실제 계좌 탭(/paper/kr/real)을 처음 열면 개요·실제 매매 상태·실제 계좌가 오기 전의
 * 자리표시가 값이 온 뒤보다 훨씬 낮아 첫 적재 이동(CLS)이 컸습니다 — 기준 빌드(40a8b4cf, QA API GET 300ms 지연, QA 자료) 390 0.5343·1024 0.3269·1440 0.2232.
 *  - 개요를 읽는 중 글(68px)이 개요가 오면 탭 줄(45·31px)로 바뀜 — 아래 실제 매매 칸이 위로 37px
 *  - 실제 매매 칸의 읽는 중 글 한 줄(68px)이 상태가 오면 칸 내용(상태 줄·타일 셋·오늘 창·주문 표·이벤트 표·주의 글 — 약 620px)으로 자라 아래 실제 계좌 조회를 밈
 *  - 실제 계좌의 읽는 중 글 한 줄 → 요약 카드(타일 다섯)·표
 * 자리표시는 값이 온 뒤의 꼴(같은 칸·같은 글줄 높이)이어야 합니다. jsdom은 배치를 계산하지 않으므로 자리표시의 꼴(칸 수·탭 줄과 같은 클래스)을 봅니다.
 * 요청 경로·켜기/끄기 단추·쓰기 경로는 그대로입니다(realTradeScreen·경계 시험 셋이 지킴). 값은 모두 합성 값입니다(실제 계좌 자료 아님).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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
import { underlineTabClasses } from "@/components/ui";

beforeEach(() => {
  window.history.replaceState(null, "", "/paper/kr/real");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  // 모든 읽기가 끝나지 않음 — 첫 적재의 읽는 중 상태.
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QA-964 한국 실제 계좌 탭의 읽는 중 자리표시는 값이 온 뒤의 꼴", () => {
  // 수정 전(재현 커밋에서는 it.fails): 개요를 읽는 동안은 읽는 중 글 하나('장부를 읽는 중…' — 상태 역할 없음)였습니다.
  it("개요를 읽는 동안 탭 줄과 같은 높이(공용 밑줄 탭 sm 클래스)의 자리 — 탭 줄(tablist)은 개요가 온 뒤에만", () => {
    render(<PaperScreen market="KR" initialTab="real" />);
    const slot = screen.getByRole("status", { name: "장부를 읽는 중" });
    const tabs = Array.from(slot.children).filter((child) => child.getAttribute("aria-hidden") === "true");
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs) expect(tab.className).toBe(underlineTabClasses(false, "sm"));
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  // 수정 전(재현 커밋에서는 it.fails): 실제 매매 칸은 읽는 중 글 하나뿐이었습니다(자리 칸 0).
  it("실제 매매 상태를 읽는 동안 칸 안에 읽는 중 글과 값이 온 뒤의 꼴(타일 셋·표 둘 — 읽기에서 빠짐), 끄기 단추는 그대로", () => {
    render(<PaperScreen market="KR" initialTab="real" />);
    const region = screen.getByRole("region", { name: "실제 매매" });
    expect(within(region).getByText("실제 매매 상태를 읽는 중…")).toBeTruthy();
    expect(region.querySelectorAll('[aria-hidden="true"] [data-pending="tile"]')).toHaveLength(3);
    expect(region.querySelectorAll('[aria-hidden="true"] [data-pending="table"]')).toHaveLength(2);
    expect(within(region).getByRole("button", { name: "실제 매매 끄기" })).toBeTruthy();
  });

  // 수정 전(재현 커밋에서는 it.fails): 실제 계좌는 읽는 중 글 하나뿐이었습니다.
  it("실제 계좌를 읽는 동안 읽는 중 글과 요약 카드 꼴(타일 다섯 — 읽기에서 빠지고 숫자·종목 없음)", () => {
    render(<PaperScreen market="KR" initialTab="real" />);
    expect(screen.getByText("실제 계좌를 읽는 중…")).toBeTruthy();
    const card = document.querySelector('[data-pending="summary"]');
    expect(card?.getAttribute("aria-hidden")).toBe("true");
    expect(card?.querySelectorAll('[data-pending="tile"]')).toHaveLength(5);
    expect(card?.textContent).toBe("");
  });
});
