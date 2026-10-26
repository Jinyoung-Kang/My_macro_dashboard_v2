/**
 * 🧪 개요의 계좌 상세 — 계좌 카드를 누르면 카드 묶음 아래에 그 계좌의 상세가 열린다(한 번에 하나).
 *
 *  - 카드 이름 옆 단추(진짜 <button>, aria-expanded·aria-controls)와 카드 어디를 눌러도 열리고, 다시 누르거나 '닫기'·Esc로 닫힌다
 *  - 열면 초점이 패널 제목으로 간다(바로 Esc로 닫을 수 있게), 움직임 줄이기를 켰으면 부드러운 스크롤 대신 바로 옮긴다
 *  - 정의(운용 방식 …)와 지금 설정(설정 응답 — 못 읽으면 숫자 없이 정의만), 핵심 숫자
 *  - 묶음이 셋 이상이면 도넛 + 범례, 둘 이하면 한 줄 막대 + 범례, 어느 쪽이든 표(차트의 표 보기)
 *  - 최근 체결 다섯 건, "보유·체결 탭에서 전체 보기"·"결정 로그 보기"는 그 탭으로 바꾸며 이 계좌를 미리 고른다
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSITION_TOP_N } from "@/lib/paper";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
// jsdom에서는 차트 크기가 0이라 recharts가 아무것도 그리지 않습니다 — 조각의 이름·값·직접 라벨·색을 목록으로 그립니다.
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: () => null,
  DonutChart: ({ segments, ariaLabel }: {
    segments: { key: string; name: string; valueText: string; label?: string | null; color: string }[];
    ariaLabel: string;
  }) => (
    <ul aria-label="구성 도넛" title={ariaLabel}>
      {segments.map((segment) => (
        <li key={segment.key} data-color={segment.color} data-label={segment.label ?? ""}>{`${segment.name} ${segment.valueText}`}</li>
      ))}
    </ul>
  ),
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const STATS = { cumReturnPct: 1.2, cagrPct: null, volPct: null, mddPct: null, sharpe: null, excessPct: null, beta: null, sampleDays: 2 };

function book(code: string, over: Record<string, unknown> = {}) {
  return {
    code, kind: "BENCHMARK", label: code, status: "ACTIVE", startedOn: "2026-10-23", initialCash: 100000,
    cash: 200, nav: 100000, equityValue: 99800, exposurePct: 99.8, returnPct: 0,
    lastObservedAtKst: "2026-10-24 05:15", positions: 1, staleCount: 0, stats: STATS, benchmark: "bench_spy", ...over,
  };
}

const BOOKS = [
  book("rules", { kind: "RULES", label: "규칙 계좌", cash: 500, nav: 101200, exposurePct: 99.51, returnPct: 1.2, positions: 7 }),
  book("claude", {
    kind: "CLAUDE", label: "Claude 계좌", status: "NOT_STARTED", startedOn: null, cash: 100000, nav: 100000, equityValue: 0,
    exposurePct: 0, returnPct: null, positions: 0, stats: null,
  }),
  book("bench_spy", { label: "SPY 계좌", benchmark: null }),
  book("bench_mix", { label: "60/40 계좌" }),
];

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], books: BOOKS,
  navSeries: { dates: [], books: {} }, quotes: null, jobs: [], pendingBackfill: [],
};

function position(ticker: string, weightPct: number, marketValue: number, over: Record<string, unknown> = {}) {
  return {
    ticker, qty: 10, avgCost: 100, lastPrice: 101, lastPriceAtKst: "2026-10-24 05:15", marketValue, weightPct, unrealizedPct: 1.5,
    highWatermark: 102, stopPrice: 93.84, stopDistancePct: 7.6, openedOn: "2026-10-23", holdingTradingDays: 1, priceStale: false,
    splitNote: null, cashLike: false, backfilled: true, ...over,
  };
}

const RULES_POSITIONS = {
  available: true,
  book: BOOKS[0],
  cash: 500,
  lockouts: [],
  positions: [
    position("NVDA", 20, 20240), position("AAPL", 15, 15180), position("MSFT", 12, 12144), position("AMZN", 10, 10120),
    position("META", 8, 8096), position("GOOG", 4.5, 4554),
    position("SHY", 30.01, 30366, { cashLike: true, stopPrice: null }),
  ],
};

const SPY_POSITIONS = {
  available: true, book: BOOKS[2], cash: 200, lockouts: [], positions: [position("SPY", 99.8, 99800)],
};

const SETTINGS = {
  available: true, version: 2,
  body: {
    trailingStopPct: 8, lockoutTradingDays: 20, minHolders: 2, rulesMaxNames: 10, maxWeightStockPct: 10, maxWeightEtfPct: 20,
    parkCashInShy: true, minOrderNotional: 500, cashLikeTickers: ["SHY"], rules: { parkCashThresholdPct: 2 },
    blend: { allocation: "CONVICTION" }, slippageBp: 5,
  },
  keys: [],
};

const FILL = {
  id: 7, orderId: 7, ticker: "NVDA", side: "BUY", qty: 10, price: 202.4101, rawPrice: 202.31, slippageBp: 5, gross: 2024.1,
  observedAtKst: "2026-10-24 05:00", observationDate: "2026-10-23", priceSource: "equity_close", backfill: true,
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};
const paths: string[] = [];

beforeEach(() => {
  paths.length = 0;
  reads = {
    "/api/paper/overview": () => Promise.resolve(OVERVIEW),
    "/api/paper/settings": () => Promise.resolve(SETTINGS),
    "/api/paper/books/rules/positions": () => Promise.resolve(RULES_POSITIONS),
    "/api/paper/books/rules/fills": () => Promise.resolve({ available: true, fills: [FILL] }),
    "/api/paper/books/bench_spy/positions": () => Promise.resolve(SPY_POSITIONS),
    "/api/paper/books/bench_spy/fills": () => Promise.resolve({ available: true, fills: [] }),
  };
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    paths.push(path);
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // jsdom에는 scrollIntoView가 없어 시험마다 붙였다 뗍니다.
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

const toggle = (name: RegExp) => screen.getByRole("button", { name });

describe("계좌 카드를 누르면 상세가 열린다", () => {
  it("카드 단추는 진짜 button이고 aria-expanded·aria-controls로 열림을 알린다 — 누르면 열리고 다시 누르면 닫힌다", async () => {
    render(<PaperPage />);
    const button = await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("region", { name: "규칙 계좌 상세" })).toBeNull();

    fireEvent.click(button);

    const panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });
    expect(toggle(/규칙 계좌 상세 닫기/).getAttribute("aria-expanded")).toBe("true");
    expect(toggle(/규칙 계좌 상세 닫기/).getAttribute("aria-controls")).toBe(panel.id);

    fireEvent.click(toggle(/규칙 계좌 상세 닫기/));
    expect(screen.queryByRole("region", { name: "규칙 계좌 상세" })).toBeNull();
    expect(toggle(/규칙 계좌 상세 보기/).getAttribute("aria-expanded")).toBe("false");
  });

  it("카드 어디를 눌러도 열리고, 다른 카드를 누르면 그 계좌로 바뀐다(한 번에 하나)", async () => {
    render(<PaperPage />);
    const spyCard = await screen.findByRole("article", { name: "SPY 계좌" });
    fireEvent.click(within(spyCard).getByText("순자산"));
    expect(await screen.findByRole("region", { name: "SPY 계좌 상세" })).toBeTruthy();

    fireEvent.click(toggle(/규칙 계좌 상세 보기/));
    expect(await screen.findByRole("region", { name: "규칙 계좌 상세" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "SPY 계좌 상세" })).toBeNull();
    expect(toggle(/SPY 계좌 상세 보기/).getAttribute("aria-expanded")).toBe("false");
    // 선택된 카드는 테두리로도 보입니다(색만이 아니라 단추 글자 '상세 닫기'도 바뀜).
    expect(screen.getByRole("article", { name: "규칙 계좌" }).className).toContain("border-accent");
  });

  it("'닫기'와 Esc로 닫히고, 초점은 그 카드의 단추로 돌아간다", async () => {
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ }));
    let panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });

    fireEvent.click(within(panel).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("region", { name: "규칙 계좌 상세" })).toBeNull();
    expect(document.activeElement).toBe(toggle(/규칙 계좌 상세 보기/));

    fireEvent.click(toggle(/규칙 계좌 상세 보기/));
    panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });
    fireEvent.keyDown(within(panel).getByRole("button", { name: "닫기" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "규칙 계좌 상세" })).toBeNull();
    expect(document.activeElement).toBe(toggle(/규칙 계좌 상세 보기/));
  });

  it("A11Y-1: 열면 초점이 패널 제목으로 간다 — 다음 Tab이 다른 카드 단추를 돌지 않고, 바로 누른 Esc도 패널을 닫는다", async () => {
    render(<PaperPage />);
    const button = await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ });
    button.focus();
    fireEvent.click(button);
    const panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });
    const heading = within(panel).getByRole("heading", { name: "규칙 계좌 상세" });
    expect(document.activeElement).toBe(heading);
    // Tab 순서에는 넣지 않습니다(초점을 받는 자리일 뿐).
    expect(heading.getAttribute("tabindex")).toBe("-1");

    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "규칙 계좌 상세" })).toBeNull();
    expect(document.activeElement).toBe(toggle(/규칙 계좌 상세 보기/));

    // 다른 카드로 바꿔 열어도 새 패널의 제목으로
    fireEvent.click(toggle(/SPY 계좌 상세 보기/));
    const spy = await screen.findByRole("region", { name: "SPY 계좌 상세" });
    expect(document.activeElement).toBe(within(spy).getByRole("heading", { name: "SPY 계좌 상세" }));
  });

  it("A11Y-3: 움직임 줄이기(prefers-reduced-motion)를 켰으면 패널로 바로 옮기고, 아니면 부드럽게", async () => {
    const scroll = vi.fn();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scroll;
    let reduce = true;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && reduce,
      media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }));
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ }));
    await screen.findByRole("region", { name: "규칙 계좌 상세" });
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", behavior: "auto" });

    reduce = false;
    fireEvent.click(toggle(/SPY 계좌 상세 보기/));
    await screen.findByRole("region", { name: "SPY 계좌 상세" });
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest", behavior: "smooth" });
  });

  it("카드에는 계좌마다 한 줄 소개가 있다", async () => {
    render(<PaperPage />);
    const rules = await screen.findByRole("article", { name: "규칙 계좌" });
    expect(within(rules).getByText(/13F 신호만 규칙대로 따르는 대조군/)).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "60/40 계좌" })).getByText(/SPY 60%·SHY 40%를 사서 그대로/)).toBeTruthy();
  });
});

describe("상세 패널의 내용", () => {
  it("정의·지금 설정·핵심 숫자 — 설정 숫자는 설정 응답에서 읽는다", async () => {
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });

    const definitions = within(panel).getByRole("region", { name: "정의" });
    for (const label of ["운용 방식", "매수", "매도·리스크", "현금", "시작·출발일", "비교 목적"]) {
      expect(within(definitions).getByText(label)).toBeTruthy();
    }
    expect(within(definitions).getByText(/재선정일\(분기 13F 공시 기한 다음 거래일\)과 시작 때만/)).toBeTruthy();
    // 지금 설정(설정 응답) — 정의 문장과 따로, 숫자는 여기에만
    expect(await within(definitions).findByText("트레일링 스탑")).toBeTruthy();
    const stop = within(definitions).getByText("트레일링 스탑").nextElementSibling;
    expect(stop?.textContent).toBe("8%");
    expect(within(definitions).getByText("SHY 매수 기준(순자산 대비)").nextElementSibling?.textContent).toBe("2%");

    const numbers = within(panel).getByRole("region", { name: "핵심 숫자" });
    const tile = (label: string) => within(numbers).getByText(label).nextElementSibling?.textContent;
    expect(tile("순자산")).toBe("101,200.00 달러");
    expect(tile("수익률(출발 이후)")).toBe("+1.20%");
    expect(tile("현금")).toBe("500.00 달러");
    expect(tile("주식 노출")).toBe("99.5%");
    expect(within(numbers).getByText("현금성(SHY) 포함")).toBeTruthy();
    expect(tile("보유 종목 수")).toBe("7종목");
    expect(tile("출발일")).toBe("2026-10-23");
    expect(tile("마지막 평가")).not.toBe("—");
  });

  it("설정을 읽지 못하면 숫자 없이 정의만 — '지금 설정'은 그리지 않는다", async () => {
    reads["/api/paper/settings"] = () => Promise.reject(new Error("설정을 읽지 못했습니다."));
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });
    expect(within(panel).getByText("운용 방식")).toBeTruthy();
    await waitFor(() => expect(paths.some((path) => path.startsWith("/api/paper/settings"))).toBe(true));
    expect(within(panel).queryByText("지금 설정")).toBeNull();
    expect(within(panel).queryByText("트레일링 스탑")).toBeNull();
  });

  it("묶음이 셋 이상이면 도넛 — 상위 3종목 + 기타 + 현금·현금성(SHY), 범례와 표(차트의 표 보기)", async () => {
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });
    const composition = within(panel).getByRole("region", { name: "구성" });

    const donut = await within(composition).findByRole("list", { name: "구성 도넛" });
    const slices = within(donut).getAllByRole("listitem");
    expect(slices.map((li) => li.textContent)).toEqual([
      "NVDA 20.0%", "AAPL 15.0%", "MSFT 12.0%", "기타 3종목 22.5%", "현금·현금성(SHY) 30.5%",
    ]);
    // 색은 상위 셋이 고정 순서(파랑·주황·청록), 기타·현금은 회색 — 주황과 가까운 넷째 색(노랑)은 쓰지 않습니다(DV-1).
    expect(slices.map((li) => li.getAttribute("data-color"))).toEqual([
      "#3987e5", "#d95926", "#199e70", "#606870", "#9ea7b3",
    ]);
    // 설명 문장의 종목 수는 lib의 상수에서 옵니다(ACCT-5 — 상수를 바꾸면 문장도 같이).
    expect(within(composition).getByText(new RegExp(`상위 ${COMPOSITION_TOP_N}종목은 따로`))).toBeTruthy();
    // 범례는 늘 있습니다 — 기타의 종목과 현금·현금성의 내역까지.
    const legend = within(composition).getByRole("list", { name: "구성 범례" });
    expect(within(legend).getByText("AMZN·META·GOOG")).toBeTruthy();
    expect(within(legend).getByText("현금 500.00 달러 + SHY 30,366.00 달러")).toBeTruthy();

    // 표 — 종목 · 비중 · 평가액 · 수익률 · 수량, 현금 줄까지
    const table = within(composition).getByRole("table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([
      "종목", "비중", "평가액", "수익률(평단 대비)", "수량",
    ]);
    const firstCells = (label: string) =>
      within(within(table).getByText(label).closest("tr") as HTMLElement).getAllByRole("cell").map((td) => td.textContent);
    expect(firstCells("NVDA")).toEqual(["NVDA", "20.0%", "20,240.00 달러", "+1.50%", "10"]);
    expect(firstCells("SHY")).toEqual(["SHY현금성", "30.0%", "30,366.00 달러", "+1.50%", "10"]);
    expect(firstCells("현금")).toEqual(["현금", "0.5%", "500.00 달러", "—", "—"]);
    expect(within(composition).queryByRole("img")).toBeNull();
  });

  it("의미 있는 묶음이 둘 이하(SPY + 잔돈)면 도넛 대신 한 줄 막대 + 범례 + 표", async () => {
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /SPY 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "SPY 계좌 상세" });
    const composition = within(panel).getByRole("region", { name: "구성" });

    expect(await within(composition).findByRole("img", { name: "SPY 계좌 구성: SPY 99.8%, 현금 0.2%" })).toBeTruthy();
    expect(within(composition).queryByRole("list", { name: "구성 도넛" })).toBeNull();
    expect(within(composition).getByRole("list", { name: "구성 범례" })).toBeTruthy();
    expect(within(composition).getByRole("table")).toBeTruthy();
    // 벤치마크는 결정을 내지 않으므로 결정 로그 단추가 없습니다.
    expect(within(panel).queryByRole("button", { name: "결정 로그 보기" })).toBeNull();
    expect(within(panel).getByText("체결이 없습니다.")).toBeTruthy();
  });

  it("최근 체결은 다섯 건만 읽는다(limit=5)", async () => {
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /규칙 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "규칙 계좌 상세" });
    const recent = within(panel).getByRole("region", { name: "최근 체결" });
    expect(await within(recent).findByText("202.4101")).toBeTruthy();
    expect(within(recent).getByText("사후 체결")).toBeTruthy();
    expect(paths).toContain("/api/paper/books/rules/fills?limit=5");
  });
});

describe("다른 탭으로", () => {
  it("'보유·체결 탭에서 전체 보기'는 그 탭으로 바꾸며 이 계좌를 미리 고른다 — 탭 단추로 다시 오면 기본 계좌", async () => {
    reads["/api/paper/books/bench_mix/positions"] = () => Promise.resolve({ ...SPY_POSITIONS, book: BOOKS[3] });
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /60\/40 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "60/40 계좌 상세" });

    fireEvent.click(within(panel).getByRole("button", { name: "보유·체결 탭에서 전체 보기" }));

    const tab = screen.getByRole("tab", { name: "보유·체결" });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab);
    expect((screen.getByLabelText("계좌 고르기") as HTMLSelectElement).value).toBe("bench_mix");

    // 탭 단추로 직접 오면 미리 고름이 지워져 기본 계좌(처음으로 시작한 계좌)로 엽니다.
    fireEvent.click(screen.getByRole("tab", { name: "개요" }));
    fireEvent.click(await screen.findByRole("tab", { name: "보유·체결" }));
    expect((screen.getByLabelText("계좌 고르기") as HTMLSelectElement).value).toBe("rules");
  });

  it("규칙·Claude 계좌의 '결정 로그 보기'는 결정 로그 탭에서 그 계좌를 고른다", async () => {
    reads["/api/paper/books/claude/positions"] = () => Promise.resolve({ available: true, book: BOOKS[1], cash: 100000, lockouts: [], positions: [] });
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("button", { name: /Claude 계좌 상세 보기/ }));
    const panel = await screen.findByRole("region", { name: "Claude 계좌 상세" });
    // 현금만 든 계좌 — 묶음 하나라 도넛이 아니라 한 줄 막대
    expect(await within(panel).findByRole("img", { name: "Claude 계좌 구성: 현금 100.0%" })).toBeTruthy();

    fireEvent.click(within(panel).getByRole("button", { name: "결정 로그 보기" }));

    expect(screen.getByRole("tab", { name: "결정 로그" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByLabelText("계좌 고르기") as HTMLSelectElement).value).toBe("claude");
  });
});
