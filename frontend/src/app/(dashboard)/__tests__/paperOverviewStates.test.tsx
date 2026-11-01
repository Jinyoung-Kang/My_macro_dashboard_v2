/**
 * 모의매매(미국) 개요 — 네 상태 이야기(설계서 §9 DoD "없음·일부 실패·추정·오래됨").
 *
 *  - 없음: 장부가 없으면(available:false) 서버 문구만 — 제목은 남고 탭·계좌 행·비교 표는 없다 / 계좌가 0개면 안내만
 *  - 일부 실패: 상태 응답이 실패해도 개요(계좌 행·곡선·비교 표)는 그대로 — 꺼짐 배너·사용량·설정 버전만 빠진다 /
 *    계좌 상세의 보유 응답이 실패하면 그 칸만 오류 + 다시 시도, 나머지(정의·핵심 숫자)는 개요 값으로
 *  - 추정에 가까운 상태: 사후 체결을 기다리는 벤치마크 행에 경고, 가격 없는 보유가 있으면 비교 표 '가격 없음'이 경고색
 *  - 오래됨: 가격 없는 보유·늦은 관측치 저장본이면 계좌 행에 '이전 값' 배지와 사유(숨기는 옵션 없음)
 *  - 기간별 순자산 곡선: 저장된 기록보다 긴 기간 탭은 없고, 고르면 그 기간만(경계선도 그 기간 안의 것만), 곡선 아래 노출 문구(남는 현금 SHY)
 *  - 시장 고르기: 화면 안에는 없다 — 셸의 하위 메뉴 줄(미국 | 한국 두 링크)이 맡는다(Shell.test.tsx), 제목은 '(미국)'
 *  - 히어로(포트폴리오식): 고른 계좌 하나(기본 Claude 계좌, 계좌 행을 누르면 그 계좌 — 상세를 닫아도 남음)의 지금 값·곡선, 기간 알약은
 *    히어로 차트 아래(아래 '순자산 곡선'과 같은 기간 — 그 카드의 탭은 없음), 초기화 전이면 히어로 없이 탭은 곡선 카드에
 *  - 지금 값(장중 명세 §4-1): 개요 응답에 current가 있으면 계좌 행은 그 값과 값의 기준 한 줄(단계 표기·덧붙임·변화 한 줄)·추정 배지,
 *    부제는 '지금 값 기준' — current가 없는 옛 응답(위 고정본들)은 장부 표시 그대로
 *  - 오늘 추정 꼬리(장중 명세 §4): navEstimate가 있으면 비교 곡선에 계좌마다 마지막 줄 → 추정 점의 꼬리(이름 '{계좌} · 추정 HH:MM', 현금뿐
 *    '· 장부', 기간 창 뒤 한 행)와 곡선 아래 설명·출처, 히어로 곡선도 꼬리 점 — 문지르면 '추정 HH:MM'(배지·알림), 현금뿐은 배지 없이 '장부'
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 recharts가 크기 0이라 아무것도 그리지 않습니다 — 순자산 곡선은 행 수·경계선, 노출 추이는 계열만 목록으로.
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: ({ data, series, markers, unit }: {
    data: { date: string }[]; series: { key: string; name: string }[]; markers?: { x: string; label: string }[]; unit?: string;
  }) => (
    <ul aria-label={unit === "%" ? "노출 계열" : "순자산 계열"} data-rows={data.length} data-first={data[0]?.date ?? ""}>
      {series.map((entry) => <li key={entry.key}>{entry.name}</li>)}
      {(markers ?? []).map((marker) => <li key={marker.x} data-marker>{`${marker.x} ${marker.label}`}</li>)}
    </ul>
  ),
  DonutChart: () => null,
  // 개요 히어로의 선 차트 — 이름(계좌)·행 수·첫 날짜·값·꼬리 값·계열(꼬리는 본 계열 키)만 목록 속성으로. 실제 차트의 문지르기 대신 '마지막 점
  // 문지르기' 단추가 onScrub에 마지막 행 순번을 넘깁니다(히어로가 그 점을 어떻게 읽는지 — 꼬리 점이면 '추정 HH:MM').
  LineChart: ({ data, series, ariaLabel, onScrub }: {
    data: Record<string, unknown>[]; series: { key: string; label: string; tailOf?: string }[]; ariaLabel?: string;
    onScrub?: (index: number | null) => void;
  }) => (
    <>
      <ul aria-label={ariaLabel ?? "선 차트"} data-rows={data.length} data-first={String(data[0]?.date ?? "")}
        data-values={data.map((entry) => String(entry.nav ?? "null")).join(",")}
        data-estimate={data.map((entry) => String(entry.estimate ?? "null")).join(",")}
        data-series={series.map((entry) => `${entry.label}${entry.tailOf ? `(꼬리 ${entry.tailOf})` : ""}`).join("|")} />
      {onScrub ? (
        <button type="button" onClick={() => onScrub(data.length - 1)}>{`${ariaLabel ?? "선 차트"} 마지막 점 문지르기`}</button>
      ) : null}
    </>
  ),
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: 1.2, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 2 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 200, nav: 100500, equityValue: 100300, exposurePct: 99.8, returnPct: 0.5,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: "bench_spy", ...over,
  };
}

const BOOKS = [
  book("rules", { kind: "RULES", label: "규칙 계좌", returnPct: 1.2, nav: 101200, positions: 7 }),
  book("claude", {
    kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null, nav: 100000, cash: 100000, equityValue: 0,
    exposurePct: 0, returnPct: null, positions: 0, stats: null, lastObservedAtKst: null,
  }),
  book("bench_spy", { label: "SPY 계좌", benchmark: null }),
  book("bench_mix", { label: "60/40 계좌" }),
];

const QUOTES = {
  collectedAtKst: "2026-10-24 05:10", ageSeconds: 300, barDate: "2026-10-23", finalClose: true, tickers: 157, staleTickers: [], stale: false,
};

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], books: BOOKS, jobs: [], pendingBackfill: [],
  navSeries: { dates: ["2026-10-23", "2026-10-24"], books: { rules: [100000, 101200], bench_spy: [100000, 100500] } },
  quotes: QUOTES,
};

/** 지금 값(current — API.md 개요 줄)이 든 고정본: 정규장 10-30 세션, 규칙·SPY 계좌는 장중 추정, 60/40 계좌는 장부 단계, Claude 계좌는 출발 전. */
const LIVE_SESSION = { phase: "REGULAR", sessionDate: "2026-10-30" };

function current(over: Record<string, unknown> = {}) {
  return {
    nav: 101234.56, returnPct: 1.23, exposurePct: 98.7, dayChangePct: 0.42, previousTradingDate: "2026-10-29", previousNavFinal: false,
    basis: "LIVE", stage: "LIVE", tradingDate: "2026-10-30", atKst: "2026-10-30 23:58 KST", isEstimated: true, livePriced: 2,
    positionCount: 2, pendingOrders: 0, neutral: false, note: null, ...over,
  };
}

const LEDGER_DAY = { tradingDate: "2026-10-30", dayChangePct: 0.3, previousTradingDate: "2026-10-29", previousNavFinal: true };

const CURRENT_BOOKS = [
  {
    ...BOOKS[0], ledgerDay: LEDGER_DAY, lastNavTradingDate: "2026-10-29", lastNavFinal: true,
    current: current({ livePriced: 1, pendingOrders: 1,
      note: "장중가 1/2종목 — 나머지는 장부 관측가 · 체결 대기 1건 반영 전 — 다음 장부 관측치에서 체결" }),
  },
  {
    ...BOOKS[1], ledgerDay: null, lastNavTradingDate: null, lastNavFinal: null,
    current: current({ nav: 100000, returnPct: null, exposurePct: 0, dayChangePct: null, previousTradingDate: null, previousNavFinal: null,
      basis: "LEDGER", stage: "LEDGER", tradingDate: null, atKst: null, isEstimated: false, livePriced: 0, positionCount: 0, neutral: true,
      note: "출발 전" }),
  },
  {
    ...BOOKS[2], ledgerDay: { ...LEDGER_DAY, dayChangePct: 0.2 }, lastNavTradingDate: "2026-10-29", lastNavFinal: true,
    current: current({ nav: 100600, returnPct: 0.6, exposurePct: 99.8, dayChangePct: 0.1, positionCount: 1, livePriced: 1 }),
  },
  {
    ...BOOKS[3], ledgerDay: { ...LEDGER_DAY, dayChangePct: 0.04 }, lastNavTradingDate: "2026-10-29", lastNavFinal: true,
    current: current({ nav: 100500, returnPct: 0.5, exposurePct: 99.8, dayChangePct: 0.05, basis: "LEDGER", stage: "LEDGER",
      atKst: "2026-10-30 23:15 KST", isEstimated: false, livePriced: 0, positionCount: 2 }),
  },
];

const CURRENT_OVERVIEW = { ...OVERVIEW, books: CURRENT_BOOKS, liveSession: LIVE_SESSION, navEstimate: null };

/**
 * 오늘 추정 꼬리가 든 고정본(navEstimate — 10-30 세션에 그날 순자산 줄이 아직 없음): 규칙·SPY 계좌는 장중 값(SPY 계좌는 기준 시각 23:57 —
 * 계좌마다 시각이 다름), 출발 전 Claude·장부 단계 60/40 계좌는 nav null.
 */
const TAIL_ESTIMATE = {
  date: "2026-10-30", atKst: "2026-10-30 23:57 KST", isEstimated: true,
  books: {
    rules: { nav: 101234.56, isEstimated: true }, claude: { nav: null, isEstimated: false },
    bench_spy: { nav: 100600, isEstimated: true }, bench_mix: { nav: null, isEstimated: false },
  },
};
const TAIL_BOOKS = CURRENT_BOOKS.map((entry) => (entry.code === "bench_spy"
  ? { ...entry, current: { ...entry.current, atKst: "2026-10-30 23:57 KST" } } : entry));
const TAIL_OVERVIEW = { ...CURRENT_OVERVIEW, books: TAIL_BOOKS, navEstimate: TAIL_ESTIMATE };

const STATUS = {
  available: true, schemaReady: true, initialized: true, enabled: false, jobs: [], settingsVersion: 4,
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

const row = (name: RegExp) => screen.getByRole("button", { name });
/** 곧바로 resolve하는 목 응답을 끝까지 반영합니다(QA-147·148 — 벽시계 한도가 있는 findBy 대신). */
const settled = () => act(async () => {});

/**
 * 계좌 비교 표의 칸(항목 줄 × 계좌 열) — 글과 글자색을 함께 보려고 칸 요소를 돌려줍니다. 항목 이름은 행 머리(th scope=row)라
 * 줄은 rowheader로 찾고, 칸은 DOM 순서(행 머리 + 계좌 칸)로 열 머리와 같은 자리에서 꺼냅니다.
 */
function comparisonCell(metric: string, account: string): HTMLElement {
  const table = screen.getByRole("table", { name: "계좌 비교" });
  const column = within(table).getAllByRole("columnheader").findIndex((th) => th.textContent === account);
  const line = within(table).getAllByRole("row").find((tr) => within(tr).queryByRole("rowheader")?.textContent === metric);
  if (!line || column < 0) throw new Error(`칸 없음: ${metric} × ${account}`);
  return line.children[column] as HTMLElement;
}

describe("값 있음 — 계좌 행·비교 표·곡선", () => {
  it("네 계좌 행: 이름·종류·상태·순자산(달러)·출발 이후 수익률 칩, 비교 표는 계좌 순서대로 열", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);

    // 단추 이름은 계좌 이름 + "상세 보기"뿐(값·칩·배지는 설명으로 — 낭독기가 숫자 전부를 단추 이름으로 읽지 않게).
    const rules = await screen.findByRole("button", { name: "규칙 계좌 상세 보기" });
    expect(rules.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(rules).getByText("101,200.00")).toBeTruthy();
    expect(within(rules).getByText("달러")).toBeTruthy();
    expect(within(rules).getByText("+1.20%")).toBeTruthy();
    expect(within(rules).getByText("상승")).toBeTruthy();
    expect(within(rules).getByText(/^규칙 · 운용 중 · /)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "계좌 목록" })).getAllByRole("listitem")).toHaveLength(4);
    // 아바타(장식 — 단추 이름에 섞이지 않음)와 그 계좌의 곡선 색 고리(규칙 계좌 = 계열 파랑, 60/40 = 회색)
    const avatar = (button: HTMLElement) => button.querySelector('[aria-hidden="true"].rounded-full') as HTMLElement | null;
    expect(avatar(rules)?.textContent).toBe("R");
    expect(avatar(rules)?.style.getPropertyValue("--avatar-ring")).toBe("#3987e5");
    expect(avatar(row(/^60\/40 계좌 상세 보기/))?.style.getPropertyValue("--avatar-ring")).toBe("#6b727e");

    const table = screen.getByRole("table", { name: "계좌 비교" });
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "항목", "규칙 계좌", "Claude 계좌", "SPY 계좌", "60/40 계좌",
    ]);
    // 항목 이름 칸은 행 머리 — 칸을 옮겨 다닐 때 어느 항목인지 함께 읽힙니다.
    expect(within(table).getAllByRole("rowheader").map((th) => th.textContent)).toContain("순자산");
    // 폰에서는 넓은 표라 좌우로 넘겨 보라는 안내 줄(sm 미만에서만 보임)
    expect(screen.getAllByText("← 표를 좌우로 넘겨 보세요").length).toBeGreaterThan(0);
    expect(comparisonCell("처음 현금", "규칙 계좌").textContent).toBe("100,000 달러");
    expect(comparisonCell("보유", "규칙 계좌").textContent).toBe("7종목");
    expect(comparisonCell("비교 기준", "규칙 계좌").textContent).toBe("SPY 계좌");
    expect(comparisonCell("수익률(출발 이후)", "규칙 계좌").querySelector(".text-up")?.textContent).toBe("+1.20%");
    // 표본 설명은 표 밖 목록에 계좌마다 한 줄
    expect(within(screen.getByRole("list", { name: "표본 설명" })).getAllByRole("listitem")).toHaveLength(4);
    expect(within(screen.getByRole("list", { name: "순자산 계열" })).getAllByRole("listitem").map((li) => li.textContent))
      .toEqual(["규칙 계좌", "SPY 계좌"]);
  });
});

describe("히어로(포트폴리오식 — 장중 명세 §4-1)", () => {
  it("기본은 Claude 계좌, 계좌 행을 누르면 히어로도 그 계좌 — 상세를 닫아도 남고, 곡선은 그 계좌 한 줄", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);

    const first = await screen.findByRole("region", { name: "Claude 계좌 순자산" });
    expect(within(first).getByText("100,000.00")).toBeTruthy();
    // 시작 전 계좌는 곡선 값이 없음(선 없음 — 0으로 채우지 않음)
    expect(within(first).getByRole("list", { name: "Claude 계좌 순자산 곡선" }).getAttribute("data-values")).toBe("null,null");
    // 히어로는 화면 맨 위(시작 카드·계좌 카드보다 앞)
    const accounts = screen.getByRole("list", { name: "계좌 목록" });
    expect(first.compareDocumentPosition(accounts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(row(/^규칙 계좌 상세 보기/));
    const hero = screen.getByRole("region", { name: "규칙 계좌 순자산" });
    expect(within(hero).getByText("101,200.00")).toBeTruthy();
    expect(within(hero).getByText("+1.20%")).toBeTruthy();
    expect(within(hero).getByText("출발 이후")).toBeTruthy();
    // 옛 응답(current 없음)은 장부 값과 마지막 관측
    expect(within(hero).getByText("마지막 관측 2026-10-24 05:15")).toBeTruthy();
    expect(within(hero).queryByText("추정")).toBeNull();
    expect(within(hero).getByRole("list", { name: "규칙 계좌 순자산 곡선" }).getAttribute("data-values")).toBe("100000,101200");
    expect(screen.queryByRole("region", { name: "Claude 계좌 순자산" })).toBeNull();

    // 상세를 닫아도 히어로는 그 계좌 그대로
    fireEvent.click(row(/^규칙 계좌 상세 닫기/));
    expect(screen.queryByRole("region", { name: "규칙 계좌 상세" })).toBeNull();
    expect(screen.getByRole("region", { name: "규칙 계좌 순자산" })).toBeTruthy();
  });

  it("지금 값 — 히어로는 단계 표기·추정 배지·서버 글 전문·변화 한 줄(서버 값)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(CURRENT_OVERVIEW);
    render(<PaperPage />);

    fireEvent.click(await screen.findByRole("button", { name: "규칙 계좌 상세 보기" }));
    const hero = screen.getByRole("region", { name: "규칙 계좌 순자산" });
    expect(within(hero).getByText("101,234.56")).toBeTruthy();
    expect(within(hero).getByText("+1.23%")).toBeTruthy();
    expect(within(hero).getByText("장중 추정 23:58")).toBeTruthy();
    expect(within(hero).getByText("추정")).toBeTruthy();
    expect(within(hero).getByText("장중가 1/2종목 — 나머지는 장부 관측가 · 체결 대기 1건 반영 전 — 다음 장부 관측치에서 체결")).toBeTruthy();
    expect(within(hero).getByText("오늘")).toBeTruthy();
    expect(within(hero).getByText("+0.42%")).toBeTruthy();
    expect(within(hero).getByText("· 10-29 잠정 대비")).toBeTruthy();
    expect(within(hero).getByText(/보유를 장중 1분봉 시세로 다시 평가한 표시 전용 추정/)).toBeTruthy();
  });

  it("문지르는 동안 단계 표기·추정 배지·서버 글은 '지금 값 …' 뒤에 — 그 점(순자산 줄)의 값이 '장중 추정'으로 읽히지 않게, 배지는 그대로", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(CURRENT_OVERVIEW);
    render(<PaperPage />);
    await settled();

    fireEvent.click(row(/^규칙 계좌 상세 보기/));
    const hero = screen.getByRole("region", { name: "규칙 계좌 순자산" });
    expect(within(hero).getByText("장중 추정 23:58")).toBeTruthy();
    // 마지막 점(10-24 순자산 줄 — 꼬리가 아님)을 문지름
    fireEvent.click(within(hero).getByRole("button", { name: "규칙 계좌 순자산 곡선 마지막 점 문지르기" }));
    expect(within(hero).getByText("2026-10-24")).toBeTruthy();
    // 단계 표기 바로 앞에 '지금 값 …'(눈으로만 — 낭독기는 Hero 값 자리의 '지금 값 …'을 이미 읽음)
    const stage = within(hero).getByText("장중 추정 23:58");
    expect(stage.textContent).toBe("지금 값 101,234.56 달러 · 장중 추정 23:58");
    expect(stage.querySelector('[aria-hidden="true"]')?.textContent).toBe("지금 값 101,234.56 달러 · ");
    expect(within(hero).getByText("추정")).toBeTruthy();
    expect(within(hero).getByText(/^지금 값: 장중가 1\/2종목 — 나머지는 장부 관측가 · 체결 대기 1건 반영 전/)).toBeTruthy();
    // 그 점은 추정이 아님 — 알림은 날짜와 값뿐
    expect(hero.querySelector('[aria-live="polite"]')?.textContent).toBe("2026-10-24 101,200.00 달러");
  });

  it("초기화 전(initialized false)이면 히어로 없이 기간 알약은 '순자산 곡선' 카드에", async () => {
    const dates = ["2026-06-01", "2026-08-03", "2026-09-28", "2026-10-26"];
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...OVERVIEW, initialized: false,
      navSeries: { dates, books: { rules: [100000, 100500, 101000, 101200], bench_spy: [100000, 100100, 100300, 100500] } },
    });
    render(<PaperPage />);

    expect(await screen.findByRole("tablist", { name: "순자산 곡선 기간" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /순자산$/ })).toBeNull();
    expect(screen.queryByText(/기간은 위 히어로에서 고릅니다/)).toBeNull();
    expect(screen.queryByText(/위 히어로·아래 장중 시세도/)).toBeNull();
  });
});

describe("지금 값 — 계좌 행(장중 명세 §4-1)", () => {
  it("행은 지금 값과 값의 기준 한 줄(단계 표기·장중가 n/m종목·체결 대기·오늘 변화), 장중 추정만 추정 배지 — 부제는 '지금 값 기준'", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(CURRENT_OVERVIEW);
    render(<PaperPage />);

    const rules = await screen.findByRole("button", { name: "규칙 계좌 상세 보기" });
    expect(within(rules).getByText("101,234.56")).toBeTruthy();
    expect(within(rules).getByText("+1.23%")).toBeTruthy();
    expect(within(rules).getByText("장중 추정 23:58 · 장중가 1/2종목 · 체결 대기 1건 반영 전 · 오늘 +0.42% · 10-29 잠정 대비")).toBeTruthy();
    expect(within(rules).getByText("추정")).toBeTruthy();
    // 값의 기준은 펼침 단추의 설명으로도 읽힙니다(이름은 '규칙 계좌 상세 보기' 그대로).
    const described = (rules.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(described).toContain("장중 추정 23:58");

    // 장부 단계(지금 세션의 시간별 관측)는 배지 없이 단계 표기만
    const mix = row(/^60\/40 계좌 상세 보기/);
    expect(within(mix).getByText("장부 23:15 · 오늘 +0.05% · 10-29 잠정 대비")).toBeTruthy();
    expect(within(mix).queryByText("추정")).toBeNull();
    // 출발 전 계좌는 기준 한 줄 없이 보조 글('시작 전 · 현금만')
    const claude = row(/^Claude 계좌 상세 보기/);
    expect(within(claude).getByText("100,000.00")).toBeTruthy();
    expect(within(claude).queryByText(/출발 전|추정/)).toBeNull();

    expect(screen.getByText(/^순자산·수익률\(출발 이후\)은 지금 값 기준\(행마다 단계 표기\) — 장중 추정은 표시 전용 · 행을 누르면/)).toBeTruthy();
    expect(screen.queryByText(/^순자산·수익률\(출발 이후\)은 장부의 마지막 관측치 기준/)).toBeNull();
  });

  it("옛 응답(current 없음)은 장부 표시 그대로 — 부제는 '장부의 마지막 관측치 기준(시각 KST)', 기준 한 줄·추정 배지 없음", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);

    const rules = await screen.findByRole("button", { name: "규칙 계좌 상세 보기" });
    expect(within(rules).queryByText("추정")).toBeNull();
    expect(within(rules).queryByText(/^장중 추정|^장부 /)).toBeNull();
    expect(screen.getByText(/^순자산·수익률\(출발 이후\)은 장부의 마지막 관측치 기준\(2026-10-24 05:15 KST\) · 행을 누르면/)).toBeTruthy();
  });
});

describe("지금 값 — 계좌 비교(한 표 한 기준)", () => {
  const rowHeaders = () => within(screen.getByRole("table", { name: "계좌 비교" })).getAllByRole("rowheader").map((th) => th.textContent);

  it("장중이 아닌 비중립 계좌가 있으면 표 전체 장부 칸 + 사유 — 기준 줄·오늘 변화(장부)·통계 기준·두 수익률 설명", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(CURRENT_OVERVIEW);
    render(<PaperPage />);

    await screen.findByRole("table", { name: "계좌 비교" });
    // 사유 괄호도 기준 줄과 같은 꼴('장부 MM-DD HH:MM')
    expect(screen.getByText("장중 추정이 아닌 계좌가 있어 표 전체를 장부 기준으로 둡니다 — 60/40 계좌(장부 10-30 23:15)")).toBeTruthy();
    expect(rowHeaders().slice(0, 1)).toEqual(["기준"]);
    expect(rowHeaders()).toEqual(expect.arrayContaining(["오늘 변화", "통계 기준"]));
    expect(comparisonCell("기준", "규칙 계좌").textContent).toBe("장부 10-24 05:15");
    // 긴 기준 글·기준 아래 글은 낱말 중간에서 접히지 않게
    expect(within(comparisonCell("기준", "규칙 계좌")).getByText("장부 10-24 05:15").className).toContain("break-keep");
    expect(within(comparisonCell("오늘 변화", "규칙 계좌")).getByText("10-29 확정 대비").className).toContain("break-keep");
    expect(comparisonCell("기준", "Claude 계좌").textContent).toBe("출발 전");
    // 장부 칸 — 순자산·수익률은 장부(BookSummary), 오늘 변화는 ledgerDay(지금 값과 섞지 않음)
    expect(comparisonCell("순자산", "규칙 계좌").textContent).toBe("101,200.00 달러");
    expect(comparisonCell("오늘 변화", "규칙 계좌").textContent).toBe("+0.30%10-29 확정 대비");
    expect(comparisonCell("통계 기준", "규칙 계좌").textContent).toBe("마감 10-29 확정");
    expect(screen.getByText(/^'수익률\(출발 이후\)'은 맨 위 '기준' 줄의 값이고, 통계 일곱 칸은 거래일 마감 순자산 줄/)).toBeTruthy();
    expect(screen.getByText(/순자산·수익률·오늘 변화·노출은 장부의 마지막 관측치 기준\(맨 위 기준 줄\)/)).toBeTruthy();
  });

  it("판정 대상이 모두 장중 추정이면 지금 값 칸 — 사유 없음, 순자산·오늘 변화는 지금 값", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...CURRENT_OVERVIEW,
      books: CURRENT_BOOKS.map((entry) => (entry.code === "bench_mix"
        ? { ...entry, current: current({ nav: 100500, returnPct: 0.5, dayChangePct: 0.05 }) } : entry)),
    });
    render(<PaperPage />);

    await screen.findByRole("table", { name: "계좌 비교" });
    expect(screen.queryByText(/표 전체를 장부 기준으로 둡니다/)).toBeNull();
    expect(comparisonCell("기준", "규칙 계좌").textContent).toBe("장중 추정 23:58");
    expect(comparisonCell("순자산", "규칙 계좌").textContent).toBe("101,234.56 달러");
    expect(comparisonCell("수익률(출발 이후)", "규칙 계좌").textContent).toBe("+1.23%");
    expect(comparisonCell("오늘 변화", "규칙 계좌").textContent).toBe("+0.42%10-29 잠정 대비");
    expect(screen.getByText(/순자산·수익률·오늘 변화·노출은 맨 위 기준 줄\(장중 추정은 표시 전용\)/)).toBeTruthy();
  });

  it("옛 응답(current 없음)은 예전 표 — 기준·오늘 변화·통계 기준 줄과 두 수익률 설명이 없다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);

    await screen.findByRole("table", { name: "계좌 비교" });
    expect(rowHeaders()).not.toEqual(expect.arrayContaining(["기준"]));
    expect(rowHeaders().some((label) => label === "오늘 변화" || label === "최근 변화" || label === "통계 기준")).toBe(false);
    expect(screen.queryByText(/^'수익률\(출발 이후\)'은 맨 위/)).toBeNull();
  });
});

describe("없음", () => {
  it("장부가 없으면(available:false) 서버 문구만 — 제목은 남고 탭·계좌 행·비교 표는 없다", async () => {
    const message = "모의 매매 테이블이 아직 없습니다. 수집기가 스키마(V8)를 적용하면 생깁니다 — make up 후 다시 보세요.";
    reads["/api/paper/overview"] = () => Promise.resolve({ available: false, message });
    render(<PaperPage />);

    expect(await screen.findByText(message)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "모의 알고리즘 매매(미국)" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("list", { name: "계좌 목록" })).toBeNull();
    expect(screen.queryByRole("table", { name: "계좌 비교" })).toBeNull();
  });

  it("계좌가 0개면 안내만 — 계좌 행·비교 표는 없다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve({ ...OVERVIEW, initialized: false, books: [], navSeries: null });
    render(<PaperPage />);

    expect(await screen.findByText("계좌가 없습니다. 초기화하면 생깁니다.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "계좌 목록" })).toBeNull();
    expect(screen.queryByRole("table", { name: "계좌 비교" })).toBeNull();
  });
});

describe("일부 실패", () => {
  it("상태 응답이 실패해도 계좌 행·곡선·비교 표는 그대로 — 꺼짐 배너 대신 '확인하지 못함', 설정 버전은 빠진다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    reads["/api/paper/status"] = () => Promise.reject(new Error("상태를 읽지 못했습니다."));
    render(<PaperPage />);

    expect(await screen.findByRole("button", { name: /^규칙 계좌 상세 보기/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: "계좌 비교" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "순자산 계열" })).toBeTruthy();
    expect(screen.queryByText(/정기 작업이 꺼져 있습니다/)).toBeNull();
    // 꺼짐·켜짐을 모르는 채 배너만 사라지면 켜져 있는 것으로 읽힌다 — 모른다고 적는다(홈과 같은 문구).
    expect(await screen.findByText("정기 작업 상태를 확인하지 못했습니다 — 상태를 읽지 못했습니다.")).toBeTruthy();
    expect(screen.queryByText(/설정 v\d/)).toBeNull();
  });

  it("상태 응답이 오면 꺼짐 배너와 계좌 부제의 설정 버전", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    reads["/api/paper/status"] = () => Promise.resolve(STATUS);
    render(<PaperPage />);

    expect(await screen.findByText(/정기 작업이 꺼져 있습니다/)).toBeTruthy();
    expect(screen.getByText(/행을 누르면 그 계좌의 상세\(위 히어로·아래 장중 시세도 그 계좌로\) · 설정 v4/)).toBeTruthy();
  });

  it("계좌 상세의 보유 응답이 실패하면 구성 칸만 오류 + 다시 시도 — 정의·핵심 숫자는 개요 값으로", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    reads["/api/paper/books/rules/positions"] = () => Promise.reject(new Error("보유를 읽지 못했습니다."));
    reads["/api/paper/books/rules/fills"] = () => Promise.resolve({ available: true, fills: [] });
    render(<PaperPage />);

    fireEvent.click(await screen.findByRole("button", { name: /^규칙 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });
    const composition = within(panel).getByRole("region", { name: "구성" });
    expect(await within(composition).findByText("보유를 읽지 못했습니다.")).toBeTruthy();
    expect(within(composition).getByRole("button", { name: "다시 시도" })).toBeTruthy();
    const numbers = within(panel).getByRole("region", { name: "핵심 숫자" });
    expect(within(numbers).getByText("순자산").nextElementSibling?.textContent).toBe("101,200.00 달러");
    expect(within(panel).getByRole("region", { name: "정의" })).toBeTruthy();
    expect(await within(panel).findByText("체결이 없습니다.")).toBeTruthy();
  });
});

describe("추정에 가까운 상태 — 아직 확정이 아닌 값", () => {
  it("사후 체결을 기다리는 벤치마크 행에 경고, 다른 행에는 없다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...OVERVIEW,
      books: BOOKS.map((entry) => (entry.kind === "BENCHMARK" ? { ...entry, status: "NOT_STARTED", startedOn: null, returnPct: null } : entry)),
      pendingBackfill: ["bench_spy", "bench_mix"],
    });
    render(<PaperPage />);

    const spy = await screen.findByRole("button", { name: /^SPY 계좌 상세 보기/ });
    const warning = within(spy).getByText("출발일 종가 대기 — 사후 체결 전(현금만)");
    expect(warning.className).toContain("text-warn");
    expect(within(spy).getByText("주의:")).toBeTruthy();
    expect(within(row(/^60\/40 계좌 상세 보기/)).getByText(/출발일 종가 대기/)).toBeTruthy();
    expect(within(row(/^규칙 계좌 상세 보기/)).queryByText(/출발일 종가 대기/)).toBeNull();
    // 초기화 카드가 사유와 다시 누를 단추를 함께 보입니다.
    expect(screen.getByText("벤치마크 사후 체결 대기")).toBeTruthy();
  });

  it("가격 없는 보유가 있으면 비교 표 '가격 없음' 칸이 경고색 — 0이면 '없음'", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...OVERVIEW, books: BOOKS.map((entry) => (entry.code === "rules" ? { ...entry, staleCount: 2 } : entry)),
    });
    render(<PaperPage />);

    await screen.findByRole("table", { name: "계좌 비교" });
    const stale = comparisonCell("가격 없음", "규칙 계좌");
    expect(stale.textContent).toBe("2종목 — 지난 값으로 평가");
    expect(stale.querySelector(".text-warn")).not.toBeNull();
    expect(comparisonCell("가격 없음", "SPY 계좌").textContent).toBe("없음");
  });
});

describe("오래됨 — 이전 값 배지는 반드시 보인다", () => {
  it("가격 없는 보유가 있으면 그 계좌 행에 '이전 값'과 사유", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...OVERVIEW, books: BOOKS.map((entry) => (entry.code === "rules" ? { ...entry, staleCount: 2 } : entry)),
    });
    render(<PaperPage />);

    const rules = await screen.findByRole("button", { name: /^규칙 계좌 상세 보기/ });
    expect(within(rules).getByText("이전 값").parentElement?.className).toContain("text-warn");
    expect(within(rules).getByText("· 가격 없음 2종목 — 지난 값으로 평가")).toBeTruthy();
    expect(within(row(/^SPY 계좌 상세 보기/)).queryByText("이전 값")).toBeNull();
  });

  it("관측치 저장본이 늦으면(서버 stale) 시작한 계좌 행마다 '이전 값'과 마지막 관측 — 시작 전 계좌는 없음, 관측치 카드는 경고 배지", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve({ ...OVERVIEW, quotes: { ...QUOTES, stale: true, ageSeconds: 4 * 3600 } });
    render(<PaperPage />);

    const spy = await screen.findByRole("button", { name: /^SPY 계좌 상세 보기/ });
    expect(within(spy).getByText("이전 값")).toBeTruthy();
    expect(within(spy).getByText("· 관측치 저장본이 늦음 · 마지막 관측 2026-10-24 05:15")).toBeTruthy();
    expect(within(row(/^Claude 계좌 상세 보기/)).queryByText("이전 값")).toBeNull();
    expect(screen.getByText("오래된 저장본")).toBeTruthy();
  });
});

describe("기간별 순자산 곡선", () => {
  it("출발 직후(며칠치)면 기간 탭이 없다 — 고를 것이 '전체'뿐", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);
    await screen.findByRole("list", { name: "순자산 계열" });
    expect(screen.queryByRole("tablist", { name: "순자산 곡선 기간" })).toBeNull();
  });

  it("곡선 아래 노출 문구 — 규칙 계좌 결과는 13F 종목 신호와 주식 노출(남는 현금 SHY)이 섞인 값(2단계 명세 §4-16, 미국 응답·한계 문구는 그대로)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);
    await screen.findByRole("list", { name: "순자산 계열" });
    expect(screen.getByText(
      "규칙 계좌 결과는 13F 종목 신호와 주식 노출(남는 현금은 SHY)이 섞인 값입니다 — 주식 비중이 낮은 날은 SHY 수익이 섞입니다",
    )).toBeTruthy();
    // 한국 문구(153130·참고선)는 미국 화면에 없습니다.
    expect(screen.queryByText(/153130|노출 맞춘 참고선/)).toBeNull();
  });

  it("기록이 길면 저장 구간 안의 기간만 — 고르면 그 기간의 행만, 경계선도 그 기간 안의 것만(한 줄 글은 전체 기준)", async () => {
    const dates = ["2026-06-01", "2026-08-03", "2026-09-28", "2026-10-26"];
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...OVERVIEW,
      navSeries: { dates, books: { rules: [100000, 100500, 101000, 101200], bench_spy: [100000, 100100, 100300, 100500] } },
      frameworkBoundaries: [
        { tradingDate: "2026-08-03", version: 0, status: "INTERIM" },
        { tradingDate: "2026-10-26", version: 1, status: "USER" },
      ],
    });
    render(<PaperPage />);

    const tabs = await screen.findByRole("tablist", { name: "순자산 곡선 기간" });
    // 기간 알약은 히어로(차트 아래) 한 곳 — 아래 '순자산 곡선' 카드에는 탭이 없고 같은 기간을 따릅니다.
    expect(within(screen.getByRole("region", { name: "Claude 계좌 순자산" })).getByRole("tablist", { name: "순자산 곡선 기간" })).toBe(tabs);
    expect(screen.getAllByRole("tablist", { name: "순자산 곡선 기간" })).toHaveLength(1);
    // 기록이 약 5개월 — 6개월·1년 탭은 그리지 않습니다.
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["1개월", "3개월", "전체"]);
    expect(within(tabs).getByRole("tab", { name: "전체" }).getAttribute("aria-selected")).toBe("true");
    const chart = () => screen.getByRole("list", { name: "순자산 계열" });
    expect(chart().getAttribute("data-rows")).toBe("4");
    expect(chart().querySelectorAll("[data-marker]")).toHaveLength(2);

    fireEvent.click(within(tabs).getByRole("tab", { name: "1개월" }));
    expect(within(tabs).getByRole("tab", { name: "1개월" }).getAttribute("aria-selected")).toBe("true");
    expect(chart().getAttribute("data-rows")).toBe("2");
    expect(chart().getAttribute("data-first")).toBe("2026-09-28");
    // 히어로 곡선도 같은 기간(두 행)이고, 곡선 카드 부제가 지금 기간을 적습니다.
    expect(screen.getByRole("list", { name: "Claude 계좌 순자산 곡선" }).getAttribute("data-rows")).toBe("2");
    expect(screen.getByText(/기간은 위 히어로에서 고릅니다\(지금 1개월\)\.$/)).toBeTruthy();
    expect(Array.from(chart().querySelectorAll("[data-marker]")).map((li) => li.textContent)).toEqual(["2026-10-26 프레임 v1"]);
    // 기간 밖의 경계를 '그날 기록 없음'으로 적지 않습니다.
    expect(screen.getByText(/2026-08-03부터 임시 v0 · 2026-10-26부터 v1$/)).toBeTruthy();
  });
});

describe("오늘 추정 꼬리(장중 명세 §4 '순자산 곡선 꼬리')", () => {
  /** 곧바로 resolve하는 목 응답을 끝까지 반영합니다(QA-148 — 벽시계 한도 없이). */
  const settled = () => act(async () => {});
  const navItems = () => within(screen.getByRole("list", { name: "순자산 계열" })).getAllByRole("listitem").map((li) => li.textContent);
  const alertOf = (region: HTMLElement) => region.querySelector('[aria-live="polite"]')?.textContent;

  it("비교 곡선에 계좌마다 꼬리 — 이름은 그 계좌의 기준 시각, 행은 창 + 1, 곡선 아래 설명과 출처(장중 추정)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(TAIL_OVERVIEW);
    render(<PaperPage />);
    await settled();

    expect(navItems()).toEqual(["규칙 계좌", "SPY 계좌", "규칙 계좌 · 추정 23:58", "SPY 계좌 · 추정 23:57"]);
    expect(screen.getByRole("list", { name: "순자산 계열" }).getAttribute("data-rows")).toBe("3");
    expect(screen.getByText(/^짧은 점선 꼬리\(범례에 없음\) = 10-30 순자산 줄이 생기기 전의 지금 값/)).toBeTruthy();
    // 곡선 카드의 출처가 그 점의 출처(장중 1분봉으로 다시 평가한 표시 전용 추정)를 함께 — 기본 히어로(출발 전 Claude 계좌)는 장부 출처
    expect(screen.getAllByText(/보유를 장중 1분봉 시세로 다시 평가한 표시 전용 추정/)).toHaveLength(1);
    // 출발 전 계좌의 히어로 곡선에는 꼬리가 없음(navEstimate의 그 계좌 값이 null — 짓지 않음)
    expect(screen.getByRole("list", { name: "Claude 계좌 순자산 곡선" }).getAttribute("data-rows")).toBe("2");
  });

  it("히어로 곡선도 꼬리 점 — 문지르면 그 점의 값과 '추정 23:58'(배지와 낭독 알림 둘 다)", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(TAIL_OVERVIEW);
    render(<PaperPage />);
    await settled();

    fireEvent.click(row(/^규칙 계좌 상세 보기/));
    const hero = screen.getByRole("region", { name: "규칙 계좌 순자산" });
    const line = within(hero).getByRole("list", { name: "규칙 계좌 순자산 곡선" });
    expect(line.getAttribute("data-values")).toBe("100000,101200,null");
    expect(line.getAttribute("data-estimate")).toBe("null,101200,101234.56");
    expect(line.getAttribute("data-series")).toBe("규칙 계좌|규칙 계좌 · 추정 23:58(꼬리 nav)");
    expect(alertOf(hero)).toBe("");

    fireEvent.click(within(hero).getByRole("button", { name: "규칙 계좌 순자산 곡선 마지막 점 문지르기" }));
    expect(within(hero).getByText("2026-10-30")).toBeTruthy();
    expect(within(hero).getByText("· 23:58")).toBeTruthy();
    expect(alertOf(hero)).toBe("2026-10-30 101,234.56 달러 추정 23:58");
  });

  it("현금뿐 계좌의 꼬리는 '장부' — 비교 곡선 이름, 히어로 문지르기는 추정 배지 없이 '장부'", async () => {
    const cash = {
      ...current(), nav: 100500, returnPct: 0.5, exposurePct: 0, dayChangePct: 0, basis: "LEDGER", stage: "FINAL", tradingDate: "2026-10-29",
      atKst: "2026-10-30 05:00 KST", isEstimated: false, livePriced: 0, positionCount: 0, neutral: true,
    };
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...TAIL_OVERVIEW,
      books: TAIL_BOOKS.map((entry) => (entry.code === "bench_spy" ? { ...entry, current: cash } : entry)),
      navEstimate: { ...TAIL_ESTIMATE, books: { ...TAIL_ESTIMATE.books, bench_spy: { nav: 100500, isEstimated: false } } },
    });
    render(<PaperPage />);
    await settled();

    expect(navItems()).toEqual(["규칙 계좌", "SPY 계좌", "규칙 계좌 · 추정 23:58", "SPY 계좌 · 장부"]);
    fireEvent.click(row(/^SPY 계좌 상세 보기/));
    const hero = screen.getByRole("region", { name: "SPY 계좌 순자산" });
    fireEvent.click(within(hero).getByRole("button", { name: "SPY 계좌 순자산 곡선 마지막 점 문지르기" }));
    expect(within(hero).getByText("· 장부")).toBeTruthy();
    expect(within(hero).queryByText("추정")).toBeNull();
    expect(alertOf(hero)).toBe("2026-10-30 100,500.00 달러 장부");
  });

  it("기간을 고르면 그 창 뒤에 꼬리 — 1개월이면 두 행 + 꼬리 점 한 행", async () => {
    const dates = ["2026-06-01", "2026-08-03", "2026-09-28", "2026-10-26"];
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...TAIL_OVERVIEW,
      navSeries: { dates, books: { rules: [100000, 100500, 101000, 101200], bench_spy: [100000, 100100, 100300, 100500] } },
    });
    render(<PaperPage />);
    await settled();

    fireEvent.click(within(screen.getByRole("tablist", { name: "순자산 곡선 기간" })).getByRole("tab", { name: "1개월" }));
    const nav = screen.getByRole("list", { name: "순자산 계열" });
    expect(nav.getAttribute("data-rows")).toBe("3");
    expect(nav.getAttribute("data-first")).toBe("2026-09-28");
  });

  it("navEstimate가 없거나(옛 응답) null(그날 줄이 이미 있음·장 밖)이면 꼬리·설명이 없다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(CURRENT_OVERVIEW);
    render(<PaperPage />);
    await settled();

    expect(navItems()).toEqual(["규칙 계좌", "SPY 계좌"]);
    expect(screen.getByRole("list", { name: "순자산 계열" }).getAttribute("data-rows")).toBe("2");
    expect(screen.queryByText(/점선 꼬리/)).toBeNull();
  });
});

describe("시장 고르기", () => {
  it("화면 안에는 시장 고르기가 없다 — 셸의 하위 메뉴 줄(미국 | 한국 두 링크, Shell.test.tsx)이 맡고, 제목이 미국 책임을 말한다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);

    expect(await screen.findByRole("tablist", { name: "모의 매매 화면" })).toBeTruthy();
    // 예전에는 제목 아래에 같은 고르기가 한 줄 더 있어 셸의 하위 메뉴 줄과 두 줄로 겹쳐 보였습니다.
    expect(screen.queryByRole("navigation", { name: "모의매매 시장" })).toBeNull();
    // 한국 화면으로 가는 링크도 화면 안에는 없습니다(셸 하위 메뉴의 '한국' 링크 하나).
    expect(document.querySelector('a[href^="/paper/kr"]')).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "모의 알고리즘 매매(미국)" })).toBeTruthy();
  });
});

describe("작업 기록 카드(x3 — 미국 응답은 그대로, 화면이 kr. 줄을 뺌)", () => {
  const run = (job: string, outcome = "OK") => ({ job, startedAtKst: "2026-10-29 22:40 KST", finishedAtKst: "2026-10-29 22:41 KST",
    outcome, detail: { filled: 0 } });

  it("미국 개요 jobs에 kr.risk·kr.decision이 섞여도 표에는 미국 줄만 — 부제에 한국 작업은 한국 개요라고 적음", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve({
      ...OVERVIEW, jobs: [run("kr.decision", "DATA_NOT_READY"), run("risk"), run("kr.risk"), run("decision", "DECIDED")],
    });
    render(<PaperPage />);

    const table = await screen.findByRole("region", { name: "작업 기록 (좌우 스크롤)" });
    const jobs = within(table).getAllByRole("row").slice(1).map((tr) => tr.children[0]?.textContent);
    expect(jobs).toEqual(["risk", "decision"]);
    expect(screen.getByText(/최근 10건 중 미국 작업 — 한국 작업 kr\.\*은 한국 개요/)).toBeTruthy();
  });

  it("받은 줄이 모두 kr.이면 '미국 작업이 없음' 안내", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve({ ...OVERVIEW, jobs: [run("kr.risk"), run("kr.decision")] });
    render(<PaperPage />);
    expect(await screen.findByText("최근 10건 가운데 미국 작업이 없습니다 — 한국 작업은 한국 개요에 있습니다.")).toBeTruthy();
  });
});

describe("장중 시세 카드 — 새 장중 값을 받으면 개요를 한 번 다시 읽는다", () => {
  /** 곧바로 resolve하는 목 응답이 잇는 일(개요 → 카드 마운트 → /live → 커밋)을 끝까지 반영합니다(QA-148 — 벽시계 한도 없이). */
  const settled = () => act(async () => {});
  const calls = (prefix: string) => api.apiGetShared.mock.calls.filter(([path]) => String(path).startsWith(prefix)).length;

  function liveAt(stamp: string) {
    return {
      available: true, market: "US", currency: "USD", nowKst: "2026-10-30 23:59 KST", isEstimated: true,
      session: { phase: "REGULAR", sessionDate: "2026-10-30", openAtKst: "2026-10-30 22:30 KST", closeAtKst: "2026-10-31 05:00 KST",
        nextOpenAtKst: "2026-11-02 23:30 KST" },
      quotes: { source: "Yahoo(yfinance) 1분봉", collectedAtKst: stamp, refreshRequested: false, missing: [], error: null },
      books: [{ code: "rules", label: "규칙 계좌", status: "ACTIVE", initialCash: 100000, cash: 200, nav: 101300, returnPct: 1.3,
        previousNav: 101200, previousTradingDate: "2026-10-29", dayChangePct: 0.1, basis: "LIVE", basisAtKst: stamp,
        liveCount: 0, positionCount: 0, positions: [] }],
    };
  }

  it("기준 시각이 바뀐 장중 값에만 개요를 한 번 더 읽고, 그 다시 읽기는 /live를 부르지 않는다", async () => {
    let liveReads = 0;
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    reads["/api/paper/live"] = () => {
      liveReads += 1;
      return Promise.resolve(liveAt(liveReads === 1 ? "2026-10-30 23:58 KST" : "2026-10-31 00:28 KST"));
    };
    render(<PaperPage />);
    await settled();
    expect(screen.getByRole("heading", { name: "장중 시세 (추정)" })).toBeTruthy();
    expect(calls("/api/paper/overview")).toBe(1);
    expect(calls("/api/paper/live")).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "지금 새로 읽기" }));
    await settled();
    expect(calls("/api/paper/live")).toBe(2);
    expect(calls("/api/paper/overview")).toBe(2);
    // 개요를 다시 읽어도 카드는 다시 마운트되지 않고 /live를 부르지 않습니다(되풀이 없음).
    await settled();
    expect(calls("/api/paper/live")).toBe(2);
    expect(calls("/api/paper/overview")).toBe(2);
  });
});
