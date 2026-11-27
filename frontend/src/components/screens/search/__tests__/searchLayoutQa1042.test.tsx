/**
 * QA-1042(성능 개선 3차 작업 D): 정보 검색 첫 화면과 대상 화면의 응답 전 자리 — 390폭 CLS 첫 화면 0.482(1440폭 0.242)·대상 화면 0.192(1440폭 0.093),
 * 고친 뒤 0.000·0.000(1440폭 0.000·0.029). QA(합성 글 약 2,750줄·최근 글 30줄).
 *  - 첫 화면: 최근 글 읽는 중 자리가 한 줄이라 목록(30~50줄)이 오며 아래의 설명·제외 매체 칸을 첫 화면 밖으로 밀었고, 좁은 화면(한 칸)에서는 관심 대상 목록이
 *    오며 그 칸이 자라 아래의 최근 글을 밀었습니다(약 150px).
 *  - 대상 화면: 읽는 중 칸과 결과 목록이 같은 DOM 칸(같은 자리의 div)을 다시 써, 결과와 함께 그 위에 생기는 도구 줄·기간 막대·묶어 보기 줄만큼 '밀린 것'으로
 *    잡혔고(1440폭 260px), 좁은 화면 머리 줄의 '받은 시각'이 결과 뒤에 생겨 줄이 꺾였으며(24px), 기간 단추의 건수('—' → '2089건')가 붙으며 단추가 넓어져
 *    거르기 칸의 줄바꿈이 바뀌었습니다.
 * 내용·차례·숫자는 그대로 두고 응답 전 자리만 맞춥니다(사용자 결정 D-5). 응답은 모두 합성 값입니다.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 각 사례의 주석.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
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

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
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

async function settle() {
  for (let round = 0; round < 4; round += 1) await act(async () => {});
}

const tokens = (element: Element | null | undefined) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const WATCH = { available: true, items: [], limits: { mine: 0, mineMax: 50, all: 0, allMax: 200 }, collecting: true };
const FEED = {
  available: true, entityKey: "us:NVDA", tab: "timeline",
  items: [
    { id: "a1", kind: "news", title: "가짜 기사 하나", url: "https://example.invalid/a1", publisher: "가짜 매체", publisherDomain: "example.invalid",
      publishedAt: "2026-11-27T01:00:00+00:00", timeBasis: "published", source: "watch", lang: "ko", summary: null, readerId: null, clusterId: null, cluster: null },
  ],
  sources: [], window: { from: "2024-11-27", to: "2026-11-27" }, rangeCounts: { "7d": 1, "30d": 1, "1y": 1, "2y": 1 }, olderOnlyLatest: null,
  pending: false, watchAsOf: null, fetchedAt: "2026-11-27T02:00:00+00:00",
};

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
});
afterEach(() => cleanup());

describe("QA-1042 정보 검색 첫 화면의 응답 전 자리", () => {
  // 수정 전: 읽는 중 글의 부모가 패널 그대로였습니다('expected [ … ] to include "min-h-dvh"').
  it("최근 글 읽는 중 자리는 화면 높이 이상 — 목록이 오며 아래 칸을 첫 화면 밖으로 밀지 않게", () => {
    renderScreen("/search");
    expect(tokens(screen.getByText("최근 글을 읽는 중…").parentElement)).toContain("min-h-dvh");
  });

  // 수정 전: 관심 대상을 읽는 동안에도 아래 칸이 좁은 화면에 보였습니다('expected [ … ] to include "max-lg:hidden"').
  it("관심 대상을 읽는 동안 좁은 화면에서는 아래 칸(최근 글·설명)을 보이지 않게 두고, 읽기가 끝나면 함께 보인다", async () => {
    renderScreen("/search");
    const column = screen.getByRole("region", { name: /최근 글/ }).parentElement;
    expect(screen.getByText("관심 대상을 읽는 중…")).toBeTruthy();
    expect(tokens(column)).toContain("max-lg:hidden");
    // 읽기는 가려진 동안에도 시작합니다(요청은 그대로).
    expect(api.apiGetShared.mock.calls.map(([path]) => path)).toContain(endpoints.search.recent);

    cleanup();
    reads[endpoints.search.watch] = WATCH;
    renderScreen("/search");
    await settle();
    expect(tokens(screen.getByRole("region", { name: /최근 글/ }).parentElement)).not.toContain("max-lg:hidden");
  });

  it("관심 대상을 읽지 못했을 때도 아래 칸은 보인다(읽기가 끝난 것)", async () => {
    api.apiGetShared.mockImplementation((path: string) => (path.startsWith(endpoints.search.watch) ? Promise.reject(new Error("합성 실패")) : serve(path)));
    api.apiGet.mockImplementation((path: string) => (path.startsWith(endpoints.search.watch) ? Promise.reject(new Error("합성 실패")) : serve(path)));
    renderScreen("/search");
    await settle();
    expect(screen.getByText(/관심 대상을 읽지 못했습니다/)).toBeTruthy();
    expect(tokens(screen.getByRole("region", { name: /최근 글/ }).parentElement)).not.toContain("max-lg:hidden");
  });
});

describe("QA-1042 정보 검색 대상 화면의 응답 전 자리", () => {
  const PATH = "/search?e=us:NVDA&tab=timeline&range=30d";

  // 수정 전: 읽는 중 칸(div)을 결과 목록이 다시 써 같은 DOM 칸이 남았습니다('expected true to be false').
  it("읽는 중 칸과 결과 목록은 서로 다른 DOM 칸 — 결과 위에 생기는 도구 줄·막대만큼 '밀린 칸'이 남지 않는다", async () => {
    reads[endpoints.search.watch] = WATCH;
    const view = renderScreen(PATH);
    const pending = screen.getByText(/결과를 모으는 중/).parentElement as HTMLElement;
    expect(tokens(pending)).toContain("min-h-dvh");

    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    view.unmount();
    // 같은 화면에서 응답이 뒤늦게 오는 흐름: 먼저 읽는 중을 그리고, 응답을 풀어 줍니다.
    let release: (value: unknown) => void = () => {};
    api.apiGet.mockImplementation((path: string) =>
      path.startsWith(endpoints.search.feed("us:NVDA", "timeline")) ? new Promise((resolve) => (release = resolve)) : serve(path),
    );
    api.apiGetShared.mockImplementation((path: string) =>
      path.startsWith(endpoints.search.feed("us:NVDA", "timeline")) ? new Promise((resolve) => (release = resolve)) : serve(path),
    );
    renderScreen(PATH);
    const waiting = screen.getByText(/결과를 모으는 중/).parentElement as HTMLElement;
    await act(async () => release(FEED));
    await settle();
    const list = screen.getByRole("listbox", { name: "결과" });
    expect(list.textContent).toContain("가짜 기사 하나");
    expect(waiting.isConnected).toBe(false);
    expect(list).not.toBe(waiting);
  });

  // 수정 전: 읽는 중에는 좁은 화면 머리 줄에 '받은 시각' 자리가 없었습니다('expected undefined to be truthy').
  it("읽는 중 좁은 화면 머리 줄에 '받은 시각'과 같은 폭의 보이지 않는 자리", () => {
    renderScreen(PATH);
    const drawerButton = screen.getByRole("button", { name: /거르기 · 기간/ });
    const slot = Array.from(drawerButton.parentElement?.querySelectorAll<HTMLElement>('[aria-hidden="true"]') ?? []).find((element) =>
      element.textContent?.includes("받은 시각"),
    );
    expect(slot).toBeTruthy();
    expect(tokens(slot)).toEqual(expect.arrayContaining(["invisible", "text-xs"]));
  });

  // 수정 전: 읽는 중의 '—'에 폭이 없었습니다('expected [ "text-xs", "text-text-3" ] to include "min-w-11"').
  it("읽는 중 기간 단추의 건수 자리는 네 자리 건수만큼의 폭 — 건수가 오면 자리 없이 받은 글 그대로", async () => {
    renderScreen(PATH);
    const pendingCount = screen.getByRole("button", { name: /^30일/ }).querySelector("span");
    expect(pendingCount?.textContent).toBe("—");
    expect(tokens(pendingCount)).toEqual(expect.arrayContaining(["inline-block", "min-w-11"]));

    cleanup();
    reads[endpoints.search.feed("us:NVDA", "timeline")] = FEED;
    renderScreen(PATH);
    await settle();
    const count = screen.getByRole("button", { name: /^30일/ }).querySelector("span");
    expect(count?.textContent).toBe("1건");
    expect(tokens(count)).not.toContain("min-w-11");
  });
});
