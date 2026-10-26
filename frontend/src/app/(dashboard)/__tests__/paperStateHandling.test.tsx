/**
 * 🧪 모의 알고리즘 매매 화면의 상태 — 테이블이 없을 때·초기화 전·값을 모를 때 지어내지 않고 그대로 말한다.
 *
 *  - available:false면 서버 문구 그대로(탭·계좌 행 없음)
 *  - 초기화 전이면 "초기화" 버튼 → POST /api/paper/init → 결과 문구 + 개요 다시 읽기
 *  - 벤치마크가 종가를 못 받아 시작 전이면(200 + skipped → pendingBackfill) 초기화 카드·버튼이 남는다
 *  - 리스크 실행이 ok:false면 경고 배너에 오류, 처리 메모는 목록 / 책 초기화의 사후 체결 실패 사유는 경고
 *  - 주당 가격은 소수 4자리(싼 종목의 5bp 슬리피지가 보이게)
 *  - 숫자 null은 "—"(0.00으로 채우지 않음), 가격 없는 보유는 배지 — 개요는 계좌 행 + 계좌 비교 표(예전 카드의 칸)
 *  - 책 초기화는 확인 창에서 책 코드를 정확히 입력해야 눌린다(창은 결과가 나온 뒤 닫힘)
 *  - 주문 표의 근거는 문장(reason.text)을 자르지 않고 먼저 — 없으면 키: 값 요약, 전체 JSON은 title, 근거가 없으면 "—"(값 없음)
 *  - 보유 표 정렬(종목·수량·평가액·비중·평가 손익 — 모르는 값은 맨 뒤), 재진입 금지 표의 행
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
// jsdom에서는 차트 크기가 0이라 recharts가 아무것도 그리지 않습니다 — 계열 이름과 행 수만 목록으로 그립니다.
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: ({ data, series }: { data: unknown[]; series: { key: string; name: string }[] }) => (
    <ul aria-label="순자산 계열" data-rows={data.length}>
      {series.map((entry) => <li key={entry.key}>{entry.name}</li>)}
    </ul>
  ),
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const LIMITS = [
  "모의 매매입니다. 어떤 주문도 밖으로 나가지 않습니다.",
  "체결가는 최대 1시간 묵은 지연 시세입니다.",
];

const STATS = { cumReturnPct: null, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 0 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 50.12, nav: 100050.12, equityValue: 100000, exposurePct: 99.95, returnPct: 0.05,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: null, ...over,
  };
}

const INITIALIZED = {
  available: true,
  initialized: true,
  startDate: "2026-10-23",
  limits: LIMITS,
  books: [
    book("rules", { kind: "RULES", label: "규칙 계좌", status: "NOT_STARTED", startedOn: null, benchmark: "bench_spy" }),
    // 값을 모르는 책 — 순자산·수익률·노출·통계가 전부 null
    book("claude", {
      kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null, benchmark: "bench_spy",
      cash: null, nav: null, equityValue: null, exposurePct: null, returnPct: null, positions: null, staleCount: null, stats: null,
    }),
    book("bench_spy", { label: "SPY 계좌" }),
    book("bench_mix", { label: "60/40 계좌", benchmark: "bench_spy" }),
  ],
  navSeries: { dates: ["2026-10-23"], books: { rules: [null], claude: [null], bench_spy: [100000], bench_mix: [100000] } },
  quotes: {
    collectedAtKst: "2026-10-24 05:10", ageSeconds: 300, barDate: "2026-10-23", finalClose: true, tickers: 157, staleTickers: [],
    stale: false,
  },
  jobs: [],
  pendingBackfill: [],
};

/** 책 네 개는 만들었지만 출발일 종가가 없어 두 벤치마크가 시작 전으로 남은 개요(init이 200 + skipped를 준 뒤). */
const PENDING = {
  ...INITIALIZED,
  books: INITIALIZED.books.map((entry) => (entry.kind === "BENCHMARK"
    ? { ...entry, status: "NOT_STARTED", startedOn: null, positions: 0, equityValue: 0, exposurePct: 0, cash: 100000, nav: 100000 }
    : entry)),
  navSeries: { dates: [], books: { rules: [], claude: [], bench_spy: [], bench_mix: [] } },
  pendingBackfill: ["bench_spy", "bench_mix"],
};

const SKIP_REASON = "2026-10-23 SPY 종가가 아직 없습니다(10년 이력 equity_close·관측치 paper.quotes) — 수집기가 받은 뒤 초기화를 다시 누르세요.";

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다("/api/paper/books/x/status" ≠ "/api/paper/status"). */
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

/** Empty 패턴(DataTable의 모르는 칸) — 보이는 "—" + 읽어 주는 "값 없음"(sr-only). */
const NONE = "—값 없음";

/**
 * 계좌 비교 표의 칸 글(항목 줄 × 계좌 열). 줄이나 열이 없으면 null. 항목 이름은 행 머리(th scope=row)라 줄은 rowheader로 찾고,
 * 칸은 DOM 순서(행 머리 + 계좌 칸)로 열 머리와 같은 자리에서 꺼냅니다.
 */
function comparisonCell(metric: string, account: string): string | null {
  const table = screen.getByRole("table", { name: "계좌 비교" });
  const column = within(table).getAllByRole("columnheader").findIndex((th) => th.textContent === account);
  const row = within(table).getAllByRole("row").find((tr) => within(tr).queryByRole("rowheader")?.textContent === metric);
  return row && column >= 0 ? row.children[column].textContent : null;
}

describe("테이블이 아직 없을 때(available:false)", () => {
  it("서버 문구를 그대로 보이고, 탭·계좌 행·버튼은 그리지 않는다", async () => {
    const message = "모의 매매 테이블이 아직 없습니다. 수집기가 스키마(V8)를 적용하면 생깁니다 — make up 후 다시 보세요.";
    reads["/api/paper/overview"] = () => Promise.resolve({ available: false, message });

    render(<PaperPage />);

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("button", { name: "초기화" })).toBeNull();
    expect(screen.queryByRole("button", { name: "리스크 지금 실행" })).toBeNull();
  });
});

describe("초기화 전", () => {
  it("한계 문구와 '초기화' 버튼을 보이고, 누르면 POST /api/paper/init 결과를 적고 개요를 다시 읽는다", async () => {
    let overviewReads = 0;
    reads["/api/paper/overview"] = () => {
      overviewReads += 1;
      return Promise.resolve({ available: true, initialized: false, startDate: "2026-10-23", limits: LIMITS, books: [], jobs: [] });
    };
    api.apiPost.mockResolvedValue({
      ok: true, created: ["rules", "claude", "bench_spy", "bench_mix"], backfilled: ["bench_spy", "bench_mix"], skipped: [],
      settingsCreated: true, startPricesCaptured: 153,
    });

    render(<PaperPage />);

    expect(await screen.findByText(LIMITS[0])).toBeTruthy();
    expect(screen.getByText(LIMITS[1])).toBeTruthy();
    // 책이 없으니 리스크 실행 버튼은 아직 없습니다.
    expect(screen.queryByRole("button", { name: "리스크 지금 실행" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "초기화" }));

    expect(await screen.findByText(/만든 계좌 rules, claude, bench_spy, bench_mix · 사후 체결 bench_spy, bench_mix/)).toBeTruthy();
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/init");
    await waitFor(() => expect(overviewReads).toBeGreaterThanOrEqual(2));
  });

  it("초기화가 실패하면 서버 문구를 보이고 버튼은 다시 누를 수 있다", async () => {
    reads["/api/paper/overview"] = () =>
      Promise.resolve({ available: true, initialized: false, startDate: "2026-10-23", limits: LIMITS, books: [], jobs: [] });
    api.apiPost.mockRejectedValue(new Error("2026-10-23 종가가 아직 없습니다."));

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: "초기화" }));

    expect(await screen.findByText("2026-10-23 종가가 아직 없습니다.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "초기화" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("종가가 없어 init이 200 + skipped를 주면, 다시 읽은 개요가 initialized:true여도 카드·버튼과 서버 사유가 남는다", async () => {
    // 실제 흐름: 첫 개요는 초기화 전 → init은 책 네 개를 만들고 벤치마크 둘을 skipped로(오류 아님) → 다시 읽은 개요는
    // initialized:true + pendingBackfill. initialized만 보던 화면은 여기서 버튼이 사라졌습니다.
    let overviewReads = 0;
    reads["/api/paper/overview"] = () => {
      overviewReads += 1;
      return Promise.resolve(overviewReads === 1
        ? { available: true, initialized: false, startDate: "2026-10-23", limits: LIMITS, books: [], jobs: [] }
        : PENDING);
    };
    api.apiPost.mockResolvedValue({
      ok: true, created: ["rules", "claude", "bench_spy", "bench_mix"], backfilled: [],
      skipped: [{ code: "bench_spy", reason: SKIP_REASON }, { code: "bench_mix", reason: SKIP_REASON }], settingsCreated: true, startPricesCaptured: 0,
    });

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: "초기화" }));

    // 다시 읽은 개요(책 네 개)가 그려진 뒤에도 카드가 남는다
    expect(await screen.findByText("벤치마크 사후 체결 대기")).toBeTruthy();
    await waitFor(() => expect(overviewReads).toBeGreaterThanOrEqual(2));
    const spyRow = await screen.findByRole("button", { name: /SPY 계좌 상세 보기/ });
    // 사후 체결을 기다리는 벤치마크 행에는 그 사실이 경고로 보입니다(추정처럼 '아직 확정 아님'을 숨기지 않음).
    expect(within(spyRow).getByText("출발일 종가 대기 — 사후 체결 전(현금만)")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /규칙 계좌 상세 보기/ })).queryByText(/출발일 종가 대기/)).toBeNull();
    expect(screen.getByText(/SPY 계좌, 60\/40 계좌: 출발일\(2026-10-23\) 종가를 아직 받지 못해/)).toBeTruthy();
    // 서버 사유(skipped.reason)가 보이고, 다시 누를 버튼이 있다
    expect(screen.getByText(/bench_spy 시작하지 않음 — 2026-10-23 SPY 종가가 아직 없습니다/)).toBeTruthy();
    const again = screen.getByRole("button", { name: "초기화" }) as HTMLButtonElement;
    expect(again.disabled).toBe(false);

    fireEvent.click(again);
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledTimes(2));
    expect(api.apiPost).toHaveBeenLastCalledWith("/api/paper/init");
  });

  it("처음 연 개요가 pendingBackfill이면 초기화 카드를 보인다 — 비면 카드 없음", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(PENDING);

    render(<PaperPage />);

    expect(await screen.findByText("벤치마크 사후 체결 대기")).toBeTruthy();
    expect(screen.getByText(/종가를 받은 뒤 초기화를 다시 누르세요/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "초기화" })).toBeTruthy();
    // 책은 있으니 리스크 실행도 그대로
    expect(screen.getByRole("button", { name: "리스크 지금 실행" })).toBeTruthy();
  });

  it("보유·체결 탭은 책이 없다고 안내하고, 준비 중인 탭은 이제 없다(프레임·메모는 단계 3b에서 열림)", async () => {
    reads["/api/paper/overview"] = () =>
      Promise.resolve({ available: true, initialized: false, startDate: "2026-10-23", limits: LIMITS, books: [], jobs: [] });

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));
    expect(screen.getByText(/아직 계좌가 없습니다/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "보유·체결" }).getAttribute("aria-selected")).toBe("true");

    // 프레임·메모 탭은 단계 3b에서 열렸습니다 — 자리 문구도 '(준비 중)' 표시도 없습니다.
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "개요", "기관 선정", "보유·체결", "결정 로그", "프레임", "메모", "설정",
    ]);
    fireEvent.click(screen.getByRole("tab", { name: "프레임" }));
    expect(screen.getByRole("tab", { name: "프레임" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText(/탭은 다음 단계에서 엽니다/)).toBeNull();
  });
});

describe("값을 모를 때", () => {
  it("계좌 행·계좌 비교 표의 null은 '—'이고 0.00으로 채우지 않는다 — 시작 전인 책은 '시작 전'", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(INITIALIZED);

    render(<PaperPage />);

    // 계좌 행 — 순자산을 모르면 "—"(단위 없음), 수익률을 모르면 칩을 생략(0.00% 없음), 상태는 글로
    const claude = await screen.findByRole("button", { name: /Claude 계좌 상세 보기/ });
    expect(within(claude).getByText("값 없음")).toBeTruthy();
    expect(within(claude).queryByText("달러")).toBeNull();
    expect(within(claude).queryByText(/0\.00/)).toBeNull();
    expect(within(claude).getByText(/시작 전 · 현금만/)).toBeTruthy();

    // 계좌 비교 표 — 예전 카드의 칸이 항목 줄로(Claude 열)
    for (const metric of ["순자산", "수익률(출발 이후)", "주식 노출", "현금", "누적 수익률"]) {
      expect(comparisonCell(metric, "Claude 계좌"), metric).toBe(NONE);
    }
    const table = screen.getByRole("table", { name: "계좌 비교" });
    const claudeColumn = within(table).getAllByRole("columnheader").findIndex((th) => th.textContent === "Claude 계좌");
    const claudeCells = within(table).getAllByRole("row").slice(1).map((tr) => tr.children[claudeColumn].textContent);
    expect(claudeCells.some((text) => /0\.00/.test(text ?? ""))).toBe(false);
    expect(comparisonCell("출발", "Claude 계좌")).toBe("시작 전");
    expect(comparisonCell("상태", "Claude 계좌")).toBe("시작 전 · 현금만");

    // 값이 있는 책은 서버 값 그대로
    expect(comparisonCell("순자산", "SPY 계좌")).toBe("100,050.12 달러");
    expect(within(screen.getByRole("button", { name: /SPY 계좌 상세 보기/ })).getByText("100,050.12")).toBeTruthy();

    // 순자산 곡선 계열은 책 순서대로, 관측치 줄은 봉 날짜·티커 수
    expect(within(screen.getByRole("list", { name: "순자산 계열" })).getAllByRole("listitem").map((li) => li.textContent))
      .toEqual(["규칙 계좌", "Claude 계좌", "SPY 계좌", "60/40 계좌"]);
    expect(screen.getByText("봉 날짜 2026-10-23(미국 동부) · 티커 157개 · 지난 값 이어받음 0개")).toBeTruthy();
    expect(screen.getByRole("button", { name: "리스크 지금 실행" })).toBeTruthy();
    // 모두 시작했으면(pendingBackfill 빔) 초기화 카드는 없습니다.
    expect(screen.queryByRole("button", { name: "초기화" })).toBeNull();
  });

  it("정기 작업이 꺼져 있으면(enabled:false) 그렇다고 알린다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(INITIALIZED);
    reads["/api/paper/status"] = () => Promise.resolve({ available: true, schemaReady: true, initialized: true, enabled: false, jobs: [] });

    render(<PaperPage />);

    expect(await screen.findByText(/정기 작업이 꺼져 있습니다/)).toBeTruthy();
  });

  it("보유 표 — 가격을 모르는 보유는 '—'와 '가격 없음' 배지, 사후 체결은 체결 표에 배지", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(INITIALIZED);
    reads["/api/paper/books/bench_spy/positions"] = () => Promise.resolve({
      available: true,
      book: INITIALIZED.books[2],
      cash: 50.12,
      lockouts: [],
      positions: [{
        ticker: "SPY", qty: 151, avgCost: 662.08, lastPrice: null, lastPriceAtKst: null, marketValue: 99974.08,
        weightPct: 99.95, unrealizedPct: null, highWatermark: 662.08, stopPrice: null, stopDistancePct: null,
        openedOn: "2026-10-23", holdingTradingDays: 0, priceStale: true, splitNote: null, cashLike: false,
      }],
    });
    reads["/api/paper/books/bench_spy/orders"] = () => Promise.resolve({ available: true, orders: [] });
    reads["/api/paper/books/bench_spy/fills"] = () => Promise.resolve({
      available: true,
      fills: [{
        id: 1, orderId: 1, ticker: "SPY", side: "BUY", qty: 151, price: 662.0808, rawPrice: 661.75, slippageBp: 5,
        gross: 99974.2, observedAtKst: "2026-10-24 05:00", observationDate: "2026-10-23", priceSource: "equity_close", backfill: true,
      }],
    });

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    // 처음 시작한 책(bench_spy)을 먼저 보여 줍니다 — 규칙·Claude 책은 아직 비어 있습니다.
    expect((screen.getByLabelText("계좌 고르기") as HTMLSelectElement).value).toBe("bench_spy");
    const spyRow = (await screen.findByText("가격 없음 · 평단 평가")).closest("tr") as HTMLElement;
    const cells = within(spyRow).getAllByRole("cell").map((td) => td.textContent);
    expect(cells[2]).toBe("662.0800");   // 평단 — 주당 가격은 4자리
    expect(cells[3]).toBe(NONE);   // 가격
    expect(cells[6]).toBe(NONE);   // 평가 손익
    expect(cells[8]).toBe(NONE);   // 스탑 가격
    expect(await screen.findByText("사후 체결")).toBeTruthy();
    expect(screen.getByText("재진입 금지 종목이 없습니다.")).toBeTruthy();
    expect(screen.getByText("주문이 없습니다.")).toBeTruthy();
  });
});

describe("주당 가격", () => {
  it("평단·가격·최고가·스탑가·체결가·관측가는 4자리 — 관측가 9.00과 체결가 9.0045가 구별된다, 총액은 2자리", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(INITIALIZED);
    reads["/api/paper/books/bench_spy/positions"] = () => Promise.resolve({
      available: true,
      book: INITIALIZED.books[2],
      cash: 50.12,
      lockouts: [],
      positions: [{
        ticker: "XYZ", qty: 100, avgCost: 9.0045, lastPrice: 9.1, lastPriceAtKst: "2026-10-24 05:15", marketValue: 910,
        weightPct: 0.91, unrealizedPct: 1.06, highWatermark: 9.2, stopPrice: 8.464, stopDistancePct: 7.51,
        openedOn: "2026-10-23", holdingTradingDays: 1, priceStale: false, splitNote: null, cashLike: false, backfilled: false,
      }],
    });
    reads["/api/paper/books/bench_spy/orders"] = () => Promise.resolve({ available: true, orders: [] });
    reads["/api/paper/books/bench_spy/fills"] = () => Promise.resolve({
      available: true,
      fills: [{
        id: 2, orderId: 2, ticker: "XYZ", side: "BUY", qty: 100, price: 9.0045, rawPrice: 9, slippageBp: 5,
        gross: 900.45, observedAtKst: "2026-10-24 05:00", observationDate: "2026-10-23", priceSource: "paper.quotes", backfill: false,
      }],
    });

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    // XYZ는 보유·체결 두 표에 다 있어, 보유 표에만 있는 보유 기간 칸으로 줄을 찾습니다.
    const holdingRow = (await screen.findByText("2026-10-23부터 · 1거래일")).closest("tr") as HTMLElement;
    const holding = within(holdingRow).getAllByRole("cell").map((td) => td.textContent);
    expect(holding[2]).toBe("9.0045");   // 평단
    expect(holding[3]).toBe("9.1000");   // 가격
    expect(holding[4]).toBe("910.00");   // 평가액은 총액 — 2자리
    expect(holding[7]).toBe("9.2000");   // 최고가
    expect(holding[8]).toBe("8.4640 · 거리 7.5%");   // 스탑 가격

    const fillRow = (await screen.findByText("paper.quotes")).closest("tr") as HTMLElement;
    const fill = within(fillRow).getAllByRole("cell").map((td) => td.textContent);
    expect(fill[4]).toBe("9.0045");   // 체결가
    expect(fill[5]).toBe("9.0000");   // 관측가
    expect(fill[7]).toBe("900.45");   // 금액은 총액 — 2자리
  });
});

describe("보유·재진입 금지 표", () => {
  it("정렬 단추는 종목·수량·평가액·비중·평가 손익 다섯 열에만, 평가 손익을 누르면 aria-sort가 붙고 모르는 값(null)은 두 방향 모두 맨 뒤", async () => {
    const position = (ticker: string, over: Record<string, unknown>) => ({
      ticker, qty: 10, avgCost: 10, lastPrice: 10, lastPriceAtKst: "2026-10-24 05:15", marketValue: 100, weightPct: 1,
      unrealizedPct: 0, highWatermark: 10, stopPrice: 9, stopDistancePct: 10, openedOn: "2026-10-23", holdingTradingDays: 1,
      priceStale: false, splitNote: null, cashLike: false, backfilled: false, ...over,
    });
    reads["/api/paper/overview"] = () => Promise.resolve(INITIALIZED);
    reads["/api/paper/books/bench_spy/positions"] = () => Promise.resolve({
      available: true,
      book: INITIALIZED.books[2],
      cash: 50.12,
      lockouts: [],
      positions: [
        position("AAA", { qty: 10, marketValue: 500, weightPct: 5, unrealizedPct: 2.5 }),
        // 가격을 몰라 평가 손익도 모르는 보유 — 정렬해도 늘 맨 뒤(가장 크거나 작은 값처럼 보이지 않게)
        position("BBB", { qty: 5, lastPrice: null, lastPriceAtKst: null, marketValue: 300, weightPct: 3, unrealizedPct: null, priceStale: true }),
        position("CCC", { qty: 20, marketValue: 900, weightPct: 9, unrealizedPct: -1.2 }),
      ],
    });
    reads["/api/paper/books/bench_spy/orders"] = () => Promise.resolve({ available: true, orders: [] });
    reads["/api/paper/books/bench_spy/fills"] = () => Promise.resolve({ available: true, fills: [] });

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    const table = await screen.findByRole("table", { name: "보유" });
    const headers = within(table).getAllByRole("columnheader");
    expect(headers.filter((th) => within(th).queryByRole("button")).map((th) => within(th).getByRole("button").textContent?.replace(/[↑↓↕]/g, "")))
      .toEqual(["종목", "수량", "평가액(달러)", "비중", "평가 손익"]);
    const tickers = () => within(table).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell")[0].textContent?.slice(0, 3));
    // 처음엔 서버 순서 그대로, aria-sort 없음
    expect(tickers()).toEqual(["AAA", "BBB", "CCC"]);
    expect(headers.some((th) => th.hasAttribute("aria-sort"))).toBe(false);

    const pnl = within(table).getByRole("columnheader", { name: /평가 손익/ });
    fireEvent.click(within(pnl).getByRole("button"));
    expect(pnl.getAttribute("aria-sort")).toBe("ascending");
    expect(tickers()).toEqual(["CCC", "AAA", "BBB"]);
    fireEvent.click(within(pnl).getByRole("button"));
    expect(pnl.getAttribute("aria-sort")).toBe("descending");
    expect(tickers()).toEqual(["AAA", "CCC", "BBB"]);

    // 다른 열(평가액)로 옮기면 그 열의 오름차순부터, aria-sort도 옮겨 갑니다.
    const value = within(table).getByRole("columnheader", { name: /평가액/ });
    fireEvent.click(within(value).getByRole("button"));
    expect(value.getAttribute("aria-sort")).toBe("ascending");
    expect(pnl.hasAttribute("aria-sort")).toBe(false);
    expect(tickers()).toEqual(["BBB", "AAA", "CCC"]);
  });

  it("재진입 금지 표 — 종목·이 날까지(미국 거래일)·사유를 서버 순서대로, 사유가 비면 '—'(값 없음)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(INITIALIZED);
    reads["/api/paper/books/bench_spy/positions"] = () => Promise.resolve({
      available: true,
      book: INITIALIZED.books[2],
      cash: 50.12,
      positions: [],
      lockouts: [
        { ticker: "ZZZ", untilTradingDate: "2026-11-05", reason: "트레일링 스탑(−8%) 체결" },
        { ticker: "YYY", untilTradingDate: "2026-11-04", reason: "" },
      ],
    });
    reads["/api/paper/books/bench_spy/orders"] = () => Promise.resolve({ available: true, orders: [] });
    reads["/api/paper/books/bench_spy/fills"] = () => Promise.resolve({ available: true, fills: [] });

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    const table = await screen.findByRole("table", { name: "재진입 금지" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["종목", "이 날까지(미국 거래일)", "사유"]);
    const rows = within(table).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell").map((td) => td.textContent));
    expect(rows).toEqual([
      ["ZZZ", "2026-11-05", "트레일링 스탑(−8%) 체결"],
      ["YYY", "2026-11-04", NONE],
    ]);
    expect(screen.queryByText("재진입 금지 종목이 없습니다.")).toBeNull();
    expect(screen.getByText("보유가 없습니다 — 현금만 들고 있습니다.")).toBeTruthy();
  });
});

describe("주문 근거", () => {
  it("규칙 책 주문의 근거는 문장(reason.text)을 자르지 않고 보이고, 문장이 없으면 키: 값 요약 — 전체 JSON은 마우스를 올려 본다", async () => {
    const active = {
      ...INITIALIZED,
      books: INITIALIZED.books.map((entry) => (entry.code === "rules" ? { ...entry, status: "ACTIVE", startedOn: "2026-10-23" } : entry)),
    };
    const buyText = "2곳 동시 매수(점수 0.8333): A1 기관 A(0000000001) 신규(가중 0.5000 × 확신도 1.00), "
      + "A2 기관 B(0000000002) 신규(가중 0.3333 × 확신도 1.00)";
    const parkText = "남는 현금 9.99%가 기준 2.0%를 넘어 9.50%를 SHY에(여유 0.5%p) — 신호 매수가 아닌 현금 관리";
    const order = (id: number, ticker: string, side: "BUY" | "SELL", reason: unknown) => ({
      id, ticker, side, qty: null, targetWeightPct: side === "BUY" ? 5 : null, sellFraction: null, timing: "NEXT_OBSERVATION",
      source: "RULE", status: "PENDING", rejectReason: null, reason, asOfTradingDate: "2026-10-26",
      createdAtKst: "2026-10-27 07:31", expiresOn: "2026-10-29", filledAtKst: null,
    });
    reads["/api/paper/overview"] = () => Promise.resolve(active);
    reads["/api/paper/books/rules/positions"] = () =>
      Promise.resolve({ available: true, book: active.books[0], cash: 100000, lockouts: [], positions: [] });
    reads["/api/paper/books/rules/orders"] = () => Promise.resolve({
      available: true,
      orders: [
        // 규칙 책 매수 근거 — 키 순서는 rule · signal · kind · text …(서버 그대로). 80자에서 자르면 문장이 앞 키에 밀려 잘립니다.
        order(1, "CCC", "BUY", { rule: "R2·R4", signal: "BUY", kind: "REBALANCE", text: buyText, score: 0.833333, rankInPlan: 1 }),
        // 재선정일이 아닌 날의 남는 현금 SHY(현금 관리)
        order(2, "SHY", "BUY", {
          rule: "park_cash", signal: "PARKING", kind: "SCHEDULED", parking: true, spareCashPct: 9.9965, bufferPct: 0.5,
          currentWeightPct: 0, selectionAsOf: "2026-10-23", thresholdPct: 2, text: parkText, targetWeightPct: 9.4965,
        }),
        // 문장이 없는 근거(장부가 덧붙인 키뿐)
        order(3, "OLD", "SELL", { cashLimited: true, note: "현금 부족" }),
        // 근거가 없는 주문 — 칸은 다른 모르는 칸과 같은 Empty("—" + 읽어 주는 "값 없음")
        order(4, "NUL", "SELL", null),
      ],
    });
    reads["/api/paper/books/rules/fills"] = () => Promise.resolve({ available: true, fills: [] });

    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    expect((screen.getByLabelText("계좌 고르기") as HTMLSelectElement).value).toBe("rules");
    const buy = await screen.findByText(buyText);
    expect(buyText.length).toBeGreaterThan(80);   // 예전 jsonSummary(…, 80)였으면 "rule: R2·R4 · signal: BUY · …"에서 잘림
    expect(buy.textContent).toBe(buyText);
    expect(buy.getAttribute("title")).toContain('"rule":"R2·R4"');
    const buyCells = within(buy.closest("tr") as HTMLElement).getAllByRole("cell");
    expect(buyCells[buyCells.length - 1].textContent).toBe(buyText);   // 근거는 마지막 칸

    expect(screen.getByText(parkText).getAttribute("title")).toContain('"rule":"park_cash"');
    expect(screen.getByText("cashLimited: true · note: 현금 부족")).toBeTruthy();
    expect(screen.queryByText(/^rule: /)).toBeNull();
    const nullCells = within(screen.getByText("NUL").closest("tr") as HTMLElement).getAllByRole("cell");
    expect(nullCells[nullCells.length - 1].textContent).toBe(NONE);
    expect(nullCells[nullCells.length - 1].querySelector("[title]")).toBeNull();
  });
});

describe("리스크 지금 실행", () => {
  beforeEach(() => {
    reads["/api/paper/overview"] = () => Promise.resolve(INITIALIZED);
  });

  it("ok:false(한 책이 오류로 되돌려짐)면 HTTP 200이어도 경고 배너에 오류와 처리 메모를 보인다", async () => {
    api.apiPost.mockResolvedValue({
      ok: false,
      outcome: {
        filled: 1, stopped: 0, expired: 0, splits: 0, booksProcessed: ["bench_spy"], skippedReason: null,
        notes: ["bench_spy: 주문 7 BUY SPY 현금 부족으로 10주 중 9주"],
        errors: ["claude: IllegalStateException 상태 저장 실패"],
      },
    });
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: "리스크 지금 실행" }));

    const errors = await screen.findByRole("list", { name: "리스크 작업 오류" });
    expect(within(errors).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["claude: IllegalStateException 상태 저장 실패"]);
    expect(within(screen.getByRole("list", { name: "리스크 작업 메모" })).getByText(/현금 부족으로 10주 중 9주/)).toBeTruthy();
    const warning = screen.getByText(/오류가 난 계좌가 있습니다/);
    expect(warning.closest("div")?.className).toContain("text-warn");
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/run/risk");
  });

  it("ok:true면 경고 없이 요약과 처리 메모", async () => {
    api.apiPost.mockResolvedValue({
      ok: true,
      outcome: {
        filled: 0, stopped: 0, expired: 1, splits: 0, booksProcessed: ["rules"], skippedReason: null,
        notes: ["rules: 주문 3 SELL XLE 취소 — 재진입 금지"], errors: [],
      },
    });
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: "리스크 지금 실행" }));

    expect(await screen.findByText("리스크 작업 — 체결 0 · 스탑 0 · 만료 1 · 분할 0 · 처리한 계좌 rules")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "리스크 작업 메모" })).getByText("rules: 주문 3 SELL XLE 취소 — 재진입 금지")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "리스크 작업 오류" })).toBeNull();
    expect(screen.queryByText(/오류가 난 계좌가 있습니다/)).toBeNull();
  });
});

describe("책 버튼", () => {
  beforeEach(() => {
    reads["/api/paper/overview"] = () => Promise.resolve(INITIALIZED);
    reads["/api/paper/books/bench_spy/positions"] = () =>
      Promise.resolve({ available: true, book: INITIALIZED.books[2], cash: 50.12, lockouts: [], positions: [] });
    reads["/api/paper/books/bench_spy/orders"] = () => Promise.resolve({ available: true, orders: [] });
    reads["/api/paper/books/bench_spy/fills"] = () => Promise.resolve({ available: true, fills: [] });
  });

  it("책 초기화는 확인 창에서 책 코드를 정확히 입력해야 눌리고, 누르면 confirm과 함께 보낸다 — 창은 결과가 나온 뒤 닫힌다", async () => {
    let finish: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation(() => new Promise((resolve) => {
      finish = resolve;
    }));
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    // 첫 누름은 확인 창만 엽니다 — 아직 서버를 부르지 않습니다.
    fireEvent.click(await screen.findByRole("button", { name: "계좌 초기화" }));
    const dialog = screen.getByRole("dialog", { name: "SPY 계좌 초기화" });
    expect(within(dialog).getByText(/체결·주문·보유·재진입 금지·순자산 기록을 모두 지웁니다/)).toBeTruthy();
    const button = within(dialog).getByRole("button", { name: "초기화 확인" }) as HTMLButtonElement;
    const input = within(dialog).getByRole("textbox", { name: /확인하려면 다음 글자를 그대로 입력하세요: bench_spy/ }) as HTMLInputElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "bench_sp" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "bench_spy" } });
    expect(button.disabled).toBe(false);
    expect(api.apiPost).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/books/bench_spy/reset", { confirm: "bench_spy" });
    // 처리 중에는 창이 남아 있고 다시 누를 수 없습니다.
    expect(screen.getByRole("dialog", { name: "SPY 계좌 초기화" })).toBeTruthy();
    expect((within(screen.getByRole("dialog")).getByRole("button", { name: "초기화 중…" }) as HTMLButtonElement).disabled).toBe(true);

    finish({ ok: true, book: INITIALIZED.books[2], backfilled: true, skippedReason: null });

    const done = await screen.findByText(/SPY 계좌를 초기화했습니다 — 지금 운용 중 · 출발일 종가로 다시 사후 체결했습니다/);
    // 창이 닫히며 초점은 '계좌 초기화' 단추로 돌아가므로, 결과는 처음부터 있던 알림 영역 안에 그려져 낭독기가 읽는다.
    expect(done.closest("[role='status']")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 다시 열면 입력은 비어 있습니다(예전의 '성공하면 입력을 비움').
    fireEvent.click(screen.getByRole("button", { name: "계좌 초기화" }));
    expect((within(screen.getByRole("dialog")).getByRole("textbox") as HTMLInputElement).value).toBe("");
  });

  it("책 초기화가 실패하면(서버 400) 창을 닫고 서버 문구를 경고로 — 다시 하려면 창을 열어 코드를 다시 친다", async () => {
    const message = "confirm이 계좌 코드와 다릅니다(bench_spy).";
    api.apiPost.mockRejectedValue(new Error(message));
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    fireEvent.click(await screen.findByRole("button", { name: "계좌 초기화" }));
    fireEvent.change(within(screen.getByRole("dialog")).getByRole("textbox"), { target: { value: "bench_spy" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "초기화 확인" }));

    const warning = await screen.findByText(message);
    expect(warning.className).toContain("text-warn");
    expect(warning.closest("[role='status']")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByRole("button", { name: "계좌 초기화" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("벤치마크를 다시 사후 체결하지 못하면(skippedReason) 사유를 경고로 보이고, 시작 전 안내는 '종가를 받은 뒤 초기화를 다시'", async () => {
    const cleared = { ...INITIALIZED.books[2], status: "NOT_STARTED", startedOn: null };
    api.apiPost.mockResolvedValue({ ok: true, book: cleared, backfilled: false, skippedReason: SKIP_REASON });
    // 리셋 뒤 다시 읽은 보유 응답의 책도 시작 전입니다.
    let positionReads = 0;
    reads["/api/paper/books/bench_spy/positions"] = () => {
      positionReads += 1;
      return Promise.resolve({
        available: true, book: positionReads === 1 ? INITIALIZED.books[2] : cleared, cash: 100000, lockouts: [], positions: [],
      });
    };
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    fireEvent.click(await screen.findByRole("button", { name: "계좌 초기화" }));
    fireEvent.change(within(screen.getByRole("dialog")).getByRole("textbox"), { target: { value: "bench_spy" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "초기화 확인" }));

    const banner = await screen.findByText(/출발일 종가로 다시 사후 체결하지 못했습니다 — 2026-10-23 SPY 종가가 아직 없습니다/);
    expect(banner.className).toContain("text-warn");
    expect(await screen.findByText(/시작 전인 벤치마크 계좌는 출발일 종가로 사후 체결해 시작합니다 — 종가를 받은 뒤 초기화를 다시 누르세요/))
      .toBeTruthy();
    expect(screen.queryByText(/시작 전인 계좌는 다음 단계의 초기 결정으로 시작합니다/)).toBeNull();
  });

  it("운용 중인 책은 '일시정지', 시작 전인 책은 버튼 없이 안내", async () => {
    api.apiPost.mockResolvedValue({ ok: true, book: { ...INITIALIZED.books[2], status: "PAUSED" }, cancelledOrders: 2 });
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));

    fireEvent.click(await screen.findByRole("button", { name: "일시정지" }));
    expect(await screen.findByText("SPY 계좌: 일시정지 · 대기 주문 2건 취소")).toBeTruthy();
    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/books/bench_spy/status", { status: "PAUSED" });

    fireEvent.change(screen.getByLabelText("계좌 고르기"), { target: { value: "rules" } });
    expect(screen.queryByRole("button", { name: "일시정지" })).toBeNull();
    // 규칙 책은 단계 2부터 개요의 '규칙 책 시작'(초기 결정)으로 시작합니다.
    expect(screen.getByText(/시작 전인 규칙 계좌는 개요 탭의 '규칙 계좌 시작'\(초기 결정\)으로 시작합니다/)).toBeTruthy();
    // 다른 책으로 바꾸면 앞 책의 결과 문구를 새 책 이름 아래 남기지 않습니다.
    expect(screen.queryByText("SPY 계좌: 일시정지 · 대기 주문 2건 취소")).toBeNull();
  });
});
