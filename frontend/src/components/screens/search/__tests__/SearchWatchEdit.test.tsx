/**
 * 정보 검색 단계 6 묶음 2(계약 §9-4·9-5) 화면. 응답은 모두 합성 값입니다(실제 응답 원문·실제 사람의 자료를 쓰지 않음 — ADR 0026 결정 12).
 *  - 별칭 편집: 관심 대상인 대상의 속성 칸에 그 줄의 별칭(칩)과 '별칭 편집' — 편집 중에는 칩 지우기·더하기·저장·취소, 서버와 같은 검사(1~12개,
 *    1~60자, 제어 글자 없음, 대소문자 무시 중복), 4글자 미만 별칭 안내, 저장(PATCH {aliases})한 뒤 관심 대상 목록과 지금 결과를 다시 부름,
 *    실패는 글(role=alert), 데모는 읽기만, 줄의 별칭 칸이 없으면 편집하지 않음
 *    저장하는 동안 취소도 막음, 저장 뒤 다시 읽기는 저장 전에 나간 같은 GET에 합류하지 않음
 *  - 알림: 관심 대상 목록 줄마다·대상 머리의 별 옆에 종 아이콘 + '알림 켬'·'알림 끔'(aria-pressed — 낭독 이름은 상태와 상관없이 같음), PATCH {notify},
 *    기본 꺼짐, 바꾸는 동안 다른 알림 단추도 막음, 실패는 누른 자리에만, 서버가 알림 칸을 주지 않으면 단추가 없음, 데모는 단추가 없음,
 *    바꾼 뒤 다시 읽기는 그 전에 나간 목록 읽기에 합류하지 않음
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiDelete: vi.fn(), apiPatch: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("next/navigation", () => import("./fakeNavigation"));

import { SessionUserProvider } from "@/hooks/useSessionUser";
import type { InfoSearchWatch } from "@/hooks/useInfoSearchWatch";
import { DEMO_READ_ONLY } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import type { SearchFeedItem, SearchWatchItem, SessionUser } from "@/lib/types";
import { AliasEditor } from "../AliasEditor";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const DEMO: SessionUser = { email: "demo@test.local", role: "MEMBER", tier: "FREE", demo: true };

const SYNTH = {
  key: "us:SYNT", kind: "company", name: "합성전자", nameKo: "합성전자", nameEn: "Synthetic Devices", aliases: ["합성전자", "Synthetic Devices", "SynDev"],
  description: null,
  ids: { ticker: "SYNT", market: "us", stockCode: null, cik: "0000000001", dartCorpCode: null, wikidata: "Q1", lei: null },
  links: [], sources: ["sec", "wikidata"],
};

const WATCH_SYNT = {
  id: 7, key: "us:SYNT", kind: "company", name: "합성전자", createdAt: "2026-11-10T00:00:00+00:00", lastSeenAt: "2026-11-13T00:00:00+00:00",
  newCount: 2, aliases: ["합성전자", "Synthetic Devices", "SynDev"], notify: false,
};
const WATCH_TOPIC = {
  id: 8, key: "topic:합성 주제", kind: "topic", name: "합성 주제", createdAt: "2026-11-10T00:00:00+00:00", lastSeenAt: null,
  newCount: 0, aliases: ["합성 주제"], notify: true,
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "합성 기사", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null,
    clusterId: null, cluster: null, ...over,
  };
}

function feed(over: Record<string, unknown> = {}) {
  return {
    available: true, entityKey: "us:SYNT", tab: "timeline", items: [row({ id: "a" })],
    sources: [{ source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 1, dropped: null, message: null }],
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 1, "30d": 1, "1y": 1, "2y": 1 },
    olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00", ...over,
  };
}

function watchList(items: unknown[]) {
  return { available: true, items, limits: { mine: items.length, max: 10, serverUsed: 5, serverMax: 100 }, collecting: true };
}

/** 경로 → 응답(값이 함수면 부를 때마다 계산). 정확히 같은 경로가 먼저, 그다음 긴 앞부분. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;

/** 붙잡은 읽기 하나 — 응답은 요청한 때의 값(서버가 그때 읽은 것)이고, release()를 부른 뒤에 돌아옵니다. */
type Held = { path: string; requested: boolean; release: () => void };
let held: Held | null = null;
/** 그 경로의 다음 읽기 하나를 붙잡습니다(쓰기 전에 나가 늦게 오는 GET). */
function holdNext(path: string): Held {
  const hold: Held = { path, requested: false, release: () => {} };
  held = hold;
  return hold;
}

function serve(path: string): Promise<unknown> {
  const hit = path in reads ? path : Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
  if (!hit) return new Promise(() => {});
  const value = reads[hit];
  const body = typeof value === "function" ? (value as () => unknown)() : value;
  const hold = held;
  if (hold && hold.path === path && !hold.requested) {
    hold.requested = true;
    return new Promise((resolve) => (hold.release = () => resolve(body)));
  }
  return Promise.resolve(body);
}

/** apiGetShared의 가짜 — 진짜(lib/sharedRequest)처럼 진행 중인 같은 경로의 GET이 있으면 그 결과를 함께 씁니다. */
const inFlight = new Map<string, Promise<unknown>>();
function serveShared(path: string): Promise<unknown> {
  const running = inFlight.get(path);
  if (running) return running;
  const request = serve(path).finally(() => inFlight.delete(path));
  inFlight.set(path, request);
  return request;
}

const sharedCalls = () => api.apiGetShared.mock.calls.map(([path]) => String(path));
const freshCalls = () => api.apiGet.mock.calls.map(([path]) => String(path));
/** 그 경로를 읽은 횟수(함께 쓰는 읽기 + 쓰기 뒤의 공유하지 않는 읽기). */
const countReads = (path: string) => [...sharedCalls(), ...freshCalls()].filter((called) => called === path).length;
const countShared = (path: string) => sharedCalls().filter((called) => called === path).length;
const patchCalls = () => api.apiPatch.mock.calls.map(([path, body]) => [String(path), body]);

const FEED_PATH = endpoints.search.feed("us:SYNT", "timeline");

function renderScreen(user: SessionUser = MEMBER, path = "/search?e=us:SYNT") {
  setLocation(path);
  return render(
    <SessionUserProvider user={user}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

/** 속성 칸의 별칭 편집 구역. */
const aliasSection = () => screen.findByRole("region", { name: "관심 대상 별칭" });

beforeEach(() => {
  reads = {};
  held = null;
  inFlight.clear();
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiPatch, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serveShared(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  api.apiPost.mockResolvedValue({ ok: true });
  api.apiDelete.mockResolvedValue({ ok: true });
  api.apiPatch.mockResolvedValue({ ok: true });
  reads[endpoints.search.entity("us:SYNT")] = { available: true, entity: SYNTH, errors: {} };
  reads[FEED_PATH] = feed();
});
afterEach(() => cleanup());

describe("별칭 편집(계약 §9-4)", () => {
  it("관심 대상이면 속성 칸에 그 줄의 별칭과 '별칭 편집', 4글자 미만 안내 — 표의 '별칭' 줄(대상 별칭)은 그대로 두고 합쳐 쓴다고 적음", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT]);
    renderScreen();
    const section = await aliasSection();
    const chips = within(section).getByRole("list", { name: "별칭" });
    expect(within(chips).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["합성전자", "Synthetic Devices", "SynDev"]);
    const edit = within(section).getByRole("button", { name: "별칭 편집" });
    expect(within(section).getByText(/4글자 미만 별칭은 뉴스 검색어와 받아 둔 글 대조에 쓰지 않습니다/)).toBeTruthy();
    // 결과 검색은 대상 풀기의 별칭에 이 목록을 더해 씀(수집기 with_aliases — 합집합) — 표의 별칭은 빼도 쓰인다는 것을 숨기지 않음
    const attributes = screen.getByRole("region", { name: "속성" });
    const aliasRow = within(attributes).getByText("별칭", { selector: "dt" });
    expect(aliasRow.nextElementSibling?.textContent).toBe("Synthetic Devices · SynDev");
    const note = within(section).getByText(/표에 있는 별칭은 여기서 빼도 결과 검색에 쓰입니다/);
    expect(note.textContent).toContain("이 대상을 등록한 모든 사용자의 목록을 합쳐 씁니다");
    expect(edit.getAttribute("aria-describedby")).toBe(note.id);
  });

  it("관심 대상이 아니면 편집이 없고 속성 표의 '별칭' 줄 그대로", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_TOPIC]);
    renderScreen();
    const attributes = await screen.findByRole("region", { name: "속성" });
    expect(within(attributes).getByText("별칭", { selector: "dt" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "관심 대상 별칭" })).toBeNull();
  });

  it("편집 — 칩을 빼고 더해 저장하면 PATCH {aliases} 뒤 관심 대상 목록과 지금 결과를 다시 부르고, 편집을 닫아 '별칭 편집'으로 포커스", async () => {
    let saved: string[] | null = null;
    reads[endpoints.search.watch] = () => watchList([{ ...WATCH_SYNT, aliases: saved ?? WATCH_SYNT.aliases }]);
    api.apiPatch.mockImplementation(async (_path: string, body: { aliases: string[] }) => {
      saved = body.aliases;
      return { ok: true };
    });
    renderScreen();
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    const input = within(section).getByRole("textbox", { name: /더할 별칭/ });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(within(section).getByText("(3 / 12)")).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "별칭 SynDev 빼기" }));
    fireEvent.change(input, { target: { value: "  Synthetic   Devices Inc  " } });
    fireEvent.click(within(section).getByRole("button", { name: "더하기" }));
    const editing = within(section).getByRole("list", { name: "편집 중인 별칭" });
    expect(within(editing).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "합성전자",
      "Synthetic Devices",
      "Synthetic Devices Inc",
    ]);

    const watchReads = countReads(endpoints.search.watch);
    const feedReads = countReads(FEED_PATH);
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(patchCalls()).toEqual([[endpoints.search.watchItem(7), { aliases: ["합성전자", "Synthetic Devices", "Synthetic Devices Inc"] }]]));
    const edit = await within(section).findByRole("button", { name: "별칭 편집" });
    await waitFor(() => expect(document.activeElement).toBe(edit));
    expect(countReads(endpoints.search.watch)).toBeGreaterThan(watchReads);
    await waitFor(() => expect(countReads(FEED_PATH)).toBeGreaterThan(feedReads));
    const chips = within(section).getByRole("list", { name: "별칭" });
    expect(within(chips).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["합성전자", "Synthetic Devices", "Synthetic Devices Inc"]);
  });

  it("더할 칸에 남긴 글은 '저장'을 누르면 함께 더함", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT]);
    renderScreen();
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.change(within(section).getByRole("textbox", { name: /더할 별칭/ }), { target: { value: "합성 디바이스" } });
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(patchCalls()).toEqual([[endpoints.search.watchItem(7), { aliases: ["합성전자", "Synthetic Devices", "SynDev", "합성 디바이스"] }]]),
    );
  });

  it("서버와 같은 검사 — 대소문자만 다른 중복·60자 넘음·12개 넘음은 보내지 않고 사유를 글(role=alert)로", async () => {
    const eleven = Array.from({ length: 11 }, (_, at) => `합성 별칭 ${at}`);
    reads[endpoints.search.watch] = watchList([{ ...WATCH_SYNT, aliases: eleven }]);
    renderScreen();
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    const input = within(section).getByRole("textbox", { name: /더할 별칭/ });
    const add = within(section).getByRole("button", { name: "더하기" });

    fireEvent.change(input, { target: { value: "합성 별칭 0".toUpperCase() } });
    fireEvent.click(add);
    expect((await within(section).findByRole("alert")).textContent).toContain("이미 있는 별칭입니다(대소문자 무시)");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "가".repeat(61) } });
    fireEvent.click(add);
    expect(within(section).getByRole("alert").textContent).toContain("별칭은 60자까지입니다");

    fireEvent.change(input, { target: { value: "열두째" } });
    fireEvent.click(add);
    expect(within(section).queryByRole("alert")).toBeNull();
    expect(within(section).getByText("(12 / 12)")).toBeTruthy();
    fireEvent.change(input, { target: { value: "열세째" } });
    fireEvent.click(add);
    expect(within(section).getByRole("alert").textContent).toContain("별칭은 12개까지입니다");
    expect(api.apiPatch).not.toHaveBeenCalled();
  });

  it("다 빼면 저장하지 않고 '하나 이상'을 글로", async () => {
    reads[endpoints.search.watch] = watchList([{ ...WATCH_SYNT, aliases: ["합성전자"] }]);
    renderScreen();
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.click(within(section).getByRole("button", { name: "별칭 합성전자 빼기" }));
    expect(within(section).getByText(/별칭이 없습니다/)).toBeTruthy();
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect((await within(section).findByRole("alert")).textContent).toContain("별칭은 하나 이상이어야 합니다");
    expect(api.apiPatch).not.toHaveBeenCalled();
  });

  it("바뀐 것이 없으면 요청 없이 닫고, 취소는 편집을 버린다", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT]);
    renderScreen();
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect(await within(section).findByRole("button", { name: "별칭 편집" })).toBeTruthy();

    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.click(within(section).getByRole("button", { name: "별칭 SynDev 빼기" }));
    fireEvent.click(within(section).getByRole("button", { name: "취소" }));
    const chips = await within(section).findByRole("list", { name: "별칭" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(3);
    expect(api.apiPatch).not.toHaveBeenCalled();
  });

  it("서버가 거절하면(400·403) 그 사유를 글로 — 편집은 그대로, 결과를 다시 부르지 않음", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT]);
    api.apiPatch.mockRejectedValue(Object.assign(new Error("별칭은 1~12개, 하나 60자까지입니다"), { status: 400 }));
    renderScreen();
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.click(within(section).getByRole("button", { name: "별칭 SynDev 빼기" }));
    const feedReads = countReads(FEED_PATH);
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    expect((await within(section).findByRole("alert")).textContent).toContain("별칭은 1~12개, 하나 60자까지입니다");
    expect(within(section).getByRole("list", { name: "편집 중인 별칭" })).toBeTruthy();
    expect(countReads(FEED_PATH)).toBe(feedReads);
    // 등록 단추 밑에는 뜨지 않음(실패 상태가 따로)
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    api.apiPatch.mockRejectedValue(Object.assign(new Error("요청 실패 (HTTP 403)"), { status: 403 }));
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(within(section).getByRole("alert").textContent).toContain("이 계정으로는 할 수 없습니다"));
  });

  it("저장하는 동안 '저장'은 aria-disabled이고 다시 눌러도 한 번만 보낸다", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT]);
    let finish: (value: unknown) => void = () => {};
    api.apiPatch.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    renderScreen();
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.click(within(section).getByRole("button", { name: "별칭 SynDev 빼기" }));
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    const busy = await within(section).findByRole("button", { name: "저장하는 중…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(api.apiPatch).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    expect(await within(section).findByRole("button", { name: "별칭 편집" })).toBeTruthy();
  });

  it("저장하는 동안 '취소'도 aria-disabled이고 눌러도 편집을 닫지 않는다 — 저장이 실패하면 사유가 편집 안에 보임", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT]);
    let fail: (reason: unknown) => void = () => {};
    api.apiPatch.mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    renderScreen();
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.click(within(section).getByRole("button", { name: "별칭 SynDev 빼기" }));
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    await within(section).findByRole("button", { name: "저장하는 중…" });
    const cancel = within(section).getByRole("button", { name: "취소" });
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(cancel);
    expect(within(section).getByRole("list", { name: "편집 중인 별칭" })).toBeTruthy();

    await act(async () => fail(Object.assign(new Error("합성 거절 사유"), { status: 400 })));
    expect((await within(section).findByRole("alert")).textContent).toContain("합성 거절 사유");
    expect(within(section).getByRole("list", { name: "편집 중인 별칭" })).toBeTruthy();
    expect(within(section).getByRole("button", { name: "취소" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("저장 뒤 결과 다시 읽기는 저장 전에 나간 같은 결과 읽기에 합류하지 않는다 — 새 별칭으로 만든 결과가 보임", async () => {
    let saved: string[] | null = null;
    reads[endpoints.search.watch] = () => watchList([{ ...WATCH_SYNT, aliases: saved ?? WATCH_SYNT.aliases }]);
    reads[FEED_PATH] = () => feed({ items: [row({ id: saved ? "after" : "before", title: saved ? "저장 뒤 결과" : "저장 전 결과" })] });
    api.apiPatch.mockImplementation(async (_path: string, body: { aliases: string[] }) => {
      saved = body.aliases;
      return { ok: true };
    });
    // 처음 결과 읽기(저장 전 별칭으로 만든 것)가 저장보다 늦게 옴 — 외부 출처를 부르면 몇 초 걸림
    const stale = holdNext(FEED_PATH);
    renderScreen();
    const section = await aliasSection();
    await waitFor(() => expect(stale.requested).toBe(true));
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.click(within(section).getByRole("button", { name: "별칭 SynDev 빼기" }));
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(api.apiPatch).toHaveBeenCalledTimes(1));
    // 저장 뒤 결과 다시 읽기가 나간 다음에 앞 읽기가 도착
    await waitFor(() => expect(countShared(FEED_PATH)).toBeGreaterThan(1));
    await act(async () => stale.release());
    expect(await screen.findByText("저장 뒤 결과")).toBeTruthy();
    expect(screen.queryByText("저장 전 결과")).toBeNull();
  });

  it("관심 대상 줄에 별칭 칸이 없으면(옛 응답) 편집하지 않고 그렇다고", async () => {
    const { aliases: _omit, ...withoutAliases } = WATCH_SYNT;
    void _omit;
    reads[endpoints.search.watch] = watchList([withoutAliases]);
    renderScreen();
    const section = await aliasSection();
    expect(within(section).getByText(/별칭을 받지 못해 여기서 고칠 수 없습니다/)).toBeTruthy();
    expect(within(section).queryByRole("button", { name: "별칭 편집" })).toBeNull();
  });

  it("연결 탭(결과 경로가 아닌 탭)의 속성 칸에도 같은 편집 — 저장하면 목록만 다시 읽음", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT]);
    reads[endpoints.search.links("us:SYNT")] = { available: true, entityKey: "us:SYNT", links: [], sources: [], fetchedAt: null };
    renderScreen(MEMBER, "/search?e=us:SYNT&tab=links");
    const section = await aliasSection();
    fireEvent.click(within(section).getByRole("button", { name: "별칭 편집" }));
    fireEvent.click(within(section).getByRole("button", { name: "별칭 SynDev 빼기" }));
    fireEvent.click(within(section).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(patchCalls()).toEqual([[endpoints.search.watchItem(7), { aliases: ["합성전자", "Synthetic Devices"] }]]));
    expect(countReads(FEED_PATH)).toBe(0);
  });

  it("데모 열람은 읽기만 — 편집 단추 없이 조회만 된다는 글", () => {
    const watch = {
      saveAliases: vi.fn(),
      clearAliasError: vi.fn(),
      aliasBusy: false,
      aliasError: null,
    } as unknown as InfoSearchWatch;
    render(<AliasEditor watch={watch} item={WATCH_SYNT as SearchWatchItem} demo />);
    const section = screen.getByRole("region", { name: "관심 대상 별칭" });
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
    expect(within(section).queryByRole("button")).toBeNull();
    expect(within(section).getByText(DEMO_READ_ONLY)).toBeTruthy();
  });
});

describe("새 글 알림 켜기(계약 §9-5)", () => {
  it("목록 줄마다 종 + 켬·끔(aria-pressed, 낭독 이름은 '<대상 이름> 알림'으로 상태와 상관없이 같음) — 누르면 PATCH {notify} 뒤 목록을 다시 읽어 상태가 바뀜", async () => {
    let notify = false;
    reads[endpoints.search.watch] = () => watchList([{ ...WATCH_SYNT, notify }, WATCH_TOPIC]);
    api.apiPatch.mockImplementation(async (_path: string, body: { notify: boolean }) => {
      notify = body.notify;
      return { ok: true };
    });
    renderScreen(MEMBER, "/search");
    const list = await screen.findByRole("list", { name: "관심 대상 목록" });
    const off = within(list).getByRole("button", { name: "합성전자 알림" });
    expect(off.getAttribute("aria-pressed")).toBe("false");
    expect(off.textContent).toContain("끔");
    const on = within(list).getByRole("button", { name: "합성 주제 알림" });
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.textContent).toContain("켬");
    // 누르는 자리(좁은 화면 44px)와 포커스 링
    expect(off.className).toMatch(/min-h-11/);
    expect(off.className).toMatch(/min-w-11/);
    expect(off.className).toMatch(/focus-visible:outline-2/);
    expect(screen.getByText(/알림을 켠 대상은 새 글이 들어오면 알림함에 한 줄을 남깁니다/)).toBeTruthy();

    fireEvent.click(off);
    await waitFor(() => expect(patchCalls()).toEqual([[endpoints.search.watchItem(7), { notify: true }]]));
    await waitFor(() => expect(within(list).getByRole("button", { name: "합성전자 알림" }).getAttribute("aria-pressed")).toBe("true"));
    expect(within(list).getByRole("button", { name: "합성전자 알림" }).textContent).toContain("켬");
  });

  it("대상 머리의 별 옆에도 같은 단추(보이는 글 '알림 끔'·'알림 켬', 낭독 이름은 늘 '알림') — 누르면 그 줄의 번호로", async () => {
    let notify = false;
    reads[endpoints.search.watch] = () => watchList([{ ...WATCH_SYNT, notify }]);
    api.apiPatch.mockImplementation(async (_path: string, body: { notify: boolean }) => {
      notify = body.notify;
      return { ok: true };
    });
    renderScreen();
    await screen.findByRole("heading", { level: 2, name: "합성전자" });
    const header = await screen.findByRole("button", { name: "알림" });
    expect(header.getAttribute("aria-pressed")).toBe("false");
    expect(header.textContent).toBe("알림 끔");
    fireEvent.click(header);
    await waitFor(() => expect(patchCalls()).toEqual([[endpoints.search.watchItem(7), { notify: true }]]));
    await waitFor(() => expect(screen.getByRole("button", { name: "알림" }).getAttribute("aria-pressed")).toBe("true"));
    expect(screen.getByRole("button", { name: "알림" }).textContent).toBe("알림 켬");
  });

  it("관심 대상이 아니면 머리에 알림 단추가 없다(등록 단추만)", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_TOPIC]);
    renderScreen();
    await screen.findByRole("button", { name: "관심 대상 등록" });
    expect(screen.queryByRole("button", { name: "알림" })).toBeNull();
  });

  it("바꾸는 동안 모든 알림 단추가 aria-disabled — 다른 줄을 눌러도 보내지 않음", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT, WATCH_TOPIC]);
    let finish: (value: unknown) => void = () => {};
    api.apiPatch.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    renderScreen(MEMBER, "/search");
    const list = await screen.findByRole("list", { name: "관심 대상 목록" });
    fireEvent.click(within(list).getByRole("button", { name: "합성전자 알림" }));
    const other = within(list).getByRole("button", { name: "합성 주제 알림" });
    await waitFor(() => expect(other.getAttribute("aria-disabled")).toBe("true"));
    expect(within(list).getByRole("button", { name: "합성전자 알림" }).getAttribute("aria-busy")).toBe("true");
    fireEvent.click(other);
    expect(api.apiPatch).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    await waitFor(() => expect(other.getAttribute("aria-disabled")).toBeNull());
  });

  it("실패는 누른 자리에만 글(role=alert) — 목록에서 눌렀으면 목록 아래, 머리에서 눌렀으면 머리 아래", async () => {
    reads[endpoints.search.watch] = watchList([WATCH_SYNT]);
    api.apiPatch.mockRejectedValue(Object.assign(new Error("요청 실패 (HTTP 403)"), { status: 403 }));
    renderScreen();
    await screen.findByRole("heading", { level: 2, name: "합성전자" });
    const list = await screen.findByRole("list", { name: "관심 대상 목록" });
    fireEvent.click(within(list).getByRole("button", { name: "합성전자 알림" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("'합성전자' 알림을 바꾸지 못했습니다 — 이 계정으로는 할 수 없습니다");
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    api.apiPatch.mockRejectedValue(Object.assign(new Error("관심 대상을 찾지 못했습니다"), { status: 404 }));
    fireEvent.click(screen.getByRole("button", { name: "알림" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("주의: 알림을 바꾸지 못했습니다 — 관심 대상을 찾지 못했습니다"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("서버가 알림 칸을 주지 않으면(옛 응답) 단추를 그리지 않음 — 끔으로 채우지 않음", async () => {
    const { notify: _omit, ...withoutNotify } = WATCH_SYNT;
    void _omit;
    reads[endpoints.search.watch] = watchList([withoutNotify]);
    renderScreen();
    await screen.findByRole("heading", { level: 2, name: "합성전자" });
    await screen.findByRole("list", { name: "관심 대상 목록" });
    expect(screen.queryByRole("button", { name: /알림$/ })).toBeNull();
    expect(screen.queryByText(/알림을 켠 대상은/)).toBeNull();
  });

  it("알림을 바꾼 뒤 다시 읽기는 그 전에 나간 목록 읽기('봤음' 뒤 다시 읽기)에 합류하지 않는다 — 바뀐 상태가 보임", async () => {
    let notify = false;
    reads[endpoints.search.watch] = () => watchList([{ ...WATCH_SYNT, notify }]);
    let seenDone: (value: unknown) => void = () => {};
    api.apiPost.mockImplementation((path: string) =>
      path === endpoints.search.watchSeen(7) ? new Promise((resolve) => (seenDone = resolve)) : Promise.resolve({ ok: true }),
    );
    api.apiPatch.mockImplementation(async (_path: string, body: { notify: boolean }) => {
      notify = body.notify;
      return { ok: true };
    });
    renderScreen();
    const header = await screen.findByRole("button", { name: /^알림( 끔)?$/ });
    await waitFor(() => expect(api.apiPost).toHaveBeenCalledWith(endpoints.search.watchSeen(7)));
    // '봤음' 뒤의 목록 읽기(알림을 바꾸기 전의 값)가 늦게 옴
    const stale = holdNext(endpoints.search.watch);
    await act(async () => seenDone({ ok: true }));
    await waitFor(() => expect(stale.requested).toBe(true));
    const readsBefore = countShared(endpoints.search.watch);

    fireEvent.click(header);
    await waitFor(() => expect(patchCalls()).toEqual([[endpoints.search.watchItem(7), { notify: true }]]));
    // 바꾼 뒤의 다시 읽기가 나간 다음에 앞 읽기가 도착
    await waitFor(() => expect(countShared(endpoints.search.watch)).toBeGreaterThan(readsBefore));
    await act(async () => stale.release());
    await waitFor(() => expect(screen.getByRole("button", { name: /^알림( 켬| 끔)?$/ }).getAttribute("aria-pressed")).toBe("true"));
    expect(within(await screen.findByRole("list", { name: "관심 대상 목록" })).getByRole("button", { name: /^합성전자 알림/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("데모는 알림 단추가 없다(관심 대상을 읽지도 쓰지도 않음)", async () => {
    renderScreen(DEMO);
    await screen.findByRole("heading", { level: 2, name: "합성전자" });
    expect(screen.queryByRole("button", { name: /알림$/ })).toBeNull();
    expect(sharedCalls()).not.toContain(endpoints.search.watch);
    expect(api.apiPatch).not.toHaveBeenCalled();
  });
});
