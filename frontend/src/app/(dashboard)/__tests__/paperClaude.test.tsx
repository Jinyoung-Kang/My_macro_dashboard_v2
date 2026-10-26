/**
 * 🧪 모의 매매 — Claude 재량 책(단계 3a). 서버 값을 그대로 보이고, 통과·거절·어긋남을 화면이 다시 판정하지 않는다.
 *
 *  - 결정 로그: Claude 책 목록에 목표 노출 칸, 상세는 판단(자세·목표 노출·어긋남 배지·확신도·요약·노출 근거)·제안 주문(근거·라벨·
 *    무효화)·검증(통과·거절·사유·설명)·사용량(모델·토큰)·프레임 판("임시 v0")·입력 패킷(접힘). 규칙 책 표(신호·게이트)는 그리지 않는다
 *  - 응답이 없으면(형식 오류) "응답 없음"과 오류, 모델 원문은 접어서. 건너뛴 기록(호출 상한·일시정지)은 "Claude를 부르지 않음 — 사유"
 *  - 결정 중 일시정지로 취소된 주문은 취소와 서버 사유로, 다른 결정이 돌고 있다는 서버 거절은 경고로
 *  - Claude 책의 '지금 결정 실행'은 비용 안내와 함께 확인 단계를 거친다
 *  - 개요: Claude 책이 시작 전이면 시작 카드(지금 판 안내 — 임시 v0이면 OS 원문으로 v1을 만든 뒤 시작 권고·비용), 미리보기·시작 모두 확인 단계 →
 *    POST /api/paper/run/initial-decision {book:"claude", preview:true} / {book:"claude"}
 *  - 개요: Claude 노출 추이(목표 vs 실제, 0~100% 축), 기록이 없으면 그렇다고
 *  - 개요: Claude 호출 사용량(오늘 호출/상한·추정 비용·토큰, 이달 누적 — 상태 응답 그대로), 일시정지 중인 Claude 책은 수동 결정을 막음
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 recharts가 크기 0이라 아무것도 그리지 않습니다 — 노출 차트만 계열 이름·행 수·축 범위를 목록으로 그립니다.
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: ({ data, series, domain }: { data: unknown[]; series: { key: string; name: string }[]; domain?: number[] }) =>
    series.some((entry) => entry.key === "target") ? (
      <ul aria-label="노출 계열" data-rows={data.length} data-domain={domain?.join("~")}>
        {series.map((entry) => <li key={entry.key}>{entry.name}</li>)}
      </ul>
    ) : null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const RULES = book("rules", { kind: "RULES", label: "규칙 계좌", benchmark: "bench_spy" });
const CLAUDE_ACTIVE = book("claude", { kind: "CLAUDE", label: "Claude 계좌", benchmark: "bench_spy" });
const CLAUDE_NOT_STARTED = book("claude", {
  kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null, benchmark: "bench_spy", positions: 0,
});

function overview(claude: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [],
    books: [RULES, claude, book("bench_spy", { label: "SPY 계좌" }), book("bench_mix", { label: "60/40 계좌" })],
    navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
    ...over,
  };
}

function decision(id: number, over: Record<string, unknown> = {}) {
  return {
    id, book: "claude", asOfTradingDate: "2026-10-26", kind: "SCHEDULED", status: "OK", decidedAtKst: "2026-10-27 07:41",
    model: "claude-sonnet-5-5", frameworkVersion: null, settingsVersion: 2, selectionAsOf: null, targetExposurePct: 35,
    summary: "노출 35% · XLV 매수", orderCount: 2, rejectedCount: 1, pricesFinal: true, error: null, ...over,
  };
}

/** Claude 책 결정 기록 — 모델 응답(decision.schema.json) + 검증 결과(자바 record 그대로). */
const RESPONSE = {
  schemaVersion: 2,
  framework: { version: 0, status: "INTERIM", title: "임시 v0 — OS 원문 반영 전" },
  stance: "RISK_OFF",
  targetEquityExposurePct: 35,
  exposureRationale: "할인율·비용 물가 두 축이 압박",
  summary: "노출을 35%로 낮추고 방어 섹터 일부만",
  orders: [
    {
      ticker: "XLV", side: "BUY", targetWeightPct: 12, sellFraction: null, timing: "NEXT_CLOSE",
      thesis: "방어 섹터 상대 강도 개선", labels: ["사실", "해석"], invalidation: "200일선 아래로",
    },
    {
      ticker: "NVDA", side: "BUY", targetWeightPct: 15, sellFraction: null, timing: "NEXT_OBSERVATION",
      thesis: "교차 확인 2곳", labels: ["가설"], invalidation: "다음 13F에서 축소",
    },
  ],
  noTradeReason: null,
  watchlist: [{ ticker: "TLT", condition: "10Y 4.75% 아래로 3일" }],
  confidence: 0.62,
  validation: [
    { order: { ticker: "XLV", side: "BUY", targetWeightPct: 12, sellFraction: null, timing: "NEXT_CLOSE" }, accepted: true, rejectReason: null, detail: null },
    {
      order: { ticker: "NVDA", side: "BUY", targetWeightPct: 15, sellFraction: null, timing: "NEXT_OBSERVATION" },
      accepted: false, rejectReason: "WEIGHT_CAP", detail: "목표 15% > 종목 상한 10%",
    },
  ],
};

const DETAIL = {
  available: true,
  decision: {
    ...decision(21),
    packet: { "0_instructions": "아래 자료만으로 판단", "12_hardRules": "현금 비중 상·하한은 없다" },
    packetHash: "abcdef0123456789",
    response: RESPONSE,
    usage: { inputTokens: 24512, outputTokens: 3120, cacheReadTokens: 0, cacheWriteTokens: 8100 },
    noteIds: [], latencyMs: 41_200, retryCount: 0,
    exposureMismatch: true,
  },
  orders: [
    {
      id: 51, ticker: "XLV", side: "BUY", qty: null, targetWeightPct: 12, sellFraction: null, timing: "NEXT_CLOSE", source: "CLAUDE",
      status: "PENDING", rejectReason: null,
      reason: { thesis: "방어 섹터 상대 강도 개선", labels: ["사실", "해석"], invalidation: "200일선 아래로" },
      asOfTradingDate: "2026-10-26", createdAtKst: "2026-10-27 07:41", expiresOn: "2026-10-28", filledAtKst: null,
    },
    {
      id: 52, ticker: "NVDA", side: "BUY", qty: null, targetWeightPct: 15, sellFraction: null, timing: "NEXT_OBSERVATION", source: "CLAUDE",
      status: "REJECTED", rejectReason: "WEIGHT_CAP",
      reason: { thesis: "교차 확인 2곳", labels: ["가설"], invalidation: "다음 13F에서 축소" },
      asOfTradingDate: "2026-10-26", createdAtKst: "2026-10-27 07:41", expiresOn: null, filledAtKst: null,
    },
  ],
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {};
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

const rowsOf = (region: HTMLElement) =>
  within(region).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell").map((td) => td.textContent));

async function openClaudeDecisions() {
  render(<PaperPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "결정 로그" }));
  fireEvent.change(await screen.findByLabelText("계좌 고르기"), { target: { value: "claude" } });
}

describe("결정 로그 — Claude 책", () => {
  beforeEach(() => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/decisions?book=rules"] = () => Promise.resolve({ available: true, decisions: [] });
    reads["/api/paper/decisions?book=claude"] = () => Promise.resolve({ available: true, decisions: [decision(21)] });
    reads["/api/paper/decisions/21"] = () => Promise.resolve(DETAIL);
  });

  it("목록에 목표 노출 칸, 상세는 판단·제안 주문·검증·사용량·프레임 판(임시 v0) — 규칙 책 표는 없다", async () => {
    await openClaudeDecisions();

    const row = await screen.findByRole("row", { name: "2026-10-26 정기" });
    expect(within(row).getAllByRole("cell").map((td) => td.textContent)).toEqual([
      "2026-10-26상세 펼치기", "정기", "주문 냄", "2건 · 거절 1", "35.0%", "노출 35% · XLV 매수", "확정 종가", "2026-10-27 07:41",
    ]);
    fireEvent.click(within(row).getByRole("button", { name: "상세 펼치기" }));

    const detail = await screen.findByRole("region", { name: "2026-10-26 정기 상세" });
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/decisions/21", 0);
    const meta = (label: string) => within(detail).getByText(label).nextElementSibling?.textContent;
    expect(meta("모델")).toBe("claude-sonnet-5-5");
    expect(meta("프레임 버전")).toBe("임시 v0");
    expect(within(detail).getByText("프레임 버전").nextElementSibling?.getAttribute("title")).toBe("임시 v0 — OS 원문 반영 전");
    expect(meta("소요")).toBe("41.2초");

    const judgement = within(detail).getByRole("region", { name: "판단" });
    expect(within(judgement).getByText("위험 회피 (RISK_OFF)")).toBeTruthy();
    expect(within(judgement).getByText("목표 주식 노출").nextElementSibling?.textContent).toBe("35.0%목표 노출 ≠ 주문");
    expect(within(judgement).getByText(/15%p 넘게 다릅니다/)).toBeTruthy();
    expect(within(judgement).getByText("확신도").nextElementSibling?.textContent).toBe("62.0%");
    expect(within(judgement).getByText("노출을 35%로 낮추고 방어 섹터 일부만")).toBeTruthy();
    expect(within(judgement).getByText("할인율·비용 물가 두 축이 압박")).toBeTruthy();

    expect(rowsOf(within(detail).getByRole("region", { name: "제안 주문 (모델 응답)" }))).toEqual([
      ["XLV", "매수", "목표 비중 12.00%", "다음 종가", "방어 섹터 상대 강도 개선", "사실해석", "200일선 아래로"],
      ["NVDA", "매수", "목표 비중 15.00%", "다음 관측치", "교차 확인 2곳", "가설", "다음 13F에서 축소"],
    ]);
    const validation = within(detail).getByRole("region", { name: "검증" });
    expect(within(validation).getByText(/현금 비중·매크로 조건은 검사하지 않습니다/)).toBeTruthy();
    expect(rowsOf(validation)).toEqual([
      ["XLV", "매수", "목표 비중 12.00%", "통과", "—", "—"],
      ["NVDA", "매수", "목표 비중 15.00%", "거절", "비중 상한 초과 (WEIGHT_CAP)", "목표 15% > 종목 상한 10%"],
    ]);
    expect(within(validation).getByText("비중 상한 초과 (WEIGHT_CAP)").getAttribute("title")).toContain("maxWeightStockPct");
    expect(rowsOf(within(detail).getByRole("region", { name: "관찰 목록" }))).toEqual([["TLT", "10Y 4.75% 아래로 3일"]]);

    const usage = within(detail).getByRole("region", { name: "사용량" });
    expect(within(usage).getByText("입력 토큰").nextElementSibling?.textContent).toBe("24,512");
    expect(within(usage).getByText("캐시 쓰기 토큰").nextElementSibling?.textContent).toBe("8,100");

    // 장부 주문 — 통과는 대기, 거절은 사유와 함께. 근거는 모델이 쓴 문장 그대로.
    const orders = rowsOf(within(detail).getByRole("region", { name: "주문" }));
    expect(orders.map((cells) => [cells[0], cells[3], cells[6]])).toEqual([
      ["XLV", "대기", "방어 섹터 상대 강도 개선 [사실·해석] · 무효화: 200일선 아래로"],
      ["NVDA", "거절WEIGHT_CAP", "교차 확인 2곳 [가설] · 무효화: 다음 13F에서 축소"],
    ]);
    // 크기 — 통과 매수는 살 금액, 거절 매수는 받은 값 그대로라 목표 비중(제안)으로
    expect(orders.map((cells) => cells[2])).toEqual(["순자산의 12.00% 매수", "목표 15.00% (제안)"]);

    // 규칙 책 표는 그리지 않고, 입력 패킷은 접어 둡니다.
    expect(within(detail).queryByRole("region", { name: "13F 신호 이벤트" })).toBeNull();
    expect(within(detail).queryByRole("region", { name: "게이트 (참고)" })).toBeNull();
    const packet = within(detail).getByText("입력 패킷(JSON)").closest("details") as HTMLDetailsElement;
    expect(packet.open).toBe(false);
    expect(packet.textContent).toContain("현금 비중 상·하한은 없다");
  });

  it("응답이 없으면(형식 오류) '응답 없음'과 오류 — 모델 원문은 접어서, 빈 제안 표는 그리지 않는다", async () => {
    reads["/api/paper/decisions?book=claude"] = () => Promise.resolve({
      available: true, decisions: [decision(22, { status: "FORMAT_ERROR", orderCount: 0, rejectedCount: 0, targetExposurePct: null, summary: null })],
    });
    reads["/api/paper/decisions/22"] = () => Promise.resolve({
      available: true,
      decision: {
        ...decision(22, { status: "FORMAT_ERROR", targetExposurePct: null, error: "orders[0].ticker: 패턴과 다릅니다" }),
        packet: { a: 1 }, packetHash: null, response: null, responseRaw: "{\"orders\": [{\"ticker\": \"brk b\"}]}",
        usage: { inputTokens: 24000, outputTokens: 900 }, noteIds: null, latencyMs: 30_000, retryCount: 0,
      },
      orders: [],
    });
    await openClaudeDecisions();
    fireEvent.click(within(await screen.findByRole("row", { name: "2026-10-26 정기" })).getByRole("button", { name: "상세 펼치기" }));

    const detail = await screen.findByRole("region", { name: "2026-10-26 정기 상세" });
    expect(within(detail).getByText("오류 — orders[0].ticker: 패턴과 다릅니다")).toBeTruthy();
    expect(within(detail).getByText(/검사한 모델 응답이 없습니다/)).toBeTruthy();
    expect(within(detail).queryByRole("region", { name: "제안 주문 (모델 응답)" })).toBeNull();
    expect(within(detail).queryByRole("region", { name: "검증" })).toBeNull();
    expect(within(detail).getByRole("region", { name: "사용량" })).toBeTruthy();
    const raw = within(detail).getByText("모델 응답 원문").closest("details") as HTMLDetailsElement;
    expect(raw.open).toBe(false);
    expect(raw.textContent).toContain("brk b");
  });

  it("건너뛴 기록(호출 상한)은 'Claude를 부르지 않음 — 서버 사유' — 형식 오류·거절·API 오류로 읽히지 않게", async () => {
    const cap = "일일 호출 상한(6회, KST 2026-10-27)에 닿아 Claude를 부르지 않았습니다 — 설정 apiDailyCallCap — 그날 재량 주문 없음";
    const skipped = { status: "SKIPPED", model: null, orderCount: 0, rejectedCount: 0, targetExposurePct: null, summary: cap };
    reads["/api/paper/decisions?book=claude"] = () => Promise.resolve({ available: true, decisions: [decision(24, skipped)] });
    // recordSkipped 모양 — 오류·사용량·패킷 없이 사유만(summary와 skipped)
    reads["/api/paper/decisions/24"] = () => Promise.resolve({
      available: true,
      decision: {
        ...decision(24, skipped),
        packet: null, packetHash: null, responseRaw: null,
        response: { summary: cap, book: "claude", kind: "SCHEDULED", asOfTradingDate: "2026-10-26", skipped: cap, settings: { apiDailyCallCap: 6 } },
        usage: null, noteIds: null, latencyMs: null, retryCount: 0,
      },
      orders: [],
    });
    await openClaudeDecisions();
    const row = await screen.findByRole("row", { name: "2026-10-26 정기" });
    expect(within(row).getByText("건너뜀")).toBeTruthy();
    fireEvent.click(within(row).getByRole("button", { name: "상세 펼치기" }));

    const detail = await screen.findByRole("region", { name: "2026-10-26 정기 상세" });
    const judgement = within(detail).getByRole("region", { name: "판단" });
    expect(within(judgement).getByText(`Claude를 부르지 않음 — ${cap}`)).toBeTruthy();
    expect(within(detail).queryByText(/응답 형식 오류·모델 거절·API 오류/)).toBeNull();
    expect(within(detail).queryByText(/^오류 —/)).toBeNull();
    expect(within(detail).queryByRole("region", { name: "제안 주문 (모델 응답)" })).toBeNull();
    expect(within(detail).queryByRole("region", { name: "사용량" })).toBeNull();
  });

  it("결정 중 일시정지된 기록 — 판단·검증은 그대로, 통과 주문은 취소와 서버 사유로(대기로 읽히지 않게), 패킷의 대기 주문은 접힌 JSON에", async () => {
    const pausedReason = "결정 중 일시정지 — 집행 안 함";
    reads["/api/paper/decisions/21"] = () => Promise.resolve({
      ...DETAIL,
      decision: {
        ...DETAIL.decision,
        packet: {
          "9_portfolio": {
            pendingOrders: [{ ticker: "XLE", side: "BUY", targetWeightPct: 8, timing: "NEXT_CLOSE", decisionKind: "SCHEDULED", expiresOn: "2026-10-29" }],
          },
        },
      },
      orders: [{ ...DETAIL.orders[0], status: "CANCELLED", rejectReason: pausedReason, expiresOn: null }, DETAIL.orders[1]],
    });
    await openClaudeDecisions();
    fireEvent.click(within(await screen.findByRole("row", { name: "2026-10-26 정기" })).getByRole("button", { name: "상세 펼치기" }));

    const detail = await screen.findByRole("region", { name: "2026-10-26 정기 상세" });
    expect(within(within(detail).getByRole("region", { name: "판단" })).getByText("위험 회피 (RISK_OFF)")).toBeTruthy();
    const orders = within(detail).getByRole("region", { name: "주문" });
    expect(rowsOf(orders).map((cells) => [cells[0], cells[3]])).toEqual([["XLV", `취소${pausedReason}`], ["NVDA", "거절WEIGHT_CAP"]]);
    expect(within(orders).getByText(/집행 전에 취소되면\(다음 결정이 대신함·일시정지\) 취소와 사유가 보입니다/)).toBeTruthy();
    const packet = within(detail).getByText("입력 패킷(JSON)").closest("details") as HTMLDetailsElement;
    expect(packet.open).toBe(false);
    expect(packet.textContent).toContain("\"pendingOrders\"");
    expect(packet.textContent).toContain("XLE");
  });

  it("다른 결정이 돌고 있어 서버가 거절하면 그 문구를 경고로 — 확인 단계는 닫히고 다시 누를 수 있다", async () => {
    api.apiPost.mockRejectedValue(new Error("다른 결정을 실행하고 있습니다 — 끝난 뒤 다시 누르세요."));
    await openClaudeDecisions();
    await screen.findByRole("row", { name: "2026-10-26 정기" });
    fireEvent.click(screen.getByRole("button", { name: "지금 결정 실행" }));
    fireEvent.click(screen.getByRole("button", { name: "결정 실행 확인" }));

    const warning = await screen.findByText("다른 결정을 실행하고 있습니다 — 끝난 뒤 다시 누르세요.");
    expect(warning.closest("div")?.className).toContain("text-warn");
    expect(screen.queryByText(/Claude를 지금 부를까요/)).toBeNull();
    expect((screen.getByRole("button", { name: "지금 결정 실행" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("지금 결정 실행은 비용 안내와 확인을 거쳐 POST /api/paper/run/decision {book:'claude'}", async () => {
    api.apiPost.mockResolvedValue({ ok: true, decision: decision(23, { kind: "MANUAL", status: "NO_TRADE", orderCount: 0, rejectedCount: 0, summary: "관망" }) });
    await openClaudeDecisions();
    await screen.findByRole("row", { name: "2026-10-26 정기" });

    fireEvent.click(screen.getByRole("button", { name: "지금 결정 실행" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(screen.getByText(/Claude를 지금 부를까요\? Sonnet 5\.5 호출 1회, 약 \$0\.1/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByText(/Claude를 지금 부를까요/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "지금 결정 실행" }));
    fireEvent.click(screen.getByRole("button", { name: "결정 실행 확인" }));
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/decision", { book: "claude" });
    expect(await screen.findByText("2026-10-26 수동 결정 — 주문 없음 · 주문 0건 · 관망")).toBeTruthy();
    expect(screen.queryByText(/Claude를 지금 부를까요/)).toBeNull();
  });
});

describe("결정 로그 — 일시정지 중인 Claude 책", () => {
  it("'지금 결정 실행'을 막고 재개하는 길을 — Claude를 부를지 묻지 않는다(서버는 행 없이 400)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview({ ...CLAUDE_ACTIVE, status: "PAUSED" }));
    reads["/api/paper/decisions?book=rules"] = () => Promise.resolve({ available: true, decisions: [] });
    reads["/api/paper/decisions?book=claude"] = () => Promise.resolve({ available: true, decisions: [] });
    await openClaudeDecisions();

    expect(await screen.findByText(/일시정지 중인 Claude 계좌는 결정을 내지 않습니다/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "지금 결정 실행" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(screen.queryByText(/Claude를 지금 부를까요/)).toBeNull();
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});

describe("개요 — Claude 호출 사용량(명세 C8)", () => {
  it("상태 응답의 오늘 호출/상한·추정 비용·토큰과 이달 누적을 그대로 — 추정 비용은 '추정'과 추정한 호출 수를 함께", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({
      available: true, schemaReady: true, initialized: true, enabled: true, jobs: [],
      apiUsage: {
        today: {
          day: "2026-10-27", calls: 6, cap: 6, inputTokens: 45012, outputTokens: 6200, cacheReadTokens: 0, cacheWriteTokens: 0,
          estCostUsd: 0.09, estimatedCalls: 1, isEstimated: true,
        },
        month: {
          month: "2026-10", days: 3, calls: 9, inputTokens: 210000, outputTokens: 27000, cacheReadTokens: 7800, cacheWriteTokens: 8100,
          estCostUsd: null, estimatedCalls: 0, isEstimated: true,
        },
        note: "호출 수는 성공·실패를 모두 셉니다. 토큰은 응답이 알려 준 값의 합입니다.",
      },
    });
    render(<PaperPage />);

    expect(await screen.findByText("Claude 호출 사용량")).toBeTruthy();
    const today = screen.getByRole("region", { name: "Claude 호출 사용량 오늘(KST 2026-10-27)" });
    expect(within(today).getByText("호출 / 하루 상한").nextElementSibling?.textContent).toBe("6 / 6회");
    expect(within(today).getByText("입력 토큰").nextElementSibling?.textContent).toBe("45,012");
    const month = screen.getByRole("region", { name: "Claude 호출 사용량 이달(KST 2026-10)" });
    expect(within(month).getByText("호출").nextElementSibling?.textContent).toBe("9회");
    expect(within(month).getByText("출력 토큰").nextElementSibling?.textContent).toBe("27,000");
    expect(within(today).getByText("추정 비용").nextElementSibling?.textContent).toBe("추정 $0.09 · 추정 1/6회");
    // 추정한 호출이 없으면(단가 도입 전) 금액은 —, 0으로 채우지 않습니다.
    expect(within(month).getByText("추정 비용").nextElementSibling?.textContent).toBe("—");
    expect(screen.getByText(/오늘 호출이 하루 상한에 닿았습니다/)).toBeTruthy();
    expect(screen.getByText(/청구액이 아닙니다/).textContent).toContain("추정에서 빠진 호출이 있습니다");
    expect(screen.getByText("호출 수는 성공·실패를 모두 셉니다. 토큰은 응답이 알려 준 값의 합입니다.")).toBeTruthy();
  });

  it("상태 응답에 사용량이 없으면(구 서버) 카드를 그리지 않는다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({ available: true, schemaReady: true, initialized: true, enabled: true, jobs: [] });
    render(<PaperPage />);

    expect(await screen.findByText("Claude 노출 추이")).toBeTruthy();
    expect(screen.queryByText("Claude 호출 사용량")).toBeNull();
    expect(screen.queryByText(/재무\(SEC XBRL\)/)).toBeNull();
  });
});

describe("개요 — 재무 수집 범위(D28)", () => {
  it("상태 응답의 fundamentals를 장부 관측치 카드에 한 줄로 — 출처에 SEC XBRL을 함께 적는다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({
      available: true, schemaReady: true, initialized: true, enabled: true, jobs: [],
      fundamentals: {
        available: true, universe: 596, mapped: 571, covered: 560, latestFetchKst: "2026-10-25 12:10 KST", staleCompanies: 2,
        note: "SEC XBRL Company Facts — Claude 계좌 패킷(8b_fundamentals)에만 씁니다.",
      },
    });
    render(<PaperPage />);

    expect(await screen.findByText("재무(SEC XBRL): 560/596곳 · 마지막 수집 2026-10-25 12:10 · 이어받음 2곳")).toBeTruthy();
    expect(screen.getByText(/SEC EDGAR XBRL Company Facts/)).toBeTruthy();
  });

  it("저장본이 아직 없으면 숫자는 —(0곳이 아님)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({
      available: true, schemaReady: true, initialized: true, enabled: true, jobs: [],
      fundamentals: {
        available: false, universe: null, mapped: null, covered: null, latestFetchKst: null, staleCompanies: null,
        note: "재무 상태 저장본(us.fundamentals.status)이 아직 없습니다",
      },
    });
    render(<PaperPage />);

    expect(await screen.findByText("재무(SEC XBRL): —/—곳 · 마지막 수집 —")).toBeTruthy();
  });
});

describe("개요 — 발표·실적 일정(2단계 A)", () => {
  it("상태 응답의 calendar를 장부 관측치 카드에 한 줄로 — 출처에 FRED·FOMC·yfinance를 함께 적는다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({
      available: true, schemaReady: true, initialized: true, enabled: true, jobs: [],
      calendar: {
        available: true, macroCount: 2, earningsCovered: 120, universe: 576, generatedAtKst: "2026-10-25 15:40 KST",
        fredStatus: "키 미설정",
      },
    });
    render(<PaperPage />);

    expect(await screen.findByText("일정(FRED·FOMC·실적): 거시 2건 · 실적 120/576종목 · 갱신 2026-10-25 15:40 · FRED 키 미설정"))
      .toBeTruthy();
    expect(screen.getByText(/calendar\.us_events/)).toBeTruthy();
  });

  it("상태 응답에 calendar가 없으면(이전 백엔드) 줄을 그리지 않는다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({ available: true, schemaReady: true, initialized: true, enabled: true, jobs: [] });
    render(<PaperPage />);

    expect(await screen.findByText("Claude 노출 추이")).toBeTruthy();
    expect(screen.queryByText(/일정\(FRED·FOMC·실적\)/)).toBeNull();
  });
});

describe("개요 — 사건 뉴스 RSS(2단계 B)", () => {
  it("상태 응답의 news를 장부 관측치 카드에 한 줄로 — 실패한 피드 키, 출처에 RSS 피드와 저장본 이름", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({
      available: true, schemaReady: true, initialized: true, enabled: true, jobs: [],
      news: {
        available: true, stored7d: 61, lastFetchKst: "2026-10-25 15:00 KST", feedsOk: 6, feedsTotal: 7,
        failedFeeds: [{ feed: "sec_press", source: "SEC", reason: "SEC_USER_AGENT 미설정" }],
      },
    });
    render(<PaperPage />);

    expect(await screen.findByText("사건 뉴스(RSS): 7일 61건 · 피드 6/7 · 갱신 2026-10-25 15:00 · 실패 sec_press")).toBeTruthy();
    expect(screen.getByText(/news\.headlines\.status/)).toBeTruthy();
  });

  it("저장본이 아직 없으면 숫자는 —, 응답에 news가 없으면(이전 백엔드) 줄을 그리지 않는다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({
      available: true, schemaReady: true, initialized: true, enabled: true, jobs: [],
      news: { available: false, stored7d: null, lastFetchKst: null, feedsOk: null, feedsTotal: null, failedFeeds: null },
    });
    const { unmount } = render(<PaperPage />);
    expect(await screen.findByText("사건 뉴스(RSS): 7일 —건 · 피드 —/— · 갱신 —")).toBeTruthy();
    unmount();

    reads["/api/paper/status"] = () => Promise.resolve({ available: true, schemaReady: true, initialized: true, enabled: true, jobs: [] });
    render(<PaperPage />);
    expect(await screen.findByText("Claude 노출 추이")).toBeTruthy();
    expect(screen.queryByText(/사건 뉴스\(RSS\)/)).toBeNull();
  });
});

describe("개요 — 어닝 서프라이즈(2단계 C)", () => {
  it("상태 응답의 earnings를 장부 관측치 카드에 한 줄로 — 출처에 yfinance quoteSummary와 저장본 이름", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({
      available: true, schemaReady: true, initialized: true, enabled: true, jobs: [],
      earnings: { available: true, covered: 98, universe: 576, withEstimate4: 91, generatedAtKst: "2026-10-25 21:30 KST" },
    });
    render(<PaperPage />);

    expect(await screen.findByText("어닝 서프라이즈(yfinance): 98/576종목 · 4분기 91 · 갱신 2026-10-25 21:30")).toBeTruthy();
    expect(screen.getByText(/us\.earnings_surprise\.status/)).toBeTruthy();
  });

  it("저장본이 아직 없으면 숫자는 —, 응답에 earnings가 없으면(이전 백엔드) 줄을 그리지 않는다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    reads["/api/paper/status"] = () => Promise.resolve({
      available: true, schemaReady: true, initialized: true, enabled: true, jobs: [],
      earnings: { available: false, covered: null, universe: null, withEstimate4: null, generatedAtKst: null },
    });
    const { unmount } = render(<PaperPage />);
    expect(await screen.findByText("어닝 서프라이즈(yfinance): —/—종목 · 4분기 — · 갱신 —")).toBeTruthy();
    unmount();

    reads["/api/paper/status"] = () => Promise.resolve({ available: true, schemaReady: true, initialized: true, enabled: true, jobs: [] });
    render(<PaperPage />);
    expect(await screen.findByText("Claude 노출 추이")).toBeTruthy();
    expect(screen.queryByText(/어닝 서프라이즈\(yfinance\)/)).toBeNull();
  });
});

/** 지금 판(GET /api/paper/framework) — 임시 v0. */
const FRAMEWORK_INTERIM = {
  available: true,
  current: {
    version: 0, status: "INTERIM", title: "임시 v0 — OS 원문 반영 전", body: null, rendered: "# 투자 OS — v0", tokensEst: 4100,
    overBudget: false, changelog: "임시 v0 — 사용자 OS 원문을 받기 전, 명세·설계의 지침으로 만든 판", createdAtKst: "2026-10-25 10:00",
  },
  versions: [],
};

describe("개요 — Claude 책 시작", () => {
  beforeEach(() => {
    reads["/api/paper/framework"] = () => Promise.resolve(FRAMEWORK_INTERIM);
  });

  it("시작 전이면 카드 — 지금 판이 임시 v0이면 OS 원문으로 v1을 만든 뒤 시작 권고·비용, 버튼 둘", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_NOT_STARTED));
    render(<PaperPage />);

    expect(await screen.findByText(/Claude 계좌는 아직 현금만 들고 있습니다/)).toBeTruthy();
    const note = await screen.findByText(/지금 프레임은 임시 v0입니다 — OS 원문으로 v1을 만든 뒤 시작을 권합니다/);
    expect(note.closest("div")?.className).toContain("text-warn");
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/framework", 0);
    expect(screen.getByText(/비용: Sonnet 5\.5 호출 1회, 약 \$0\.1/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "미리보기" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claude 계좌 시작" })).toBeTruthy();
  });

  it("미리보기 — 확인 → POST {book:'claude', preview:true} → 경과 초 → 결과(검증 표·사용량·패킷), 장부는 다시 읽지 않는다", async () => {
    let overviewReads = 0;
    reads["/api/paper/overview"] = () => {
      overviewReads += 1;
      return Promise.resolve(overview(CLAUDE_NOT_STARTED));
    };
    let finish: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    render(<PaperPage />);

    fireEvent.click(await screen.findByRole("button", { name: "미리보기" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(screen.getByText(/미리보기를 부를까요\? Sonnet 5\.5 호출 1회, 약 \$0\.1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "미리보기 확인" }));

    const busy = await screen.findByRole("button", { name: /미리보기 중… \d+초/ });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/initial-decision", { book: "claude", preview: true });

    finish({
      ok: true, preview: true, model: "claude-sonnet-5-5", packet: { "1_asOf": "2026-10-23" },
      response: { ...RESPONSE, validation: undefined }, validation: RESPONSE.validation,
      usage: { inputTokens: 23001, outputTokens: 2800, cacheReadTokens: null, cacheWriteTokens: 7900 },
    });

    const result = await screen.findByRole("region", { name: "미리보기 결과" });
    expect(within(result).getByText(/claude-sonnet-5-5의 응답을 검증까지 했습니다/)).toBeTruthy();
    expect(within(result).getByText(/장부·결정·주문 기록은 바꾸지 않았습니다/)).toBeTruthy();
    expect(rowsOf(within(result).getByRole("region", { name: "검증" })).map((cells) => [cells[0], cells[3], cells[4]])).toEqual([
      ["XLV", "통과", "—"],
      ["NVDA", "거절", "비중 상한 초과 (WEIGHT_CAP)"],
    ]);
    expect(within(within(result).getByRole("region", { name: "사용량" })).getByText("캐시 읽기 토큰").nextElementSibling?.textContent)
      .toBe("—");
    expect(within(result).getByText("입력 패킷(JSON)")).toBeTruthy();
    // 미리보기는 장부를 바꾸지 않아 개요를 다시 읽지 않고, 카드는 그대로 남습니다.
    expect(overviewReads).toBe(1);
    expect(screen.getByRole("button", { name: "Claude 계좌 시작" })).toBeTruthy();
  });

  it("미리보기가 실패하면(호출 상한 등) 서버 문구를 경고로, 다시 누를 수 있다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_NOT_STARTED));
    api.apiPost.mockRejectedValue(new Error("하루 호출 상한(6회)에 닿았습니다 — 내일 다시 누르세요."));
    render(<PaperPage />);

    fireEvent.click(await screen.findByRole("button", { name: "미리보기" }));
    fireEvent.click(screen.getByRole("button", { name: "미리보기 확인" }));

    const warning = await screen.findByText("하루 호출 상한(6회)에 닿았습니다 — 내일 다시 누르세요.");
    expect(warning.closest("div")?.className).toContain("text-warn");
    expect((screen.getByRole("button", { name: "미리보기" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("시작 — 확인 → POST {book:'claude'} → 결과, 개요 다시 읽어 카드가 사라져도 결과는 남는다", async () => {
    let overviewReads = 0;
    reads["/api/paper/overview"] = () => {
      overviewReads += 1;
      return Promise.resolve(overview(overviewReads === 1 ? CLAUDE_NOT_STARTED : CLAUDE_ACTIVE));
    };
    api.apiPost.mockResolvedValue({
      ok: true, fills: [{}, {}],
      decision: decision(30, { asOfTradingDate: "2026-10-23", kind: "INITIAL", orderCount: 3, summary: "노출 60%로 시작" }),
    });
    render(<PaperPage />);

    // 확인 문구의 프레임 판은 지금 판을 읽은 뒤에 붙습니다.
    await screen.findByText(/지금 프레임은 임시 v0입니다/);
    fireEvent.click(await screen.findByRole("button", { name: "Claude 계좌 시작" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    const confirm = screen.getByText(/정말 시작할까요\? Sonnet 5\.5 호출 1회/);
    expect(confirm.textContent).toContain("'계좌 초기화'");
    expect(confirm.textContent).toContain("프레임은 아직 임시 v0입니다");
    fireEvent.click(screen.getByRole("button", { name: "시작 확인" }));

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/initial-decision", { book: "claude" });
    expect(await screen.findByText(
      "Claude 계좌를 시작했습니다 · 2026-10-23 초기 결정 · 주문 3건 · 사후 체결 2건 — 노출 60%로 시작",
    )).toBeTruthy();
    await waitFor(() => expect(overviewReads).toBeGreaterThanOrEqual(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Claude 계좌 시작" })).toBeNull());
    expect(screen.getByText(/Claude 계좌를 시작했습니다/)).toBeTruthy();
  });

  it("이미 시작했으면 카드가 없다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    render(<PaperPage />);
    expect(await screen.findByText("Claude 노출 추이")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "미리보기" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Claude 계좌 시작" })).toBeNull();
  });
});

describe("개요 — Claude 노출 추이", () => {
  it("목표 vs 실제 두 선(0~100% 축)과 마지막 날 한 줄 — 모르는 값은 —", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE, {
      claudeExposureSeries: [
        { tradingDate: "2026-10-23", targetExposurePct: 60, actualExposurePct: 59.42 },
        { tradingDate: "2026-10-26", targetExposurePct: 35, actualExposurePct: null },
      ],
    }));
    render(<PaperPage />);

    const chart = await screen.findByRole("list", { name: "노출 계열" });
    expect(within(chart).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["목표 노출(Claude가 정함)", "실제 노출(장부)"]);
    expect(chart.getAttribute("data-rows")).toBe("2");
    expect(chart.getAttribute("data-domain")).toBe("0~100");
    expect(screen.getByText("마지막 2026-10-26 — 목표 35.0% · 실제 —")).toBeTruthy();
  });

  it("기록이 없으면(이 필드를 아직 보내지 않는 백엔드도) 차트 대신 안내", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE_ACTIVE));
    render(<PaperPage />);

    expect(await screen.findByText(/아직 Claude 결정 기록이 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "노출 계열" })).toBeNull();
  });
});
