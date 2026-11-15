/**
 * 정보 검색 대상 화면의 포커스 — 누른 단추가 사라질 때 옮길 자리(QA-430·QA-434 — WCAG 2.4.3)와 코드가 포커스를 보내는 자리의 포커스 테두리
 * (QA-433 — WCAG 2.4.7). 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *
 * 미리 보기는 창 폭마다 자리(xl 미만은 아래 시트, xl은 오른쪽 칸)만 다르고 닫는 동작은 같으므로 jsdom에서 한 번에 봅니다.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
import type { SearchFeedItem, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

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
    // 포커스가 목록에 있으므로 ↓가 곧바로 첫 줄을 다시 고릅니다(Escape로 닫은 뒤와 같음).
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(within(list).getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");
  });

  it("Escape로 닫아도 포커스는 결과 목록에 그대로 — 두 닫기의 자리가 같다", async () => {
    const { list } = await openFirstPreview();
    fireEvent.keyDown(list, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
    expect(list.getAttribute("aria-activedescendant")).toBeNull();
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

  // 같은 함정이 다른 화면에 다시 들어오지 않게 화면 소스 전체를 봅니다. 한 줄을 따옴표·백틱·중괄호로 나눈 조각마다(className 한 덩이) 포커스
  // 바깥선 폭이 있는데 계산한 선 모양이 none이면 걸립니다. 상수를 끼워 넣어 합친 클래스(`${FOCUS} outline-none`)는 위의 화면 시험이 봅니다.
  it("화면 소스에 outline-none·outline-hidden이 focus(-visible):outline-<n>의 선을 지우는 조합이 없다", () => {
    const root = resolve(__dirname, "../../../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "__checks__") walk(path);
        } else if (/\.tsx?$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const path of files) {
      readFileSync(path, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const hit = line
            .split(/["'`{}]/)
            .some((piece) => FOCUS_OUTLINE_WIDTH.test(piece) && focusVisibleOutline(piece).style === "none");
          if (hit) offenders.push(`${relative(root, path)}:${index + 1}`);
        });
    }
    expect(offenders).toEqual([]);
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
