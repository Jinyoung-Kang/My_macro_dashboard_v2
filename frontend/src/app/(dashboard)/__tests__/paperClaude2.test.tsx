/**
 * 🧪 모의매매(미국) — Claude 계좌2(체결 시점 실험, 계좌2 명세 §13-3, ADR 0022)의 화면. 계좌1·벤치마크 화면은 그대로.
 *
 *  - 개요: 계좌2가 시작 전이면 출발 카드 — 설정 claude2.enabled가 꺼져 있으면 '계좌2 시작'이 닫히고 설정을 켜라고, 켜져 있으면 확인 단계 →
 *    POST run/initial-decision {book:"claude2"}(미리보기 없음) → 개요를 다시 읽음. 계좌1 시작 카드는 계좌1이 운용 중이면 없다
 *  - 개요: 체결 시점 실험(시점마다 N·평균·90% 구간 — 문턱 미달이면 '—'와 '판단 보류', 시가는 대리값), 계좌1 기준 분포로 바꿔 보기,
 *    그 위에 고른 시점(M1 — 주 판정) 표 — 계좌2만(본 줄·대체 체결 따로), 계좌1이면 표 대신 '계좌2만' 한 줄, 사전 등록 문턱은 설명으로만
 *    S = 100 같은 구간(출발 전이면 그리지 않는다고), 한계 문구 아래 계좌2의 한계
 *  - 보유·체결: 계좌2 주문 표에 목표 시각·계좌1식 대비·실행 메모, 체결 표에 체결 봉·사다리·계좌1식 대비·대체 체결 배지 — 계좌1 표는 칸이 그대로
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
// jsdom에서는 recharts가 크기 0이라 아무것도 그리지 않습니다 — 차트 이름·계열 이름·색·행 수를 목록으로 그립니다.
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: ({ data, series, ariaLabel }: { data: unknown[]; series: { key: string; name: string; color?: string }[]; ariaLabel?: string }) => (
    <ul aria-label={`차트 ${ariaLabel ?? ""}`} data-rows={data.length}>
      {series.map((entry) => <li key={entry.key} data-color={entry.color}>{entry.name}</li>)}
    </ul>
  ),
  DonutChart: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: "bench_spy", ...over,
  };
}

const CLAUDE2_NOT_STARTED = book("claude2", { kind: "CLAUDE", label: "Claude 계좌2", status: "NOT_STARTED", startedOn: null, positions: 0 });
const CLAUDE2_ACTIVE = book("claude2", { kind: "CLAUDE", label: "Claude 계좌2", startedOn: "2026-11-02" });

function overview(claude2: Record<string, unknown> | null, over: Record<string, unknown> = {}) {
  return {
    available: true, initialized: true, startDate: "2026-10-23", jobs: [], pendingBackfill: [],
    limits: ["모의 매매입니다. 어떤 주문도 밖으로 나가지 않습니다.", "체결가는 최대 1시간 묵은 지연 시세입니다."],
    books: [
      book("rules", { kind: "RULES", label: "규칙 계좌" }),
      book("claude", { kind: "CLAUDE", label: "Claude 계좌1" }),
      ...(claude2 ? [claude2] : []),
      book("bench_spy", { label: "SPY 계좌", benchmark: null }),
      book("bench_mix", { label: "60/40 계좌" }),
    ],
    navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null, claudeExposureSeries: [],
    ...over,
  };
}

function status(enabled: boolean, nextDecision: Record<string, unknown> = {
  tradingDate: "2026-10-30", atKst: "2026-10-31 07:30 KST", atEt: "2026-10-30 18:30 ET",
  cutoffKst: "2026-11-02 23:00 KST", cutoffEt: "2026-11-02 09:00 ET",
}) {
  return {
    available: true, enabled: true, jobs: [],
    claude2: {
      book: "claude2", status: "NOT_STARTED", startedOn: null, enabled,
      nextDecision,
      cycle: { tradingDate: "2026-10-29", calls: 0, cap: 2 },
      bars: null,
    },
  };
}

function summaryLine(timing: string, over: Record<string, unknown> = {}) {
  return { timing, n: 3, days: 2, excludedNoBaseline: 0, excludedNoPrice: 0, meanBp: null, lowBp: null, highBp: null, isProxy: timing === "NEXT_OPEN", ...over };
}

/** 고른 시점(M1) 묶음 — 서버 모양(본 줄 + 대체 체결 따로). */
function chosenSummary(over: Record<string, unknown> = {}, fallback: Record<string, unknown> = {}) {
  return {
    formula: "s × (P_NEXT_OBSERVATION − P_체결) ÷ P_NEXT_OBSERVATION × 10⁴ bp", n: 2, days: 1, excludedNoBaseline: 0, meanBp: null, lowBp: null,
    highBp: null, isProxy: false, excludedFallback: 1, notFilled: 0,
    fallback: { n: 1, days: 1, excludedNoBaseline: 0, meanBp: null, lowBp: null, highBp: null, isProxy: false, ...fallback }, ...over,
  };
}

function execution(bookCode: string, timings: Record<string, unknown>[], orders: Record<string, unknown>[] = [],
  chosen: Record<string, unknown> | null = bookCode === "claude2" ? chosenSummary() : null) {
  return {
    available: true, book: bookCode, limit: 50, orders,
    summary: {
      baseline: "NEXT_OBSERVATION", formula: "s × (P_NEXT_OBSERVATION − P_시점) ÷ P_NEXT_OBSERVATION × 10⁴ bp", weighting: "체결 금액(gross) 가중 평균",
      interval: { level: 90, method: "결정일(기준 거래일) 묶음 부트스트랩", resamples: 2000, seed: 1 },
      minOrders: 10, minDays: 5, audited: 3, chosen, timings,
    },
  };
}

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
const headersOf = (table: HTMLElement) => within(table).getAllByRole("columnheader").map((th) => th.textContent);

describe("개요 — 계좌2 출발", () => {
  // 출발 카드의 다음 결정은 지금과 견줍니다(지난 시각이면 '결정 창 열림') — 고정 응답의 결정 시각(2026-10-31 07:30 KST) 전으로 시계를 고정해 실제
  // 날짜가 지나도 같은 결과가 나오게.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T11:00:00Z"));   // 20:00 KST
  });
  afterEach(() => vi.useRealTimers());

  it("설정이 꺼져 있으면 '계좌2 시작'이 닫히고 설정을 켜라고 — 창 시각·이번 주기 호출, 계좌1 시작 카드는 없다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_NOT_STARTED));
    reads["/api/paper/status"] = () => Promise.resolve(status(false));
    render(<PaperPage />);

    expect(await screen.findByText(/설정 claude2\.enabled가 꺼져 있습니다/)).toBeTruthy();
    const button = screen.getByRole("button", { name: "계좌2 시작" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Claude 계좌2는 아직 현금만 들고 있습니다\. 출발은 사후 체결이 아니라 앞으로 체결입니다/)).toBeTruthy();
    const panel = screen.getByLabelText("계좌2 결정 창");
    expect(within(panel).getByText("2026-10-31 07:30 KST · 2026-10-30 18:30 ET")).toBeTruthy();
    expect(within(panel).getByText("0회 / 상한 2회")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Claude 계좌1 시작" })).toBeNull();
    expect(screen.queryByRole("button", { name: "미리보기" })).toBeNull();
  });

  // 수정 전에는 d(마감이 끝난 최근 세션)의 계좌2 행이 아직 없으면 서버가 보내는 그 결정 시각 — 이미 지난 07:30 KST(창은 개장 전 컷오프까지 열림,
  // PaperQueryService.claude2Status) — 을 '다음 결정'에 그대로 적어, 17:43 KST에 '2026-10-30 07:30 KST'가 다음 결정으로 읽혔다(수정 전에는 it.fails).
  it("다음 결정 시각이 이미 지났으면 지난 시각 대신 '결정 창 열림(07:30부터 컷오프 22:00 KST까지)'", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-30T08:43:00Z"));   // 17:43 KST — 그날 07:30 결정 시각은 지났고 22:00 컷오프 전
    try {
      reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_NOT_STARTED));
      reads["/api/paper/status"] = () => Promise.resolve(status(true, {
        tradingDate: "2026-10-29", atKst: "2026-10-30 07:30 KST", atEt: "2026-10-29 18:30 ET",
        cutoffKst: "2026-10-30 22:00 KST", cutoffEt: "2026-10-30 09:00 ET",
      }));
      render(<PaperPage />);

      // 상태 응답이 온 뒤(그 전에는 창 칸이 '—')의 결정 창.
      expect(await screen.findByText("다음 결정(기준 거래일 2026-10-29)")).toBeTruthy();
      const panel = screen.getByLabelText("계좌2 결정 창");
      await waitFor(() => expect(within(panel).getByText("결정 창 열림(07:30부터 컷오프 22:00 KST까지)")).toBeTruthy());
      expect(within(panel).queryByText("2026-10-30 07:30 KST · 2026-10-29 18:30 ET")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("설정이 켜져 있으면 확인 단계 → POST {book:'claude2'}(미리보기 없음) → 결과와 개요 다시 읽기", async () => {
    let overviewReads = 0;
    reads["/api/paper/overview"] = () => {
      overviewReads += 1;
      return Promise.resolve(overview(CLAUDE2_NOT_STARTED));
    };
    reads["/api/paper/status"] = () => Promise.resolve(status(true));
    api.apiPost.mockResolvedValue({
      ok: true, preview: false, outcome: "STARTED", message: "출발했습니다", fills: [],
      decision: {
        id: 41, book: "claude2", asOfTradingDate: "2026-10-30", kind: "INITIAL", status: "OK", decidedAtKst: "2026-10-31 07:42",
        model: "claude-sonnet-5-5", frameworkVersion: 4, settingsVersion: 9, selectionAsOf: null, targetExposurePct: 60, summary: null,
        orderCount: 5, rejectedCount: 0, pricesFinal: true, error: null,
      },
    });
    render(<PaperPage />);

    expect(await screen.findByText(/설정 claude2\.enabled가 켜져 있습니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "계좌2 시작" }));
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(screen.getByText(/계좌2를 지금 출발시킬까요\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "출발 확인" }));

    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/initial-decision", { book: "claude2" }));
    expect(await screen.findByText(/Claude 계좌2가 출발했습니다 — 주문은 다음 세션에 고른 시점으로 체결됩니다 · 2026-10-30 초기 결정 · 주문 5건/))
      .toBeTruthy();
    await waitFor(() => expect(overviewReads).toBe(2));
  });
});

describe("개요 — 체결 시점 실험·S = 100·한계", () => {
  beforeEach(() => {
    reads["/api/paper/status"] = () => Promise.resolve(status(false));
    reads["/api/paper/books/claude2/execution"] = () => Promise.resolve(execution("claude2", [
      summaryLine("NEXT_OPEN"),
      summaryLine("AT_1000", { n: 12, days: 6, meanBp: 4.25, lowBp: -10.5, highBp: 18 }),
    ]));
    reads["/api/paper/books/claude/execution"] = () => Promise.resolve(execution("claude", [summaryLine("NEXT_CLOSE", { n: 40, days: 12, meanBp: -2, lowBp: -9, highBp: 4 })]));
  });

  it("시점마다 N·평균·90% 구간 — 문턱 미달은 '—'와 판단 보류, 시가는 대리값, 계좌1 기준 분포로 바꿔 본다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_NOT_STARTED));
    render(<PaperPage />);

    const table = await screen.findByRole("table", { name: "체결 시점 실험" });
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/books/claude2/execution?limit=1", 0);
    expect(headersOf(table)).toEqual(["시점", "주문", "결정일", "평균(계좌1식 대비)", "90% 구간", "판단", "뺀 주문"]);
    expect(within(table).getAllByRole("rowheader").map((th) => th.textContent)).toEqual(["다음 거래일 시가대리값", "다음 거래일 10:00 ET"]);
    expect(rowsOf(table)).toEqual([
      // 모르는 칸은 표가 "—"(Empty — 낭독기는 "값 없음")로 그립니다.
      ["3건", "2일", "—값 없음", "—값 없음", "판단 보류 — 표본 부족(주문 3/10건 · 결정일 2/5일)", "기준 없음 0 · 값 없음 0"],
      ["12건", "6일", "+4.3bp", "-10.5bp ~ +18.0bp", "구간 참고(판정은 8주 뒤)", "기준 없음 0 · 값 없음 0"],
    ]);
    expect(screen.getByText("감사한 주문 3건 · 평균·구간은 주문 10건·결정일 5일 이상부터")).toBeTruthy();

    const picker = screen.getByRole("group", { name: "실행 감사 계좌" });
    expect(within(picker).getByRole("button", { name: "Claude 계좌2" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(within(picker).getByRole("button", { name: "Claude 계좌1" }));
    expect(await screen.findByText("다음 종가")).toBeTruthy();
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/books/claude/execution?limit=1", 0);
  });

  it("고른 시점(M1 — 주 판정)은 시점 표 위에 — 문턱 미달이면 '—'와 판단 보류, 값이 있으면 평균·구간(판정 문장 없음), 대체 체결은 따로, 계좌1이면 없음", async () => {
    reads["/api/paper/books/claude2/execution"] = () => Promise.resolve(execution("claude2", [summaryLine("NEXT_OPEN")], [],
      chosenSummary({ n: 31, days: 9, excludedNoBaseline: 2, meanBp: 12.5, lowBp: 1.25, highBp: 24, isProxy: true, excludedFallback: 3, notFilled: 4 },
        { n: 3, days: 2 })));
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_ACTIVE));
    render(<PaperPage />);

    const chosen = await screen.findByRole("table", { name: "고른 시점(M1 — 주 판정)" });
    expect(headersOf(chosen)).toEqual(["구분", "주문", "결정일", "평균(계좌1식 대비)", "90% 구간", "판단", "뺀 주문"]);
    expect(within(chosen).getAllByRole("rowheader").map((th) => th.textContent))
      .toEqual(["고른 시점 대비 계좌1식(M1 — 주 판정)대리값", "대체 체결(따로 셈)"]);
    expect(rowsOf(chosen)).toEqual([
      ["31건", "9일", "+12.5bp", "+1.3bp ~ +24.0bp", "구간 참고(판정은 8주 뒤)", "기준 없음 2 · 대체 체결 3(아래 줄) · 체결 없음 4"],
      ["3건", "2일", "—값 없음", "—값 없음", "판정에 쓰지 않음 — 표본 부족(주문 3/10건 · 결정일 2/5일)", "기준 없음 0"],
    ]);
    // 문턱을 넘는 값이어도 카드가 판정하지 않는다 — 표 안에 판정 문장이 없고, 문턱은 설명 목록에만.
    expect(chosen.textContent).not.toMatch(/도움이 됐다|손해였다/);
    const menu = screen.getByRole("table", { name: "체결 시점 실험" });
    expect(chosen.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();   // M1 표가 시점 표보다 위
    const notes = screen.getByRole("list", { name: "체결 시점 실험 설명" });
    expect(notes.textContent).toContain("M1 계산: s × (P_NEXT_OBSERVATION − P_체결)");
    expect(notes.textContent).toContain("대체 체결을 뺀 M1 주문 30건 이상이고 평균 > +10bp이고 90% 구간 하한 > 0이면 '도움이 됐다'");
    expect(notes.textContent).toContain("이 카드는 판정을 내리지 않습니다");

    fireEvent.click(within(screen.getByRole("group", { name: "실행 감사 계좌" })).getByRole("button", { name: "Claude 계좌1" }));
    expect(await screen.findByText("고른 시점(M1 — 주 판정)은 계좌2만 있습니다 — 계좌1은 고른 시점이 곧 계좌1식 기준입니다.")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "고른 시점(M1 — 주 판정)" })).toBeNull();
    expect(screen.getByRole("table", { name: "체결 시점 실험" })).toBeTruthy();
  });

  it("고른 시점(M1) 본 줄이 문턱 아래면 '—'와 판단 보류(표본 수와 문턱)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_NOT_STARTED));
    render(<PaperPage />);

    const chosen = await screen.findByRole("table", { name: "고른 시점(M1 — 주 판정)" });
    expect(rowsOf(chosen)[0]).toEqual(["2건", "1일", "—값 없음", "—값 없음", "판단 보류 — 표본 부족(주문 2/10건 · 결정일 1/5일)",
      "기준 없음 0 · 대체 체결 1(아래 줄) · 체결 없음 0"]);
  });

  // 수정 전에는 카드 설명이 '대체 체결·계좌1식 기준이 없는 주문은 빼고 셉니다'라고 적었지만, 서버 요약(ExecutionView.summary)은 계좌1식 기준이
  // 없거나 그 시점 반사실이 없는 주문만 빼고 대체 체결은 따로 빼지 않는다(수정 전에는 it.fails).
  it("카드 설명은 서버 요약이 빼는 것만 적는다 — 계좌1식 기준이 없거나 그 시점 반사실이 없는 주문, 대체 체결은 따로 빼지 않음", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_NOT_STARTED));
    render(<PaperPage />);

    const notes = await screen.findByRole("list", { name: "체결 시점 실험 설명" });
    expect(notes.textContent).toContain("그 시점 반사실이 없는 주문은 빼고 셉니다(뺀 수를 함께 적음");
    expect(notes.textContent).toContain("대체 체결로 풀린 주문도 따로 빼지 않음");
    expect(notes.textContent).not.toContain("대체 체결·계좌1식 기준이 없는 주문은 빼고");
  });

  // 수정 전에는 카드 설명이 '계좌1식 기준이 없거나 그 시점 반사실이 없는 주문은 빼고 셉니다'라고만 적었지만, 서버 요약(ExecutionView.summary)은
  // 체결 금액(가중치)이 없는 주문도 같은 칸(excludedNoBaseline)으로 뺀다 — 계좌2는 기준이 있어도 체결 없는 대기·만료·취소 주문이 '기준 없음'에 든다(수정 전에는 it.fails).
  it("카드 설명은 시점 표의 '기준 없음'에 계좌2의 체결 없는 주문도 든다고 적는다 — 서버는 계좌1식 기준이나 체결(가중치)이 없는 주문을 뺌", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_NOT_STARTED));
    render(<PaperPage />);

    const notes = await screen.findByRole("list", { name: "체결 시점 실험 설명" });
    expect(notes.textContent).toContain("계좌1식 기준이나 체결(금액 가중치)이 없거나 그 시점 반사실이 없는 주문은 빼고 셉니다");
    expect(notes.textContent).toContain("'기준 없음'에는 계좌2의 체결 없는 주문도 듦");
  });

  // 수정 전에는 두 표의 '뺀 주문' 칸과 M1 표의 첫 칸(구분)이 줄바꿈 금지(whitespace-nowrap)라, 1280px 카드(표 상자 958px)에서 M1 본 줄의 뺀 주문
  // ("기준 없음 · 대체 체결(아래 줄) · 체결 없음")이 표를 1,115px로 밀어 '체결 없음'이 가로 스크롤 밖에 숨었다(QA 스택 화면 — 수정 전에는 it.fails).
  it("M1 표의 구분·뺀 주문 칸과 시점 표의 뺀 주문 칸은 낱말 사이에서 줄바꿈 — 1280px 카드 안에 M1 본 줄이 다 보이게", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_ACTIVE));
    render(<PaperPage />);

    const wraps = (cell: Element) => {
      expect(cell.className).toContain("break-keep");
      expect(cell.className).not.toContain("whitespace-nowrap");
    };
    const chosen = await screen.findByRole("table", { name: "고른 시점(M1 — 주 판정)" });
    for (const row of within(chosen).getAllByRole("row").slice(1)) {
      wraps(row.firstElementChild as Element);
      wraps(row.lastElementChild as Element);
    }
    const menu = screen.getByRole("table", { name: "체결 시점 실험" });
    for (const row of within(menu).getAllByRole("row").slice(1)) {
      wraps(row.lastElementChild as Element);
      // 시점 표의 첫 칸(시점 이름)은 짧아 한 줄 그대로
      expect((row.firstElementChild as Element).className).toContain("whitespace-nowrap");
    }
  });

  it("계좌2가 출발 전이면 S = 100 보기를 그리지 않는다고, 한계 문구 아래 계좌2의 한계", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_NOT_STARTED, {
      navSeries: { dates: ["2026-10-30"], books: { rules: [1], claude: [2], claude2: [null], bench_spy: [3], bench_mix: [4] } },
    }));
    render(<PaperPage />);

    expect(await screen.findByText(/아직 계좌2가 출발하지 않았습니다 — 출발 전 구간은 계좌2 값이 없어/)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "차트 S = 100 같은 구간" })).toBeNull();
    const limits = screen.getByRole("region", { name: "Claude 계좌2의 한계" });
    expect(within(limits).getAllByRole("listitem")).toHaveLength(4);
    expect(within(limits).getByText(/위 2번\(최대 1시간 묵은 지연 시세\) 대신/)).toBeTruthy();
    // 순자산 곡선의 계좌2 색(검증한 자주색).
    const nav = screen.getByRole("list", { name: "차트 순자산 곡선" });
    expect(within(nav).getByText("Claude 계좌2").getAttribute("data-color")).toBe("#a438a0");
  });

  it("계좌2가 출발했으면 S = 100 선(계좌1·계좌2·SPY 계좌)과 노출 추이의 계좌2 선", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_ACTIVE, {
      navSeries: {
        dates: ["2026-10-30", "2026-11-02", "2026-11-03"],
        books: { rules: [1, 2, 3], claude: [99000, 100000, 101000], claude2: [null, 100000, 100500], bench_spy: [1, 100, 101], bench_mix: [1, 2, 3] },
      },
      claudeExposureSeries: [{ tradingDate: "2026-11-02", targetExposurePct: 60, actualExposurePct: 58 }],
    }));
    reads["/api/paper/books/claude2/nav"] = () => Promise.resolve({
      available: true, series: [{ tradingDate: "2026-11-03", nav: 100500, cash: 40000, equityValue: 60500, exposurePct: 60.2, pricesFinal: true }],
    });
    render(<PaperPage />);

    const same = await screen.findByRole("list", { name: "차트 S = 100 같은 구간" });
    expect(within(same).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Claude 계좌1", "Claude 계좌2", "SPY 계좌"]);
    expect(same.getAttribute("data-rows")).toBe("2");
    expect(screen.getByText(/기준일 S = 2026-11-02\(Claude 계좌2 출발일\)/)).toBeTruthy();
    expect(screen.getByText("마지막 2026-11-03 — Claude 계좌1 101.0 · Claude 계좌2 100.5 · SPY 계좌 101.0")).toBeTruthy();
    const exposure = await screen.findByRole("list", { name: "차트 Claude 노출 추이(목표 대비 실제)" });
    await waitFor(() => expect(within(exposure).getAllByRole("listitem").map((li) => li.textContent))
      .toEqual(["목표 노출(Claude가 정함)", "실제 노출(장부)", "계좌2 실제 노출(장부)"]));
    expect(screen.queryByRole("button", { name: "계좌2 시작" })).toBeNull();
  });

  it("계좌2가 없는 개요(배포 전 백엔드)는 예전 그대로 — 출발 카드·S = 100·계좌2 한계 없음", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(null));
    render(<PaperPage />);

    expect(await screen.findByRole("table", { name: "체결 시점 실험" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "실행 감사 계좌" })).toBeNull();
    expect(screen.queryByText("S = 100 같은 구간")).toBeNull();
    expect(screen.queryByRole("region", { name: "Claude 계좌2의 한계" })).toBeNull();
    expect(screen.queryByRole("button", { name: "계좌2 시작" })).toBeNull();
  });
});

describe("보유·체결 — 계좌2 칸", () => {
  const ORDERS = [{
    id: 71, ticker: "AAA", side: "BUY", qty: null, targetWeightPct: 8, sellFraction: null, timing: "AT_1000", source: "CLAUDE",
    status: "FILLED", rejectReason: null,
    reason: { thesis: "근거", labels: ["사실"], invalidation: "조건", executionNote: "개장 직후 변동성을 피함" },
    asOfTradingDate: "2026-11-02", createdAtKst: "2026-11-03 07:41", expiresOn: "2026-11-03", filledAtKst: "2026-11-04 01:10",
  }];
  const FILLS = [{
    id: 81, orderId: 71, ticker: "AAA", side: "BUY", qty: 80, price: 100.05, rawPrice: 100, slippageBp: 5, gross: 8004,
    // 가격 출처 칸은 이 시험에서 보지 않습니다(서버 글자 그대로 그리는 칸 — 화면 코드는 1분봉 저장본 이름을 모름, 수집기 test_paper_bars).
    observedAtKst: "2026-11-04 01:10", observationDate: "2026-11-03", priceSource: null, backfill: false,
    barAtKst: "2026-11-04 00:00", fillRung: "Y1M_LATE", fallback: true,
  }];

  beforeEach(() => {
    reads["/api/paper/overview"] = () => Promise.resolve(overview(CLAUDE2_ACTIVE));
    reads["/api/paper/books/claude2/positions"] = () => Promise.resolve({ available: true, book: CLAUDE2_ACTIVE, cash: 92000, lockouts: [], positions: [] });
    reads["/api/paper/books/claude2/orders"] = () => Promise.resolve({ available: true, orders: ORDERS });
    reads["/api/paper/books/claude2/fills"] = () => Promise.resolve({ available: true, fills: FILLS });
    reads["/api/paper/books/claude2/execution"] = () => Promise.resolve(execution("claude2", [], [{
      orderId: 71, decisionId: 9, ticker: "AAA", side: "BUY", status: "FILLED", timing: "AT_1000", asOfTradingDate: "2026-11-02",
      targetSession: "2026-11-03", targetAtKst: "2026-11-04 00:00", createdAtKst: "2026-11-03 07:41", fill: null,
      cf: {}, advantageBp: { AT_1000: 12.345 }, lagSeconds: null, lateResolved: true, executionNote: "개장 직후 변동성을 피함", auditedAtKst: null,
    }]));
  });

  it("주문 표에 목표 시각·계좌1식 대비·실행 메모, 체결 표에 체결 봉·사다리·계좌1식 대비와 대체 체결 배지", async () => {
    render(<PaperPage initialTab="holdings" />);
    fireEvent.change(await screen.findByLabelText("계좌 고르기"), { target: { value: "claude2" } });

    const orders = await screen.findByRole("table", { name: "주문" });
    await waitFor(() => expect(within(orders).getByText("+12.3bp")).toBeTruthy());
    expect(headersOf(orders)).toEqual(["낸 시각·기준일", "종목·방향", "크기", "체결 시점·목표 시각", "계좌1식 대비", "상태·만료·체결", "실행 메모·근거"]);
    expect(within(orders).getByText("다음 거래일 10:00 ET")).toBeTruthy();
    expect(within(orders).getByText("목표 2026-11-04 00:00")).toBeTruthy();
    expect(within(orders).getByText("개장 직후 변동성을 피함")).toBeTruthy();

    const fills = screen.getByRole("table", { name: "체결" });
    expect(headersOf(fills)).toEqual([
      "관측 시각·봉 날짜", "종목", "방향", "수량", "체결가·관측가(달러)", "체결 봉·사다리", "계좌1식 대비", "금액(달러)·슬리피지", "가격 출처",
    ]);
    expect(within(fills).getByText("R2b · 그 세션 T 뒤 첫 거래 봉 시가")).toBeTruthy();
    expect(within(fills).getByText("대체 체결")).toBeTruthy();
    expect(within(fills).getByText("+12.3bp")).toBeTruthy();
    expect(screen.getByText(/Claude 계좌2 주문은 다음 세션 하루짜리입니다/)).toBeTruthy();
  });

  // 수정 전에는 계좌2 표에만 줄바꿈 금지 칸(목표 시각·체결 봉·사다리)과 실행 메모 최소 폭이 더해져 표의 최소 폭이 카드를 넘었고(1280px에서 주문
  // 1,272·체결 1,241px > 상자 958px), 그때 브라우저가 모든 칸을 최소 폭으로 접어 '매수'를 한 글자씩·낸 시각과 체결 시점을 서너 줄로 접었다
  // (주문 행 157px·체결 행 77px — QA 스택 화면, 수정 전에는 it.fails).
  it("계좌2 표는 짧은 칸을 한 줄로, 글 칸(상태·실행 메모·근거·크기·사다리 이름)은 최소 폭을 두고 낱말 사이에서만 줄바꿈 — 넓으면 상자 안에서 가로로 넘김", async () => {
    render(<PaperPage initialTab="holdings" />);
    fireEvent.change(await screen.findByLabelText("계좌 고르기"), { target: { value: "claude2" } });

    const orders = await screen.findByRole("table", { name: "주문" });
    await waitFor(() => expect(within(orders).getByText("+12.3bp")).toBeTruthy());
    const classesOf = (table: HTMLElement) => {
      const cells = [...within(table).getAllByRole("row")[1].children];
      return Object.fromEntries(headersOf(table).map((header, index) => [header, cells[index].className]));
    };
    const order = classesOf(orders);
    for (const header of ["낸 시각·기준일", "종목·방향", "체결 시점·목표 시각", "계좌1식 대비"]) {
      expect(order[header], header).toContain("whitespace-nowrap");
    }
    for (const header of ["상태·만료·체결", "실행 메모·근거"]) {
      expect(order[header], header).toMatch(/min-w-\[[\d.]+rem\] break-keep/);
    }
    // 크기는 오른쪽 정렬 칸(줄바꿈 없음이 기본)이라 최소 폭을 두고 안의 글만 낱말 사이에서 접음('순자산의 5.00% 매수 (목표 8.00%)').
    expect(order["크기"]).toMatch(/min-w-\[[\d.]+rem\]/);
    expect(within(orders).getByText("순자산의 8.00% 매수").className).toContain("whitespace-normal break-keep");
    const fills = screen.getByRole("table", { name: "체결" });
    const fill = classesOf(fills);
    for (const [header, className] of Object.entries(fill)) {
      if (header === "체결 봉·사다리") continue;
      expect(className, header).toContain("whitespace-nowrap");
    }
    // 사다리 이름('R2b · 그 세션 T 뒤 첫 거래 봉 시가')만 최소 폭 안에서 낱말 사이로 접음 — 체결 봉 시각은 한 줄.
    expect(fill["체결 봉·사다리"]).toMatch(/min-w-\[[\d.]+rem\]/);
    expect(within(fills).getByText("R2b · 그 세션 T 뒤 첫 거래 봉 시가").className).toContain("break-keep");
    expect(within(fills).getByText("2026-11-04 00:00").className).toContain("whitespace-nowrap");
  });

  // 수정 전에는 계좌2 표가 값마다 한 칸이라(주문 열네 칸·체결 열세 칸) 1280px에서 주문 표 1,809px·체결 표 1,364px로 카드 안 표 상자(958px)를 넘어,
  // 8주 실험 동안 가장 자주 볼 계좌2 칸(계좌1식 대비·실행 메모·근거)이 가로 스크롤 오른쪽 밖에 숨었다(QA 스택 화면 — 수정 전에는 it.fails).
  // 이제 두 표 모두 1280px에서 958px(QA 스택에서 잼 — jsdom은 폭을 재지 못해 칸 구성으로 봄).
  it("계좌2 표는 한국 표처럼 두 줄 칸으로 묶어 계좌2 칸(계좌1식 대비·실행 메모·근거)을 앞쪽에 — 주문 일곱 칸·체결 아홉 칸", async () => {
    render(<PaperPage initialTab="holdings" />);
    fireEvent.change(await screen.findByLabelText("계좌 고르기"), { target: { value: "claude2" } });

    const orders = await screen.findByRole("table", { name: "주문" });
    await waitFor(() => expect(within(orders).getByText("+12.3bp")).toBeTruthy());
    expect(headersOf(orders)).toEqual(["낸 시각·기준일", "종목·방향", "크기", "체결 시점·목표 시각", "계좌1식 대비", "상태·만료·체결", "실행 메모·근거"]);
    expect(rowsOf(orders)).toEqual([[
      "2026-11-03 07:41기준 2026-11-02", "AAA매수", "순자산의 8.00% 매수", "다음 거래일 10:00 ET목표 2026-11-04 00:00", "+12.3bp",
      "체결Claude · 만료 2026-11-03체결 2026-11-04 01:10", "개장 직후 변동성을 피함근거 [사실] · 무효화: 조건",
    ]]);

    const fills = screen.getByRole("table", { name: "체결" });
    expect(headersOf(fills)).toEqual([
      "관측 시각·봉 날짜", "종목", "방향", "수량", "체결가·관측가(달러)", "체결 봉·사다리", "계좌1식 대비", "금액(달러)·슬리피지", "가격 출처",
    ]);
    expect(rowsOf(fills)).toEqual([[
      "2026-11-04 01:10봉 2026-11-03", "AAA대체 체결", "매수", "80", "100.0500관측 100.0000", "2026-11-04 00:00R2b · 그 세션 T 뒤 첫 거래 봉 시가",
      "+12.3bp", "8,004.00슬리피지 5.0bp", "—값 없음",
    ]]);
  });

  it("계좌1 표는 칸이 그대로 — 실행 감사를 읽지 않는다", async () => {
    reads["/api/paper/books/claude/positions"] = () => Promise.resolve({ available: true, book: book("claude", { kind: "CLAUDE", label: "Claude 계좌1" }), cash: 50, lockouts: [], positions: [] });
    reads["/api/paper/books/claude/orders"] = () => Promise.resolve({ available: true, orders: [] });
    reads["/api/paper/books/claude/fills"] = () => Promise.resolve({ available: true, fills: [] });
    render(<PaperPage initialTab="holdings" />);
    fireEvent.change(await screen.findByLabelText("계좌 고르기"), { target: { value: "claude" } });

    const orders = await screen.findByRole("table", { name: "주문" });
    expect(headersOf(orders)).toEqual(["낸 시각", "종목", "방향", "크기", "체결 시점", "출처", "상태", "기준 거래일", "만료", "체결 시각", "근거"]);
    expect(api.apiGetShared.mock.calls.map(([path]) => path)).not.toContain("/api/paper/books/claude/execution?limit=50");
  });
});
