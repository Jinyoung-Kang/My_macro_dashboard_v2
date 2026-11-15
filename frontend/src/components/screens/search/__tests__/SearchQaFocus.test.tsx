/**
 * 정보 검색 대상 화면의 포커스 — 누른 단추가 사라질 때 옮길 자리(QA-430·QA-434 — WCAG 2.4.3)와 코드가 포커스를 보내는 자리의 포커스 테두리
 * (QA-433 — WCAG 2.4.7). 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *
 * 미리 보기는 창 폭마다 자리(xl 미만은 아래 시트, xl은 오른쪽 칸)만 다르고 닫는 동작은 같으므로 jsdom에서 한 번에 봅니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
import { endpoints } from "@/lib/endpoints";
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: "미국의 반도체 기업",
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: null },
  links: [],
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

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

function renderScreen(path: string, user: SessionUser = MEMBER) {
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
  reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
  reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
});
afterEach(() => cleanup());

/** 결과 목록에 포커스를 두고 Home으로 첫 줄을 골라 미리 보기를 엽니다(QA 확인의 순서). */
async function openFirstPreview() {
  renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
  const list = await screen.findByRole("listbox", { name: "결과" });
  list.focus();
  fireEvent.keyDown(list, { key: "Home" });
  const first = within(list).getAllByRole("option")[0];
  expect(first.getAttribute("aria-selected")).toBe("true");
  const preview = screen.getByRole("region", { name: "미리 보기" });
  return { list, first, preview };
}

describe("QA-430 — 미리 보기 닫기 단추로 닫으면 포커스가 결과 목록으로 간다(Escape와 같은 자리)", () => {
  // QA-430: 정보 검색 QA 스택 브라우저 확인(1024·390 아래 시트, 1440 오른쪽 칸)에서 '미리 보기 닫기'를 키보드(Enter)·마우스로 누르면 단추가
  // 미리 보기째 DOM에서 사라지고 document.activeElement가 BODY가 됐습니다. 다음 Tab은 같은 자리에 새로 생긴 속성 칸의 '별칭 편집'으로 갔고,
  // Escape로 닫으면 포커스가 결과 목록에 남아 두 닫기의 결과가 달랐습니다(WCAG 2.4.3). 브라우저는 단추 위 Enter·Space를 click으로 바꾸고
  // 마우스로 누르면 단추에 포커스가 먼저 가므로, 포커스를 둔 뒤 click으로 누릅니다. 목록은 페이지가 튀지 않게 preventScroll로 받습니다.
  // 수정 전 실패: document.activeElement가 결과 목록이 아니라 body.
  it("닫기 단추를 누르면 미리 보기가 닫히고 포커스는 결과 목록(preventScroll) — ↓가 그 목록에서 이어 간다", async () => {
    const { list, preview } = await openFirstPreview();
    const focus = vi.spyOn(list, "focus");
    const close = within(preview).getByRole("button", { name: "미리 보기 닫기" });
    close.focus();
    expect(document.activeElement).toBe(close);
    fireEvent.click(close);
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
    // 포커스가 목록에 있으므로 ↓가 곧바로 닫기 전 줄(첫 줄)의 다음 줄을 고릅니다(Escape로 닫은 뒤와 같음 — 아래 '닫은 뒤 ↑↓' 시험).
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[1].getAttribute("aria-selected")).toBe("true");
  });

  it("Escape로 닫아도 포커스는 결과 목록에 그대로 — 두 닫기의 자리가 같다", async () => {
    const { list } = await openFirstPreview();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
  });
});

describe("개선 제안 — 미리 보기 안에 포커스가 있을 때도 Escape로 닫는다(포커스는 결과 목록)", () => {
  // 개선 제안(QA 스택 재확인 3, 390·1024·1180): 미리 보기 시트의 Escape 닫기는 결과 목록에 포커스가 있을 때만(onListKeyDown)이라, 시트 안의
  // '원문 열기'·'받아 둔 글 보기'·닫기 단추에 포커스가 있으면 Escape가 아무것도 하지 않았습니다. 목록에서와 같이 닫고 포커스를 결과 목록(닫기
  // 단추와 같은 자리 — QA-430)으로 옮깁니다. 원문 팝업이 열려 있으면 그 Escape는 팝업만 닫습니다(한 번에 둘을 닫지 않음).
  // 수정 전 실패: 미리 보기 안의 Escape 뒤에도 미리 보기가 그대로.
  it("'원문 열기'·닫기 단추에서 Escape — 미리 보기를 닫고 포커스는 결과 목록", async () => {
    const { list, preview } = await openFirstPreview();
    const link = within(preview).getByRole("link", { name: /원문 열기/ });
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);

    fireEvent.keyDown(list, { key: "Home" });
    const close = within(screen.getByRole("region", { name: "미리 보기" })).getByRole("button", { name: "미리 보기 닫기" });
    close.focus();
    fireEvent.keyDown(close, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
  });

  it("이미 다른 층(대화상자 등)이 처리한 Escape는 미리 보기를 닫지 않는다", async () => {
    const { preview } = await openFirstPreview();
    const link = within(preview).getByRole("link", { name: /원문 열기/ });
    link.focus();
    // Radix 대화상자처럼 문서 캡처 단계에서 Escape를 받아 처리한 층.
    const layer = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", layer, { capture: true });
    try {
      fireEvent.keyDown(link, { key: "Escape" });
    } finally {
      document.removeEventListener("keydown", layer, { capture: true });
    }
    expect(screen.getByRole("region", { name: "미리 보기" })).toBe(preview);
    expect(document.activeElement).toBe(link);
  });

  it("원문 팝업이 열려 있으면 Escape는 팝업만 닫고, 포커스가 '받아 둔 글 보기'로 돌아온 뒤의 Escape가 미리 보기를 닫는다", async () => {
    const READER = "0123456789abcdef01234567";
    reads[endpoints.search.feed("us:NVDA", "timeline")] = {
      ...FEED,
      items: [row({ id: "q1", title: "받아 둔 글 확인용", kind: "post", source: "info", readerId: READER }), ...FEED.items],
      rangeCounts: { "7d": 3, "30d": 3, "1y": 3, "2y": 3 },
    };
    reads[endpoints.info.item(READER)] = { available: true, item: { id: READER, body: "받아 둔 본문", summary: null } };
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d", OWNER);
    const list = await screen.findByRole("listbox", { name: "결과" });
    fireEvent.click(within(list).getByRole("option", { name: /받아 둔 글 확인용/ }));
    const preview = screen.getByRole("region", { name: "미리 보기" });
    const read = within(preview).getByRole("button", { name: "받아 둔 글 보기" });
    read.focus();
    fireEvent.click(read);
    const dialog = await screen.findByRole("dialog", { name: "받아 둔 글 확인용" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "미리 보기" })).toBe(preview);
    await waitFor(() => expect(document.activeElement).toBe(read));
    fireEvent.keyDown(read, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
  });

  // 2차 검토 지적: 위 시험은 팝업이 React 트리에서 미리 보기 밖(FeedPanel 루트)에 그려져 팝업 안의 키가 미리 보기의 onKeyDown에 오지 않아서
  // 통과하므로, 미리 보기의 두 가드(이미 처리된 Escape·팝업이 열려 있는 동안)를 지워도 통과했습니다. React 합성 이벤트는 포털 안에서 나도 React
  // 트리를 따라 올라가므로 팝업을 미리 보기 안으로 옮기면 팝업의 Escape가 미리 보기의 onKeyDown을 지납니다 — 그 길을 미리 보기 안의 단추에서 낸
  // Escape로 직접 거칩니다. 팝업(Radix)이 문서 캡처 단계에서 받아 닫고, 미리 보기는 그대로(두 가드를 모두 지우면 실패).
  it("원문 팝업이 열려 있는 동안 미리 보기 영역을 지나는 Escape는 팝업만 닫는다 — 미리 보기의 가드를 직접 거침", async () => {
    const READER = "0123456789abcdef01234567";
    reads[endpoints.search.feed("us:NVDA", "timeline")] = {
      ...FEED,
      items: [row({ id: "q1", title: "받아 둔 글 확인용", kind: "post", source: "info", readerId: READER }), ...FEED.items],
      rangeCounts: { "7d": 3, "30d": 3, "1y": 3, "2y": 3 },
    };
    reads[endpoints.info.item(READER)] = { available: true, item: { id: READER, body: "받아 둔 본문", summary: null } };
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d", OWNER);
    const list = await screen.findByRole("listbox", { name: "결과" });
    fireEvent.click(within(list).getByRole("option", { name: /받아 둔 글 확인용/ }));
    const preview = screen.getByRole("region", { name: "미리 보기" });
    const read = within(preview).getByRole("button", { name: "받아 둔 글 보기" });
    read.focus();
    fireEvent.click(read);
    await screen.findByRole("dialog", { name: "받아 둔 글 확인용" });
    fireEvent.keyDown(read, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("region", { name: "미리 보기" })).toBe(preview);
  });
});

describe("개선 제안 — 미리 보기를 닫은 뒤 ↑↓는 닫기 전에 고른 줄에서 이어 간다", () => {
  // 개선 제안(QA 스택 재확인 5, 390·1024·1280): End로 마지막 줄을 고른 뒤 닫기 단추나 Escape로 닫으면 고른 줄이 풀리고(aria-activedescendant
  // 없음) ↓가 첫 줄을 골라 목록 맨 위로 돌아갔습니다(390에서 658px, 1024에서 381px 위로). 닫기 전 줄을 기억해 ↓·↑는 그 다음·앞 줄을 고르고,
  // Home·End는 그대로 양 끝, 목록이 바뀌면(거르기·기간·자료) 잊습니다. 닫은 뒤에는 고른 줄이 없는 것도 그대로입니다.
  // 수정 전 실패: 닫은 뒤의 ↑가 첫 줄을 고름.
  const FIVE = {
    ...FEED,
    items: [1, 2, 3, 4, 5].map((at) => row({ id: `n${at}`, title: `기사 ${at}`, publishedAt: `2026-11-13T0${at}:00:00+00:00` })),
    rangeCounts: { "7d": 5, "30d": 5, "1y": 5, "2y": 5 },
  };
  /** 지금 고른 줄의 제목(없으면 null). */
  const selectedTitle = (list: HTMLElement) =>
    within(list)
      .getAllByRole("option")
      .find((option) => option.getAttribute("aria-selected") === "true")
      ?.textContent?.replace(/^.*?(기사 \d)$/, "$1") ?? null;

  async function openList() {
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FIVE;
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    list.focus();
    return list;
  }

  it("Escape로 닫은 뒤 ↑는 닫기 전 줄의 앞 줄, ↓는 다음 줄 — 닫은 동안은 고른 줄이 없다", async () => {
    const list = await openList();
    fireEvent.keyDown(list, { key: "End" });
    expect(selectedTitle(list)).toBe("기사 1");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
    expect(selectedTitle(list)).toBeNull();
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedTitle(list)).toBe("기사 2");
    fireEvent.keyDown(list, { key: "Escape" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedTitle(list)).toBe("기사 1");
  });

  it("닫기 단추·미리 보기 안의 Escape로 닫아도 같다 — 가운데 줄에서 닫으면 ↓는 그 다음 줄", async () => {
    const list = await openList();
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selectedTitle(list)).toBe("기사 3");
    const close = within(screen.getByRole("region", { name: "미리 보기" })).getByRole("button", { name: "미리 보기 닫기" });
    close.focus();
    fireEvent.click(close);
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(selectedTitle(list)).toBe("기사 2");
    const link = within(screen.getByRole("region", { name: "미리 보기" })).getByRole("link", { name: /원문 열기/ });
    link.focus();
    fireEvent.keyDown(link, { key: "Escape" });
    expect(document.activeElement).toBe(list);
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(selectedTitle(list)).toBe("기사 3");
  });

  it("Home·End는 닫은 뒤에도 양 끝", async () => {
    const list = await openList();
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Escape" });
    fireEvent.keyDown(list, { key: "Home" });
    expect(selectedTitle(list)).toBe("기사 5");
    fireEvent.keyDown(list, { key: "Escape" });
    fireEvent.keyDown(list, { key: "End" });
    expect(selectedTitle(list)).toBe("기사 1");
  });

  it("목록이 바뀌면(거르기를 바꿨다 되돌려도) 잊고 ↓는 첫 줄부터", async () => {
    const list = await openList();
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "Escape" });
    const pane = screen.getByRole("region", { name: "거르기" });
    fireEvent.click(within(pane).getByRole("checkbox", { name: "영어 5건" }));
    fireEvent.click(within(pane).getByRole("checkbox", { name: "영어 5건" }));
    const again = screen.getByRole("listbox", { name: "결과" });
    again.focus();
    fireEvent.keyDown(again, { key: "ArrowDown" });
    expect(selectedTitle(again)).toBe("기사 5");
  });
});

/**
 * Tailwind v4가 :focus-visible에서 그리는 바깥선의 모양·폭 — jsdom은 Tailwind CSS를 계산하지 않으므로 클래스 목록으로 셉니다.
 * v4의 outline-<n>은 선 모양을 var(--tw-outline-style)(@property 처음 값 solid)에서 읽고, outline-none·outline-hidden은 그 변수까지 none으로
 * 둡니다(설치된 tailwindcss 4.3.5의 dist/lib.js). 그래서 outline-none 옆의 focus-visible:outline-2는 폭·색만 바꾸고 선을 그리지 않습니다.
 * 변형은 바탕 클래스보다 뒤에 나오므로(focus → focus-visible 순) 그 순서로 덮어 씁니다. 폭 클래스가 없으면 width는 null입니다.
 */
function focusVisibleOutline(className: string): { style: string; width: string | null } {
  const tokens = className.split(/\s+/).filter(Boolean);
  let style = "solid";
  let width: string | null = null;
  for (const variant of ["", "focus:", "focus-visible:"]) {
    for (const token of tokens) {
      if (variant && !token.startsWith(variant)) continue;
      const rest = token.slice(variant.length);
      if (rest.includes(":")) continue; // 다른 변형(hover: 등)
      const shape = /^outline-(none|hidden|solid|dashed|dotted|double)$/.exec(rest);
      if (shape) style = shape[1] === "hidden" ? "none" : shape[1];
      const size = /^outline(?:-(\d+))?$/.exec(rest);
      if (size) width = size[1] ?? "1";
    }
  }
  return { style, width };
}

/** :focus-visible 바깥선의 offset(px) — outline-offset-<n>은 n px, -outline-offset-<n>은 -n px, 없으면 0(브라우저 처음 값). */
function focusVisibleOutlineOffset(className: string): number {
  let offset = 0;
  for (const variant of ["", "focus:", "focus-visible:"]) {
    for (const token of className.split(/\s+/)) {
      if (variant && !token.startsWith(variant)) continue;
      const hit = /^(-?)outline-offset-(\d+)$/.exec(token.slice(variant.length));
      if (hit) offset = (hit[1] ? -1 : 1) * Number(hit[2]);
    }
  }
  return offset;
}

/** 포커스 테두리를 그리겠다는 클래스(focus:·focus-visible:의 바깥선 폭)가 있는 조각. */
const FOCUS_OUTLINE_WIDTH = /(?:^|\s)(?:focus|focus-visible):outline(?:-\d+)?(?:\s|$)/;

/** 포커스 테두리를 그리겠다면서(폭) 계산한 선 모양이 none인 클래스 묶음인가. */
const erasesFocusOutline = (classes: string) => FOCUS_OUTLINE_WIDTH.test(classes) && focusVisibleOutline(classes).style === "none";

/** 대문자 상수 정의(`const FOCUS = "…"`, 백틱도) — 여는 따옴표까지. */
const CONSTANT_START = /(?:^|\n)[ \t]*(?:export[ \t]+)?const[ \t]+([A-Z][A-Z0-9_]*)[ \t]*=[ \t]*(["'`])/g;

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

/** start의 따옴표를 닫는 자리. 백틱 안의 ${…}는 중괄호 깊이로 건넙니다. */
function closingQuote(source: string, start: number): number {
  const quote = source[start];
  let depth = 0;
  for (let at = start + 1; at < source.length; at++) {
    const char = source[at];
    if (char === "\\") at++;
    else if (quote === "`" && char === "$" && source[at + 1] === "{") {
      depth++;
      at++;
    } else if (depth > 0) {
      if (char === "{") depth++;
      else if (char === "}") depth--;
    } else if (char === quote) return at;
  }
  return source.length;
}

/** className= 뒤 식(따옴표 하나 또는 중괄호 한 덩이 — 여러 줄 가능)이 끝나는 자리. 식이 아니면 -1. */
function expressionEnd(source: string, start: number): number {
  const open = source[start];
  if (open === '"' || open === "'") return closingQuote(source, start);
  if (open !== "{") return -1;
  let depth = 0;
  for (let at = start; at < source.length; at++) {
    const char = source[at];
    if (char === '"' || char === "'" || char === "`") at = closingQuote(source, at);
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return at;
  }
  return source.length;
}

/**
 * outline-none·outline-hidden이 focus(-visible):outline-<n>의 선을 지우는 자리(경로:줄). 세 가지로 봅니다.
 * (1) 한 줄을 따옴표·백틱·중괄호로 나눈 조각 하나(문자열 하나). (2) className= 뒤의 식 하나(여러 줄 템플릿, cn("…", "…")처럼 나눈 인자,
 * 삼항의 두 갈래까지 한 덩이로 — 걸리면 갈래를 따로 확인). (3) 대문자 상수 정의 하나. (2)·(3)은 식 안의 대문자 이름을 상수의 글로 풀어
 * 합칩니다(같은 파일 정의를 먼저, 없으면 다른 파일의 같은 이름 전부 — `${FOCUS} outline-none`). 함수가 돌려주는 클래스·소문자 변수·props로
 * 넘긴 클래스는 보지 못합니다.
 */
function outlineOffenders(files: { path: string; source: string }[]): string[] {
  const shared = new Map<string, string[]>();
  const local = new Map<string, Map<string, string[]>>();
  const definitions: { path: string; line: number; value: string }[] = [];
  for (const { path, source } of files) {
    const own = new Map<string, string[]>();
    for (const match of source.matchAll(CONSTANT_START)) {
      const quote = (match.index ?? 0) + match[0].length - 1;
      const value = source.slice(quote + 1, closingQuote(source, quote));
      for (const map of [own, shared]) map.set(match[1], [...(map.get(match[1]) ?? []), value]);
      definitions.push({ path, line: lineOf(source, quote), value });
    }
    local.set(path, own);
  }
  const classesOf = (path: string, text: string): string => {
    const expand = (part: string, depth: number): string =>
      depth > 4
        ? part
        : part.replace(/\b[A-Z][A-Z0-9_]*\b/g, (name) => {
            const values = local.get(path)?.get(name) ?? shared.get(name);
            return values ? ` ${values.map((value) => expand(value, depth + 1)).join(" ")} ` : name;
          });
    return expand(text, 0).split(/[\s"'`{}(),$]+/).join(" ");
  };
  const offenders = new Set<string>();
  for (const { path, source } of files) {
    source.split("\n").forEach((line, index) => {
      if (line.split(/["'`{}]/).some(erasesFocusOutline)) offenders.add(`${path}:${index + 1}`);
    });
    for (const match of source.matchAll(/className=/g)) {
      const start = (match.index ?? 0) + match[0].length;
      const end = expressionEnd(source, start);
      if (end >= 0 && erasesFocusOutline(classesOf(path, source.slice(start, end + 1)))) {
        offenders.add(`${path}:${lineOf(source, match.index ?? 0)}`);
      }
    }
  }
  for (const { path, line, value } of definitions) {
    if (erasesFocusOutline(classesOf(path, value))) offenders.add(`${path}:${line}`);
  }
  return [...offenders].sort();
}

describe("QA-433 — 코드가 포커스를 보내는 결과 칸 세 자리는 키보드 포커스 테두리를 그린다", () => {
  // QA-433: 정보 검색 QA 스택 브라우저 확인(1024·1440·390)에서 미리 보기를 닫은 뒤(QA-430)·Tab으로 들어온 결과 목록(listbox '결과'),
  // '다시 확인' 뒤의 받는 중 줄(p[role=status]), 기간을 풀거나 다시 확인한 뒤의 빈 결과 안내(div[role=status])가 :focus-visible인데
  // outline-style이 none이라(폭 2px·색만 바뀜) 화면에 포커스 자리가 보이지 않았습니다(WCAG 2.4.7). 세 자리의 className이
  // 'outline-none focus-visible:outline-2 …'였고, Tailwind v4의 outline-none은 --tw-outline-style까지 none으로 둬 focus-visible:outline-2가
  // 선 모양을 되살리지 못합니다. jsdom은 Tailwind CSS를 계산하지 않으므로 클래스 목록으로 :focus-visible의 선 모양·폭을 계산해
  // (focusVisibleOutline) 실선 2px인지 봅니다(같은 화면 단추의 FOCUS 상수와 같은 모양).
  // 수정 전 실패: 세 자리 모두 선 모양이 none.
  it("결과 목록(listbox)은 :focus-visible에서 실선 2px 테두리를 그린다", async () => {
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    expect(focusVisibleOutline(list.className)).toEqual({ style: "solid", width: "2" });
  });

  // 검토 지적: 목록의 테두리를 안쪽(-outline-offset-2)에 그리면 위치를 가진 자식(sticky 날짜 머리 z-10·고른 줄 relative, 둘 다 불투명 바탕)이
  // 나중에 칠해져 테두리를 덮습니다 — Chromium 재현에서 날짜 머리·고른 줄 높이마다 좌우 변이 끊기고 윗변이 보이지 않았습니다. jsdom은 칠하는
  // 차례를 계산하지 않으므로 테두리가 상자 바깥(offset 0 이상)에 있다는 클래스 약속으로 봅니다.
  it("결과 목록의 테두리는 상자 바깥(offset 0 이상)에 그려 날짜 머리·고른 줄이 덮지 못한다", async () => {
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const header = within(list).getAllByRole("group")[0].firstElementChild as HTMLElement;
    expect(header.className).toMatch(/(?:^|\s)sticky(?:\s|$)/); // 덮을 수 있는 자식이 아직 있다(이 시험이 지키는 까닭)
    expect(focusVisibleOutlineOffset(list.className)).toBeGreaterThanOrEqual(0);
  });

  // QA-433 후속(QA 스택 재확인 3, 1280·1440): 바깥에 그린 목록 테두리의 오른쪽 변이 xl 오른쪽 칸(같은 칸 틀의 뒤 형제 — border-l·불투명
  // bg-surface)에 덮였습니다(오른쪽 변 0/836px, 보이는 것은 1px). 뒤에 오는 형제는 위치가 없어도 나중에 칠해지므로, 목록이 :focus-visible일
  // 때만 위치를 가진 층(relative + z)으로 올라가야 그 위에 그려집니다. jsdom은 칠하는 차례를 계산하지 않으므로 클래스 약속으로 봅니다.
  // 수정 전 실패: 목록 className에 focus-visible:relative·focus-visible:z-* 가 없음(재현 커밋에서는 it.fails).
  it("결과 목록은 :focus-visible에서 위치를 가진 층으로 올라가 뒤에 오는 xl 오른쪽 칸이 바깥 테두리를 덮지 못한다", async () => {
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const tokens = list.className.split(/\s+/);
    expect(tokens).toContain("focus-visible:relative");
    expect(tokens.some((token) => /^focus-visible:z-(\d+|\[\d+\])$/.test(token))).toBe(true);
  });

  it("받는 중 줄(p[role=status] — '다시 확인' 뒤 포커스 자리)도 실선 2px 테두리를 그린다", async () => {
    reads[endpoints.search.feed("us:NVDA", "timeline")] = {
      ...FEED,
      pending: true,
      sources: [...FEED.sources, { source: "finviz", label: "Finviz 종목 뉴스", status: "pending", count: 0, dropped: null, message: null }],
    };
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const status = (await screen.findByText(/받는 중인 출처가 있어/)).closest("p") as HTMLElement;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.tabIndex).toBe(-1);
    expect(focusVisibleOutline(status.className)).toEqual({ style: "solid", width: "2" });
  });

  it("빈 결과 안내(div[role=status] — 기간을 풀거나 다시 확인한 뒤 포커스 자리)도 실선 2px 테두리를 그린다", async () => {
    reads[endpoints.search.feed("us:NVDA", "timeline")] = {
      ...FEED,
      items: [],
      sources: [{ ...FEED.sources[0], count: 0 }],
      rangeCounts: { "7d": 0, "30d": 0, "1y": 0, "2y": 0 },
    };
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const empty = (await screen.findByText("최근 2년 안의 자료가 없습니다")).closest('[role="status"]') as HTMLElement;
    expect(empty.tabIndex).toBe(-1);
    expect(focusVisibleOutline(empty.className)).toEqual({ style: "solid", width: "2" });
  });

  // 같은 함정이 다른 화면에 다시 들어오지 않게 화면 소스 전체를 봅니다(outlineOffenders — 한 줄 조각, 여러 줄 className 식, 대문자 상수를
  // 풀어 합친 클래스). 함수가 돌려주는 클래스·소문자 변수·props로 넘긴 클래스는 보지 못하므로, 코드가 포커스를 보내는 FeedPanel 세 자리는
  // 위의 화면 시험이 따로 봅니다.
  it("소스 검사는 한 줄·여러 줄 템플릿·cn 인자 나누기·상수 끼워 넣기·상수 정의를 모두 찾는다(검사 자체의 확인)", () => {
    const hits = outlineOffenders([
      { path: "ring.ts", source: 'export const RING = "focus-visible:outline-2 focus-visible:outline-focus";\n' },
      {
        path: "a.tsx",
        source: [
          '<div className="outline-none focus-visible:outline-2" />',
          "<div className={`outline-none",
          "  focus-visible:outline-2`} />",
          "<div className={`${RING} outline-none`} />",
          '<div className={cn("outline-none", "focus-visible:outline-2")} />',
          "const BAD = `outline-hidden ${RING}`;",
          // 아래 셋은 걸리지 않습니다 — 선 모양을 되살림, 포커스 테두리를 그리지 않음, outline-none 없음.
          '<div className="outline-none focus-visible:outline-solid focus-visible:outline-2" />',
          '<input className="outline-none" />',
          "<div className={`${RING} px-3`} />",
        ].join("\n"),
      },
    ]);
    expect(hits).toEqual(["a.tsx:1", "a.tsx:2", "a.tsx:4", "a.tsx:5", "a.tsx:6"]);
  });

  it("화면 소스에 outline-none·outline-hidden이 focus(-visible):outline-<n>의 선을 지우는 조합이 없다", () => {
    const root = resolve(__dirname, "../../../..");
    const files: { path: string; source: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "__checks__") walk(path);
        } else if (/\.tsx?$/.test(name)) {
          files.push({ path: relative(root, path), source: readFileSync(path, "utf8") });
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    expect(outlineOffenders(files)).toEqual([]);
  });
});

describe("QA-434 — '거르기 모두 풀기'를 누르면 사라진 단추 대신 논리적인 자리로 포커스가 간다", () => {
  // QA-434: 정보 검색 QA 스택 브라우저 확인(1024·390 — 390은 '거르기 · 기간' 서랍을 연 뒤)에서 '거르기 모두 풀기'를 Enter로 누르면 단추가
  // 사라지고(빈 결과 안내는 결과 목록으로 바뀌고, 거르기 칸의 단추는 거른 것이 없어져 빠짐) document.activeElement가 BODY가 됐습니다.
  // 빈 결과 안내 쪽 뒤의 Tab은 결과 목록을 건너뛰고 속성 칸으로, 거르기 칸 쪽 뒤의 Tab은 '지금 새로 받기'로 갔습니다(WCAG 2.4.3).
  // 같은 안내의 '좁히기 풀기'는 포커스를 결과 목록으로 옮깁니다. 브라우저는 단추 위 Enter·Space를 click으로 바꾸므로 포커스를 둔 뒤 click으로 누릅니다.
  // 수정 전 실패: document.activeElement가 body.

  /** 결과 목록이 그려진 뒤의 거르기 칸. */
  async function filterPane() {
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    await screen.findByRole("listbox", { name: "결과" });
    return screen.getByRole("region", { name: "거르기" });
  }

  it("빈 결과 안내의 단추 → 다시 나타난 결과 목록", async () => {
    const pane = await filterPane();
    fireEvent.click(within(pane).getByRole("checkbox", { name: "뉴스 2건" }));
    const notice = screen.getByText("고른 거르기에 맞는 자료가 없습니다").closest('[role="status"]') as HTMLElement;
    const clear = within(notice).getByRole("button", { name: "거르기 모두 풀기" });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByText("고른 거르기에 맞는 자료가 없습니다")).toBeNull();
    const list = screen.getByRole("listbox", { name: "결과" });
    expect(document.activeElement).toBe(list);
    // 포커스가 목록에 있으므로 ↓가 곧바로 첫 줄을 고릅니다.
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("거르기 칸의 단추 → 그 칸의 첫 체크 상자(모두 켜진 것을 바로 듣게)", async () => {
    const pane = await filterPane();
    fireEvent.click(within(pane).getByRole("checkbox", { name: "영어 2건" }));
    const clear = within(pane).getByRole("button", { name: "거르기 모두 풀기" });
    clear.focus();
    fireEvent.click(clear);
    expect(within(pane).queryByRole("button", { name: "거르기 모두 풀기" })).toBeNull();
    const first = within(pane).getAllByRole("checkbox")[0] as HTMLInputElement;
    expect(document.activeElement).toBe(first);
    expect(first.checked).toBe(true);
  });

  it("거르기 칸에 체크 상자가 없으면(고른 기간에 받은 줄이 없음) 그 칸의 지금 기간 단추", async () => {
    // 거르기는 기간을 바꿔도 남으므로, 7일에 받은 줄이 없으면 체크 상자 없이 '거르기 모두 풀기'만 남습니다(서버가 센 기간별 건수 — 7일 0건).
    reads[endpoints.search.feed("us:NVDA", "timeline")] = { ...FEED, rangeCounts: { "7d": 0, "30d": 2, "1y": 2, "2y": 2 } };
    const pane = await filterPane();
    fireEvent.click(within(pane).getByRole("checkbox", { name: "영어 2건" }));
    fireEvent.click(within(pane).getByRole("button", { name: /^7일/ }));
    expect(await screen.findByText("이 기간에는 자료가 없습니다")).toBeTruthy();
    expect(within(pane).queryAllByRole("checkbox")).toHaveLength(0);
    const clear = within(pane).getByRole("button", { name: "거르기 모두 풀기" });
    clear.focus();
    fireEvent.click(clear);
    expect(within(pane).queryByRole("button", { name: "거르기 모두 풀기" })).toBeNull();
    expect(document.activeElement).toBe(within(pane).getByRole("button", { name: /^7일/, pressed: true }));
  });
});

describe("QA-435 — 키보드로 고른 줄은 붙어 있는 날짜 머리 밑에 숨지 않는다", () => {
  // QA-435: QA 스택 재확인 3(1440·1280·1024)에서 목록에 포커스를 두고 맨 아래로 내린 뒤 ↓를 누르면 0번 줄이 본문 위끝으로 옮겨지는데
  // (scrollIntoView block nearest), 그 자리에 sticky 날짜 머리(top-0 z-10, 높이 약 25px)가 붙어 있어 고른 줄이 7px만 보였습니다
  // (WCAG 2.4.11 — 미리 보기에는 그 줄이 뜸). 줄마다 날짜 머리 높이 이상의 scroll-margin-top을 두어 옮길 때 머리 아래에 멈추게 합니다.
  // jsdom은 스크롤·칠하기를 계산하지 않으므로 클래스 약속(scroll-mt-*)으로 보고, 묶음 줄(cluster)도 같은 약속인지 소스로 봅니다.
  // 수정 전 실패: 줄의 className에 scroll-mt-* 가 없음(재현 커밋에서는 it.fails).
  const SCROLL_MT = /^scroll-mt-(\d+(\.\d+)?|\[[^\]]+\])$/;

  it("결과 목록의 줄(role=option)마다 날짜 머리 높이만큼 scroll-margin-top을 둔다", async () => {
    renderScreen("/search?e=us:NVDA&tab=timeline&range=30d");
    const list = await screen.findByRole("listbox", { name: "결과" });
    const header = within(list).getAllByRole("group")[0].firstElementChild as HTMLElement;
    expect(header.className).toMatch(/(?:^|\s)sticky(?:\s|$)/); // 줄을 덮을 수 있는 머리가 아직 있다(이 시험이 지키는 까닭)
    const options = within(list).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    for (const option of options) expect(option.className.split(/\s+/).some((token) => SCROLL_MT.test(token))).toBe(true);
  });

  it("묶음 줄을 포함해 FeedPanel의 role=option 요소는 모두 scroll-mt-* 를 가진다(소스 대조)", () => {
    const source = readFileSync(resolve(__dirname, "../FeedPanel.tsx"), "utf8");
    // JSX 속성 줄(role="option"만 있는 줄)로만 나눕니다 — 소스의 querySelector('[role="option"]…') 같은 글자는 요소가 아님.
    const blocks = source.split(/\n[ \t]*role="option"[ \t]*\n/).slice(1);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    for (const block of blocks) {
      const className = /className=\{?`([^`]*)`|className="([^"]*)"/.exec(block);
      expect(className).not.toBeNull();
      const text = (className?.[1] ?? className?.[2] ?? "").split(/\s+/);
      expect(text.some((token) => SCROLL_MT.test(token))).toBe(true);
    }
  });
});
