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
    data: { date: string }[]; series: { key: string; name: string; valueDigits?: number }[]; unit?: string; axisWidth?: number;
  }) => (
    <ul aria-label={unit === "%" ? "노출 계열" : "순자산 계열"} data-rows={data.length} data-axis-width={axisWidth ?? ""}>
      {series.map((entry) => <li key={entry.key} data-digits={entry.valueDigits ?? ""}>{entry.name}</li>)}
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
    // 관측치 줄은 한국 표기(KR 거래일·종목)
    expect(screen.getByText("봉 날짜 2026-10-30(KR 거래일) · 종목 103개 · 지난 값 이어받음 0개")).toBeTruthy();
    await waitFor(() => expect(requested()).toContain("/api/paper/status?market=KR"));
    expect(requested()).not.toContain("/api/paper/status");
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
