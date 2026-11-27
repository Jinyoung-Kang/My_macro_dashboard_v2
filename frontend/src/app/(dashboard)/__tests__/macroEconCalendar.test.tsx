/**
 * 매크로 화면의 경제 캘린더 카드(ADR 0026 결정 10).
 *
 * 경로(GET /api/macro/econ-calendar)는 운영자 전용입니다 — 차단 통과 수집으로 받은 비공식 자료라 회원·데모 방문자에게는 카드를
 * 그리지 않고 경로도 부르지 않습니다. 운영자에게는 출처·수집 시각·'우회 수집' 표기를 함께 보이고, 없는 값은 '—'로 둡니다
 * (0으로 그리지 않음). 저장본이 없으면 빈 표가 아니라 그 사실을 적습니다.
 *
 * 날짜 띠 + 그날 표(2026-11-18 사용자 결정): 중요도 보통·높음만 보이고 낮음·모름은 숨긴 건수 한 줄, 보일 일정이 있는 KST 날짜마다 탭 하나,
 * 그 아래 고른 날의 표 하나. 처음 고른 날은 오늘(KST)·오늘 뒤 첫 날·오늘 앞 마지막 날 차례.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { SessionUser } from "@/lib/types";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { EconCalendarSection } from "../macro/EconCalendarSection";
import MacroPage from "../macro/page";
import {
  type EconEvent,
  bypassBadge,
  econCalendarView,
  econDayChip,
  econDayCountText,
  econDayTitle,
  econEventDate,
  econEventTime,
  econHiddenText,
  econToday,
  importanceLabel,
  isShownImportance,
  pickEconDay,
  valueText,
} from "@/lib/econCalendar";
import { formatNumber } from "@/lib/format";

const OWNER: SessionUser = { email: "owner@test.local", role: "OWNER", tier: "PRO" };
const MEMBER: SessionUser = { email: "member@test.local", role: "MEMBER", tier: "PRO" };
const DEMO: SessionUser = { email: null, role: "MEMBER", tier: "PRO", demo: true };
const PATH = "/api/macro/econ-calendar";

const CALENDAR = {
  available: true,
  collectedAtKst: "2026-11-05 12:00 KST",
  ageSeconds: 3600,
  source: "TradingView 경제 캘린더",
  sourceUrl: "https://www.tradingview.com/economic-calendar/",
  fetchTier: "impersonate",
  window: { from: "2026-11-04T00:00:00.000Z", to: "2026-11-19T00:00:00.000Z" },
  events: [
    { id: "1", country: "US", title: "Initial Jobless Claims", at: "2026-11-05T13:30:00+00:00", atKst: "2026-11-05 22:30 KST",
      importance: 0, actual: 218, forecast: 220, previous: 219, unit: null, scale: "K", period: null },
    { id: "2", country: "US", title: "Inflation Rate YoY", at: "2026-11-12T13:30:00+00:00", atKst: "2026-11-12 22:30 KST",
      importance: 1, actual: null, forecast: 3, previous: 3.1, unit: "%", scale: null, period: "Oct" },
    { id: "3", country: "KR", title: "Interest Rate Decision", at: "2026-11-26T01:00:00+00:00", atKst: "2026-11-26 10:00 KST",
      importance: 1, actual: 0, forecast: null, previous: 2.5, unit: "%", scale: null, period: null },
    // 숨는 둘 — 중요도 낮음·모름(화면에 없고 숨긴 건수 한 줄에만).
    { id: "4", country: "US", title: "Redbook YoY", at: "2026-11-05T13:55:00+00:00", atKst: "2026-11-05 22:55 KST",
      importance: -1, actual: 5.9, forecast: null, previous: 6.1, unit: "%", scale: null, period: null },
    { id: "5", country: "KR", title: "Import Prices YoY", at: "2026-11-12T23:00:00+00:00", atKst: "2026-11-13 08:00 KST",
      importance: null, actual: null, forecast: null, previous: 1.2, unit: "%", scale: null, period: null },
  ],
};

function mockCalendar(response: unknown) {
  api.apiGetShared.mockImplementation((path: string) =>
    path === PATH ? Promise.resolve(response) : new Promise(() => {}));
}

/** 지금 시각을 고정합니다(Date만 — 타이머는 그대로라 findBy 기다리기가 돕니다). */
function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

beforeEach(() => {
  signal.token = 0;
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
  // 기본 '지금' — 2026-11-05 12:00 KST(첫 일정의 날).
  at("2026-11-05T03:00:00Z");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("경제 캘린더 카드는 운영자에게만", () => {
  it.each([
    ["일반 회원", MEMBER],
    ["데모 방문자", DEMO],
    ["사용자를 아직 모름", undefined],
  ])("%s: 카드가 없고 경로를 부르지 않는다", (_name, user) => {
    render(<SessionUserProvider user={user}><MacroPage /></SessionUserProvider>);

    expect(screen.queryByText("경제 캘린더")).toBeNull();
    expect(api.apiGetShared.mock.calls.some(([path]) => path === PATH)).toBe(false);
  });

  it("운영자: 카드가 있고 경로를 부른다", () => {
    render(<SessionUserProvider user={OWNER}><MacroPage /></SessionUserProvider>);

    // 패널 제목(h2) — 화면 목차에도 같은 이름의 칸(같은 화면 절 링크)이 있습니다.
    expect(screen.getByRole("heading", { level: 2, name: "경제 캘린더" })).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "경제 캘린더" }).every((link) => link.getAttribute("href") === "#macro-calendar")).toBe(true);
    expect(api.apiGetShared.mock.calls.some(([path]) => path === PATH)).toBe(true);
  });
});

describe("경제 캘린더 카드의 네 상태", () => {
  it("값 있음: 출처·수집 시각·우회 수집 표기와 일정 행", async () => {
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);

    const claims = (await screen.findByText("Initial Jobless Claims")).closest("tr")!;
    expect(within(claims).getByText("218K")).toBeTruthy();
    expect(within(claims).getByText("220K")).toBeTruthy();
    expect(within(claims).getByText("보통")).toBeTruthy();
    // 날짜는 날짜 띠·표 머리에 있어 칸은 시각(KST)만.
    expect(within(claims).getByText("22:30")).toBeTruthy();
    expect(screen.getByText("우회 수집 · 브라우저 TLS")).toBeTruthy();
    expect(screen.getByText("TradingView 경제 캘린더 (비공식)")).toBeTruthy();
    expect(screen.getByText(/2026-11-05 12:00/)).toBeTruthy();
  });

  it("없는 값은 '—'이고 0은 0으로 보인다", async () => {
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);

    fireEvent.click(await screen.findByRole("tab", { name: /^11\/12 \(목\)/ }));
    const cpi = screen.getByText("Inflation Rate YoY").closest("tr")!;
    expect(within(cpi).getAllByText("—")).toHaveLength(1);        // 실제치만 없음
    expect(within(cpi).getByText("3%")).toBeTruthy();
    expect(within(cpi).getByText("3.1%")).toBeTruthy();
    expect(within(cpi).getByText("높음")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: /^11\/26 \(목\)/ }));
    const rate = screen.getByText("Interest Rate Decision").closest("tr")!;
    expect(within(rate).getByText("0%")).toBeTruthy();             // 실제치 0은 값입니다
    expect(within(rate).getAllByText("—")).toHaveLength(1);       // 예상치 없음(중요도를 모르는 일정은 숨으므로 중요도 칸은 늘 글)
    expect(within(rate).getByText("한국")).toBeTruthy();
  });

  it("저장본 없음: 빈 표가 아니라 그 사실을 적는다", async () => {
    mockCalendar({ available: false, events: [] });
    render(<EconCalendarSection />);

    expect(await screen.findByText(/아직 받은 일정이 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/우회 수집/)).toBeNull();
  });

  it("읽기 실패: 오류 문구와 다시 시도", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path === PATH ? Promise.reject(new Error("운영자만 쓸 수 있는 기능입니다.")) : new Promise(() => {}));
    render(<EconCalendarSection />);

    expect(await screen.findByText("운영자만 쓸 수 있는 기능입니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});

describe("표시 규칙", () => {
  it("중요도는 -1·0·1만 글로 바꾸고 나머지는 '—'", () => {
    expect([-1, 0, 1, null, undefined, 5].map(importanceLabel)).toEqual(["낮음", "보통", "높음", "—", "—", "—"]);
  });

  it("값은 출처의 자릿수를 넘기지 않고 단위를 붙인다", () => {
    expect(valueText(218, { unit: null, scale: "K" }, formatNumber)).toBe("218K");
    expect(valueText(3.1, { unit: "%", scale: null }, formatNumber)).toBe("3.1%");
    expect(valueText(-0.25, { unit: "%", scale: null }, formatNumber)).toBe("−0.25%");
    expect(valueText(1.23456, {}, formatNumber)).toBe("1.23");
    expect(valueText(null, { unit: "%" }, formatNumber)).toBe("—");
    expect(valueText(0, { unit: "%" }, formatNumber)).toBe("0%");
    // 실제 응답의 단위·배수 조합(2026-11-06) — 통화 기호는 숫자 앞(음수는 부호 뒤), 글자 단위는 띄어서.
    expect(valueText(61.46, { unit: "$", scale: "B" }, formatNumber)).toBe("$61.46B");
    expect(valueText(-7.5, { unit: "$", scale: "B" }, formatNumber)).toBe("−$7.5B");
    expect(valueText(1.2, { unit: "KRW", scale: "T" }, formatNumber)).toBe("1.2T KRW");
    expect(valueText(33, { unit: "cf", scale: "B" }, formatNumber)).toBe("33B cf");
    expect(valueText(86, { unit: null, scale: "K" }, formatNumber)).toBe("86K");
  });

  // QA-648: 실제·예상·이전 값의 음수가 ASCII '-'였습니다(개편 전부터) — 같은 화면군의 다른 음수(금리차 QA-622·순유동성 QA-627·COT QA-629·국면 QA-636·
  // 상관계수)는 모두 −(U+2212)인데 이 표만 남았습니다(명세 D4·§3-1 '음수 부호는 −', P5a 검토). MoM·수지 지표는 음수가 흔합니다.
  it("QA-648 음수 값은 −(U+2212) — 통화 기호 앞 부호도", () => {
    expect(valueText(-0.25, { unit: "%", scale: null }, formatNumber)).toBe("−0.25%");
    expect(valueText(-7.5, { unit: "$", scale: "B" }, formatNumber)).toBe("−$7.5B");
    expect(valueText(-12, { unit: null, scale: "K" }, formatNumber)).toBe("−12K");
    expect(valueText(-1.2, { unit: "KRW", scale: "T" }, formatNumber)).toBe("−1.2T KRW");
  });

  it("우회 수집 표기는 통과한 계층을 알 때만", () => {
    expect(bypassBadge("impersonate")).toBe("우회 수집 · 브라우저 TLS");
    expect(bypassBadge("browser")).toBe("우회 수집 · 브라우저");
    expect([bypassBadge(null), bypassBadge(undefined), bypassBadge("other")]).toEqual([null, null, null]);
  });
});

/** 시험용 일정 — 이름·UTC 시각·중요도만 다르게. atKst는 주지 않으면 null(at을 KST로 바꿔 씀). */
function event(id: string, at: string, importance: number | null, over: Partial<EconEvent> = {}): EconEvent {
  return {
    id, country: "US", title: `지표 ${id}`, at, atKst: null, importance,
    actual: null, forecast: null, previous: null, unit: null, scale: null, period: null, ...over,
  };
}

describe("날짜 띠 + 그날 표 — 순수 규칙(lib/econCalendar)", () => {
  it("중요도 보통·높음만 보이고 낮음·모름(그 밖의 값 포함)은 숨긴다", () => {
    expect([1, 0, -1, null, undefined, 2].map(isShownImportance)).toEqual([true, true, false, false, false, false]);
    const view = econCalendarView([
      event("a", "2026-11-18T00:00:00Z", 1),
      event("b", "2026-11-18T01:00:00Z", 0),
      event("c", "2026-11-18T02:00:00Z", -1),
      event("d", "2026-11-18T03:00:00Z", -1),
      event("e", "2026-11-18T04:00:00Z", null),
      event("f", "2026-11-18T05:00:00Z", 2),
    ]);
    expect(view.days.map((day) => day.events.map((entry) => entry.id))).toEqual([["a", "b"]]);
    expect(view.hidden).toEqual({ low: 2, unknown: 2, undated: 0 });
  });

  it("숨긴 건수 한 줄 — 0건 마디는 빼고, 숨긴 것이 없으면 줄이 없다", () => {
    expect(econHiddenText({ low: 172, unknown: 3, undated: 0 })).toBe("중요도 낮음 172건·모름 3건은 숨겼습니다.");
    expect(econHiddenText({ low: 1180, unknown: 0, undated: 0 })).toBe("중요도 낮음 1,180건은 숨겼습니다.");
    expect(econHiddenText({ low: 0, unknown: 2, undated: 0 })).toBe("중요도 모름 2건은 숨겼습니다.");
    expect(econHiddenText({ low: 4, unknown: 0, undated: 1 })).toBe("중요도 낮음 4건과 발표 날짜를 모르는 일정 1건은 숨겼습니다.");
    expect(econHiddenText({ low: 0, unknown: 0, undated: 0 })).toBeNull();
  });

  it("날짜는 KST로 묶는다 — UTC 15:00이 KST 자정(그 전은 앞날, 그 뒤는 다음 날)", () => {
    expect(econEventDate({ at: "2026-11-17T14:59:00Z", atKst: null })).toBe("2026-11-17");
    expect(econEventDate({ at: "2026-11-17T15:00:00Z", atKst: null })).toBe("2026-11-18");
    expect(econEventTime({ at: "2026-11-17T14:59:00Z", atKst: null })).toBe("23:59");
    expect(econEventTime({ at: "2026-11-17T15:00:00Z", atKst: null })).toBe("00:00");
    // atKst가 있으면 그 날짜·시각(백엔드가 KST로 적은 글), 알아볼 수 없으면 at을 KST로.
    expect(econEventDate({ at: "2026-11-17T15:30:00Z", atKst: "2026-11-18 00:30 KST" })).toBe("2026-11-18");
    expect(econEventTime({ at: "2026-11-17T15:30:00Z", atKst: "2026-11-18 00:30 KST" })).toBe("00:30");
    expect(econEventDate({ at: "2026-11-17T15:30:00Z", atKst: "모름" })).toBe("2026-11-18");
    expect(econEventDate({ at: "", atKst: null })).toBeNull();
    expect(econEventTime({ at: "엉뚱", atKst: null })).toBeNull();

    const view = econCalendarView([
      event("late", "2026-11-17T15:00:00Z", 0),
      event("early", "2026-11-17T14:59:00Z", 1),
      event("next", "2026-11-17T23:30:00Z", 1),
      event("nodate", "엉뚱", 0),
    ]);
    expect(view.days.map((day) => [day.date, day.events.map((entry) => entry.id), day.high])).toEqual([
      ["2026-11-17", ["early"], 1],
      ["2026-11-18", ["late", "next"], 1],
    ]);
    expect(view.hidden).toEqual({ low: 0, unknown: 0, undated: 1 });
  });

  it("그날 안은 발표 시각 차례(받은 차례와 달라도) — 시각을 모르면 그날 끝", () => {
    const view = econCalendarView([
      event("b", "2026-11-18T05:00:00Z", 0, { atKst: "2026-11-18 14:00 KST" }),
      event("x", "", 0, { atKst: "2026-11-18" }),
      event("a", "2026-11-18T00:30:00Z", 0, { atKst: "2026-11-18 09:30 KST" }),
    ]);
    expect(view.days[0].events.map((entry) => entry.id)).toEqual(["a", "b", "x"]);
  });

  it("처음 고른 날 — 오늘에 일정이 있으면 오늘, 없으면 오늘 뒤 첫 날, 그것도 없으면 오늘 앞 마지막 날", () => {
    const dates = ["2026-11-16", "2026-11-18", "2026-11-20"];
    expect(pickEconDay(dates, "2026-11-18")).toBe("2026-11-18");
    expect(pickEconDay(dates, "2026-11-17")).toBe("2026-11-18");
    expect(pickEconDay(dates, "2026-11-21")).toBe("2026-11-20");
    expect(pickEconDay(dates, "2026-11-01")).toBe("2026-11-16");
    // 오늘을 아직 모르면(마운트 전) 첫 날, 날이 없으면 없음.
    expect(pickEconDay(dates, null)).toBe("2026-11-16");
    expect(pickEconDay([], "2026-11-18")).toBeNull();
  });

  it("오늘(KST)은 지금 시각에서 — UTC 15:00 전후로 날이 바뀐다", () => {
    expect(econToday(Date.parse("2026-11-17T14:59:59Z"))).toBe("2026-11-17");
    expect(econToday(Date.parse("2026-11-17T15:00:00Z"))).toBe("2026-11-18");
  });

  it("칩·표 머리 글 — '11/18 (수)'·'11월 18일 (수)', 건수와 높음 건수는 글로", () => {
    expect(econDayChip("2026-11-18")).toBe("11/18 (수)");
    expect(econDayChip("2026-12-06")).toBe("12/6 (일)");
    expect(econDayTitle("2026-11-18")).toBe("11월 18일 (수)");
    expect(econDayCountText({ events: [event("a", "", 0), event("b", "", 1)], high: 1 })).toBe("2건 · 높음 1");
    expect(econDayCountText({ events: [event("a", "", 0)], high: 0 })).toBe("1건");
  });
});

describe("날짜 띠 + 그날 표 — 화면", () => {
  it("보일 일정이 있는 날마다 탭 하나(건수·높음 건수 글), 오늘 탭이 골라져 있고 그날 표 하나", async () => {
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);

    const strip = await screen.findByRole("tablist", { name: "경제 캘린더 날짜" });
    // 11/13은 숨는 일정(중요도 모름)만 있는 날이라 탭이 없습니다.
    expect(within(strip).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "11/5 (목) 1건",
      "11/12 (목) 1건 · 높음 1",
      "11/26 (목) 1건 · 높음 1",
    ]);
    const todayTab = within(strip).getByRole("tab", { name: "11/5 (목) 1건" });
    expect(todayTab.getAttribute("aria-selected")).toBe("true");

    const panel = screen.getByRole("tabpanel", { name: "11/5 (목) 1건" });
    const table = within(panel).getByRole("table", { name: "경제 캘린더 일정 — 11월 5일 (목)" });
    expect(within(panel).getByText("11월 5일 (목) — 1건")).toBeTruthy();
    // 같은 날의 숨는 일정(Redbook — 낮음)은 표에 없음.
    expect(within(table).queryByText("Redbook YoY")).toBeNull();
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "시각(KST)", "나라", "지표", "중요도", "실제", "예상", "이전",
    ]);
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(screen.getByText("중요도 낮음 1건·모름 1건은 숨겼습니다.")).toBeTruthy();
    // 제목 옆 개수는 창 안의 보이는 건수(거른 뒤 — 받은 다섯 중 셋).
    expect(screen.getByRole("heading", { level: 2, name: "경제 캘린더" }).parentElement?.textContent).toBe("경제 캘린더3건");
  });

  it("키보드 — ←·→·Home·End는 포커스만 옮기고, 누르기(Enter·Space)로 고르면 그날 표로 바뀐다", async () => {
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);

    const first = await screen.findByRole("tab", { name: "11/5 (목) 1건" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const second = screen.getByRole("tab", { name: "11/12 (목) 1건 · 높음 1" });
    expect(document.activeElement).toBe(second);
    expect(second.getAttribute("aria-selected")).toBe("false");
    expect(screen.getByText("Initial Jobless Claims")).toBeTruthy();

    fireEvent.click(second); // 단추의 Enter·Space는 누르기(click)와 같음 — 공용 Tabs의 고르기
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByText("Initial Jobless Claims")).toBeNull();
    expect(screen.getByText("Inflation Rate YoY")).toBeTruthy();
    expect(screen.getByText("11월 12일 (목) — 1건")).toBeTruthy();

    fireEvent.keyDown(second, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "11/26 (목) 1건 · 높음 1" }));
    fireEvent.keyDown(document.activeElement as Element, { key: "Home" });
    expect(document.activeElement).toBe(first);
    // Tab 키로 들어오는 탭은 고른 탭 하나.
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
  });

  it("오늘에 일정이 없으면 오늘 뒤 첫 날, 창 끝을 지났으면 마지막 날을 처음 고른다", async () => {
    at("2026-11-08T03:00:00Z"); // 11-08 KST — 그날 일정 없음
    mockCalendar(CALENDAR);
    const { unmount } = render(<EconCalendarSection />);
    expect((await screen.findByRole("tab", { name: "11/12 (목) 1건 · 높음 1" })).getAttribute("aria-selected")).toBe("true");
    unmount();

    at("2026-11-30T03:00:00Z");
    render(<EconCalendarSection />);
    expect((await screen.findByRole("tab", { name: "11/26 (목) 1건 · 높음 1" })).getAttribute("aria-selected")).toBe("true");
  });

  it("빈 상태 — 일정이 없으면 그 사실, 모두 숨었으면 보통 이상이 없다는 말과 숨긴 건수(띠·표 없음)", async () => {
    mockCalendar({ ...CALENDAR, events: [] });
    const { unmount } = render(<EconCalendarSection />);
    expect(await screen.findByText("창 안에 일정이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByText(/숨겼습니다/)).toBeNull();
    unmount();

    mockCalendar({ ...CALENDAR, events: CALENDAR.events.filter((entry) => entry.importance === -1 || entry.importance === null) });
    render(<EconCalendarSection />);
    expect(await screen.findByText("창 안에 중요도 보통 이상인 일정이 없습니다.")).toBeTruthy();
    expect(screen.getByText("중요도 낮음 1건·모름 1건은 숨겼습니다.")).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
    // 출처·우회 수집 배지는 그대로.
    expect(screen.getByText("우회 수집 · 브라우저 TLS")).toBeTruthy();
  });

  // 2026-11-18 검토 지적: 고른 날을 지키는 조건(새 자료에 그날이 있는가)을 지워도 앞 시험이 모두 통과했습니다 — 그러면 지난날을 고른 채 두었다가 창이 하루
  // 밀린 새 자료가 오면 띠와 표가 통째로 사라지고 '보통 이상인 일정이 없습니다'가 떴습니다(다시 고를 탭도 없음).
  // QA-684(11-18 요청 QA 스택 확인): 사라진 날의 고름은 그리기 때 대신 고를 날만 셈하고 상태에 남아, 그날이 다음 읽기에 다시 오면 입력 없이 띠·표가 옛 날로
  // 돌아갔습니다(셋째 단계). 수정 전(재현 커밋에서는 it.fails) 셋째 단계에서 11/5 탭이 다시 골라졌습니다.
  it("고른 날은 새 자료에서도 지키고, 새 자료에서 사라지면 같은 규칙(오늘·오늘 뒤 첫 날)으로 다시 고르며, 사라졌던 날이 다시 와도 되살리지 않는다", async () => {
    at("2026-11-12T03:00:00Z"); // 11-12 KST — 일정이 있는 날
    mockCalendar(CALENDAR);
    const { rerender } = render(<EconCalendarSection />);
    expect((await screen.findByRole("tab", { name: "11/12 (목) 1건 · 높음 1" })).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "11/5 (목) 1건" }));
    expect(screen.getByText("Initial Jobless Claims")).toBeTruthy();
    const reads = () => api.apiGetShared.mock.calls.filter(([path]) => path === PATH).length;

    // 같은 날이 남은 새 자료(셸의 수동 새로고침 신호로 다시 읽음) — 고른 지난날 그대로.
    signal.token = 1;
    rerender(<EconCalendarSection />);
    await waitFor(() => expect(reads()).toBe(2));
    await act(async () => {});
    expect(screen.getByRole("tab", { name: "11/5 (목) 1건" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Initial Jobless Claims")).toBeTruthy();

    // 창이 밀려 11/5가 빠진 새 자료 — 오늘(11/12)을 다시 고르고, 띠·표가 남고 빈 상태 문구가 없음.
    mockCalendar({ ...CALENDAR, events: CALENDAR.events.filter((entry) => !entry.atKst.startsWith("2026-11-05")) });
    signal.token = 2;
    rerender(<EconCalendarSection />);
    await waitFor(() => expect(screen.queryByRole("tab", { name: /^11\/5 / })).toBeNull());
    expect(screen.getByRole("tab", { name: "11/12 (목) 1건 · 높음 1" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tablist", { name: "경제 캘린더 날짜" })).toBeTruthy();
    expect(within(screen.getByRole("tabpanel")).getByText("Inflation Rate YoY")).toBeTruthy();
    expect(screen.queryByText(/일정이 없습니다/)).toBeNull();

    // 사라졌던 11/5가 다음 읽기에 다시 옴(창이 되돌아간 수집본 등) — 입력이 없었으니 오늘(11/12) 그대로, 옛 고름(11/5)을 되살리지 않음.
    mockCalendar(CALENDAR);
    signal.token = 3;
    rerender(<EconCalendarSection />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "11/5 (목) 1건" })).toBeTruthy());
    expect(screen.getByRole("tab", { name: "11/5 (목) 1건" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "11/12 (목) 1건 · 높음 1" }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel")).getByText("Inflation Rate YoY")).toBeTruthy();
    expect(screen.queryByText("Initial Jobless Claims")).toBeNull();
  });

  // 2026-11-18 검토 지적: 이 카드는 매크로 화면의 마지막 절이라, 일정이 적은 날로 바꿔 문서가 짧아지면 맨 아래까지 내린 스크롤이 눌려 방금 누른 날짜 띠가
  // 포인터 밑에서 수백 px 아래로 튀었습니다. 날짜를 고르는 순간의 표 영역 높이를 하한으로 남깁니다(늘어나기만). jsdom은 높이를 재지 않아 그 값을 겁니다.
  it("짧은 날로 바꿔도 표 영역 높이의 하한이 남는다 — 고르는 순간의 높이, 늘어나기만", async () => {
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);
    const panel = await screen.findByRole("tabpanel");
    expect(panel.style.minHeight).toBe(""); // 첫 그리기에는 하한이 없음(첫 읽기 높이 그대로)
    const height = vi.spyOn(panel, "getBoundingClientRect");

    height.mockReturnValue({ height: 419.5 } as DOMRect);
    fireEvent.click(screen.getByRole("tab", { name: "11/12 (목) 1건 · 높음 1" }));
    expect(screen.getByRole("tabpanel")).toBe(panel);
    expect(panel.style.minHeight).toBe("420px");

    height.mockReturnValue({ height: 300 } as DOMRect);
    fireEvent.click(screen.getByRole("tab", { name: "11/26 (목) 1건 · 높음 1" }));
    expect(panel.style.minHeight).toBe("420px"); // 줄지 않음

    height.mockReturnValue({ height: 600 } as DOMRect);
    fireEvent.click(screen.getByRole("tab", { name: "11/5 (목) 1건" }));
    expect(panel.style.minHeight).toBe("600px");
    expect(within(panel).getByText("Initial Jobless Claims")).toBeTruthy();
  });

  it("행 높이가 바뀌는 폭 경계(lg)를 넘으면 잰 하한을 버린다", async () => {
    let wide = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal(
      "matchMedia",
      (query: string) =>
        ({
          get matches() {
            return query === "(min-width: 64rem)" && wide;
          },
          media: query,
          addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
          removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
        }) as unknown as MediaQueryList,
    );
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);
    const panel = await screen.findByRole("tabpanel");
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ height: 900 } as DOMRect);
    fireEvent.click(screen.getByRole("tab", { name: "11/12 (목) 1건 · 높음 1" }));
    expect(panel.style.minHeight).toBe("900px");

    act(() => {
      wide = true;
      listeners.forEach((listener) => listener());
    });
    expect(panel.style.minHeight).toBe("");
  });
});

// QA-683(11-18 요청 QA 스택 확인, qa@06f93335): '나라' 칸(한국·미국)에 줄 바꿈을 막는 클래스가 없어, 표가 조금만 눌려도 공용 표의 자동 배치가 이 열을
// 52px 아래로 줄여 '미/국'·'한/국'으로 음절이 꺾였습니다(칸 글 14px 두 자 28px보다 머리 '나라'(13px·nowrap 26px)가 좁은 탓). 조밀 표(dense)의 행이
// 1024에서 28 → 48px, 390에서 45 → 65px로 늘었습니다(머리 없는 크롬으로 잼). 공용 표는 오른쪽 정렬(숫자) 열만 nowrap이라 이 열은 부르는 쪽이 붙입니다.
// 수정 전(재현 커밋에서는 it.fails) 칸에 whitespace-nowrap이 없었습니다.
describe("QA-683 '나라' 칸은 음절에서 꺾이지 않는다", () => {
  it("'나라' 열의 머리와 칸 모두 whitespace-nowrap", async () => {
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);
    fireEvent.click(await screen.findByRole("tab", { name: /^11\/26 \(목\)/ }));
    const table = screen.getByRole("table");
    const heads = within(table).getAllByRole("columnheader");
    const country = heads.findIndex((head) => head.textContent === "나라");
    const cells = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.children[country] as HTMLElement);
    expect(cells.map((cell) => cell.textContent)).toEqual(["한국"]);
    for (const element of [heads[country], ...cells]) expect(element.className.split(/\s+/)).toContain("whitespace-nowrap");
  });
});

// QA-685(11-18 요청 QA 스택 확인): 포커스가 있던 날짜 탭이 다시 읽기에서 사라지면(창이 하루 밀림) 그 단추가 DOM에서 떨어져 포커스가 body로 갔습니다 —
// 포커스 링이 사라지고 낭독기는 자리를 잃었습니다(크롬의 다음 Tab은 그날 표, Shift+Tab은 고른 탭 — 사라진 자리 근처에서 이어짐). 공용 탭 줄이 다시 고른
// 날의 탭으로 포커스를 넘깁니다(components/ui Tabs).
// 수정 전(재현 커밋에서는 it.fails) 포커스가 body였습니다.
describe("QA-685 포커스가 있던 날짜 탭이 사라지면", () => {
  it("다시 고른 날(오늘)의 탭으로 포커스가 간다", async () => {
    at("2026-11-12T03:00:00Z");
    mockCalendar(CALENDAR);
    const { rerender } = render(<EconCalendarSection />);
    const past = await screen.findByRole("tab", { name: "11/5 (목) 1건" });
    past.focus();
    fireEvent.click(past);
    expect(document.activeElement).toBe(past);

    mockCalendar({ ...CALENDAR, events: CALENDAR.events.filter((entry) => !entry.atKst.startsWith("2026-11-05")) });
    signal.token = 1;
    rerender(<EconCalendarSection />);
    await waitFor(() => expect(screen.queryByRole("tab", { name: /^11\/5 / })).toBeNull());
    const today = screen.getByRole("tab", { name: "11/12 (목) 1건 · 높음 1" });
    expect(today.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(today);
  });
});
