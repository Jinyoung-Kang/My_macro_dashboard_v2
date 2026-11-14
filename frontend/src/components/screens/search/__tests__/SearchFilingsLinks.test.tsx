/**
 * 정보 검색 단계 4(계약 §7) 화면. 응답은 모두 합성 값입니다(실제 응답 원문·실제 사람의 자료를 쓰지 않음 — ADR 0026 결정 12).
 *  - 공시·리서치 탭은 대상 종류에 따라(주제는 둘 다 없음, 기관·사람·상장되지 않은 기업은 리서치 없음) — 고를 수 없는 탭을 주소로 줘도 그 결과를 부르지 않음
 *  - 줄의 종류 표지(공시·리서치), 날짜만 아는 줄(timeBasis "date")은 날짜만(시각·'받은 시각' 없음)
 *  - 연결 탭: 대상 풀기의 links + GET /api/search/links(탭을 열 때만)를 관계별로(내부자·최상위 모회사·모회사·자회사), 설명 줄, 출처 상태 줄,
 *    받는 중·실패·건너뜀은 글로(Wikidata를 받지 못했으면 모른다고, 다시 받는 동안은 받는 중), 키 없는 연결은 그 이름으로 다시 풂
 *  - 속성 칸의 LEI(있을 때만)
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("./fakeNavigation"));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SearchFeedItem, SearchLink, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };

const LEI = "TEST00LEI0000000AB42";
const NO_IDS = { ticker: null, market: null, stockCode: null, cik: null, dartCorpCode: null, wikidata: null, lei: null };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: "미국의 반도체 기업",
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: LEI },
  links: [
    { relation: "subsidiary", key: "wd:Q100", name: "Mellanox", kind: "company", source: "wikidata" },
    { relation: "founded_by", key: null, name: "Jensen Huang", kind: "person", source: "wikidata" },
  ],
  sources: ["sec", "wikidata"],
};

const BERKSHIRE = {
  key: "cik:0001067983", kind: "institution", name: "버크셔 해서웨이", nameKo: "버크셔 해서웨이", nameEn: "Berkshire Hathaway Inc", aliases: [],
  description: null, ids: { ...NO_IDS, cik: "0001067983" }, links: [], sources: ["13f"],
};

const PERSON = {
  key: "wd:Q3195170", kind: "person", name: "Example Person", nameKo: null, nameEn: "Example Person", aliases: [], description: null,
  ids: { ...NO_IDS, wikidata: "Q3195170" }, links: [], sources: ["wikidata"],
};

/** 상장되지 않은 기업(Wikidata에만 있음 — 시장·티커 없음). */
const PRIVATE_CO = {
  key: "wd:Q4000001", kind: "company", name: "Example Private Co", nameKo: null, nameEn: "Example Private Co", aliases: [], description: null,
  ids: { ...NO_IDS, wikidata: "Q4000001" }, links: [], sources: ["wikidata"],
};

const TOPIC_KEY = "topic:AI 반도체";
const TOPIC = { key: TOPIC_KEY, kind: "topic", name: "AI 반도체", nameKo: null, nameEn: null, aliases: ["AI 반도체"], description: null, ids: NO_IDS, links: [], sources: [] };

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "filing", title: "제목", url: "https://www.sec.gov/Archives/edgar/data/1/000000000026000001/0000000000-26-000001-index.htm",
    publisher: "NVIDIA CORP", publisherDomain: "sec.gov", publishedAt: "2026-11-13T00:00:00+00:00", timeBasis: "published", source: "sec", lang: "en",
    summary: null, readerId: null, ...over,
  };
}

const FILINGS = [
  // 접수 시각이 있는 SEC 줄 — UTC 21:05는 KST 다음 날 06:05
  row({ id: "f1", title: "10-Q · Quarterly report", publishedAt: "2026-11-12T21:05:00+00:00", summary: "보고 기준일 2026-10-26" }),
  // 날짜만 아는 전문 검색 줄 — 미국 동부 2026-11-13 00:00 = UTC 05:00 = KST 14:00(시각은 보이지 않아야 함)
  row({ id: "f2", title: "8-K · Example Filer", source: "sec_fts", publisher: "Example Filer", publishedAt: "2026-11-13T05:00:00+00:00", timeBasis: "date", summary: "Current report" }),
];

const RESEARCH = [
  row({ id: "r1", kind: "research", title: "Example Securities: 상향 Hold → Buy", source: "yahoo_research", publisher: "Example Securities",
    publisherDomain: null, url: "https://finance.yahoo.com/quote/NVDA/analysis/", publishedAt: "2026-11-13T13:00:00+00:00", summary: "목표가 $150 → $180" }),
  // 네이버 리포트 날짜(KST 2026-11-12 00:00 = UTC 전날 15:00)
  row({ id: "r2", kind: "research", title: "수요 점검 리포트", source: "naver_research", publisher: "예시증권", publisherDomain: null, url: null, lang: "ko",
    publishedAt: "2026-11-11T15:00:00+00:00", timeBasis: "date" }),
];

const status = (source: string, label: string, over: Record<string, unknown> = {}) => ({
  source, label, status: "ok", count: 0, dropped: { old: 0, noTime: 0, chinese: 0, excluded: 0 }, message: null, ...over,
});

function feed(tab: string, items: SearchFeedItem[], sources: unknown[]) {
  return {
    available: true, entityKey: "us:NVDA", tab, items, sources,
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": items.length, "30d": items.length, "1y": items.length, "2y": items.length },
    olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
  };
}

const link = (over: Partial<SearchLink>): SearchLink => ({ relation: "insider", key: null, name: "X", kind: "person", source: "yahoo", detail: null, ...over });

const LINKS = {
  available: true,
  entityKey: "us:NVDA",
  links: [
    link({ name: "Jane Roe", detail: "Chief Financial Officer · 최근 Sale 2026-11-03" }),
    link({ name: "John Doe", detail: "Director" }),
    link({ relation: "ultimate_parent", name: "EXAMPLE GLOBAL HOLDINGS LTD", kind: "company", source: "gleif", detail: "GB · LEI TEST00LEI0000000UP11" }),
    link({ relation: "parent", name: "EXAMPLE US HOLDINGS INC", kind: "company", source: "gleif", detail: "US · LEI TEST00LEI0000000PA22" }),
    link({ relation: "subsidiary", name: "EXAMPLE CHIPS GMBH", kind: "company", source: "gleif", detail: "DE · LEI TEST00LEI0000000SU33" }),
  ],
  sources: [
    status("insiders", "내부자 명단(Yahoo)", { count: 2 }),
    status("gleif", "법인 관계(GLEIF)", { count: 3, message: "자회사 20곳까지(전체 31곳)" }),
  ],
  fetchedAt: "2026-11-14T01:00:00+00:00",
};

/** 경로 앞부분 → 응답. failures의 경로는 실패, 둘 다 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
let failures: Record<string, string>;
const longestPrefix = (table: Record<string, unknown>, path: string) =>
  Object.keys(table)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
function serve(path: string): Promise<unknown> {
  const failed = failures[path];
  if (failed) return Promise.reject(new Error(failed));
  const hit = longestPrefix(reads, path);
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}
const sharedCalls = () => api.apiGetShared.mock.calls.map(([path]) => String(path));

function renderScreen(user: SessionUser, path: string) {
  setLocation(path);
  return render(
    <SessionUserProvider user={user}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

const tabNames = async () => within(await screen.findByRole("tablist", { name: "결과 탭" })).getAllByRole("tab").map((tab) => tab.textContent);

beforeEach(() => {
  reads = {};
  failures = {};
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
});
afterEach(() => cleanup());

describe("공시·리서치 탭 — 대상 종류에 따라(계약 §7-7)", () => {
  it("13F 기관 — 공시는 있고 리서치는 없다. 주소로 리서치를 줘도 타임라인이고 그 결과를 부르지 않는다", async () => {
    reads[endpoints.search.entity("cik:0001067983")] = { available: true, entity: BERKSHIRE, errors: {} };
    renderScreen(MEMBER, "/search?e=cik:0001067983&tab=research");
    expect(await tabNames()).toEqual(["타임라인", "뉴스", "공시", "보유", "연결"]);
    expect(screen.getByRole("tab", { name: "타임라인" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(sharedCalls()).toContain(endpoints.search.feed("cik:0001067983", "timeline")));
    expect(sharedCalls().some((path) => path.includes("tab=research"))).toBe(false);
  });

  it("사람 — 공시는 있고 리서치는 없다(운영자는 글·논평도)", async () => {
    reads[endpoints.search.entity("wd:Q3195170")] = { available: true, entity: PERSON, errors: {} };
    renderScreen(OWNER, "/search?e=wd:Q3195170&tab=research");
    expect(await tabNames()).toEqual(["타임라인", "뉴스", "공시", "글·논평", "연결"]);
    expect(screen.getByRole("tab", { name: "타임라인" }).getAttribute("aria-selected")).toBe("true");
    expect(sharedCalls().some((path) => path.includes("tab=research"))).toBe(false);
  });

  it("상장되지 않은 기업 — 공시·보유는 있고 리서치는 없다(계약 §7-3 상장 종목만). 주소로 리서치를 줘도 부르지 않는다", async () => {
    reads[endpoints.search.entity("wd:Q4000001")] = { available: true, entity: PRIVATE_CO, errors: {} };
    renderScreen(MEMBER, "/search?e=wd:Q4000001&tab=research");
    expect(await tabNames()).toEqual(["타임라인", "뉴스", "공시", "보유", "연결"]);
    expect(screen.getByRole("tab", { name: "타임라인" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(sharedCalls()).toContain(endpoints.search.feed("wd:Q4000001", "timeline")));
    expect(sharedCalls().some((path) => path.includes("tab=research"))).toBe(false);
  });

  it("wd:로 열었어도 풀린 대상이 상장 종목이면 리서치 탭이 있다", async () => {
    reads[endpoints.search.entity("wd:Q182477")] = { available: true, entity: NVIDIA, errors: {} };
    renderScreen(MEMBER, "/search?e=wd:Q182477&tab=research");
    expect(await tabNames()).toEqual(["타임라인", "뉴스", "공시", "리서치", "보유", "연결"]);
    expect(screen.getByRole("tab", { name: "리서치" }).getAttribute("aria-selected")).toBe("true");
  });

  it("주제 — 공시·리서치 탭이 없고, 주소로 공시를 줘도 부르지 않는다", async () => {
    reads[endpoints.search.entity(TOPIC_KEY)] = { available: true, entity: TOPIC, errors: {} };
    renderScreen(MEMBER, `/search?e=${encodeURIComponent(TOPIC_KEY)}&tab=filings`);
    expect(await tabNames()).toEqual(["타임라인", "뉴스", "연결"]);
    await waitFor(() => expect(sharedCalls()).toContain(endpoints.search.feed(TOPIC_KEY, "timeline")));
    expect(sharedCalls().some((path) => path.includes("tab=filings") || path.includes("tab=research"))).toBe(false);
  });
});

describe("주소의 탭이 이 대상에 없을 때 — 주소도 타임라인으로 바꿔 씀(4단계 확인 [관찰])", () => {
  it("주제 + tab=filings → 주소의 탭을 timeline으로 바꿔 쓴다(기록에 쌓지 않음, 기간은 그대로)", async () => {
    reads[endpoints.search.entity(TOPIC_KEY)] = { available: true, entity: TOPIC, errors: {} };
    renderScreen(MEMBER, `/search?e=${encodeURIComponent(TOPIC_KEY)}&tab=filings&range=1y`);
    const before = window.history.length;
    await tabNames();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("timeline"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("e")).toBe(TOPIC_KEY);
    expect(params.get("range")).toBe("1y");
    expect(window.history.length).toBe(before);
  });

  it("13F 기관 + tab=research, 회원 + tab=posts도 같은 방식", async () => {
    reads[endpoints.search.entity("cik:0001067983")] = { available: true, entity: BERKSHIRE, errors: {} };
    renderScreen(MEMBER, "/search?e=cik:0001067983&tab=research");
    await tabNames();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("timeline"));
    cleanup();

    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=posts");
    await tabNames();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get("tab")).toBe("timeline"));
  });

  it("고를 수 있는 탭이면 주소를 그대로 둔다 — wd: 키는 풀린 뒤 종류를 보고 정함", async () => {
    reads[endpoints.search.entity("wd:Q182477")] = { available: true, entity: NVIDIA, errors: {} };
    renderScreen(MEMBER, "/search?e=wd:Q182477&tab=research");
    expect(await tabNames()).toContain("리서치");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("research");
  });

  it("wd: 키를 풀지 못했으면(종류를 모름) 주소의 탭을 바꾸지 않는다", async () => {
    failures[endpoints.search.entity("wd:Q4000001")] = "HTTP 502";
    renderScreen(MEMBER, "/search?e=wd:Q4000001&tab=holdings");
    await tabNames();
    expect(screen.getByRole("tab", { name: "타임라인" }).getAttribute("aria-selected")).toBe("true");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("holdings");
  });
});

describe("좁은 화면(390) — 고른 탭을 탭 줄 안에 보이게 가로로 옮김(4단계 확인 [하])", () => {
  const TAB_WIDTH = 80;
  const BAR = { left: 16, right: 374 };
  let rects: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    // jsdom은 배치를 재지 않아 탭 줄(358px)과 탭(80px씩)의 자리를 흉내 냅니다. 탭의 자리는 탭 줄의 가로 스크롤만큼 왼쪽으로 갑니다.
    rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const box = (left: number, right: number) => ({ left, right, top: 0, bottom: 44, width: right - left, height: 44, x: left, y: 0, toJSON: () => ({}) });
      if (this.getAttribute("role") === "tablist") return box(BAR.left, BAR.right) as DOMRect;
      const bar = this.closest('[role="tablist"]') as HTMLElement | null;
      if (this.getAttribute("role") === "tab" && bar) {
        const index = [...bar.querySelectorAll('[role="tab"]')].indexOf(this);
        const left = BAR.left + index * TAB_WIDTH - bar.scrollLeft;
        return box(left, left + TAB_WIDTH) as DOMRect;
      }
      return box(0, 0) as DOMRect;
    });
  });
  afterEach(() => rects.mockRestore());

  it("주소로 연 탭(tab=links)이 탭 줄 밖이면 그 탭이 보이게 옮긴다", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    const bar = await screen.findByRole("tablist", { name: "결과 탭" });
    // 연결 = 여섯째 탭(16 + 5 × 80 = 416 ~ 496) — 오른쪽 끝 374에 맞춤
    await waitFor(() => expect(bar.scrollLeft).toBe(496 - BAR.right));
  });

  it("탭을 바꾸면 그 탭이 보이게 다시 옮기고, 이미 보이면 그대로", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    const bar = await screen.findByRole("tablist", { name: "결과 탭" });
    await waitFor(() => expect(bar.scrollLeft).toBe(122));
    fireEvent.click(within(bar).getByRole("tab", { name: "타임라인" }));
    await waitFor(() => expect(bar.scrollLeft).toBe(0));
    fireEvent.click(within(bar).getByRole("tab", { name: "뉴스" }));
    await waitFor(() => expect(within(bar).getByRole("tab", { name: "뉴스" }).getAttribute("aria-selected")).toBe("true"));
    expect(bar.scrollLeft).toBe(0);
  });
});

describe("공시 탭 — 날짜만 아는 줄(계약 §7-1)", () => {
  beforeEach(() => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "filings")] = feed("filings", FILINGS, [
      status("sec", "SEC 공시(회사별)", { count: 1, message: "최근 1,000건만 — 그 앞은 SEC에서" }),
      status("sec_fts", "SEC 전문 검색(이름)", { status: "skipped", message: "사람·13F 기관만 찾음" }),
    ]);
  });

  it("기업은 공시·리서치 탭이 있고, 공시 탭을 열면 그 결과를 부른다", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=filings");
    expect(await tabNames()).toEqual(["타임라인", "뉴스", "공시", "리서치", "보유", "연결"]);
    expect(screen.getByRole("tab", { name: "공시" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(sharedCalls()).toContain(endpoints.search.feed("us:NVDA", "filings")));
  });

  it("줄마다 '공시' 표지 — 날짜만 아는 줄은 날짜만(시각·'받은 시각' 없음), 접수 시각이 있는 줄은 KST 시각", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=filings");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const dated = within(list).getByRole("option", { name: /8-K · Example Filer/ });
    expect(dated.textContent).toContain("공시");
    expect(dated.textContent).toContain("2026-11-13");
    expect(dated.textContent).not.toContain("14:00");
    expect(dated.textContent).not.toContain("받은 시각");
    const timed = within(list).getByRole("option", { name: /10-Q · Quarterly report/ });
    expect(timed.textContent).toContain("공시");
    expect(timed.textContent).toContain("06:05");
    // 두 줄 모두 KST 2026-11-13 묶음
    expect(within(list).getByText("2026-11-13 (금)")).toBeTruthy();
  });

  it("고른 날짜만 아는 줄의 미리 보기도 날짜만", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=filings");
    fireEvent.click(await screen.findByRole("option", { name: /8-K · Example Filer/ }));
    const preview = screen.getByRole("region", { name: "미리 보기" });
    expect(preview.textContent).toContain("2026-11-13");
    expect(preview.textContent).not.toContain("14:00");
    expect(preview.textContent).not.toContain("받은 시각");
    expect(within(preview).getByText("Current report")).toBeTruthy();
  });

  it("출처 상태 줄 — 건너뜀과 안내 글을 글로", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=filings");
    const statuses = await screen.findByRole("list", { name: "출처 상태" });
    const sec = within(statuses).getByText("SEC 공시(회사별)").closest("li") as HTMLElement;
    expect(sec.textContent).toContain("최근 1,000건만 — 그 앞은 SEC에서");
    const fts = within(statuses).getByText("SEC 전문 검색(이름)").closest("li") as HTMLElement;
    expect(fts.textContent).toContain("건너뜀");
  });
});

describe("리서치 탭", () => {
  it("줄마다 '리서치' 표지 — 네이버 리포트(날짜만)는 날짜, Yahoo 투자의견 변경은 KST 시각", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "research")] = feed("research", RESEARCH, [status("yahoo_research", "투자의견 변경(Yahoo)", { count: 1 })]);
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=research");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const naver = within(list).getByRole("option", { name: /수요 점검 리포트/ });
    expect(naver.textContent).toContain("리서치");
    expect(naver.textContent).toContain("2026-11-12");
    expect(naver.textContent).not.toContain("00:00");
    const yahoo = within(list).getByRole("option", { name: /Example Securities: 상향/ });
    expect(yahoo.textContent).toContain("리서치");
    expect(yahoo.textContent).toContain("22:00");
  });
});

describe("연결 탭 — 대상 풀기의 연결 + 연결 보강(계약 §7-5)", () => {
  beforeEach(() => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed("timeline", FILINGS, []);
  });

  it("연결 탭을 열기 전에는 보강 경로를 부르지 않는다", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    expect(sharedCalls()).not.toContain(endpoints.search.links("us:NVDA"));
    fireEvent.click(screen.getByRole("tab", { name: "연결" }));
    await waitFor(() => expect(sharedCalls()).toContain(endpoints.search.links("us:NVDA")));
  });

  it("두 응답을 관계별로 합쳐 보이고(설명 줄과 함께), 출처 상태를 글로 적는다", async () => {
    reads[endpoints.search.links("us:NVDA")] = LINKS;
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    expect(await screen.findByRole("heading", { name: "내부자" })).toBeTruthy();
    for (const label of ["창업자", "최상위 모회사", "모회사", "자회사"]) expect(screen.getByRole("heading", { name: label })).toBeTruthy();

    // 자회사 — Wikidata(Mellanox)와 GLEIF가 한 묶음
    const subsidiaries = screen.getByRole("region", { name: "자회사" });
    expect(within(subsidiaries).getByRole("button", { name: /Mellanox/ })).toBeTruthy();
    const child = within(subsidiaries).getByRole("button", { name: /EXAMPLE CHIPS GMBH/ });
    expect(child.textContent).toContain("DE · LEI TEST00LEI0000000SU33");
    expect(child.textContent).toContain("GLEIF");

    const insider = screen.getByRole("button", { name: /Jane Roe/ });
    expect(insider.textContent).toContain("Chief Financial Officer · 최근 Sale 2026-11-03");
    expect(insider.textContent).toContain("Yahoo");

    const statuses = screen.getByRole("list", { name: "출처 상태" });
    const insiders = within(statuses).getByText("내부자 명단(Yahoo)").closest("li") as HTMLElement;
    expect(insiders.textContent).toContain("받음");
    expect(insiders.textContent).toContain("2건");
    const gleif = within(statuses).getByText("법인 관계(GLEIF)").closest("li") as HTMLElement;
    expect(gleif.textContent).toContain("자회사 20곳까지(전체 31곳)");
    expect(sharedCalls().filter((path) => path === endpoints.search.links("us:NVDA"))).toHaveLength(1);
  });

  it("키 없는 연결(내부자)을 누르면 그 이름으로 다시 푼다", async () => {
    reads[endpoints.search.links("us:NVDA")] = LINKS;
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    fireEvent.click(await screen.findByRole("button", { name: /Jane Roe/ }));
    expect(window.location.search).toBe(`?q=${encodeURIComponent("Jane Roe")}`);
  });

  it("받는 중 — 대상 풀기의 연결은 바로 보이고, 보강은 받는 중이라고 글로(없다고 하지 않음)", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    expect(await screen.findByRole("button", { name: /Mellanox/ })).toBeTruthy();
    expect(screen.getByText(/내부자 명단·법인 관계를 받는 중/)).toBeTruthy();
    expect(screen.queryByText(/가진 연결이 없습니다/)).toBeNull();
  });

  it("보강 경로가 실패하면 사유를 글로 — 대상 풀기의 연결은 그대로", async () => {
    failures[endpoints.search.links("us:NVDA")] = "HTTP 502";
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    expect(await screen.findByText(/내부자 명단·법인 관계를 받지 못했습니다 — HTTP 502/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Mellanox/ })).toBeTruthy();
  });

  it("건너뛴 출처(LEI 없음 등)는 상태 줄에 '건너뜀'과 사유를 글로", async () => {
    reads[endpoints.search.links("us:NVDA")] = {
      ...LINKS,
      links: [],
      sources: [
        status("insiders", "내부자 명단(Yahoo)", { status: "error", message: "HTTP 429" }),
        status("gleif", "법인 관계(GLEIF)", { status: "skipped", message: "LEI 없음 — Wikidata에 법인 식별자가 없음" }),
      ],
    };
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    const statuses = await screen.findByRole("list", { name: "출처 상태" });
    const gleif = within(statuses).getByText("법인 관계(GLEIF)").closest("li") as HTMLElement;
    expect(gleif.textContent).toContain("건너뜀");
    expect(gleif.textContent).toContain("LEI 없음 — Wikidata에 법인 식별자가 없음");
    const insiders = within(statuses).getByText("내부자 명단(Yahoo)").closest("li") as HTMLElement;
    expect(insiders.textContent).toContain("실패");
    // Wikidata 연결은 그대로 보임
    expect(screen.getByRole("button", { name: /Mellanox/ })).toBeTruthy();
  });

  it("Wikidata를 받지 못했으면(대상 풀기의 errors) 보강 출처가 모두 건너뜀이어도 '없다'고 하지 않고 모른다고 — 사유 한 줄과 함께", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: { ...NVIDIA, links: [] }, errors: { wikidata: "HTTP 503" } };
    reads[endpoints.search.links("us:NVDA")] = {
      ...LINKS,
      links: [],
      sources: [
        status("insiders", "내부자 명단(Yahoo)", { status: "skipped", message: "미국 상장 회사가 아님" }),
        status("gleif", "법인 관계(GLEIF)", { status: "skipped", message: "LEI 없음 — Wikidata에 법인 식별자가 없음" }),
      ],
    };
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    expect(await screen.findByText(/더 있는지 모릅니다/)).toBeTruthy();
    expect(screen.getByText("Wikidata 관계를 받지 못했습니다 — HTTP 503")).toBeTruthy();
    expect(screen.queryByText(/^가진 연결이 없습니다/)).toBeNull();
  });

  it("수집기에 닿지 못한 응답 뒤 '다시 받기'를 누르면 받는 중 글로 바뀌고(실패 글을 남기지 않음), 받으면 연결이 보인다", async () => {
    reads[endpoints.search.links("us:NVDA")] = { available: false, message: "수집기 응답 시간 초과" };
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    expect(await screen.findByText(/내부자 명단·법인 관계를 받지 못했습니다 — 수집기 응답 시간 초과/)).toBeTruthy();

    let release: (value: unknown) => void = () => {};
    const linksPath = endpoints.search.links("us:NVDA");
    api.apiGetShared.mockImplementation((path: string) =>
      path === linksPath ? new Promise((resolve) => (release = resolve)) : serve(path),
    );
    fireEvent.click(screen.getByRole("button", { name: "다시 받기" }));
    expect(await screen.findByText(/내부자 명단·법인 관계를 받는 중/)).toBeTruthy();
    expect(screen.queryByText(/받지 못했습니다 — 수집기 응답 시간 초과/)).toBeNull();
    expect(screen.queryByRole("button", { name: "다시 받기" })).toBeNull();

    await act(async () => release(LINKS));
    expect(await screen.findByRole("heading", { name: "내부자" })).toBeTruthy();
    expect(screen.queryByText(/받는 중/)).toBeNull();
  });

  it("연결이 하나도 없고 받지 못한 출처가 있으면 '없다'고 하지 않고 모른다고", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: { ...NVIDIA, links: [] }, errors: {} };
    reads[endpoints.search.links("us:NVDA")] = {
      ...LINKS, links: [], sources: [status("insiders", "내부자 명단(Yahoo)", { status: "error", message: "HTTP 429" })],
    };
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    expect(await screen.findByText(/더 있는지 모릅니다/)).toBeTruthy();
    expect(screen.queryByText(/^가진 연결이 없습니다/)).toBeNull();
  });
});

describe("속성 칸의 LEI(계약 §7-5)", () => {
  it("ids.lei가 있으면 속성 칸에 보인다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed("timeline", FILINGS, []);
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    const attributes = screen.getByRole("region", { name: "속성" });
    expect(within(attributes).getByText("LEI")).toBeTruthy();
    expect(within(attributes).getByText(LEI)).toBeTruthy();
  });

  it("없으면(null이거나 옛 응답에 칸이 없음) LEI 줄을 그리지 않는다", async () => {
    const withoutLei = Object.fromEntries(Object.entries(NVIDIA.ids).filter(([name]) => name !== "lei"));
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: { ...NVIDIA, ids: withoutLei }, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed("timeline", FILINGS, []);
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    const attributes = screen.getByRole("region", { name: "속성" });
    expect(within(attributes).queryByText("LEI")).toBeNull();
  });
});
