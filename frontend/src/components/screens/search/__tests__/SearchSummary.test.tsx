/**
 * 정보 검색 단계 6 묶음 3(계약 §9-6) 화면 — AI 요약(운영자 전용). 응답은 모두 합성 값이고 실제 AI를 부르지 않습니다(lib/api를 가짜로 둠).
 *  - '요약' 단추는 결과 머리(지금 새로 받기 줄)에 운영자에게만 — 회원·데모에는 없음, 고른 기간에 받은 줄이 없으면 없음
 *  - 누르면 POST /api/search/summary {e, tab, range}, 읽는 동안 글(role=status), 받으면 결과 위 패널: 'AI 요약 — 받은 자료 n건의 제목·요약만 보고
 *    만든 것, 원문 확인 필요', 줄마다 근거 줄로 가는 단추(목록에서 그 줄을 고름 — 접힌 같은 사건 묶음이면 펼침), 지금 목록에 없는 줄은 글로만,
 *    받은 자료에 없는 근거는 건수, 모델·만든 시각(KST), 다시 쓴 요약이면 '캐시'
 *  - 실패는 글(role=alert), 대상·탭·기간이 바뀌면 패널을 비움, 닫으면 포커스는 '요약' 단추로
 *  - 서버는 요약을 한 번에 하나만 만듦(겹치면 429) — 읽는 동안 기간·탭을 바꾸면 단추를 잠그고 앞 요약을 만드는 중이라고 적음(끝나면 풀림),
 *    읽는 중인 기간·탭으로 돌아오면 읽는 중으로 보이고 그 응답을 받음(두 번 보내지 않음)
 *  - 서버가 읽은 줄이 0건이면 'AI 요약 … 보고 만든 것' 안내를 붙이지 않음
 *  - 모델이 준 글은 글로만 그림(링크·태그로 바꾸지 않음), 긴 낱말도 줄을 바꿈(좁은 화면에서 잘리지 않게)
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

import { resetSummaryRequestsForTest } from "@/hooks/useInfoSearchSummary";
import { SessionUserProvider } from "@/hooks/useSessionUser";
import { endpoints } from "@/lib/endpoints";
import type { SearchFeedItem, SearchSummaryResponse, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const OWNER: SessionUser = { email: "o@test.local", role: "OWNER", tier: "PRO" };
const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };
const DEMO: SessionUser = { email: "demo@test.local", role: "MEMBER", tier: "FREE", demo: true };

const SYNTH = {
  key: "us:SYNT", kind: "company", name: "합성전자", nameKo: "합성전자", nameEn: "Synthetic Devices", aliases: ["합성전자", "Synthetic Devices"],
  description: null,
  ids: { ticker: "SYNT", market: "us", stockCode: null, cik: "0000000001", dartCorpCode: null, wikidata: "Q1", lei: null },
  links: [], sources: ["sec", "wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "합성 기사", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null,
    clusterId: null, cluster: null, ...over,
  };
}

// c1 묶음 = 대표 c1a(가장 이른 줄) + c1b + c1c. 기본은 묶어 보기라 c1b·c1c는 접혀 있습니다.
const ROWS = [
  row({ id: "c1a", title: "대표 기사", clusterId: "c1a", cluster: { size: 3, publishers: 2 }, publisher: "Alpha", publishedAt: "2026-11-13T01:00:00+00:00" }),
  row({ id: "p1", title: "묶이지 않은 기사", publishedAt: "2026-11-13T23:00:00+00:00" }),
  row({ id: "c1b", title: "둘째 보도", clusterId: "c1a", publisher: "Beta", publishedAt: "2026-11-13T22:00:00+00:00" }),
  row({ id: "c1c", title: "셋째 보도", clusterId: "c1a", publisher: "Alpha", publishedAt: "2026-11-13T05:00:00+00:00" }),
  row({ id: "f1", title: "합성 분기 공시", kind: "filing", source: "sec", publisher: "SYNTHETIC DEVICES", publisherDomain: "sec.gov",
    publishedAt: "2026-11-10T01:00:00+00:00" }),
  row({ id: "old", title: "지난달 기사", publishedAt: "2026-10-20T01:00:00+00:00" }),
];

const SOURCES = [
  { source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 5, dropped: null, message: null },
  { source: "sec", label: "SEC 공시(회사별)", status: "ok", count: 1, dropped: null, message: null },
];

function feed(over: Record<string, unknown> = {}) {
  return {
    available: true, entityKey: "us:SYNT", tab: "timeline", items: ROWS, sources: SOURCES,
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 5, "30d": 6, "1y": 6, "2y": 6 },
    olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00", ...over,
  };
}

const SUMMARY: SearchSummaryResponse = {
  available: true,
  summary: [
    { text: "첫째 요약 줄", refs: ["p1", "c1a"] },
    { text: "둘째 요약 줄", refs: ["c1b", "f1", "gone"] },
  ],
  basedOn: 6,
  model: "synthetic-model-1",
  generatedAt: "2026-11-14T01:05:00+00:00",
  cached: false,
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않습니다(읽는 중). */
let reads: Record<string, unknown>;
function serve(path: string): Promise<unknown> {
  const hit = Object.keys(reads)
    .sort((a, b) => b.length - a.length)
    .find((prefix) => path === prefix || path.startsWith(prefix));
  return hit ? Promise.resolve(reads[hit]) : new Promise(() => {});
}

/** 요약 POST — 시험이 끝낼 때까지 붙잡습니다(watch 등록 같은 다른 POST는 바로 답함). */
type Pending = { body: unknown; resolve: (value: unknown) => void; reject: (error: unknown) => void };
let summaries: Pending[];

function renderScreen(user: SessionUser = OWNER, path = "/search?e=us:SYNT") {
  setLocation(path);
  return render(
    <SessionUserProvider user={user}>
      <SearchScreen />
    </SessionUserProvider>,
  );
}

const summaryButton = () => screen.findByRole("button", { name: "요약" });
const rangeButton = (label: RegExp) => within(screen.getByRole("region", { name: "거르기" })).getByRole("button", { name: label });
/** 앞서 누른 요약을 만드는 중이라는 상태 글(다른 기간·탭에서 단추가 잠겼을 때). */
const WAITING = /한 번에 하나만 만듭니다/;
const panel = () => screen.findByRole("region", { name: "AI 요약" });
const listbox = () => screen.getByRole("listbox", { name: "결과" });
const option = (title: string) => within(listbox()).getAllByRole("option").find((element) => element.textContent?.includes(title)) ?? null;

/** 단추를 누르고 붙잡은 요약 POST에 답합니다. */
async function summarize(response: unknown = SUMMARY) {
  fireEvent.click(await summaryButton());
  await waitFor(() => expect(summaries.length).toBeGreaterThan(0));
  await act(async () => summaries[summaries.length - 1].resolve(response));
  return panel();
}

beforeEach(() => {
  resetSummaryRequestsForTest();
  reads = {};
  summaries = [];
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiPatch, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  api.apiPost.mockImplementation((path: string, body: unknown) => {
    if (path !== endpoints.search.summary) return Promise.resolve({ ok: true });
    return new Promise((resolve, reject) => summaries.push({ body, resolve, reject }));
  });
  reads[endpoints.search.entity("us:SYNT")] = { available: true, entity: SYNTH, errors: {} };
  reads[endpoints.search.feed("us:SYNT", "timeline")] = feed();
  reads[endpoints.search.watch] = { available: true, items: [], limits: null, collecting: null };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("'요약' 단추 — 운영자만(계약 §9-6)", () => {
  it("운영자에게는 결과 머리(지금 새로 받기 옆)에 단추", async () => {
    renderScreen(OWNER);
    const button = await summaryButton();
    const refresh = screen.getByRole("button", { name: /지금 새로 받기/ });
    expect(button.parentElement?.closest("div")).toBe(refresh.closest("div"));
    expect(api.apiPost).not.toHaveBeenCalledWith(endpoints.search.summary, expect.anything());
  });

  it("회원·데모에게는 단추가 없음", async () => {
    for (const user of [MEMBER, DEMO]) {
      renderScreen(user);
      await screen.findByRole("listbox", { name: "결과" });
      expect(screen.queryByRole("button", { name: "요약" })).toBeNull();
      cleanup();
    }
    expect(api.apiPost).not.toHaveBeenCalledWith(endpoints.search.summary, expect.anything());
  });

  it("고른 기간에 받은 줄이 없으면 단추가 없음(요약할 자료가 없음)", async () => {
    reads[endpoints.search.feed("us:SYNT", "timeline")] = feed({ items: [], rangeCounts: { "7d": 0, "30d": 0, "1y": 0, "2y": 0 } });
    renderScreen(OWNER);
    await screen.findByText("최근 2년 안의 자료가 없습니다");
    expect(screen.queryByRole("button", { name: "요약" })).toBeNull();
  });
});

describe("요약 받기", () => {
  it("누르면 POST {e, tab, range}, 읽는 동안 글(role=status), 받으면 결과 위 패널", async () => {
    renderScreen(OWNER, "/search?e=us:SYNT&tab=timeline&range=30d");
    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(1));
    expect(api.apiPost).toHaveBeenCalledWith(endpoints.search.summary, { e: "us:SYNT", tab: "timeline", range: "30d" });
    const loading = screen.getByText(/요약하는 중/);
    expect(loading.closest("[role=status]")).not.toBeNull();
    expect((await summaryButton()).getAttribute("aria-disabled")).toBe("true");

    // 읽는 동안 다시 눌러도 한 번
    fireEvent.click(await summaryButton());
    expect(summaries).toHaveLength(1);

    await act(async () => summaries[0].resolve(SUMMARY));
    const region = await panel();
    expect(within(region).getByText("AI 요약 — 받은 자료 6건의 제목·요약만 보고 만든 것, 원문 확인 필요")).toBeTruthy();
    expect(within(region).getByText("첫째 요약 줄")).toBeTruthy();
    expect(within(region).getByText("둘째 요약 줄")).toBeTruthy();
    expect(within(region).getByText("모델 synthetic-model-1 · 만든 시각 2026-11-14 10:05 KST")).toBeTruthy();
    expect(within(region).queryByText("캐시")).toBeNull();
    expect(screen.queryByText(/요약하는 중/)).toBeNull();
    // 패널은 결과 목록 위
    expect(region.compareDocumentPosition(listbox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("다시 쓴 요약이면 '캐시'(글 — 색만이 아님)", async () => {
    renderScreen(OWNER);
    const region = await summarize({ ...SUMMARY, cached: true });
    expect(within(region).getByText("캐시")).toBeTruthy();
  });

  it("받아 둔 결과가 없어 요약에 들지 않은 출처는 이름으로 적음(실패를 '없음'으로 보이지 않게)", async () => {
    renderScreen(OWNER);
    const region = await summarize({ ...SUMMARY, offlineSources: ["google_en"] });
    expect(within(region).getByText(/요약에 들지 않은 출처: 구글 뉴스\(영어\)/)).toBeTruthy();
  });

  it("고른 기간·탭이 요청에 그대로 — 뉴스 탭 1년", async () => {
    reads[endpoints.search.feed("us:SYNT", "news")] = feed({ tab: "news" });
    renderScreen(OWNER, "/search?e=us:SYNT&tab=news&range=1y");
    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(1));
    expect(summaries[0].body).toEqual({ e: "us:SYNT", tab: "news", range: "1y" });
  });
});

describe("근거 줄로 가기", () => {
  it("목록에 보이는 줄은 단추 — 누르면 그 줄을 고르고(미리 보기) 포커스는 결과 목록", async () => {
    renderScreen(OWNER);
    const region = await summarize();
    const ref = within(region).getByRole("button", { name: /묶이지 않은 기사/ });
    fireEvent.click(ref);
    expect(option("묶이지 않은 기사")?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(listbox());
    expect(screen.getByRole("region", { name: "미리 보기" })).toBeTruthy();
  });

  it("접힌 같은 사건 묶음의 줄도 단추 — 누르면 묶음을 펼치고 그 줄을 고름", async () => {
    renderScreen(OWNER);
    const region = await summarize();
    expect(option("둘째 보도")).toBeNull();
    fireEvent.click(within(region).getByRole("button", { name: /둘째 보도/ }));
    await waitFor(() => expect(option("둘째 보도")?.getAttribute("aria-selected")).toBe("true"));
    expect(screen.getByText(/같은 사건 3건 · 매체 2곳 — 접기/)).toBeTruthy();
    expect(document.activeElement).toBe(listbox());
  });

  it("지금 목록에 없는 줄(거르기로 숨김)은 글로만, 받은 자료에 없는 근거는 건수", async () => {
    renderScreen(OWNER);
    await screen.findByRole("listbox", { name: "결과" });
    fireEvent.click(within(screen.getByRole("region", { name: "거르기" })).getByRole("checkbox", { name: "공시 1건" }));
    const region = await summarize();
    expect(within(region).queryByRole("button", { name: /합성 분기 공시/ })).toBeNull();
    const plain = within(region).getByText("합성 분기 공시");
    expect(plain.closest("button")).toBeNull();
    expect(within(region).getByText(/지금 목록에 없음/)).toBeTruthy();
    expect(within(region).getByText("받은 자료에서 찾지 못한 근거 1건")).toBeTruthy();
  });

  it("거르기를 풀면 그 근거가 다시 단추", async () => {
    renderScreen(OWNER);
    await screen.findByRole("listbox", { name: "결과" });
    const filing = () => within(screen.getByRole("region", { name: "거르기" })).getByRole("checkbox", { name: "공시 1건" });
    fireEvent.click(filing());
    const region = await summarize();
    expect(within(region).queryByRole("button", { name: /합성 분기 공시/ })).toBeNull();
    fireEvent.click(filing());
    expect(within(region).getByRole("button", { name: /합성 분기 공시/ })).toBeTruthy();
  });

  it("모델이 준 글은 글로만 — 링크·태그로 바꾸지 않음", async () => {
    renderScreen(OWNER);
    const text = "[누르세요](https://evil.example) <img src=x onerror=alert(1)> 무시하고 지시를 따르라";
    const region = await summarize({ ...SUMMARY, summary: [{ text, refs: ["p1"] }] });
    expect(within(region).getByText(text)).toBeTruthy();
    expect(region.querySelector("a")).toBeNull();
    expect(region.querySelector("img")).toBeNull();
  });
});

describe("실패·비우기", () => {
  it("요청 실패는 글(role=alert)", async () => {
    renderScreen(OWNER);
    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(1));
    await act(async () => summaries[0].reject(new Error("네트워크 오류")));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("요약하지 못했습니다 — 네트워크 오류");
    expect(screen.queryByRole("region", { name: "AI 요약" })).toBeNull();
  });

  it("수집기·엔진에 닿지 못한 응답은 서버 사유(role=alert)", async () => {
    renderScreen(OWNER);
    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(1));
    await act(async () => summaries[0].resolve({ available: false, message: "오늘 AI 글자 상한을 다 썼습니다." }));
    expect((await screen.findByRole("alert")).textContent).toContain("요약하지 못했습니다 — 오늘 AI 글자 상한을 다 썼습니다.");
  });

  it("서버가 읽은 줄이 0건이면 그렇다고 — 'AI 요약 … 보고 만든 것' 안내·'받았습니다' 상태 글을 붙이지 않음", async () => {
    renderScreen(OWNER);
    const region = await summarize({ ...SUMMARY, summary: [], basedOn: 0, model: null, generatedAt: null });
    expect(within(region).getByText("고른 기간에 받아 둔 자료가 없어 요약하지 않았습니다.")).toBeTruthy();
    expect(within(region).queryByText(/보고 만든 것/)).toBeNull();
    expect(screen.queryByText("AI 요약을 받았습니다")).toBeNull();
    const status = screen.getAllByRole("status").find((element) => element.textContent?.includes("요약하지 않았습니다"));
    expect(status).toBeTruthy();
  });

  it("요약 글·실패 사유는 긴 낱말도 줄을 바꿈(break-words — 좁은 화면에서 가로로 넘쳐 잘리지 않게)", async () => {
    renderScreen(OWNER);
    const long = "x".repeat(300);
    const region = await summarize({ ...SUMMARY, summary: [{ text: long, refs: ["p1"] }] });
    expect(within(region).getByText(long).className).toMatch(/break-words/);
    fireEvent.click(within(region).getByRole("button", { name: "요약 닫기" }));

    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(2));
    await act(async () => summaries[1].reject(new Error("y".repeat(200))));
    const alert = await screen.findByRole("alert");
    const reason = within(alert).getByText(/요약하지 못했습니다/).closest(".break-words");
    expect(reason).not.toBeNull();
    expect(reason?.className).toMatch(/min-w-0/);
  });

  it("기간을 바꾸면 패널을 비움", async () => {
    renderScreen(OWNER);
    await summarize();
    fireEvent.click(rangeButton(/^7일/));
    await waitFor(() => expect(window.location.search).toContain("range=7d"));
    expect(screen.queryByRole("region", { name: "AI 요약" })).toBeNull();
  });

  it("읽는 동안 기간을 바꾸면 패널을 비우고 단추를 잠금(앞 요약을 만드는 중 — role=status) — 끝나도 그 요약은 보이지 않고 단추가 풀림", async () => {
    renderScreen(OWNER);
    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(1));
    fireEvent.click(rangeButton(/^7일/));
    await waitFor(() => expect(window.location.search).toContain("range=7d"));
    expect(screen.queryByText(/요약하는 중/)).toBeNull();
    const waiting = screen.getByText(WAITING);
    expect(waiting.closest("[role=status]")).not.toBeNull();
    expect((await summaryButton()).getAttribute("aria-disabled")).toBe("true");

    // 서버는 겹치면 429 — 잠긴 동안 눌러도 보내지 않음
    fireEvent.click(await summaryButton());
    expect(summaries).toHaveLength(1);

    await act(async () => summaries[0].resolve(SUMMARY));
    expect(screen.queryByRole("region", { name: "AI 요약" })).toBeNull();
    expect(screen.queryByText(WAITING)).toBeNull();
    expect((await summaryButton()).getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(2));
    expect(summaries[1].body).toEqual({ e: "us:SYNT", tab: "timeline", range: "7d" });
  });

  it("읽는 동안 기간을 바꿨다 돌아오면 읽는 중 — 그 응답을 받음(두 번 보내지 않음)", async () => {
    renderScreen(OWNER);
    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(1));
    fireEvent.click(rangeButton(/^7일/));
    await waitFor(() => expect(window.location.search).toContain("range=7d"));
    fireEvent.click(rangeButton(/^30일/));
    await waitFor(() => expect(window.location.search).toContain("range=30d"));
    expect(screen.getByText(/요약하는 중/)).toBeTruthy();
    fireEvent.click(await summaryButton());
    expect(summaries).toHaveLength(1);

    await act(async () => summaries[0].resolve(SUMMARY));
    expect(within(await panel()).getByText("첫째 요약 줄")).toBeTruthy();
  });

  it("읽는 동안 탭을 바꾸면 잠그고, 돌아오면 읽는 중 — 그 응답을 받음(두 번 보내지 않음)", async () => {
    reads[endpoints.search.feed("us:SYNT", "news")] = feed({ tab: "news" });
    renderScreen(OWNER);
    fireEvent.click(await summaryButton());
    await waitFor(() => expect(summaries).toHaveLength(1));

    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    await waitFor(() => expect(window.location.search).toContain("tab=news"));
    await screen.findByRole("listbox", { name: "결과" });
    expect(await screen.findByText(WAITING)).toBeTruthy();
    expect((await summaryButton()).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(await summaryButton());
    expect(summaries).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: "타임라인" }));
    await waitFor(() => expect(window.location.search).toContain("tab=timeline"));
    expect(await screen.findByText(/요약하는 중/)).toBeTruthy();
    await act(async () => summaries[0].resolve(SUMMARY));
    expect(within(await panel()).getByText("첫째 요약 줄")).toBeTruthy();
    expect(summaries).toHaveLength(1);
  });

  it("탭을 바꾸면 패널을 비움", async () => {
    reads[endpoints.search.feed("us:SYNT", "news")] = feed({ tab: "news" });
    renderScreen(OWNER);
    await summarize();
    fireEvent.click(screen.getByRole("tab", { name: "뉴스" }));
    await waitFor(() => expect(window.location.search).toContain("tab=news"));
    await screen.findByRole("listbox", { name: "결과" });
    expect(screen.queryByRole("region", { name: "AI 요약" })).toBeNull();
  });

  it("닫으면 패널이 사라지고 포커스는 '요약' 단추", async () => {
    renderScreen(OWNER);
    const region = await summarize();
    fireEvent.click(within(region).getByRole("button", { name: "요약 닫기" }));
    expect(screen.queryByRole("region", { name: "AI 요약" })).toBeNull();
    expect(document.activeElement).toBe(await summaryButton());
  });
});
