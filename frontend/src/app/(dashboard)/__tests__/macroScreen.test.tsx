/**
 * 매크로 화면(/macro) — 작업대 화면 언어 P5a 배치에서 고정하는 것.
 *  - 원본 데이터: 화면 머리의 동작 둘('원본 데이터 보기' 대화상자·'원본 데이터 복사'), 열 때만 읽음, 생성 시각·글자 수·다시 읽기·오류와 다시 시도
 *  - 장단기 금리차: 묶음 머리(h3) + KPI 띠 둘(값 부호·'%p' 단위·변화 칩), 해석 기준표는 처음에 접힘(펼치기 머리 + 공용 표)
 *  - 신용·변동성: KPI 띠(단위·변화 칩·기준일·출처, 못 받은 값 '—'+'수집 실패', MOVE는 '대리 지표' 배지 + 주의 상태 글), 해석 기준표 접힘
 *  - 심화 지표: KPI 띠 — 해석 색은 상태 아이콘 + 글(빨강 위험은 '주의:' 머리말, 값 글자색으로 전하지 않음), 메모 '표본 백분위 · 표본 · 기준일'
 *  - 환율 비교: 고른 계열 KPI 띠(끝값·단위, 기간 변화율 칩 + '기간', 메모 '기준일 … · 최근 …'), 계열 칩 aria-pressed 그대로
 *  - 비공식 시세·경제 캘린더: 공용 표(항목·지표가 행 머리, 개수 줄, 받지 못한 현재가 '—'+'수집 실패', 캘린더는 조밀 표)
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), apiBase: () => "http://backend", UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { EconCalendarSection } from "../macro/EconCalendarSection";
import MacroPage from "../macro/page";
import { ScrapedSection } from "../macro/ScrapedSection";

const SNAPSHOT_PATH = "/api/snapshot/text";

/** 경로 앞부분 → 응답(함수면 부를 때마다 새로). 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, () => Promise<unknown>> = {};

function snapshotCalls(): number {
  return api.apiGetShared.mock.calls.filter(([path]) => path === SNAPSHOT_PATH).length;
}

beforeEach(() => {
  reads = {};
  window.localStorage.clear();
  api.apiGet.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("원본 데이터 — 화면 머리 동작", () => {
  it("'원본 데이터 보기'는 대화상자 단추이고 열기 전에는 읽지 않는다 — 열면 생성 시각·글자 수·본문, 닫으면 연 단추로 돌아온다", async () => {
    reads[SNAPSHOT_PATH] = () => Promise.resolve({ text: "== 매크로 ==\n원/달러 1,389.46", chars: 1234, generatedAtKst: "2026-11-17 06:31 KST" });
    render(<MacroPage />);

    const header = screen.getByRole("heading", { level: 1, name: "거시경제 매크로 지표" }).closest("header") as HTMLElement;
    const open = within(header).getByRole("button", { name: "원본 데이터 보기" });
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    expect(within(header).getByRole("button", { name: "원본 데이터 복사" })).toBeTruthy();
    expect(snapshotCalls()).toBe(0);

    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "전체 대시보드 원본 데이터" });
    expect(await within(dialog).findByText(/원\/달러 1,389\.46/)).toBeTruthy();
    expect(within(dialog).getByText("2026-11-17 06:31 생성 · 1,234자")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "다시 읽기" })).toBeTruthy();
    expect(snapshotCalls()).toBe(1);

    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(open);
  });

  it("'다시 읽기'는 한 번 더 읽는다 — 첫 읽기에 실패하면 오류와 다시 시도", async () => {
    let calls = 0;
    reads[SNAPSHOT_PATH] = () => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error("요청 실패 (HTTP 503)"))
        : Promise.resolve({ text: `원본 글 ${calls}`, chars: 6, generatedAtKst: "2026-11-17 06:31 KST" });
    };
    render(<MacroPage />);

    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
    const dialog = await screen.findByRole("dialog", { name: "전체 대시보드 원본 데이터" });
    expect(await within(dialog).findByText("요청 실패 (HTTP 503)")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    expect(await within(dialog).findByText("원본 글 2")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "다시 읽기" }));
    expect(await within(dialog).findByText("원본 글 3")).toBeTruthy();
    expect(snapshotCalls()).toBe(3);
  });
});

// QA-623: 원본 글을 받은 뒤 '다시 읽기'가 실패하면 useApi는 앞 글을 남기고 실패를 refreshError로만 알리는데, 원본 데이터 화면은 error만 그려
// 실패가 아무 표시 없이 묻혔습니다(개편 전 카드부터 — 단추가 '다시 읽는 중…'에서 '다시 읽기'로 돌아올 뿐). 다른 패널의 '새로 읽지 못함'(QA-067)과 같은 표시가 필요합니다.
describe("QA-623 원본 데이터 '다시 읽기' 실패를 알린다", () => {
  it("받은 글이 있는 동안 다시 읽기에 실패하면 '새로 읽지 못함'과 함께 앞 글을 그대로 보인다", async () => {
    let calls = 0;
    reads[SNAPSHOT_PATH] = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve({ text: "원본 글", chars: 4, generatedAtKst: "2026-11-17 06:31 KST" })
        : Promise.reject(new Error("요청 실패 (HTTP 503)"));
    };
    render(<MacroPage />);

    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
    const dialog = await screen.findByRole("dialog", { name: "전체 대시보드 원본 데이터" });
    await within(dialog).findByText("원본 글");

    fireEvent.click(within(dialog).getByRole("button", { name: "다시 읽기" }));
    await waitFor(() => expect(snapshotCalls()).toBe(2));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "다시 읽기" }).hasAttribute("disabled")).toBe(false));

    expect(within(dialog).queryByText("새로 읽지 못함")).not.toBeNull();
    expect(within(dialog).getByText("원본 글")).toBeTruthy();
  });
});

describe("장단기 금리차", () => {
  const block = (over: Record<string, unknown>) => ({
    longId: "DGS10", shortId: "DGS2", points: [{ date: "2026-11-13", value: 0.512 }], latest: 0.512, previous: 0.5,
    scraped: { longValue: 4.1, shortValue: 3.6, spread: 0.5, previousSpread: 0.52, delta: -0.02 }, ...over,
  });
  const overview = {
    available: true, collectedAtKst: "2026-11-17 06:30 KST", categories: [],
    spreads: { realtime: { longValue: null, shortValue: null, spread: null, previousSpread: null, delta: null },
      official10y2y: block({}), official30y2y: block({ longId: "DGS30" }) },
  };

  it("묶음 머리(h3)와 KPI 띠 둘 — 값은 부호·셋째 자리에 '%p' 단위를 따로, 변화는 칩, 기준일·출처 줄", async () => {
    reads["/api/macro/overview"] = () => Promise.resolve(overview);
    render(<MacroPage />);

    const panel = (await screen.findByRole("heading", { level: 2, name: "10Y−2Y 장단기 금리차" })).closest("section") as HTMLElement;
    expect(within(panel).getByRole("heading", { level: 3, name: /공식 확정치 · FRED/ })).toBeTruthy();
    expect(within(panel).getByRole("heading", { level: 3, name: /스크래핑 참고 시세 · TradingView/ })).toBeTruthy();
    const official = within(panel).getByRole("region", { name: "10Y−2Y 공식 확정치" });
    const tile = within(official).getByRole("group", { name: "10Y−2Y 스프레드" });
    // 값 단위(첫째)는 값과 따로 작은 보조 글, 변화 칩의 단위는 칩 안(둘째).
    expect(within(tile).getAllByText("%p")[0].className).toContain("text-text-3");
    expect(tile.textContent).toContain("+0.512%p");
    expect(tile.textContent).toContain("+0.012%p");
    expect(tile.textContent).toContain("직전 확정치 대비");
    expect(tile.textContent).toContain("FRED DGS10 − DGS2 · 2026-11-13");
    const scraped = within(panel).getByRole("region", { name: "10Y−2Y 스크래핑 참고 시세" });
    expect(within(scraped).getByRole("group", { name: "10Y−2Y 스프레드" }).textContent).toContain("−0.020%p");
    expect(within(scraped).getByText("하락").className).toContain("sr-only");
  });

  it("해석 기준표는 처음에 접혀 있고(펼치기 머리 '해석 기준 보기') 안에 공용 표 — '역전'은 경고 상태 글", async () => {
    reads["/api/macro/overview"] = () => Promise.resolve(overview);
    render(<MacroPage />);

    const panel = (await screen.findByRole("heading", { level: 2, name: "장단기 금리차 해석 기준" })).closest("section") as HTMLElement;
    const details = panel.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByText("해석 기준 보기").tagName).toBe("SUMMARY");
    const table = details.querySelector("table") as HTMLTableElement;
    expect(table.querySelector("caption")?.textContent).toBe("장단기 금리차 해석 기준");
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual([
      "정상 (Normal)", "평탄화 (Flattening)", "주의: 역전 (Inversion)",
    ]);
  });
});

describe("신용·변동성", () => {
  const entry = (over: Record<string, unknown>) => ({ available: true, value: 18.2, delta: -0.4, asOf: "2026-11-14", ...over });
  const risk = {
    vix: entry({}),
    move: entry({ value: 92.1, isProxy: true, sourceLabel: "^TNX 변동성 기반 추정 (실제 ICE BofA MOVE 아님)" }),
    hyOas: entry({ value: 2.95, delta: 0.03 }),
    cpSpread: entry({ available: false, value: null, delta: null, asOf: null }),
    stlfsi: entry({ value: -0.52, delta: 0.1 }),
  };

  it("KPI 띠 다섯 — 단위는 값과 따로, 변화는 칩, 기준일·출처 줄, 못 받은 값은 '—'와 '수집 실패', MOVE는 대리 지표 배지와 주의 상태", async () => {
    reads["/api/macro/risk"] = () => Promise.resolve(risk);
    render(<MacroPage />);

    const panel = (await screen.findByRole("heading", { level: 2, name: "신용 리스크, 은행권 및 시장 변동성" })).closest("section") as HTMLElement;
    const strip = await within(panel).findByRole("region", { name: "신용·변동성 지표" });
    expect(within(strip).getAllByRole("group")).toHaveLength(5);

    const vix = within(strip).getByRole("group", { name: "CBOE VIX (주식 변동성)" });
    expect(vix.textContent).toContain("18.20");
    expect(vix.textContent).toContain("−0.40");
    expect(within(vix).getByText("하락").className).toContain("sr-only");
    expect(vix.textContent).toContain("기준일 2026-11-14");
    expect(vix.textContent).toContain("Yahoo Finance (^VIX)");

    const hy = within(strip).getByRole("group", { name: "하이일드 스프레드 (HY OAS)" });
    expect(hy.textContent).toContain("2.95%p");
    expect(hy.textContent).toContain("+0.03%p");

    const cp = within(strip).getByRole("group", { name: "3M 금융 CP 스프레드" });
    expect(within(cp).getByText("—")).toBeTruthy();
    expect(within(cp).getByText("수집 실패")).toBeTruthy();
    expect(cp.textContent).not.toContain("—%p");

    const move = within(strip).getByRole("group", { name: "MOVE (채권 변동성)" });
    expect(within(move).getByText("대리 지표")).toBeTruthy();
    expect(within(move).getByText(/실제 지표가 아닙니다 — \^TNX 변동성 기반 추정/).parentElement?.className).toContain("text-warn");
    expect(within(move).getByText("주의:").className).toContain("sr-only");

    expect(within(strip).getByRole("group", { name: "세인트루이스 연준 금융스트레스" }).textContent).toContain("−0.52pt");
  });

  it("해석 기준표는 처음에 접혀 있다(펼치기 머리 = 표 이름)", async () => {
    reads["/api/macro/risk"] = () => Promise.resolve(risk);
    render(<MacroPage />);

    const panel = (await screen.findByRole("heading", { level: 2, name: "신용 리스크, 은행권 및 시장 변동성" })).closest("section") as HTMLElement;
    const summary = await within(panel).findByText("신용·은행권·변동성 핵심 해석 기준표", { selector: "summary" });
    expect(summary.tagName).toBe("SUMMARY");
    expect((summary.closest("details") as HTMLDetailsElement).open).toBe(false);
    expect(within(summary.closest("details") as HTMLElement).getAllByRole("rowheader")).toHaveLength(5);
  });
});

describe("심화 지표", () => {
  const advanced = {
    order: ["T10Y3M", "BAMLC0A0CM", "NFCI", "DFII10"],
    latest: {
      T10Y3M: { id: "T10Y3M", label: "10Y-3M", unit: "%p", digits: 2, group: "금리", why: "역전 신호", source: "FRED T10Y3M", available: true,
        value: -0.62, delta: -0.04, asOf: "2026-11-13", percentile: 3.4, percentileFrom: "2016-11-14", percentileCount: 2500, percentileYears: 10,
        status: "깊은 역전", color: "red", note: "침체가 뒤따른 구간입니다." },
      BAMLC0A0CM: { id: "BAMLC0A0CM", label: "IG 스프레드", unit: "%p", digits: 2, group: "신용", why: "", source: "FRED BAMLC0A0CM", available: true,
        value: 1.2, delta: 0.01, status: "경계", color: "orange" },
      NFCI: { id: "NFCI", label: "NFCI", unit: "", digits: 3, group: "금융상황", why: "", source: "FRED NFCI", available: true,
        value: -0.5, delta: 0.01, asOf: "2026-11-07", status: "매우 완화", color: "green" },
      DFII10: { id: "DFII10", label: "10년 실질금리", unit: "%", digits: 2, group: "금리", why: "", source: "FRED DFII10", available: false },
    },
    derived: {},
  };

  it("해석 색은 상태 아이콘 + 글 — 위험(빨강)은 '오류:'가 아니라 '주의:', 주의(주황)·정상(초록), 값 글자색으로 전하지 않는다", async () => {
    reads["/api/macro/advanced"] = () => Promise.resolve(advanced);
    render(<MacroPage />);

    const strip = await screen.findByRole("region", { name: "심화 지표" });
    const curve = within(strip).getByRole("group", { name: "10Y-3M" });
    const deep = within(curve).getByText("깊은 역전");
    expect(deep.parentElement?.className).toContain("text-danger");
    expect(deep.parentElement?.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(within(curve).getByText("주의:").className).toContain("sr-only");
    expect(within(curve).queryByText("오류:")).toBeNull();
    // 값 글은 본문 잉크 — 해석 색(예전 statusColor)으로 칠하지 않습니다.
    const value = within(curve).getByText("−0.6", { exact: false });
    expect(value.className).toContain("text-text");
    expect(value.className).not.toMatch(/text-(danger|warn|ok)/);

    expect(within(within(strip).getByRole("group", { name: "IG 스프레드" })).getByText("경계").parentElement?.className).toContain("text-warn");
    expect(within(within(strip).getByRole("group", { name: "NFCI" })).getByText("매우 완화").parentElement?.className).toContain("text-ok");
  });

  it("메모는 해석 글 다음에 '표본 백분위 · 표본 · 기준일', 못 받은 지표는 '—'와 '수집 실패'", async () => {
    reads["/api/macro/advanced"] = () => Promise.resolve(advanced);
    render(<MacroPage />);

    const strip = await screen.findByRole("region", { name: "심화 지표" });
    expect(within(strip).getByRole("group", { name: "10Y-3M" }).textContent).toContain(
      "침체가 뒤따른 구간입니다. 표본 백분위 3.4% · 표본 2016-11-14 이후 2,500개 · 약 10.0년 · 기준일 2026-11-13",
    );
    const real = within(strip).getByRole("group", { name: "10년 실질금리" });
    expect(within(real).getByText("수집 실패")).toBeTruthy();
    expect(real.textContent).not.toContain("—%");
  });
});

describe("환율 비교", () => {
  it("고른 계열은 KPI 띠 — 끝값·단위, 기간 변화율은 칩과 '기간', 메모 '기준일 … · 최근 …' — 계열 칩은 그대로", async () => {
    reads["/api/macro/fx"] = () => Promise.resolve({
      available: true, period: "1y", mode: "index",
      catalog: [{ id: "usdkrw", label: "원/달러", unit: "원", ticker: "KRW=X" }, { id: "dxy", label: "달러 인덱스", unit: null, ticker: "DX-Y.NYB" }],
      series: [
        { id: "usdkrw", label: "원/달러", unit: "원", ticker: "KRW=X", available: true, latest: 1389.456, latestDate: "2026-11-14",
          baseDate: "2025-11-14", baseValue: 1300, changePct: 6.88, points: [{ date: "2026-11-14", value: 106.88 }] },
        { id: "dxy", label: "달러 인덱스", unit: null, ticker: "DX-Y.NYB", available: true, latest: 99.5, latestDate: "2026-11-14",
          baseDate: "2025-11-14", baseValue: 104, changePct: -4.33, points: [{ date: "2026-11-14", value: 95.67 }] },
      ],
    });
    render(<MacroPage />);

    const strip = await screen.findByRole("region", { name: "고른 환율 계열" });
    const krw = within(strip).getByRole("group", { name: "원/달러" });
    expect(krw.textContent).toContain("1,389.46원");
    expect(krw.textContent).toContain("+6.88%");
    expect(within(krw).getByText("기간")).toBeTruthy();
    expect(krw.textContent).toContain("기준일 2025-11-14 · 최근 2026-11-14");
    const dxy = within(strip).getByRole("group", { name: "달러 인덱스" });
    expect(dxy.textContent).toContain("−4.33%");
    expect(within(dxy).getByText("하락").className).toContain("sr-only");

    const panel = screen.getByRole("heading", { level: 2, name: "환율·달러인덱스 비교" }).closest("section") as HTMLElement;
    expect(within(panel).getByRole("button", { name: "원/달러" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("비공식 시세·경제 캘린더 — 공용 표", () => {
  it("비공식 시세: 항목이 행 머리, 개수 줄, 받지 못한 현재가는 '—'와 '수집 실패', 이어받은 값은 비고에 '이전 값'", async () => {
    reads["/api/macro/scraped"] = () => Promise.resolve({ available: true, updatedAt: "2026-11-17T06:30:00+09:00", items: [
      { key: "wti", name: "WTI 원유", provider: "TradingView", unit: "USD", status: "ok", price: 60.5, previousClose: 61.25, changePct: -1.22,
        error: null, delayMinutes: 10, isStale: true, staleReason: "HTTP 429" },
      { key: "kospi200", name: "코스피200 야간", provider: "TradingView", unit: "pt", status: "fail", price: null, previousClose: null,
        changePct: null, error: "응답 없음", delayMinutes: null },
    ] });
    render(<ScrapedSection />);

    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["WTI 원유", "코스피200 야간"]);
    expect(screen.getByText("2개")).toBeTruthy();
    const failed = screen.getByText("코스피200 야간").closest("tr") as HTMLElement;
    expect(within(failed).getByText("수집 실패")).toBeTruthy();
    expect(within(failed).getByText("응답 없음")).toBeTruthy();
    const stale = screen.getByText("WTI 원유").closest("tr") as HTMLElement;
    expect(within(stale).getByText(/이전 값 — HTTP 429/).closest("span[class*='text-warn']")).toBeTruthy();
  });

  it("경제 캘린더: 조밀 표(일정 기록) — 지표가 행 머리, 개수 줄", async () => {
    reads["/api/macro/econ-calendar"] = () => Promise.resolve({ available: true, collectedAtKst: "2026-11-05 12:00 KST", events: [
      { id: "1", country: "US", title: "Initial Jobless Claims", at: "2026-11-05T13:30:00+00:00", atKst: "2026-11-05 22:30 KST",
        importance: 0, actual: 218, forecast: 220, previous: 219, unit: null, scale: "K", period: null },
    ] });
    render(<SessionUserProvider user={{ email: "owner@test.local", role: "OWNER", tier: "PRO" }}><EconCalendarSection /></SessionUserProvider>);

    const header = await screen.findByRole("rowheader", { name: "Initial Jobless Claims" });
    // 조밀 표 — 넓은 화면 행 28px의 칸 여백(공용 표 dense).
    expect(header.className).toContain("lg:py-1");
    expect(screen.getByText("1건")).toBeTruthy();
  });
});
