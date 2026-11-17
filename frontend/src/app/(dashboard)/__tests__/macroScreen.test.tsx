/**
 * 매크로 화면(/macro) — 작업대 화면 언어 P5a 배치에서 고정하는 것.
 *  - 원본 데이터: 화면 머리의 동작 둘('원본 데이터 보기' 대화상자·'원본 데이터 복사'), 열 때만 읽음, 생성 시각·글자 수·다시 읽기·오류와 다시 시도
 *  - 장단기 금리차: 묶음 머리(h3) + KPI 띠 둘(값 부호·'%p' 단위·변화 칩), 해석 기준표는 처음에 접힘(펼치기 머리 + 공용 표)
 *  - 신용·변동성: KPI 띠(단위·변화 칩·기준일·출처, 못 받은 값 '—'+'수집 실패', MOVE는 '대리 지표' 배지 + 주의 상태 글), 해석 기준표 접힘
 *  - 심화 지표: KPI 띠 — 해석 색은 상태 아이콘 + 글(빨강 위험은 '주의:' 머리말, 값 글자색으로 전하지 않음), 메모 '표본 백분위 · 표본 · 기준일'
 *  - 환율 비교: 고른 계열 KPI 띠(끝값·단위, 기간 변화율 칩 + '기간', 메모 '기준일 … · 최근 …'), 계열 칩 aria-pressed 그대로
 *  - 비공식 시세·경제 캘린더: 공용 표(항목·지표가 행 머리, 개수 줄, 받지 못한 현재가 '—'+'수집 실패', 캘린더는 조밀 표)
 *  - 지표 표: 범주마다 h3·부제·출처 줄과 공용 표(지표 행 머리 = 미리보기 단추 + '티커 · 시장', 값·변화 칩·기준), 실패 '—'+'수집 실패',
 *    추정·이전 값 배지·경고 상태 글. 미리보기: 넓은 화면은 옆 검사 칸(처음은 첫 지표, 고른 줄은 aria-current), 좁은 화면은 위쪽 대화상자 —
 *    값·변화·전일·기준 시각·장 상태·출처·전일값 출처·티커와 '지표 상세 열기'(/markets/i/키)
 *  - 목차: 회원 일곱·운영자 여덟(절 id = lib/marketSections), 지표 칸 아래 범주 칸(개수), 2xl부터 왼쪽 세로 목록(결정 7), 절 닻은 읽는 중에도 있음
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
import { MACRO_SECTIONS } from "@/lib/marketSections";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
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
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

/** 넓은 화면(lg 이상 — 셸의 왼쪽 메뉴가 보이는 폭)으로 흉내 냅니다. 틀 폭은 jsdom에서 0이라 크기 질의 배치(옆 칸)에 맡깁니다. */
function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

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

// QA-646: 원본 글 스크롤 상자 <pre tabIndex=0 aria-label="원본 데이터 글">에 역할이 없었습니다 — pre는 generic 역할이라 ARIA 1.2에서 aria-label이
// 금지되고 보조기기가 이름을 무시해, Tab 정지점이 이름 없이 읽혔습니다(P5a가 대화상자로 옮기며 이름을 붙임, P5a 검토). 같은 목적의 공용 표 스크롤 상자처럼
// 이름 있는 영역(role=region)이어야 이름이 붙습니다.
describe("QA-646 원본 글 스크롤 상자는 이름 있는 영역", () => {
  it("Tab으로 닿는 원본 글 상자가 role=region '원본 데이터 글'", async () => {
    reads[SNAPSHOT_PATH] = () => Promise.resolve({ text: "원본 글", chars: 4, generatedAtKst: "2026-11-17 06:31 KST" });
    render(<MacroPage />);
    fireEvent.click(screen.getByRole("button", { name: "원본 데이터 보기" }));
    const dialog = await screen.findByRole("dialog", { name: "전체 대시보드 원본 데이터" });
    await within(dialog).findByText("원본 글");
    const box = within(dialog).getByRole("region", { name: "원본 데이터 글" });
    expect(box.tagName).toBe("PRE");
    expect(box.getAttribute("tabindex")).toBe("0");
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

describe("지표 표와 미리보기", () => {
  const card = (over: Record<string, unknown>) => ({
    status: "ok", priceStr: "1.00", deltaStr: "+0.00 (+0.00%)", prevStr: "1.00", delta: 0, pct: 0, delayMinutes: 0, ...over,
  });
  const OVERVIEW = {
    available: true,
    collectedAtKst: "2026-10-20 19:54 KST",
    categories: [
      { id: "ust", title: "🏛️ 미국 국채 수익률", items: [
        card({ key: "us10y", name: "미국채 10년물 수익률(%)", ticker: "^TNX", market: "ust", priceStr: "4.123", delta: -0.012, pct: -0.29,
          deltaStr: "-0.012 (-0.29%)", prevStr: "4.135", prevSource: "FRED DGS10 (공식)", isReference: true, isEstimated: true,
          source: "TradingView Scanner", lastTs: "2026-10-20 19:54 KST (TradingView 수집 시각)" }),
        card({ key: "us02y", name: "미국채 2년물 수익률(%)", ticker: "^IRX", market: "ust", status: "fail", priceStr: "N/A", deltaStr: "N/A",
          delta: null, pct: null, prevStr: "N/A" }),
      ] },
      { id: "us_equity", title: "미국 주가지수", items: [
        card({ key: "sp500", name: "S&P 500", ticker: "^GSPC", market: "nyse", priceStr: "6,812.50", delta: 22.4, pct: 0.33,
          deltaStr: "+22.40 (+0.33%)", prevStr: "6,790.10", delayMinutes: 10, source: "Yahoo Finance (^GSPC)", lastTs: "2026-10-20 04:59 KST",
          isStale: true, staleReason: "HTTP 429", warning: "선물 조회 실패 · 지수 값" }),
      ] },
    ],
  };

  beforeEach(() => {
    // 2026-10-20 19:54 KST = 뉴욕 06:54 — 미국 국채 전자거래는 개장, 뉴욕 증시는 장 전(마감).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T10:54:00Z"));
    reads["/api/macro/overview"] = () => Promise.resolve(OVERVIEW);
  });
  afterEach(() => vi.useRealTimers());

  it("패널 '지표'(개수)·범주마다 h3·부제·출처 줄과 공용 표 — 지표가 행 머리(미리보기 단추 + '티커 · 시장'), 값·변화 칩·기준 칸", async () => {
    render(<MacroPage />);

    // 값이 오면 패널 머리에 개수가 생겨 제목(h2) 요소가 다시 그려지므로, 범주 제목을 먼저 기다린 뒤 패널을 찾습니다.
    await screen.findByRole("heading", { level: 3, name: "미국 국채 수익률" });
    const panel = screen.getByRole("heading", { level: 2, name: "지표" }).closest("section") as HTMLElement;
    expect(within(panel).getByText("3개")).toBeTruthy();
    expect(within(panel).getByRole("heading", { level: 3, name: "미국 주가지수" })).toBeTruthy();
    expect(within(panel).getAllByText("시세: 실시간").length).toBeGreaterThan(0);

    const tables = within(panel).getAllByRole("table");
    expect(tables.map((table) => table.querySelector("caption")?.textContent)).toEqual(["미국 국채 수익률 지표", "미국 주가지수 지표"]);
    expect(within(tables[0]).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["지표", "값", "변화", "기준"]);

    const us10y = within(tables[0]).getByRole("rowheader", { name: /미국채 10년물 수익률/ });
    const trigger = within(us10y).getByRole("button", { name: "미국채 10년물 수익률(%)" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("dialog");
    expect(us10y.textContent).toContain("^TNX · 미국 국채");
    const row = us10y.closest("tr") as HTMLElement;
    expect(within(row).getByText("4.123")).toBeTruthy();
    expect(row.textContent).toContain("−0.012");
    expect(within(row).getByText("하락").className).toContain("sr-only");
    expect(row.textContent).toContain("TradingView Scanner · 참고 시세 · 개장 · 실시간");
    expect(within(row).getByText("추정")).toBeTruthy();
  });

  it("수집 실패 줄은 값 '—'와 '수집 실패', 변화 '—' — 이어받은 줄은 '이전 값'과 사유, 카드 경고는 상태 글", async () => {
    render(<MacroPage />);

    const failed = (await screen.findByRole("button", { name: "미국채 2년물 수익률(%)" })).closest("tr") as HTMLElement;
    const cells = within(failed).getAllByRole("cell");
    expect(within(cells[0]).getByText("—")).toBeTruthy();
    expect(within(cells[0]).getByText("수집 실패")).toBeTruthy();
    expect(within(cells[1]).getByText("—")).toBeTruthy();
    expect(failed.textContent).not.toContain("0.00");

    const stale = screen.getByRole("button", { name: "S&P 500" }).closest("tr") as HTMLElement;
    expect(within(stale).getByText("이전 값").parentElement?.textContent).toContain("HTTP 429");
    expect(within(stale).getByText("선물 조회 실패 · 지수 값").parentElement?.className).toContain("text-warn");
  });

  // 2026-11-17 결정 9(사용자 위임 — 권장안 가): 좁은 화면(md 미만 — 390 등)은 지표·값 두 칸의 두 줄 행. 예전에는 332px 상자 안 640px 표라 변화 칸이
  // 잘리고 기준 칸(추정·이전 값 배지 포함)은 가로로 넘겨야 보였습니다. md 이상은 그대로 네 칸(md~lg는 최소 640px + 넘김 안내).
  it("좁은 화면(md 미만): 두 줄 행 — 지표·값 두 칸, 이름 칸 둘째 줄에 변화 칩·추정·이전 값 배지·경고, 최소 폭·넘김 안내 없음, 기준은 미리보기", async () => {
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({ matches: query === "(width < 48rem)", media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
    );
    render(<MacroPage />);

    await screen.findByRole("heading", { level: 3, name: "미국 국채 수익률" });
    const panel = screen.getByRole("heading", { level: 2, name: "지표" }).closest("section") as HTMLElement;
    const tables = within(panel).getAllByRole("table");
    for (const table of tables) {
      expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["지표", "값"]);
      expect(table.className.split(/\s+/)).not.toContain("min-w-[640px]");
    }
    expect(within(panel).queryByText("← 표를 좌우로 넘겨 보세요")).toBeNull();

    // 추정·변화(하락 칩)는 이름 칸의 둘째 줄 — 같은 줄의 값 칸과 함께 가로로 넘기지 않고 보입니다.
    const us10y = within(tables[0]).getByRole("rowheader", { name: /미국채 10년물 수익률/ });
    const line = us10y.querySelector("[data-macro-narrow-line]") as HTMLElement;
    expect(line.textContent).toContain("−0.012");
    expect(within(line).getByText("하락").className).toContain("sr-only");
    expect(within(line).getByText("변화").className).toContain("sr-only");
    expect(within(line).getByText("추정")).toBeTruthy();
    const row = us10y.closest("tr") as HTMLElement;
    expect(within(row).getAllByRole("cell")).toHaveLength(1);
    expect(within(row).getByRole("cell").textContent).toBe("4.123");
    // 기준 칸의 출처·장 상태는 줄에 없고(넓은 화면의 기준 칸), 수집 실패 줄의 변화는 '—'(0.00%를 만들지 않음).
    expect(row.textContent).not.toContain("TradingView Scanner");
    const failed = within(tables[0]).getByRole("rowheader", { name: /미국채 2년물/ });
    expect(within(failed.querySelector("[data-macro-narrow-line]") as HTMLElement).getByText("—")).toBeTruthy();
    expect(failed.closest("tr")?.textContent).not.toContain("0.00");

    // 이어받은 줄은 '이전 값'과 사유, 카드 경고는 상태 글 — 모두 둘째 줄.
    const sp500 = within(tables[1]).getByRole("rowheader", { name: /S&P 500/ });
    const staleLine = sp500.querySelector("[data-macro-narrow-line]") as HTMLElement;
    expect(within(staleLine).getByText("이전 값").parentElement?.textContent).toContain("HTTP 429");
    expect(within(staleLine).getByText("선물 조회 실패 · 지수 값").parentElement?.className).toContain("text-warn");

    // 기준(출처·장 상태·지연·시각)은 이름 단추가 여는 미리보기 대화상자에 있습니다.
    fireEvent.click(within(sp500).getByRole("button", { name: "S&P 500" }));
    const dialog = await screen.findByRole("dialog", { name: "S&P 500" });
    expect(within(dialog).getByText("출처").nextElementSibling?.textContent).toContain("Yahoo Finance (^GSPC)");
    expect(within(dialog).getByText("장 상태·지연").nextElementSibling?.textContent).toBe("마감");
  });

  it("md~lg(좁은 화면도 넓은 화면도 아님)는 네 칸 표 그대로 — 최소 640px(넘기면 안내), 둘째 줄 없음", async () => {
    render(<MacroPage />);

    await screen.findByRole("heading", { level: 3, name: "미국 국채 수익률" });
    const panel = screen.getByRole("heading", { level: 2, name: "지표" }).closest("section") as HTMLElement;
    const tables = within(panel).getAllByRole("table");
    expect(within(tables[0]).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["지표", "값", "변화", "기준"]);
    expect(tables[0].className.split(/\s+/)).toContain("min-w-[640px]");
    expect(panel.querySelector("[data-macro-narrow-line]")).toBeNull();
  });

  it("좁은 화면: 이름 단추는 위쪽 대화상자로 미리보기를 연다 — 속성·지표 상세 링크, 닫으면 단추로 포커스", async () => {
    render(<MacroPage />);

    const trigger = await screen.findByRole("button", { name: "S&P 500" });
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "S&P 500" });
    const terms = within(dialog).getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["값", "변화", "전일", "기준 시각", "장 상태·지연", "출처", "티커", "경고"]);
    const value = (name: string) => within(dialog).getByText(name).nextElementSibling?.textContent ?? "";
    expect(value("값")).toContain("6,812.50");
    expect(value("값")).toContain("이전 값");
    expect(value("변화")).toContain("+22.40");
    expect(value("전일")).toBe("6,790.10");
    expect(value("기준 시각")).toBe("2026-10-20 04:59");
    // 이어받은 값이라 지연은 적지 않습니다(지금 시세의 지연이 아님 — 장 상태만).
    expect(value("장 상태·지연")).toBe("마감");
    expect(value("출처")).toContain("Yahoo Finance (^GSPC)");
    expect(within(dialog).getByText("^GSPC").className).toContain("font-mono");
    expect(within(dialog).getByRole("link", { name: "지표 상세 열기" }).getAttribute("href")).toBe("/markets/i/sp500");

    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("넓은 화면: 옆 미리보기 칸 — 처음은 첫 지표, 이름을 누르면 그 지표(표의 고른 줄은 aria-current), 전일값 출처·추정 배지", async () => {
    stubWide();
    render(<MacroPage />);

    const inspector = await screen.findByRole("region", { name: "지표 미리보기 — 미국채 10년물 수익률(%)" });
    expect(within(inspector).getByRole("heading", { level: 3, name: "미국채 10년물 수익률(%)" })).toBeTruthy();
    expect(within(inspector).getByText("전일값 출처").nextElementSibling?.textContent).toBe("FRED DGS10 (공식)");
    expect(within(inspector).getByText("추정")).toBeTruthy();
    expect(within(inspector).getByText("기준 시각").nextElementSibling?.textContent).toBe("2026-10-20 19:54 (TradingView 수집 시각)");
    expect(screen.getByRole("button", { name: "미국채 10년물 수익률(%)" }).closest("tr")?.getAttribute("aria-current")).toBe("true");

    const sp500 = screen.getByRole("button", { name: "S&P 500" });
    expect(sp500.getAttribute("aria-controls")).toBe(inspector.id);
    sp500.focus();
    fireEvent.click(sp500);
    // 고른 줄이 바뀌어도 누른 단추가 그대로 남아 포커스를 잃지 않습니다(QA-624).
    expect(document.activeElement).toBe(sp500);
    const next = screen.getByRole("region", { name: "지표 미리보기 — S&P 500" });
    expect(within(next).getByRole("link", { name: "지표 상세 열기" }).getAttribute("href")).toBe("/markets/i/sp500");
    expect(sp500.closest("tr")?.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "미국채 10년물 수익률(%)" }).closest("tr")?.getAttribute("aria-current")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("목차와 절 닻", () => {
  const MEMBER = { email: "member@test.local", role: "MEMBER", tier: "PRO" } as const;
  const OWNER = { email: "owner@test.local", role: "OWNER", tier: "PRO" } as const;
  /** 목차의 첫 단계 칸 이름(가로 줄 — 세로 목록에도 같은 칸이 있음). */
  const topLinks = (nav: HTMLElement) => within(nav.querySelector("ul") as HTMLElement).getAllByRole("link");

  it("회원: 일곱 칸(같은 화면 절 링크) — 절 닻은 자료를 받기 전에도 모두 있다(경제 캘린더 없음)", () => {
    render(<SessionUserProvider user={MEMBER}><MacroPage /></SessionUserProvider>);

    const nav = screen.getByRole("navigation", { name: "매크로 지표 목차" });
    expect(topLinks(nav).map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["지표", `#${MACRO_SECTIONS.indicators}`],
      ["환율 비교", `#${MACRO_SECTIONS.fx}`],
      ["장단기 금리차", `#${MACRO_SECTIONS.spreads}`],
      ["신용·변동성", `#${MACRO_SECTIONS.risk}`],
      ["심화 지표", `#${MACRO_SECTIONS.advanced}`],
      ["단독 차트", `#${MACRO_SECTIONS.single}`],
      ["비공식 시세", `#${MACRO_SECTIONS.scraped}`],
    ]);
    for (const id of Object.values(MACRO_SECTIONS).filter((id) => id !== MACRO_SECTIONS.calendar)) {
      expect(document.getElementById(id)).not.toBeNull();
    }
    expect(document.getElementById(MACRO_SECTIONS.calendar)).toBeNull();
    // 금리차 절은 개요를 받기 전에도 비지 않습니다(읽는 중).
    expect(within(document.getElementById(MACRO_SECTIONS.spreads) as HTMLElement).getByText("장단기 금리차를 불러오는 중…")).toBeTruthy();
  });

  it("운영자: 여덟째 칸 '경제 캘린더'와 그 절 닻", () => {
    render(<SessionUserProvider user={OWNER}><MacroPage /></SessionUserProvider>);

    const nav = screen.getByRole("navigation", { name: "매크로 지표 목차" });
    expect(topLinks(nav)).toHaveLength(8);
    expect(topLinks(nav)[7].getAttribute("href")).toBe(`#${MACRO_SECTIONS.calendar}`);
    expect(document.getElementById(MACRO_SECTIONS.calendar)).not.toBeNull();
  });

  it("개요를 받으면 '지표' 칸에 개수와 범주 하위 칸(세로 목록 — 범주 닻으로), 2xl부터 왼쪽 13rem 세로 목록", async () => {
    reads["/api/macro/overview"] = () => Promise.resolve({ available: true, collectedAtKst: "2026-11-17 06:30 KST", categories: [
      { id: "ust", title: "🏛️ 미국 국채 수익률", items: [
        { key: "us10y", name: "미국채 10년물", status: "ok", priceStr: "4.123", deltaStr: "+0.010 (+0.24%)", delta: 0.01, pct: 0.24, delayMinutes: 0 },
        { key: "us02y", name: "미국채 2년물", status: "ok", priceStr: "3.600", deltaStr: "+0.010 (+0.28%)", delta: 0.01, pct: 0.28, delayMinutes: 0 },
      ] },
      { id: "us_equity", title: "미국 주가지수", items: [
        { key: "sp500", name: "S&P 500", status: "ok", priceStr: "6,812.50", deltaStr: "+22.40 (+0.33%)", delta: 22.4, pct: 0.33, delayMinutes: 0 },
      ] },
    ] });
    render(<SessionUserProvider user={MEMBER}><MacroPage /></SessionUserProvider>);

    const nav = screen.getByRole("navigation", { name: "매크로 지표 목차" });
    expect((await within(nav).findAllByRole("link", { name: "지표 (3)" })).length).toBe(2);
    const child = within(nav).getByRole("link", { name: "미국 국채 수익률 (2)" });
    expect(child.getAttribute("href")).toBe("#macro-cat-ust");
    expect(within(nav).getByRole("link", { name: "미국 주가지수 (1)" }).getAttribute("href")).toBe("#macro-cat-us-equity");
    expect(document.getElementById("macro-cat-ust")?.querySelector("h3")?.textContent).toBe("미국 국채 수익률");
    // 2xl부터 왼쪽 13rem 세로 목록 + 본문(1024~1535는 본문 위 가로 줄 — 목차 칸을 두면 지표 패널이 좁아 미리보기가 옆 칸이 되지 못함, 결정 7).
    const frameTokens = (nav.parentElement as HTMLElement).className.split(/\s+/);
    expect(frameTokens).toContain("2xl:grid-cols-[13rem_minmax(0,1fr)]");
    expect(frameTokens).not.toContain("xl:grid-cols-[13rem_minmax(0,1fr)]");
    expect(nav.getAttribute("data-section-index-bar")).toBe("2xl");
    expect((document.getElementById(MACRO_SECTIONS.indicators) as HTMLElement).className.split(/\s+/)).toContain("2xl:scroll-mt-4");
    expect((document.getElementById("macro-cat-ust") as HTMLElement).className.split(/\s+/)).toContain("2xl:scroll-mt-4");
  });
});

// QA-652: 목차 가로 줄(2xl 미만 — 결정 7 뒤 1024~1535와 좁은 화면)의 '지표' 칸은 개수를 모르는 동안 개수 자리가 없어, 개요가 와서 '21'이 생기면 뒤의
// 칸이 모두 오른쪽으로 밀렸습니다(자기 빌드 + QA API: '장단기 금리차' 칸 x 1024 388 → 405px·390 152 → 169px — 17px = 사이 4px + 숫자 두 자리).
// 읽는 동안의 자리(pendingChildren)는 세로 목록의 하위 칸 몫뿐이었습니다. 개요를 처음 읽는 동안에는 두 목록 모두 '지표' 칸에 개수 자리(글 없는 막대 —
// 숫자 두 자리 폭, 읽기에서 뺌)를 두어야 합니다.
describe("QA-652 목차 '지표' 칸은 개수를 읽는 동안 개수 자리를 잡는다", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 개수 자리가 없었습니다('expected null not to be null').
  it("개요를 처음 읽는 동안 가로 줄·세로 목록의 '지표' 칸에 개수 자리(숫자 두 자리 폭의 막대, 읽기에서 뺌) — 링크 이름은 '지표' 그대로", () => {
    render(<MacroPage />);
    const nav = screen.getByRole("navigation", { name: "매크로 지표 목차" });
    const [strip, column] = Array.from(nav.children) as HTMLElement[];
    for (const list of [strip, column]) {
      const link = within(list).getAllByRole("link", { name: "지표" })[0];
      const slot = link.querySelector("[data-section-index-count-pending]");
      expect(slot).not.toBeNull();
      expect(slot?.getAttribute("aria-hidden")).toBe("true");
      expect((slot?.getAttribute("class") ?? "").split(/\s+/)).toEqual(expect.arrayContaining(["w-[2ch]", "text-xs"]));
    }
  });
});
