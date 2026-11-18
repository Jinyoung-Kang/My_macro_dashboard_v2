/**
 * QA-773 — 개요 탭 Claude 계좌 시작 카드의 미리보기 결과 '입력 패킷(JSON)' 접기 머리(`<summary>`)가 좁은 화면(lg 미만)에서 44px 누름 자리가 아님.
 * QA-748(결정·복기 상세의 접기 머리)과 같은 꼴이 이 카드에 남았습니다 — summary가 'cursor-pointer text-text-3'뿐이라 12px 글 높이(약 16px)입니다.
 * 개편 전부터 있었고(작업대 P6 검토 지적), 통합 감사는 QA 자료가 Claude 계좌 시작 뒤라 이 카드를 그리지 않아 잡지 못했습니다. jsdom은 배치를 재지 않으므로
 * 공용 누름 자리 감사(lib/__tests__/touchTargetAudit `smallTargets` — 클래스로 lg 미만 44px을 따짐)로 봅니다. 값은 모두 합성 값입니다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { smallTargets } from "@/lib/__tests__/touchTargetAudit";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { ClaudeStartSection } from "@/components/screens/paper/ClaudeStartSection";
import type { PaperOverviewResponse } from "@/lib/types";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [],
  books: [
    book("rules", { kind: "RULES", label: "규칙 계좌", benchmark: "bench_spy" }),
    book("claude", { kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null, benchmark: "bench_spy", positions: 0 }),
  ],
  navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
} as unknown as PaperOverviewResponse;

beforeEach(() => {
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => cleanup());

describe("QA-773 — Claude 시작 카드의 '입력 패킷(JSON)' 접기 머리는 좁은 화면 44px", () => {
  it("미리보기 결과의 접기 머리가 lg 미만 44px 누름 자리", async () => {
    api.apiPost.mockResolvedValue({
      ok: true, preview: true, model: "claude-sonnet-5-5", packet: { "1_asOf": "2026-10-23" },
      response: { schemaVersion: 2, orders: [] }, validation: null, usage: null,
    });
    render(<ClaudeStartSection overview={OVERVIEW} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "미리보기" }));
    fireEvent.click(screen.getByRole("button", { name: "미리보기 확인" }));
    const result = await screen.findByRole("region", { name: "미리보기 결과" });
    expect(result.querySelectorAll("summary")).toHaveLength(1);
    expect(smallTargets(result).filter((entry) => entry.startsWith("summary"))).toEqual([]);
  });
});
