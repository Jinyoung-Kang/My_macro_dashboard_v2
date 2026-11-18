/**
 * QA-748 — 모의 결정 상세·주간 복기 상세의 접기 머리(`<details><summary>`)가 좁은 화면(lg 미만)에서 44px 누름 자리가 아님(진행 기록 넘긴 항목
 * `touch-targets-lt-lg-missed-by-qa458`의 '결정 summary' 몫).
 *
 * 결정 기록 원본(JSON)·모델 응답 원문·입력 패킷(JSON)·한국 후보 표 보기·사건 패킷 글(제목), 복기 입력·복기 응답(JSON)의 summary가 글 높이(12px 글 —
 * 약 16px)뿐이라 손가락으로 누르기 어렵습니다(원칙 A8). jsdom은 배치를 재지 않으므로 공용 누름 자리 감사(lib/__tests__/touchTargetAudit
 * `smallTargets` — 클래스로 lg 미만 44px을 따짐)로 상세 안의 summary만 봅니다(종목 글 단추 등 다른 조작은 다른 결함 번호 몫).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { smallTargets } from "@/lib/__tests__/touchTargetAudit";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  LineChart: () => null,
  MultiLineSeries: () => null,
  DonutChart: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50, nav: 100000, equityValue: 99950, exposurePct: 99.95, returnPct: 0,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: null, benchmark: null, ...over,
  };
}

function overview(books: unknown[], over: Record<string, unknown> = {}) {
  return {
    available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], books,
    navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null, ...over,
  };
}

function decision(id: number, bookCode: string, over: Record<string, unknown> = {}) {
  return {
    id, book: bookCode, asOfTradingDate: "2026-10-26", kind: "SCHEDULED", status: "FORMAT_ERROR", decidedAtKst: "2026-10-27 07:41",
    model: "claude-sonnet-5-5", frameworkVersion: 3, settingsVersion: 2, selectionAsOf: null, targetExposurePct: null,
    summary: "응답 형식 오류", orderCount: 0, rejectedCount: 0, pricesFinal: true, error: "orders[0].ticker: 패턴과 다릅니다", ...over,
  };
}

/** 경로(정확히 일치) → 응답. 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => cleanup());

/** 결정 하나의 상세를 엽니다 — 고치기 전 표의 '상세 펼치기' 또는 시각순 목록의 줄 단추(data-item-key = 결정 번호). */
async function openDecision(id: number, name: string): Promise<HTMLElement> {
  await waitFor(() => expect(document.querySelector(`button[data-item-key="${id}"]`)).not.toBeNull());
  fireEvent.click(document.querySelector<HTMLButtonElement>(`button[data-item-key="${id}"]`)!);
  return screen.findByRole("region", { name: `${name} 상세` });
}

/** 상세 안의 summary 가운데 lg 미만 44px이 아닌 것. */
const smallSummaries = (root: HTMLElement) => smallTargets(root).filter((entry) => entry.startsWith("summary"));

describe("QA-748 결정·복기 상세의 접기 머리는 좁은 화면에서 44px 누름 자리", () => {
  it("미국 Claude 결정 상세 — 결정 기록 원본·모델 응답 원문·입력 패킷", async () => {
    const row = decision(22, "claude");
    reads["/api/paper/overview"] = overview([book("rules", { kind: "RULES", label: "규칙 계좌" }), book("claude", { kind: "CLAUDE", label: "Claude 계좌" })]);
    reads["/api/paper/decisions?book=rules&limit=50"] = { available: true, decisions: [] };
    reads["/api/paper/decisions?book=claude&limit=50"] = { available: true, decisions: [row] };
    reads["/api/paper/status"] = { available: false };
    reads["/api/paper/decisions/22"] = {
      available: true, orders: [],
      decision: { ...row, packet: { a: 1 }, packetHash: null, usage: null, noteIds: null, latencyMs: 30_000, retryCount: 0,
        response: { kind: "SCHEDULED", note: "원본" }, responseRaw: "{\"orders\": [{\"ticker\": \"brk b\"}]}" },
    };
    render(<PaperPage initialTab="decisions" market="US" />);
    fireEvent.change(await screen.findByLabelText("계좌 고르기"), { target: { value: "claude" } });

    const detail = await openDecision(22, "2026-10-26 정기");
    expect(detail.querySelectorAll("summary")).toHaveLength(3);
    expect(smallSummaries(detail)).toEqual([]);
    // 머리는 브라우저 삼각형 대신 공용 아래 화살표(펼치면 뒤집힘), 처음에는 접힘.
    for (const summary of detail.querySelectorAll("summary")) {
      expect(summary.className).toContain("list-none");
      expect(summary.querySelector("svg")?.getAttribute("class")).toContain("group-open:rotate-180");
      expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    }
  });

  it("한국 결정 상세 — 후보 표 보기(규칙 계좌)·사건 패킷 글(Claude 계좌)", async () => {
    window.history.replaceState(null, "", "/paper/kr/decisions");
    reads["/api/paper/overview?market=KR"] = overview(
      [book("kr_rules", { kind: "RULES", label: "한국 규칙 계좌" }), book("kr_claude", { kind: "CLAUDE", label: "한국 Claude 계좌" })],
      { market: "KR", currency: "KRW", dormantReason: null },
    );
    const rules = decision(41, "kr_rules", { status: "OK", model: null, frameworkVersion: null, error: null });
    reads["/api/paper/decisions?book=kr_rules&limit=50"] = { available: true, decisions: [rules] };
    reads["/api/paper/decisions/41"] = {
      available: true, orders: [],
      decision: { ...rules, packet: null, packetHash: null, usage: null, noteIds: [], latencyMs: null, retryCount: 0,
        response: { book: "kr_rules", kind: "SCHEDULED", selectionDay: true, gates: [],
          selection: { maxNames: 12, weighting: "EQUAL", candidates: [{ code: "005930", universeRank: 1, score: 0.0123 }], exclusionCounts: {},
            targets: [], notChosen: [], stockWeightPct: 80, parkingWeightPct: 20 },
          holdings: [], orders: [], skipped: [], notes: [], settings: {} } },
    };
    const claude = decision(50, "kr_claude", { status: "OK", error: null });
    reads["/api/paper/decisions?book=kr_claude&limit=50"] = { available: true, decisions: [claude] };
    reads["/api/paper/decisions/50"] = {
      available: true, orders: [],
      decision: { ...claude, packetHash: null, usage: null, noteIds: [], latencyMs: 1000, retryCount: 0,
        response: { stance: "NEUTRAL", targetEquityExposurePct: 60, summary: "관망", exposureRationale: "근거", orders: [], validation: [] },
        packet: { "11b_events": { window: { from: "2026-10-25T22:30:00+09:00", to: "2026-10-26T22:30:00+09:00" }, timeNote: null,
          text: "<<사건 #1 시작>> 제목 <<사건 #1 끝>>", items: [] } } },
    };
    render(<PaperPage initialTab="decisions" market="KR" />);

    const rulesDetail = await openDecision(41, "2026-10-26 정기");
    expect(rulesDetail.querySelectorAll("summary").length).toBeGreaterThanOrEqual(1);
    const rulesSmall = smallSummaries(rulesDetail);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("region", { name: "2026-10-26 정기 상세" })).toBeNull());

    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "kr_claude" } });
    const claudeDetail = await openDecision(50, "2026-10-26 정기");
    expect(claudeDetail.querySelectorAll("summary").length).toBeGreaterThanOrEqual(1);
    expect([...rulesSmall, ...smallSummaries(claudeDetail)]).toEqual([]);
  });

  it("주간 복기 상세 — 복기 입력·복기 응답(JSON)", async () => {
    reads["/api/paper/overview"] = overview([book("rules", { kind: "RULES", label: "규칙 계좌" }), book("claude", { kind: "CLAUDE", label: "Claude 계좌" })]);
    reads["/api/paper/decisions?book=rules&limit=50"] = { available: true, decisions: [] };
    const week = {
      weekEnding: "2026-10-30", status: "OK", windowWeeks: 4, model: "claude-sonnet-5-5", verdictCounts: { 유지: 1, 반증: 0, 판단불가: 0 },
      proposalId: null, proposalStatus: null, createdAtKst: "2026-10-31 09:05", error: null, retryCount: 0, retryable: false, frameworkVersion: 1,
    };
    reads["/api/paper/reviews"] = { available: true, latestWeekEnding: "2026-10-30", reviews: [week] };
    reads["/api/paper/reviews/2026-10-30"] = {
      available: true,
      review: { ...week, trimmedReason: null, verdicts: [], missingDecisionIds: [], recurringErrors: [], keep: [], proposal: null,
        input: { weekEnding: "2026-10-30" }, response: { schemaVersion: 1 }, usage: null },
    };
    render(<PaperPage initialTab="decisions" market="US" />);
    fireEvent.click(await screen.findByRole("button", { name: "주간 복기" }));

    // 복기 한 건 — 고치기 전은 목록 아래 칸, 시각순 목록으로 바꾼 뒤는 그 주 줄 단추로 여는 검사 칸(좁은 배치 — 대화상자).
    await waitFor(() => {
      const ready = screen.queryByRole("region", { name: "2026-10-30 주 복기" }) !== null || document.querySelector('button[data-item-key*="2026-10-30"]') !== null;
      expect(ready).toBe(true);
    });
    if (screen.queryByRole("region", { name: "2026-10-30 주 복기" }) === null) {
      fireEvent.click(document.querySelector<HTMLButtonElement>('button[data-item-key*="2026-10-30"]')!);
    }
    const body = await screen.findByRole("region", { name: "2026-10-30 주 복기" });
    await waitFor(() => expect(body.querySelectorAll("summary")).toHaveLength(2));
    expect(smallSummaries(body)).toEqual([]);
  });
});
