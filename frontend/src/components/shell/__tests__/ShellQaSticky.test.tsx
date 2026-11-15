/**
 * 셸 본문(main#main)과 위에 붙는 머리(position: sticky) — QA-450.
 *
 * sticky는 가장 가까운 스크롤 상자(overflow가 visible·clip이 아닌 조상)를 기준으로 붙습니다. 그 상자가 스크롤하지 않으면 머리는 붙지 않고
 * 내용과 함께 화면 밖으로 나갑니다. jsdom은 배치·스크롤을 계산하지 않으므로 클래스 약속으로 봅니다 — lg 미만에서 쓰이는 클래스(lg·xl·2xl 접두가
 * 없는 것)와 인라인 style 가운데 스크롤 상자를 만드는 overflow 값(hidden·auto·scroll — 한 축만 그래도 다른 축 visible이 auto로 바뀜)을 찾습니다.
 * 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError, auth: { logout: vi.fn() } };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({
  token: 0, reloadAll: () => {}, notifyUnauthorized: () => {}, requestRefresh: vi.fn(), collecting: false, message: null as string | null,
}));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("../../screens/search/__tests__/fakeNavigation"));

import { type Column, DataTable } from "@/components/patterns/DataTable";
import { SearchScreen } from "@/components/screens/search/SearchScreen";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { setLocation } from "../../screens/search/__tests__/fakeNavigation";
import { Shell } from "../Shell";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

/** 가상의 회사(합성 값). */
const ENTITY = {
  key: "us:EXMP", kind: "company", name: "예시전자", nameKo: "예시전자", nameEn: "Example Electronics Corp", aliases: ["Example Electronics"],
  description: "가상의 전자 회사",
  ids: { ticker: "EXMP", market: "us", stockCode: null, cik: null, dartCorpCode: null, wikidata: null, lei: null },
  links: [],
  sources: ["wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null, ...over,
  };
}

/** 이틀에 걸친 결과 — 날짜 머리 둘. */
const FEED = {
  available: true, entityKey: "us:EXMP", tab: "timeline",
  items: [row({ id: "r1", title: "첫째 기사" }), row({ id: "r2", title: "둘째 기사", publishedAt: "2026-11-13T10:00:00+00:00" })],
  sources: [{ source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 2, dropped: null, message: null }],
  window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 2, "30d": 2, "1y": 2, "2y": 2 },
  olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
};

type Row = { name: string };
const TABLE_COLUMNS: Column<Row>[] = [{ key: "name", header: "이름", cell: (r) => r.name }];

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  reads[endpoints.search.entity("us:EXMP")] = { available: true, entity: ENTITY, errors: {} };
  reads[endpoints.search.feed("us:EXMP", "timeline")] = FEED;
});
afterEach(() => cleanup());

/** 정보 검색 결과 화면을 셸 안에 그립니다(대시보드 레이아웃과 같은 감쌈). 고정 머리가 있는 표도 하나 함께 둡니다. */
function renderSearchInShell() {
  setLocation("/search?e=us:EXMP&tab=timeline&range=30d");
  return render(
    <SessionUserProvider user={MEMBER}>
      <Shell user={MEMBER} readMode="auto" unread={0}>
        <SearchScreen />
        <DataTable columns={TABLE_COLUMNS} rows={[{ name: "가" }, { name: "나" }]} rowKey={(r) => r.name} caption="예시 표" maxHeight={200} />
      </Shell>
    </SessionUserProvider>,
  );
}

/** 클래스 낱말의 변형(접두) 목록 — 대괄호 안의 콜론(supports-[overflow:clip]: 등)은 나누지 않습니다. */
function variantsOf(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth -= 1;
    else if (ch === ":" && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  return parts;
}

/** lg(1024px) 이상에서만 쓰이는 접두. 이것이 없는 낱말은 lg 미만에서도 쓰일 수 있습니다(상태 접두 hover: 등은 쓰이는 쪽으로 셈). */
const LG_AND_UP = new Set(["lg", "xl", "2xl"]);
function belowLg(tokens: string[]): string[] {
  return tokens.filter((token) => token && !variantsOf(token).some((variant) => LG_AND_UP.has(variant)));
}
function utility(token: string): string {
  const variants = variantsOf(token);
  return variants.length === 0 ? token : token.slice(variants.join(":").length + 1);
}

/** 스크롤 상자를 만드는 overflow 유틸리티. clip·visible은 만들지 않습니다(다른 축이 hidden·auto·scroll이 아니면). */
const SCROLL_BOX = /^overflow(-[xy])?-(hidden|auto|scroll)$/;
const HIDDEN = /^overflow(-[xy])?-hidden$/;

/** 요소의 클래스 낱말 — SVG 요소(className이 문자열이 아님)도 class 속성으로 읽습니다. */
function classTokens(element: Element): string[] {
  return (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** 이 요소가 lg 미만에서 갖는 overflow 값들(클래스 + 인라인 style). */
function belowLgOverflow(element: HTMLElement): string[] {
  const fromClass = belowLg(classTokens(element))
    .map(utility)
    .filter((name) => name.startsWith("overflow"));
  const style = element.style;
  const fromStyle = [
    style.overflow ? `overflow-${style.overflow}` : "",
    style.overflowX ? `overflow-x-${style.overflowX}` : "",
    style.overflowY ? `overflow-y-${style.overflowY}` : "",
  ].filter(Boolean);
  return [...fromClass, ...fromStyle];
}

/** 요소의 조상(부모부터 html까지). */
function ancestors(element: HTMLElement): HTMLElement[] {
  const chain: HTMLElement[] = [];
  for (let node = element.parentElement; node; node = node.parentElement) chain.push(node);
  return chain;
}

function describeNode(node: HTMLElement): string {
  return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}[${belowLgOverflow(node).join(" ")}]`;
}

describe("QA-450 — 1024 미만에서도 날짜 머리(sticky top-0)가 위에 붙는다", () => {
  // QA-450: 운영 화면 확인(390)에서 /search 결과 목록을 스크롤하면 날짜 머리(sticky top-0)가 화면 밖으로 사라져 지금 보이는 줄이 며칠 것인지
  // 알 수 없었고, ↑↓로 고른 줄 위의 28px(scroll-mt-7) 자리에는 날짜 머리 대신 앞 줄 꼬리가 보였습니다. 셸 본문 main의 overflow-x-hidden이
  // 다른 축(overflow-y: visible)을 auto로 바꿔 lg 미만에서 main을 스크롤 상자로 만들지만, 높이가 내용만큼이라 main은 스크롤하지 않고 창이
  // 스크롤합니다 — sticky는 스크롤하지 않는 main을 기준으로 붙으므로 붙지 않았습니다(lg 이상은 lg:overflow-y-auto로 main이 실제로 스크롤해 정상).
  // 수정 전 실패: main의 lg 미만 클래스에 overflow-x-hidden(스크롤 상자)이 있고 overflow-x-clip이 없음.
  it.fails("본문 main은 lg 미만에서 스크롤 상자가 아니다 — 가로 넘침은 overflow-x-clip으로 자르고, 세로 스크롤 상자는 lg부터(lg:overflow-y-auto)", () => {
    renderSearchInShell();
    const main = screen.getByRole("main");
    const tokens = classTokens(main);
    expect(tokens).toContain("overflow-x-clip");
    expect(belowLg(tokens).filter((token) => SCROLL_BOX.test(utility(token)))).toEqual([]);
    // lg 이상은 그대로 — 본문만 스크롤(lg:overflow-y-auto와 함께면 clip은 hidden으로 계산됨)·넓은 표가 페이지를 넓히지 않음·sr-only 글의 위치 기준.
    expect(tokens).toContain("lg:overflow-y-auto");
    expect(tokens).toContain("min-w-0");
    expect(tokens).toContain("relative");
  });

  // 수정 전 실패: 날짜 머리의 조상 main#main이 lg 미만에서 overflow-x-hidden(스크롤하지 않는 스크롤 상자).
  it.fails("lg 미만에서 쓰이는 sticky 요소는 overflow-hidden 조상 안에 있지 않고, 날짜 머리의 가장 가까운 스크롤 상자는 창이다", async () => {
    renderSearchInShell();
    const list = await screen.findByRole("listbox", { name: "결과" });
    const headers = within(list)
      .getAllByRole("group")
      .map((group) => group.firstElementChild as HTMLElement);
    expect(headers.length).toBe(2);
    for (const header of headers) expect(classTokens(header)).toEqual(expect.arrayContaining(["sticky", "top-0"]));

    // 셸 안의 lg 미만 sticky 요소 모두(날짜 머리 + 표 머리) — 스크롤하지 않는 상자(hidden) 안이면 붙지 않습니다.
    const sticky = Array.from(document.querySelectorAll<HTMLElement>("[class]")).filter((element) =>
      belowLg(classTokens(element)).includes("sticky"),
    );
    expect(sticky.length).toBeGreaterThanOrEqual(3);
    const hiddenAncestors = sticky.flatMap((element) =>
      ancestors(element)
        .filter((node) => belowLgOverflow(node).some((value) => HIDDEN.test(value)))
        .map(describeNode),
    );
    expect(hiddenAncestors).toEqual([]);

    // 날짜 머리는 창(문서)이 스크롤할 때 붙어야 합니다 — 사이에 lg 미만 스크롤 상자가 하나도 없어야 함(표 머리는 제 상자 안 — maxHeight).
    for (const header of headers) {
      expect(ancestors(header).filter((node) => belowLgOverflow(node).some((value) => SCROLL_BOX.test(value))).map(describeNode)).toEqual([]);
    }
  });
});
