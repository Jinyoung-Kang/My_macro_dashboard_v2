/**
 * 정보 검색 단계 5 — Finviz 종목 뉴스(계약 §8-6, ADR 0041 결정 10). 응답은 모두 합성 값입니다(실제 응답 원문을 쓰지 않음 — ADR 0026 결정 12).
 *  - 응답이 pending이면 5초마다 같은 결과를 다시 부름(최대 12번 — 1분). 보이던 줄은 그대로 두고 새 응답으로 바꿔 끼움
 *  - 그 뒤에는 '받는 중' 그대로 두고 '다시 확인' 단추(누르면 한 번 읽음)
 *  - 탭을 바꾸면 앞 탭의 다시 읽기를 멈춤
 *  - 출처 상태 글: 받는 중 — 몇 초 뒤 채움 · 운영 서버에서만 · 예산 소진·차단은 서버가 준 사유 — 색만으로 가르지 않음
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
import { FEED_PENDING_MAX_POLLS, FEED_PENDING_REFRESH_MS } from "@/lib/infoSearch";
import type { SearchFeedItem, SearchSourceStatus, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: null,
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477" },
  links: [], sources: ["sec", "wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "yahoo", lang: "en", summary: null, readerId: null, ...over,
  };
}

const status = (source: string, label: string, code: string, over: Partial<SearchSourceStatus> = {}): SearchSourceStatus => ({
  source, label, status: code, count: 0, dropped: null, message: null, ...over,
});

const YAHOO_ROW = row({ id: "y1", title: "합성 Yahoo 기사", source: "yahoo", publisher: "Example Wire" });
const FINVIZ_ROW = row({ id: "f1", title: "합성 Finviz 기사", source: "finviz", publisher: "Example Daily", publishedAt: "2026-11-14T00:40:00+00:00" });
const YAHOO_OK = status("yahoo", "Yahoo Finance", "ok", { count: 1 });
const FINVIZ_PENDING = status("finviz", "Finviz 종목 뉴스", "pending", { message: "받는 중 — 몇 초 뒤 채움" });
const FINVIZ_OK = status("finviz", "Finviz 종목 뉴스", "ok", { count: 1 });
/** Finviz 줄까지 받은 응답(두 줄 — 서버가 센 기간별 건수도 두 줄). */
const BOTH = { items: [FINVIZ_ROW, YAHOO_ROW], sources: [YAHOO_OK, FINVIZ_OK], rangeCounts: { "7d": 2, "30d": 2, "1y": 2, "2y": 2 }, pending: false };

function feed(over: Record<string, unknown> = {}) {
  return {
    available: true, entityKey: "us:NVDA", tab: "news", items: [YAHOO_ROW], sources: [YAHOO_OK, FINVIZ_PENDING],
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 1, "30d": 1, "1y": 1, "2y": 1 },
    olderOnlyLatest: null, pending: true, fetchedAt: "2026-11-14T01:00:00+00:00", ...over,
  };
}

/** 경로 → 응답(값이 함수면 부를 때마다 계산). 정확히 같은 경로가 먼저, 그다음 긴 앞부분. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = path in reads ? path : Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  if (!hit) return new Promise(() => {});
  const value = reads[hit];
  return typeof value === "function" ? (value as () => Promise<unknown>)() : Promise.resolve(value);
}
const NEWS = endpoints.search.feed("us:NVDA", "news");
const feedCalls = (path = NEWS) => api.apiGetShared.mock.calls.filter(([called]) => called === path).length;

function renderScreen(path: string) {
  setLocation(path);
  return render(
    <SessionUserProvider user={MEMBER}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
  reads[endpoints.search.watch] = { available: true, items: [], limits: null, collecting: false };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("받는 중(pending) — 다시 부르기(계약 §8-6)", () => {
  it("5초 뒤 같은 결과를 다시 부르고, 그동안 보이던 줄은 그대로 — 새 응답이 오면 Finviz 줄을 바꿔 끼운다", async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => {};
    let calls = 0;
    reads[NEWS] = () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(feed());
      return new Promise((resolve) => (answer = resolve));
    };
    renderScreen("/search?e=us:NVDA&tab=news");
    await tick(10);
    expect(screen.getByText("합성 Yahoo 기사")).toBeTruthy();
    expect(screen.getByText(/받는 중인 출처가 있어 몇 초 뒤 다시 읽습니다\(Finviz 종목 뉴스\)/)).toBeTruthy();
    expect(feedCalls()).toBe(1);

    await tick(FEED_PENDING_REFRESH_MS + 10);
    expect(feedCalls()).toBe(2);
    // 다시 부르는 동안에도 줄은 그대로(읽는 중 화면으로 바뀌지 않음)
    expect(screen.getByText("합성 Yahoo 기사")).toBeTruthy();
    expect(screen.queryByText(/결과를 모으는 중/)).toBeNull();

    await act(async () => {
      answer(feed(BOTH));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText("합성 Finviz 기사")).toBeTruthy();
    expect(screen.getByText("합성 Yahoo 기사")).toBeTruthy();
    expect(screen.queryByText(/받는 중인 출처가 있어/)).toBeNull();
    // 다 받으면 멈춤
    await tick(FEED_PENDING_REFRESH_MS * 3);
    expect(feedCalls()).toBe(2);
  });

  it("12번(1분) 뒤에도 받는 중이면 멈추고 '받는 중'과 '다시 확인' 단추 — 누르면 한 번 더 읽는다", async () => {
    vi.useFakeTimers();
    reads[NEWS] = feed();
    renderScreen("/search?e=us:NVDA&tab=news");
    await tick(10);
    expect(screen.queryByRole("button", { name: "다시 확인" })).toBeNull();
    for (let at = 0; at < FEED_PENDING_MAX_POLLS + 2; at += 1) await tick(FEED_PENDING_REFRESH_MS);
    expect(feedCalls()).toBe(1 + FEED_PENDING_MAX_POLLS);
    expect(screen.getByText("받는 중 — 1분 동안 다시 읽었지만 아직 받지 못했습니다(Finviz 종목 뉴스).")).toBeTruthy();
    const statusLine = screen.getByRole("list", { name: "출처 상태" });
    const finvizLine = within(statusLine).getByText("Finviz 종목 뉴스").closest("li") as HTMLElement;
    expect(within(finvizLine).getByText("받는 중")).toBeTruthy();
    expect(within(finvizLine).queryByText(/몇 초 뒤/)).toBeNull();
    // 줄은 그대로
    expect(screen.getByText("합성 Yahoo 기사")).toBeTruthy();

    reads[NEWS] = feed(BOTH);
    fireEvent.click(screen.getByRole("button", { name: "다시 확인" }));
    await tick(10);
    expect(feedCalls()).toBe(2 + FEED_PENDING_MAX_POLLS);
    expect(screen.getByText("합성 Finviz 기사")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "다시 확인" })).toBeNull();
  });

  it("'다시 확인'을 키보드로 누르면 포커스를 잃지 않는다 — 읽는 동안 단추에 그대로, 단추가 사라지면 받는 중 줄이나 결과 목록으로", async () => {
    vi.useFakeTimers();
    reads[NEWS] = feed();
    renderScreen("/search?e=us:NVDA&tab=news");
    await tick(10);
    for (let at = 0; at < FEED_PENDING_MAX_POLLS + 2; at += 1) await tick(FEED_PENDING_REFRESH_MS);
    let answer: (value: unknown) => void = () => {};
    let fail: (reason: unknown) => void = () => {};
    reads[NEWS] = () => new Promise((resolve, reject) => ((answer = resolve), (fail = reject)));

    // 실패 — 단추가 남고 포커스도 단추에(읽는 동안 disabled로 바꾸지 않음 — 브라우저가 포커스를 body로 떨어뜨림)
    let button = screen.getByRole("button", { name: "다시 확인" });
    button.focus();
    fireEvent.click(button);
    await tick(10);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    // 읽는 동안 또 눌러도 보내지 않음
    const calls = feedCalls();
    fireEvent.click(button);
    await tick(10);
    expect(feedCalls()).toBe(calls);
    await act(async () => {
      fail(new Error("네트워크 오류"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByText(/다시 확인하지 못했습니다 — 네트워크 오류/)).toBeTruthy();
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(button);

    // 아직 받는 중 — 단추가 사라지고(다시 12번) 포커스는 같은 자리의 받는 중 줄로
    button.focus();
    fireEvent.click(button);
    await tick(10);
    await act(async () => {
      answer(feed());
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByRole("button", { name: "다시 확인" })).toBeNull();
    const pendingLine = screen.getByText(/받는 중인 출처가 있어 몇 초 뒤 다시 읽습니다/).closest("[role=status]");
    expect(pendingLine).not.toBeNull();
    expect(document.activeElement).toBe(pendingLine);

    // 다 받음 — 받는 중 줄도 사라지면 결과 목록으로
    reads[NEWS] = feed();
    for (let at = 0; at < FEED_PENDING_MAX_POLLS + 2; at += 1) await tick(FEED_PENDING_REFRESH_MS);
    reads[NEWS] = feed(BOTH);
    button = screen.getByRole("button", { name: "다시 확인" });
    button.focus();
    fireEvent.click(button);
    await tick(10);
    expect(screen.getByText("합성 Finviz 기사")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "결과" }));
  });

  it("탭을 바꾸면 앞 탭의 다시 읽기를 멈춘다", async () => {
    vi.useFakeTimers();
    reads[NEWS] = feed();
    reads[endpoints.search.feed("us:NVDA", "filings")] = feed({ tab: "filings", items: [], sources: [], pending: false });
    renderScreen("/search?e=us:NVDA&tab=news");
    await tick(10);
    fireEvent.click(screen.getByRole("tab", { name: "공시" }));
    await tick(FEED_PENDING_REFRESH_MS * 4);
    expect(feedCalls()).toBe(1);
  });
});

describe("Finviz 출처 상태 글 — 색만으로 가르지 않음", () => {
  const statusLine = async () => screen.findByRole("list", { name: "출처 상태" });
  const lineOf = (list: HTMLElement) => within(list).getByText("Finviz 종목 뉴스").closest("li") as HTMLElement;

  it("받는 중 — '받는 중 — 몇 초 뒤 채움'(서버의 같은 말은 겹쳐 적지 않음)", async () => {
    reads[NEWS] = feed();
    renderScreen("/search?e=us:NVDA&tab=news");
    const line = lineOf(await statusLine());
    expect(within(line).getByText("받는 중 — 몇 초 뒤 채움")).toBeTruthy();
    expect(within(line).getAllByText(/몇 초 뒤 채움/)).toHaveLength(1);
  });

  it("서버에서만(로컬·QA) — '운영 서버에서만'이고 받는 중 안내를 띄우지 않는다", async () => {
    reads[NEWS] = feed({ pending: false, sources: [YAHOO_OK, status("finviz", "Finviz 종목 뉴스", "server_only", { message: "Finviz는 운영 서버에서만" })] });
    renderScreen("/search?e=us:NVDA&tab=news");
    const line = lineOf(await statusLine());
    expect(within(line).getByText("운영 서버에서만")).toBeTruthy();
    expect(screen.queryByText(/받는 중인 출처가 있어/)).toBeNull();
  });

  it("예산 소진·차단 — 상태 글과 서버가 준 사유", async () => {
    reads[NEWS] = feed({
      pending: false,
      sources: [YAHOO_OK, status("finviz", "Finviz 종목 뉴스", "skipped", { message: "오늘 Finviz 검색 예산 소진" })],
    });
    renderScreen("/search?e=us:NVDA&tab=news");
    let line = lineOf(await statusLine());
    expect(within(line).getByText("건너뜀")).toBeTruthy();
    expect(within(line).getByText(/오늘 Finviz 검색 예산 소진/)).toBeTruthy();
    cleanup();

    reads[NEWS] = feed({
      pending: false,
      sources: [YAHOO_OK, status("finviz", "Finviz 종목 뉴스", "error", { message: "finviz.com 닫힘(거부 3번)" })],
    });
    renderScreen("/search?e=us:NVDA&tab=news");
    line = lineOf(await statusLine());
    expect(within(line).getByText("실패")).toBeTruthy();
    expect(within(line).getByText(/finviz\.com 닫힘\(거부 3번\)/)).toBeTruthy();
  });

  it("Finviz 줄의 출처 거르기 이름도 'Finviz 종목 뉴스'(상태 줄이 없어도 기본 이름)", async () => {
    reads[NEWS] = feed({ ...BOTH, sources: [YAHOO_OK] });
    renderScreen("/search?e=us:NVDA&tab=news");
    expect(await screen.findByRole("checkbox", { name: "Finviz 종목 뉴스 1건" })).toBeTruthy();
  });
});
