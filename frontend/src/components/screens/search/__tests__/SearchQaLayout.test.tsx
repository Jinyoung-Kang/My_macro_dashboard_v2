/**
 * 정보 검색 대상 화면의 배치(QA-420). 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *
 * jsdom은 배치를 재지 않습니다. 그래서 그린 화면의 클래스에서 그 창 폭에 쓰이는 칸 틀(`grid-cols-[…]`과 그 앞의 lg:·xl: 등)을 읽고,
 * 셸의 폭(아래 상수)으로 가운데 칸의 폭을 셈해 줄의 고정 칸이 들어가는지 봅니다(배치 계산을 클래스 계약으로 시험 — 실제 화면은 QA 스택에서 잼).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import { linkGraphSize } from "@/lib/infoSearch";
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: "미국의 반도체 기업",
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: null },
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

const FEED = {
  available: true, entityKey: "us:NVDA", tab: "timeline",
  items: [row({ id: "r1", title: "첫째 기사" }), row({ id: "r2", title: "둘째 기사", publishedAt: "2026-11-13T10:00:00+00:00" })],
  sources: [{ source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 2, dropped: null, message: null }],
  window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 2, "30d": 2, "1y": 2, "2y": 2 },
  olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
};

const LINKS = { available: true, entityKey: "us:NVDA", links: [], sources: [], fetchedAt: "2026-11-14T01:00:00+00:00" };

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

function renderScreen(path: string) {
  setLocation(path);
  return render(
    <SessionUserProvider user={MEMBER}>
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
afterEach(() => cleanup());

// ------------------------------------------------------------------ 폭 셈(셸의 값 — 바뀌면 여기도 고침)

const REM = 16;
/** 왼쪽 메뉴(SideNav w-[232px], lg 이상). */
const SIDE_NAV = 232;
/** 본문(main — lg:overflow-y-auto)의 스크롤 막대. 겹쳐 그리는 스크롤 막대면 0이라 폭이 그만큼 넓어집니다 — 좁은 쪽으로 셈. */
const SCROLLBAR = 15;
/** 본문 열 최대 폭(Shell max-w-7xl)과 좌우 여백(lg:px-8). */
const MAIN_MAX = 1280;
const MAIN_PAD = 2 * 32;
/** 정보 검색 화면 테두리(1px)와 안쪽 여백(lg:p-5)·결과 패널 테두리(PANEL 1px). */
const SCREEN_FRAME = 2 * 1 + 2 * 20;
const PANEL_BORDER = 2 * 1;
/** 결과 줄의 좌우 여백(px-3)·칸 사이(gap-x-3). */
const ROW_PAD = 2 * 12;
const ROW_GAP = 12;
/** 제목 칸이 적어도 남겨야 하는 폭 — 14px 한글 다섯 자 남짓과 말줄임. */
const TITLE_MIN = 80;

const BREAKPOINTS: Record<string, number> = { "": 0, "sm:": 640, "md:": 768, "lg:": 1024, "xl:": 1280, "2xl:": 1536 };
/** 확인할 창 폭 — 1024~1279는 왼쪽 메뉴가 있는 가장 좁은 넓은 화면, 1280은 xl 경계, 1440은 QA의 넓은 화면. */
const WIDTHS = [1024, 1100, 1180, 1279, 1280, 1440];

/** 결과 패널 안쪽의 폭(창 폭 → 칸 틀이 나눌 폭). */
const gridWidth = (viewport: number) => Math.min(viewport - SIDE_NAV - SCROLLBAR, MAIN_MAX) - MAIN_PAD - SCREEN_FRAME - PANEL_BORDER;

/** 그 창 폭에서 쓰이는 칸 틀(`grid-cols-[a_b_c]` → ["a","b","c"]) — 앞머리(lg: 등)가 창 폭 이하인 것 가운데 가장 큰 것. */
function activeTracks(element: Element, viewport: number): string[] {
  let best: { min: number; tracks: string[] } | null = null;
  for (const token of element.className.split(/\s+/)) {
    const match = /^((?:sm|md|lg|xl|2xl):)?grid-cols-\[([^\]]+)\]$/.exec(token);
    if (!match) continue;
    const min = BREAKPOINTS[match[1] ?? ""];
    if (min <= viewport && (!best || min > best.min)) best = { min, tracks: match[2].split("_") };
  }
  if (!best) throw new Error(`칸 틀이 없습니다: ${element.className}`);
  return best.tracks;
}

/** 칸 틀의 고정 폭(rem·px) 합 — minmax(0,1fr) 같은 늘어나는 칸은 0. */
function fixedPx(tracks: string[]): number {
  return tracks.reduce((sum, track) => {
    const rem = /^([\d.]+)rem$/.exec(track);
    const px = /^(\d+)px$/.exec(track);
    return sum + (rem ? Number(rem[1]) * REM : px ? Number(px[1]) : 0);
  }, 0);
}

/** 대상 화면의 칸 틀(왼쪽·가운데·오른쪽 칸을 나누는 요소) — 안에 있는 요소에서 올라가 찾습니다. */
const entityGridOf = (inner: Element) => {
  const grid = inner.closest('[class*="grid-cols-[13rem"]');
  if (!grid) throw new Error("대상 화면의 칸 틀을 찾지 못했습니다");
  return grid;
};

/** 가운데 칸의 폭 — 칸 틀이 나눌 폭에서 고정 칸(왼쪽·오른쪽)을 뺀 것. */
const middleWidth = (grid: Element, viewport: number) => gridWidth(viewport) - fixedPx(activeTracks(grid, viewport));

describe("QA-420 — 창 폭 1024~1279에서 대상 화면 가운데 칸이 좁아 줄이 오른쪽 속성 칸으로 넘침", () => {
  // QA-420: 1024에서 가운데 칸이 173px(669 - 13rem - 18rem)인데 타임라인 줄은 고정 칸만 340px(+ 제목 80)이라 넘쳤음 — lg는 두 칸(461px).
  it("타임라인 — 1024·1100·1180·1279·1280·1440 모두 가운데 칸에 줄의 고정 칸과 제목이 들어간다(칸 머리 줄도)", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const grid = entityGridOf(list);
    const header = list.firstElementChild as Element;
    expect(header.textContent).toContain("제목");
    const rows = [header, ...within(list).getAllByRole("option")];
    for (const viewport of WIDTHS) {
      const middle = middleWidth(grid, viewport);
      for (const line of rows) {
        const tracks = activeTracks(line, viewport);
        const need = ROW_PAD + fixedPx(tracks) + ROW_GAP * (tracks.length - 1) + TITLE_MIN;
        expect({ viewport, middle }).toEqual({ viewport, middle: Math.max(middle, need) });
      }
    }
  });

  // QA-420: 연결·보유 탭도 같은 세 칸이라 1024에서 가운데 안쪽이 149px — 연결 그림의 가장 작은 폭(280)보다 좁아 12px 글자가 줄었음.
  it("연결 탭 — 같은 창 폭에서 가운데 칸 안쪽이 연결 그림의 가장 작은 폭 이상이다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.links("us:NVDA")] = LINKS;
    renderScreen("/search?e=us:NVDA&tab=links&range=30d");
    const grid = entityGridOf(await screen.findByRole("button", { name: /Mellanox/ }));
    const graphMin = linkGraphSize(1).width;
    for (const viewport of WIDTHS) {
      const inner = middleWidth(grid, viewport) - 2 * 12; // 가운데 칸의 px-3
      expect({ viewport, inner }).toEqual({ viewport, inner: Math.max(inner, graphMin) });
    }
  });

  it("lg(1024~1279)는 두 칸 — 왼쪽 칸이 두 줄을 차지하고 오른쪽 칸(속성)은 가운데 아래(옆 경계는 xl부터), lg 미만은 한 칸 그대로", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const grid = entityGridOf(await screen.findByRole("listbox", { name: "결과" }));
    for (const viewport of [1024, 1279]) expect(activeTracks(grid, viewport)).toEqual(["13rem", "minmax(0,1fr)"]);
    expect(activeTracks(grid, 1280)).toEqual(["13rem", "minmax(0,1fr)", "18rem"]);
    const tokens = grid.className.split(/\s+/);
    // lg 미만은 칸 틀이 없음(한 칸 — 390 그대로).
    expect(tokens.filter((token) => !token.includes(":"))).toEqual([]);
    expect(tokens).toContain("lg:grid-rows-[auto_1fr]");
    const [left, middle, right] = [...grid.children];
    expect(left.className.split(/\s+/)).toEqual(expect.arrayContaining(["lg:row-span-2", "xl:row-span-1"]));
    expect(middle.contains(screen.getByRole("listbox", { name: "결과" }))).toBe(true);
    const edge = right.className.split(/\s+/);
    expect(edge).toEqual(expect.arrayContaining(["border-t", "xl:border-l", "xl:border-t-0", "xl:static"]));
    expect(edge.some((token) => token.startsWith("lg:"))).toBe(false);
    expect(right.textContent).toContain("속성");
  });

  it("xl 미만에서 고른 줄의 미리 보기는 아래 시트 — lg는 바닥에, 왼쪽 메뉴(232px) 옆. xl은 오른쪽 칸 그대로", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    fireEvent.click(within(list).getAllByRole("option")[0]);
    const preview = screen.getByRole("region", { name: "미리 보기" });
    const pane = preview.parentElement?.parentElement as HTMLElement;
    const tokens = pane.className.split(/\s+/);
    // 좁은 화면의 시트(하단 탭 바 위)는 그대로.
    expect(tokens).toEqual(expect.arrayContaining(["fixed", "inset-x-0", "bottom-[calc(64px+env(safe-area-inset-bottom))]", "z-30", "max-h-[50dvh]"]));
    expect(tokens).toEqual(expect.arrayContaining(["lg:bottom-0", "lg:left-[232px]"]));
    expect(tokens).toEqual(expect.arrayContaining(["xl:static", "xl:z-auto", "xl:max-h-none", "xl:overflow-visible", "xl:border-l", "xl:border-t-0", "xl:shadow-none"]));
    expect(tokens).not.toContain("lg:static");
    expect(preview.parentElement?.className).toBe("xl:sticky xl:top-0");
  });

  it("결과 탭과 연결 탭은 같은 칸 틀을 쓴다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    reads[endpoints.search.links("us:NVDA")] = LINKS;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const feedGrid = entityGridOf(await screen.findByRole("listbox", { name: "결과" })).className;
    fireEvent.click(screen.getByRole("tab", { name: "연결" }));
    const linksGrid = entityGridOf(await screen.findByRole("button", { name: /Mellanox/ })).className;
    expect(linksGrid).toBe(feedGrid);
  });

  it("1440 — 세 칸(13rem · 가운데 · 18rem) 그대로", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const grid = entityGridOf(await screen.findByRole("listbox", { name: "결과" }));
    expect(activeTracks(grid, 1440)).toEqual(["13rem", "minmax(0,1fr)", "18rem"]);
    expect(middleWidth(grid, 1440)).toBe(589);
  });
});
