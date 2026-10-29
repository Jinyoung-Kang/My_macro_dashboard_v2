/**
 * 🧪 모의매매(한국) 개요(/paper/kr, 2단계 명세 §4-16) — 네 상태 이야기(설계서 §9 DoD)와 한국 표기.
 *
 *  - 불러오는 중: 개요 응답 전에는 '장부를 읽는 중…'(제목은 '(한국)')
 *  - 쉬는 한국: 정기 작업이 쉬는 사유(dormantReason)를 맨 위 경고로, 계좌가 없으면 한국 초기화 안내 — 숫자를 짓지 않음
 *  - 오류: 개요를 못 읽으면 오류 + 다시 시도(누르면 다시 읽음)
 *  - 자료: 네 계좌 행·비교 표는 원 단위 정수, 한계 문구(§6) 카드, 미국 전용 카드(초기화·사후 체결 대기·계좌 시작·신호 기관·OS 게이트)는
 *    없고, 한국 벤치마크가 '시작 전'이어도 사후 체결 대기 경고가 없다. 개요·상태는 ?market=KR 경로
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
// jsdom에서는 recharts가 크기 0이라 그리지 않습니다 — 계열 이름·자릿수·축 폭만 목록으로.
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: ({ data, series, unit, axisWidth }: {
    data: Record<string, unknown>[]; series: { key: string; name: string; valueDigits?: number; dashed?: boolean }[]; unit?: string;
    axisWidth?: number;
  }) => (
    <ul aria-label={unit === "%" ? "노출 계열" : "순자산 계열"} data-rows={data.length} data-axis-width={axisWidth ?? ""}>
      {series.map((entry) => (
        <li key={entry.key} data-digits={entry.valueDigits ?? ""} data-dashed={entry.dashed ? "yes" : "no"}
          data-values={data.map((row) => String(row[entry.key] ?? "null")).join(",")}>
          {entry.name}
        </li>
      ))}
    </ul>
  ),
  DonutChart: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";
import { PENDING_BACKFILL_WARNING } from "@/lib/paperOverview";

const STATS = { cumReturnPct: 0.31, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 2 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-29", initialCash: 100_000_000,
    cash: 34_000, nav: 100_312_450, equityValue: 100_278_450, exposurePct: 99.97, returnPct: 0.31,
    lastObservedAtKst: "2026-10-30 22:05 KST", positions: 1, staleCount: 0, stats: STATS, statsReason: null,
    benchmark: "kr_bench_k200", ...over,
  };
}

const KR_BOOKS = [
  book("kr_rules", { kind: "RULES", label: "한국 규칙 계좌", positions: 12 }),
  book("kr_claude", { kind: "CLAUDE", label: "한국 Claude 계좌" }),
  book("kr_bench_k200", { label: "KODEX 200 계좌", benchmark: null }),
  book("kr_bench_mix", { label: "한국 60/40 계좌", positions: 2 }),
];

const KR_LIMITS = [
  "모의 매매입니다. 어떤 주문도 밖으로 나가지 않습니다.",
  "미국·한국 책은 출발일·비용 모형·체결 시점·스탑 집행·통화가 달라 수익률을 서로 비교하지 않습니다.",
];

const KR_OVERVIEW = {
  available: true, market: "KR", currency: "KRW", dormantReason: null, initialized: true, pendingBackfill: [],
  startDate: "2026-10-29", books: KR_BOOKS,
  navSeries: {
    dates: ["2026-10-29", "2026-10-30"],
    books: { kr_rules: [100_000_000, 100_312_450], kr_claude: [100_000_000, 100_312_450],
      kr_bench_k200: [100_000_000, 100_312_450], kr_bench_mix: [100_000_000, 100_312_450] },
  },
  quotes: { collectedAtKst: "2026-10-30 22:05 KST", ageSeconds: 600, barDate: "2026-10-30", finalClose: true, tickers: 103,
    staleTickers: [], stale: false },
  selection: null, gate: null, claudeExposureSeries: [], frameworkBoundaries: [], limits: KR_LIMITS, jobs: [],
};

const DORMANT = {
  available: true, market: "KR", currency: "KRW",
  dormantReason: "한국 책 출발일(dashboard.paper.kr.start-date — .env PAPER_KR_START_DATE)이 비어 있어 한국 초기화·출발을 하지 않습니다",
  initialized: false, pendingBackfill: [], startDate: null, books: [], navSeries: { dates: [], books: {} }, quotes: null,
  selection: null, gate: null, claudeExposureSeries: [], frameworkBoundaries: [], limits: KR_LIMITS, jobs: [],
};

const KR_STATUS = { available: true, market: "KR", currency: "KRW", dormantReason: null, schemaReady: true, initialized: true,
  enabled: true, jobs: [], settingsVersion: 4 };

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};

beforeEach(() => {
  reads = {};
  window.history.replaceState(null, "", "/paper/kr");
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

const requested = () => api.apiGetShared.mock.calls.map(([path]) => String(path));

/** 계좌 비교 표의 칸(항목 줄 × 계좌 열). */
function comparisonCell(metric: string, account: string): HTMLElement {
  const table = screen.getByRole("table", { name: "계좌 비교" });
  const column = within(table).getAllByRole("columnheader").findIndex((th) => th.textContent === account);
  const line = within(table).getAllByRole("row").find((tr) => within(tr).queryByRole("rowheader")?.textContent === metric);
  if (!line || column < 0) throw new Error(`칸 없음: ${metric} × ${account}`);
  return line.children[column] as HTMLElement;
}

describe("불러오는 중", () => {
  it("개요 응답 전에는 읽는 중 표시 — 제목은 '(한국)', 개요는 ?market=KR로 읽는다", () => {
    render(<PaperPage market="KR" />);
    expect(screen.getByRole("heading", { name: "모의 알고리즘 매매(한국)" })).toBeTruthy();
    expect(screen.getByText("장부를 읽는 중…")).toBeTruthy();
    expect(requested()).toContain("/api/paper/overview?market=KR");
    expect(requested()).not.toContain("/api/paper/overview");
  });
});

describe("쉬는 한국", () => {
  it("dormantReason을 맨 위 경고로 적고, 계좌가 없으면 한국 초기화 안내 — 계좌 행·비교 표는 없다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(DORMANT);
    render(<PaperPage market="KR" />);

    expect(await screen.findByText(/한국 책이 쉬고 있습니다/)).toBeTruthy();
    expect(screen.getByText(/PAPER_KR_START_DATE/)).toBeTruthy();
    expect(screen.getByText(/한국 계좌가 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("table", { name: "계좌 비교" })).toBeNull();
    // 한계 문구(§6)는 쉬어도 보입니다.
    expect(screen.getByText("이 장부의 한계")).toBeTruthy();
    expect(screen.getByText(/수익률을 서로 비교하지 않습니다/)).toBeTruthy();
  });
});

describe("오류", () => {
  it("개요를 못 읽으면 오류와 다시 시도 — 누르면 다시 읽는다", async () => {
    let calls = 0;
    reads["/api/paper/overview?market=KR"] = () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error("개요를 읽지 못했습니다.")) : Promise.resolve(KR_OVERVIEW);
    };
    render(<PaperPage market="KR" />);

    expect(await screen.findByText("개요를 읽지 못했습니다.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByRole("button", { name: "한국 규칙 계좌 상세 보기" })).toBeTruthy();
  });
});

describe("자료", () => {
  it("네 계좌 행·비교 표는 원 단위 정수, 한계 문구 카드, 미국 전용 카드와 사후 체결 대기 경고는 없다", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({
      ...KR_OVERVIEW,
      // 한국 pendingBackfill은 '시작 전 벤치마크'일 뿐 — 초기화를 다시 눌러 체결하지 않으므로 경고를 달지 않습니다.
      pendingBackfill: ["kr_bench_k200", "kr_bench_mix"],
    });
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(KR_STATUS);
    render(<PaperPage market="KR" />);

    const rules = await screen.findByRole("button", { name: "한국 규칙 계좌 상세 보기" });
    expect(within(rules).getByText("100,312,450")).toBeTruthy();
    expect(within(rules).getByText("원")).toBeTruthy();
    expect(within(rules).getByText("+0.31%")).toBeTruthy();
    expect(within(rules).getByText(/^규칙 · 운용 중 · 외국인·기관이 함께 사는/)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "계좌 목록" })).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.queryByText(PENDING_BACKFILL_WARNING)).toBeNull();

    expect(comparisonCell("처음 현금", "한국 규칙 계좌").textContent).toBe("100,000,000원");
    expect(comparisonCell("순자산", "KODEX 200 계좌").textContent).toBe("100,312,450원");
    expect(comparisonCell("현금", "한국 60/40 계좌").textContent).toBe("34,000원");
    expect(comparisonCell("비교 기준", "한국 규칙 계좌").textContent).toBe("KODEX 200 계좌");

    // 순자산 곡선: 네 계좌 계열·툴팁 0자리·넓은 축(원 단위 정수 눈금)
    const nav = screen.getByRole("list", { name: "순자산 계열" });
    expect(within(nav).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "한국 규칙 계좌", "한국 Claude 계좌", "KODEX 200 계좌", "한국 60/40 계좌",
    ]);
    expect(within(nav).getAllByRole("listitem").every((li) => li.getAttribute("data-digits") === "0")).toBe(true);
    expect(nav.getAttribute("data-axis-width")).toBe("84");
    expect(screen.getByText(/KR 거래일별 순자산\(원\)/)).toBeTruthy();

    // 한계 문구(§6)
    const limits = screen.getByText("이 장부의 한계").closest("section") ?? document.body;
    expect(within(limits).getByText(/수익률을 서로 비교하지 않습니다/)).toBeTruthy();

    // 미국 전용 카드는 없음
    for (const title of ["신호 기관", "OS 게이트 지표", "장부 초기화", "벤치마크 사후 체결 대기"]) {
      expect(screen.queryByText(title), title).toBeNull();
    }
    expect(screen.queryByRole("button", { name: /Claude 계좌 시작|미리보기/ })).toBeNull();
    // 한국 수집 상태 카드 — 이 상태 응답에는 collection이 없어(F2 전 서버) 관측치 한 줄만, 한국 표기(KR 거래일·종목)
    expect(await screen.findByText(/관측치 한 줄만: 봉 날짜 2026-10-30\(KR 거래일\) · 종목 103개 · 지난 값 이어받음 0개/)).toBeTruthy();
    expect(screen.queryByText("장부 관측치")).toBeNull();
    await waitFor(() => expect(requested()).toContain("/api/paper/status?market=KR"));
    expect(requested()).not.toContain("/api/paper/status");
    // 미국 책 낱말(13F·SHY·SPY·사후 체결)이 한국 개요에 섞이지 않음 — 출처·안내 문구까지.
    expect(document.body.textContent).not.toMatch(/13F|SHY|SPY|사후 체결/);
    expect(screen.getByText(/아직 한국 Claude 결정 기록이 없습니다/)).toBeTruthy();
  });

  it("계좌 상세: 한국 정의·원 단위 체결 머리·현금성 153130", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(KR_OVERVIEW);
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(KR_STATUS);
    reads["/api/paper/books/kr_bench_mix/positions"] = () => Promise.resolve({
      available: true, book: KR_BOOKS[3], cash: 34_000, lockouts: [],
      positions: [
        { ticker: "069500", qty: 600, avgCost: 100_000, lastPrice: 100_500, lastPriceAtKst: null, marketValue: 60_300_000,
          weightPct: 60.11, unrealizedPct: 0.5, highWatermark: null, stopPrice: null, stopDistancePct: null, openedOn: "2026-10-30",
          holdingTradingDays: 0, priceStale: false, splitNote: null, cashLike: false, backfilled: false },
      ],
    });
    reads["/api/paper/books/kr_bench_mix/fills"] = () => Promise.resolve({
      available: true,
      fills: [{ id: 1, orderId: 1, ticker: "069500", side: "BUY", qty: 600, price: 100_000, rawPrice: 100_000, slippageBp: 5,
        gross: 60_000_000, observedAtKst: "2026-10-30 22:05 KST", observationDate: "2026-10-30", priceSource: "TOSS_1M_OPEN",
        backfill: false }],
    });
    reads["/api/paper/settings"] = () => Promise.resolve({ available: true, version: 4, body: { kr: { slippageBp: 5, commissionBp: 1.5 } } });
    render(<PaperPage market="KR" />);

    fireEvent.click(await screen.findByRole("button", { name: "한국 60/40 계좌 상세 보기" }));
    const panel = await screen.findByRole("region", { name: "한국 60/40 계좌 상세" });
    expect(within(panel).getByText(/069500 60%·153130 40%를 사서/)).toBeTruthy();
    expect(within(panel).getByText("현금성(153130) 포함")).toBeTruthy();
    expect(await within(panel).findByRole("columnheader", { name: "체결가(원)" })).toBeTruthy();
    expect(within(panel).getByRole("columnheader", { name: "금액(원)" })).toBeTruthy();
    expect(await within(panel).findByText("60,000,000")).toBeTruthy();
    expect(within(panel).getByText("100,000")).toBeTruthy();
    expect(await within(panel).findByText("1.5bp")).toBeTruthy();
  });
});

describe("계좌 상세의 최근 체결(한국 — 잠정·확정)", () => {
  // 수정 전에는 미국 배지(사후 체결만)와 '체결가(원)'을 써, 토스 잠정가가 확정 여부 표시 없이 체결가로 보였습니다(it.fails).
  it.fails("머리는 '잠정 체결가(원)'·'잠정 금액(원)', 확정 상태 배지(확정·확정 대기), 확정 행은 확정가를 그 아래", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(KR_OVERVIEW);
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(KR_STATUS);
    reads["/api/paper/books/kr_rules/positions"] = () => Promise.resolve({ available: true, book: KR_BOOKS[0], cash: 34_000, lockouts: [],
      positions: [] });
    const fill = { orderId: 1, side: "BUY", qty: 10, rawPrice: 71_300, slippageBp: 5, observedAtKst: "2026-10-30 22:05 KST",
      observationDate: "2026-10-30", backfill: false, fee: 106, tax: 0, slippageCost: 356, costBp: 6.48 };
    reads["/api/paper/books/kr_rules/fills"] = () => Promise.resolve({
      available: true, confirmationTotal: { rows: 1, cashDelta: 1_000, unconfirmed: 1 },
      fills: [
        { ...fill, id: 1, ticker: "005930", price: 71_300, gross: 713_000, priceSource: "TOSS_1M_OPEN", confirmationState: "CONFIRMED",
          confirmationNote: null, confirmation: { confirmedPrice: 71_200, priceDiff: -100, fee: 106, tax: 0, slippageCost: 356, costBp: 6.49,
            cashDelta: 1_000, source: "FSC", reconciledAtKst: "2026-11-02 22:05 KST" } },
        { ...fill, id: 2, ticker: "000660", price: 200_000, gross: 2_000_000, priceSource: "TOSS_INTEGRATED", confirmationState: "WAITING",
          confirmationNote: "금융위 2026-10-29까지 냄 — 그날 값 기다림", confirmation: null },
      ],
    });
    reads["/api/paper/settings"] = () => Promise.resolve({ available: true, version: 4, body: { kr: {} } });
    render(<PaperPage market="KR" />);

    fireEvent.click(await screen.findByRole("button", { name: "한국 규칙 계좌 상세 보기" }));
    const panel = await screen.findByRole("region", { name: "한국 규칙 계좌 상세" });
    const table = await within(panel).findByRole("region", { name: "최근 체결 (좌우 스크롤)" });
    expect(within(table).getByRole("columnheader", { name: "잠정 체결가(원)" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "잠정 금액(원)" })).toBeTruthy();
    const row = (ticker: string) => within(table).getAllByRole("row").find((tr) => tr.textContent?.includes(ticker)) as HTMLElement;
    expect(within(row("005930")).getByText("확정")).toBeTruthy();
    expect(within(row("005930")).getByText("71,300")).toBeTruthy();
    expect(within(row("005930")).getByText("확정 71,200원")).toBeTruthy();
    expect(within(row("000660")).getByText("확정 대기")).toBeTruthy();
    expect(within(row("000660")).getByText("KRX+NXT 통합가 · 잠정")).toBeTruthy();
    expect(within(row("000660")).queryByText(/^확정 \d/)).toBeNull();
  });
});

const WAITING_BOOKS = KR_BOOKS.map((entry) => ({
  ...entry, status: "NOT_STARTED", startedOn: null, nav: 100_000_000, cash: 100_000_000, returnPct: null, stats: null,
}));

describe("출발 상태(초기화·출발 단추)", () => {
  it("초기화 전(출발일은 있음)에만 '한국 초기화' — POST init?market=KR, 결과 줄", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({ ...DORMANT, dormantReason: "한국 계좌가 없습니다 — 한국 초기화를 누르세요", startDate: "2026-10-29" });
    api.apiPost.mockResolvedValue({ ok: true, market: "KR", startDate: "2026-10-29", created: ["kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix"],
      settingsCreated: false, settingsVersion: 4, settingsKeysWritten: [] });
    render(<PaperPage market="KR" />);

    fireEvent.click(await screen.findByRole("button", { name: "한국 초기화" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/paper/init?market=KR"));
    expect(await screen.findByText(/만든 계좌 kr_rules, kr_claude, kr_bench_k200, kr_bench_mix · 설정 그대로\(v4\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "출발 지금 실행" })).toBeNull();
  });

  it("초기화 400은 서버 문구 그대로", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({ ...DORMANT, startDate: "2026-10-31" });
    api.apiPost.mockRejectedValue(new Error("한국 출발일 2026-10-31은 KRX 거래일이 아닙니다"));
    render(<PaperPage market="KR" />);
    fireEvent.click(await screen.findByRole("button", { name: "한국 초기화" }));
    expect(await screen.findByText("한국 출발일 2026-10-31은 KRX 거래일이 아닙니다")).toBeTruthy();
  });

  it("쉬는 한국(출발일 없음)에는 초기화·출발 단추가 없다 — 정기 작업 꺼짐 배너도 없는 단추를 가리키지 않음", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(DORMANT);
    reads["/api/paper/status?market=KR"] = () => Promise.resolve({ ...KR_STATUS, initialized: false, enabled: false });
    render(<PaperPage market="KR" />);
    expect(await screen.findByText("쉬는 동안에는 초기화·출발 단추가 없습니다")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /한국 초기화|출발 지금 실행|리스크 지금 실행/ })).toBeNull();
    expect(await screen.findByText(/한국 리스크 점검·결정·출발도 정기적으로 돌지 않습니다/)).toBeTruthy();
    expect(screen.queryByText(/리스크 지금 실행.을 누를 때만/)).toBeNull();
  });

  it("출발 대기: 결정 창(설정)·최근 출발 기록·수동 문턱, 확인 뒤 본문 없이 POST initial-decision?market=KR — ALREADY_STARTED 표시", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({
      ...KR_OVERVIEW, books: WAITING_BOOKS, pendingBackfill: ["kr_bench_k200", "kr_bench_mix"],
      jobs: [{ job: "kr.decision", startedAtKst: "2026-10-29 22:30 KST", finishedAtKst: "2026-10-29 22:50 KST", outcome: "START_WAITING",
        detail: { start: true, tradingDate: "2026-10-29", checks: 3, reason: "⑤ 069500 D 봉 없음" } }],
    });
    reads["/api/paper/status?market=KR"] = () => Promise.resolve({
      ...KR_STATUS, apiUsage: { today: { day: "2026-10-29", calls: 2, cap: 20, scheduledReserve: 7, manualLimit: 13, inputTokens: 0,
        outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, month: { month: "2026-10", days: 1, calls: 2, inputTokens: 0,
        outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    });
    reads["/api/paper/settings"] = () => Promise.resolve({ available: true, version: 4,
      body: { kr: { decisionTimeKst: "22:30", decisionDeadlineKst: "01:00" } } });
    api.apiPost.mockResolvedValue({ ok: true, market: "KR", outcome: "ALREADY_STARTED", tradingDate: "2026-10-29", message: null,
      decisions: [], books: [], record: null });
    render(<PaperPage market="KR" />);

    expect(await screen.findByText("출발일 2026-10-29 · 결정 창 22:30 ~ 01:00(다음 날) KST")).toBeTruthy();
    expect(screen.getByText(/최근 출발 기록: 2026-10-29 22:30 START_WAITING · 세션 2026-10-29 · 이어진 주기 3번 · 사유 ⑤ 069500 D 봉 없음/))
      .toBeTruthy();
    expect(screen.queryByText("벤치마크 사후 체결 대기")).toBeNull();
    expect(document.body.textContent).not.toMatch(/13F|SHY|SPY|사후 체결/);
    fireEvent.click(screen.getByRole("button", { name: "출발 지금 실행" }));
    const dialog = await screen.findByRole("dialog", { name: "한국 출발을 지금 실행할까요?" });
    await waitFor(() => expect(within(dialog).getByText(/수동 문턱 13회 안에서만, 오늘 2회 씀/)).toBeTruthy());
    expect(api.apiPost).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "출발 실행" }));

    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(1));
    expect(api.apiPost.mock.calls[0]).toEqual(["/api/paper/run/initial-decision?market=KR"]);
    expect(await screen.findByText("이미 출발했습니다(2026-10-29) — 아무것도 하지 않았습니다")).toBeTruthy();
  });

  it("출발이 미뤄지면 경고색으로 서버 문구와 미룬 날·과금 호출", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({ ...KR_OVERVIEW, books: WAITING_BOOKS });
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(KR_STATUS);
    api.apiPost.mockResolvedValue({ ok: false, market: "KR", outcome: "START_POSTPONED", tradingDate: "2026-10-29",
      message: "Claude 출발 호출 실패 — 다음 KR 거래일로", decisions: [], books: [],
      record: { start: true, tradingDate: "2026-10-29", postponedTo: "2026-10-30", calls: { kr_claude: { calls: 2 } } } });
    render(<PaperPage market="KR" />);

    fireEvent.click(await screen.findByRole("button", { name: "출발 지금 실행" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "출발 실행" }));
    expect(await screen.findByText("출발을 다음 KR 거래일로 미뤘습니다(2026-10-29) — Claude 출발 호출 실패 — 다음 KR 거래일로")).toBeTruthy();
    expect(screen.getByText(/다음 KR 거래일 2026-10-30로 미룸 · 과금 호출 kr_claude 2회/)).toBeTruthy();
  });

  it("리스크 지금 실행은 한국 경로 — 쉬는 사유면 그 사유를 경고로, 단추 설명(실패 기억 복구 경로)", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({ ...KR_OVERVIEW, books: WAITING_BOOKS });
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(KR_STATUS);
    api.apiPost.mockResolvedValue({ ok: false, market: "KR", dormantReason: "한국 계좌가 없습니다",
      outcome: { filled: 0, stopped: 0, expired: 0, splits: 0, booksProcessed: [], skippedReason: "쉼", notes: [], errors: [] } });
    render(<PaperPage market="KR" />);

    expect(await screen.findByText(/한국 장부의 실패 기억을 지우고 같은 관측치를 다시 처리합니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "리스크 지금 실행" }));
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/risk?market=KR"));
    expect(await screen.findByText("한국 책이 쉬고 있어 리스크 점검을 하지 않았습니다 — 한국 계좌가 없습니다")).toBeTruthy();
  });
});

describe("작업 기록 카드(한국)", () => {
  it("기다림 줄의 이어진 주기·사유, 출발 미룸의 과금 호출·미룬 날이 상세 앞에 — 부제는 기다림 줄도 남긴다고", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({
      ...KR_OVERVIEW,
      jobs: [
        { job: "kr.decision", startedAtKst: "2026-10-30 22:30 KST", finishedAtKst: "2026-10-30 23:10 KST", outcome: "DATA_NOT_READY",
          detail: { tradingDate: "2026-10-30", checks: 5, waiting: "자료 게이트 미달: ② — 기한까지 다음 주기에 다시 봅니다",
            gates: [{ gate: "②", status: "FAIL", note: "관측치 없음" }] } },
        { job: "kr.decision", startedAtKst: "2026-10-30 01:00 KST", finishedAtKst: "2026-10-30 01:00 KST", outcome: "START_POSTPONED",
          detail: { start: true, tradingDate: "2026-10-29", configuredStartDate: "2026-10-29", postponed: false,
            postponedTo: "2026-10-30", reason: "출발 계획 실패", calls: { kr_claude: { calls: 2 } } } },
      ],
    });
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(KR_STATUS);
    render(<PaperPage market="KR" />);

    const table = await screen.findByRole("region", { name: "작업 기록 (좌우 스크롤)" });
    expect(within(table).getByText("세션 2026-10-30 · 이어진 주기 5번 · 자료 게이트 미달: ② — 기한까지 다음 주기에 다시 봅니다")).toBeTruthy();
    expect(within(table).getByText(/다음 KR 거래일 2026-10-30로 미룸 · 사유 출발 계획 실패 · 과금 호출 kr_claude 2회/)).toBeTruthy();
    expect(screen.getByText(/한국 결정·출발이 자료를 기다린 세션마다 한 줄/)).toBeTruthy();
  });
});

describe("한국 수집 상태 카드(x4)", () => {
  const COLLECTION = {
    quotes: { task: "kr_paper_quotes", dataset: "paper.kr.quotes", available: true, collectedAtKst: "2026-10-30 22:05 KST",
      session: "2026-10-30", universeDate: "2026-10-29", scope: 103, stale: false, staleReason: null },
    flows: { task: "kr_paper_flows", dataset: "kr.paper_flows.status", available: true, collectedAtKst: "2026-10-30 22:10 KST",
      session: "2026-10-30", universeDate: "2026-10-29", scope: 103, ok: 101, sessionMiss: 0, noRecords: 1, carried: 0, missing: 1,
      stale: true, staleReason: null },
    universe: { available: true, baseDate: "2026-10-29", size: 100, behind: false, behindReason: null },
    dart: { available: true, collectedAtKst: "2026-10-29 01:10 KST", universe: 174, krScope: 101, unmapped: 44, stale: false },
    news: { available: true, lastFetchKst: "2026-10-30 21:58 KST", stored7d: 387, feedsOk: 4, feedsTotal: 4, failedFeeds: [], stale: false },
    calendar: { available: false, generatedAtKst: null, macroCount: null, unconfirmed: null, horizonTo: null, stale: null },
    fsc: { tasks: ["fsc_prices", "fsc_etf_prices"], available: true, stocksLatestBasDt: "2026-10-29", etfsLatestBasDt: "2026-10-29",
      metaCollectedAtKst: "2026-10-30 22:00 KST", etfBehind: false },
  };

  it("미국 '장부 관측치' 자리에 일곱 줄 표 — 상태 글(정상·늦음·없음)과 사유, 출처는 토스증권·금융위원회(공공데이터포털)", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(KR_OVERVIEW);
    reads["/api/paper/status?market=KR"] = () => Promise.resolve({ ...KR_STATUS, collection: COLLECTION });
    render(<PaperPage market="KR" />);

    const table = await screen.findByRole("region", { name: "한국 수집 상태 (좌우 스크롤)" });
    expect(within(table).getAllByRole("rowheader").map((th) => th.textContent?.replace(/(토스증권|금융위원회|금융감독원|RSS|상수).*/, "")))
      .toEqual(["관측치", "수급", "유니버스", "재무(DART)", "사건 뉴스", "거시 일정", "확정 시세"]);
    expect(within(table).getAllByText("정상")).toHaveLength(5);
    expect(within(table).getByText("늦음")).toBeTruthy();
    expect(within(table).getByText("없음")).toBeTruthy();
    expect(within(table).getByText("범위 103종목 · 받은 103종목 · 이어받음 0 · 봉 2026-10-30")).toBeTruthy();
    expect(screen.getByText(/토스증권 Open API\(관측치·수급\) · 금융위원회\(공공데이터포털/)).toBeTruthy();
  });

  it("상태 응답이 실패하면 이 카드만 오류·다시 시도 — 계좌 행은 개요 그대로", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(KR_OVERVIEW);
    reads["/api/paper/status?market=KR"] = () => Promise.reject(new Error("상태를 읽지 못했습니다."));
    render(<PaperPage market="KR" />);

    expect(await screen.findByText("한국 수집 상태를 읽지 못했습니다 — 상태를 읽지 못했습니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "한국 규칙 계좌 상세 보기" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "다시 시도" }).length).toBeGreaterThan(0);
  });

  it("사용량 카드: 수동 호출 문턱 칸, 문턱에 닿으면 수동 호출 거절 안내", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve(KR_OVERVIEW);
    reads["/api/paper/status?market=KR"] = () => Promise.resolve({
      ...KR_STATUS, apiUsage: { today: { day: "2026-10-30", calls: 13, cap: 20, scheduledReserve: 7, manualLimit: 13, inputTokens: 0,
        outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, month: { month: "2026-10", days: 2, calls: 15, inputTokens: 0,
        outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    });
    render(<PaperPage market="KR" />);

    expect(await screen.findByText("13회(하루 상한 20 − 정기 작업 몫 7)")).toBeTruthy();
    expect(screen.getByText(/오늘 호출이 수동 호출 문턱에 닿았습니다/)).toBeTruthy();
    expect(screen.getByText(/하루 상한은 미국·한국 책이 함께 쓰고/)).toBeTruthy();
  });
});

describe("노출 맞춘 참고선(K40)", () => {
  it("순자산 곡선에 점선 계열 '노출 맞춘 참고선(계좌 아님)' — 날짜로 맞춘 값·멈춘 사유 글, 참고선이 null이면 계열·글 없음", async () => {
    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({
      ...KR_OVERVIEW,
      exposureReference: {
        label: "노출 맞춘 참고선 — 계좌 아님", basis: "…", note: "…", dates: ["2026-10-29", "2026-10-30"],
        values: [100_000_000, 100_100_000], stockWeightPct: [null, 0], asOfDate: "2026-10-30",
        stoppedReason: "2026-10-30 규칙 계좌 주식 비중을 모릅니다(그날 규칙 계좌 결정의 보유 비중이 없음 — 기한 지남·일시정지·비중 모름 등) — 그 뒤는 그리지 않습니다",
      },
    });
    reads["/api/paper/status?market=KR"] = () => Promise.resolve(KR_STATUS);
    const view = render(<PaperPage market="KR" />);

    const nav = await screen.findByRole("list", { name: "순자산 계열" });
    const reference = within(nav).getByText("노출 맞춘 참고선(계좌 아님)");
    expect(reference.getAttribute("data-dashed")).toBe("yes");
    expect(reference.getAttribute("data-digits")).toBe("0");
    expect(reference.getAttribute("data-values")).toBe("100000000,100100000");
    expect(within(nav).getByText("한국 규칙 계좌").getAttribute("data-dashed")).toBe("no");
    // 곡선 아래 노출 문구(미국과 같은 함수 — 한국은 153130·참고선).
    expect(screen.getByText(/^규칙 계좌 결과는 종목 신호와 주식 노출\(후보가 모자란 만큼과 남는 현금은 153130\)이 섞인 값입니다/)).toBeTruthy();
    const notes = screen.getByRole("list", { name: "노출 맞춘 참고선 설명" });
    expect(within(notes).getByText(/^멈춤: 2026-10-30 규칙 계좌 주식 비중을 모릅니다/)).toBeTruthy();
    expect(within(notes).getByText(/전날 규칙 계좌 주식 비중 0\.00%/)).toBeTruthy();
    view.unmount();

    reads["/api/paper/overview?market=KR"] = () => Promise.resolve({ ...KR_OVERVIEW, exposureReference: null });
    render(<PaperPage market="KR" />);
    const plain = await screen.findByRole("list", { name: "순자산 계열" });
    expect(within(plain).queryByText("노출 맞춘 참고선(계좌 아님)")).toBeNull();
    expect(screen.queryByRole("list", { name: "노출 맞춘 참고선 설명" })).toBeNull();
  });
});
