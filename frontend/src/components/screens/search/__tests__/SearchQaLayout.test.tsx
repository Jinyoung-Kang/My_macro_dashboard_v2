/**
 * 정보 검색 대상 화면의 배치(QA-420)와 주소의 탭·기간 정규화(QA-421). 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *
 * 배치: jsdom은 배치를 재지 않습니다. 그래서 그린 화면의 클래스에서 그 창 폭에 쓰이는 칸 틀(`grid-cols-[…]`과 그 앞의 lg:·xl: 등)을 읽고,
 * 셸의 폭(아래 상수)으로 가운데 칸의 폭을 셈해 줄의 고정 칸이 들어가는지 봅니다(배치 계산을 클래스 계약으로 시험 — 실제 화면은 QA 스택에서 잼).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

import { BOTTOM_SHEET_VAR } from "@/hooks/useBottomSheet";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import { canonicalSearchHref, linkGraphSize } from "@/lib/infoSearch";
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

const NO_IDS = { ticker: null, market: null, stockCode: null, cik: null, dartCorpCode: null, wikidata: null, lei: null };
const TOPIC_KEY = "topic:합성 반도체 공급";
const TOPIC = { key: TOPIC_KEY, kind: "topic", name: "합성 반도체 공급", nameKo: null, nameEn: null, aliases: [], description: null, ids: NO_IDS, links: [], sources: [] };

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

/** 지금 주소로 화면을 그립니다. render는 act 안에서 효과까지 돌리므로 주소를 바꿔 쓰는 효과는 이 함수가 돌아오기 전에 끝납니다. */
function mountScreen() {
  return render(
    <SessionUserProvider user={MEMBER}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

function renderScreen(path: string) {
  setLocation(path);
  return mountScreen();
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
/** 컨테이너 쿼리 크기(rem — 설치된 Tailwind v4의 --container-*). `@xl:`은 그 칸을 담은 @container 요소의 폭이 36rem 이상일 때. */
const CONTAINERS: Record<string, number> = { "3xs": 16, "2xs": 18, xs: 20, sm: 24, md: 28, lg: 32, xl: 36, "2xl": 42, "3xl": 48 };
/** 확인할 창 폭 — 1024~1279는 왼쪽 메뉴가 있는 가장 좁은 넓은 화면, 1280은 xl 경계, 1440은 QA의 넓은 화면. */
const WIDTHS = [1024, 1100, 1180, 1279, 1280, 1440];

/** 결과 패널 안쪽의 폭(창 폭 → 칸 틀이 나눌 폭). */
const gridWidth = (viewport: number) => Math.min(viewport - SIDE_NAV - SCROLLBAR, MAIN_MAX) - MAIN_PAD - SCREEN_FRAME - PANEL_BORDER;

/**
 * 그 창 폭에서 쓰이는 칸 틀(`grid-cols-[a_b_c]` → ["a","b","c"]) — 앞머리(lg: 등)가 창 폭 이하인 것 가운데 가장 큰 것. 컨테이너 앞머리(@xl: 등)는
 * 둘러싼 @container의 폭(container)으로 고르고, Tailwind가 그 규칙을 창 폭 규칙보다 뒤에 두므로 맞으면 창 폭 앞머리보다 앞섭니다.
 */
function activeTracks(element: Element, viewport: number, container?: number): string[] {
  let best: { rank: number; tracks: string[] } | null = null;
  for (const token of element.className.split(/\s+/)) {
    const match = /^(?:((?:sm|md|lg|xl|2xl):)|@([0-9a-z]+):)?grid-cols-\[([^\]]+)\]$/.exec(token);
    if (!match) continue;
    let rank: number;
    if (match[2] !== undefined) {
      if (container === undefined) throw new Error(`컨테이너 폭이 있어야 고를 수 있는 칸 틀입니다: ${token}`);
      const min = CONTAINERS[match[2]] * REM;
      if (!(container >= min)) continue;
      rank = 10_000 + min;
    } else {
      const min = BREAKPOINTS[match[1] ?? ""];
      if (min > viewport) continue;
      rank = min;
    }
    if (!best || rank > best.rank) best = { rank, tracks: match[3].split("_") };
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
        const tracks = activeTracks(line, viewport, middle); // 결과 목록은 가운데 칸의 폭 그대로(@container)
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

describe("개선 제안 — 타임라인 줄의 배치는 창 폭이 아니라 결과 목록의 폭(@container)으로 정해 제목 칸이 좁아지지 않는다", () => {
  // 개선 제안(QA 스택 재확인 1): 줄의 네 칸(시각 · 종류 · 매체 · 제목)을 창 폭 lg(1024)부터 써서 제목 칸이 1024 126px·1100 202px, xl 세 칸이
  // 시작하는 1280에서 94px(1279는 381px)로 줄었습니다 — '합성 반도체 공급 감소 전망'·'… 증가 전망'이 둘 다 '합성 반도체 공급 …'로 보였습니다.
  // 네 칸은 결과 목록이 36rem(@xl, 576px — 제목 칸 236px) 이상일 때만, 그 밑은 lg 미만의 두 칸(시각 · 제목 두 줄까지 + 종류 · 매체 줄)입니다.
  // 수정 전 실패: 1024·1100·1280에서 네 칸이라 제목 칸이 121·197·89px(셈은 위 QA-420 시험과 같은 셸 폭).
  const FOUR = 4;
  const TWO = 2;
  /** 네 칸일 때 제목 칸이 적어도 남길 폭 — 앞머리가 같은 제목을 가를 만큼(14px 한글 열여섯 자 남짓). */
  const TITLE_WIDE = 236;
  /** 창 폭마다 바라는 배치 — 390은 왼쪽 메뉴·칸 틀이 없어 목록이 창보다 좁음(창 폭으로 위 끝을 셈). */
  const EXPECTED: [number, number][] = [
    [390, TWO],
    [1024, TWO],
    [1100, TWO],
    [1180, FOUR],
    [1279, FOUR],
    [1280, TWO],
    [1440, FOUR],
  ];

  it("390·1024·1100·1280은 두 칸, 1180·1279·1440은 네 칸 — 어느 쪽이든 제목 칸이 236px 이상(칸 머리는 네 칸일 때만)", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const grid = entityGridOf(list);
    const header = list.firstElementChild as Element;
    const rows = within(list).getAllByRole("option");
    const seen: [number, number][] = [];
    for (const [viewport] of EXPECTED) {
      const width = viewport < BREAKPOINTS["lg:"] ? viewport : middleWidth(grid, viewport);
      const layouts = rows.map((line) => activeTracks(line, viewport, width).length);
      expect(new Set(layouts).size).toBe(1);
      seen.push([viewport, layouts[0]]);
      const tracks = activeTracks(rows[0], viewport, width);
      const title = width - ROW_PAD - fixedPx(tracks) - ROW_GAP * (tracks.length - 1);
      if (viewport >= BREAKPOINTS["lg:"]) expect({ viewport, title }).toEqual({ viewport, title: Math.max(title, TITLE_WIDE) });
      // 칸 머리는 네 칸과 같은 기준(@xl)으로만 보입니다.
      expect(activeTracks(header, viewport, width)).toEqual(["4.5rem", "4rem", "9rem", "minmax(0,1fr)"]);
    }
    expect(seen).toEqual(EXPECTED);
    // 줄의 @xl:을 가르는 것은 결과 목록(가운데 칸의 폭 그대로)입니다.
    expect(list.className.split(/\s+/)).toContain("@container");
    expect(header.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "@xl:grid"]));
    // 36rem 경계에서 네 칸의 제목 칸 — 576 - 24 - 280 - 36.
    expect(CONTAINERS.xl * REM - ROW_PAD - fixedPx(["4.5rem", "4rem", "9rem"]) - ROW_GAP * 3).toBe(TITLE_WIDE);
  });

  it("배치를 바꾸는 클래스는 모두 목록 폭(@xl:) — 창 폭(lg:)은 누르는 자리(줄 높이·위아래 여백)만, 두 칸의 제목은 두 줄까지", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const header = list.firstElementChild as HTMLElement;
    for (const element of [header, ...within(list).getAllByRole("option"), ...within(list).getAllByRole("option").flatMap((row) => [...row.querySelectorAll("*")])]) {
      const tokens = element.getAttribute("class")?.split(/\s+/) ?? [];
      expect(tokens.filter((token) => /^lg:(grid|block|hidden|truncate|grid-cols-|col-start-|row-start-|text-)/.test(token))).toEqual([]);
    }
    const row = within(list).getAllByRole("option")[0];
    const tokens = row.className.split(/\s+/);
    expect(tokens).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-8", "scroll-mt-7", "grid-cols-[4.5rem_minmax(0,1fr)]", "@xl:grid-cols-[4.5rem_4rem_9rem_minmax(0,1fr)]"]));
    const title = within(row).getByText("첫째 기사");
    expect(title.className.split(/\s+/)).toEqual(expect.arrayContaining(["line-clamp-2", "break-words", "@xl:block", "@xl:truncate"]));
    expect(title.className.split(/\s+/)).not.toContain("truncate");
    // 두 칸에서는 종류 뒤에 매체를 같은 줄에, 네 칸에서는 매체 칸에.
    const inline = within(row).getByText((_, element) => element?.textContent === " · Example Wire");
    expect(inline.className).toBe("@xl:hidden");
    const column = [...row.children].find((child) => child.textContent === "Example Wire") as HTMLElement;
    expect(column.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "@xl:block"]));
  });
});

describe("QA-420 검토 — xl 미만의 아래 시트가 차지한 높이만큼 비운다(고른 줄·끝 줄이 시트 밑에 숨지 않게)", () => {
  // jsdom은 배치를 재지 않으므로 시트(max-h-[50dvh] 칸)의 계산된 위치(고정인지)와 크기를 가짜로 줍니다 — 창 폭에 따라 고정(xl 미만)·흐름 안(xl)인 것은
  // 클래스(xl:static)가 정하고, 여기서는 그 두 경우를 sheetFixed로 고릅니다.
  const SHEET_TOP = 500;
  const SHEET_HEIGHT = 240;
  let sheetFixed: boolean;
  /** 시트 안 내용의 높이 — 시트의 높이는 이것과 시트의 min-height(인라인 'min(Npx, 50dvh)' — CSS처럼) 가운데 큰 쪽입니다. */
  let contentHeight: (sheet: HTMLElement) => number;
  /** 고른 줄의 화면 위 자리(위·아래 끝). */
  let selectedBox: { top: number; bottom: number };
  let main: HTMLElement;
  let restore: (() => void)[];
  const isSheet = (element: Element) => element instanceof HTMLElement && element.className.split(/\s+/).includes("max-h-[50dvh]");
  const rect = (top: number, height: number) =>
    ({ x: 0, y: top, top, left: 0, right: 0, bottom: top + height, width: 0, height, toJSON: () => ({}) }) as DOMRect;
  const reserved = () => document.documentElement.style.getPropertyValue(BOTTOM_SHEET_VAR);
  const minHeightOf = (element: HTMLElement) => Number(/^min\((\d+)px/.exec(element.style.minHeight)?.[1] ?? 0);
  /** 같은 사건 묶음(대표 줄 + 다른 보도 하나)과 다음 결과 줄 — 목록은 대표 줄 · 묶음 줄 · 다음 줄. */
  const CLUSTERED = {
    ...FEED,
    items: [
      row({ id: "a1", title: "묶음 대표", clusterId: "a1", cluster: { size: 2, publishers: 2 }, publishedAt: "2026-11-13T23:00:00+00:00" }),
      row({ id: "a2", title: "묶음 둘째", clusterId: "a1", publisher: "Other Wire", publisherDomain: "other.example", publishedAt: "2026-11-14T00:00:00+00:00" }),
      row({ id: "b1", title: "다음 기사", publishedAt: "2026-11-13T10:00:00+00:00" }),
    ],
    rangeCounts: { "7d": 3, "30d": 3, "1y": 3, "2y": 3 },
  };

  beforeEach(() => {
    sheetFixed = true;
    contentHeight = () => SHEET_HEIGHT;
    selectedBox = { top: 600, bottom: 632 };
    const realStyle = window.getComputedStyle.bind(window);
    const style = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element: Element, pseudo?: string | null) =>
        sheetFixed && isSheet(element) ? ({ position: "fixed" } as CSSStyleDeclaration) : realStyle(element, pseudo),
      );
    const box = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (isSheet(this)) return rect(SHEET_TOP, Math.max(contentHeight(this), minHeightOf(this)));
      if (this.getAttribute("role") === "option" && this.getAttribute("aria-selected") === "true") {
        return rect(selectedBox.top, selectedBox.bottom - selectedBox.top);
      }
      return rect(0, 0);
    });
    // 본문(main#main)의 세로 스크롤 막대 10px — 셸의 본문이 lg부터 스크롤 상자.
    main = document.createElement("main");
    main.id = "main";
    Object.defineProperty(main, "offsetWidth", { configurable: true, value: 800 });
    Object.defineProperty(main, "clientWidth", { configurable: true, value: 790 });
    document.body.appendChild(main);
    restore = [() => style.mockRestore(), () => box.mockRestore()];
  });
  afterEach(() => {
    cleanup();
    restore.forEach((undo) => undo());
    main.remove();
    document.documentElement.style.removeProperty(BOTTOM_SHEET_VAR);
  });

  async function openPreview(index: number) {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const panel = entityGridOf(list).parentElement as HTMLElement;
    const scrolled: Element[] = [];
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    restore.push(() => scroll.mockRestore());
    const row = within(list).getAllByRole("option")[index];
    fireEvent.click(row);
    const sheet = screen.getByRole("region", { name: "미리 보기" }).parentElement?.parentElement as HTMLElement;
    return { list, panel, sheet, row, scrolled, scroll };
  }

  it("시트가 고정(xl 미만)이면 그 높이를 문서 루트(--bottom-sheet — 스크롤 여백)에 적고 결과 아래에 같은 여백, 오른쪽은 본문 스크롤 막대만큼 비운다 — 닫으면 지운다", async () => {
    const { list, panel, sheet } = await openPreview(1);
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    expect(panel.style.marginBottom).toBe(`${SHEET_HEIGHT}px`);
    expect(sheet.style.right).toBe("10px");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(reserved()).toBe("");
    expect(panel.style.marginBottom).toBe("");
  });

  it("시트가 열려 고른 줄을 덮으면 그 줄을 시트 위로 옮긴다(nearest — 스크롤 여백을 따름), 덮지 않았으면 옮기지 않는다", async () => {
    const { row, scrolled, scroll } = await openPreview(1);
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    expect(scrolled).toEqual([row]);
    expect(scroll).toHaveBeenCalledWith({ block: "nearest" });
    scroll.mockRestore();
    cleanup();
    expect(reserved()).toBe("");
    selectedBox = { top: 100, bottom: 132 };
    const again = await openPreview(0);
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    expect(again.scrolled).toEqual([]);
  });

  // QA-420 후속(QA 스택 재확인 3, 1024·1100·1279·390): 시트가 새로 열리거나 커지는 순간(묶음 줄 다음 줄을 고를 때 등) 고른 줄의 아래끝이
  // 시트 위끝 바로 위 — 시트 위로 올라간 TOP 단추 자리(64px, globals.css의 스크롤 여백과 같은 값) — 에 있으면 단추가 그 줄을 덮었는데
  // (1024에서 29x15px), 다시 옮기는 조건이 '시트가 줄을 덮을 때'뿐이었습니다. 그 띠에 걸친 줄도 옮겨야 합니다.
  // 수정 전 실패: 줄 450~482(시트 위끝 500, 띠 436~500)를 옮기지 않음(재현 커밋에서는 it.fails).
  it("시트가 열릴 때 고른 줄이 시트 위 TOP 단추 자리(64px 띠)에 걸치면 그 줄도 옮긴다", async () => {
    selectedBox = { top: 450, bottom: 482 };
    const { row, scrolled } = await openPreview(1);
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    expect(scrolled).toEqual([row]);
  });

  // 개선 제안(QA 스택 재확인 1, 1024·390): ↓로 '같은 사건 n건 — 펼치기' 묶음 줄을 지나면 미리 보기가 없어 시트가 닫히고(--bottom-sheet를 지우고
  // 결과 아래 여백이 사라짐 — 1024에서 본문 높이 2504 → 2688, TOP 단추도 내려옴) 다음 ↓에서 다시 열렸습니다. 묶음 줄도 미리 보기(묶음)를 보이므로
  // 시트·스크롤 여백·결과 아래 여백이 그대로입니다. 수정 전 실패: 묶음 줄에서 미리 보기가 사라지고 --bottom-sheet가 지워짐.
  it("↑↓로 묶음 줄을 지나도 시트가 닫히지 않는다 — --bottom-sheet·결과 아래 여백이 그대로", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = CLUSTERED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const panel = entityGridOf(list).parentElement as HTMLElement;
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    restore.push(() => scroll.mockRestore());
    list.focus();
    fireEvent.keyDown(list, { key: "Home" });
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    const sheet = screen.getByRole("region", { name: "미리 보기" }).parentElement?.parentElement as HTMLElement;
    const removed = vi.spyOn(document.documentElement.style, "removeProperty");
    restore.push(() => removed.mockRestore());
    expect(within(list).getAllByRole("option").map((option) => option.textContent)).toEqual([
      expect.stringContaining("묶음 대표"),
      "같은 사건 2건 · 매체 2곳 — 펼치기",
      expect.stringContaining("다음 기사"),
    ]);
    for (const at of [1, 2]) {
      fireEvent.keyDown(list, { key: "ArrowDown" });
      expect(within(list).getAllByRole("option")[at].getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("region", { name: "미리 보기" }).parentElement?.parentElement).toBe(sheet);
      expect(sheet.className.split(/\s+/)).toContain("fixed");
      expect(reserved()).toBe(`${SHEET_HEIGHT}px`);
      expect(panel.style.marginBottom).toBe(`${SHEET_HEIGHT}px`);
    }
    expect(removed).not.toHaveBeenCalledWith(BOTTOM_SHEET_VAR);
  });

  // 검토 지적(위 시험의 고침 — 1024 스크롤 당김): 묶음 미리 보기(1024에서 약 343px)는 결과 줄의 미리 보기(240~265px)보다 높아, 시트가 닫히지는
  // 않아도 묶음 줄에서 다음 줄로 옮기면 시트·결과 아래 여백·--bottom-sheet가 약 103px 줄었습니다. 목록 끝 근처에서는 본문의 스크롤 높이가 그만큼
  // 줄어 스크롤 위치가 당겨지고 고른 줄이 움직였습니다(원래 지적한 약 104px와 같은 작동). 열린 동안 시트는 잰 높이 아래로 줄지 않습니다.
  // 수정 전 실패: 다음 줄에서 시트의 min-height가 없고 결과 아래 여백이 240px로 줄어듦.
  it("열린 동안 시트는 줄지 않는다 — 높은 묶음 미리 보기에서 낮은 결과 줄로 옮겨도 결과 아래 여백·--bottom-sheet가 그대로, 닫으면 풀림", async () => {
    const CLUSTER_HEIGHT = 343;
    contentHeight = (sheet) => (sheet.querySelector('ul[aria-label="같은 사건의 다른 보도"]') ? CLUSTER_HEIGHT : SHEET_HEIGHT);
    // jsdom에는 ResizeObserver가 없습니다 — 시트의 크기가 바뀐 것을 알리는 자리를 손으로 부릅니다.
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    restore.push(() => vi.unstubAllGlobals());
    const resized = () => act(() => observers.forEach((callback) => callback()));
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = CLUSTERED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const panel = entityGridOf(list).parentElement as HTMLElement;
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    restore.push(() => scroll.mockRestore());
    list.focus();
    fireEvent.keyDown(list, { key: "Home" });
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    const sheet = screen.getByRole("region", { name: "미리 보기" }).parentElement?.parentElement as HTMLElement;
    expect(sheet.style.minHeight).toBe(`min(${SHEET_HEIGHT}px, 50dvh)`);

    // 묶음 줄 — 시트가 커짐(그만큼 결과 아래 여백도).
    fireEvent.keyDown(list, { key: "ArrowDown" });
    resized();
    expect(reserved()).toBe(`${CLUSTER_HEIGHT}px`);
    expect(panel.style.marginBottom).toBe(`${CLUSTER_HEIGHT}px`);

    // 다음 결과 줄 — 내용은 240px이지만 시트·여백은 줄지 않음.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    resized();
    expect(within(list).getAllByRole("option")[2].getAttribute("aria-selected")).toBe("true");
    expect(sheet.style.minHeight).toBe(`min(${CLUSTER_HEIGHT}px, 50dvh)`);
    expect(reserved()).toBe(`${CLUSTER_HEIGHT}px`);
    expect(panel.style.marginBottom).toBe(`${CLUSTER_HEIGHT}px`);

    // 닫으면 풀리고, 다시 열면 그 미리 보기의 높이부터.
    fireEvent.keyDown(list, { key: "Escape" });
    expect(sheet.style.minHeight).toBe("");
    expect(panel.style.marginBottom).toBe("");
    fireEvent.keyDown(list, { key: "Home" });
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    expect(panel.style.marginBottom).toBe(`${SHEET_HEIGHT}px`);
  });

  // 검토 지적(항목 1 — 누르기): 묶음 줄을 누르면 아래 시트가 열려 누른 줄을 시트 위로 옮기고 바로 밑에 펼친 줄을 덮었습니다. 누르기로 고른 묶음
  // 줄은 시트를 열지 않고, 열려 있던 시트는 닫습니다(--bottom-sheet·결과 아래 여백을 지움). 수정 전 실패: 시트가 열린 채(고정) 남음.
  it("묶음 줄을 누르면 시트를 열지 않는다 — 열려 있던 시트도 닫혀 펼친 줄을 덮지 않음", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = CLUSTERED;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const panel = entityGridOf(list).parentElement as HTMLElement;
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
    restore.push(() => scroll.mockRestore());
    const rows = () => within(list).getAllByRole("option");
    fireEvent.click(rows()[0]);
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    const sheet = screen.getByRole("region", { name: "미리 보기" }).parentElement?.parentElement as HTMLElement;
    fireEvent.click(rows()[1]);
    expect(rows().map((option) => option.textContent)).toEqual([
      expect.stringContaining("묶음 대표"),
      "같은 사건 2건 · 매체 2곳 — 접기",
      expect.stringContaining("묶음 둘째"),
      expect.stringContaining("다음 기사"),
    ]);
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
    expect(sheet.className.split(/\s+/)).not.toContain("fixed");
    expect(reserved()).toBe("");
    expect(panel.style.marginBottom).toBe("");
  });

  it("xl(오른쪽 칸 — 흐름 안)에서는 비우지 않는다", async () => {
    sheetFixed = false;
    const { panel, sheet, scrolled } = await openPreview(1);
    expect(reserved()).toBe("");
    expect(panel.style.marginBottom).toBe("");
    expect(sheet.style.right).toBe("");
    expect(scrolled).toEqual([]);
  });

  it("TOP 단추는 시트 높이(--bottom-sheet)만큼 위로 올라가 시트에 가리지 않는다(Tab 차례에 숨은 단추가 남지 않게)", async () => {
    await openPreview(1);
    await waitFor(() => expect(reserved()).toBe(`${SHEET_HEIGHT}px`));
    act(() => {
      main.scrollTop = 900;
      main.dispatchEvent(new Event("scroll"));
    });
    const top = screen.getByRole("button", { name: /맨 위로/ });
    expect(top.style.translate).toBe("0 calc(-1 * var(--bottom-sheet, 0px))");
    expect(top.className).toContain("z-20");
  });

  it("스크롤 여백은 --bottom-sheet를 따른다 — lg 미만은 문서(하단 탭 바 + 시트), lg 이상은 본문 main(globals.css)", () => {
    const css = readFileSync(resolve(__dirname, "../../../../app/globals.css"), "utf8");
    expect(BOTTOM_SHEET_VAR).toBe("--bottom-sheet");
    expect(css).toMatch(
      /@media \(width < 64rem\) \{\s*html \{\s*scroll-padding-bottom: calc\(64px \+ env\(safe-area-inset-bottom\) \+ var\(--bottom-sheet, 0px\) \+ min\(var\(--bottom-sheet, 0px\), 64px\)\);/,
    );
    expect(css).toMatch(/@media \(width >= 64rem\) \{\s*#main \{\s*scroll-padding-bottom: calc\(var\(--bottom-sheet, 0px\) \+ min\(var\(--bottom-sheet, 0px\), 64px\)\);/);
  });

  // QA-420 후속(QA 스택 재확인 3, 390·1024): 시트가 열리면 TOP 단추가 시트 바로 위로 올라가는데(4cd7b845), ↑↓로 고른 줄은 스크롤 여백대로
  // 시트 위끝에 맞춰 멈춰 그 줄의 오른쪽 끝을 단추가 덮었습니다(390에서 54x35px, 17줄 가운데 9줄). 단추가 차지하는 높이(lg 미만 16 + 44,
  // lg 이상 24 + 34 — 많아야 60px)를 시트가 열렸을 때만 스크롤 여백에 더해야 합니다(시트가 없으면 0 — min(시트 높이, 64px)).
  // 수정 전 실패: 두 규칙 모두 시트 높이만 더함(재현 커밋에서는 it.fails).
  it("시트가 열렸을 때만 TOP 단추 자리(64px)를 스크롤 여백에 더해 고른 줄이 단추 밑에 멈추지 않는다", () => {
    const css = readFileSync(resolve(__dirname, "../../../../app/globals.css"), "utf8");
    const narrow = /@media \(width < 64rem\) \{\s*html \{\s*scroll-padding-bottom: ([^;]+);/.exec(css)?.[1] ?? "";
    const wide = /@media \(width >= 64rem\) \{\s*#main \{\s*scroll-padding-bottom: ([^;]+);/.exec(css)?.[1] ?? "";
    for (const rule of [narrow, wide]) expect(rule).toContain("min(var(--bottom-sheet, 0px), 64px)");
  });
});

describe("QA-421 — 주소의 모르는 탭·기간 값이 주소에 그대로 남음(계약 §5 — 탭·기간은 바꿔 씀)", () => {
  // 기록 길이는 그리기 전에 읽습니다 — 바꿔 쓰기는 render(act) 안의 효과에서 일어나므로 그린 뒤에 읽으면 pushState여도 잡지 못합니다
  // (QA-421 검토). setLocation은 replaceState라 길이를 바꾸지 않습니다.
  const url = () => new URLSearchParams(window.location.search);
  const tabNames = async () => within(await screen.findByRole("tablist", { name: "결과 탭" })).getAllByRole("tab").map((tab) => tab.textContent);

  // QA-421: 화면은 타임라인인데 주소의 tab=bogus가 그대로 남았음(파싱이 조용히 기본값으로 바꿔 EntityView의 비교에 드러나지 않음).
  it("모르는 탭 값(tab=bogus) — 주소를 timeline으로 바꿔 쓴다(기록에 쌓지 않음, 기간은 그대로)", async () => {
    reads[endpoints.search.entity(TOPIC_KEY)] = { available: true, entity: TOPIC, errors: {} };
    const before = window.history.length;
    renderScreen(`/search?e=${encodeURIComponent(TOPIC_KEY)}&tab=bogus&range=1y`);
    expect(await tabNames()).toEqual(["타임라인", "뉴스", "연결"]);
    expect(screen.getByRole("tab", { name: "타임라인" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(url().get("tab")).toBe("timeline"));
    expect(url().get("e")).toBe(TOPIC_KEY);
    expect(url().get("range")).toBe("1y");
    expect(window.history.length).toBe(before);
  });

  // QA-421: 화면은 30일인데 주소의 range=9y가 그대로 남았음(기간은 바꿔 쓰는 길이 없었음).
  it("모르는 기간 값(range=9y) — 주소를 30d로 바꿔 쓴다(기록에 쌓지 않음, 탭은 그대로)", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    const before = window.history.length;
    renderScreen("/search?e=us:NVDA&tab=news&range=9y");
    await tabNames();
    expect(screen.getByRole("tab", { name: "뉴스" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(url().get("range")).toBe("30d"));
    expect(url().get("tab")).toBe("news");
    expect(window.history.length).toBe(before);
  });

  it("고를 수 없는 탭 + 모르는 기간(주제 + tab=filings&range=9y) — 두 바꿔 쓰기가 서로 되돌리지 않고 한 주소로 끝난다", async () => {
    reads[endpoints.search.entity(TOPIC_KEY)] = { available: true, entity: TOPIC, errors: {} };
    setLocation(`/search?e=${encodeURIComponent(TOPIC_KEY)}&tab=filings&range=9y`);
    const before = window.history.length;
    // 시작 주소를 놓은 뒤, 그리기 전에 겁니다 — 바꿔 쓰기는 그리는 동안(render의 act) 일어납니다.
    const writes = vi.spyOn(window.history, "replaceState");
    const pushes = vi.spyOn(window.history, "pushState");
    try {
      mountScreen();
      await tabNames();
      await waitFor(() => expect([url().get("tab"), url().get("range")]).toEqual(["timeline", "30d"]));
      expect(url().get("e")).toBe(TOPIC_KEY);
      expect(window.history.length).toBe(before);
      expect(pushes).not.toHaveBeenCalled();
      // 앞 렌더의 주소(tab=filings)로 되돌린 뒤 다시 바꿔 쓰지 않음.
      const tabs = writes.mock.calls.map(([, , href]) => new URLSearchParams(String(href).split("?")[1]).get("tab"));
      expect(tabs.length).toBeGreaterThan(0);
      expect(tabs).not.toContain("filings");
    } finally {
      writes.mockRestore();
      pushes.mockRestore();
    }
  });

  it("wd: 키를 풀지 못했어도(종류를 모름) 모르는 탭 값은 바꿔 쓴다 — 이름이 맞는 탭(holdings)은 그대로", async () => {
    renderScreen("/search?e=wd:Q4000001&tab=bogus");
    await waitFor(() => expect(url().get("tab")).toBe("timeline"));
    expect(url().get("range")).toBe("30d");
    cleanup();
    renderScreen("/search?e=wd:Q4000001&tab=holdings");
    expect(screen.getByText("대상을 푸는 중…")).toBeTruthy();
    expect(window.location.search).toBe("?e=wd:Q4000001&tab=holdings");
  });

  it("탭·기간이 빠진 주소(알림의 /search?e=…&tab=timeline 등)는 기본값으로 보이고 주소는 그대로 둔다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    renderScreen("/search?e=us:NVDA&tab=timeline");
    await tabNames();
    expect(screen.getByRole("tab", { name: "타임라인" }).getAttribute("aria-selected")).toBe("true");
    expect(window.location.search).toBe("?e=us:NVDA&tab=timeline");
  });
});

describe("canonicalSearchHref — 주소의 모르는 탭·기간 값을 기본값으로 바꾼 주소(QA-421)", () => {
  it("모르는 탭·기간이면 기본값으로 바꾼 주소, 아는 값은 그대로", () => {
    expect(canonicalSearchHref("?e=us:NVDA&tab=bogus&range=1y")).toBe("/search?e=us:NVDA&tab=timeline&range=1y");
    expect(canonicalSearchHref("?e=us:NVDA&tab=news&range=9y")).toBe("/search?e=us:NVDA&tab=news&range=30d");
    expect(canonicalSearchHref("?e=us:NVDA&tab=&range=")).toBe("/search?e=us:NVDA&tab=timeline&range=30d");
    expect(canonicalSearchHref(new URLSearchParams("e=topic:합성 반도체&tab=Timeline"))).toBe(
      `/search?e=topic:${encodeURIComponent("합성 반도체")}&tab=timeline&range=30d`,
    );
  });

  it("바꿀 것이 없으면 null — 아는 값, 빠진 값, 대상이 없거나 키 모양이 틀린 주소", () => {
    expect(canonicalSearchHref("?e=us:NVDA&tab=news&range=1y")).toBeNull();
    // 이름은 맞지만 이 대상에서 고를 수 없는 탭은 종류를 아는 EntityView가 맡음
    expect(canonicalSearchHref("?e=topic:x&tab=filings&range=30d")).toBeNull();
    expect(canonicalSearchHref("?e=us:NVDA&tab=timeline")).toBeNull();
    expect(canonicalSearchHref("?e=us:NVDA")).toBeNull();
    expect(canonicalSearchHref("?q=엔비디아&tab=bogus")).toBeNull();
    expect(canonicalSearchHref("?e=us:nvda&tab=bogus")).toBeNull();
    expect(canonicalSearchHref("")).toBeNull();
    expect(canonicalSearchHref(null)).toBeNull();
  });
});
