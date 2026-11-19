/**
 * 정보 수집(/info/<탭>) 재배치 전에 고정하는 것(작업대 화면 언어 P7 — 정보 수집 갈래 '지킴'). 화면을 조밀 표·검사 칸·KPI 띠로 바꿔도 아래는 그대로여야 합니다.
 *  - 요청: 탭마다 읽는 경로와 다시 읽는 주기(useApi의 두 번째 인자), 처음 그릴 때의 요청 수. 개요 catalog 120초·mechanism 300초·items page=1 size=5 300초,
 *    뉴스 catalog 두 훅(300초·120초)·글 목록 size=10(주기 없음)·글을 열 때만 GET /api/info/items/{id}(본문 있는 글만), 국내 krx 600초·flows 300초·catalog 120초,
 *    해외·공시·모의 입력·출처 상태 catalog 120초, 메커니즘 mechanism 300초, 거장 견해 gurus 600초.
 *  - 쓰기: 번역 POST /api/info/translate 본문 셋 — 제목 단추 {title}, 원문(수집 글) {itemId}, 원문(사건 뉴스) {title, text}. 같은 요청은 한 번(useTranslate).
 *  - 쪽 나누기 10줄, 사유·기록은 자르지 않음(2026-11-12 사용자 결정), 시각은 KST 그대로.
 * 응답은 모두 합성 값입니다. DOM 꼴(카드·표·팝업)에 기대지 않게 이름(역할·글)으로만 찾습니다.
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

/** useApi를 부른 (경로, 주기) — 실제 훅은 그대로 돌리고 인자만 적습니다. */
const reads = vi.hoisted(() => ({ calls: [] as [string | null, number][] }));
vi.mock("@/hooks/useApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useApi")>();
  return {
    ...actual,
    useApi: (path: string | null, refreshMs?: number, options?: Parameters<typeof actual.useApi>[2]) => {
      reads.calls.push([path, refreshMs ?? 0]);
      return actual.useApi(path, refreshMs, options);
    },
  };
});

import InfoHub from "../InfoHub";
import { endpoints } from "@/lib/endpoints";
import type { InfoTab } from "@/lib/info";

function source(index: number, over: Record<string, unknown> = {}) {
  return {
    task: `task_${index}`, key: `key_${index}`, label: `출처 ${index}`, tab: "global", kind: "data", siteUrl: null, origin: "합성",
    access: "official", screen: null, speed: "slow", lastStatus: "ok", lastRunAt: "2026-11-11 17:00 KST", lastDetail: null,
    politeStatus: null, streak: null, lastOkAt: null, nextDueAt: null, items: null, incident: null, tone: "ok", ...over,
  };
}

const LONG = "KRX 기준일 2026-11-11 · 순매수 상위 10/12 · 시장 합계·외국인 보유·공매도 거래 5/6 · 공매도 잔고 1/2 · 못 받음 4 · "
  + "일부 받지 못함(받지 못함: rank.KOSPI.연기금 등, rank.KOSDAQ.연기금 등, shortBalances.KOSDAQ 외 1) · 다음 2026-11-11 21:40 KST";

const CATALOG = {
  checkedAt: "2026-11-11 18:00 KST",
  collectorReachable: true,
  tabs: [
    { key: "news", label: "뉴스·글", sources: 1, tones: { ok: 1 } },
    { key: "global", label: "해외 시장·거시", sources: 12, tones: { ok: 11, danger: 1 } },
  ],
  sources: [
    source(0, { tab: "news", kind: "blog", key: "blog.wolfstreet", label: "Wolf Street", access: "bypass", speed: "polite" }),
    ...Array.from({ length: 11 }, (_, i) => source(i + 1, i === 0 ? { lastDetail: LONG } : {})),
    source(12, {
      label: "끊긴 출처", tone: "danger", politeStatus: "blocked",
      incident: { key: "task_12", task: "task_12", label: "끊긴 출처", kind: "blocked", kindLabel: "차단됨 — 잠시 멈춤", reason: "403", since: null, streak: 1 },
    }),
  ],
  incidents: [],
};

const ITEM = {
  id: "0123456789abcdef01234567", source: "blog.wolfstreet", sourceLabel: "Wolf Street", kind: "article",
  url: "https://wolfstreet.com/2026/11/10/rates-spike/", title: "Rates Spike", titleKo: null, author: "Wolf Richter",
  publishedAt: "2026-11-10 19:21 KST", firstSeenAt: "2026-11-11 01:00 KST", summary: "요약 글", bodyStatus: "full",
  fetchTier: null, category: null,
};
/** 본문도 요약도 없는 한 줄 속보 — 열어도 본문을 읽으러 가지 않습니다. */
const BARE = { ...ITEM, id: "0123456789abcdef0123ffff", title: "Bare headline", summary: null, bodyStatus: "none" };

const HEADLINES = {
  available: true, page: 1, size: 10, total: 1, pages: 1,
  items: [{ set: "us", title: "Fed issues FOMC statement", summary: "The Committee decided to maintain the target range.",
    link: "https://www.federalreserve.gov/x", source: "Federal Reserve", feed: "fed_monetary", publishedAt: "2026-11-11 04:00 KST", fetchedAt: null }],
};

const MECHANISM = {
  checkedAt: "2026-11-11 18:00 KST",
  collector: null,
  hostStates: [], schedule: {}, alerts: { formatStreak: 2, failedStreak: 3, intervalMinutes: 5 }, deferred: [],
};

const KRX = {
  available: false, ranking: { market: "KOSPI", investor: "외국인", tradeType: "순매수", date: null, rows: [] }, markets: ["KOSPI", "KOSDAQ"], investors: ["외국인"],
};
const FLOWS = { available: false };

function routes(map: Record<string, unknown>) {
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(map).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key === undefined ? new Promise(() => {}) : Promise.resolve(map[key]);
  });
}

/** 처음 그린 뒤의 GET 경로(호출 순서 그대로). */
const gets = () => api.apiGetShared.mock.calls.map(([path]) => String(path));
/** useApi에 넘긴 (경로, 주기) — 경로가 있는 것만, 겹친 것은 한 번. */
const readPairs = () => [...new Set(reads.calls.filter(([path]) => path !== null).map(([path, ms]) => `${path} @${ms}`))].sort();

beforeEach(() => {
  reads.calls = [];
  api.apiGetShared.mockReset();
  api.apiPost.mockReset();
});
afterEach(() => cleanup());

const ALL = {
  "/api/info/catalog": CATALOG,
  "/api/info/mechanism": MECHANISM,
  "/api/info/items?page=1&size=5": { available: true, items: [], page: 1, pages: 0, total: 0 },
  "/api/info/items?kind=blog": { available: true, items: [ITEM, BARE], page: 1, size: 10, total: 2, pages: 1 },
  [`/api/info/items/${ITEM.id}`]: { found: true, item: { ...ITEM, body: "First paragraph of the body." } },
  "/api/info/headlines?set=us": HEADLINES,
  "/api/info/krx": KRX,
  "/api/info/flows": FLOWS,
  "/api/info/gurus": { available: false },
};

describe("정보 수집 — 재배치 전에 고정하는 요청", () => {
  const cases: [InfoTab, string, string[], Record<string, number>][] = [
    ["overview", "출처 1", [
      `${endpoints.info.catalog} @120000`, `${endpoints.info.items({ page: 1, size: 5 })} @300000`, `${endpoints.info.mechanism} @300000`,
    ], { [endpoints.info.catalog]: 1, [endpoints.info.mechanism]: 1, [endpoints.info.items({ page: 1, size: 5 })]: 1 }],
    ["news", "Rates Spike", [
      `${endpoints.info.catalog} @120000`, `${endpoints.info.catalog} @300000`, `${endpoints.info.items({ kind: "blog", page: 1, size: 10 })} @0`,
    ], { [endpoints.info.catalog]: 2, [endpoints.info.items({ kind: "blog", page: 1, size: 10 })]: 1 }],
    ["kr", "출처 1", [
      `${endpoints.info.catalog} @120000`, `${endpoints.info.flows} @300000`, `${endpoints.info.krx("KOSPI", "외국인", "순매수")} @600000`,
    ], { [endpoints.info.catalog]: 1, [endpoints.info.flows]: 1, [endpoints.info.krx("KOSPI", "외국인", "순매수")]: 1 }],
    ["global", "출처 1", [`${endpoints.info.catalog} @120000`], { [endpoints.info.catalog]: 1 }],
    ["filings", "출처 1", [`${endpoints.info.catalog} @120000`], { [endpoints.info.catalog]: 1 }],
    ["paper", "출처 1", [`${endpoints.info.catalog} @120000`], { [endpoints.info.catalog]: 1 }],
    ["status", "출처 1", [`${endpoints.info.catalog} @120000`], { [endpoints.info.catalog]: 1 }],
    ["mechanism", "한 바퀴", [`${endpoints.info.mechanism} @300000`], { [endpoints.info.mechanism]: 1 }],
  ];

  for (const [tab, ready, pairs, counts] of cases) {
    it(`${tab}: 읽는 경로·주기와 처음 요청 수`, async () => {
      // 개요·해외 등은 그 분류에 출처가 없어도 됩니다 — 기다릴 글은 그 탭에 늘 보이는 것.
      const catalog = tab === "filings" || tab === "paper" || tab === "kr" ? { ...CATALOG, sources: CATALOG.sources.map((row) => ({ ...row, tab })) } : CATALOG;
      routes({ ...ALL, "/api/info/catalog": catalog });
      render(<InfoHub tab={tab} />);
      if (tab === "overview") await screen.findAllByText("해외 시장·거시");
      else if (tab === "mechanism") await screen.findByText(/수집기에 닿지 못해/);
      else await screen.findAllByText(ready);

      expect(readPairs()).toEqual([...pairs].sort());
      const tally: Record<string, number> = {};
      for (const path of gets()) tally[path] = (tally[path] ?? 0) + 1;
      expect(tally).toEqual(counts);
    });
  }

  it("뉴스·글: 글 목록은 10편씩 서버에 묻고, 본문 있는 글을 열 때만 GET /api/info/items/{id} 한 번 — 본문 없는 글은 읽지 않는다", async () => {
    routes(ALL);
    render(<InfoHub tab="news" />);
    await screen.findByRole("button", { name: "Bare headline" });
    expect(gets().filter((path) => path.startsWith("/api/info/items?"))).toEqual([endpoints.info.items({ kind: "blog", page: 1, size: 10 })]);
    expect(gets().filter((path) => path.startsWith("/api/info/items/"))).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Bare headline" }));
    await screen.findByRole("dialog", { name: "Bare headline" });
    expect(gets().filter((path) => path.startsWith("/api/info/items/"))).toEqual([]);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Bare headline" }), { key: "Escape" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Rates Spike" }));
    const dialog = await screen.findByRole("dialog", { name: "Rates Spike" });
    await within(dialog).findByText("First paragraph of the body.");
    expect(gets().filter((path) => path.startsWith("/api/info/items/"))).toEqual([endpoints.info.item(ITEM.id)]);
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("뉴스·글: 거장 견해 보기는 gurus를 600초로 읽는다", async () => {
    routes(ALL);
    render(<InfoHub tab="news" />);
    await screen.findByRole("button", { name: "Rates Spike" });
    reads.calls = [];
    api.apiGetShared.mockClear();
    fireEvent.click(screen.getByRole(screen.queryByRole("radiogroup", { name: "글 종류" }) ? "radio" : "button", { name: "거장 견해" }));
    await screen.findByText(/아직 받은 견해가 없습니다/);
    expect(readPairs()).toContain(`${endpoints.info.gurus} @600000`);
    expect(gets()).toContain(endpoints.info.gurus);
  });
});

describe("정보 수집 — 재배치 전에 고정하는 쓰기(번역 POST 본문 셋)", () => {
  const OK = { ok: true, titleKo: "번역 제목", textKo: "번역 본문", alreadyKorean: false, cached: false, truncated: false, model: "gemini-flash-lite-latest", error: null };

  it("제목 번역 단추는 {title} 한 번", async () => {
    routes(ALL);
    api.apiPost.mockResolvedValue(OK);
    render(<InfoHub tab="news" />);
    fireEvent.click(await screen.findByRole("button", { name: "제목 번역: Rates Spike" }));
    expect(await screen.findByText("번역 제목")).toBeTruthy();
    expect(api.apiPost.mock.calls).toEqual([["/api/info/translate", { title: "Rates Spike" }]]);
  });

  it("원문(수집 글) 번역은 {itemId} 한 번", async () => {
    routes(ALL);
    api.apiPost.mockResolvedValue(OK);
    render(<InfoHub tab="news" />);
    fireEvent.click(await screen.findByRole("button", { name: "Rates Spike" }));
    const dialog = await screen.findByRole("dialog", { name: "Rates Spike" });
    await within(dialog).findByText("First paragraph of the body.");
    fireEvent.click(within(dialog).getByRole("button", { name: "한국어로 번역" }));
    expect(await within(dialog).findByText("번역 본문")).toBeTruthy();
    expect(api.apiPost.mock.calls).toEqual([["/api/info/translate", { itemId: ITEM.id }]]);
  });

  it("원문(사건 뉴스) 번역은 {title, text} 한 번", async () => {
    routes(ALL);
    api.apiPost.mockResolvedValue(OK);
    render(<InfoHub tab="news" />);
    await screen.findByRole("button", { name: "Rates Spike" });
    fireEvent.click(screen.getByRole(screen.queryByRole("radiogroup", { name: "글 종류" }) ? "radio" : "button", { name: "사건 뉴스(미국)" }));
    fireEvent.click(await screen.findByRole("button", { name: "Fed issues FOMC statement" }));
    const dialog = await screen.findByRole("dialog", { name: "Fed issues FOMC statement" });
    fireEvent.click(within(dialog).getByRole("button", { name: "한국어로 번역" }));
    expect(await within(dialog).findByText("번역 본문")).toBeTruthy();
    expect(api.apiPost.mock.calls).toEqual([
      ["/api/info/translate", { title: "Fed issues FOMC statement", text: "The Committee decided to maintain the target range." }],
    ]);
  });
});

describe("정보 수집 — 쪽 나누기·자르지 않음·KST", () => {
  it("출처 상태: 10줄씩, 위험이 먼저, 사유·기록 전체(자르지 않음), 시각은 KST 글 그대로", async () => {
    routes({ "/api/info/catalog": CATALOG });
    render(<InfoHub tab="status" />);
    const table = await screen.findByRole("region", { name: /^출처 상태/ });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(10);
    expect(within(rows[0]).getByText("끊긴 출처")).toBeTruthy();
    const reason = within(table).getByText(LONG);
    expect(reason.className).not.toMatch(/line-clamp|truncate/);
    expect(within(table).getAllByText("2026-11-11 17:00 KST").length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: /쪽$/ })).toBeTruthy();
  });

  it("해외 분류: 출처는 쪽을 나누고(13곳 → 두 쪽), 사유·기록은 자르지 않는다", async () => {
    routes({ "/api/info/catalog": CATALOG });
    render(<InfoHub tab="global" />);
    const text = await screen.findByText(LONG);
    expect(text.className).not.toMatch(/line-clamp|truncate/);
    const pager = screen.getByRole("navigation", { name: /쪽$/ });
    expect(within(pager).getByText("1/2쪽")).toBeTruthy();
  });
});
