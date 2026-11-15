/**
 * 정보 검색 결과 목록과 아래 시트의 다듬기 — QA-447(시트가 열린 채 창 폭이 바뀌면 고른 줄을 다시 보임). 응답은 모두 합성 값입니다(실제 응답
 * 원문을 쓰지 않음 — ADR 0026 결정 12).
 *
 * jsdom은 배치를 재지 않습니다. 아래 시트 시험은 SearchQaLayout의 시트 시험과 같은 틀로 시트의 계산된 위치(고정)·크기와 고른 줄의 화면 위
 * 자리를 가짜로 줍니다(배치 계산을 클래스·좌표 계약으로 시험 — 실제 화면은 QA 스택에서 잼).
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

import { BOTTOM_SHEET_VAR } from "@/hooks/useBottomSheet";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const NO_IDS = { ticker: null, market: null, stockCode: null, cik: null, dartCorpCode: null, wikidata: null, lei: null };
const TOPIC_KEY = "topic:합성 반도체 공급";
const TOPIC = { key: TOPIC_KEY, kind: "topic", name: "합성 반도체 공급", nameKo: null, nameEn: null, aliases: [], description: null, ids: NO_IDS, links: [], sources: [] };

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null, ...over,
  };
}

function feed(items: SearchFeedItem[]) {
  const count = items.length;
  return {
    available: true, entityKey: TOPIC_KEY, tab: "timeline", items,
    sources: [{ source: "google_en", label: "구글 뉴스(영어)", status: "ok", count, dropped: null, message: null }],
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": count, "30d": count, "1y": count, "2y": count },
    olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00",
  };
}

const FEED = feed([row({ id: "r1", title: "첫째 기사" }), row({ id: "r2", title: "둘째 기사", publishedAt: "2026-11-13T10:00:00+00:00" })]);

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

/** 주제 대상의 타임라인(30일)을 그립니다. */
async function renderFeed(data: unknown) {
  reads[endpoints.search.entity(TOPIC_KEY)] = { available: true, entity: TOPIC, errors: {} };
  reads[endpoints.search.feed(TOPIC_KEY, "timeline")] = data;
  setLocation(`/search?e=${encodeURIComponent(TOPIC_KEY)}&tab=timeline&range=30d`);
  render(
    <SessionUserProvider user={MEMBER}>
      <SearchScreen />
    </SessionUserProvider>,
  );
  return screen.findByRole("listbox", { name: "결과" });
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

describe("QA-447 — 아래 시트가 열린 채 휴대폰을 돌리면(창 폭이 바뀌면) 고른 줄이 화면 밖에 남음", () => {
  // QA 스택(390x844 → 844x390): 묶음 줄을 골라 시트(358~780, 422px)가 열린 채 휴대폰을 가로로 돌리면 시트가 50dvh(195px)로 줄고 줄 바꿈이
  // 달라져, 고른 줄이 -103~-59(화면 위)로 밀려난 채 남았습니다. 고른 줄을 다시 옮기는 효과가 '시트 높이가 바뀌고 그 줄이 시트·TOP 단추 띠에
  // 걸칠 때'만 봐서, 화면 위로(또는 시트 아래로) 밀려난 줄은 다루지 않습니다. 높이만 바뀐 때(휴대폰 주소 막대)는 사용자가 다른 곳으로 스크롤해
  // 둔 것일 수 있어 지금처럼 옮기지 않아야 합니다.
  const SHEET_TOP = 500;
  const SHEET_HEIGHT = 240;
  /** 시트의 높이 상한(50dvh) — 창 높이가 바뀌면(돌림·주소 막대) 시트가 이만큼으로 줄어듭니다. */
  let cap: number;
  /** 고른 줄의 화면 위 자리(위·아래 끝). */
  let selectedBox: { top: number; bottom: number };
  /** 본문(main#main)의 화면 위 위끝 — lg 이상은 본문이 스크롤 상자라 그 위(상단바·하위 메뉴 줄)는 줄이 보이지 않는 자리. */
  let mainTop: number;
  /** 고른 줄의 계산된 scroll-margin-top(scroll-mt-7 — jsdom은 Tailwind 클래스를 풀지 않으므로 가짜로 줌). 없으면 jsdom 그대로. */
  let rowMargin: string | null;
  let main: HTMLElement;
  let restore: (() => void)[];
  const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
  const setWidth = (value: number) => Object.defineProperty(window, "innerWidth", { configurable: true, enumerable: true, get: () => value });
  const isSheet = (element: Element) => element instanceof HTMLElement && element.className.split(/\s+/).includes("max-h-[50dvh]");
  const rect = (top: number, height: number) =>
    ({ x: 0, y: top, top, left: 0, right: 0, bottom: top + height, width: 0, height, toJSON: () => ({}) }) as DOMRect;
  const reserved = () => document.documentElement.style.getPropertyValue(BOTTOM_SHEET_VAR);
  /** 시트의 min-height(인라인 'min(Npx, 50dvh)')의 px — CSS처럼 상한(cap) 안에서만 받칩니다. */
  const minHeightOf = (element: HTMLElement) => Number(/^min\((\d+)px/.exec(element.style.minHeight)?.[1] ?? 0);
  const isSelectedRow = (element: Element) => element.getAttribute("role") === "option" && element.getAttribute("aria-selected") === "true";

  beforeEach(() => {
    cap = Number.POSITIVE_INFINITY;
    selectedBox = { top: 100, bottom: 144 };
    mainTop = 0;
    rowMargin = null;
    setWidth(390);
    const realStyle = window.getComputedStyle.bind(window);
    const style = vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element, pseudo?: string | null) => {
      if (isSheet(element)) return { position: "fixed" } as CSSStyleDeclaration;
      const real = realStyle(element, pseudo);
      if (rowMargin === null || !isSelectedRow(element)) return real;
      const margin = rowMargin;
      return new Proxy(real, {
        get: (target, key) => {
          if (key === "scrollMarginTop") return margin;
          const value: unknown = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const box = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (isSheet(this)) return rect(SHEET_TOP, Math.min(cap, Math.max(SHEET_HEIGHT, minHeightOf(this))));
      if (isSelectedRow(this)) return rect(selectedBox.top, selectedBox.bottom - selectedBox.top);
      if (this === main) return rect(mainTop, 0);
      return rect(0, 0);
    });
    main = document.createElement("main");
    main.id = "main";
    document.body.appendChild(main);
    restore = [() => style.mockRestore(), () => box.mockRestore()];
  });
  afterEach(() => {
    cleanup();
    restore.forEach((undo) => undo());
    main.remove();
    document.documentElement.style.removeProperty(BOTTOM_SHEET_VAR);
    if (width) Object.defineProperty(window, "innerWidth", width);
  });

  /** 둘째 줄을 눌러 시트를 엽니다 — 열린 뒤 옮긴 기록은 비웁니다(창 크기를 바꾼 뒤의 것만 봄). */
  async function openPreview() {
    const list = await renderFeed(FEED);
    const scrolled: Element[] = [];
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
      scrolled.push(this);
    });
    restore.push(() => scroll.mockRestore());
    const selected = within(list).getAllByRole("option")[1];
    fireEvent.click(selected);
    expect(reserved()).toBe(`${SHEET_HEIGHT}px`);
    scrolled.length = 0;
    return { row: selected, scrolled, scroll };
  }

  /** 창 크기를 바꿉니다 — 폭(돌리면 바뀜)과 시트 높이 상한(50dvh). */
  const resize = (nextWidth: number, nextCap: number) => {
    setWidth(nextWidth);
    cap = nextCap;
    fireEvent(window, new Event("resize"));
  };

  // QA-447: 수정 전 실패: 시트가 195px로 줄고 고른 줄이 -103~-59(화면 위)에 남는데 옮기지 않음(재현 커밋에서는 it.fails).
  it("돌려서(390 → 844) 고른 줄이 화면 위로 벗어나면 그 줄을 다시 옮긴다(nearest — 스크롤 여백을 따름)", async () => {
    const { row, scrolled, scroll } = await openPreview();
    selectedBox = { top: -103, bottom: -59 };
    resize(844, 195);
    expect(reserved()).toBe("195px");
    expect(scrolled).toEqual([row]);
    expect(scroll).toHaveBeenLastCalledWith({ block: "nearest" });
  });

  // QA-447: 수정 전 실패: 가로에서 세로로 돌려 줄 바꿈이 늘어 고른 줄이 시트 아래(760~804 — 시트 500~740 밑)로 밀려도 옮기지 않음.
  it("돌려서(844 → 390) 고른 줄이 시트 아래로 밀려나도 그 줄을 다시 옮긴다", async () => {
    setWidth(844);
    const { row, scrolled } = await openPreview();
    selectedBox = { top: 760, bottom: 804 };
    resize(390, 422);
    expect(scrolled).toEqual([row]);
  });

  it("창 폭이 그대로인 높이 변화(휴대폰 주소 막대)에서는 화면 위로 스크롤해 둔 고른 줄을 옮기지 않는다", async () => {
    const { scrolled } = await openPreview();
    selectedBox = { top: -103, bottom: -59 };
    resize(390, 195);
    expect(reserved()).toBe("195px");
    expect(scrolled).toEqual([]);
  });

  it("창 폭이 바뀌어도 고른 줄이 보이는 자리(화면 위끝 ~ 시트 위 TOP 단추 띠)에 있으면 옮기지 않는다", async () => {
    const { scrolled } = await openPreview();
    selectedBox = { top: 100, bottom: 144 };
    resize(844, 195);
    expect(reserved()).toBe("195px");
    expect(scrolled).toEqual([]);
  });

  // 태블릿을 돌릴 때(1024 ↔ 768) 등 — lg 이상은 본문 main이 스크롤 상자라 그 위끝(상단바 아래)이 보이는 자리의 위끝이고, 날짜 머리가 거기 붙으므로
  // 줄의 scroll-margin-top(28px)만큼 더 아래부터 보입니다. nearest로 옮기면 줄이 멈추는 자리와 같은 경계.
  it("보이는 자리의 위끝은 스크롤 상자(본문 main)의 위끝 + 줄의 scroll-margin-top(붙는 날짜 머리 자리) — 그 위에 걸친 줄만 옮긴다", async () => {
    setWidth(1024);
    mainTop = 104;
    rowMargin = "28px";
    const { row, scrolled } = await openPreview();
    selectedBox = { top: 140, bottom: 172 };
    resize(768, 195);
    expect(scrolled).toEqual([]);
    selectedBox = { top: 120, bottom: 152 };
    resize(1024, 195);
    expect(scrolled).toEqual([row]);
  });
});

describe("묶음 미리 보기의 펼치는 법은 머리 바로 아래(QA 스택 기록 R1-SG1-N2)", () => {
  // QA 스택(1024·390): 다른 보도가 5건 넘는 묶음은 미리 보기가 시트의 50dvh 상한(384·422px)에 닿아, 끝에 둔 펼치는 법('펼치기: 결과 목록에서
  // Enter …')이 처음에는 시트 밑으로 48~54px 밀려 시트 안을 스크롤해야 보였습니다. jsdom은 배치를 재지 않으므로 그린 차례로 봅니다 — 머리(건수·
  // 매체 수) 바로 다음이고 대표 줄·다른 보도 목록보다 앞.
  const at = (hour: number) => `2026-11-13T${String(hour).padStart(2, "0")}:00:00+00:00`;
  const BIG = feed([
    row({ id: "b0", title: "큰 묶음 대표", clusterId: "b0", cluster: { size: 8, publishers: 8 }, publisher: "P0", publishedAt: at(1) }),
    ...Array.from({ length: 7 }, (_, index) =>
      row({ id: `b${index + 1}`, title: `큰 묶음 보도 ${index + 1}`, clusterId: "b0", publisher: `P${index + 1}`, publishedAt: at(index + 2) }),
    ),
  ]);
  const follows = (first: Node, second: Node) => (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

  it("접혀 있든 펼쳤든 펼치기·접기 안내가 머리 바로 다음, 대표 줄·다른 보도보다 앞에 있다", async () => {
    const list = await renderFeed(BIG);
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /같은 사건 8건 · 매체 8곳/ }).getAttribute("aria-selected")).toBe("true");
    for (const hint of [/^펼치기: 결과 목록에서 Enter.*나머지 7건이 대표 줄 아래에 나옵니다/, /^접기: 결과 목록에서 Enter/]) {
      const preview = screen.getByRole("region", { name: "미리 보기" });
      const heading = within(preview).getByText("같은 사건 8건 · 매체 8곳");
      const note = within(preview).getByText(hint);
      expect(heading.nextElementSibling).toBe(note);
      expect(follows(note, within(preview).getByText("대표 보도 — 가장 이른 줄"))).toBe(true);
      expect(follows(note, within(preview).getByRole("list", { name: "같은 사건의 다른 보도" }))).toBe(true);
      fireEvent.keyDown(list, { key: "Enter" });
    }
  });
});

describe("결과 줄을 두 번 눌러 원문 열기는 마우스만(QA 스택 기록 R3-SG3-4)", () => {
  // QA 스택(390, 터치): 결과 줄을 120ms 간격으로 두 번 탭하면 브라우저가 dblclick을 내 원문 새 창이 열렸습니다(그 줄의 미리 보기 시트도 열림).
  // 두 번 눌러 열기는 데스크톱 단축 동작이라 마우스로만 — 터치·펜은 고르기(미리 보기)만 하고, 원문은 미리 보기의 '원문 열기'나 Enter로 엽니다.
  it("터치·펜으로 두 번 누르면 원문을 열지 않고 줄만 고른다 — 마우스로 두 번 누르거나 Enter면 연다", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      const list = await renderFeed(FEED);
      const target = within(list).getAllByRole("option")[0];
      for (const pointerType of ["touch", "pen"]) {
        for (let tap = 0; tap < 2; tap += 1) {
          fireEvent.pointerDown(target, { pointerType });
          fireEvent.click(target);
        }
        fireEvent.doubleClick(target);
      }
      expect(open).not.toHaveBeenCalled();
      expect(target.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("region", { name: "미리 보기" })).toBeTruthy();

      fireEvent.pointerDown(target, { pointerType: "mouse" });
      fireEvent.doubleClick(target);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenLastCalledWith("https://news.example/a", "_blank", "noopener,noreferrer");

      // Enter는 마지막 포인터와 상관없이 엶.
      fireEvent.pointerDown(target, { pointerType: "touch" });
      fireEvent.keyDown(list, { key: "Enter" });
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      open.mockRestore();
    }
  });
});
