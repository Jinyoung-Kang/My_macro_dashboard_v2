/**
 * 정보 검색 화면(/search — ADR 0041, 계약 §5). 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *  - 첫 화면은 저장본만(관심 대상·최근 글 — 대상 풀기·결과·후보를 부르지 않음), 내용 영역은 늘 어두운 범위(data-scope="search")
 *  - 후보: 치는 동안의 후보, Enter는 검색어로(자동으로 고르지 않음), 여럿이면 목록, 하나이고 이름이 같으면 바로 열기(그 자리를 바꿔 씀)
 *  - 빈 결과: 2년 안에 없음(+ 가장 최근 자료 날짜), 이 기간에 없음 + 더 넓은 기간 단추
 *  - 출처 상태 줄: 실패한 출처를 글로(색만이 아님)
 *  - 탭: 글·논평은 운영자만(회원이 주소로 줘도 부르지 않음), 원문 팝업도 운영자만
 *  - 키보드: ↑↓로 줄, Enter로 원문 새 창(http만), 고른 줄은 오른쪽 미리 보기
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
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: "미국의 반도체 기업",
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477" },
  links: [
    { relation: "subsidiary", key: "wd:Q100", name: "Mellanox", kind: "company", source: "wikidata" },
    { relation: "founded_by", key: null, name: "Jensen Huang", kind: "person", source: "wikidata" },
  ],
  sources: ["sec", "wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null, ...over,
  };
}

const ROWS = [
  row({ id: "r1", title: "첫째 기사", summary: "첫째 요약", publishedAt: "2026-11-14T00:30:00+00:00" }),
  row({ id: "r2", title: "둘째 기사", url: "javascript:alert(1)", publisher: "Other", publishedAt: "2026-11-13T10:00:00+00:00", timeBasis: "fetched" }),
  row({ id: "r3", title: "수집 글 하나", kind: "post", source: "info", readerId: "0123456789abcdef01234567", publishedAt: "2026-11-12T01:00:00+00:00" }),
];

const SOURCES = [
  { source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 2, dropped: { old: 4, noTime: 1, chinese: 0, excluded: 0 }, message: null },
  { source: "bing", label: "Bing 뉴스", status: "error", count: 0, dropped: null, message: "HTTP 503" },
];

function feed(over: Record<string, unknown> = {}) {
  return {
    available: true, entityKey: "us:NVDA", tab: "timeline", items: ROWS, sources: SOURCES,
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 3, "30d": 3, "1y": 3, "2y": 3 },
    olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00", ...over,
  };
}

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}
const sharedCalls = () => api.apiGetShared.mock.calls.map(([path]) => String(path));

function renderScreen(user: SessionUser = MEMBER, path = "/search") {
  setLocation(path);
  return render(
    <SessionUserProvider user={user}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

beforeEach(() => {
  reads = {};
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiDelete.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("첫 화면", () => {
  it("대상을 고르기 전에는 저장본만(관심 대상·최근 글) — 대상 풀기·결과·후보를 부르지 않고, 내용 영역은 늘 어두운 범위", () => {
    const { container } = renderScreen();
    expect(screen.getByRole("heading", { level: 1, name: "정보 검색" })).toBeTruthy();
    expect(screen.getAllByText(/최근 2년/).length).toBeGreaterThan(0);
    expect(container.querySelector('[data-scope="search"]')).toBeTruthy();
    expect(api.apiGet).not.toHaveBeenCalled();
    expect([...new Set(sharedCalls())].sort()).toEqual([endpoints.search.recent, endpoints.search.watch].sort());
  });

  it("주소의 대상 키 모양이 틀리면 부르지 않고 그렇게 말한다", () => {
    renderScreen(MEMBER, "/search?e=us:nvda");
    expect(screen.getByText(/대상 키의 모양이 맞지 않습니다/)).toBeTruthy();
    // 첫 화면(관심 대상·최근 글 — 저장본)만 그리고 대상 풀기·결과는 부르지 않음.
    expect(sharedCalls().filter((path) => path !== endpoints.search.watch && path !== endpoints.search.recent)).toEqual([]);
  });
});

describe("검색창과 후보", () => {
  it("치면 가진 색인의 후보를 보이고, 고르지 않고 Enter면 그 검색어로 찾는다(후보를 자동으로 고르지 않음)", async () => {
    vi.useFakeTimers();
    reads[endpoints.search.suggest("엔비")] = {
      available: true, items: [{ key: "us:NVDA", kind: "company", name: "엔비디아", sub: "NVDA · 미국", source: "sec" }],
    };
    renderScreen();
    const input = screen.getByRole("combobox", { name: "대상 검색" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "엔비" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(screen.getByRole("option", { name: /엔비디아/ })).toBeTruthy();
    expect(input.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(input, { key: "Enter" });
    expect(window.location.search).toBe(`?q=${encodeURIComponent("엔비")}`);
  });

  it("후보를 ↓로 고른 뒤 Enter면 그 대상", async () => {
    vi.useFakeTimers();
    reads[endpoints.search.suggest("엔비")] = {
      available: true, items: [{ key: "us:NVDA", kind: "company", name: "엔비디아", sub: "NVDA · 미국", source: "sec" }],
    };
    renderScreen();
    const input = screen.getByRole("combobox", { name: "대상 검색" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "엔비" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(window.location.search).toBe("?e=us:NVDA&tab=timeline&range=30d");
  });

  it("후보가 여럿(동명이인)이면 목록만 — 고르면 그 대상, 맨 끝은 주제로 찾기", async () => {
    reads[endpoints.search.resolve("Ken Griffin")] = {
      available: true,
      items: [
        { key: "wd:Q3195170", kind: "person", name: "Ken Griffin", sub: "헤지펀드 운용자", source: "wikidata" },
        { key: "wd:Q999", kind: "person", name: "Ken Griffin", sub: "야구 선수", source: "wikidata" },
        { key: "topic:Ken Griffin", kind: "topic", name: "Ken Griffin", sub: null, source: "topic" },
      ],
      errors: { dart: "키 없음" },
    };
    renderScreen(MEMBER, `/search?q=${encodeURIComponent("Ken Griffin")}`);
    const list = await screen.findByRole("list", { name: "후보" });
    const buttons = within(list).getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons[2].textContent).toContain("주제");
    expect(window.location.search).toBe(`?q=${encodeURIComponent("Ken Griffin")}`);
    // 후보의 출처 이름으로(결과 탭의 'DART 공시'가 아니라 고유번호 표 — 단계 4에서 sourceLabel에 공시 출처 이름이 생김)
    expect(screen.getByText(/DART: 키 없음/)).toBeTruthy();

    fireEvent.click(buttons[0]);
    expect(window.location.search).toBe("?e=wd:Q3195170&tab=timeline&range=30d");
  });

  it("주제를 뺀 후보가 하나이고 이름이 입력과 같으면 바로 연다 — 후보 보기 자리를 바꿔 씀", async () => {
    reads[endpoints.search.resolve("NVIDIA")] = {
      available: true,
      items: [
        { key: "us:NVDA", kind: "company", name: "NVIDIA", sub: "NVDA · 미국", source: "sec" },
        { key: "topic:NVIDIA", kind: "topic", name: "NVIDIA", sub: null, source: "topic" },
      ],
    };
    const push = vi.spyOn(window.history, "pushState");
    renderScreen(MEMBER, "/search?q=NVIDIA");
    await waitFor(() => expect(window.location.search).toBe("?e=us:NVDA&tab=timeline&range=30d"));
    expect(push).not.toHaveBeenCalled();
  });

  it("키가 없는 후보(거장 이름 등)를 고르면 그 이름으로 다시 푼다", async () => {
    reads[endpoints.search.resolve("드러켄밀러")] = {
      available: true,
      items: [
        { key: null, kind: "person", name: "Stanley Druckenmiller", sub: "거장", source: "guru" },
        { key: "topic:드러켄밀러", kind: "topic", name: "드러켄밀러", sub: null, source: "topic" },
      ],
    };
    renderScreen(MEMBER, `/search?q=${encodeURIComponent("드러켄밀러")}`);
    fireEvent.click(await screen.findByRole("button", { name: /Stanley Druckenmiller/ }));
    expect(window.location.search).toBe(`?q=${encodeURIComponent("Stanley Druckenmiller")}`);
  });
});

describe("대상 화면 — 빈 결과", () => {
  it("2년 안에 자료가 없으면 그 안내", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed({ items: [], rangeCounts: { "7d": 0, "30d": 0, "1y": 0, "2y": 0 }, sources: [] });
    renderScreen(MEMBER, "/search?e=us:NVDA");
    expect(await screen.findByText("최근 2년 안의 자료가 없습니다")).toBeTruthy();
    expect(screen.queryByText(/가장 최근 자료/)).toBeNull();
  });

  it("2년보다 오래된 것만 있었으면 가장 최근 날짜를 함께(그 줄은 보이지 않음)", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed({
      items: [], rangeCounts: { "7d": 0, "30d": 0, "1y": 0, "2y": 0 }, olderOnlyLatest: "2023-05-02",
    });
    renderScreen(MEMBER, "/search?e=us:NVDA");
    expect(await screen.findByText("최근 2년 안의 자료가 없습니다")).toBeTruthy();
    expect(screen.getByText("가장 최근 자료: 2023-05-02")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("출처가 모두 실패하면 '없다'고 하지 않고 모른다고 — 실패한 출처를 이름으로 적는다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed({
      items: [], rangeCounts: { "7d": 0, "30d": 0, "1y": 0, "2y": 0 },
      sources: [
        { source: "google_en", label: "구글 뉴스(영어)", status: "error", count: 0, dropped: null, message: "HTTP 503" },
        { source: "bing", label: "Bing 뉴스", status: "error", count: 0, dropped: null, message: "HTTP 429" },
      ],
    });
    renderScreen(MEMBER, "/search?e=us:NVDA");
    expect(await screen.findByText("받은 출처가 없어 최근 2년 안의 자료가 있는지 모릅니다")).toBeTruthy();
    expect(screen.queryByText("최근 2년 안의 자료가 없습니다")).toBeNull();
    expect(screen.getByText(/받지 못한 출처가 있습니다\(구글 뉴스\(영어\) · Bing 뉴스\)/)).toBeTruthy();
  });

  it("대상을 풀지 못해 출처를 부르지 않았으면(모두 건너뜀) 모른다고", async () => {
    reads[endpoints.search.entity("topic:없는말")] = { available: true, entity: null, errors: {} };
    const skipped = (source: string, label: string) => ({ source, label, status: "skipped", count: 0, dropped: null, message: "대상을 풀지 못해 묻지 않음" });
    reads[endpoints.search.feed("topic:없는말", "timeline")] = feed({
      entityKey: "topic:없는말", items: [], rangeCounts: { "7d": 0, "30d": 0, "1y": 0, "2y": 0 },
      sources: [skipped("google_ko", "구글 뉴스(한국어)"), skipped("bing", "Bing 뉴스"), skipped("event_news", "사건 뉴스(저장본)")],
    });
    renderScreen(MEMBER, `/search?e=${encodeURIComponent("topic:없는말")}`);
    expect(await screen.findByText("받은 출처가 없어 최근 2년 안의 자료가 있는지 모릅니다")).toBeTruthy();
    expect(screen.queryByText("최근 2년 안의 자료가 없습니다")).toBeNull();
  });

  it("외부 조회를 하지 않은 응답(데모·저장본만)은 저장본만 찾았다고 덧붙인다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed({
      items: [], rangeCounts: { "7d": 0, "30d": 0, "1y": 0, "2y": 0 },
      sources: [
        { source: "google_en", label: "구글 뉴스(영어)", status: "offline", count: 0, dropped: null, message: null },
        { source: "event_news", label: "사건 뉴스(저장본)", status: "empty", count: 0, dropped: null, message: null },
      ],
    });
    renderScreen(MEMBER, "/search?e=us:NVDA");
    expect(await screen.findByText("최근 2년 안의 자료가 없습니다")).toBeTruthy();
    expect(screen.getByText(/외부 출처는 부르지 않았습니다\(저장본만 찾음\)/)).toBeTruthy();
  });

  it("고른 기간에 없으면 더 넓은 기간 단추(건수와 함께) — 누르면 그 기간으로(다시 부르지 않음)", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed({
      items: [row({ id: "old", title: "반년 전 기사", publishedAt: "2026-05-01T00:00:00+00:00" })],
      rangeCounts: { "7d": 0, "30d": 0, "1y": 1, "2y": 1 },
    });
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=timeline&range=30d");
    expect(await screen.findByText("이 기간에는 자료가 없습니다")).toBeTruthy();
    const before = sharedCalls().filter((path) => path.startsWith("/api/search/feed")).length;
    fireEvent.click(screen.getByRole("button", { name: "1년으로 넓히기 (1건)" }));
    expect(window.location.search).toBe("?e=us:NVDA&tab=timeline&range=1y");
    expect(await screen.findByRole("option", { name: /반년 전 기사/ })).toBeTruthy();
    expect(sharedCalls().filter((path) => path.startsWith("/api/search/feed")).length).toBe(before);
  });
});

describe("대상 화면 — 결과", () => {
  beforeEach(() => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed();
    reads[endpoints.search.feed("us:NVDA", "news")] = feed({ tab: "news" });
    reads[endpoints.search.feed("us:NVDA", "posts")] = feed({ tab: "posts" });
  });

  it("머리 — 종류·이름·식별자·별칭, 종목 상세 바로가기(차트·시세 없음)", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA");
    expect(await screen.findByRole("heading", { level: 2, name: "엔비디아" })).toBeTruthy();
    expect(screen.getByText("NVDA · 미국")).toBeTruthy();
    expect(screen.getAllByText("NVIDIA").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "종목 상세" }).getAttribute("href")).toBe("/s/us/NVDA");
  });

  it("출처 상태 줄 — 실패한 출처를 글로 적고(색만이 아님), 뺀 건수도", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA");
    const status = await screen.findByRole("list", { name: "출처 상태" });
    const bing = within(status).getByText("Bing 뉴스").closest("li") as HTMLElement;
    expect(bing.textContent).toContain("실패");
    expect(bing.textContent).toContain("HTTP 503");
    const google = within(status).getByText("구글 뉴스(영어)").closest("li") as HTMLElement;
    expect(google.textContent).toContain("받음");
    expect(google.textContent).toContain("2건");
    expect(google.textContent).toContain("2년 밖 4건");
  });

  it("KST 날짜로 묶고, 받은 시각으로 넣은 줄에는 '받은 시각'", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA");
    const list = await screen.findByRole("listbox", { name: "결과" });
    expect(within(list).getByText("2026-11-14 (토)")).toBeTruthy();
    expect(within(list).getByText("2026-11-13 (금)")).toBeTruthy();
    const second = within(list).getByRole("option", { name: /둘째 기사/ });
    expect(second.textContent).toContain("받은 시각");
    expect(within(list).getByRole("option", { name: /첫째 기사/ }).textContent).not.toContain("받은 시각");
    expect(within(list).getByRole("option", { name: /첫째 기사/ }).textContent).toContain("09:30");
  });

  it("↑↓로 줄을 옮기고 고른 줄은 미리 보기, Enter는 원문을 새 창으로(http 주소만)", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderScreen(MEMBER, "/search?e=us:NVDA");
    const list = await screen.findByRole("listbox", { name: "결과" });
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    const first = within(list).getByRole("option", { name: /첫째 기사/ });
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(first.id);
    const preview = screen.getByRole("region", { name: "미리 보기" });
    expect(within(preview).getByText("첫째 요약")).toBeTruthy();

    fireEvent.keyDown(list, { key: "Enter" });
    expect(open).toHaveBeenCalledWith("https://news.example/a", "_blank", "noopener,noreferrer");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(within(list).getByRole("option", { name: /둘째 기사/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("회원 — 글·논평 탭이 없고, 주소로 줘도 그 경로를 부르지 않으며, 원문 팝업 단추도 없다", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=posts");
    const tabs = await screen.findByRole("tablist", { name: "결과 탭" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["타임라인", "뉴스", "공시", "리서치", "보유", "연결"]);
    expect(within(tabs).getByRole("tab", { name: "타임라인" }).getAttribute("aria-selected")).toBe("true");
    await screen.findByRole("listbox", { name: "결과" });
    expect(sharedCalls().some((path) => path.includes("tab=posts"))).toBe(false);

    fireEvent.click(screen.getByRole("option", { name: /수집 글 하나/ }));
    expect(screen.queryByRole("button", { name: /받아 둔 글 보기/ })).toBeNull();
  });

  it("운영자 — 글·논평 탭이 있고, 수집 글은 원문 팝업(어두운 범위 표지)으로 연다", async () => {
    reads[endpoints.info.item("0123456789abcdef01234567")] = {
      available: true, item: { id: "0123456789abcdef01234567", body: "받아 둔 본문", summary: null },
    };
    renderScreen(OWNER, "/search?e=us:NVDA&tab=posts");
    const tabs = await screen.findByRole("tablist", { name: "결과 탭" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["타임라인", "뉴스", "공시", "리서치", "글·논평", "보유", "연결"]);
    expect(within(tabs).getByRole("tab", { name: "글·논평" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(sharedCalls()).toContain(endpoints.search.feed("us:NVDA", "posts")));

    fireEvent.click(await screen.findByRole("option", { name: /수집 글 하나/ }));
    fireEvent.click(screen.getByRole("button", { name: /받아 둔 글 보기/ }));
    const dialog = await screen.findByRole("dialog", { name: "수집 글 하나" });
    expect(dialog.getAttribute("data-scope")).toBe("search");
    expect(await within(dialog).findByText("받아 둔 본문")).toBeTruthy();
  });

  it("탭을 바꾸면 주소를 바꿔 쓰고(기록에 쌓지 않음) 그 탭의 결과를 한 번 부른다", async () => {
    const push = vi.spyOn(window.history, "pushState");
    renderScreen(MEMBER, "/search?e=us:NVDA");
    fireEvent.click(await screen.findByRole("tab", { name: "뉴스" }));
    expect(window.location.search).toBe("?e=us:NVDA&tab=news&range=30d");
    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(sharedCalls()).toContain(endpoints.search.feed("us:NVDA", "news")));
  });

  it("받는 중인 출처가 있으면 그렇다고 적는다", async () => {
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed({ pending: true });
    renderScreen(MEMBER, "/search?e=us:NVDA");
    expect(await screen.findByText(/받는 중인 출처가 있어/)).toBeTruthy();
  });

  it("거르기 — 종류별 건수(받은 자료 기준), 끄면 그 줄이 빠진다", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    const filters = screen.getByRole("region", { name: "거르기" });
    expect(within(filters).getByText(/받은 자료 기준/)).toBeTruthy();
    const postBox = within(filters).getByRole("checkbox", { name: "글 1건" });
    fireEvent.click(postBox);
    expect(screen.queryByRole("option", { name: /수집 글 하나/ })).toBeNull();
    expect(screen.getByRole("option", { name: /첫째 기사/ })).toBeTruthy();
  });
});

describe("대상 화면 — 보유·연결", () => {
  beforeEach(() => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
  });

  it("보유 — 회사는 13F 보유 기관(영문 이름으로), 가장 최근 보고가 2년보다 오래면 안내만", async () => {
    reads[endpoints.institution.guruHolders("NVIDIA")] = {
      available: true, query: "NVIDIA",
      rows: [{ institution: "버크셔 (Berkshire)", cik: "0001067983", name: "NVIDIA CORP", cusip: "x", weight: 1.2, value: 1000, reportDate: "2023-12-31" }],
    };
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=holdings");
    expect(await screen.findByText("최근 2년 안의 자료가 없습니다")).toBeTruthy();
    expect(screen.getByText("가장 최근 자료: 2023-12-31")).toBeTruthy();
    expect(screen.queryByText("NVIDIA CORP")).toBeNull();
    expect(sharedCalls().some((path) => path.startsWith("/api/search/feed"))).toBe(false);
  });

  it("연결 — 관계별로, 키가 있으면 그 대상으로, 없으면 그 이름으로 찾는다", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    fireEvent.click(await screen.findByRole("button", { name: /Mellanox/ }));
    expect(window.location.search).toBe("?e=wd:Q100&tab=timeline&range=30d");
  });

  it("연결 — 키 없는 대상은 이름으로 다시 풂", async () => {
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=links");
    expect(await screen.findByText("창업자")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Jensen Huang/ }));
    expect(window.location.search).toBe(`?q=${encodeURIComponent("Jensen Huang")}`);
  });
});
