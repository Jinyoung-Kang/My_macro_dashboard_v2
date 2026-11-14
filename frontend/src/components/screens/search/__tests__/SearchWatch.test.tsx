/**
 * 정보 검색 단계 3(계약 §6 — ADR 0041 결정 8·9). 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *  - 첫 화면: 내 관심 대상(이름·종류·마지막으로 본 뒤 새 글 수)과 새 피드 묶음의 최근 글, 정기 수집이 꺼진 곳이면 그렇다고
 *  - 대상 머리의 등록·해제 단추: 대표 키로 등록, 상한(409)은 서버 사유를 글로, 데모는 등록하지 못함
 *  - 관심 대상의 타임라인을 열면 '봤음'을 한 번만 보냄
 *  - '지금 새로 받기'는 refresh=1로 부르고 그 결과를 보임
 *  - 매체 제외 목록: 운영자는 더하고 지우고, 회원은 읽기만
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { DEMO_READ_ONLY } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };
const DEMO: SessionUser = { email: "demo@test.local", role: "MEMBER", tier: "FREE", demo: true };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: null,
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477" },
  links: [], sources: ["sec", "wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "headline", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "feeds", lang: "en", summary: null, readerId: null, ...over,
  };
}

const WATCH_NVDA = { id: 7, key: "us:NVDA", kind: "company", name: "엔비디아", createdAt: "2026-11-10T00:00:00+00:00", lastSeenAt: "2026-11-13T00:00:00+00:00", newCount: 3 };
const WATCH_BRK = { id: 8, key: "cik:0001067983", kind: "institution", name: "버크셔 해서웨이", createdAt: "2026-11-10T00:00:00+00:00", lastSeenAt: null, newCount: 0 };

/** 합성 관심 대상 n개(주제). */
function manyWatches(count: number) {
  return Array.from({ length: count }, (_, at) => ({ ...WATCH_BRK, id: 100 + at, key: `topic:합성 주제 ${at}`, kind: "topic", name: `합성 주제 ${at}` }));
}

/**
 * 관심 대상 목록의 스크롤 영역 — 높이 상한·세로 스크롤·Tab으로 닿음(jsdom은 배치를 재지 않아 클래스로 확인).
 * 상한은 min(28dvh, 14rem) — 4단계 브라우저 확인에서 40dvh·24rem이면 50개일 때 대상 화면의 거르기(1440x900에서 y≈934)와 첫 화면의
 * 최근 글(390)이 여전히 첫 화면 밖이었습니다.
 */
function expectBoundedScroll(region: HTMLElement) {
  expect(region.getAttribute("tabindex")).toBe("0");
  expect(region.className).toContain("overflow-y-auto");
  expect(region.className).toMatch(/max-h-\[min\(28dvh,14rem\)\]/);
  expect(region.className).not.toMatch(/max-h-\[min\(40dvh/);
}

function watchList(items: unknown[], over: Record<string, unknown> = {}) {
  return { available: true, items, limits: { mine: items.length, max: 10, serverUsed: 5, serverMax: 100 }, collecting: false, ...over };
}

function feed(over: Record<string, unknown> = {}) {
  return {
    available: true, entityKey: "us:NVDA", tab: "timeline",
    items: [row({ id: "f1", title: "연준 보도자료 한 줄", source: "feeds", publisher: "Federal Reserve" })],
    sources: [{ source: "feeds", label: "보도자료·경제지 피드", status: "ok", count: 1, dropped: null, message: null }],
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 1, "30d": 1, "1y": 1, "2y": 1 },
    olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00", ...over,
  };
}

/** 경로 → 응답(값이 함수면 부를 때마다 계산). 정확히 같은 경로가 먼저, 그다음 긴 앞부분. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = path in reads ? path : Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  if (!hit) return new Promise(() => {});
  const value = reads[hit];
  return Promise.resolve(typeof value === "function" ? (value as () => unknown)() : value);
}
const sharedCalls = () => api.apiGetShared.mock.calls.map(([path]) => String(path));
const postCalls = () => api.apiPost.mock.calls.map(([path, body]) => [String(path), body]);

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
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  api.apiPost.mockResolvedValue({ ok: true });
  api.apiDelete.mockResolvedValue({ ok: true });
});
afterEach(() => cleanup());

describe("첫 화면 — 관심 대상과 최근 글", () => {
  it("관심 대상은 이름·종류·새 글 수(1건 이상만), 정기 수집이 꺼진 곳이면 서버에서만 돈다고 — 누르면 그 대상", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_NVDA, WATCH_BRK]);
    reads[endpoints.search.recent] = { available: true, items: [], fetchedAt: "2026-11-14T01:00:00+00:00" };
    renderScreen();
    const list = await screen.findByRole("list", { name: "관심 대상 목록" });
    const nvidia = within(list).getByRole("button", { name: /엔비디아/ });
    expect(nvidia.textContent).toContain("기업");
    expect(nvidia.textContent).toContain("새 글 3");
    const berkshire = within(list).getByRole("button", { name: /버크셔 해서웨이/ });
    expect(berkshire.textContent).toContain("기관");
    expect(berkshire.textContent).not.toContain("새 글");
    expect(screen.getByText(/정기 수집은 서버에서만 돕니다/)).toBeTruthy();
    expect(screen.getByText("내 목록 2 / 10 · 서버 전체 5 / 100")).toBeTruthy();

    fireEvent.click(nvidia);
    expect(window.location.search).toBe("?e=us:NVDA&tab=timeline&range=30d");
  });

  it("정기 수집이 켜진 곳(서버)에서는 그 안내가 없다", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_NVDA], { collecting: true });
    reads[endpoints.search.recent] = { available: true, items: [], fetchedAt: null };
    renderScreen();
    await screen.findByRole("list", { name: "관심 대상 목록" });
    expect(screen.queryByText(/정기 수집은 서버에서만 돕니다/)).toBeNull();
  });

  it("최근 글 — 새 피드 묶음의 글을 KST 날짜로 묶어 시각·매체·제목(원문 새 창, http만), 받은 시각으로 넣은 줄은 그렇다고", async () => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.recent] = {
      available: true,
      items: [
        row({ id: "a", title: "ECB 보도자료", publisher: "European Central Bank", url: "https://www.ecb.europa.eu/x", publishedAt: "2026-11-14T00:30:00+00:00" }),
        row({ id: "b", title: "Nikkei 기사", publisher: "Nikkei Asia", url: "javascript:alert(1)", publishedAt: "2026-11-13T10:00:00+00:00", timeBasis: "fetched" }),
      ],
      fetchedAt: "2026-11-14T01:00:00+00:00",
    };
    renderScreen();
    const recent = await screen.findByRole("list", { name: "최근 글" });
    expect(within(recent).getByText("2026-11-14 (토)")).toBeTruthy();
    const link = within(recent).getByRole("link", { name: /ECB 보도자료/ });
    expect(link.getAttribute("href")).toBe("https://www.ecb.europa.eu/x");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(within(recent).getByText("09:30")).toBeTruthy();
    expect(within(recent).getByText("European Central Bank")).toBeTruthy();
    // javascript: 주소는 링크로 두지 않음
    expect(within(recent).queryByRole("link", { name: /Nikkei 기사/ })).toBeNull();
    expect(within(recent).getByText("Nikkei 기사")).toBeTruthy();
    expect(within(recent).getByText("받은 시각")).toBeTruthy();
    // 등록한 대상이 없으면 어떻게 등록하는지
    expect(screen.getByText(/등록한 관심 대상이 없습니다/)).toBeTruthy();
  });

  it("최근 글이 없으면 그렇다고(0건으로 채우지 않음), 받지 못했으면 사유", async () => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.recent] = { available: false, message: "수집기에서 응답을 받지 못했습니다." };
    renderScreen();
    expect(await screen.findByText("수집기에서 응답을 받지 못했습니다.")).toBeTruthy();
  });

  it("저장본을 읽지 못했으면(errors) '없음'이 아니라 모른다고 — 그 출처와 사유", async () => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.recent] = { available: true, items: [], errors: { feeds: "저장소를 읽지 못함(QueryCanceled)" }, fetchedAt: "2026-11-14T01:00:00+00:00" };
    renderScreen();
    expect(await screen.findByText(/보도자료·경제지 피드 — 저장소를 읽지 못함\(QueryCanceled\)/)).toBeTruthy();
    expect(screen.getByText(/최근 글이 있는지 모릅니다/)).toBeTruthy();
    expect(screen.queryByText(/아직 받은 글이 없습니다/)).toBeNull();
  });

  it("일부만 읽지 못했으면(운영자의 속보) 받은 글과 함께 읽지 못한 출처를 적는다", async () => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.recent] = {
      available: true,
      items: [row({ id: "a", title: "ECB 보도자료" })],
      errors: { wire: "저장소를 읽지 못함(OperationalError)" },
      fetchedAt: "2026-11-14T01:00:00+00:00",
    };
    renderScreen(OWNER);
    const recent = await screen.findByRole("list", { name: "최근 글" });
    expect(within(recent).getByText("ECB 보도자료")).toBeTruthy();
    expect(screen.getByText(/속보 — 저장소를 읽지 못함\(OperationalError\)/)).toBeTruthy();
  });

  it("관심 대상이 많아도(상한 50) 목록은 제 높이 안에서 스크롤한다 — 키보드로 닿는 이름 있는 영역, 최근 글을 밀어내지 않음", async () => {
    reads[endpoints.search.watch] = watchList(manyWatches(50), { limits: { mine: 50, max: 50, serverUsed: 50, serverMax: 100 } });
    reads[endpoints.search.recent] = { available: true, items: [], fetchedAt: null };
    renderScreen(OWNER);
    const region = await screen.findByRole("region", { name: "관심 대상 목록 (위아래 스크롤)" });
    expectBoundedScroll(region);
    expect(within(within(region).getByRole("list", { name: "관심 대상 목록" })).getAllByRole("button")).toHaveLength(50);
    // 목록 아래 상한 한 줄은 스크롤 영역 밖(늘 보임)
    expect(within(region).queryByText("내 목록 50 / 50 · 서버 전체 50 / 100")).toBeNull();
    expect(screen.getByText("내 목록 50 / 50 · 서버 전체 50 / 100")).toBeTruthy();
  });
});

describe("대상 화면의 관심 대상 칸", () => {
  beforeEach(() => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "news")] = feed({ tab: "news" });
  });

  it("목록은 제 높이 안에서 스크롤한다 — 거르기(기간·종류·출처)를 밀어내지 않음", async () => {
    reads[endpoints.search.watch] = watchList(manyWatches(50));
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=news");
    const region = await screen.findByRole("region", { name: "관심 대상 목록 (위아래 스크롤)" });
    expectBoundedScroll(region);
    expect(within(region).getAllByRole("button")).toHaveLength(50);
    expect(within(region).queryByRole("group", { name: "기간" })).toBeNull();
  });

  it("좁은 화면의 접힌 서랍 머리에 새 글 수 합계 — 모르는 수(null)는 0으로도 세지 않고, 합계가 없으면 붙이지 않음", async () => {
    reads[endpoints.search.watch] = watchList([
      WATCH_NVDA,
      { ...WATCH_BRK, newCount: 2 },
      { ...WATCH_BRK, id: 9, key: "topic:HBM", kind: "topic", name: "HBM", newCount: null },
    ]);
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=news");
    const header = await screen.findByRole("button", { name: "관심 대상 3 · 새 글 5" });
    expect(header.getAttribute("aria-expanded")).toBe("false");
  });

  it("새 글이 없으면 머리는 개수만", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_BRK, { ...WATCH_BRK, id: 9, key: "topic:HBM", kind: "topic", name: "HBM", newCount: null }]);
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=news");
    expect(await screen.findByRole("button", { name: "관심 대상 2" })).toBeTruthy();
  });
});

describe("등록·해제(대상 머리)", () => {
  beforeEach(() => {
    reads[endpoints.search.entity("wd:Q182477")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("wd:Q182477", "timeline")] = feed({ entityKey: "wd:Q182477" });
  });

  it("등록 — 대표 키(풀린 대상의 key)로 보내고 목록을 다시 읽어 해제 단추가 된다", async () => {
    let registered = false;
    reads[endpoints.search.watch] = () => watchList(registered ? [WATCH_BRK, { ...WATCH_NVDA, newCount: 0 }] : [WATCH_BRK]);
    api.apiPost.mockImplementation(async (path: string) => {
      if (path === endpoints.search.watch) registered = true;
      return { ok: true };
    });
    renderScreen(MEMBER, "/search?e=wd:Q182477");
    await screen.findByRole("heading", { level: 2, name: "엔비디아" });
    const add = await screen.findByRole("button", { name: "관심 대상 등록" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    expect(await screen.findByRole("button", { name: "관심 대상 해제" })).toBeTruthy();
    expect(postCalls()).toContainEqual([endpoints.search.watch, { key: "us:NVDA" }]);
    expect(sharedCalls().filter((path) => path === endpoints.search.watch).length).toBeGreaterThanOrEqual(2);
  });

  it("해제 — 그 줄의 번호로 지운다", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_NVDA]);
    renderScreen(MEMBER, "/search?e=wd:Q182477");
    fireEvent.click(await screen.findByRole("button", { name: "관심 대상 해제" }));
    await waitFor(() => expect(api.apiDelete).toHaveBeenCalledWith(endpoints.search.watchItem(7)));
  });

  it("상한(409)이면 서버가 준 사유를 글로 보이고, 목록은 그대로", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_BRK]);
    api.apiPost.mockRejectedValue(Object.assign(new Error("관심 대상은 회원 10개까지입니다 — 하나를 지운 뒤 다시 등록하세요"), { status: 409 }));
    renderScreen(MEMBER, "/search?e=wd:Q182477");
    await screen.findByRole("heading", { level: 2, name: "엔비디아" });
    const add = await screen.findByRole("button", { name: "관심 대상 등록" });
    await waitFor(() => expect((add as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(add);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("관심 대상은 회원 10개까지입니다 — 하나를 지운 뒤 다시 등록하세요");
    expect(screen.getByRole("button", { name: "관심 대상 등록" })).toBeTruthy();
  });

  it("데모는 등록하지 못한다 — 단추가 꺼져 있고 조회만 된다는 글, 관심 대상을 부르지도 쓰지도 않음", async () => {
    renderScreen(DEMO, "/search?e=wd:Q182477");
    await screen.findByRole("heading", { level: 2, name: "엔비디아" });
    const add = screen.getByRole("button", { name: "관심 대상 등록" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(screen.getAllByText(new RegExp(DEMO_READ_ONLY)).length).toBeGreaterThan(0);
    fireEvent.click(add);
    expect(api.apiPost).not.toHaveBeenCalled();
    expect(sharedCalls()).not.toContain(endpoints.search.watch);
  });
});

describe("봤음(새 글 수 지우기)", () => {
  beforeEach(() => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed();
    reads[endpoints.search.feed("us:NVDA", "news")] = feed({ tab: "news" });
  });

  it("관심 대상의 타임라인을 열면 한 번만 보낸다 — 목록을 다시 읽어도 또 보내지 않음", async () => {
    let seen = false;
    reads[endpoints.search.watch] = () => watchList([{ ...WATCH_NVDA, newCount: seen ? 0 : 3 }]);
    api.apiPost.mockImplementation(async (path: string) => {
      if (path === endpoints.search.watchSeen(7)) seen = true;
      return { ok: true };
    });
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await waitFor(() => expect(postCalls()).toContainEqual([endpoints.search.watchSeen(7), undefined]));
    // 다시 읽은 목록(새 글 0)이 그려질 때까지 기다린 뒤에도 한 번
    await waitFor(() => expect(sharedCalls().filter((path) => path === endpoints.search.watch).length).toBeGreaterThanOrEqual(2));
    const list = await screen.findByRole("list", { name: "관심 대상 목록" });
    await waitFor(() => expect(within(list).getByRole("button", { name: /엔비디아/ }).textContent).not.toContain("새 글"));
    expect(postCalls().filter(([path]) => path === endpoints.search.watchSeen(7))).toHaveLength(1);
  });

  it("다른 탭으로 열면 보내지 않고, 타임라인으로 바꾸면 그때 한 번", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_NVDA]);
    renderScreen(MEMBER, "/search?e=us:NVDA&tab=news");
    await screen.findByRole("list", { name: "관심 대상 목록" });
    await screen.findByRole("listbox", { name: "결과" });
    expect(postCalls().filter(([path]) => path === endpoints.search.watchSeen(7))).toHaveLength(0);
    fireEvent.click(screen.getByRole("tab", { name: "타임라인" }));
    await waitFor(() => expect(postCalls().filter(([path]) => path === endpoints.search.watchSeen(7))).toHaveLength(1));
  });

  it("타임라인 결과를 받지 못했으면(수집기 응답 없음) 보내지 않는다 — 보지 못한 새 글 수를 남김", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_NVDA]);
    reads[endpoints.search.feed("us:NVDA", "timeline")] = { available: false, message: "수집기에서 결과를 받지 못했습니다." };
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByText("수집기에서 결과를 받지 못했습니다.");
    const list = await screen.findByRole("list", { name: "관심 대상 목록" });
    expect(within(list).getByRole("button", { name: /엔비디아/ }).textContent).toContain("새 글 3");
    expect(postCalls().filter(([path]) => path === endpoints.search.watchSeen(7))).toHaveLength(0);
  });

  it("타임라인을 받는 중에는 보내지 않고, 받아 보인 뒤에 한 번", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_NVDA]);
    let release: (value: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    reads[endpoints.search.feed("us:NVDA", "timeline")] = () => pending;
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("list", { name: "관심 대상 목록" });
    await screen.findByText(/결과를 모으는 중/);
    expect(postCalls().filter(([path]) => path === endpoints.search.watchSeen(7))).toHaveLength(0);
    release(feed());
    await screen.findByRole("option", { name: /연준 보도자료 한 줄/ });
    await waitFor(() => expect(postCalls().filter(([path]) => path === endpoints.search.watchSeen(7))).toHaveLength(1));
  });

  it("관심 대상이 아니면 보내지 않는다", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_BRK]);
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    await screen.findByRole("list", { name: "관심 대상 목록" });
    expect(api.apiPost).not.toHaveBeenCalled();
  });
});

describe("지금 새로 받기", () => {
  it("refresh=1로 부르고 그 결과를 그린다 — 서버가 준 한 줄(10분 상한 등)을 보인다", async () => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed();
    reads[endpoints.search.feed("us:NVDA", "timeline", true)] = feed({
      items: [row({ id: "n1", title: "방금 받은 기사", source: "google_en", kind: "news" })],
      refreshNote: "10분에 한 번만 새로 받습니다 — 다음은 10:10 KST부터",
      fetchedAt: "2026-11-14T01:05:00+00:00",
    });
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("option", { name: /연준 보도자료 한 줄/ });
    fireEvent.click(screen.getByRole("button", { name: "지금 새로 받기" }));
    expect(await screen.findByRole("option", { name: /방금 받은 기사/ })).toBeTruthy();
    expect(api.apiGet).toHaveBeenCalledWith(endpoints.search.feed("us:NVDA", "timeline", true));
    expect(screen.getByText("10분에 한 번만 새로 받습니다 — 다음은 10:10 KST부터")).toBeTruthy();
  });

  it("새로 받은 응답에 받지 못한 출처가 있으면 '새로 받았습니다' 줄에 그렇다고 붙인다", async () => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed();
    reads[endpoints.search.feed("us:NVDA", "timeline", true)] = feed({
      items: [row({ id: "n1", title: "방금 받은 기사", source: "google_en", kind: "news" })],
      sources: [
        { source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 1, dropped: null, message: null },
        { source: "gdelt", label: "GDELT", status: "error", count: null, dropped: null, message: "시간 초과" },
      ],
      fetchedAt: "2026-11-14T01:05:00+00:00",
    });
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("option", { name: /연준 보도자료 한 줄/ });
    fireEvent.click(screen.getByRole("button", { name: "지금 새로 받기" }));
    await screen.findByRole("option", { name: /방금 받은 기사/ });
    expect(screen.getByText("새로 받았습니다 — 받은 시각 2026-11-14 10:05 KST — 일부 출처는 받지 못함(아래 출처 상태)")).toBeTruthy();
  });

  it("새로 받기가 수집기에 닿지 못하면(available:false) 보이던 결과와 단추를 그대로 두고 실패를 상태 영역에 알린다", async () => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed();
    reads[endpoints.search.feed("us:NVDA", "timeline", true)] = { available: false, message: "수집기에서 응답을 받지 못했습니다.", refreshNote: null };
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("option", { name: /연준 보도자료 한 줄/ });
    fireEvent.click(screen.getByRole("button", { name: "지금 새로 받기" }));
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("새로 받지 못했습니다 — 수집기에서 응답을 받지 못했습니다."))).toBe(true),
    );
    expect(screen.getByRole("option", { name: /연준 보도자료 한 줄/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "지금 새로 받기" })).toBeTruthy();
  });

  it("새로 받기 요청이 실패하면 그 사유를 상태 영역(낭독기가 읽는 곳)에 둔다", async () => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed();
    reads[endpoints.search.feed("us:NVDA", "timeline", true)] = () => Promise.reject(new Error("요청 시간이 지났습니다"));
    renderScreen(MEMBER, "/search?e=us:NVDA");
    await screen.findByRole("option", { name: /연준 보도자료 한 줄/ });
    fireEvent.click(screen.getByRole("button", { name: "지금 새로 받기" }));
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((el) => el.textContent?.includes("새로 받지 못했습니다 — 요청 시간이 지났습니다"))).toBe(true),
    );
  });

  it("데모에는 단추가 없다(외부를 부르지 않는 열람)", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed();
    renderScreen(DEMO, "/search?e=us:NVDA");
    await screen.findByRole("option", { name: /연준 보도자료 한 줄/ });
    expect(screen.queryByRole("button", { name: "지금 새로 받기" })).toBeNull();
  });
});

describe("매체 제외 목록", () => {
  const EXCLUDES = {
    available: true,
    seed: [
      { kind: "domain", value: "xinhuanet.com", group: "중국 국가·당 매체" },
      { kind: "domain", value: "rthk.hk", group: "홍콩" },
    ],
    added: [{ id: 3, kind: "name", value: "Some Media", note: "사용자 추가", createdAt: "2026-11-14T01:00:00+00:00" }],
  };

  beforeEach(() => {
    reads[endpoints.search.watch] = watchList([]);
    reads[endpoints.search.recent] = { available: true, items: [], fetchedAt: null };
    reads[endpoints.search.excludes] = EXCLUDES;
  });

  it("운영자 — 처음 값(묶음별)과 더한 것을 보고, 도메인은 소문자 호스트로 더하고, 더한 것을 지운다", async () => {
    renderScreen(OWNER);
    const toggle = await screen.findByRole("button", { name: /매체 제외 목록/ });
    expect(sharedCalls()).not.toContain(endpoints.search.excludes);   // 펼칠 때만 읽음
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("xinhuanet.com")).toBeTruthy();
    expect(screen.getByText("중국 국가·당 매체")).toBeTruthy();
    const added = screen.getByRole("list", { name: "더한 제외 매체" });
    expect(within(added).getByText("Some Media")).toBeTruthy();
    expect(within(added).getByText(/사용자 추가/)).toBeTruthy();

    const form = screen.getByRole("form", { name: "제외 매체 더하기" });
    fireEvent.change(within(form).getByLabelText("종류"), { target: { value: "domain" } });
    fireEvent.change(within(form).getByLabelText("값"), { target: { value: "https://News.Example.COM/path" } });
    fireEvent.click(within(form).getByRole("button", { name: "더하기" }));
    await waitFor(() =>
      expect(postCalls()).toContainEqual([endpoints.search.excludes, { kind: "domain", value: "news.example.com", note: null }]),
    );

    fireEvent.click(within(added).getByRole("button", { name: "Some Media 지우기" }));
    await waitFor(() => expect(api.apiDelete).toHaveBeenCalledWith(endpoints.search.exclude(3)));
  });

  it("운영자 — 이미 있는 값·모양이 틀린 도메인은 보내지 않고 그 사유를 글로", async () => {
    renderScreen(OWNER);
    fireEvent.click(await screen.findByRole("button", { name: /매체 제외 목록/ }));
    const form = await screen.findByRole("form", { name: "제외 매체 더하기" });
    fireEvent.change(within(form).getByLabelText("값"), { target: { value: "XINHUANET.com" } });
    fireEvent.click(within(form).getByRole("button", { name: "더하기" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("이미 목록에 있습니다");
    expect(api.apiPost).not.toHaveBeenCalled();
  });

  it("운영자 — 더하거나 지우면 최근 글을 다시 읽는다(서버가 이미 빼고 줌)", async () => {
    renderScreen(OWNER);
    await waitFor(() => expect(sharedCalls().filter((path) => path === endpoints.search.recent)).toHaveLength(1));
    fireEvent.click(await screen.findByRole("button", { name: /매체 제외 목록/ }));
    const form = await screen.findByRole("form", { name: "제외 매체 더하기" });
    fireEvent.change(within(form).getByLabelText("값"), { target: { value: "example.org" } });
    fireEvent.click(within(form).getByRole("button", { name: "더하기" }));
    await waitFor(() => expect(sharedCalls().filter((path) => path === endpoints.search.recent)).toHaveLength(2));

    fireEvent.click(within(screen.getByRole("list", { name: "더한 제외 매체" })).getByRole("button", { name: "Some Media 지우기" }));
    await waitFor(() => expect(sharedCalls().filter((path) => path === endpoints.search.recent)).toHaveLength(3));
  });

  it("운영자 — 더하기가 실패하면 최근 글을 다시 읽지 않는다", async () => {
    api.apiPost.mockRejectedValue(Object.assign(new Error("도메인 형식이 올바르지 않습니다"), { status: 400 }));
    renderScreen(OWNER);
    await waitFor(() => expect(sharedCalls().filter((path) => path === endpoints.search.recent)).toHaveLength(1));
    fireEvent.click(await screen.findByRole("button", { name: /매체 제외 목록/ }));
    const form = await screen.findByRole("form", { name: "제외 매체 더하기" });
    fireEvent.change(within(form).getByLabelText("값"), { target: { value: "example.org" } });
    fireEvent.click(within(form).getByRole("button", { name: "더하기" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("도메인 형식이 올바르지 않습니다");
    expect(sharedCalls().filter((path) => path === endpoints.search.recent)).toHaveLength(1);
  });

  it("운영자 — 국제화 도메인은 punycode로 보내고 메모가 비면 입력한 표기를, www 주소를 붙여 넣으면 www를 떼어 이미 있는 줄로 본다", async () => {
    reads[endpoints.search.excludes] = {
      ...EXCLUDES,
      added: [...EXCLUDES.added, { id: 4, kind: "domain", value: "xn--h89at9srwx.xn--3e0b707e", note: "입력: 한겨레.한국", createdAt: "2026-11-14T01:00:00+00:00" }],
    };
    renderScreen(OWNER);
    fireEvent.click(await screen.findByRole("button", { name: /매체 제외 목록/ }));
    const form = await screen.findByRole("form", { name: "제외 매체 더하기" });

    fireEvent.change(within(form).getByLabelText("값"), { target: { value: "https://WWW.한겨레.한국/path" } });
    fireEvent.click(within(form).getByRole("button", { name: "더하기" }));
    expect((await within(form).findByRole("alert")).textContent).toContain("이미 목록에 있습니다");

    fireEvent.change(within(form).getByLabelText("값"), { target: { value: "news.한겨레.한국" } });
    fireEvent.click(within(form).getByRole("button", { name: "더하기" }));
    await waitFor(() =>
      expect(within(form).getByRole("alert").textContent).toContain("이미 목록의 xn--h89at9srwx.xn--3e0b707e이(가) 이 도메인을 덮습니다"),
    );
    expect(api.apiPost).not.toHaveBeenCalled();

    fireEvent.change(within(form).getByLabelText("값"), { target: { value: "Bücher.example" } });
    fireEvent.click(within(form).getByRole("button", { name: "더하기" }));
    await waitFor(() =>
      expect(postCalls()).toContainEqual([endpoints.search.excludes, { kind: "domain", value: "xn--bcher-kva.example", note: "입력: bücher.example" }]),
    );
  });

  it("더한 매체 줄 — 좁은 화면에서는 메모가 값 아래 한 줄을 다 쓴다(글자마다 끊기지 않게)", async () => {
    renderScreen(MEMBER);
    fireEvent.click(await screen.findByRole("button", { name: /매체 제외 목록/ }));
    const added = await screen.findByRole("list", { name: "더한 제외 매체" });
    const note = within(added).getByText("사용자 추가");
    // 좁은 화면: 줄의 마지막으로 내려 한 줄을 다 씀 · sm 이상: 값 옆 남은 폭
    expect(note.className).toContain("order-last");
    expect(note.className).toContain("basis-full");
    expect(note.className).toContain("sm:order-none");
    expect(note.className).toContain("sm:basis-0");
  });

  it("회원 — 목록은 읽기만(더하기·지우기 없음)", async () => {
    renderScreen(MEMBER);
    fireEvent.click(await screen.findByRole("button", { name: /매체 제외 목록/ }));
    expect(await screen.findByText("xinhuanet.com")).toBeTruthy();
    const added = screen.getByRole("list", { name: "더한 제외 매체" });
    expect(within(added).getByText("Some Media")).toBeTruthy();
    expect(within(added).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("form", { name: "제외 매체 더하기" })).toBeNull();
    expect(screen.getByText(/운영자만/)).toBeTruthy();
  });
});
