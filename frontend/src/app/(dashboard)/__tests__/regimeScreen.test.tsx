/**
 * 국면(/regime) 화면 — 판정 대상(대상 머리·근거 넷·네 국면·탭 셋·연결·출처)과 국면 이력 띠·판정 기록·판정 성과의 뜻.
 * 가운데 탭 셋은 모두 마운트하고 고르지 않은 것은 hidden이라, 숨은 탭의 내용은 그 탭을 연 뒤에 역할로 찾습니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { regimeExpansion, regimeUnknown } from "@/lib/__tests__/homeFixtures";
import { endpoints } from "@/lib/endpoints";
import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";
import type { RegimeResponse } from "@/lib/types";
import RegimePage from "../regime/page";

/** 경로 → 응답(정확히 일치). 없는 경로는 끝나지 않는 요청(불러오는 중). */
let reads: Record<string, unknown> = {};

beforeEach(() => {
  reads = {};
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path in reads ? Promise.resolve(reads[path]) : new Promise(() => {})));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** 넓은 화면(lg 이상 — 왼쪽 메뉴가 보이는 폭)의 matchMedia 대역. */
function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

const REGIME = endpoints.insight.regime("5");
const REGIME_LOG = endpoints.insight.regimeLog(60);
const TRACK_SPY = endpoints.insight.regimeTrackRecord("SPY");

/** 하이픈(-)으로 쓴 음수 — 숫자 바로 앞의 '-'이고 앞 글자가 숫자·영문자가 아님(날짜 '2026-10-08'·이름 '10Y-3M'은 빼고). */
const ASCII_NEGATIVE = /(^|[^\dA-Za-z])-\d/;

/** 가운데 탭을 엽니다(누르기 — 화살표는 포커스만 옮김). */
async function openTab(name: string) {
  fireEvent.click(await screen.findByRole("tab", { name }));
}

async function panelTitled(name: string): Promise<HTMLElement> {
  return (await screen.findByRole("heading", { name })).closest("section") as HTMLElement;
}

/** 판정 기록 한 건 — 금리차·NFCI·순유동성 4주가 음수. */
function regimeLog() {
  return {
    available: true, startedOn: "2026-10-08", count: 1, recordHourKst: 18,
    entries: [{
      date: "2026-10-08", code: "LATE", label: "후퇴 경계 (Late cycle)", missing: [], ruleVersion: "regime-v1",
      inputs: {
        curve10y3m: { value: -0.12, asOf: "2026-10-08" },
        nfci: { value: -0.48, asOf: "2026-10-02" },
        hyOas: { value: 2.85, asOf: "2026-10-08" },
        liquidity4w: { value: -0.0254, asOf: "2026-10-08" },
      },
    }],
  };
}

/** 판정 성과 — 확장 국면 13주 뒤 평균·중앙값·기준 대비가 음수. */
function trackRecord() {
  const cell = { horizonWeeks: 13, count: 42, independent: 4, sufficient: true, mean: -1.2, median: -0.8, winRate: 40,
    best: 5, worst: -9, excessMean: -1.7 };
  const base = { horizonWeeks: 13, count: 140, independent: 11, sufficient: true, mean: -0.4, median: 0.2, winRate: 55, best: 12, worst: -9 };
  return {
    available: true, asset: "SPY", assetLabel: "S&P 500 (SPY)", assets: [{ ticker: "SPY", label: "S&P 500 (SPY)" }],
    horizons: [13], limits: ["과거 재현입니다."], evaluatedFrom: "2023-09-07", evaluatedTo: "2026-08-13", knownWeeks: 154,
    priceFrom: "2021-01-04", priceTo: "2026-11-14", minSamples: 10, minIndependent: 3, rule: "매주 목요일 판정.",
    start: [{ code: "EXPANSION", label: "확장 (Expansion)", weeks: 6, episodes: 6, cells: [cell] }],
    all: [{ code: "EXPANSION", label: "확장 (Expansion)", weeks: 60, episodes: 6, cells: [cell] }],
    baseline: [base],
  };
}

/** 국면 응답 + 주간 재현 넷과 구간 셋(최근 순). */
function withHistory(): RegimeResponse {
  return {
    ...regimeExpansion(),
    timeline: [
      { date: "2026-10-22", code: "UNKNOWN", label: "판정 불가" },
      { date: "2026-10-29", code: "LATE", label: "후퇴 경계 (Late cycle)" },
      { date: "2026-11-05", code: "EXPANSION", label: "확장 (Expansion)" },
      { date: "2026-11-12", code: "EXPANSION", label: "확장 (Expansion)" },
    ],
    episodes: [
      { code: "EXPANSION", label: "확장 (Expansion)", start: "2026-11-05", end: "2026-11-12", weeks: 2 },
      { code: "LATE", label: "후퇴 경계 (Late cycle)", start: "2026-10-29", end: "2026-10-29", weeks: 1 },
      { code: "UNKNOWN", label: "판정 불가", start: "2026-10-22", end: "2026-10-22", weeks: 1 },
    ],
  };
}

describe("QA-635 국면 이력 띠·범례 견본이 고대비에서 남는다", () => {
  // 수정 전에는 띠의 칸과 범례 견본을 바탕색(bg-ok/70 등)으로만 그려, 고대비(forced-colors)에서 바탕색이 지워지면 띠와 견본이 통째로 사라졌습니다
  // (D1 QA '바탕색만으로 그린 모양'의 국면 몫). 띠는 이름 없는 칸 259개라 낭독기에는 아무 뜻도 전하지 못했습니다.
  it("띠는 이름 있는 그림(기간·구간 수)이고 칸은 읽기에서 빠지며, 띠와 범례 견본은 고대비에서도 색 그대로", async () => {
    reads[REGIME] = withHistory();
    render(<RegimePage />);
    await openTab("국면 이력");

    const band = await screen.findByRole("img", { name: /국면 이력 띠/ });
    expect(band.getAttribute("aria-label")).toBe("국면 이력 띠 — 2026-10-22 ~ 2026-11-12, 주간 판정 4번·구간 3개(최근 구간은 아래 표)");
    expect(band.className).toContain("forced-color-adjust-none");
    const cells = Array.from(band.children);
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.getAttribute("aria-hidden") === "true")).toBe(true);

    const legend = screen.getByRole("list", { name: "국면 이력 띠 범례" });
    const swatches = Array.from(legend.querySelectorAll("[data-band-swatch]"));
    // 네 국면 + 판정 불가.
    expect(swatches).toHaveLength(5);
    for (const swatch of swatches) {
      expect(swatch.getAttribute("aria-hidden")).toBe("true");
      expect(swatch.className).toContain("forced-color-adjust-none");
    }
    expect(within(legend).getByText("판정 불가")).toBeTruthy();
  });
});

describe("QA-636 국면 화면의 음수는 −(U+2212)", () => {
  // 수정 전에는 판정 근거 값(formatNumber)·판정 기록 근거(regimeInputCells — formatSigned·formatTrillionDelta)·판정 성과 수익률(formatPercent)이
  // 하이픈(-)으로 음수를 적어, 같은 국면 신호를 −로 적는 홈 국면 패널(QA-600)·변화 칩과 글자가 달랐습니다(명세 D4).
  it("판정 근거: NFCI 음수가 −로", async () => {
    reads[REGIME] = regimeExpansion();
    render(<RegimePage />);
    const panel = await panelTitled("판정 근거");
    await within(panel).findByText("시카고 연준 금융상황지수");
    expect(panel.textContent).not.toMatch(ASCII_NEGATIVE);
    expect(panel.textContent).toContain("−0.");
  });

  it("판정 기록: 근거 넷의 음수가 −로", async () => {
    reads[REGIME_LOG] = regimeLog();
    render(<RegimePage />);
    const panel = await panelTitled("판정 기록");
    await within(panel).findAllByText(/0\.48/);
    expect(panel.textContent).not.toMatch(ASCII_NEGATIVE);
    expect(panel.textContent).toContain("−0.48");
    expect(panel.textContent).toContain("−254.0억 달러");
  });

  it("판정 성과: 평균·중앙값·기준 대비·아무 때나의 음수가 −로", async () => {
    reads[TRACK_SPY] = trackRecord();
    render(<RegimePage />);
    await openTab("판정 성과");
    const panel = await panelTitled("판정 성과");
    await within(panel).findAllByText(/1\.20%/);
    expect(panel.textContent).not.toMatch(ASCII_NEGATIVE);
    for (const text of ["−1.20%", "−0.80%", "−1.70%p", "−0.40%"]) expect(panel.textContent).toContain(text);
  });
});

/** 판정 기록 두 건 — 최근이 판정 불가(하이일드를 받지 못함). */
function regimeLogTwo() {
  const log = regimeLog();
  return {
    ...log, count: 2,
    entries: [
      {
        date: "2026-10-09", code: "UNKNOWN", label: "판정 불가", missing: ["하이일드 스프레드"], ruleVersion: "regime-v1",
        inputs: { ...log.entries[0].inputs, hyOas: { value: null, asOf: null } },
      },
      ...log.entries,
    ],
  };
}

describe("판정 기록 — 타임라인", () => {
  it("줄마다 날짜·국면 태그(아이콘 + 글)·근거 한 줄(마디 안 줄바꿈 없음), 판정 불가 날은 사유 수 — 넓은 화면은 처음에 가장 최근 줄의 검사 칸", async () => {
    stubWide();
    reads[REGIME_LOG] = regimeLogTwo();
    render(<RegimePage />);
    const list = await screen.findByRole("list", { name: "판정 기록" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(2);

    // 가장 최근(판정 불가) — 날짜 <time>, 중립 태그(점선 원), 요약 끝에 받지 못한 입력 수.
    expect(rows[0].querySelector("time")?.getAttribute("dateTime")).toBe("2026-10-09");
    expect(within(rows[0]).getByText("판정 불가")).toBeTruthy();
    expect(rows[0].textContent).toContain("하이일드 — · 순유동성 4주 −254.0억 달러 · 판정 불가 사유 1");
    // 마디(이름 값)는 줄을 바꾸지 않고, 가운뎃점은 앞 마디 끝에 붙습니다(다음 줄이 '·'로 시작하지 않음).
    expect(within(rows[0]).getByText("하이일드 — ·").className).toContain("whitespace-nowrap");
    expect(within(rows[0]).getByText("판정 불가 사유 1").className).toContain("whitespace-nowrap");
    // 후퇴 경계 — 주의 태그(삼각 아이콘 + '주의:').
    expect(within(rows[1]).getByText("주의:")).toBeTruthy();
    expect(rows[1].textContent).toContain("10Y-3M −0.12%p · NFCI −0.48 · 하이일드 2.85%p");
    for (const row of rows) expect(row.querySelectorAll("svg")).toHaveLength(1);

    // 넓은 화면은 처음에 가장 최근 줄을 검사 칸에(고르기 콜백 없이).
    const inspector = screen.getByRole("region", { name: "판정 기록 — 2026-10-09 판정 — 판정 불가" });
    expect(within(inspector).getByRole("heading", { name: "2026-10-09 판정 — 판정 불가" })).toBeTruthy();
    expect(within(inspector).getByText("하이일드 스프레드").tagName).toBe("LI");
    expect(within(inspector).getByText("regime-v1").className).toContain("font-mono");

    // 다른 줄을 고르면 그 줄의 근거 넷 값·기준일.
    fireEvent.click(rows[1]);
    const next = screen.getByRole("region", { name: "판정 기록 — 2026-10-08 판정 — 후퇴 경계 (Late cycle)" });
    expect(within(next).getByText("−0.48")).toBeTruthy();
    expect(within(next).getByText("기준일 2026-10-02")).toBeTruthy();
    expect(within(next).getByText("없음")).toBeTruthy();
  });

  it("좁은 화면에서는 줄을 누르면 대화상자로 검사 내용을 연다", async () => {
    reads[REGIME_LOG] = regimeLogTwo();
    render(<RegimePage />);
    const list = await screen.findByRole("list", { name: "판정 기록" });
    expect(screen.queryByRole("region", { name: /^판정 기록 — / })).toBeNull();

    fireEvent.click(within(list).getAllByRole("button")[1]);
    const dialog = await screen.findByRole("dialog", { name: "2026-10-08 판정 — 후퇴 경계 (Late cycle)" });
    expect(within(dialog).getByText("기준일 2026-10-02")).toBeTruthy();
    expect(within(dialog).getByText("regime-v1")).toBeTruthy();
  });

  it("읽는 중은 자리표시, 기록이 없으면 첫 기록 시각 안내, 무료 등급 잘림 글은 목록 아래", async () => {
    const { unmount } = render(<RegimePage />);
    expect(await screen.findByRole("status", { name: "판정 기록을 읽는 중" })).toBeTruthy();
    unmount();

    reads[REGIME_LOG] = { available: true, count: 0, recordHourKst: 18, limitedTo: 30, entries: [] };
    render(<RegimePage />);
    expect(await screen.findByText("아직 기록이 없습니다. 첫 기록은 KST 18시 이후에 생깁니다.")).toBeTruthy();
    expect(screen.getByText("무료 등급은 최근 30건만 보입니다. 유료 등급은 기록 전체를 봅니다.")).toBeTruthy();
  });
});

describe("판정 성과 — 국면별 공용 표", () => {
  it("국면마다 h3 국면 태그(아이콘 + 글)와 캡션 있는 공용 표, 상자 안쪽 12px(lg 16px)", async () => {
    reads[TRACK_SPY] = trackRecord();
    render(<RegimePage />);
    await openTab("판정 성과");
    const panel = await panelTitled("판정 성과");
    const heading = await within(panel).findByRole("heading", { level: 3, name: "확장 (Expansion)" });
    expect(heading.querySelectorAll("svg")).toHaveLength(1);
    const box = heading.parentElement as HTMLElement;
    expect(box.className).toContain("p-3");
    expect(box.className).toContain("lg:p-4");

    const table = within(box).getByRole("table", { name: "확장 (Expansion) — 판정 뒤 수익률" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "기간", "표본", "평균", "중앙값", "상승 비율", "기준 대비(평균)", "비교: 아무 때나",
    ]);
    // 기간은 행 머리(QA-673), 나머지 여섯이 칸.
    expect(within(table).getByRole("rowheader").textContent).toBe("13주 뒤");
    const cells = within(table).getAllByRole("cell").map((cell) => cell.textContent);
    expect(cells).toEqual(["42건 · 독립 4", "−1.20%", "−0.80%", "40%", "−1.70%p", "−0.40% · 55% 상승"]);
  });

  it("표본이 부족하면 숫자 대신 '표본 부족'(보조 글)과 —, 관점을 바꾸면 그 관점의 국면", async () => {
    const body = trackRecord();
    const thin = { ...body.start[0].cells[0], count: 4, independent: 2, sufficient: false, mean: null, median: null, winRate: null, excessMean: null };
    reads[TRACK_SPY] = { ...body, start: [{ ...body.start[0], cells: [thin] }] };
    render(<RegimePage />);
    await openTab("판정 성과");
    const panel = await panelTitled("판정 성과");
    const table = await within(panel).findByRole("table", { name: "확장 (Expansion) — 판정 뒤 수익률" });
    const mean = within(table).getByText("표본 부족");
    expect(mean.className).toContain("text-text-3");
    expect(within(table).getAllByText("—").length).toBeGreaterThanOrEqual(3);

    fireEvent.change(within(panel).getByLabelText("관점"), { target: { value: "all" } });
    expect(within(panel).getByText("60주 · 6개 구간")).toBeTruthy();
  });
});

describe("판정 대상 — 대상 머리", () => {
  it("h1 '시장 국면'·종류 '국면 판정'(저울 아이콘 칸)·주 값 지금 판정·식별자 코드·판정 문장·출처와 기준일·축 태그·신선도와 이력 기간", async () => {
    reads[REGIME] = regimeExpansion();
    render(<RegimePage />);
    const header = (await screen.findByRole("heading", { level: 1, name: "시장 국면" })).closest("header") as HTMLElement;
    await within(header).findByText("확장 (Expansion)");

    expect(within(header).getByText("국면 판정")).toBeTruthy();
    expect(within(header).getByText("지금 판정")).toBeTruthy();
    expect(within(header).getByText("확장 (Expansion)").className).toContain("text-value-lg");
    expect(within(header).getByText("EXPANSION").className).toContain("font-mono");
    expect(within(header).getByText(/위험자산에 우호적인 조합입니다/)).toBeTruthy();
    // 출처 배지 글(날짜 마디는 줄바꿈 없는 묶음 — keepDates라 글이 마디로 나뉨).
    const provenance = Array.from(header.querySelectorAll("span")).find((span) => span.querySelector(".sr-only")?.textContent === "출처: ");
    expect(provenance?.textContent).toMatch(/^출처: FRED \(공식\) — 10Y−3M 금리차.* · 2026-10-16$/);
    expect(provenance?.querySelector(".whitespace-nowrap")?.textContent).toBe("2026-10-16");
    expect(within(header).getByText("성장·신용 양호")).toBeTruthy();
    expect(within(header).getByText("유동성 확대")).toBeTruthy();
    expect((within(header).getByLabelText("이력 기간") as HTMLSelectElement).value).toBe("5");
    // 판정이 났으면 판정 불가 안내 상자가 없습니다.
    expect(within(header).queryByText("판정 불가")).toBeNull();
    expect(screen.queryByText(/를 받지 못했습니다/)).toBeNull();
  });

  it("읽는 중에는 값 자리만 자리표시이고 이름·이력 기간 고르기는 그대로(QA-047), 실패하면 머리에 오류 상자와 다시 시도", async () => {
    const { unmount } = render(<RegimePage />);
    const header = screen.getByRole("heading", { level: 1, name: "시장 국면" }).closest("header") as HTMLElement;
    expect(within(header).getByRole("status", { name: "국면을 판정하는 중" })).toBeTruthy();
    expect(within(header).getByLabelText("이력 기간")).toBeTruthy();
    unmount();

    api.apiGetShared.mockImplementation((path: string) =>
      path === REGIME ? Promise.reject(new Error("요청 실패 (HTTP 502)")) : new Promise(() => {}));
    render(<RegimePage />);
    const failed = screen.getByRole("heading", { level: 1, name: "시장 국면" }).closest("header") as HTMLElement;
    expect(await within(failed).findByText(/HTTP 502/)).toBeTruthy();
    expect(within(failed).getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });

  it("판정 불가면 주의 안내 상자에 받지 못한 입력, 근거의 빠진 신호는 0이 아니라 —와 '받지 못함'", async () => {
    reads[REGIME] = regimeUnknown();
    render(<RegimePage />);
    const callout = (await screen.findByText("하이일드 스프레드 (HY OAS)를 받지 못했습니다.")).closest("div.flex") as HTMLElement;
    expect(within(callout).getByText("판정 불가")).toBeTruthy();
    expect(within(callout).getByText("주의:")).toBeTruthy();

    const panel = await panelTitled("판정 근거");
    const term = within(panel).getByText("하이일드 스프레드", { selector: "dt" });
    const value = term.nextElementSibling as HTMLElement;
    expect(value.textContent).toContain("—");
    expect(value.textContent).toContain("받지 못함");
    expect(value.textContent).not.toMatch(/0\.00/);
  });
});

describe("판정 대상 — 근거 넷·네 국면·탭·연결·출처", () => {
  it("판정 근거 — 신호 넷의 값(음수 −·단위)·상태와 해석, 기준일 뜻과 고지", async () => {
    reads[REGIME] = regimeExpansion();
    render(<RegimePage />);
    const panel = await panelTitled("판정 근거");
    await within(panel).findByText("시카고 연준 금융상황지수");
    const terms = within(panel).getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["장단기 금리차 10Y-3M", "시카고 연준 금융상황지수", "하이일드 스프레드", "연준 순유동성 4주 변화"]);
    const value = (label: string) => (within(panel).getByText(label, { selector: "dt" }).nextElementSibling as HTMLElement).textContent;
    expect(value("장단기 금리차 10Y-3M")).toContain("+0.78%p");
    expect(value("시카고 연준 금융상황지수")).toContain("−0.496완화적");
    expect(value("연준 순유동성 4주 변화")).toContain("+0.031조 달러");
    expect(within(panel).getByText(/기준일/).textContent).toBe("기준일 2026-10-16 — 네 입력 계열의 마지막 날짜 중 가장 이른 날");
    expect(within(panel).getByText("임계치는 역사적 분포에 근거한 참고치이며 투자 판단의 근거가 아닙니다.")).toBeTruthy();
  });

  it("네 국면 — 국면마다 태그(아이콘 + 글)와 축 설명, 지금 칸은 aria-current·'지금'·잉크 테두리", async () => {
    reads[REGIME] = { ...regimeExpansion(), verdict: { ...regimeExpansion().verdict!, code: "CONTRACTION", label: "침체 경계 (Contraction)" } };
    render(<RegimePage />);
    const list = await screen.findByRole("list", { name: "네 국면" });
    await within(list).findByText("지금");
    const items = within(list).getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.replace("주의: ", ""))).toEqual([
      "확장성장·신용 양호 + 유동성 확대",
      "후퇴 경계성장·신용 양호 + 유동성 축소",
      "회복성장·신용 악화 + 유동성 확대",
      "침체 경계지금성장·신용 악화 + 유동성 축소",
    ]);
    for (const item of items) expect(item.querySelectorAll("svg")).toHaveLength(1);
    // 주의·위험 국면은 낭독기에 '주의:'(후퇴 경계·침체 경계), 확장·회복은 없음.
    expect(items.map((item) => within(item).queryByText("주의:") !== null)).toEqual([false, true, false, true]);
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([null, null, null, "true"]);
    expect(items[3].className).toContain("border-text");
    expect(items[0].className).not.toContain("border-text");
  });

  it("탭 셋(판정 기록·국면 이력·판정 성과)은 모두 마운트 — 고르지 않은 탭은 hidden, 처음은 판정 기록", async () => {
    reads[REGIME] = withHistory();
    render(<RegimePage />);
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute("aria-selected")])).toEqual([
      ["판정 기록", "true"], ["국면 이력", "false"], ["판정 성과", "false"],
    ]);
    const panel = screen.getByRole("tabpanel", { name: "판정 기록" });
    const blocks = Array.from(panel.children) as HTMLElement[];
    expect(blocks.map((block) => block.hidden)).toEqual([false, true, true]);
    // 숨은 탭의 내용도 마운트돼 있습니다(이름 있는 글로 찾음).
    expect(within(blocks[1]).getByText("과거 구간 (최근 순)", { selector: "h3" })).toBeTruthy();
    expect(within(blocks[2]).getByLabelText("관점")).toBeTruthy();

    await openTab("국면 이력");
    expect(screen.getByRole("tabpanel", { name: "국면 이력" })).toBeTruthy();
    expect(blocks.map((block) => block.hidden)).toEqual([true, false, true]);
    const table = screen.getByRole("table", { name: "과거 구간 (최근 순)" });
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    // 국면은 행 머리(QA-673) — 칸은 시작·끝·기간.
    expect(within(table).getAllByRole("cell")[2].textContent).toBe("2주");
  });

  it("연결 — 쓰인 지표가 있는 매크로 화면(링크 글이 절 — 심화·신용 변동성, QA-641)과 순유동성 화면, 출처 셋", async () => {
    reads[REGIME] = regimeExpansion();
    render(<RegimePage />);
    const links = (await panelTitled("연결")).querySelectorAll("a");
    expect(Array.from(links).map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["장단기 금리차 10Y-3M · NFCI — 매크로 지표의 심화 지표 절", "/macro"],
      ["하이일드 스프레드 — 매크로 지표의 신용·변동성 절", "/macro"],
      ["연준 순유동성 4주 변화 — 순유동성 화면", "/liquidity"],
    ]);
    const sources = await panelTitled("출처");
    expect(within(sources).getAllByRole("term").map((term) => term.textContent)).toEqual(["판정·근거", "판정 기록", "판정 성과"]);
  });

  it("칸 차례 — 대상 머리 → 판정 근거 → 네 국면·탭 → 연결·출처", async () => {
    reads[REGIME] = regimeExpansion();
    render(<RegimePage />);
    await screen.findByRole("list", { name: "네 국면" });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["판정 근거", "네 국면", "판정 기록", "연결", "출처"]);
  });
});

// QA-641: 국면 '연결'의 매크로 링크 둘이 절 조각(/macro#macro-advanced·#macro-risk)으로 갔는데, 매크로 화면은 자료가 온 뒤 위 절들이 자라 해시 스크롤이
// 그 절에 머물지 않았습니다(통합 빌드 + QA API — 화면 안 이동 뒤 절 위 끝: 1024 심화 463px·위험 1,854px, 390 심화 3,433px·위험 2,138px, 지금 칸은 앞 절.
// 1440은 맞음). 주소를 바로 열거나 새로 고치면 셸이 그린 뒤에 닻이 생겨 어느 폭에서도 스크롤하지 않았습니다(위험 절 위 끝 4,940~6,333px).
// 계획의 대안대로 매크로 화면 맨 위(/macro)로 잇고, 어느 절인지는 링크 글이 말합니다(그 화면의 목차로 이동).
describe("QA-641 국면 연결의 매크로 링크는 해시 없이 매크로 화면으로", () => {
  // 고치기 전 값(it.fails로 둔 커밋): expected [ '/macro#macro-advanced', '/macro#macro-risk' ] to deeply equal [ '/macro', '/macro' ]
  it("매크로로 가는 연결 링크에 절 조각(#)이 없다 — 주소는 메뉴 표의 매크로 지표 경로", async () => {
    reads[REGIME] = regimeExpansion();
    render(<RegimePage />);
    const links = Array.from((await panelTitled("연결")).querySelectorAll("a"));
    const macro = links.map((link) => link.getAttribute("href") ?? "").filter((href) => href.startsWith("/macro"));
    expect(macro).toEqual(["/macro", "/macro"]);
  });
});

// QA-647: 응답에 값이 없을 때 숫자를 지어냈습니다(개편 전부터 — P5a가 옮기며 그대로 둠). 판정 기록 건수를 모르면 '0건', 기록 시각을 모르면 'KST 18시',
// 판정 성과의 판정 주 수를 모르면 '0주 판정'으로 적었습니다 — '없는 숫자를 만들지 않는다'(null → '—') 규칙과 어긋남(P5a 검토). 같은 줄의 시작일은 이미 '—'.
describe("QA-647 판정 기록·성과 부제는 모르는 수를 지어내지 않는다", () => {
  it("건수·기록 시각·판정 주 수가 응답에 없으면 '0건'·'18시'·'0주'가 아니라 '—'(시각은 그 마디를 뺌)", async () => {
    reads[REGIME] = regimeExpansion();
    const { count: _count, recordHourKst: _hour, ...log } = regimeLog();
    reads[REGIME_LOG] = { ...log, entries: [] };
    const { knownWeeks: _weeks, ...track } = trackRecord();
    reads[TRACK_SPY] = track;
    render(<RegimePage />);

    const logPanel = await panelTitled("판정 기록");
    await within(logPanel).findByText(/부터/);
    const logText = logPanel.textContent ?? "";
    expect(logText).not.toMatch(/0건|18시/);
    expect(logText).toContain("2026-10-08부터 —건");

    await openTab("판정 성과");
    const trackPanel = await panelTitled("판정 성과");
    await within(trackPanel).findAllByText(/매주 목요일/);
    expect(trackPanel.textContent ?? "").not.toMatch(/0주 판정/);
    expect(trackPanel.textContent ?? "").toContain("매주 목요일 —주 판정");
  });
});

// QA-650: 대상 머리의 읽는 중 자리표시가 값이 온 뒤의 머리보다 낮아(P5a 검토 반영 `23de9e99`의 최소 높이 160·136·76px — 설명 글·주 값 줄·배지 줄 합보다 작음),
// 값이 오면 아래 칸 틀 전체가 밀렸습니다. 자기 빌드(메뉴 220, QA API GET — 응답 2.5초 지연)에서 머리 높이 390 268 → 306px·1024 168 → 174px·1280 이상
// 108 → 116px. 1024에서는 그 6px 이동이 '연결' 패널이 화면 밖으로 밀리는 것과 같은 프레임에 걸려 첫 적재 CLS가 0.4718(8번 중 6~7번 — 기준 `a5cdae2f`
// 0.3525)이었습니다. 자리표시는 값이 온 뒤의 머리(설명 글·주 값 줄·배지 줄 — 이름 줄은 그대로)와 같은 높이를 폭마다 잡아야 합니다.
// 수정 전(재현 커밋에서는 it.fails)에는 [160, 160, 160, 136, 76]이었습니다.
// 기대 높이는 자기 빌드에서 판정 다섯 글(백엔드 Regime.java의 고정 글)로 잰 값이 온 뒤의 부분 높이(설명 + 4 + 주 값 줄 36 + 4 + 배지 줄)이고,
// 글마다 다르면 다섯 글 가운데 셋 이상이 갖는 높이입니다: 390(기본) 60+36+74 · 640(sm) 40+36+58 · 768(md) 20+36+42 · 1024(lg) 40+36+58 · 1280 이상(xl) 20+36+20.
// 값이 오면 자라는 글은 뺐습니다 — 390 후퇴·침체 경계와 768 후퇴 경계·회복 +20px, 1280~1439 판정 불가 +26px(배지 줄이 두 줄).
// jsdom은 배치를 계산하지 않으므로 자리표시의 높이 클래스(h-*·min-h-*, 폭 앞머리)로 폭마다 잡는 높이를 셉니다.
describe("QA-650 대상 머리의 읽는 중 자리표시는 값이 온 뒤의 머리와 같은 높이", () => {
  const STEPS = ["", "sm:", "md:", "lg:", "xl:"] as const;
  /** 클래스의 높이 값(px) — 'h-15' 60, 'h-[74px]' 74, 'min-h-40' 160. 폭 앞머리가 그 폭 이하인 것 가운데 가장 큰 앞머리의 값. */
  function heightAt(element: Element, step: number, kind: "h" | "min-h"): number | null {
    const tokens = (element.getAttribute("class") ?? "").split(/\s+/);
    let found: number | null = null;
    STEPS.slice(0, step + 1).forEach((prefix) => {
      for (const token of tokens) {
        const match = token.startsWith(prefix) ? new RegExp(`^${kind}-(?:(\\d+(?:\\.\\d+)?)|\\[(\\d+)px\\])$`).exec(token.slice(prefix.length)) : null;
        if (match) found = match[1] !== undefined ? Number(match[1]) * 4 : Number(match[2]);
      }
    });
    return found;
  }
  /** 자리표시가 그 폭에서 잡는 높이 — 자기 최소 높이와, 높이가 정해진 자식들의 합(+ gap) 가운데 큰 쪽. */
  function reserved(root: Element, step: number): number {
    const gapToken = (root.getAttribute("class") ?? "").split(/\s+/).find((token) => /^gap-\d+$/.test(token));
    const gap = gapToken ? Number(gapToken.slice(4)) * 4 : 0;
    const parts = Array.from(root.children).map((child) => heightAt(child, step, "h")).filter((value): value is number => value !== null);
    const sum = parts.length > 0 ? parts.reduce((total, value) => total + value, 0) + gap * (parts.length - 1) : 0;
    return Math.max(heightAt(root, step, "min-h") ?? 0, sum);
  }

  it("폭마다(기본·sm·md·lg·xl) 설명 글 + 주 값 줄 + 배지 줄 높이 178·142·106·142·84px를 잡는다", () => {
    render(<RegimePage />);
    const header = screen.getByRole("heading", { level: 1, name: "시장 국면" }).closest("header") as HTMLElement;
    const status = within(header).getByRole("status", { name: "국면을 판정하는 중" });
    // EntityHeader가 자리표시를 감싸는 칸(div.min-w-0)의 첫 자식이 자리표시입니다.
    let slot: HTMLElement = status;
    while (slot.parentElement && !(slot.parentElement.className === "min-w-0")) slot = slot.parentElement;
    expect(STEPS.map((_, step) => reserved(slot, step))).toEqual([178, 142, 106, 142, 84]);
  });
});

// QA-651: 판정 기록을 읽는 동안 목록 자리가 막대 네 줄(88px)뿐이라, 값이 오면 목록(QA 자료 13건 — 판정 기록 패널 233 → 1,173px)이 자라 lg(1024~1279 —
// 오른쪽 칸이 가운데 아래)의 '연결'·'출처' 패널을 밀었습니다. 자기 빌드(1024 x 900, 메뉴 220)에서 '연결' 위 끝 797 → 1,743px — 화면 안(아래 103px가
// 보임)에서 화면 밖으로, 이 이동 하나가 첫 적재 CLS 0.053(머리 이동과 같은 프레임이면 QA-650과 합쳐 0.4718). 판정 기록은 하루 한 건씩 쌓여 요청 한도
// (60건, 무료 30건)까지 차므로, 읽는 중에는 목록 꼴의 자리 줄 열 개(보이는 수가 아님)로 목록 높이를 잡아 '연결'이 처음부터 화면 아래에 있게 합니다.
describe("QA-651 판정 기록을 읽는 동안 목록 자리를 잡는다", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 자리 줄이 없었습니다(막대 네 줄 — 'expected to have a length of 10 but got +0').
  it("응답 전 판정 기록 패널은 목록 꼴 자리 줄 열 개(읽기에서 빠짐)와 읽는 중 상태", async () => {
    reads[REGIME] = regimeExpansion();
    render(<RegimePage />);
    const panel = await panelTitled("판정 기록");
    const status = within(panel).getByRole("status", { name: "판정 기록을 읽는 중" });
    expect(status.querySelectorAll("li")).toHaveLength(10);
    expect(status.querySelector("ul")?.getAttribute("aria-hidden")).toBe("true");
  });
});

// QA-655: 대상 머리의 자리표시(QA-650)와 판정 기록의 목록 꼴 자리(QA-651)를 '값 없이 읽는 중'이면 늘 그려, 첫 읽기가 실패한 뒤 다시 읽을 때마다(자동 갱신
// 5분·10분 · 다시 시도 · 탭 복귀) 오류 상자와 큰 자리표시가 번갈아 그려졌습니다(매크로 지표 패널과 같은 원인 — 검토 지적). 실패 뒤 다시 읽는 동안은 오류
// 상자와 비슷한 높이의 '…읽는 중' 한 줄이어야 합니다(값 꼴 자리는 처음 읽는 동안만).
describe("QA-655 첫 읽기가 실패한 뒤 다시 읽는 동안에는 값 꼴 자리를 다시 그리지 않는다", () => {
  /** path의 첫 읽기는 실패, 다시 읽기는 failAgain()을 부를 때까지 끝나지 않다가 실패. 나머지 경로는 reads 그대로. */
  function failFirst(path: string) {
    const state = { calls: 0, failAgain: () => {} };
    api.apiGetShared.mockImplementation((requested: string) => {
      if (requested !== path) return requested in reads ? Promise.resolve(reads[requested]) : new Promise(() => {});
      state.calls += 1;
      return state.calls === 1
        ? Promise.reject(new Error("백엔드 API 오류 (503)"))
        : new Promise((_, reject) => { state.failAgain = () => reject(new Error("백엔드 API 오류 (503)")); });
    });
    return state;
  }

  // 수정 전(재현 커밋에서는 it.fails)에는 다시 읽는 동안 머리 꼴 자리표시(status '국면을 판정하는 중')가 다시 그려졌습니다('expected <div role="status" …> to be null').
  it("대상 머리 — 실패 → 다시 읽는 중에 머리 꼴 자리표시 없이 '국면을 판정하는 중…' 한 줄, 다시 실패하면 오류 상자", async () => {
    const state = failFirst(REGIME);
    render(<RegimePage />);
    const header = screen.getByRole("heading", { level: 1, name: "시장 국면" }).closest("header") as HTMLElement;
    fireEvent.click(await within(header).findByRole("button", { name: "다시 시도" }));

    expect(state.calls).toBe(2);
    expect(within(header).queryByRole("status", { name: "국면을 판정하는 중" })).toBeNull();
    expect(within(header).getByText("국면을 판정하는 중…")).toBeTruthy();

    await act(async () => state.failAgain());
    expect(await within(header).findByRole("button", { name: "다시 시도" })).toBeTruthy();
  });

  // 수정 전(재현 커밋에서는 it.fails)에는 다시 읽는 동안 목록 꼴 자리 줄 열 개(status '판정 기록을 읽는 중')가 다시 그려졌습니다('expected <div role="status" …> to be null').
  it("판정 기록 — 실패 → 다시 읽는 중에 목록 꼴 자리 줄 없이 '판정 기록을 읽는 중…' 한 줄, 다시 실패하면 오류 상자", async () => {
    reads[REGIME] = regimeExpansion();
    const state = failFirst(REGIME_LOG);
    render(<RegimePage />);
    const panel = await panelTitled("판정 기록");
    fireEvent.click(await within(panel).findByRole("button", { name: "다시 시도" }));

    expect(state.calls).toBe(2);
    expect(within(panel).queryByRole("status", { name: "판정 기록을 읽는 중" })).toBeNull();
    expect(panel.querySelectorAll("li")).toHaveLength(0);
    expect(within(panel).getByText("판정 기록을 읽는 중…")).toBeTruthy();

    await act(async () => state.failAgain());
    expect(await within(panel).findByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});

// QA-673: 국면 이력의 '과거 구간 (최근 순)' 표와 판정 성과의 국면별 표는 첫 열에 행 머리가 없어, 낭독기가 칸을 옮길 때 국면 이름·기간이 행 이름으로
// 읽히지 않았습니다(QA 스택 390·1024·1440 — 접근성 트리 rowheader 0, 탭을 바꿔 잼). 개편 전 옛 표는 행 머리를 그릴 수 없었습니다.
describe("QA-673 과거 구간·판정 성과 표의 첫 열은 행 머리", () => {
  // 수정 전(재현 커밋에서는 it.fails)에는 행 머리가 없었습니다('Unable to find an accessible element with the role "rowheader"').
  it("판정 성과 표의 행 머리는 기간('13주 뒤'), 과거 구간 표는 줄마다 행 머리(국면)", async () => {
    reads[REGIME] = withHistory();
    reads[TRACK_SPY] = trackRecord();
    render(<RegimePage />);

    await openTab("판정 성과");
    const track = await screen.findByRole("table", { name: "확장 (Expansion) — 판정 뒤 수익률" });
    expect(within(track).getAllByRole("rowheader").map((cell) => cell.textContent)).toEqual(["13주 뒤"]);

    await openTab("국면 이력");
    const episodes = screen.getByRole("table", { name: "과거 구간 (최근 순)" });
    const bodyRows = within(episodes).getAllByRole("row").length - 1;
    expect(bodyRows).toBe(3);
    expect(within(episodes).getAllByRole("rowheader")).toHaveLength(bodyRows);
  });
});
