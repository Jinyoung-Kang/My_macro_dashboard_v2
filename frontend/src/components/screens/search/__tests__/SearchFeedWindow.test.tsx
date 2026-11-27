/**
 * 정보 검색 결과 목록의 이어 그리기(성능 개선 3차 작업 C, ADR 0052 결정 8).
 *
 * 받은 줄이 수천 건이면 한 번에 다 그리는 DOM이 1만 개를 넘었습니다(QA 합성 글 2,089줄에 12,679개 — 기준 5,000). 목록은 날짜 묶음 단위로 앞(최근)에서부터
 * 약 60줄만 그리고 이어서 약 120줄씩 그립니다. 달라지지 않아야 하는 것: 보이는 줄의 내용·차례, 기간 단추·거르기의 건수(받은 전체), ↑↓·End로 끝까지 가는 길.
 * 스크롤에 따른 이어 그리기(IntersectionObserver)는 jsdom에 없어 여기서는 '이어서 보기' 단추와 키보드 길만 봅니다(스크롤은 QA 브라우저 측정). 응답은 합성 값입니다.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
import type { SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const DAYS = 30;
const PER_DAY = 10;
const TOTAL = DAYS * PER_DAY;
/** 2026-11-27(오늘)부터 하루에 열 줄씩 서른 날 — 짝수 번째는 뉴스, 홀수 번째는 헤드라인. 제목에 최근순 번호(0 = 가장 최근). */
const ITEMS = Array.from({ length: TOTAL }, (_, index) => {
  const day = Math.floor(index / PER_DAY);
  const moment = new Date(Date.UTC(2026, 10, 27, 3, 0, 0) - day * 86_400_000 - (index % PER_DAY) * 60_000);
  return {
    id: `row-${index}`, kind: index % 2 === 0 ? "news" : "headline", title: `가짜 기사 ${String(index).padStart(3, "0")}`, url: `https://example.invalid/${index}`,
    publisher: "가짜 매체", publisherDomain: "example.invalid", publishedAt: moment.toISOString(), timeBasis: "published", source: "watch", lang: "ko",
    summary: null, readerId: null, clusterId: null, cluster: null,
  };
});
const FEED = {
  available: true, entityKey: "us:NVDA", tab: "timeline", items: ITEMS, sources: [], window: { from: "2024-11-27", to: "2026-11-27" },
  rangeCounts: { "7d": 70, "30d": TOTAL, "1y": TOTAL, "2y": TOTAL }, olderOnlyLatest: null, pending: false, watchAsOf: null, fetchedAt: "2026-11-27T03:30:00+00:00",
};

function serve(path: string): Promise<unknown> {
  return path.startsWith(endpoints.search.feed("us:NVDA", "timeline")) ? Promise.resolve(FEED) : new Promise(() => {});
}

async function open() {
  setLocation("/search?e=us:NVDA&tab=timeline&range=2y");
  render(
    <SessionUserProvider user={MEMBER}>
      <SearchScreen />
    </SessionUserProvider>,
  );
  for (let round = 0; round < 4; round += 1) await act(async () => {});
  return screen.getByRole("listbox", { name: "결과" });
}

const titles = (list: HTMLElement) => within(list).getAllByRole("option").map((row) => /가짜 기사 \d{3}/.exec(row.textContent ?? "")?.[0]);
const more = () => screen.queryByRole("button", { name: "이어서 보기" });

let scroll: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-27T04:00:00Z"));
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  scroll.mockRestore();
  vi.useRealTimers();
});

describe("정보 검색 결과 목록의 이어 그리기", () => {
  it("처음에는 날짜 묶음 단위로 앞에서부터 60줄만 그린다 — 내용·차례는 받은 그대로(최근순)", async () => {
    const list = await open();
    expect(titles(list)).toEqual(ITEMS.slice(0, 60).map((item) => item.title));
    expect(within(list).getAllByRole("group")).toHaveLength(6);
    expect(more()?.parentElement?.textContent).toContain(`60줄까지 그렸습니다 · 남은 ${TOTAL - 60}줄`);
  });

  it("건수는 그린 줄이 아니라 받은 전체를 센다 — 기간 단추·거르기", async () => {
    await open();
    expect(screen.getByRole("button", { name: /^2년/ }).textContent).toContain(`${TOTAL}건`);
    expect(screen.getByRole("button", { name: /^7일/ }).textContent).toContain("70건");
    expect(screen.getByRole("checkbox", { name: `뉴스 ${TOTAL / 2}건` })).toBeTruthy();
  });

  it("'이어서 보기'를 누르면 120줄을 더 그리고, 마지막까지 그리면 단추가 사라지며 포커스가 결과 목록으로 간다", async () => {
    const list = await open();
    fireEvent.click(more() as HTMLElement);
    expect(titles(list)).toEqual(ITEMS.slice(0, 180).map((item) => item.title));
    expect(more()?.parentElement?.textContent).toContain(`180줄까지 그렸습니다 · 남은 ${TOTAL - 180}줄`);

    fireEvent.click(more() as HTMLElement);
    expect(titles(list)).toHaveLength(TOTAL);
    expect(more()).toBeNull();
    expect(document.activeElement).toBe(list);
  });

  it("End는 끝까지 그린 뒤 마지막 줄을 고르고 그 줄로 옮긴다 — 키보드로 끝까지 갈 수 있음", async () => {
    const list = await open();
    list.focus();
    fireEvent.keyDown(list, { key: "End" });
    await act(async () => {});
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(TOTAL);
    expect(rows[TOTAL - 1].getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(rows[TOTAL - 1].id);
    expect(scroll.mock.instances.at(-1)).toBe(rows[TOTAL - 1]);
  });

  it("↓로 그린 끝을 넘으면 다음 날짜 묶음을 그리고 그 줄을 고른다", async () => {
    const list = await open();
    list.focus();
    fireEvent.click(within(list).getAllByRole("option")[59]);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    await act(async () => {});
    const rows = within(list).getAllByRole("option");
    expect(rows).toHaveLength(70);
    expect(rows[60].getAttribute("aria-selected")).toBe("true");
    expect(rows[60].textContent).toContain("가짜 기사 060");
    expect(scroll.mock.instances.at(-1)).toBe(rows[60]);
  });

  it("거르기를 바꾸면 처음 크기로 돌아간다 — 줄 수가 반이 되어 날짜 묶음 열둘이 60줄", async () => {
    const list = await open();
    fireEvent.click(more() as HTMLElement);
    expect(within(list).getAllByRole("option")).toHaveLength(180);

    fireEvent.click(screen.getByRole("checkbox", { name: `헤드라인 ${TOTAL / 2}건` }));
    const rows = titles(screen.getByRole("listbox", { name: "결과" }));
    expect(rows).toEqual(ITEMS.filter((item) => item.kind === "news").slice(0, 60).map((item) => item.title));
    expect(more()?.parentElement?.textContent).toContain(`60줄까지 그렸습니다 · 남은 ${TOTAL / 2 - 60}줄`);
  });

  it("줄이 60줄보다 적으면 다 그리고 '이어서 보기'가 없다", async () => {
    api.apiGet.mockImplementation((path: string) =>
      path.startsWith(endpoints.search.feed("us:NVDA", "timeline")) ? Promise.resolve({ ...FEED, items: ITEMS.slice(0, 25) }) : new Promise(() => {}),
    );
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith(endpoints.search.feed("us:NVDA", "timeline")) ? Promise.resolve({ ...FEED, items: ITEMS.slice(0, 25) }) : new Promise(() => {}),
    );
    const list = await open();
    expect(within(list).getAllByRole("option")).toHaveLength(25);
    expect(more()).toBeNull();
  });
});
