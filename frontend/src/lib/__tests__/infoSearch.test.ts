/**
 * 정보 검색(/search — ADR 0041) 화면의 순수 규칙 — 주소 상태, 대상 키 모양, 후보 자동 열기, 기간 자르기(rangeCounts), KST 날짜 묶음,
 * 빈 화면 안내, 출처 상태 글, 거르기, 키보드. 표본은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANGE,
  DEFAULT_TAB,
  FEED_PENDING_REFRESH_MS,
  applyFilters,
  autoPick,
  isTopicSearch,
  candidateTarget,
  countByRange,
  cutByRange,
  droppedText,
  entityShortcuts,
  facetCounts,
  feedEmptyState,
  feedRefreshMs,
  feedTabOf,
  groupByKstDate,
  holdersQuery,
  holdingsWindow,
  httpUrl,
  identifierChips,
  isDateOnly,
  isEntityKey,
  isListedEntity,
  itemTimeText,
  linkSourceLabel,
  linksView,
  mergeLinks,
  relationLabel,
  rowTimeText,
  isSlashShortcut,
  kindOfKey,
  kstDate,
  kstTime,
  kstToday,
  linkGroups,
  linkTarget,
  nextRowIndex,
  parseSearchUrl,
  rangeCountsOf,
  rangeStart,
  readerOfFeedItem,
  searchHref,
  sourceLabel,
  sourceStatusView,
  tabFor,
  tabsFor,
  topicKey,
  excludeDraft,
  excludeKindLabel,
  excludeSeedGroups,
  findWatch,
  newCountText,
  refreshNoteText,
  watchCollectingNote,
  watchKeyOf,
  watchLimitsText,
  watchNewTotal,
  writeErrorText,
} from "../infoSearch";
import type {
  SearchCandidate,
  SearchEntity,
  SearchFeedItem,
  SearchFeedResponse,
  SearchLink,
  SearchLinksResponse,
  SearchSourceStatus,
  SearchWatchItem,
} from "../types";

function item(over: Partial<SearchFeedItem> = {}): SearchFeedItem {
  return {
    id: "a", kind: "news", title: "제목", url: "https://example.com/a", publisher: "Example", publisherDomain: "example.com",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null, ...over,
  };
}

function entity(over: Partial<SearchEntity> = {}): SearchEntity {
  return {
    key: "us:NVDA", kind: "company", name: "엔비디아", nameKo: "엔비디아", nameEn: "NVIDIA Corp", aliases: ["NVIDIA", "엔비디아"],
    description: null,
    ids: { ticker: "NVDA", market: "us", stockCode: null, cik: "0001045810", dartCorpCode: null, wikidata: "Q182477" },
    links: [], sources: ["sec"], ...over,
  };
}

const cand = (over: Partial<SearchCandidate>): SearchCandidate => ({ key: null, kind: "company", name: "", sub: null, source: "sec", ...over });

describe("대상 키 모양(계약 §2)", () => {
  it.each([
    "us:NVDA", "us:BRK.B", "us:BRK-B", "kr:005930", "cik:0001067983", "wd:Q3195170", "topic:AI 반도체", `topic:${"가".repeat(60)}`,
  ])("%s — 맞음", (key) => expect(isEntityKey(key)).toBe(true));

  it.each([
    null, "", "us:", "us:nvda", "us:NV DA", "kr:5930", "kr:00593A", "cik:1067983", "wd:182477", "wd:q1", "topic:", "topic:   ",
    ` topic:x`, `topic:${"가".repeat(61)}`, "foo:bar", "NVDA",
    // 수집기 문법과 같게 — 티커 15자까지, QID는 0으로 시작하지 않음, 제어 글자 없음
    `us:${"A".repeat(16)}`, "wd:Q0123", "topic:AI\u0007반도체",
  ])("%s — 틀림(주소로 넘어가지 않음)", (key) => expect(isEntityKey(key)).toBe(false));

  it("주제 키는 앞뒤 공백을 떼고 1~60자만 — 넘거나 비면 null", () => {
    expect(topicKey("  AI   반도체 ")).toBe("topic:AI 반도체");
    expect(topicKey("   ")).toBeNull();
    expect(topicKey("가".repeat(61))).toBeNull();
  });

  it("키 앞부분으로 종류를 짐작한다 — wd:는 모름", () => {
    expect(kindOfKey("us:NVDA")).toBe("company");
    expect(kindOfKey("kr:005930")).toBe("company");
    expect(kindOfKey("cik:0001067983")).toBe("institution");
    expect(kindOfKey("topic:x")).toBe("topic");
    expect(kindOfKey("wd:Q1")).toBeNull();
  });
});

describe("주소 상태", () => {
  it("대상 키가 있으면 대상·탭·기간, 없거나 틀린 값은 기본(타임라인·30일)", () => {
    expect(parseSearchUrl("?e=us:NVDA&tab=news&range=1y")).toEqual({ q: null, e: "us:NVDA", tab: "news", range: "1y", badKey: false });
    expect(parseSearchUrl(new URLSearchParams("e=us%3ANVDA&tab=bogus&range=9y"))).toEqual({
      q: null, e: "us:NVDA", tab: DEFAULT_TAB, range: DEFAULT_RANGE, badKey: false,
    });
    expect(parseSearchUrl("?e=us:nvda")).toMatchObject({ e: null, badKey: true });
    expect(parseSearchUrl("?q=%20Ken%20Griffin%20")).toMatchObject({ q: "Ken Griffin", e: null });
    expect(parseSearchUrl("")).toEqual({ q: null, e: null, tab: "timeline", range: "30d", badKey: false });
  });

  it("검색어는 60자까지만", () => {
    expect(parseSearchUrl(`?q=${"a".repeat(80)}`).q).toHaveLength(60);
  });

  it("주소 만들기 — 대상이면 탭·기간을 함께(':'는 읽기 좋게 그대로), 아니면 검색어, 둘 다 없으면 /search", () => {
    expect(searchHref({ e: "us:NVDA", tab: "news", range: "1y" })).toBe("/search?e=us:NVDA&tab=news&range=1y");
    expect(searchHref({ e: "topic:AI & 반도체" })).toBe(`/search?e=topic:AI%20%26%20${encodeURIComponent("반도체")}&tab=timeline&range=30d`);
    expect(searchHref({ q: "삼성전자" })).toBe(`/search?q=${encodeURIComponent("삼성전자")}`);
    expect(searchHref({ e: "bad key", q: "x" })).toBe("/search?q=x");
    expect(searchHref({})).toBe("/search");
    // 만든 주소를 다시 읽으면 같은 상태
    expect(parseSearchUrl(searchHref({ e: "topic:AI & 반도체", tab: "links", range: "7d" }).slice("/search".length))).toMatchObject({
      e: "topic:AI & 반도체", tab: "links", range: "7d",
    });
  });
});

describe("탭", () => {
  it("글·논평은 운영자만, 보유는 기업·기관만, 공시는 주제 밖 모두, 리서치는 상장 기업만, 연결·타임라인·뉴스는 모두(계약 §7-3·7-7)", () => {
    expect(tabsFor("company", false, true)).toEqual(["timeline", "news", "filings", "research", "holdings", "links"]);
    expect(tabsFor("company", true, true)).toEqual(["timeline", "news", "filings", "research", "posts", "holdings", "links"]);
    expect(tabsFor("institution", false, false)).toEqual(["timeline", "news", "filings", "holdings", "links"]);
    expect(tabsFor("person", true, false)).toEqual(["timeline", "news", "filings", "posts", "links"]);
    expect(tabsFor("topic", false, false)).toEqual(["timeline", "news", "links"]);
    expect(tabsFor("topic", true, false)).toEqual(["timeline", "news", "posts", "links"]);
  });

  it("상장되지 않은 기업(시장 없는 wd: 기업)은 리서치 탭이 없다 — 수집기가 묻지 않는 탭을 '모름'으로 열지 않음(계약 §7-3)", () => {
    expect(tabsFor("company", false, false)).toEqual(["timeline", "news", "filings", "holdings", "links"]);
    expect(tabFor("research", "company", true, false)).toBe("timeline");
  });

  it("상장 여부 — 풀린 대상의 시장(미국·한국), 풀기 전·풀지 못했으면 키 앞부분(us:·kr:)", () => {
    expect(isListedEntity("us:NVDA", null)).toBe(true);
    expect(isListedEntity("kr:005930", null)).toBe(true);
    expect(isListedEntity("wd:Q95", null)).toBe(false);
    expect(isListedEntity("cik:0001067983", null)).toBe(false);
    expect(isListedEntity("topic:AI", null)).toBe(false);
    // wd:로 열었어도 풀린 대상이 상장 종목이면(대표 키 us:·kr:, 시장 있음) 상장
    expect(isListedEntity("wd:Q182477", entity())).toBe(true);
    expect(isListedEntity("wd:Q20", entity({ key: "kr:005930", ids: { ...entity().ids, market: "kr", stockCode: "005930" } }))).toBe(true);
    // 시장이 없는 wd: 기업은 상장 아님
    expect(isListedEntity("wd:Q95", entity({ key: "wd:Q95", ids: { ...entity().ids, ticker: null, market: null, cik: null } }))).toBe(false);
  });

  it("고를 수 없는 탭을 주소로 주면 타임라인 — 회원의 글·논평(403을 부르지 않음), 사람의 보유, 주제의 공시, 기관·사람의 리서치", () => {
    expect(tabFor("posts", "company", false, true)).toBe("timeline");
    expect(tabFor("posts", "company", true, true)).toBe("posts");
    expect(tabFor("holdings", "person", true, false)).toBe("timeline");
    expect(tabFor("filings", "topic", true, false)).toBe("timeline");
    expect(tabFor("research", "topic", true, false)).toBe("timeline");
    expect(tabFor("research", "institution", true, false)).toBe("timeline");
    expect(tabFor("research", "person", true, false)).toBe("timeline");
    expect(tabFor("filings", "person", false, false)).toBe("filings");
    expect(tabFor("research", "company", false, true)).toBe("research");
  });

  it("결과 경로를 부르는 탭만 feed 탭 이름이 있다 — 공시·리서치도 결과 경로", () => {
    expect(feedTabOf("timeline")).toBe("timeline");
    expect(feedTabOf("posts")).toBe("posts");
    expect(feedTabOf("filings")).toBe("filings");
    expect(feedTabOf("research")).toBe("research");
    expect(feedTabOf("holdings")).toBeNull();
    expect(feedTabOf("links")).toBeNull();
  });

  it("주소의 공시·리서치 탭을 읽고 다시 쓴다", () => {
    expect(parseSearchUrl("?e=us:NVDA&tab=filings").tab).toBe("filings");
    expect(parseSearchUrl("?e=us:NVDA&tab=research&range=1y")).toMatchObject({ tab: "research", range: "1y" });
    expect(searchHref({ e: "kr:005930", tab: "filings", range: "2y" })).toBe("/search?e=kr:005930&tab=filings&range=2y");
  });
});

describe("후보 고르기(자동으로 고르지 않음)", () => {
  const nvidia = cand({ key: "us:NVDA", name: "NVIDIA", sub: "NVDA · 미국" });
  const topic = cand({ key: "topic:NVIDIA", kind: "topic", name: "NVIDIA", source: "topic" });

  it("주제를 뺀 후보가 하나이고 이름이 입력과 같을 때만(대소문자·공백 무시) 바로 연다", () => {
    expect(autoPick([nvidia, topic], " nvidia ")).toBe(nvidia);
    expect(autoPick([nvidia, topic], "NVDA")).toBeNull();
    expect(autoPick([nvidia, cand({ key: "wd:Q182477", name: "NVIDIA", source: "wikidata" }), topic], "NVIDIA")).toBeNull();
    expect(autoPick([topic], "NVIDIA")).toBeNull();
    // 사람·조직이 아닌 Wikidata 항목(종류 topic, 키 wd:)은 주제 검색이 아니라 대상 — 같은 이름이면 목록을 보임(자동으로 고르지 않음)
    const wdTopic = cand({ key: "wd:Q11660", kind: "topic", name: "NVIDIA", source: "wikidata" });
    expect(autoPick([nvidia, wdTopic, topic], "NVIDIA")).toBeNull();
    expect(autoPick([wdTopic, topic], "NVIDIA")).toBe(wdTopic);
  });

  it("주제 검색 줄은 출처 topic(키 topic:)뿐 — 종류가 topic인 Wikidata 항목은 아님", () => {
    expect(isTopicSearch(topic)).toBe(true);
    expect(isTopicSearch(cand({ key: "wd:Q11660", kind: "topic", name: "인공지능", source: "wikidata" }))).toBe(false);
    expect(isTopicSearch(nvidia)).toBe(false);
  });

  it("키가 없는 후보는 바로 열지 않는다", () => {
    expect(autoPick([cand({ key: null, name: "Ken Griffin", kind: "person" }), topic], "Ken Griffin")).toBeNull();
  });

  it("고른 후보 — 키가 있으면 그 대상, 없으면 그 이름으로 다시 풀고, 이미 그 이름으로 푼 목록이면 주제로", () => {
    expect(candidateTarget(nvidia, null)).toEqual({ open: "us:NVDA" });
    expect(candidateTarget(cand({ key: null, name: "Ken Griffin" }), null)).toEqual({ resolve: "Ken Griffin" });
    expect(candidateTarget(cand({ key: null, name: "Ken Griffin" }), "Ken Griffin")).toEqual({ open: "topic:Ken Griffin" });
    expect(candidateTarget(cand({ key: "us:bad key", name: "X" }), null)).toEqual({ resolve: "X" });
  });

  it("연결 — 키가 있으면 그 대상, 없으면 그 이름으로 풂", () => {
    expect(linkTarget({ relation: "owner_of", key: "wd:Q1", name: "A", kind: "company", source: "wikidata" })).toEqual({ open: "wd:Q1" });
    expect(linkTarget({ relation: "manager", key: null, name: "Stanley Druckenmiller", kind: "person", source: "13f" })).toEqual({
      resolve: "Stanley Druckenmiller",
    });
  });
});

describe("KST 시각", () => {
  it("UTC ISO를 KST 날짜·시각으로(+9시간, 날짜가 넘어감)", () => {
    expect(kstDate("2026-11-13T15:30:00+00:00")).toBe("2026-11-14");
    expect(kstTime("2026-11-13T15:30:00+00:00")).toBe("00:30");
    expect(kstDate(null)).toBeNull();
    expect(kstTime("not a time")).toBeNull();
  });

  it("오늘(KST)", () => {
    expect(kstToday(Date.parse("2026-11-13T15:00:00Z"))).toBe("2026-11-14");
    expect(kstToday(Date.parse("2026-11-13T14:59:59Z"))).toBe("2026-11-13");
  });

  it("기간 시작 날짜 — 오늘 − 기간(2년은 계약 §4-1과 같은 정의)", () => {
    expect(rangeStart("7d", "2026-11-14")).toBe("2026-11-07");
    expect(rangeStart("30d", "2026-11-14")).toBe("2026-10-15");
    expect(rangeStart("1y", "2026-11-14")).toBe("2025-11-14");
    expect(rangeStart("2y", "2026-11-14")).toBe("2024-11-14");
    expect(rangeStart("1y", "2028-02-29")).toBe("2027-02-28");
  });
});

describe("기간 자르기", () => {
  const items = [
    item({ id: "1", publishedAt: "2026-11-13T23:00:00+00:00" }), // KST 11-14
    item({ id: "2", publishedAt: "2026-11-10T01:00:00+00:00" }), // 11-10
    item({ id: "3", publishedAt: "2026-10-01T01:00:00+00:00" }), // 10-01
    item({ id: "4", publishedAt: "2025-06-01T01:00:00+00:00" }), // 2025-06-01
  ];
  const feed = (over: Partial<SearchFeedResponse> = {}): SearchFeedResponse => ({
    available: true, items, window: { from: "2024-11-14", to: "2026-11-14" }, rangeCounts: { "7d": 2, "30d": 2, "1y": 3, "2y": 4 }, ...over,
  });

  it("rangeCounts가 있으면 최근부터 그 수만큼 — 서버가 센 수와 보이는 줄이 같다", () => {
    expect(cutByRange(feed(), "7d").map((row) => row.id)).toEqual(["1", "2"]);
    expect(cutByRange(feed(), "1y").map((row) => row.id)).toEqual(["1", "2", "3"]);
    expect(cutByRange(feed(), "2y").map((row) => row.id)).toEqual(["1", "2", "3", "4"]);
  });

  it("rangeCounts가 없으면 창 끝 날짜(window.to)에서 작성 시각(KST)으로 자른다", () => {
    const bare = feed({ rangeCounts: null });
    expect(cutByRange(bare, "7d").map((row) => row.id)).toEqual(["1", "2"]);
    expect(cutByRange(bare, "30d").map((row) => row.id)).toEqual(["1", "2"]);
    expect(cutByRange(bare, "1y").map((row) => row.id)).toEqual(["1", "2", "3"]);
    expect(countByRange(items, "2026-11-14")).toEqual({ "7d": 2, "30d": 2, "1y": 3, "2y": 4 });
  });

  it("보이는 건수는 서버의 rangeCounts(받은 자료 기준), 없으면 직접 센 값", () => {
    expect(rangeCountsOf(feed({ rangeCounts: { "7d": 9, "30d": 9, "1y": 9, "2y": 9 } }))).toEqual({ "7d": 9, "30d": 9, "1y": 9, "2y": 9 });
    expect(rangeCountsOf(feed({ rangeCounts: null }))).toEqual({ "7d": 2, "30d": 2, "1y": 3, "2y": 4 });
  });

  it("순서가 섞여 와도 최근부터 — 시각 없는 줄은 맨 뒤", () => {
    const mixed = feed({ items: [items[2], item({ id: "x", publishedAt: null }), items[0], items[1]], rangeCounts: { "7d": 2, "30d": 2, "1y": 3, "2y": 3 } });
    expect(cutByRange(mixed, "2y").map((row) => row.id)).toEqual(["1", "2", "3"]);
  });
});

describe("날짜 묶음(KST)", () => {
  it("KST 날짜로 묶고 요일을 붙인다 — UTC로는 전날인 줄도 KST 날짜로", () => {
    const groups = groupByKstDate([
      item({ id: "1", publishedAt: "2026-11-13T23:00:00+00:00" }),
      item({ id: "2", publishedAt: "2026-11-13T15:10:00+00:00" }),
      item({ id: "3", publishedAt: "2026-11-13T14:50:00+00:00" }),
    ]);
    expect(groups.map((group) => [group.date, group.label, group.items.map((row) => row.id)])).toEqual([
      ["2026-11-14", "2026-11-14 (토)", ["1", "2"]],
      ["2026-11-13", "2026-11-13 (금)", ["3"]],
    ]);
  });
});

describe("빈 화면 안내(계약 §5)", () => {
  const counts = { "7d": 0, "30d": 0, "1y": 3, "2y": 5 };
  const none = { "7d": 0, "30d": 0, "1y": 0, "2y": 0 };
  const src = (source: string, status: string, label = source): SearchSourceStatus => ({
    source, label, status, count: 0, dropped: null, message: null,
  });

  it("2년 안에 하나도 없으면 그 안내 — 2년보다 오래된 것만 있었으면 가장 최근 날짜를 함께", () => {
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: "2023-05-02" }))
      .toEqual({ kind: "none2y", message: "최근 2년 안의 자료가 없습니다", note: "가장 최근 자료: 2023-05-02", caveat: null, wider: [] });
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: null }))
      .toEqual({ kind: "none2y", message: "최근 2년 안의 자료가 없습니다", note: null, caveat: null, wider: [] });
  });

  it("고른 기간에 없으면 그 안내와 더 넓은 기간 단추(건수가 있는 것만, 건수와 함께)", () => {
    expect(feedEmptyState({ total: 5, inRange: 0, shown: 0, counts, range: "7d", olderOnlyLatest: null })).toEqual({
      kind: "range", message: "이 기간에는 자료가 없습니다", note: null, caveat: null,
      wider: [{ range: "1y", label: "1년", count: 3 }, { range: "2y", label: "2년", count: 5 }],
    });
  });

  it("거르기 때문에 비었으면 그렇다고 — 기간 안내와 섞지 않음", () => {
    expect(feedEmptyState({ total: 5, inRange: 5, shown: 0, counts, range: "2y", olderOnlyLatest: null })).toMatchObject({
      kind: "filtered", wider: [], caveat: null,
    });
  });

  it("보일 줄이 있으면 안내 없음", () => {
    expect(feedEmptyState({ total: 5, inRange: 2, shown: 2, counts, range: "2y", olderOnlyLatest: null })).toBeNull();
  });

  it("출처가 모두 실패하면 '없다'고 하지 않고 모른다고 — 사유는 출처 상태 줄로", () => {
    const sources = [src("google_en", "error", "구글 뉴스(영어)"), src("bing", "error", "Bing 뉴스"), src("wire", "owner_only")];
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: null, sources })).toEqual({
      kind: "unknown",
      message: "받은 출처가 없어 최근 2년 안의 자료가 있는지 모릅니다",
      note: null,
      caveat: "받지 못한 출처가 있습니다(구글 뉴스(영어) · Bing 뉴스) — 아래 출처 상태를 보세요.",
      wider: [],
    });
  });

  it("대상을 풀지 못해 출처를 하나도 부르지 않았으면(모두 건너뜀) 모른다고", () => {
    const sources = [src("google_ko", "skipped"), src("google_en", "skipped"), src("bing", "skipped"), src("event_news", "skipped"), src("wire", "owner_only")];
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: null, sources })).toMatchObject({
      kind: "unknown",
      message: "받은 출처가 없어 최근 2년 안의 자료가 있는지 모릅니다",
      caveat: "부른 출처가 없습니다 — 아래 출처 상태에서 사유를 보세요.",
    });
  });

  it("외부 조회를 하지 않았으면(데모·저장본만) 저장본만 찾았다고 덧붙인다", () => {
    const sources = [src("google_ko", "offline"), src("google_en", "offline"), src("bing", "offline"), src("event_news", "empty")];
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: null, sources })).toEqual({
      kind: "none2y",
      message: "최근 2년 안의 자료가 없습니다",
      note: null,
      caveat: "외부 출처는 부르지 않았습니다(저장본만 찾음) — 아래 출처 상태를 보세요.",
      wider: [],
    });
    const allOffline = [src("google_en", "offline"), src("bing", "offline")];
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: null, sources: allOffline }))
      .toMatchObject({ kind: "unknown", caveat: "외부 출처는 부르지 않았습니다(저장본만 찾음) — 아래 출처 상태를 보세요." });
  });

  it("일부 출처만 실패하면 안내 글은 그대로, 받지 못한 출처를 덧붙인다(기간 안내도 같음)", () => {
    const sources = [src("google_en", "ok", "구글 뉴스(영어)"), src("bing", "error", "Bing 뉴스"), src("google_ko", "skipped")];
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: null, sources })).toMatchObject({
      kind: "none2y", message: "최근 2년 안의 자료가 없습니다", caveat: "받지 못한 출처가 있습니다(Bing 뉴스) — 아래 출처 상태를 보세요.",
    });
    expect(feedEmptyState({ total: 5, inRange: 0, shown: 0, counts, range: "7d", olderOnlyLatest: null, sources })).toMatchObject({
      kind: "range", caveat: "받지 못한 출처가 있습니다(Bing 뉴스) — 아래 출처 상태를 보세요.",
    });
  });

  it("받는 중인 출처만 남았으면 그렇다고", () => {
    const sources = [src("google_en", "empty"), src("finviz", "pending", "Finviz")];
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: null, sources })).toMatchObject({
      kind: "none2y", caveat: "받는 중인 출처가 있습니다(Finviz) — 몇 초 뒤 다시 읽습니다.",
    });
  });

  it("출처 상태가 없으면(옛 응답) 지금처럼 2년 안내", () => {
    expect(feedEmptyState({ total: 0, inRange: 0, shown: 0, counts: none, range: "30d", olderOnlyLatest: null, sources: [] }))
      .toMatchObject({ kind: "none2y", caveat: null });
  });
});

describe("출처 상태 줄", () => {
  it("상태 글·톤·건수·뺀 건수 — 색만으로 가르지 않게 글이 있다", () => {
    expect(sourceStatusView({ source: "bing", label: "Bing 뉴스", status: "error", count: 0, dropped: null, message: "HTTP 503" })).toEqual({
      label: "Bing 뉴스", status: "실패", tone: "danger", count: "0건", dropped: null, message: "HTTP 503",
    });
    expect(sourceStatusView({ source: "google_en", label: "구글 뉴스(영어)", status: "ok", count: 12,
      dropped: { old: 3, noTime: 2, chinese: 1, excluded: 0 }, message: null })).toMatchObject({
      status: "받음", tone: "ok", count: "12건", dropped: "뺀 줄: 2년 밖 3건 · 시각을 알 수 없음 2건 · 중국어 제목 1건",
    });
    expect(sourceStatusView({ source: "info", label: "수집 글", status: "owner_only", count: null, dropped: null, message: null })).toMatchObject({
      status: "운영자 전용", tone: "neutral", count: "—",
    });
    expect(sourceStatusView({ source: "x", label: "X", status: "brand_new", count: 1, dropped: null, message: null }).status).toBe("brand_new");
  });

  it("뺀 건수가 모두 0이거나 없으면 null", () => {
    expect(droppedText({ old: 0, noTime: 0, chinese: 0, excluded: 0 })).toBeNull();
    expect(droppedText(null)).toBeNull();
    expect(droppedText({ old: 0, noTime: 0, chinese: 0, excluded: 4 })).toBe("뺀 줄: 제외 매체 4건");
  });

  it("받는 중인 출처가 있으면 몇 초 뒤 다시 읽는다", () => {
    expect(feedRefreshMs({ pending: true })).toBe(FEED_PENDING_REFRESH_MS);
    expect(feedRefreshMs({ pending: false })).toBe(0);
    expect(feedRefreshMs(null)).toBe(0);
  });
});

describe("거르기", () => {
  const rows = [
    item({ id: "1", kind: "news", source: "google_en", lang: "en" }),
    item({ id: "2", kind: "news", source: "naver", lang: "ko" }),
    item({ id: "3", kind: "wire", source: "wire", lang: null }),
  ];

  it("종류·출처·언어별 건수(받은 자료 기준) — 출처 이름은 상태 줄의 이름을 먼저", () => {
    const facets = facetCounts(rows, [{ source: "naver", label: "네이버 종목 뉴스", status: "ok", count: 1, dropped: null, message: null }]);
    expect(facets.kind).toEqual([{ key: "news", label: "뉴스", count: 2 }, { key: "wire", label: "속보", count: 1 }]);
    expect(facets.source.map((facet) => [facet.label, facet.count])).toEqual([["구글 뉴스(영어)", 1], ["네이버 종목 뉴스", 1], ["속보", 1]]);
    expect(facets.lang.map((facet) => [facet.key, facet.label, facet.count])).toEqual([["en", "영어", 1], ["ko", "한국어", 1], ["unknown", "모름", 1]]);
  });

  it("끈 값의 줄을 뺀다", () => {
    expect(applyFilters(rows, { kind: [], source: ["naver"], lang: [] }).map((row) => row.id)).toEqual(["1", "3"]);
    expect(applyFilters(rows, { kind: [], source: [], lang: ["unknown"] }).map((row) => row.id)).toEqual(["1", "2"]);
  });
});

describe("대상 머리·바로가기·보유", () => {
  it("식별자 칸 — 있는 것만", () => {
    expect(identifierChips(entity())).toEqual(["NVDA · 미국", "CIK 0001045810", "Wikidata Q182477"]);
    expect(identifierChips(entity({ ids: { ticker: null, market: "kr", stockCode: "005930", cik: null, dartCorpCode: "00126380", wikidata: null } })))
      .toEqual(["005930 · 한국", "DART 00126380"]);
  });

  it("종목은 종목 상세, 13F 기관(cik: 키)은 기관 상세 — 차트·시세는 그리지 않고 링크만", () => {
    expect(entityShortcuts(entity())).toEqual([{ label: "종목 상세", href: "/s/us/NVDA" }]);
    expect(entityShortcuts(entity({ key: "kr:005930", ids: { ticker: null, market: "kr", stockCode: "005930", cik: null, dartCorpCode: null, wikidata: null } })))
      .toEqual([{ label: "종목 상세", href: "/s/kr/005930" }]);
    expect(entityShortcuts(entity({ key: "cik:0001067983", kind: "institution", ids: { ticker: null, market: null, stockCode: null, cik: "0001067983", dartCorpCode: null, wikidata: null } })))
      .toEqual([{ label: "기관 상세", href: "/institutions/0001067983" }]);
    expect(entityShortcuts(entity({ key: "wd:Q1", kind: "person", ids: { ticker: null, market: null, stockCode: null, cik: null, dartCorpCode: null, wikidata: "Q1" } })))
      .toEqual([]);
  });

  it("13F 보유 기관 검색어 — 영문 이름(법인 꼬리 뗌), 없으면 티커", () => {
    expect(holdersQuery(entity())).toBe("NVIDIA");
    expect(holdersQuery(entity({ name: "삼성전자", nameEn: null, ids: { ticker: "SSNLF", market: "us", stockCode: null, cik: null, dartCorpCode: null, wikidata: null } })))
      .toBe("SSNLF");
    expect(holdersQuery(entity({ name: "Apple Inc.", nameEn: null }))).toBe("APPLE");
  });

  it("보유 자료의 2년 규칙 — 가장 최근 보고가 2년보다 오래면 보이지 않고 그 날짜만", () => {
    expect(holdingsWindow(["2026-09-30", "2026-06-30"], "2026-11-14")).toEqual({ recent: ["2026-09-30", "2026-06-30"], latest: "2026-09-30" });
    expect(holdingsWindow(["2023-12-31", "2024-03-31"], "2026-11-14")).toEqual({ recent: [], latest: "2024-03-31" });
    expect(holdingsWindow([], "2026-11-14")).toEqual({ recent: [], latest: null });
  });

  it("연결은 관계 종류별로 묶고 계약의 순서대로", () => {
    const groups = linkGroups([
      { relation: "subsidiary", key: "wd:Q2", name: "B", kind: "company", source: "wikidata" },
      { relation: "owned_by", key: null, name: "A", kind: "person", source: "wikidata" },
      { relation: "subsidiary", key: "wd:Q3", name: "C", kind: "company", source: "wikidata" },
      { relation: "mystery", key: null, name: "M", kind: null, source: "wikidata" },
    ]);
    expect(groups.map((group) => [group.label, group.links.map((link) => link.name)])).toEqual([
      ["소유자", ["A"]],
      ["자회사", ["B", "C"]],
      ["mystery", ["M"]],
    ]);
  });
});

describe("키보드·링크", () => {
  it("↑↓로 줄을 옮긴다 — 끝에서 멈추고, 고른 줄이 없으면 첫 줄", () => {
    expect(nextRowIndex(-1, "ArrowDown", 3)).toBe(0);
    expect(nextRowIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextRowIndex(2, "ArrowDown", 3)).toBe(2);
    expect(nextRowIndex(1, "ArrowUp", 3)).toBe(0);
    expect(nextRowIndex(0, "ArrowUp", 3)).toBe(0);
    expect(nextRowIndex(-1, "ArrowUp", 3)).toBe(0);
    expect(nextRowIndex(5, "ArrowUp", 0)).toBe(-1);
  });

  it("'/'는 다른 입력칸에서 칠 때·조합 중·수식키와 함께·대화상자 안에서는 검색창으로 가지 않는다", () => {
    const base = { key: "/", ctrlKey: false, metaKey: false, altKey: false, isComposing: false, target: { tagName: "BODY" } };
    expect(isSlashShortcut(base)).toBe(true);
    expect(isSlashShortcut({ ...base, target: { tagName: "INPUT" } })).toBe(false);
    expect(isSlashShortcut({ ...base, target: { tagName: "TEXTAREA" } })).toBe(false);
    expect(isSlashShortcut({ ...base, target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
    expect(isSlashShortcut({ ...base, target: { tagName: "BUTTON", closest: (selector: string) => (selector.includes("dialog") ? {} : null) } })).toBe(false);
    expect(isSlashShortcut({ ...base, isComposing: true })).toBe(false);
    expect(isSlashShortcut({ ...base, ctrlKey: true })).toBe(false);
    expect(isSlashShortcut({ ...base, key: "?" })).toBe(false);
  });

  it("원문 주소는 http(s)만", () => {
    expect(httpUrl("https://a.example/x")).toBe("https://a.example/x");
    expect(httpUrl("HTTP://a.example")).toBe("HTTP://a.example");
    expect(httpUrl("javascript:alert(1)")).toBeNull();
    expect(httpUrl(null)).toBeNull();
  });

  it("수집 글의 원문 팝업 — id로 본문을 읽고, 시각은 KST", () => {
    const entry = readerOfFeedItem(item({ id: "z", readerId: "0123456789abcdef01234567", source: "info", url: "javascript:x" }), "수집 글");
    expect(entry).toMatchObject({
      key: "search:z", sourceLabel: "수집 글", time: "2026-11-14 09:30 KST", itemId: "0123456789abcdef01234567", hasBody: true, url: null,
    });
  });
});

// ------------------------------------------------------------------ 단계 3 — 관심 대상·새 피드 묶음·매체 제외(계약 §6)

const watchItem = (over: Partial<SearchWatchItem> = {}): SearchWatchItem => ({
  id: 7, key: "us:NVDA", kind: "company", name: "엔비디아", createdAt: "2026-11-14T00:00:00+00:00", lastSeenAt: null, newCount: 0, ...over,
});

describe("관심 대상(계약 §6-4)", () => {
  it("등록은 대표 키로 — 풀린 대상의 key, 풀지 못했으면 주소의 키", () => {
    expect(watchKeyOf("wd:Q182477", entity({ key: "us:NVDA" }))).toBe("us:NVDA");
    expect(watchKeyOf("topic:AI 반도체", null)).toBe("topic:AI 반도체");
    // 풀린 대상의 키가 모양이 틀리면(있을 수 없지만) 주소의 키로 — 서버의 400을 부르지 않게.
    expect(watchKeyOf("us:NVDA", entity({ key: "bad key" }))).toBe("us:NVDA");
  });

  it("이 대상이 내 관심 대상인가 — 주소의 키나 대표 키가 같은 줄", () => {
    const items = [watchItem({ id: 7, key: "us:NVDA" }), watchItem({ id: 8, key: "cik:0001067983", kind: "institution", name: "버크셔" })];
    expect(findWatch(items, "us:NVDA", null)?.id).toBe(7);
    expect(findWatch(items, "wd:Q182477", entity({ key: "us:NVDA" }))?.id).toBe(7);
    expect(findWatch(items, "wd:Q1", entity({ key: "wd:Q1" }))).toBeNull();
    expect(findWatch([], "us:NVDA", null)).toBeNull();
  });

  it("새 글 수 꼬리표는 1건 이상일 때만 — 모르면(null) 0으로 채우지 않고 그리지 않음", () => {
    expect(newCountText(3)).toBe("새 글 3");
    expect(newCountText(1200)).toBe("새 글 999+");
    expect(newCountText(0)).toBeNull();
    expect(newCountText(null)).toBeNull();
    expect(newCountText(undefined)).toBeNull();
    expect(newCountText(Number.NaN)).toBeNull();
  });

  it("상한 한 줄 — 모르는 값은 '—'", () => {
    expect(watchLimitsText({ mine: 2, max: 10, serverUsed: 40, serverMax: 100 })).toBe("내 목록 2 / 10 · 서버 전체 40 / 100");
    expect(watchLimitsText({ mine: 2, max: 50, serverUsed: null, serverMax: 100 })).toBe("내 목록 2 / 50 · 서버 전체 — / 100");
    expect(watchLimitsText(null)).toBeNull();
  });

  it("정기 수집 안내 — 꺼진 곳(로컬·QA)이면 서버에서만 돈다고, 모르면 모른다고, 켜졌으면 없음", () => {
    expect(watchCollectingNote(false)).toContain("정기 수집은 서버에서만 돕니다");
    expect(watchCollectingNote(null)).toContain("확인하지 못했습니다");
    expect(watchCollectingNote(undefined)).toContain("확인하지 못했습니다");
    expect(watchCollectingNote(true)).toBeNull();
  });

  it("쓰기 실패 문구 — 409·400은 서버 사유 그대로(없으면 대신하는 글), 그 밖은 오류 글", () => {
    const failed = (status: number, message: string) => Object.assign(new Error(message), { status });
    expect(writeErrorText(failed(409, "관심 대상은 회원 10개까지입니다"), "상한")).toBe("관심 대상은 회원 10개까지입니다");
    expect(writeErrorText(failed(409, "요청 실패 (HTTP 409)"), "관심 대상 상한을 넘었습니다")).toBe("관심 대상 상한을 넘었습니다");
    expect(writeErrorText(failed(400, "도메인 모양이 아닙니다"), "x")).toBe("도메인 모양이 아닙니다");
    expect(writeErrorText(failed(403, "요청 실패 (HTTP 403)"), "x")).toBe("이 계정으로는 할 수 없습니다");
    expect(writeErrorText(failed(0, "백엔드 API(http://x)에 연결하지 못했습니다"), "x")).toBe("백엔드 API(http://x)에 연결하지 못했습니다");
    expect(writeErrorText("문자열", "x")).toBe("알 수 없는 오류");
  });

  it("'지금 새로 받기' 뒤의 한 줄 — 서버가 준 글(10분 상한 등)이 있으면 그것, 없으면 받은 시각", () => {
    expect(refreshNoteText({ refreshNote: "10분에 한 번만 새로 받습니다 — 저장해 둔 결과입니다", fetchedAt: "2026-11-14T01:00:00+00:00" }))
      .toBe("10분에 한 번만 새로 받습니다 — 저장해 둔 결과입니다");
    expect(refreshNoteText({ fetchedAt: "2026-11-14T01:00:00+00:00" })).toBe("새로 받았습니다 — 받은 시각 2026-11-14 10:00 KST");
    expect(refreshNoteText({ fetchedAt: null })).toBe("새로 받았습니다");
  });

  it("새로 받은 응답에 받지 못한 출처(실패·외부 조회 안 함)가 있으면 그 한 줄에 그렇다고 붙인다", () => {
    const status = (source: string, code: string): SearchSourceStatus => ({ source, label: source, status: code, count: null, dropped: null, message: null });
    const at = "2026-11-14T01:00:00+00:00";
    expect(refreshNoteText({ fetchedAt: at, sources: [status("google_en", "ok"), status("gdelt", "error")] }))
      .toBe("새로 받았습니다 — 받은 시각 2026-11-14 10:00 KST — 일부 출처는 받지 못함(아래 출처 상태)");
    expect(refreshNoteText({ fetchedAt: at, sources: [status("google_en", "ok"), status("finviz", "offline")] }))
      .toBe("새로 받았습니다 — 받은 시각 2026-11-14 10:00 KST — 일부 출처는 받지 못함(아래 출처 상태)");
    expect(refreshNoteText({ refreshNote: "10분에 한 번만 새로 받습니다", sources: [status("gdelt", "error")] }))
      .toBe("10분에 한 번만 새로 받습니다 — 일부 출처는 받지 못함(아래 출처 상태)");
    // 받음·캐시·결과 없음·건너뜀은 받지 못한 것이 아닙니다.
    expect(refreshNoteText({ fetchedAt: at, sources: ["ok", "cached", "empty", "skipped", "owner_only"].map((code) => status(code, code)) }))
      .toBe("새로 받았습니다 — 받은 시각 2026-11-14 10:00 KST");
  });

  it("새 글 수 합계(접힌 서랍 머리) — 1건 이상인 수만 더하고, 모르는 수(null)는 0으로 세지 않음", () => {
    expect(watchNewTotal([watchItem({ newCount: 3 }), watchItem({ newCount: 2 }), watchItem({ newCount: 0 })])).toBe(5);
    expect(watchNewTotal([watchItem({ newCount: null }), watchItem({ newCount: 4 })])).toBe(4);
    expect(watchNewTotal([watchItem({ newCount: null })])).toBe(0);
    expect(watchNewTotal([])).toBe(0);
  });

  it("새 출처 이름 — 새 피드 묶음·관심 대상 수집", () => {
    expect(sourceLabel("feeds")).toBe("보도자료·경제지 피드");
    expect(sourceLabel("watch")).toBe("관심 대상 수집");
  });
});

describe("매체 제외 목록(계약 §6-2·6-4)", () => {
  const existing = [
    { kind: "domain", value: "xinhuanet.com" },
    { kind: "name", value: "Global Times" },
  ];

  it("도메인은 소문자 호스트로 — 주소를 붙여 넣어도 호스트만, 메모는 비면 null", () => {
    expect(excludeDraft("domain", "  https://News.Example.COM:443/path?q=1 ", "  ", existing)).toEqual({
      ok: true, body: { kind: "domain", value: "news.example.com", note: null },
    });
    expect(excludeDraft("domain", "example.org.", " 사용자 추가 ", existing)).toEqual({
      ok: true, body: { kind: "domain", value: "example.org", note: "사용자 추가" },
    });
  });

  it("국제화 도메인(유니코드 표기)은 서버처럼 ASCII(punycode)로 바꿔 보내고, 메모가 비었으면 입력한 표기를 메모로 남긴다", () => {
    expect(excludeDraft("domain", "한겨레.한국", null, existing)).toEqual({
      ok: true, body: { kind: "domain", value: "xn--h89at9srwx.xn--3e0b707e", note: "입력: 한겨레.한국" },
    });
    expect(excludeDraft("domain", "https://Bücher.example/a", "  ", existing)).toEqual({
      ok: true, body: { kind: "domain", value: "xn--bcher-kva.example", note: "입력: bücher.example" },
    });
    // 메모를 쓴 값은 그대로, ASCII로 넣은 값(punycode 포함)에는 붙이지 않음
    expect(excludeDraft("domain", "한겨레.한국", " 한겨레 ", existing)).toMatchObject({ ok: true, body: { note: "한겨레" } });
    expect(excludeDraft("domain", "xn--h89at9srwx.xn--3e0b707e", null, existing)).toMatchObject({ ok: true, body: { note: null } });
    // 이미 punycode로 넣은 값과 같으면 다시 더하지 않음
    expect(excludeDraft("domain", "한겨레.한국", null, [{ kind: "domain", value: "xn--h89at9srwx.xn--3e0b707e" }])).toEqual({
      ok: false, message: "이미 목록에 있습니다",
    });
    // 모양이 틀린 유니코드 값은 그대로 거절
    expect(excludeDraft("domain", "한겨레", null, existing)).toMatchObject({ ok: false });
    expect(excludeDraft("domain", "사용자@한겨레.한국", null, existing)).toMatchObject({ ok: false });
  });

  it("도메인 모양이 아니면 거절", () => {
    expect(excludeDraft("domain", "", null, existing)).toMatchObject({ ok: false });
    expect(excludeDraft("domain", "localhost", null, existing)).toMatchObject({ ok: false });
    expect(excludeDraft("domain", "bad_host.com", null, existing)).toMatchObject({ ok: false });
    expect(excludeDraft("domain", "a b.com", null, existing)).toMatchObject({ ok: false });
  });

  it("이름은 앞뒤 공백만 떼고 그대로(대조는 서버가 대소문자 무시 완전 일치), 길이 상한은 서버와 같은 80자", () => {
    // 가운데 공백은 그대로 — 백엔드(strip)·수집기(strip().casefold())가 그 값으로 대조합니다.
    expect(excludeDraft("name", "  Some  Media ", null, existing)).toEqual({ ok: true, body: { kind: "name", value: "Some  Media", note: null } });
    expect(excludeDraft("name", "x".repeat(80), null, existing)).toMatchObject({ ok: true });
    expect(excludeDraft("name", "x".repeat(81), null, existing)).toMatchObject({ ok: false });
    expect(excludeDraft("name", "a\u0001b", null, existing)).toMatchObject({ ok: false });
    expect(excludeDraft("name", "   ", null, existing)).toMatchObject({ ok: false });
  });

  it("이미 있으면(처음 값·더한 것 — 대소문자 무시) 다시 더하지 않음", () => {
    expect(excludeDraft("domain", "XINHUANET.com", null, existing)).toEqual({ ok: false, message: "이미 목록에 있습니다" });
    expect(excludeDraft("name", "global times", null, existing)).toEqual({ ok: false, message: "이미 목록에 있습니다" });
    // 종류가 다르면 다른 값입니다.
    expect(excludeDraft("name", "xinhuanet.com", null, existing)).toMatchObject({ ok: true });
  });

  it("앞의 www.는 뗀다(수집기 normalize_domain·백엔드와 같게) — 붙여 넣은 www 주소가 따로 한 줄이 되지 않게", () => {
    expect(excludeDraft("domain", "www.Example.org", null, existing)).toEqual({ ok: true, body: { kind: "domain", value: "example.org", note: null } });
    expect(excludeDraft("domain", "https://WWW.한겨레.한국/path", null, existing)).toEqual({
      ok: true, body: { kind: "domain", value: "xn--h89at9srwx.xn--3e0b707e", note: "입력: 한겨레.한국" },
    });
    expect(excludeDraft("domain", "https://WWW.한겨레.한국/path", null, [{ kind: "domain", value: "xn--h89at9srwx.xn--3e0b707e" }])).toEqual({
      ok: false, message: "이미 목록에 있습니다",
    });
    // www 하나만 남는 값은 도메인이 아님
    expect(excludeDraft("domain", "www.com", null, existing)).toMatchObject({ ok: false });
  });

  it("목록의 도메인 아래 주소(점 경계)는 이미 걸리므로 더하지 않고, 어느 값이 덮는지 글로", () => {
    expect(excludeDraft("domain", "english.XINHUANET.com", null, existing)).toEqual({
      ok: false, message: "이미 목록의 xinhuanet.com이(가) 이 도메인을 덮습니다",
    });
    expect(excludeDraft("domain", "news.한겨레.한국", null, [{ kind: "domain", value: "xn--h89at9srwx.xn--3e0b707e" }])).toEqual({
      ok: false, message: "이미 목록의 xn--h89at9srwx.xn--3e0b707e이(가) 이 도메인을 덮습니다",
    });
    // 점 경계가 아니면 다른 도메인, 이름 종류는 도메인을 덮지 않음, 더 넓은 도메인은 더할 수 있음
    expect(excludeDraft("domain", "notxinhuanet.com", null, existing)).toMatchObject({ ok: true });
    expect(excludeDraft("domain", "news.example.com", null, [{ kind: "name", value: "example.com" }])).toMatchObject({ ok: true });
    expect(excludeDraft("domain", "example.com", null, [{ kind: "domain", value: "news.example.com" }])).toMatchObject({ ok: true });
  });

  it("처음 값은 묶음별로(받은 순서), 묶음이 없으면 '그 밖'", () => {
    expect(excludeSeedGroups([
      { kind: "domain", value: "a.cn", group: "중국 국가·당 매체" },
      { kind: "domain", value: "b.hk", group: "홍콩" },
      { kind: "name", value: "C", group: "중국 국가·당 매체" },
      { kind: "domain", value: "d.example", group: null },
    ])).toEqual([
      { group: "중국 국가·당 매체", items: [{ kind: "domain", value: "a.cn" }, { kind: "name", value: "C" }] },
      { group: "홍콩", items: [{ kind: "domain", value: "b.hk" }] },
      { group: "그 밖", items: [{ kind: "domain", value: "d.example" }] },
    ]);
    expect(excludeKindLabel("domain")).toBe("도메인");
    expect(excludeKindLabel("name")).toBe("이름");
    expect(excludeKindLabel("other")).toBe("other");
  });
});

// ------------------------------------------------------------------ 단계 4 — 공시·리서치·연결 보강(계약 §7)

describe("날짜만 아는 줄(계약 §7-1 — timeBasis \"date\")", () => {
  // DART·네이버 = 그 날짜의 KST 00:00, SEC = 미국 동부 00:00을 UTC로 바꾼 값 — KST 날짜가 출처의 날짜와 같습니다.
  const dart = item({ id: "d", kind: "filing", source: "dart", timeBasis: "date", publishedAt: "2026-11-12T15:00:00+00:00" });
  const secWinter = item({ id: "s1", kind: "filing", source: "sec_fts", timeBasis: "date", publishedAt: "2026-11-13T05:00:00+00:00" });
  const secSummer = item({ id: "s2", kind: "filing", source: "sec_fts", timeBasis: "date", publishedAt: "2026-07-01T04:00:00+00:00" });

  it("날짜만(YYYY-MM-DD) — 시각·'KST'를 붙이지 않음", () => {
    expect(isDateOnly(dart)).toBe(true);
    expect(isDateOnly(item())).toBe(false);
    expect(itemTimeText(dart)).toBe("2026-11-13");
    expect(itemTimeText(secWinter)).toBe("2026-11-13");
    expect(itemTimeText(secSummer)).toBe("2026-07-01");
    expect(itemTimeText(item())).toBe("2026-11-14 09:30 KST");
    expect(itemTimeText(item({ timeBasis: "date", publishedAt: null }))).toBe("—");
  });

  it("목록의 시각 칸 — 날짜만 아는 줄은 날짜, 그 밖은 KST 시각, 모르면 '—'", () => {
    expect(rowTimeText(dart)).toBe("2026-11-13");
    expect(rowTimeText(item())).toBe("09:30");
    expect(rowTimeText(item({ publishedAt: null }))).toBe("—");
  });

  it("날짜 묶음·기간 자르기도 그 날짜로(KST)", () => {
    expect(groupByKstDate([dart, secWinter]).map((group) => group.date)).toEqual(["2026-11-13"]);
    expect(countByRange([dart, secSummer], "2026-11-14")).toEqual({ "7d": 1, "30d": 1, "1y": 2, "2y": 2 });
  });

  it("수집 글 팝업의 시각도 날짜만", () => {
    expect(readerOfFeedItem(dart, "DART 공시").time).toBe("2026-11-13");
  });
});

describe("단계 4 출처·관계 이름", () => {
  it("공시·리서치·연결 보강 출처 이름(응답의 상태 줄 이름이 없을 때)", () => {
    expect(sourceLabel("sec")).toBe("SEC 공시(회사별)");
    expect(sourceLabel("sec_fts")).toBe("SEC 전문 검색(이름)");
    expect(sourceLabel("dart")).toBe("DART 공시");
    expect(sourceLabel("yahoo_research")).toBe("투자의견 변경(Yahoo)");
    expect(sourceLabel("naver_research")).toBe("증권사 리포트(네이버)");
    expect(sourceLabel("insiders")).toBe("내부자 명단(Yahoo)");
    expect(sourceLabel("gleif")).toBe("법인 관계(GLEIF)");
    // 상태 줄의 이름이 있으면 그쪽
    expect(sourceLabel("dart", [status({ source: "dart", label: "DART" })])).toBe("DART");
  });

  it("관계 이름 — 내부자·최상위 모회사·모회사·자회사, 모르는 관계는 이름 그대로", () => {
    expect(relationLabel("insider")).toBe("내부자");
    expect(relationLabel("ultimate_parent")).toBe("최상위 모회사");
    expect(relationLabel("parent")).toBe("모회사");
    expect(relationLabel("subsidiary")).toBe("자회사");
    expect(relationLabel("mystery")).toBe("mystery");
  });

  it("연결 출처 이름 — Wikidata·13F·Yahoo·GLEIF", () => {
    expect(linkSourceLabel("wikidata")).toBe("Wikidata");
    expect(linkSourceLabel("13f")).toBe("13F 기관 목록");
    expect(linkSourceLabel("yahoo")).toBe("Yahoo");
    expect(linkSourceLabel("gleif")).toBe("GLEIF");
    expect(linkSourceLabel("other")).toBe("other");
  });

  it("관계 묶음 순서 — 대표 다음 내부자, 최상위 모회사가 모회사 앞", () => {
    const groups = linkGroups([
      link({ relation: "subsidiary", name: "C" }),
      link({ relation: "insider", name: "I", kind: "person" }),
      link({ relation: "parent", name: "P" }),
      link({ relation: "ultimate_parent", name: "U" }),
      link({ relation: "ceo", name: "E", kind: "person" }),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["대표", "내부자", "최상위 모회사", "모회사", "자회사"]);
  });
});

function status(over: Partial<SearchSourceStatus>): SearchSourceStatus {
  return { source: "gleif", label: "법인 관계(GLEIF)", status: "ok", count: 0, dropped: null, message: null, ...over };
}

function link(over: Partial<SearchLink>): SearchLink {
  return { relation: "subsidiary", key: null, name: "X", kind: "company", source: "gleif", detail: null, ...over };
}

describe("연결 합치기(계약 §7-5 — 대상 풀기의 links + 연결 보강 경로)", () => {
  it("대상 풀기의 연결이 먼저, 같은 관계·같은 대상(키, 없으면 이름 — 대소문자·공백 무시)은 한 줄 — 빠진 키·설명은 뒤 줄에서 채움", () => {
    const merged = mergeLinks(
      [
        link({ relation: "subsidiary", key: "wd:Q100", name: "Mellanox", source: "wikidata" }),
        link({ relation: "parent", key: null, name: "Acme Holdings", source: "wikidata" }),
      ],
      [
        link({ relation: "parent", name: "ACME  holdings", detail: "US · LEI TEST00LEI0000000AB42" }),
        link({ relation: "subsidiary", name: "Mellanox Technologies Ltd", detail: "IL · LEI TEST00LEI0000000CD17" }),
        link({ relation: "insider", name: "Jane Roe", kind: "person", source: "yahoo", detail: "CFO" }),
      ],
    );
    expect(merged.map((row) => [row.relation, row.name, row.source, row.detail ?? null])).toEqual([
      ["subsidiary", "Mellanox", "wikidata", null],
      ["parent", "Acme Holdings", "wikidata", "US · LEI TEST00LEI0000000AB42"],
      ["subsidiary", "Mellanox Technologies Ltd", "gleif", "IL · LEI TEST00LEI0000000CD17"],
      ["insider", "Jane Roe", "yahoo", "CFO"],
    ]);
  });

  it("키 있는 Wikidata 연결과 키 없는 GLEIF 연결이 같은 관계·같은 이름이면 한 줄 — 키는 Wikidata, 설명은 GLEIF에서", () => {
    const merged = mergeLinks(
      [link({ relation: "parent", key: "wd:Q20800404", name: "Example Parent Inc.", source: "wikidata" })],
      [link({ relation: "parent", key: null, name: "EXAMPLE PARENT INC.", source: "gleif", detail: "US · LEI TEST00LEI0000000PA22" })],
    );
    expect(merged).toEqual([
      { relation: "parent", key: "wd:Q20800404", name: "Example Parent Inc.", kind: "company", source: "wikidata", detail: "US · LEI TEST00LEI0000000PA22" },
    ]);
  });

  it("키 없는 줄이 앞에 있고 같은 이름의 키 있는 줄이 뒤에 오면 그 키로 채움 — 그 뒤 같은 키의 줄도 같은 줄", () => {
    const merged = mergeLinks(
      [link({ relation: "manager", key: null, name: "Jane Roe", kind: "person", source: "13f" })],
      [
        link({ relation: "manager", key: "wd:Q7", name: "jane roe", kind: "person", source: "wikidata" }),
        link({ relation: "manager", key: "wd:Q7", name: "J. Roe", kind: "person", source: "wikidata", detail: "설명" }),
      ],
    );
    expect(merged).toEqual([{ relation: "manager", key: "wd:Q7", name: "Jane Roe", kind: "person", source: "13f", detail: "설명" }]);
  });

  it("키가 다른 두 줄은 이름이 같아도 따로(동명이인), 그 이름의 키 없는 줄은 어느 쪽인지 짐작하지 않고 따로", () => {
    const merged = mergeLinks(
      [
        link({ relation: "subsidiary", key: "wd:Q1", name: "Acme", source: "wikidata" }),
        link({ relation: "subsidiary", key: "wd:Q2", name: "ACME", source: "wikidata" }),
      ],
      [link({ relation: "subsidiary", key: null, name: "acme", source: "gleif", detail: "US · LEI TEST00LEI0000000AC55" })],
    );
    expect(merged.map((row) => [row.key, row.source, row.detail ?? null])).toEqual([
      ["wd:Q1", "wikidata", null],
      ["wd:Q2", "wikidata", null],
      [null, "gleif", "US · LEI TEST00LEI0000000AC55"],
    ]);
  });

  it("관계가 다르면 같은 이름이어도 따로(대표와 내부자)", () => {
    const merged = mergeLinks(
      [link({ relation: "ceo", key: "wd:Q5", name: "Jane Roe", kind: "person", source: "wikidata" })],
      [link({ relation: "insider", name: "Jane Roe", kind: "person", source: "yahoo" })],
    );
    expect(merged).toHaveLength(2);
  });
});

describe("연결 탭 상태(계약 §7-7 — 받는 중·실패·건너뜀은 글로)", () => {
  const entityLinks = [link({ relation: "founded_by", key: null, name: "Jensen Huang", kind: "person", source: "wikidata" })];
  const response = (over: Partial<SearchLinksResponse> = {}): SearchLinksResponse => ({
    available: true, entityKey: "us:NVDA",
    links: [link({ relation: "insider", name: "Jane Roe", kind: "person", source: "yahoo", detail: "CFO" })],
    sources: [status({ source: "insiders", label: "내부자 명단(Yahoo)", count: 1 }), status({ source: "gleif", status: "skipped", message: "LEI 없음" })],
    fetchedAt: "2026-11-14T01:00:00+00:00", ...over,
  });

  it("받는 중 — 대상 풀기의 연결은 바로 보이고, 보강은 받는 중이라고(없다고 하지 않음)", () => {
    const view = linksView({ entity: { links: entityLinks }, entitySettled: true, entityErrors: {}, response: null, loading: true, error: null });
    expect(view.groups.map((group) => group.label)).toEqual(["창업자"]);
    expect(view.extra).toEqual({ state: "loading", text: expect.stringContaining("받는 중") });
    expect(view.empty).toBeNull();
    expect(view.sources).toEqual([]);
  });

  it("받으면 합쳐 묶고 출처 상태를 넘긴다", () => {
    const view = linksView({ entity: { links: entityLinks }, entitySettled: true, entityErrors: {}, response: response(), loading: false, error: null });
    expect(view.groups.map((group) => group.label)).toEqual(["창업자", "내부자"]);
    expect(view.extra).toBeNull();
    expect(view.sources.map((row) => row.source)).toEqual(["insiders", "gleif"]);
    expect(view.empty).toBeNull();
  });

  it("보강 경로가 실패하면(요청 실패·수집기 응답 없음) 사유를 글로, 대상 풀기의 연결은 그대로", () => {
    const failed = linksView({ entity: { links: entityLinks }, entitySettled: true, entityErrors: {}, response: null, loading: false, error: "HTTP 502" });
    expect(failed.extra).toEqual({ state: "error", text: expect.stringContaining("HTTP 502") });
    expect(failed.groups).toHaveLength(1);
    const offline = linksView({
      entity: { links: entityLinks }, entitySettled: true, entityErrors: {}, response: { available: false, message: "수집기에서 응답을 받지 못했습니다." }, loading: false, error: null,
    });
    expect(offline.extra).toEqual({ state: "error", text: expect.stringContaining("수집기에서 응답을 받지 못했습니다.") });
  });

  it("연결이 하나도 없을 때 — 다 받았으면 없다고, 받지 못한 출처가 있으면 더 있는지 모른다고, 받는 중이면 말하지 않음", () => {
    const none = linksView({ entity: { links: [] }, entitySettled: true, entityErrors: {}, response: response({ links: [] }), loading: false, error: null });
    expect(none.empty).toMatch(/^가진 연결이 없습니다/);
    const partly = linksView({
      entity: { links: [] }, entitySettled: true, entityErrors: {},
      response: response({ links: [], sources: [status({ source: "insiders", status: "error", message: "HTTP 429" })] }), loading: false, error: null,
    });
    expect(partly.empty).toMatch(/모릅니다/);
    const failed = linksView({ entity: { links: [] }, entitySettled: true, entityErrors: {}, response: null, loading: false, error: "HTTP 502" });
    expect(failed.empty).toMatch(/모릅니다/);
    expect(linksView({ entity: { links: [] }, entitySettled: true, entityErrors: {}, response: null, loading: true, error: null }).empty).toBeNull();
  });

  it("대상은 풀렸지만 Wikidata를 받지 못했으면(errors.wikidata) 보강 출처가 모두 건너뜀이어도 '없다'고 하지 않고 모른다고, 사유를 한 줄로", () => {
    const skippedOnly = response({
      links: [],
      sources: [
        status({ source: "insiders", label: "내부자 명단(Yahoo)", status: "skipped", message: "미국 상장 회사가 아님" }),
        status({ source: "gleif", status: "skipped", message: "LEI 없음" }),
      ],
    });
    const view = linksView({ entity: { links: [] }, entitySettled: true, entityErrors: { wikidata: "HTTP 503" }, response: skippedOnly, loading: false, error: null });
    expect(view.empty).toMatch(/모릅니다/);
    expect(view.empty).not.toMatch(/^가진 연결이 없습니다/);
    expect(view.entityNote).toBe("Wikidata 관계를 받지 못했습니다 — HTTP 503");
    // 연결이 있어도(일부만 받음) 사유 줄은 남김
    const partial = linksView({ entity: { links: entityLinks }, entitySettled: true, entityErrors: { wikidata: "HTTP 503" }, response: skippedOnly, loading: false, error: null });
    expect(partial.entityNote).toBe("Wikidata 관계를 받지 못했습니다 — HTTP 503");
    // 다른 출처의 오류(SEC 표 등)는 연결과 무관 — 다 받았으면 없다고
    const other = linksView({ entity: { links: [] }, entitySettled: true, entityErrors: { sec: "HTTP 500" }, response: skippedOnly, loading: false, error: null });
    expect(other.empty).toMatch(/^가진 연결이 없습니다/);
    expect(other.entityNote).toBeNull();
    // 대상 풀기 시간 초과(errors.entity — 수집기는 이때 wikidata 사유를 지움)도 Wikidata 관계를 모르는 것 — 수집기 _unknown_lei와 같은 기준
    const timedOut = linksView({ entity: { links: [] }, entitySettled: true, entityErrors: { entity: "대상 풀기가 15초를 넘어 저장본 이름으로만 답함" }, response: skippedOnly, loading: false, error: null });
    expect(timedOut.empty).toMatch(/모릅니다/);
    expect(timedOut.entityNote).toBe("Wikidata 관계를 받지 못했습니다 — 대상 풀기가 15초를 넘어 저장본 이름으로만 답함");
  });

  it("실패 뒤 다시 받는 중이면(앞 응답이 남아 있어도) 실패 글이 아니라 받는 중", () => {
    const offline = { available: false, message: "timeout" } as const;
    const retrying = linksView({ entity: { links: entityLinks }, entitySettled: true, entityErrors: {}, response: offline, loading: true, error: null });
    expect(retrying.extra).toEqual({ state: "loading", text: expect.stringContaining("받는 중") });
    expect(retrying.empty).toBeNull();
    // 받은 응답을 다시 읽는 동안(수동 새로고침)은 받는 중 줄을 띄우지 않음 — 보이던 연결 그대로
    expect(linksView({ entity: { links: entityLinks }, entitySettled: true, entityErrors: {}, response: response(), loading: true, error: null }).extra).toBeNull();
  });

  it("대상을 풀지 못했으면 Wikidata·13F 연결은 모른다고 — 보강 경로의 연결은 보임", () => {
    const view = linksView({ entity: null, entitySettled: true, entityErrors: {}, response: response(), loading: false, error: null });
    expect(view.entityNote).toMatch(/대상을 풀지 못해/);
    expect(view.groups.map((group) => group.label)).toEqual(["내부자"]);
    expect(linksView({ entity: null, entitySettled: false, entityErrors: {}, response: null, loading: true, error: null }).entityNote).toMatch(/푸는 중/);
    expect(linksView({ entity: { links: [] }, entitySettled: true, entityErrors: {}, response: response(), loading: false, error: null }).entityNote).toBeNull();
  });
});
