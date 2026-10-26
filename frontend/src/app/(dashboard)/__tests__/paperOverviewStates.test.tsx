/**
 * 🧪 모의매매(미국) 개요 — 네 상태 이야기(설계서 §9 DoD "없음·일부 실패·추정·오래됨").
 *
 *  - 없음: 장부가 없으면(available:false) 서버 문구만 — 제목은 남고 탭·계좌 행·비교 표는 없다 / 계좌가 0개면 안내만
 *  - 일부 실패: 상태 응답이 실패해도 개요(계좌 행·곡선·비교 표)는 그대로 — 꺼짐 배너·사용량·설정 버전만 빠진다 /
 *    계좌 상세의 보유 응답이 실패하면 그 칸만 오류 + 다시 시도, 나머지(정의·핵심 숫자)는 개요 값으로
 *  - 추정에 가까운 상태: 사후 체결을 기다리는 벤치마크 행에 경고, 가격 없는 보유가 있으면 비교 표 '가격 없음'이 경고색
 *  - 오래됨: 가격 없는 보유·늦은 관측치 저장본이면 계좌 행에 '이전 값' 배지와 사유(숨기는 옵션 없음)
 *  - 기간별 순자산 곡선: 저장된 기록보다 긴 기간 탭은 없고, 고르면 그 기간만(경계선도 그 기간 안의 것만)
 *  - 시장 고르기: 화면 안에는 없다 — 셸의 하위 메뉴 줄(미국 | 한국 · 준비 중 · 2단계)이 맡는다(Shell.test.tsx), 제목은 '(미국)'
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
    expect(screen.getByText(/행을 누르면 그 계좌의 상세 · 설정 v4/)).toBeTruthy();
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
    expect(screen.getByText("⚠️ 오래된 저장본")).toBeTruthy();
  });
});

describe("기간별 순자산 곡선", () => {
  it("출발 직후(며칠치)면 기간 탭이 없다 — 고를 것이 '전체'뿐", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);
    await screen.findByRole("list", { name: "순자산 계열" });
    expect(screen.queryByRole("tablist", { name: "순자산 곡선 기간" })).toBeNull();
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
    expect(Array.from(chart().querySelectorAll("[data-marker]")).map((li) => li.textContent)).toEqual(["2026-10-26 프레임 v1"]);
    // 기간 밖의 경계를 '그날 기록 없음'으로 적지 않습니다.
    expect(screen.getByText(/2026-08-03부터 임시 v0 · 2026-10-26부터 v1$/)).toBeTruthy();
  });
});

describe("시장 고르기", () => {
  it("화면 안에는 시장 고르기가 없다 — 셸의 하위 메뉴 줄이 맡고(한국 · 준비 중 · 2단계는 Shell.test.tsx), 제목이 미국 책임을 말한다", async () => {
    reads["/api/paper/overview"] = () => Promise.resolve(OVERVIEW);
    render(<PaperPage />);

    expect(await screen.findByRole("tablist", { name: "모의 매매 화면" })).toBeTruthy();
    // 예전에는 제목 아래에 같은 고르기가 한 줄 더 있어 셸의 하위 메뉴 줄과 두 줄로 겹쳐 보였습니다.
    expect(screen.queryByRole("navigation", { name: "모의매매 시장" })).toBeNull();
    expect(screen.queryByText(/한국 · 준비 중/)).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "모의 알고리즘 매매(미국)" })).toBeTruthy();
  });
});
