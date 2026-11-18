/**
 * QA-771 — 결정 로그 '지금 결정 실행'(작업대 P6 — 화면 머리 동작으로 옮김)의 결과·오류가 알림 영역(role=status) 밖에 그려지고, 확인 상자 없이 바로 도는
 * 규칙 계좌 길은 실행 중 단추가 막히며 잃은 포커스를 끝난 뒤 되돌리지 않던 결함. 단추와 결과 글이 떨어져(머리 ↔ '결정' 패널) 낭독기 사용자는 비용이 드는
 * 쓰기의 성공·실패를 듣지 못했습니다(같은 이유로 보유·체결 탭은 늘 그려 둔 role=status 영역에 결과를 둠). 값은 모두 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { DecisionsSection } from "@/components/screens/paper/DecisionsSection";
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

describe("QA-771 — 머리 '지금 결정 실행'의 결과는 알림 영역 안, 끝나면 그 단추로 포커스", () => {
  it.fails("규칙 계좌 — 결과 글이 role=status 영역 안이고, 끝난 뒤 포커스가 '지금 결정 실행'으로 돌아온다", async () => {
    let finish: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    render(<DecisionsSection books={[RULES]} onChanged={() => {}} />);
    const run = await screen.findByRole("button", { name: "지금 결정 실행" });
    run.focus();
    fireEvent.click(run);
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/decision", { book: "rules" });
    expect((run as HTMLButtonElement).disabled).toBe(true);
    // 크롬은 포커스가 있던 단추가 막히면 포커스를 문서(body)로 놓습니다 — jsdom은 그러지 않고 막힌 단추의 blur()도 받지 않아, 잠깐 둔 입력칸에
    // 포커스를 옮겼다가 지워 포커스를 문서로 떨어뜨립니다.
    act(() => {
      const spare = document.createElement("input");
      document.body.appendChild(spare);
      spare.focus();
      spare.remove();
    });
    expect(document.activeElement).toBe(document.body);
    await act(async () => {
      finish({
        ok: true,
        decision: { id: 9, asOfTradingDate: "2026-10-23", kind: "MANUAL", status: "NO_TRADE", orderCount: 0, summary: "매도 신호 없음", error: null },
      });
    });
    const result = await screen.findByText(/2026-10-23 수동 결정 — 주문 없음/);
    expect(result.closest('[role="status"]')).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "지금 결정 실행" })));
  });

  it.fails("실패하면 서버 문구가 role=status 영역 안", async () => {
    api.apiPost.mockRejectedValue(new Error("선정이 없습니다 — 규칙 계좌를 먼저 시작하세요."));
    render(<DecisionsSection books={[RULES]} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "지금 결정 실행" }));
    const warning = await screen.findByText("선정이 없습니다 — 규칙 계좌를 먼저 시작하세요.");
    expect(warning.closest('[role="status"]')).not.toBeNull();
  });
});
