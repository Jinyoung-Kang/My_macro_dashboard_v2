/**
 * 매크로 화면의 경제 캘린더 카드(ADR 0026 결정 10).
 *
 * 경로(GET /api/macro/econ-calendar)는 운영자 전용입니다 — 차단 통과 수집으로 받은 비공식 자료라 회원·데모 방문자에게는 카드를
 * 그리지 않고 경로도 부르지 않습니다. 운영자에게는 출처·수집 시각·'우회 수집' 표기를 함께 보이고, 없는 값은 '—'로 둡니다
 * (0으로 그리지 않음). 저장본이 없으면 빈 표가 아니라 그 사실을 적습니다.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
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
import { bypassBadge, importanceLabel, valueText } from "@/lib/econCalendar";
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
      importance: null, actual: 0, forecast: null, previous: 2.5, unit: "%", scale: null, period: null },
  ],
};

function mockCalendar(response: unknown) {
  api.apiGetShared.mockImplementation((path: string) =>
    path === PATH ? Promise.resolve(response) : new Promise(() => {}));
}

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation(() => new Promise(() => {}));
});
afterEach(() => cleanup());

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

    expect(screen.getByText("경제 캘린더")).toBeTruthy();
    expect(api.apiGetShared.mock.calls.some(([path]) => path === PATH)).toBe(true);
  });
});

describe("경제 캘린더 카드의 네 상태", () => {
  it("값 있음: 출처·수집 시각·우회 수집 표기와 일정 행", async () => {
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);

    const claims = (await screen.findByText("Initial Jobless Claims", {}, { timeout: 500 })).closest("tr")!;
    expect(within(claims).getByText("218K")).toBeTruthy();
    expect(within(claims).getByText("220K")).toBeTruthy();
    expect(within(claims).getByText("보통")).toBeTruthy();
    expect(within(claims).getByText("2026-11-05 22:30")).toBeTruthy();
    expect(screen.getByText("우회 수집 · 브라우저 TLS")).toBeTruthy();
    expect(screen.getByText("TradingView 경제 캘린더 (비공식)")).toBeTruthy();
    expect(screen.getByText(/2026-11-05 12:00/)).toBeTruthy();
  });

  it("없는 값은 '—'이고 0은 0으로 보인다", async () => {
    mockCalendar(CALENDAR);
    render(<EconCalendarSection />);

    const cpi = (await screen.findByText("Inflation Rate YoY", {}, { timeout: 500 })).closest("tr")!;
    expect(within(cpi).getAllByText("—")).toHaveLength(1);        // 실제치만 없음
    expect(within(cpi).getByText("3%")).toBeTruthy();
    expect(within(cpi).getByText("3.1%")).toBeTruthy();
    expect(within(cpi).getByText("높음")).toBeTruthy();

    const rate = screen.getByText("Interest Rate Decision").closest("tr")!;
    expect(within(rate).getByText("0%")).toBeTruthy();             // 실제치 0은 값입니다
    expect(within(rate).getAllByText("—")).toHaveLength(2);       // 중요도·예상치 없음
    expect(within(rate).getByText("한국")).toBeTruthy();
  });

  it("저장본 없음: 빈 표가 아니라 그 사실을 적는다", async () => {
    mockCalendar({ available: false, events: [] });
    render(<EconCalendarSection />);

    expect(await screen.findByText(/아직 받은 일정이 없습니다/, {}, { timeout: 500 })).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.queryByText(/우회 수집/)).toBeNull();
  });

  it("읽기 실패: 오류 문구와 다시 시도", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path === PATH ? Promise.reject(new Error("운영자만 쓸 수 있는 기능입니다.")) : new Promise(() => {}));
    render(<EconCalendarSection />);

    expect(await screen.findByText("운영자만 쓸 수 있는 기능입니다.", {}, { timeout: 500 })).toBeTruthy();
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
    expect(valueText(-0.25, { unit: "%", scale: null }, formatNumber)).toBe("-0.25%");
    expect(valueText(1.23456, {}, formatNumber)).toBe("1.23");
    expect(valueText(null, { unit: "%" }, formatNumber)).toBe("—");
    expect(valueText(0, { unit: "%" }, formatNumber)).toBe("0%");
  });

  it("우회 수집 표기는 통과한 계층을 알 때만", () => {
    expect(bypassBadge("impersonate")).toBe("우회 수집 · 브라우저 TLS");
    expect(bypassBadge("browser")).toBe("우회 수집 · 브라우저");
    expect([bypassBadge(null), bypassBadge(undefined), bypassBadge("other")]).toEqual([null, null, null]);
  });
});
