/**
 * 정보 수집 화면(/info/<탭>, ADR 0035·0036) — 탭마다 저장본·상태를 읽어 그리고, 긴 목록은 쪽을 나누며(10줄), 없는 값은 '—'(0이 아님),
 * 작동 방식은 수집기의 실제 값을 보인다. 표본은 모두 합성 응답입니다.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import InfoHub from "../InfoHub";

function source(index: number, over: Record<string, unknown> = {}) {
  return {
    task: `task_${index}`, key: `key_${index}`, label: `출처 ${index}`, tab: "global", kind: "data", siteUrl: null, origin: "합성",
    access: "official", screen: null, speed: "slow", lastStatus: "ok", lastRunAt: "2026-11-11 17:00:00 KST", lastDetail: null,
    politeStatus: null, streak: null, lastOkAt: null, nextDueAt: null, items: null, incident: null, tone: "ok", ...over,
  };
}

const CATALOG = {
  checkedAt: "2026-11-11 18:00:00 KST",
  collectorReachable: true,
  tabs: [
    { key: "news", label: "뉴스·글", sources: 1, tones: { ok: 1 } },
    { key: "global", label: "해외 시장·거시", sources: 11, tones: { ok: 10, danger: 1 } },
  ],
  sources: [
    source(0, { tab: "news", kind: "blog", key: "blog.wolfstreet", label: "Wolf Street", access: "bypass", speed: "polite" }),
    ...Array.from({ length: 10 }, (_, i) => source(i + 1)),
    source(11, {
      label: "끊긴 출처", tone: "danger", politeStatus: "blocked",
      incident: { key: "task_11", task: "task_11", label: "끊긴 출처", kind: "blocked", kindLabel: "차단됨 — 잠시 멈춤", reason: "403", since: null, streak: 1 },
    }),
  ],
  incidents: [],
};

const ITEM = {
  id: "0123456789abcdef01234567", source: "blog.wolfstreet", sourceLabel: "Wolf Street", kind: "article",
  url: "https://wolfstreet.com/2026/11/10/rates-spike/", title: "Rates Spike", titleKo: "금리 급등", author: "Wolf Richter",
  publishedAt: "2026-11-10 19:21:57 KST", firstSeenAt: "2026-11-11 01:00:00 KST", summary: "요약 글", bodyStatus: "full",
  fetchTier: "impersonate", category: null,
};

const KRX = {
  available: true, collectedAtKst: "2026-11-11 18:40 KST", ageSeconds: 60, source: "KRX 정보데이터시스템", fetchTier: "impersonate",
  asOf: "2026-11-11", sourceUrl: "https://data.krx.co.kr/",
  totals: { KOSPI: { asOf: "2026-11-11", rows: [{ investor: "외국인", buyEok: 100, sellEok: 50, netEok: 50, netVolume: 10 }] } },
  foreign: { KOSPI: { asOf: "2026-11-11", rows: [{ code: "000001", name: "가나다", close: 1000, changePct: 1.5, holdShares: 10, holdPct: 50.12, limitExhaustPct: null }] } },
  shortTrades: {},
  shortBalances: { KOSPI: { asOf: "2026-11-07", isStale: true, rows: [] } },
  failed: [],
  ranking: {
    market: "KOSPI", investor: "외국인", tradeType: "순매수", date: "2026-11-11",
    rows: Array.from({ length: 12 }, (_, i) => ({
      rank: i + 1, code: `00000${i}`.slice(-6), name: `종목${i + 1}`, netAmountEok: i === 0 ? null : 10 - i, netVolume: 1000, buyEok: 1, sellEok: 1,
    })),
  },
  markets: ["KOSPI", "KOSDAQ"],
  investors: ["외국인", "기관"],
};

const FLOWS = {
  available: true, collectedAtKst: "2026-11-11 16:50 KST", ageSeconds: 60, source: "네이버 증권", fetchTier: "impersonate", unit: "억원", failed: [],
  sourceUrls: {},
  trend: { KOSPI: { rows: [] } },
  rankings: { FOREIGNER: { KOSPI: { estimated: true, rankedAt: "2026-11-11T16:44:10+09:00", period: { from: "2026-11-11", to: "2026-11-11" },
    buy: [{ rank: 1, code: "000001", name: "네이버추정", price: 7210, changePct: -1.1, netVolume: 873324, netAmountEok: null }], sell: [] } } },
};

const MECHANISM = {
  checkedAt: "2026-11-11 18:00:00 KST",
  collector: {
    politeEnabled: false, tickSeconds: 60, tickJitterSeconds: 25, taskDeadlineSeconds: 900,
    browser: { configured: false, reachable: false, pressCheckbox: null, allowedHosts: null },
    gap: { medianSeconds: 7, lowSeconds: 4, highSeconds: 15, longChance: 0.1, longLowSeconds: 20, longHighSeconds: 60 },
    backoffMinutes: [[30, 60], [120, 240]], humanCheckMinutes: [360, 720], giveUpLevel: 4, giveUpRecheckDays: 7, staleFactor: 3,
    hosts: [{ host: "data.krx.co.kr", tiers: ["impersonate"], dailyBudget: 40 }],
    cadences: [{ task: "info_krx_daily", lowMinutes: 120, highMinutes: 300, note: null }],
    articles: { retentionDays: 180 },
  },
  hostStates: [{ host: "data.krx.co.kr", lastGoodTier: "impersonate", failLevel: 0, blockedUntil: null, blockedReason: null, givenUp: false, usedToday: 3 }],
  schedule: { info_krx_daily: "2026-11-11 19:12:00 KST" },
  alerts: { formatStreak: 2, failedStreak: 3, intervalMinutes: 5 },
  deferred: [{ task: "saveticker", label: "saveticker 뉴스(보류)", reason: "서버 IP 차단" }],
};

function routes(map: Record<string, unknown>) {
  api.apiGetShared.mockImplementation((path: string) => {
    const hit = Object.entries(map).find(([prefix]) => path.startsWith(prefix));
    return hit ? Promise.resolve(hit[1]) : new Promise(() => {});
  });
}

const called = (prefix: string) => api.apiGetShared.mock.calls.map(([path]) => String(path)).filter((path) => path.startsWith(prefix));

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
});
afterEach(() => cleanup());

describe("정보 수집 화면", () => {
  it("개요: 분류 카드가 그 분류 탭으로 가고, 위험이 있는 분류는 그 수를 보인다", async () => {
    routes({ "/api/info/catalog": CATALOG, "/api/info/mechanism": MECHANISM, "/api/info/items": { available: true, items: [], page: 1, pages: 0, total: 0 } });
    render(<InfoHub tab="overview" />);

    const card = await screen.findByRole("link", { name: /해외 시장·거시/ });
    expect(card.getAttribute("href")).toBe("/info/global");
    expect(within(card).getByText(/위험 1/)).toBeTruthy();
    expect(screen.getByText(/차단 통과 수집이 꺼져 있습니다/)).toBeTruthy();
  });

  it("뉴스·글: 한국어 제목을 위에, 다음 쪽은 서버에 page=2로 묻고, 제목을 누르면 원문 팝업에서 본문을 읽고 한국어로 번역한다", async () => {
    routes({
      "/api/info/catalog": CATALOG,
      "/api/info/items/0123456789abcdef01234567": { found: true, item: { ...ITEM, body: "First paragraph of the body." } },
      "/api/info/items?kind=blog": { available: true, items: [ITEM], page: 1, size: 10, total: 25, pages: 3 },
    });
    api.apiPost.mockResolvedValue({
      ok: true, titleKo: null, textKo: "본문 첫 문단의 번역", alreadyKorean: false, cached: false, truncated: false, model: "claude-haiku-5-5", error: null,
    });
    render(<InfoHub tab="news" />);

    await screen.findByRole("button", { name: "금리 급등" });
    expect(screen.getByRole("link", { name: "원문 열기" }).getAttribute("href")).toBe(ITEM.url);
    fireEvent.click(within(screen.getByRole("navigation", { name: "글 목록 쪽" })).getByRole("button", { name: "다음" }));
    expect(called("/api/info/items?kind=blog").some((path) => path.includes("page=2"))).toBe(true);

    expect(called("/api/info/items/")).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "금리 급등" }));
    const dialog = await screen.findByRole("dialog", { name: "금리 급등" });
    expect(await within(dialog).findByText("First paragraph of the body.")).toBeTruthy();
    expect(within(dialog).getByText("원문 제목: Rates Spike")).toBeTruthy();
    expect(api.apiPost).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "한국어로 번역" }));
    expect(await within(dialog).findByText("본문 첫 문단의 번역")).toBeTruthy();
    expect(api.apiPost).toHaveBeenCalledWith("/api/info/translate", { itemId: ITEM.id });
    fireEvent.click(within(dialog).getByRole("button", { name: "원문 보기" }));
    expect(within(dialog).getByText("First paragraph of the body.")).toBeTruthy();
  });

  it("뉴스·글: 속보는 미리 번역한 제목을 위에 보이고, 본문 없는 한 줄이라 팝업에 번역 단추가 없다. 사건 뉴스는 피드 요약을 번역한다", async () => {
    const WIRE = {
      ...ITEM, id: "0123456789abcdef01234568", source: "wire.financialjuice", sourceLabel: "Financial Juice 속보", kind: "headline",
      title: "Fed's Waller: rates are restrictive", titleKo: "월러 연준 이사: 금리는 제약적", author: null, summary: null, bodyStatus: "none",
    };
    routes({
      "/api/info/catalog": CATALOG,
      "/api/info/items?kind=wire": { available: true, items: [WIRE], page: 1, size: 10, total: 1, pages: 1 },
      "/api/info/items?kind=blog": { available: true, items: [], page: 1, size: 10, total: 0, pages: 1 },
      "/api/info/headlines?set=us": {
        available: true, page: 1, size: 10, total: 1, pages: 1,
        items: [{ set: "us", title: "Fed issues FOMC statement", titleKo: null, summary: "The Committee decided to maintain the target range.",
          link: "https://www.federalreserve.gov/x", source: "Federal Reserve", feed: "fed_monetary", publishedAt: "2026-11-11 04:00:00 KST", fetchedAt: null }],
      },
    });
    api.apiPost.mockResolvedValue({
      ok: true, titleKo: "연준, FOMC 성명 발표", textKo: "위원회는 목표 범위를 유지하기로 했다.", alreadyKorean: false, cached: false, truncated: false,
      model: "claude-haiku-5-5", error: null,
    });
    render(<InfoHub tab="news" />);

    fireEvent.click(await screen.findByRole("button", { name: "속보(Financial Juice)" }));
    fireEvent.click(await screen.findByRole("button", { name: "월러 연준 이사: 금리는 제약적" }));
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/한 줄 속보라 본문이 없는 출처/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "한국어로 번역" })).toBeNull();
    expect(called("/api/info/items/")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));

    fireEvent.click(await screen.findByRole("button", { name: "사건 뉴스(미국)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fed issues FOMC statement" }));
    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("The Committee decided to maintain the target range.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "한국어로 번역" }));
    expect(await within(dialog).findByText("위원회는 목표 범위를 유지하기로 했다.")).toBeTruthy();
    expect(within(dialog).getByText("연준, FOMC 성명 발표")).toBeTruthy();
    expect(api.apiPost).toHaveBeenCalledWith("/api/info/translate", {
      title: "Fed issues FOMC statement", text: "The Committee decided to maintain the target range.",
    });
  });

  it("국내 시장·수급: KRX 순위는 10줄씩, 금액이 없으면 '—', 이어받은 부분은 이전 값 표시; 네이버 장중 추정은 금액 '—'", async () => {
    routes({ "/api/info/krx": KRX, "/api/info/flows": FLOWS, "/api/info/catalog": CATALOG });
    render(<InfoHub tab="kr" />);

    const ranking = await screen.findByRole("region", { name: /^KRX 외국인 순매수 상위 · 코스피 / });
    expect(within(ranking).getAllByRole("row")).toHaveLength(11);
    const first = within(ranking).getByText("종목1 (000000)").closest("tr") as HTMLElement;
    expect(within(first).getByText("—")).toBeTruthy();
    expect(screen.getByText(/기준일 2026-11-07 · 이번에 받지 못해 이전 값/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("navigation", { name: "KRX 외국인 순매수 상위 · 코스피 쪽" })).getByRole("button", { name: "2" }));
    expect(within(ranking).getByText("종목11 (000010)")).toBeTruthy();

    const naver = await screen.findByRole("region", { name: /^외국인 순매수 상위 · 코스피 / });
    const row = within(naver).getByText("네이버추정").closest("tr") as HTMLElement;
    expect(within(row).getByText("—")).toBeTruthy();
    expect(within(row).getByText("+873,324주")).toBeTruthy();
    expect(called("/api/info/krx")[0]).toContain("investor=%EC%99%B8%EA%B5%AD%EC%9D%B8");
  });

  it("출처 상태: 위험이 먼저, 10줄씩, 상태로 거른다", async () => {
    routes({ "/api/info/catalog": CATALOG });
    render(<InfoHub tab="status" />);

    const table = await screen.findByRole("region", { name: /^출처 상태 / });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(10);
    expect(within(rows[0]).getByText("끊긴 출처")).toBeTruthy();
    expect(within(rows[0]).getByText("차단됨 — 잠시 멈춤")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "위험" }));
    expect(within(table).getAllByRole("row").slice(1)).toHaveLength(1);
    expect(screen.queryByRole("navigation", { name: /출처 상태 쪽/ })).toBeNull();
  });

  it("정보(메커니즘): 수집기의 실제 값(스위치·간격·예산)과 패킷 스위치·보류 출처를 보인다", async () => {
    routes({ "/api/info/mechanism": MECHANISM });
    render(<InfoHub tab="mechanism" />);

    expect(await screen.findByText(/끔 — 이 수집기에서는 돌지 않음/)).toBeTruthy();
    const hosts = screen.getByRole("region", { name: /^호스트별 계층·하루 예산 / });
    expect(within(hosts).getByText("3 / 40")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: /^출처별 간격 / })).getByText("2~5시간")).toBeTruthy();
    expect(screen.getByText("info.packet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "설정 탭" }).getAttribute("href")).toBe("/paper/us/settings");
    expect(screen.getByText("saveticker 뉴스(보류)")).toBeTruthy();
  });
});
