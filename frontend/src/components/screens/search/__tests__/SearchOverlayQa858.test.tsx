/**
 * 정보 검색의 덮개 두 곳이 3층 덮개 토큰을 따르지 않음 — QA-858(D1 결정 거리 `search-overlays-not-overlay-tokens`, 작업대 화면 언어 실행 명세
 * docs/specs/2026-11-15-v2-workbench-ui.md §3-3 '덮개 — 바탕 surface-2, 안쪽 1px 밝은 경계(border-overlay), 바깥 그림자, 덮개 안 hover·눌림 surface-3').
 *
 * 1. 입력 후보 목록(SearchBox — 입력칸 아래에 뜬 목록): 바탕 surface-2·그림자는 맞았으나 경계가 패널 경계(border)였고, 고른 줄이 surface(덮개보다 어두운 면)였습니다.
 *    고른 줄은 덮개 안 눌림 면 surface-3이고, 그 위 글자는 text·text-2만(surface-3 위 text-3 금지 — 명세 §3-2).
 * 2. xl 미만의 아래 미리 보기 시트(FeedPanel — 화면 아래에 고정된 덮개): 바탕 surface(패널 면)·경계 border-strong이었습니다. 덮개 바탕 surface-2·
 *    경계 border-overlay이고, 안에 단추가 있으므로 덮개 표지(data-overlay — 공용 단추의 바탕이 한 단계 위 surface-3)를 붙입니다. 고정이 아닌 xl의 오른쪽 칸
 *    (흐름 안)은 지금 모양(바탕 surface·왼쪽 경계 border-strong·표지 없음) 그대로입니다. 시트 안의 요약 상자·닫기 단추 hover는 놓인 면보다 한 단계 위
 *    (조작 바탕 control-fill — 시트 안 surface-3, xl 칸 surface-2)라 덮개 바탕에 묻히지 않습니다.
 * jsdom은 배치를 재지 않으므로 시트가 고정인 것은 SearchQaLayout 시험과 같은 방식으로 흉내 냅니다(계산 스타일 position fixed·높이). 요청은 그대로입니다.
 * 수정 전(재현 커밋에서는 두 사례 it.fails): 목록 "expected [ 'absolute', 'inset-x-0', …(11) ] to deeply equal ArrayContaining{…}"(border-overlay 없음),
 * 시트 "expected false to be true"(data-overlay 없음).
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
import { SearchBox } from "../SearchBox";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA"], description: null,
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: null, dartCorpCode: null, wikidata: null, lei: null }, links: [], sources: ["sec"],
};
function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: "합성 요약", readerId: null, ...over,
  };
}
const FEED = {
  available: true, entityKey: "us:NVDA", tab: "timeline",
  items: [row({ id: "r1", title: "첫째 기사" }), row({ id: "r2", title: "둘째 기사", publishedAt: "2026-11-13T10:00:00+00:00" })],
  sources: [{ source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 2, dropped: null, message: null }],
  window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 2, "30d": 2, "1y": 2, "2y": 2 },
  olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
};

let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}
const classesOf = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiGetShared]) {
    fn.mockReset();
    fn.mockImplementation((path: string) => serve(path));
  }
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("입력 후보 목록 — 덮개 토큰(QA-858)", () => {
  it.fails("목록은 surface-2 바탕·밝은 경계(border-overlay)·그림자, ↓로 고른 줄은 surface-3이고 그 위 글자에 text-3이 없다", async () => {
    vi.useFakeTimers();
    reads[endpoints.search.suggest("엔비")] = {
      available: true, items: [{ key: "us:NVDA", kind: "company", name: "엔비디아", sub: "NVDA · 미국", source: "sec" }],
    };
    render(<SearchBox initial={null} onSubmit={() => {}} onChoose={() => {}} />);
    const input = screen.getByRole("combobox", { name: "대상 검색" });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "엔비" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    const list = screen.getByRole("listbox", { name: "입력 후보" });
    expect(classesOf(list)).toEqual(expect.arrayContaining(["bg-surface-2", "border-border-overlay", "shadow-overlay"]));
    expect(classesOf(list)).not.toContain("border-border");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    const option = within(list).getByRole("option", { name: /엔비디아/ });
    expect(option.getAttribute("aria-selected")).toBe("true");
    expect(classesOf(option)).toContain("bg-surface-3");
    expect(classesOf(option)).not.toContain("bg-surface");
    const inks = [option, ...option.querySelectorAll("*")].flatMap((element) => classesOf(element)).filter((token) => /^text-text-3$|^text-accent$|^text-danger$/.test(token));
    expect(inks).toEqual([]);
  });
});

describe("xl 미만 아래 미리 보기 시트 — 덮개 토큰(QA-858)", () => {
  const SHEET_HEIGHT = 240;
  let restore: (() => void)[] = [];
  const isSheet = (element: Element) => element instanceof HTMLElement && element.className.split(/\s+/).includes("max-h-[50dvh]");

  beforeEach(() => {
    const realStyle = window.getComputedStyle.bind(window);
    const style = vi
      .spyOn(window, "getComputedStyle")
      .mockImplementation((element: Element, pseudo?: string | null) => (isSheet(element) ? ({ position: "fixed" } as CSSStyleDeclaration) : realStyle(element, pseudo)));
    const box = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const height = isSheet(this) ? SHEET_HEIGHT : 0;
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: height, width: 0, height, toJSON: () => ({}) } as DOMRect;
    });
    restore = [() => style.mockRestore(), () => box.mockRestore()];
  });
  afterEach(() => {
    cleanup();
    restore.forEach((undo) => undo());
    document.documentElement.style.removeProperty("--bottom-sheet");
  });

  it.fails("고정 시트는 surface-2 바탕·밝은 경계·그림자와 덮개 표지(data-overlay), xl 오른쪽 칸은 지금 모양(surface·border-strong) — 안의 요약 상자·닫기 hover는 한 단계 위 면", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    setLocation("/search?e=us:NVDA&tab=timeline&range=30d");
    render(
      <SessionUserProvider user={MEMBER}>
        <SearchScreen />
      </SessionUserProvider>,
    );
    const list = await screen.findByRole("listbox", { name: "결과" });
    fireEvent.click(within(list).getAllByRole("option")[1]);
    const preview = screen.getByRole("region", { name: "미리 보기" });
    const sheet = preview.parentElement?.parentElement as HTMLElement;
    await waitFor(() => expect(sheet.hasAttribute("data-overlay")).toBe(true));
    const tokens = classesOf(sheet);
    expect(tokens).toEqual(expect.arrayContaining(["fixed", "bg-surface-2", "border-border-overlay", "shadow-overlay"]));
    expect(tokens).not.toContain("bg-surface");
    expect(tokens).not.toContain("border-border-strong");
    // xl(흐름 안의 오른쪽 칸)은 지금 모양 그대로.
    expect(tokens).toEqual(expect.arrayContaining(["xl:static", "xl:bg-surface", "xl:border-border-strong", "xl:border-l", "xl:border-t-0", "xl:shadow-none"]));
    // 안의 요약 상자·닫기 단추 hover는 놓인 면보다 한 단계 위(조작 바탕 — 시트 안 surface-3, xl 칸 surface-2).
    expect(classesOf(within(preview).getByText("합성 요약"))).toContain("bg-control-fill");
    expect(classesOf(within(preview).getByRole("button", { name: "미리 보기 닫기" }))).toContain("hover:bg-control-fill");
  });
});
