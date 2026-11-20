/**
 * QA-813 — 결정 로그 머리 '지금 결정 실행'(작업대 P6 — 머리 둘째 줄로 옮김)의 결과·오류 알림 영역이 '결정' 패널의 긴 계좌 설명(약 400자)·결정 창·장중 판단
 * 계획 아래에 남아, 좁은 화면에서는 단추를 누른 첫 화면 밖에 떴습니다(D5 전 QA 스택 390x844 규칙 계좌: 머리 동작 y 266~310, 알림 861~932 — 아래 탭
 * 막대가 780~844를 덮음, 포커스는 머리로 돌아와 스크롤이 그대로라 보이는 반응 없음). 개편 전에는 단추와 결과가 같은 카드의 첫 줄 근처였습니다.
 * 알림 영역은 '결정' 패널 본문의 맨 앞(설명 글보다 먼저)에 있어야 합니다. jsdom은 배치를 재지 않아 문서 차례로 봅니다. 값은 모두 합성 값입니다.
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

import { DecisionsSection } from "@/components/screens/paper/DecisionsSection";
import { decisionBookNote } from "@/lib/paper";
import type { PaperBookSummary } from "@/lib/types";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };
const RULES = {
  code: "rules", kind: "RULES", label: "규칙 계좌", status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
  cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05, lastObservedAtKst: "2026-10-24 05:15",
  positions: 1, staleCount: 0, stats: STATS, benchmark: "bench_spy",
} as unknown as PaperBookSummary;

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path.startsWith("/api/paper/decisions?book=rules") ? Promise.resolve({ available: true, decisions: [] }) : new Promise(() => {}),
  );
});

afterEach(() => cleanup());

describe("QA-813 — '지금 결정 실행'의 결과 알림은 '결정' 패널 본문 맨 앞", () => {
  it("결과 글이 든 알림 영역이 계좌 설명 글보다 앞(문서 차례)", async () => {
    api.apiPost.mockRejectedValue(new Error("합성 오류 — 결정을 실행하지 못했습니다"));
    render(<DecisionsSection books={[RULES]} onChanged={() => {}} />);
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "지금 결정 실행" }));
    });
    const status = (await screen.findByText("합성 오류 — 결정을 실행하지 못했습니다")).closest('[role="status"]') as HTMLElement;
    const note = screen.getByText(decisionBookNote("RULES", "rules"));
    expect(status).not.toBeNull();
    expect(status.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
