/**
 * 정보 검색 단계 6 묶음 1(계약 §9-1~9-3) 화면. 응답은 모두 합성 값입니다(실제 응답 원문·실제 사람의 자료를 쓰지 않음 — ADR 0026 결정 12).
 *  - 기간 막대: 결과 위에 고른 기간의 건수(7일·30일 하루씩, 1년·2년 월요일 시작 주), 지금 탭·거르기를 거친 줄(묶기와 상관없이 줄 수),
 *    '받은 자료 기준' 한 줄을 늘, 막대마다 낭독 이름(날짜·건수)과 숨긴 표, 누르면 그 날·주로 좁히고 다시 누르거나 '좁히기 풀기'로 풂
 *  - 같은 사건 묶기: 기본은 묶어 보기(대표 줄 아래 '같은 사건 n건 · 매체 m곳 — 펼치기'), 끄면 모든 줄, ↑↓·Enter가 그대로 됨,
 *    관심 대상 목록의 '화제' 글 배지(색만이 아님)
 *  - 연결 그림: '목록 | 그림' 전환, 노드마다 이름·관계 낭독 이름, 누르기·Enter로 그 대상(키가 없으면 이름으로 찾기), 30개 넘으면 '목록에서 n개 더'
 */
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
import { PERIOD_BARS_NOTE } from "@/lib/infoSearch";
import type { SearchFeedItem, SearchLink, SessionUser } from "@/lib/types";
import { SearchScreen } from "../SearchScreen";
import { setLocation } from "./fakeNavigation";

const MEMBER: SessionUser = { email: "m@test.local", role: "MEMBER", tier: "FREE" };

const NVIDIA = {
  key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
  description: null,
  ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477", lei: null },
  links: [
    { relation: "subsidiary", key: "wd:Q100", name: "Mellanox", kind: "company", source: "wikidata" },
    { relation: "founded_by", key: null, name: "Jensen Huang", kind: "person", source: "wikidata" },
  ],
  sources: ["sec", "wikidata"],
};

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null,
    clusterId: null, cluster: null, ...over,
  };
}

// 최근순이 아니게 섞어 둠(화면이 정렬). c1 묶음 = 대표 c1a(가장 이른 줄) + c1b + c1c.
const ROWS = [
  row({ id: "c1a", title: "대표 기사", clusterId: "c1a", cluster: { size: 3, publishers: 2 }, publisher: "Alpha", publisherDomain: "alpha.example",
    url: "https://alpha.example/lead", publishedAt: "2026-11-13T01:00:00+00:00" }), // KST 11-13 10:00
  row({ id: "p1", title: "묶이지 않은 기사", publishedAt: "2026-11-13T23:00:00+00:00" }), // KST 11-14 08:00
  row({ id: "c1b", title: "둘째 보도", clusterId: "c1a", publisher: "Beta", publisherDomain: "beta.example", url: "https://beta.example/b",
    summary: "둘째 요약", publishedAt: "2026-11-13T22:00:00+00:00" }), // KST 11-14 07:00
  row({ id: "c1c", title: "셋째 보도", clusterId: "c1a", publisher: "Alpha", publisherDomain: "alpha.example", url: "https://alpha.example/c",
    publishedAt: "2026-11-13T05:00:00+00:00" }), // KST 11-13 14:00
  row({ id: "f1", title: "10-Q · Quarterly report", kind: "filing", source: "sec", publisher: "NVIDIA CORP", publisherDomain: "sec.gov",
    publishedAt: "2026-11-10T01:00:00+00:00" }), // KST 11-10
  row({ id: "old", title: "지난달 기사", publishedAt: "2026-10-20T01:00:00+00:00" }), // KST 10-20
];

const SOURCES = [
  { source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 5, dropped: null, message: null },
  { source: "sec", label: "SEC 공시(회사별)", status: "ok", count: 1, dropped: null, message: null },
];

function feed(over: Record<string, unknown> = {}) {
  return {
    available: true, entityKey: "us:NVDA", tab: "timeline", items: ROWS, sources: SOURCES,
    window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 5, "30d": 6, "1y": 6, "2y": 6 },
    olderOnlyLatest: null, pending: false, fetchedAt: "2026-11-14T01:00:00+00:00", ...over,
  };
}

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

const barsOf = async () => within(await screen.findByRole("toolbar", { name: /기간 막대/ })).getAllByRole("button");
const options = () => within(screen.getByRole("listbox", { name: "결과" })).getAllByRole("option").map((option) => option.textContent ?? "");

beforeEach(() => {
  reads = {};
  for (const fn of [api.apiGet, api.apiPost, api.apiDelete, api.apiGetShared]) fn.mockReset();
  api.apiGetShared.mockImplementation((path: string) => serve(path));
  api.apiGet.mockImplementation((path: string) => serve(path));
  api.apiPost.mockResolvedValue({ ok: true });
  reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: NVIDIA, errors: {} };
  reads[endpoints.search.feed("us:NVDA", "timeline")] = feed();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("기간 막대(계약 §9-1)", () => {
  it("30일은 하루씩 31칸 — 막대마다 날짜·건수 이름, '받은 자료 기준' 한 줄을 늘, 화면 읽기용 숨긴 표", async () => {
    renderScreen("/search?e=us:NVDA");
    const bars = await barsOf();
    expect(bars.length).toBe(31);
    expect(bars[0].getAttribute("aria-label")).toBe("2026-10-15 (목) 0건");
    expect(bars[30].getAttribute("aria-label")).toBe("2026-11-14 (토) 2건");
    expect(screen.getByRole("button", { name: "2026-11-13 (금) 2건" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2026-11-10 (화) 1건" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2026-10-20 (화) 1건" })).toBeTruthy();
    expect(screen.getByText(PERIOD_BARS_NOTE)).toBeTruthy();
    const table = screen.getByRole("table", { name: /기간별 건수/ });
    // 표 자체가 아니라 감싼 상자가 sr-only(표는 1px 상자를 무시하고 줄 수만큼 커져 화면 밖으로 넘침 — 시각 확인에서 찾음).
    expect(table.className).not.toContain("sr-only");
    expect(table.parentElement?.className).toContain("sr-only");
    expect(within(table).getAllByRole("row").length).toBe(32);
    expect(within(table).getByRole("row", { name: "2026-11-14 (토) 2" })).toBeTruthy();
    // 막대는 결과 목록 위
    const list = screen.getByRole("listbox", { name: "결과" });
    expect(screen.getByRole("toolbar", { name: /기간 막대/ }).compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("막대 건수는 묶기와 상관없이 줄 수 — 묶어 보기로 숨은 줄도 셈", async () => {
    renderScreen("/search?e=us:NVDA");
    await barsOf();
    expect(screen.getByRole("button", { name: "2026-11-14 (토) 2건" })).toBeTruthy();
    expect(options().some((text) => text.includes("둘째 보도"))).toBe(false);
  });

  it("막대를 누르면 그 날로 목록을 좁히고 다시 누르면 풂 — '좁히기 풀기' 단추로도", async () => {
    renderScreen("/search?e=us:NVDA");
    await barsOf();
    const day = screen.getByRole("button", { name: "2026-11-10 (화) 1건" });
    fireEvent.click(day);
    expect(day.getAttribute("aria-pressed")).toBe("true");
    expect(options()).toHaveLength(1);
    expect(options()[0]).toContain("10-Q · Quarterly report");
    expect(screen.getByText("좁힌 기간: 2026-11-10 (화) · 1건")).toBeTruthy();

    fireEvent.click(day);
    expect(day.getAttribute("aria-pressed")).toBe("false");
    expect(options().some((text) => text.includes("묶이지 않은 기사"))).toBe(true);
    expect(screen.queryByText(/좁힌 기간:/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "2026-11-13 (금) 2건" }));
    expect(options().some((text) => text.includes("대표 기사"))).toBe(true);
    expect(options().some((text) => text.includes("묶이지 않은 기사"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "좁히기 풀기" }));
    expect(options().some((text) => text.includes("묶이지 않은 기사"))).toBe(true);
    expect(screen.getByRole("button", { name: "2026-11-13 (금) 2건" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("지금 탭·거르기를 거친 줄로 셈 — 공시를 끄면 그 날 막대가 0건이고 누를 수 없음", async () => {
    renderScreen("/search?e=us:NVDA");
    await barsOf();
    fireEvent.click(within(screen.getByRole("region", { name: "거르기" })).getByRole("checkbox", { name: "공시 1건" }));
    const day = screen.getByRole("button", { name: "2026-11-10 (화) 0건" });
    expect(day.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(day);
    expect(day.getAttribute("aria-pressed")).toBe("false");
  });

  it("좁힌 날의 줄을 거르기로 모두 끄면 그렇다고 하고 풀 단추를 둠", async () => {
    renderScreen("/search?e=us:NVDA");
    await barsOf();
    fireEvent.click(screen.getByRole("button", { name: "2026-11-10 (화) 1건" }));
    fireEvent.click(within(screen.getByRole("region", { name: "거르기" })).getByRole("checkbox", { name: "공시 1건" }));
    expect(screen.getByText("좁힌 기간(막대)에 맞는 자료가 없습니다")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "좁히기 풀기" })[0]);
    expect(screen.queryByText("좁힌 기간(막대)에 맞는 자료가 없습니다")).toBeNull();
    expect(options().some((text) => text.includes("묶이지 않은 기사"))).toBe(true);
  });

  it("빈 결과 안내의 '좁히기 풀기'를 누르면 안내가 사라지고 포커스는 결과 목록으로(처음부터 다시 찾지 않게)", async () => {
    renderScreen("/search?e=us:NVDA");
    await barsOf();
    fireEvent.click(screen.getByRole("button", { name: "2026-11-10 (화) 1건" }));
    fireEvent.click(within(screen.getByRole("region", { name: "거르기" })).getByRole("checkbox", { name: "공시 1건" }));
    const notice = screen.getByText("좁힌 기간(막대)에 맞는 자료가 없습니다").parentElement as HTMLElement;
    const clear = within(notice).getByRole("button", { name: "좁히기 풀기" });
    clear.focus();
    fireEvent.click(clear);
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "결과" }));
  });

  it("기간을 바꾸면 막대 좁히기가 풀림 — 같은 하루 단위(30일 → 7일)여도", async () => {
    renderScreen("/search?e=us:NVDA");
    await barsOf();
    fireEvent.click(screen.getByRole("button", { name: "2026-11-13 (금) 2건" }));
    expect(screen.getByText(/좁힌 기간:/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole("region", { name: "거르기" })).getByRole("button", { name: /^7일/ }));
    await waitFor(() => expect(window.location.search).toContain("range=7d"));
    expect((await barsOf()).length).toBe(8);
    expect(screen.getByRole("button", { name: "2026-11-13 (금) 2건" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText(/좁힌 기간:/)).toBeNull();
    expect(options().some((text) => text.includes("묶이지 않은 기사"))).toBe(true);
  });

  it("좁은 화면(lg 미만)은 막대가 그림뿐이고 44px 고르기 상자로 날·주를 고름 — 고르면 좁히고 '좁히지 않음'으로 풂", async () => {
    renderScreen("/search?e=us:NVDA");
    await barsOf();
    // 누르는 막대 줄은 넓은 화면(lg)에서만 — 좁은 화면에서는 같은 막대를 그림(낭독 제외)으로만 그림.
    const toolbar = screen.getByRole("toolbar", { name: /기간 막대/ });
    expect(toolbar.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(toolbar.className).toContain("lg:flex");
    const picture = toolbar.nextElementSibling as HTMLElement;
    expect(picture.getAttribute("aria-hidden")).toBe("true");
    expect(picture.className).toContain("lg:hidden");
    expect(within(picture).queryAllByRole("button")).toHaveLength(0);

    const select = screen.getByRole("combobox", { name: "날로 좁히기" });
    expect(select.className).toContain("min-h-11");
    // 같은 고르기 상자는 넓은 화면에도 있습니다(막대의 대체 조작 — QA-859). 전에는 lg:hidden 안이었습니다.
    expect(select.closest(".lg\\:hidden")).toBeNull();
    // 건수가 있는 날만, 최근 날부터.
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "좁히지 않음",
      "2026-11-14 (토) 2건",
      "2026-11-13 (금) 2건",
      "2026-11-10 (화) 1건",
      "2026-10-20 (화) 1건",
    ]);
    fireEvent.change(select, { target: { value: "2026-11-10" } });
    expect(options()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "2026-11-10 (화) 1건" }).getAttribute("aria-pressed")).toBe("true");
    expect((select as HTMLSelectElement).value).toBe("2026-11-10");
    fireEvent.change(select, { target: { value: "" } });
    expect(options().some((text) => text.includes("묶이지 않은 기사"))).toBe(true);
    expect(screen.queryByText(/좁힌 기간:/)).toBeNull();
  });

  it("좁은 화면의 고르기 상자 — 1년은 주로 고름", async () => {
    renderScreen("/search?e=us:NVDA&range=1y");
    await barsOf();
    const select = screen.getByRole("combobox", { name: "주로 좁히기" });
    expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "좁히지 않음",
      "2026-11-09 ~ 2026-11-15 주 5건",
      "2026-10-19 ~ 2026-10-25 주 1건",
    ]);
  });

  it("1년은 월요일 시작 주마다 — 막대 이름은 그 주의 시작~끝", async () => {
    renderScreen("/search?e=us:NVDA&range=1y");
    const bars = await barsOf();
    expect(bars.length).toBe(53);
    expect(screen.getByRole("button", { name: "2026-11-09 ~ 2026-11-15 주 5건" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "2026-10-19 ~ 2026-10-25 주 1건" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /주마다\(월요일 시작\)/ })).toBeTruthy();
    expect(screen.getByRole("table", { name: /주마다, 월요일 시작/ })).toBeTruthy();
  });

  it("키보드 — 막대 줄은 Tab 자리 하나, ←→·Home·End로 옮김", async () => {
    renderScreen("/search?e=us:NVDA&range=7d");
    const bars = await barsOf();
    expect(bars.length).toBe(8);
    expect(bars.filter((bar) => bar.getAttribute("tabindex") === "0")).toHaveLength(1);
    const last = bars[7];
    expect(last.getAttribute("tabindex")).toBe("0");
    last.focus();
    fireEvent.keyDown(last, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(bars[6]);
    fireEvent.keyDown(bars[6], { key: "Home" });
    expect(document.activeElement).toBe(bars[0]);
    fireEvent.keyDown(bars[0], { key: "End" });
    expect(document.activeElement).toBe(bars[7]);
  });
});

describe("같은 사건 묶기(계약 §9-2)", () => {
  it("기본은 묶어 보기 — 대표 줄 아래 '같은 사건 3건 · 매체 2곳 — 펼치기', 누르면 나머지 줄이 펼쳐지고 '접기'", async () => {
    renderScreen("/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    expect(options().some((text) => text.includes("대표 기사"))).toBe(true);
    expect(options().some((text) => text.includes("둘째 보도") || text.includes("셋째 보도"))).toBe(false);
    const toggle = screen.getByRole("option", { name: "같은 사건 3건 · 매체 2곳 — 펼치기" });
    fireEvent.click(toggle);
    expect(screen.getByRole("option", { name: "같은 사건 3건 · 매체 2곳 — 접기" })).toBeTruthy();
    const texts = options();
    const lead = texts.findIndex((text) => text.includes("대표 기사"));
    expect(texts[lead + 1]).toContain("같은 사건 3건");
    expect(texts[lead + 2]).toContain("둘째 보도");
    expect(texts[lead + 3]).toContain("셋째 보도");
    // 대표와 다른 날짜(KST 11-14)의 펼친 줄에는 날짜를 덧붙임.
    expect(texts[lead + 2]).toContain("11-14");
  });

  it("키보드 — ↑↓가 묶음 줄을 지나고 Enter로 펼침, 펼친 줄도 고르면 미리 보기·Enter는 원문", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    renderScreen("/search?e=us:NVDA");
    const list = await screen.findByRole("listbox", { name: "결과" });
    list.focus();
    for (let at = 0; at < 3; at += 1) fireEvent.keyDown(list, { key: "ArrowDown" });
    const toggle = screen.getByRole("option", { name: /같은 사건 3건/ });
    expect(toggle.getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(toggle.id);
    fireEvent.keyDown(list, { key: "Enter" });
    expect(open).not.toHaveBeenCalled();
    expect(screen.getByRole("option", { name: /같은 사건 3건 · 매체 2곳 — 접기/ }).getAttribute("aria-selected")).toBe("true");

    fireEvent.keyDown(list, { key: "ArrowDown" });
    const second = screen.getByRole("option", { name: /둘째 보도/ });
    expect(second.getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("region", { name: "미리 보기" })).getByText("둘째 요약")).toBeTruthy();
    fireEvent.keyDown(list, { key: "Enter" });
    expect(open).toHaveBeenCalledWith("https://beta.example/b", "_blank", "noopener,noreferrer");

    // 묶음 줄에서 다시 Enter면 접히고 펼친 줄은 사라짐.
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(screen.queryByRole("option", { name: /둘째 보도/ })).toBeNull();
  });

  // 개선 제안(QA 스택 재확인 1, 1024·390): ↓로 묶음 줄을 지나면 고른 것이 결과 줄이 아니라 미리 보기가 사라지고(아래 시트가 닫힘) 다음 ↓에서
  // 다시 열렸습니다 — 화면 아래 264px가 깜빡이고 1024에서는 본문 높이가 바뀌어 고른 줄이 약 104px 움직였습니다. 묶음 줄을 고르면 같은 미리 보기
  // 자리에 그 묶음을 보입니다(머리는 묶음 줄과 같은 셈, 대표 줄, 다른 보도, 펼치는 법, 같은 닫기 단추).
  it("묶음 줄을 고르면 미리 보기가 닫히지 않고 그 묶음을 보인다 — 건수·매체 수, 대표 줄, 다른 보도, 펼치는 법", async () => {
    renderScreen("/search?e=us:NVDA");
    const list = await screen.findByRole("listbox", { name: "결과" });
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("region", { name: "미리 보기" })).toBeTruthy();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /같은 사건 3건/ }).getAttribute("aria-selected")).toBe("true");
    const preview = screen.getByRole("region", { name: "미리 보기" });
    expect(within(preview).getByText("같은 사건 3건 · 매체 2곳")).toBeTruthy();
    expect(within(preview).getByText("대표 기사")).toBeTruthy();
    expect(within(preview).getByText("2026-11-13 10:00 KST")).toBeTruthy();
    expect(within(preview).getByText("Alpha · alpha.example")).toBeTruthy();
    const others = within(preview).getByRole("list", { name: "같은 사건의 다른 보도" });
    // 펼치면 놓이는 차례(최근순)와 같게, 매체·시각과 함께.
    expect(within(others).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "둘째 보도Beta · 2026-11-14 07:00 KST",
      "셋째 보도Alpha · 2026-11-13 14:00 KST",
    ]);
    expect(within(preview).getByText(/^펼치기: 결과 목록에서 Enter.*나머지 2건이 대표 줄 아래에 나옵니다/)).toBeTruthy();
    // 속성 칸(xl 오른쪽 칸)으로 돌아가지 않음.
    expect(screen.queryByRole("heading", { name: "속성" })).toBeNull();

    fireEvent.keyDown(list, { key: "Enter" });
    expect(within(screen.getByRole("region", { name: "미리 보기" })).getByText(/^접기: 결과 목록에서 Enter/)).toBeTruthy();

    // 닫기 단추는 결과 줄의 미리 보기와 같음 — 포커스는 결과 목록(QA-430).
    const close = within(screen.getByRole("region", { name: "미리 보기" })).getByRole("button", { name: "미리 보기 닫기" });
    close.focus();
    fireEvent.click(close);
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);

    // 2차 검토 지적: 미리 보기 안의 Escape(결과 목록으로 닫기)는 결과 줄 미리 보기에서만 시험해, 묶음 미리 보기에 그 키 처리가 이어져 있는지
    // 지키는 시험이 없었습니다(끊겨도 모두 통과). 묶음 미리 보기 안의 닫기 단추에서도 Escape로 닫고 포커스는 결과 목록.
    fireEvent.keyDown(list, { key: "Home" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /같은 사건 3건/ }).getAttribute("aria-selected")).toBe("true");
    const clusterPreview = screen.getByRole("region", { name: "미리 보기" });
    expect(within(clusterPreview).getByText("같은 사건 3건 · 매체 2곳")).toBeTruthy();
    const clusterClose = within(clusterPreview).getByRole("button", { name: "미리 보기 닫기" });
    clusterClose.focus();
    fireEvent.keyDown(clusterClose, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(document.activeElement).toBe(list);
  });

  // D1 QA 지적(겉모양 단계 맞춤): 넓은 화면의 미리 보기 닫기 단추가 28px(lg:size-7)로 조작 높이 단계(명세 §3-7 — 기본 30·표 안 24·
  // 검색창 40px) 밖이었습니다. 공용 Dialog·Toast 닫기 단추와 같은 30px, 좁은 화면(lg 미만)은 그대로 44px(QA-458). 결과 줄·묶음 줄의
  // 미리 보기가 같은 틀(PreviewFrame)이라 둘 다 봅니다.
  it("미리 보기 닫기 단추는 좁은 화면 44px(size-11), 넓은 화면 30px(lg:size-[30px]) — 28px(lg:size-7)가 아님", async () => {
    renderScreen("/search?e=us:NVDA");
    const list = await screen.findByRole("listbox", { name: "결과" });
    list.focus();
    const closeClasses = () =>
      within(screen.getByRole("region", { name: "미리 보기" })).getByRole("button", { name: "미리 보기 닫기" }).className.split(/\s+/);
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /같은 사건 3건/ }).getAttribute("aria-selected")).toBe("false");
    const rowClose = closeClasses();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /같은 사건 3건/ }).getAttribute("aria-selected")).toBe("true");
    const clusterClose = closeClasses();
    for (const classes of [rowClose, clusterClose]) {
      expect(classes).toContain("size-11");
      expect(classes).toContain("lg:size-[30px]");
      expect(classes).not.toContain("lg:size-7");
    }
  });

  // D1 QA 검토 지적(같은 겉모양 항목): 머리 줄이 위 맞춤(items-start)이면 넓은 화면에서 '미리 보기'(12/16 글) 가운데와 30px 단추의 X 가운데가
  // 7px 어긋납니다. 머리 글은 늘 한 줄이라 넓은 화면은 가운데 맞춤(lg:items-center) — 좁은 화면(44px 단추)은 그대로.
  it("넓은 화면에서 미리 보기 머리 글은 30px 닫기 단추와 가운데 맞춤(lg:items-center) — 결과 줄·묶음 줄 모두", async () => {
    renderScreen("/search?e=us:NVDA");
    const list = await screen.findByRole("listbox", { name: "결과" });
    list.focus();
    const headClasses = () => {
      const region = screen.getByRole("region", { name: "미리 보기" });
      const head = within(region).getByRole("button", { name: "미리 보기 닫기" }).parentElement!;
      expect(within(head).getByRole("heading", { name: "미리 보기" })).toBeTruthy();
      return head.className.split(/\s+/);
    };
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /같은 사건 3건/ }).getAttribute("aria-selected")).toBe("false");
    const rowHead = headClasses();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /같은 사건 3건/ }).getAttribute("aria-selected")).toBe("true");
    const clusterHead = headClasses();
    for (const classes of [rowHead, clusterHead]) {
      expect(classes).toContain("items-start");
      expect(classes).toContain("lg:items-center");
    }
  });

  it("묶음 미리 보기는 다른 보도를 앞 5건만 이름으로 — 나머지는 건수(접혀 있으면 펼치는 길, 펼쳤으면 목록에 있다고)", async () => {
    const at = (hour: number) => `2026-11-13T${String(hour).padStart(2, "0")}:00:00+00:00`;
    const big = [
      row({ id: "b0", title: "큰 묶음 대표", clusterId: "b0", cluster: { size: 8, publishers: 8 }, publisher: "P0", publishedAt: at(1) }),
      ...Array.from({ length: 7 }, (_, index) =>
        row({ id: `b${index + 1}`, title: `큰 묶음 보도 ${index + 1}`, clusterId: "b0", publisher: `P${index + 1}`, publishedAt: at(index + 2) }),
      ),
    ];
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed({ items: big, rangeCounts: { "7d": 8, "30d": 8, "1y": 8, "2y": 8 } });
    renderScreen("/search?e=us:NVDA");
    const list = await screen.findByRole("listbox", { name: "결과" });
    list.focus();
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /같은 사건 8건 · 매체 8곳/ }).getAttribute("aria-selected")).toBe("true");
    const preview = screen.getByRole("region", { name: "미리 보기" });
    expect(within(preview).getByText("같은 사건의 다른 보도 7건")).toBeTruthy();
    const names = within(within(preview).getByRole("list", { name: "같은 사건의 다른 보도" })).getAllByRole("listitem");
    expect(names.map((item) => item.firstElementChild?.textContent)).toEqual([7, 6, 5, 4, 3].map((at) => `큰 묶음 보도 ${at}`));
    expect(within(preview).getByText("그 밖에 2건 — 펼치면 목록에 모두 나옵니다.")).toBeTruthy();

    // 검토 지적(묶음 미리 보기의 글): 펼친 뒤에도 '펼치면 목록에 모두 나옵니다'가 그대로라 바로 아래의 '접기' 안내와 어긋났습니다.
    // 수정 전 실패: Enter로 펼친 뒤에도 같은 글.
    fireEvent.keyDown(list, { key: "Enter" });
    const expanded = screen.getByRole("region", { name: "미리 보기" });
    expect(within(expanded).getByText("그 밖에 2건 — 목록에 모두 나와 있습니다.")).toBeTruthy();
    expect(within(expanded).queryByText(/펼치면 목록에/)).toBeNull();
    expect(within(expanded).getByText(/^접기: 결과 목록에서 Enter/)).toBeTruthy();
  });

  // 검토 지적(항목 1 — 누르기): 묶음 미리 보기를 더하면서 묶음 줄을 누르기만 해도 아래 시트(390에서 376~422px)가 열려, 누른 줄을 시트 위로
  // 옮기고 바로 밑에 펼친 줄을 시트·TOP 단추 띠 밑에 덮었습니다. 누르기는 펼치기만(전과 같이), 묶음 미리 보기는 ↑↓·Home·End로 고를 때만.
  // 수정 전 실패: 묶음 줄을 누르면 미리 보기(묶음)가 열림.
  it("묶음 줄을 누르면 펼치기만 하고 미리 보기는 열지 않는다 — 열려 있던 미리 보기는 닫히고, ↑↓로 다시 고르면 묶음 미리 보기", async () => {
    renderScreen("/search?e=us:NVDA");
    const list = await screen.findByRole("listbox", { name: "결과" });
    fireEvent.click(screen.getByRole("option", { name: /대표 기사/ }));
    expect(screen.getByRole("region", { name: "미리 보기" })).toBeTruthy();

    fireEvent.click(screen.getByRole("option", { name: "같은 사건 3건 · 매체 2곳 — 펼치기" }));
    const toggle = screen.getByRole("option", { name: "같은 사건 3건 · 매체 2곳 — 접기" });
    expect(toggle.getAttribute("aria-selected")).toBe("true");
    expect(list.getAttribute("aria-activedescendant")).toBe(toggle.id);
    expect(document.activeElement).toBe(list);
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    expect(screen.getByRole("heading", { name: "속성" })).toBeTruthy();
    // 다시 누르면 접힘 — 여전히 미리 보기 없음.
    fireEvent.click(toggle);
    expect(screen.getByRole("option", { name: "같은 사건 3건 · 매체 2곳 — 펼치기" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();
    // Enter도 펼치기만(누르기로 고른 줄).
    fireEvent.keyDown(list, { key: "Enter" });
    expect(screen.getByRole("option", { name: /같은 사건 3건 · 매체 2곳 — 접기/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "미리 보기" })).toBeNull();

    // ↑↓는 그 줄에서 이어 가고, 키보드로 묶음 줄에 돌아오면 묶음 미리 보기.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /둘째 보도/ }).getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("region", { name: "미리 보기" })).getByText("둘째 요약")).toBeTruthy();
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(within(screen.getByRole("region", { name: "미리 보기" })).getByText("같은 사건 3건 · 매체 2곳")).toBeTruthy();
  });

  it("'묶어 보기'를 끄면 모든 줄을 지금처럼(묶음 줄 없음)", async () => {
    renderScreen("/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    const toggle = screen.getByRole("switch", { name: /묶어 보기/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.textContent).toContain("켬");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.textContent).toContain("끔");
    const texts = options();
    expect(texts.some((text) => text.includes("둘째 보도"))).toBe(true);
    expect(texts.some((text) => text.includes("같은 사건"))).toBe(false);
    expect(texts).toHaveLength(6);
  });

  it("묶는 기준 안내는 실제 기준(자카드 — 겹친 낱말 / 두 제목의 낱말을 합친 것 ≥ 0.5)대로", async () => {
    renderScreen("/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    const note = screen.getByText(/같은 사건 묶음 1개/);
    expect(note.textContent).toContain("두 제목의 낱말을 합친 것 가운데 절반 이상이 겹치고(자카드 0.5 이상)");
    expect(note.textContent).toContain("48시간 안");
    expect(note.textContent).not.toContain("제목 낱말이 절반 이상 겹치고");
  });

  it("묶음이 없는 결과(단계 5까지의 응답)에는 '묶어 보기' 전환이 없다", async () => {
    const withoutClusters = ROWS.map((item) => {
      const copy: Partial<SearchFeedItem> = { ...item };
      delete copy.clusterId;
      delete copy.cluster;
      return copy;
    });
    reads[endpoints.search.feed("us:NVDA", "timeline")] = feed({ items: withoutClusters });
    renderScreen("/search?e=us:NVDA");
    await screen.findByRole("listbox", { name: "결과" });
    expect(screen.queryByRole("switch", { name: /묶어 보기/ })).toBeNull();
    expect(options()).toHaveLength(6);
  });

  it("관심 대상 목록 — 화제인 대상에 '화제' 글 배지(색만이 아님)와 접힌 안내 속 화제 뜻, 아니거나 모르면 배지 없음", async () => {
    reads[endpoints.search.watch] = {
      available: true,
      items: [
        { id: 7, key: "us:NVDA", kind: "company", name: "엔비디아", createdAt: null, lastSeenAt: null, newCount: 12, hot: true },
        { id: 8, key: "cik:0001067983", kind: "institution", name: "버크셔 해서웨이", createdAt: null, lastSeenAt: null, newCount: 1, hot: false },
        { id: 9, key: "topic:합성 주제", kind: "topic", name: "합성 주제", createdAt: null, lastSeenAt: null, newCount: null },
      ],
      limits: { mine: 3, max: 10, serverUsed: 3, serverMax: 100 },
      collecting: true,
    };
    reads[endpoints.search.recent] = { available: true, items: [], fetchedAt: null };
    renderScreen("/search");
    const list = await screen.findByRole("list", { name: "관심 대상 목록" });
    const hot = within(list).getByRole("button", { name: /엔비디아/ });
    expect(within(hot).getByText("화제")).toBeTruthy();
    expect(within(list).getByRole("button", { name: /버크셔 해서웨이/ }).textContent).not.toContain("화제");
    expect(within(list).getByRole("button", { name: /합성 주제/ }).textContent).not.toContain("화제");
    // 뜻은 목록 아래에 늘 펼치지 않고 기본으로 접힌 안내(details)에 둡니다(QA-419). jsdom의 getByText는 닫힌 details 안의 글도 찾으므로 자리를 함께 대조합니다.
    const definition = screen.getByText(/화제 = 지난 24시간에 처음 받은 글이 5건 이상/);
    expect(definition.closest("details")).not.toBeNull();
    expect(definition.closest("details")!.hasAttribute("open")).toBe(false);
  });

  it("화제인 대상이 없으면 접힌 안내에도 화제 뜻이 없다", async () => {
    reads[endpoints.search.watch] = {
      available: true,
      items: [{ id: 8, key: "cik:0001067983", kind: "institution", name: "버크셔 해서웨이", createdAt: null, lastSeenAt: null, newCount: 1, hot: false }],
      limits: null,
      collecting: true,
    };
    reads[endpoints.search.recent] = { available: true, items: [], fetchedAt: null };
    renderScreen("/search");
    await screen.findByRole("list", { name: "관심 대상 목록" });
    expect(screen.queryByText(/화제 = /)).toBeNull();
  });
});

describe("연결 그림(계약 §9-3)", () => {
  const insider = (at: number): SearchLink => ({ relation: "insider", key: null, name: `Example Insider ${at}`, kind: "person", source: "yahoo", detail: null });

  it("'목록 | 그림' 전환 — 기본은 목록, 그림은 노드마다 이름·관계, 누르면 그 대상으로", async () => {
    reads[endpoints.search.links("us:NVDA")] = { available: true, entityKey: "us:NVDA", links: [], sources: [], fetchedAt: null };
    renderScreen("/search?e=us:NVDA&tab=links");
    const listButton = await screen.findByRole("button", { name: "목록" });
    expect(listButton.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Mellanox/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "그림" }));
    expect(screen.getByRole("button", { name: "그림" }).getAttribute("aria-pressed")).toBe("true");

    const graph = screen.getByRole("group", { name: /엔비디아의 연결 그림/ });
    expect(graph.tagName.toLowerCase()).toBe("svg");
    expect(graph.getAttribute("width")).toBe("100%");
    // 뷰박스 폭은 잰 칸 폭(재지 못하면 360), 세로는 그린 범위만(노드가 둘이면 낮은 그림).
    expect(graph.getAttribute("viewBox")).toMatch(/^0 \d+ 360 \d+$/);
    const nodes = within(graph).getAllByRole("button");
    expect(nodes.map((node) => node.getAttribute("aria-label"))).toEqual(["Jensen Huang · 창업자 · 이름으로 찾기", "Mellanox · 자회사"]);
    expect(nodes.every((node) => node.getAttribute("tabindex") === "0")).toBe(true);
    // 마우스로 가리키면 이름·관계(줄인 이름의 전체와 관계 — 낭독 이름과 같은 글).
    expect(nodes.map((node) => node.querySelector("title")?.textContent)).toEqual(nodes.map((node) => node.getAttribute("aria-label")));
    // 관계 글(한국어)이 그림 안에.
    expect(within(graph).getByText("창업자")).toBeTruthy();
    expect(within(graph).getByText("자회사")).toBeTruthy();
    expect(screen.getByText("받은 자료 기준 — 출처에 없는 관계는 그리지 않음")).toBeTruthy();

    fireEvent.click(within(graph).getByRole("button", { name: "Mellanox · 자회사" }));
    await waitFor(() => expect(window.location.search).toBe("?e=wd:Q100&tab=timeline&range=30d"));
  });

  it("Enter로 노드를 열고 — 키 없는 노드는 그 이름으로 찾음", async () => {
    reads[endpoints.search.links("us:NVDA")] = { available: true, entityKey: "us:NVDA", links: [], sources: [], fetchedAt: null };
    renderScreen("/search?e=us:NVDA&tab=links");
    fireEvent.click(await screen.findByRole("button", { name: "그림" }));
    const node = screen.getByRole("button", { name: "Jensen Huang · 창업자 · 이름으로 찾기" });
    node.focus();
    expect(document.activeElement).toBe(node);
    fireEvent.keyDown(node, { key: "Enter" });
    expect(window.location.search).toBe(`?q=${encodeURIComponent("Jensen Huang")}`);
  });

  it("30개를 넘으면 30개만 그리고 '목록에서 n개 더' — 누르면 목록으로", async () => {
    reads[endpoints.search.links("us:NVDA")] = {
      available: true, entityKey: "us:NVDA", links: Array.from({ length: 35 }, (_, at) => insider(at)), sources: [], fetchedAt: null,
    };
    renderScreen("/search?e=us:NVDA&tab=links");
    await screen.findByText("Example Insider 34");
    fireEvent.click(screen.getByRole("button", { name: "그림" }));
    const graph = screen.getByRole("group", { name: /연결 그림/ });
    expect(within(graph).getAllByRole("button")).toHaveLength(30);
    // 관계마다 돌아가며 골라 창업자·자회사도 그려짐.
    expect(within(graph).getByRole("button", { name: "Mellanox · 자회사" })).toBeTruthy();
    const more = screen.getByRole("button", { name: "목록에서 7개 더" });
    more.focus();
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "목록" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("group", { name: /연결 그림/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Example Insider 34/ })).toBeTruthy();
    // 누른 단추가 그림과 함께 사라지므로 포커스를 '목록' 전환 단추로 옮김(문서 맨 앞으로 떨어지지 않게).
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "목록" }));
  });

  it("연결이 없으면 전환을 두지 않는다", async () => {
    reads[endpoints.search.entity("us:NVDA")] = { available: true, entity: { ...NVIDIA, links: [] }, errors: {} };
    reads[endpoints.search.links("us:NVDA")] = { available: true, entityKey: "us:NVDA", links: [], sources: [], fetchedAt: null };
    renderScreen("/search?e=us:NVDA&tab=links");
    await screen.findByText(/가진 연결이 없습니다/);
    expect(screen.queryByRole("button", { name: "그림" })).toBeNull();
  });
});
