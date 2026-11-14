/**
 * 정보 검색 단계 6 묶음 1(계약 §9-1~9-3)의 화면 규칙 — 기간 막대(KST 하루·월요일 시작 주), 같은 사건 묶음 보기, 연결 그림 배치.
 * 표본은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import {
  LINK_GRAPH_MAX,
  PERIOD_BARS_NOTE,
  clusterToggleText,
  feedClusterCount,
  feedEmptyState,
  feedEntryGroups,
  fitGraphLabel,
  graphLinks,
  itemInPeriod,
  kstWeekStart,
  linkGraphLayout,
  linkGraphSize,
  linkGroups,
  otherDateText,
  periodAriaLabel,
  periodBars,
  periodLabel,
  periodUnit,
  type FeedClusterEntry,
  type FeedEntry,
} from "@/lib/infoSearch";
import type { SearchFeedItem, SearchLink } from "@/lib/types";

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "제목", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null, ...over,
  };
}

const keys = (entries: readonly FeedEntry[]) => entries.map((entry) => entry.key);

describe("기간 막대 — 단위와 주의 시작(계약 §9-1)", () => {
  it("7일·30일은 하루씩, 1년·2년은 주마다", () => {
    expect(periodUnit("7d")).toBe("day");
    expect(periodUnit("30d")).toBe("day");
    expect(periodUnit("1y")).toBe("week");
    expect(periodUnit("2y")).toBe("week");
  });

  it("주는 월요일 시작 — 토·일요일은 그 앞 월요일, 월요일은 그날, 달·해를 넘어감", () => {
    expect(kstWeekStart("2026-11-14")).toBe("2026-11-09"); // 토
    expect(kstWeekStart("2026-11-15")).toBe("2026-11-09"); // 일
    expect(kstWeekStart("2026-11-09")).toBe("2026-11-09"); // 월
    expect(kstWeekStart("2026-11-10")).toBe("2026-11-09"); // 화
    expect(kstWeekStart("2026-11-01")).toBe("2026-10-26"); // 일 — 달을 넘어감
    expect(kstWeekStart("2026-01-01")).toBe("2025-12-29"); // 목 — 해를 넘어감
  });
});

describe("기간 막대 — 건수(받은 자료 기준)", () => {
  it("7일은 오늘 − 7일부터 오늘까지 하루씩(8칸) — KST 날짜로 셈(UTC로는 전날인 줄도 KST 날짜)", () => {
    const items = [
      row({ id: "a", publishedAt: "2026-11-14T00:30:00+00:00" }), // KST 11-14 09:30
      row({ id: "b", publishedAt: "2026-11-13T20:00:00+00:00" }), // KST 11-14 05:00
      row({ id: "c", publishedAt: "2026-11-13T10:00:00+00:00" }), // KST 11-13 19:00
      row({ id: "d", publishedAt: "2026-11-07T00:00:00+00:00" }), // KST 11-07 — 첫 칸
    ];
    const bars = periodBars(items, "7d", "2026-11-14");
    expect(bars.unit).toBe("day");
    expect(bars.bins.map((bin) => bin.start)).toEqual([
      "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14",
    ]);
    expect(bars.bins.every((bin) => bin.start === bin.end)).toBe(true);
    expect(bars.bins.map((bin) => bin.count)).toEqual([1, 0, 0, 0, 0, 0, 1, 2]);
    expect(bars.max).toBe(2);
    expect(bars.offChart).toBe(0);
  });

  it("30일은 31칸(오늘 − 30일부터)", () => {
    const bars = periodBars([row({})], "30d", "2026-11-14");
    expect(bars.bins.length).toBe(31);
    expect(bars.bins[0].start).toBe("2026-10-15");
    expect(bars.bins[30].start).toBe("2026-11-14");
  });

  it("1년은 월요일 시작 주마다 — 첫 칸은 기간 시작 날이 든 주, 끝 칸은 오늘이 든 주(끝 날은 일요일)", () => {
    const items = [
      row({ id: "a", publishedAt: "2026-11-14T00:30:00+00:00" }), // 토 → 11-09 주
      row({ id: "b", publishedAt: "2026-11-09T00:30:00+00:00" }), // 월 → 11-09 주
      row({ id: "c", publishedAt: "2026-11-08T15:30:00+00:00" }), // UTC 일 15:30 = KST 월 11-09 00:30 → 11-09 주
      row({ id: "d", publishedAt: "2026-11-08T00:30:00+00:00" }), // KST 일 11-08 → 11-02 주
    ];
    const bars = periodBars(items, "1y", "2026-11-14");
    expect(bars.unit).toBe("week");
    expect(bars.bins[0].start).toBe("2025-11-10"); // rangeStart(1y) = 2025-11-14(금) → 그 주 월요일
    expect(bars.bins.at(-1)).toMatchObject({ start: "2026-11-09", end: "2026-11-15", count: 3 });
    expect(bars.bins.at(-2)).toMatchObject({ start: "2026-11-02", end: "2026-11-08", count: 1 });
    expect(bars.bins.length).toBe(53);
    expect(bars.bins.every((bin, at) => at === 0 || bin.start > bars.bins[at - 1].end)).toBe(true);
  });

  it("2년은 105칸 안팎의 주 — 모든 줄이 한 칸에만 들어감", () => {
    const items = Array.from({ length: 50 }, (_, at) => row({ id: `w${at}`, publishedAt: new Date(Date.UTC(2025, 0, 1 + at * 13)).toISOString() }));
    const bars = periodBars(items, "2y", "2026-11-14");
    expect(bars.bins.length).toBeGreaterThanOrEqual(105);
    expect(bars.bins.length).toBeLessThanOrEqual(106);
    expect(bars.bins.reduce((total, bin) => total + bin.count, 0)).toBe(50);
  });

  it("시각을 모르는 줄은 막대에 없고 따로 셈 — 0으로 채우지 않음", () => {
    const bars = periodBars([row({ id: "a" }), row({ id: "b", publishedAt: null })], "7d", "2026-11-14");
    expect(bars.bins.reduce((total, bin) => total + bin.count, 0)).toBe(1);
    expect(bars.offChart).toBe(1);
  });

  it("오늘을 모르면 받은 줄의 가장 최근 날짜까지, 날짜를 아는 줄이 없으면 막대 없음", () => {
    const bars = periodBars([row({ id: "a", publishedAt: "2026-11-10T00:30:00+00:00" })], "7d", null);
    expect(bars.bins.at(-1)?.start).toBe("2026-11-10");
    expect(bars.bins.length).toBe(8);
    expect(periodBars([row({ publishedAt: null })], "7d", null).bins).toEqual([]);
    expect(periodBars([], "7d", "2026-11-14").max).toBe(0);
  });

  it("서버가 센 기간보다 조금 이른 줄(기간 밖)·내일 날짜 줄도 칸을 늘려 담음(많아야 7일·4주) — 그보다 이른 줄·이틀 뒤는 막대 밖", () => {
    const items = [
      row({ id: "early", publishedAt: "2026-11-05T00:30:00+00:00" }), // 7일 기간 시작(11-07)보다 이틀 이름
      row({ id: "tomorrow", publishedAt: "2026-11-15T00:30:00+00:00" }), // 내일(KST)
      row({ id: "far", publishedAt: "2026-11-20T00:30:00+00:00" }), // 엿새 뒤 — 막대 밖
      row({ id: "old", publishedAt: "2020-01-01T00:30:00+00:00" }), // 2년 밖 — 막대 밖
    ];
    const bars = periodBars(items, "7d", "2026-11-14");
    expect(bars.bins[0].start).toBe("2026-11-05");
    expect(bars.bins.at(-1)?.start).toBe("2026-11-15");
    expect(bars.bins.reduce((total, bin) => total + bin.count, 0)).toBe(2);
    expect(bars.offChart).toBe(2);
    // 기간(7일) 시작보다 8일 이른 줄은 칸을 늘리지 않고 막대 밖 — 30일 기간에 2년치 줄이 와도 31칸 남짓.
    const far = periodBars([row({ id: "x", publishedAt: "2026-10-30T00:30:00+00:00" })], "7d", "2026-11-14");
    expect(far.bins.length).toBe(8);
    expect(far.offChart).toBe(1);
    const yearOfRows = Array.from({ length: 365 }, (_, at) => row({ id: `y${at}`, publishedAt: new Date(Date.UTC(2026, 10, 14) - at * 86400000).toISOString() }));
    expect(periodBars(yearOfRows, "30d", "2026-11-14").bins.length).toBe(38);
    expect(periodBars(yearOfRows, "1y", "2026-11-14").bins.length).toBe(53);
  });

  it("막대 이름 — 하루는 'YYYY-MM-DD (요일)', 주는 '시작 ~ 끝 주', 낭독용은 건수와 함께", () => {
    expect(periodLabel({ start: "2026-11-14", end: "2026-11-14" }, "day")).toBe("2026-11-14 (토)");
    expect(periodLabel({ start: "2026-11-09", end: "2026-11-15" }, "week")).toBe("2026-11-09 ~ 2026-11-15 주");
    expect(periodAriaLabel({ start: "2026-11-14", end: "2026-11-14", count: 3 }, "day")).toBe("2026-11-14 (토) 3건");
    expect(periodAriaLabel({ start: "2026-11-09", end: "2026-11-15", count: 0 }, "week")).toBe("2026-11-09 ~ 2026-11-15 주 0건");
    expect(PERIOD_BARS_NOTE).toBe("받은 자료 기준 — 출처마다 한 번에 주는 건수에 상한이 있어 전체 보도량이 아님");
  });

  it("좁히기 — 그 날·주의 KST 날짜인 줄만(경계 포함), 시각 모르는 줄은 빠짐", () => {
    const week = { start: "2026-11-09", end: "2026-11-15" };
    expect(itemInPeriod(row({ publishedAt: "2026-11-08T15:00:00+00:00" }), week)).toBe(true); // KST 11-09 00:00
    expect(itemInPeriod(row({ publishedAt: "2026-11-08T14:59:00+00:00" }), week)).toBe(false); // KST 11-08 23:59
    expect(itemInPeriod(row({ publishedAt: "2026-11-15T14:59:00+00:00" }), week)).toBe(true); // KST 11-15 23:59
    expect(itemInPeriod(row({ publishedAt: null }), week)).toBe(false);
  });

  it("좁힌 기간에 맞는 줄이 없으면(거르기를 바꾼 뒤 등) 그렇다고 — 거르기 안내와 따로", () => {
    const counts = { "7d": 2, "30d": 2, "1y": 2, "2y": 2 };
    const empty = feedEmptyState({ total: 2, inRange: 2, shown: 2, narrowed: 0, counts, range: "30d", olderOnlyLatest: null });
    expect(empty).toMatchObject({ kind: "period", message: "좁힌 기간(막대)에 맞는 자료가 없습니다" });
    expect(feedEmptyState({ total: 2, inRange: 2, shown: 0, narrowed: 0, counts, range: "30d", olderOnlyLatest: null })?.kind).toBe("filtered");
    expect(feedEmptyState({ total: 2, inRange: 2, shown: 2, narrowed: 1, counts, range: "30d", olderOnlyLatest: null })).toBeNull();
  });
});

describe("같은 사건 묶음 보기(계약 §9-2)", () => {
  // 최근순(화면이 받은 줄을 정렬한 순서). c1 묶음: 대표 c1a(가장 이른 줄) + c1b + c1c, c2 묶음은 대표만 보임(나머지는 기간 밖).
  const lead = row({
    id: "c1a", title: "대표 기사", clusterId: "c1a", cluster: { size: 3, publishers: 2 }, publisher: "Alpha", publisherDomain: "alpha.example",
    publishedAt: "2026-11-13T01:00:00+00:00",
  });
  const second = row({ id: "c1b", title: "둘째 보도", clusterId: "c1a", publisher: "Beta", publisherDomain: "beta.example", publishedAt: "2026-11-13T22:00:00+00:00" });
  const third = row({ id: "c1c", title: "셋째 보도", clusterId: "c1a", publisher: "Alpha", publisherDomain: "alpha.example", publishedAt: "2026-11-13T05:00:00+00:00" });
  const lonely = row({ id: "c2a", title: "혼자 남은 대표", clusterId: "c2a", cluster: { size: 4, publishers: 3 }, publishedAt: "2026-11-12T03:00:00+00:00" });
  const plain = row({ id: "p1", title: "묶이지 않은 줄", clusterId: null, publishedAt: "2026-11-13T23:00:00+00:00" });
  const sorted = [plain, second, third, lead, lonely];

  it("기본(묶어 보기) — 대표 줄 아래 묶음 줄 하나, 나머지 줄은 숨김. 보이는 줄이 하나뿐인 묶음은 그냥 줄", () => {
    const groups = feedEntryGroups(sorted, { grouped: true, expanded: new Set() });
    const all = groups.flatMap((group) => group.entries);
    expect(keys(all)).toEqual(["p1", "c1a", "cluster:c1a", "c2a"]);
    const toggle = all[2] as FeedClusterEntry;
    expect(toggle).toMatchObject({ type: "cluster", clusterId: "c1a", size: 3, publishers: 2, expanded: false });
    // 대표 줄의 KST 날짜 묶음에 들어감(묶음 줄도 같은 날짜 묶음 안).
    expect(groups.map((group) => [group.date, keys(group.entries)])).toEqual([
      ["2026-11-14", ["p1"]],
      ["2026-11-13", ["c1a", "cluster:c1a"]],
      ["2026-11-12", ["c2a"]],
    ]);
    expect(feedClusterCount(sorted)).toBe(1);
  });

  it("펼치면 묶음 줄 아래 나머지 줄(최근순, member 표시) — 펼침은 묶음마다", () => {
    const all = feedEntryGroups(sorted, { grouped: true, expanded: new Set(["c1a"]) }).flatMap((group) => group.entries);
    expect(keys(all)).toEqual(["p1", "c1a", "cluster:c1a", "c1b", "c1c", "c2a"]);
    expect(all.filter((entry) => entry.type === "item" && entry.member).map((entry) => entry.key)).toEqual(["c1b", "c1c"]);
    expect((all[2] as FeedClusterEntry).expanded).toBe(true);
  });

  it("묶어 보기를 끄면 모든 줄을 지금처럼(묶음 줄 없음)", () => {
    const all = feedEntryGroups(sorted, { grouped: false, expanded: new Set(["c1a"]) }).flatMap((group) => group.entries);
    expect(keys(all)).toEqual(["p1", "c1b", "c1c", "c1a", "c2a"]);
    expect(all.every((entry) => entry.type === "item" && !entry.member)).toBe(true);
  });

  it("대표 줄이 보이지 않으면(기간·거르기) 보이는 줄 가운데 가장 이른 줄이 대표 — 건수·매체는 보이는 줄로 셈", () => {
    const all = feedEntryGroups([plain, second, third], { grouped: true, expanded: new Set() }).flatMap((group) => group.entries);
    expect(keys(all)).toEqual(["p1", "c1c", "cluster:c1a"]);
    expect(all[2]).toMatchObject({ size: 2, publishers: 2 });
  });

  it("보이는 줄이 묶음 전체면 서버의 매체 수, 일부면 보이는 줄의 서로 다른 매체(이름 → 없으면 도메인, 대소문자 무시), 모르면 null", () => {
    const partial = feedEntryGroups([second, lead], { grouped: true, expanded: new Set() }).flatMap((group) => group.entries);
    expect(partial.find((entry) => entry.type === "cluster")).toMatchObject({ size: 2, publishers: 2 });
    const unknown = [
      row({ id: "u2", clusterId: "u1", publisher: null, publisherDomain: null, publishedAt: "2026-11-13T02:00:00+00:00" }),
      row({ id: "u1", clusterId: "u1", cluster: { size: 3, publishers: 0 }, publisher: null, publisherDomain: null, publishedAt: "2026-11-13T01:00:00+00:00" }),
    ];
    expect(feedEntryGroups(unknown, { grouped: true, expanded: new Set() }).flatMap((group) => group.entries)[1]).toMatchObject({
      size: 2,
      publishers: null,
    });
    const sameName = [
      row({ id: "n2", clusterId: "n1", publisher: "ALPHA", publisherDomain: null, publishedAt: "2026-11-13T02:00:00+00:00" }),
      row({ id: "n1", clusterId: "n1", publisher: "alpha", publisherDomain: null, publishedAt: "2026-11-13T01:00:00+00:00" }),
    ];
    expect(feedEntryGroups(sameName, { grouped: true, expanded: new Set() }).flatMap((group) => group.entries)[1]).toMatchObject({ publishers: 1 });
  });

  const clusterOf = (items: readonly SearchFeedItem[], all?: readonly SearchFeedItem[]) =>
    feedEntryGroups(items, { grouped: true, expanded: new Set(), all })
      .flatMap((group) => group.entries)
      .find((entry): entry is FeedClusterEntry => entry.type === "cluster");

  it("보이는 줄이 묶음의 일부일 때 매체 수는 수집기 규칙(_publisher_count)과 같게 — MSN 꼬리 뗌·대소문자 무시, 이름 없는 줄의 도메인은 묶음 안 이름 하나에만 쓰였으면 그 매체", () => {
    // 수집기 시험(test_매체_수는_이름_대소문자_무시_또는_도메인으로_센다)과 같은 여섯 줄 — 대표 m0은 기간 밖이라 보이지 않음.
    const at = (hour: number) => `2026-11-13T0${hour}:00:00+00:00`;
    const rows = [
      row({ id: "m6", clusterId: "m0", publisher: "Other Wire", publisherDomain: null, publishedAt: at(6) }),
      row({ id: "m5", clusterId: "m0", publisher: null, publisherDomain: "other.example", publishedAt: at(5) }),
      row({ id: "m4", clusterId: "m0", publisher: null, publisherDomain: "reuters.example", publishedAt: at(4) }),
      row({ id: "m3", clusterId: "m0", publisher: "REUTERS on MSN", publisherDomain: "msn.example", publishedAt: at(3) }),
      row({ id: "m2", clusterId: "m0", publisher: "reuters", publisherDomain: "reuters.example", publishedAt: at(2) }),
      row({ id: "m1", clusterId: "m0", publisher: "Reuters", publisherDomain: "reuters.example", publishedAt: at(1) }),
    ];
    expect(clusterOf(rows)).toMatchObject({ size: 6, publishers: 3 });
    // 거르기로 한 줄이 빠져 보이는 줄이 묶음의 일부가 돼도 매체 수가 늘지 않음(대표 s1의 서버 값은 2곳).
    const lead = row({ id: "s1", clusterId: "s1", cluster: { size: 4, publishers: 2 }, publisher: "Reuters", publisherDomain: "reuters.example", publishedAt: at(1) });
    const msn = row({ id: "s2", clusterId: "s1", publisher: "Reuters on MSN", publisherDomain: "msn.example", publishedAt: at(2) });
    const bare = row({ id: "s3", clusterId: "s1", publisher: null, publisherDomain: "reuters.example", publishedAt: at(3) });
    const beta = row({ id: "s4", clusterId: "s1", publisher: "Beta", publisherDomain: "beta.example", publishedAt: at(4) });
    expect(clusterOf([beta, bare, msn, lead])).toMatchObject({ size: 4, publishers: 2 });
    expect(clusterOf([bare, msn, lead])).toMatchObject({ size: 3, publishers: 1 });
  });

  it("서버 대표 줄의 매체 수(묶음 전체)를 위 한도로 — 대표 줄이 거르기로 숨어도 거르기 전 줄(all)에서 찾음", () => {
    // 보이는 둘만으로는 이름 없는 줄(d.example)을 따로 셈(2곳)이지만, 묶음 전체에서 d.example은 Xpress 한 곳뿐(서버 1곳).
    const lead = row({ id: "x1", clusterId: "x1", cluster: { size: 3, publishers: 1 }, publisher: "Xpress", publisherDomain: "d.example", publishedAt: "2026-11-13T01:00:00+00:00" });
    const bare = row({ id: "x2", clusterId: "x1", publisher: null, publisherDomain: "d.example", publishedAt: "2026-11-13T02:00:00+00:00" });
    const other = row({ id: "x3", clusterId: "x1", publisher: "Xpress", publisherDomain: "e.example", publishedAt: "2026-11-13T03:00:00+00:00" });
    expect(clusterOf([other, bare])).toMatchObject({ size: 2, publishers: 2 });
    expect(clusterOf([other, bare], [other, bare, lead])).toMatchObject({ size: 2, publishers: 1 });
    // 서버 값을 모르면(0·없음) 보이는 줄로 센 값 그대로.
    const unknownLead = { ...lead, cluster: { size: 3, publishers: 0 } };
    expect(clusterOf([other, bare], [other, bare, unknownLead])).toMatchObject({ publishers: 2 });
  });

  it("묶음 줄의 글 — 건수·매체 수·펼치기/접기(매체 수를 모르면 그 칸 없이)", () => {
    expect(clusterToggleText({ size: 3, publishers: 2, expanded: false })).toBe("같은 사건 3건 · 매체 2곳 — 펼치기");
    expect(clusterToggleText({ size: 3, publishers: 2, expanded: true })).toBe("같은 사건 3건 · 매체 2곳 — 접기");
    expect(clusterToggleText({ size: 2, publishers: null, expanded: false })).toBe("같은 사건 2건 — 펼치기");
  });

  it("펼친 줄이 대표와 다른 KST 날짜면 날짜를 덧붙임(날짜만 아는 줄은 이미 날짜라 없음)", () => {
    expect(otherDateText(row({ publishedAt: "2026-11-13T20:00:00+00:00" }), "2026-11-13")).toBe("11-14");
    expect(otherDateText(row({ publishedAt: "2026-11-13T01:00:00+00:00" }), "2026-11-13")).toBeNull();
    expect(otherDateText(row({ publishedAt: "2026-11-13T20:00:00+00:00", timeBasis: "date" }), "2026-11-13")).toBeNull();
    expect(otherDateText(row({ publishedAt: null }), "2026-11-13")).toBeNull();
  });

  it("단계 5까지의 응답(칸 없음)은 묶음 없이 지금처럼", () => {
    const old = [row({ id: "o1" }), row({ id: "o2", publishedAt: "2026-11-13T00:30:00+00:00" })];
    expect(keys(feedEntryGroups(old, { grouped: true, expanded: new Set() }).flatMap((group) => group.entries))).toEqual(["o1", "o2"]);
    expect(feedClusterCount(old)).toBe(0);
  });
});

describe("연결 그림 배치(계약 §9-3)", () => {
  const link = (over: Partial<SearchLink>): SearchLink => ({ relation: "subsidiary", key: null, name: "X", kind: "company", source: "wikidata", detail: null, ...over });
  const many = (relation: string, count: number) => Array.from({ length: count }, (_, at) => link({ relation, name: `${relation}-${at}`, key: `wd:Q${at + 1}` }));

  it("크기 — 잰 폭(280~760, 모르면 360)에 맞추고 높이는 폭의 3/4(340~480)", () => {
    expect(linkGraphSize(0)).toEqual({ width: 360, height: 340 });
    expect(linkGraphSize(330)).toEqual({ width: 330, height: 340 });
    expect(linkGraphSize(560)).toEqual({ width: 560, height: 420 });
    expect(linkGraphSize(2000)).toEqual({ width: 760, height: 480 });
    expect(linkGraphSize(200)).toEqual({ width: 280, height: 340 });
  });

  it("최대 30개 — 관계 묶음마다 돌아가며 하나씩 골라 한 관계가 자리를 다 차지하지 않음, 나머지는 건수로", () => {
    const groups = linkGroups([...many("insider", 40), ...many("parent", 1), ...many("subsidiary", 5)]);
    const picked = graphLinks(groups, LINK_GRAPH_MAX);
    expect(LINK_GRAPH_MAX).toBe(30);
    expect(picked.groups.reduce((total, group) => total + group.links.length, 0)).toBe(30);
    expect(picked.hidden).toBe(16);
    expect(picked.groups.map((group) => [group.relation, group.links.length])).toEqual([
      ["insider", 24],
      ["parent", 1],
      ["subsidiary", 5],
    ]);
    // 묶음 안의 순서는 그대로(앞에서부터).
    expect(picked.groups[0].links.map((entry) => entry.name).slice(0, 3)).toEqual(["insider-0", "insider-1", "insider-2"]);
    expect(graphLinks(linkGroups(many("parent", 3)), LINK_GRAPH_MAX).hidden).toBe(0);
  });

  it("노드는 대상(가운데)을 둘러싼 타원 위 — 관계 묶음마다 이어진 부채꼴, 묶음 순서대로 시계 방향", () => {
    const groups = linkGroups([...many("subsidiary", 4), ...many("founded_by", 2), ...many("parent", 3)]);
    const layout = linkGraphLayout(groups, { width: 560, height: 420 });
    expect(layout.cx).toBe(280);
    expect(layout.cy).toBe(210);
    expect(layout.nodes.length).toBe(9);
    for (const node of layout.nodes) {
      const onEllipse = ((node.x - layout.cx) / layout.rx) ** 2 + ((node.y - layout.cy) / layout.ry) ** 2;
      expect(onEllipse).toBeCloseTo(1, 2);
    }
    // 부채꼴은 linkGroups의 순서(창업자 → 모회사 → 자회사)로 겹치지 않고 이어짐, 노드는 제 부채꼴 안.
    expect(layout.sectors.map((sector) => [sector.relation, sector.label, sector.count])).toEqual([
      ["founded_by", "창업자", 2],
      ["parent", "모회사", 3],
      ["subsidiary", "자회사", 4],
    ]);
    for (let at = 1; at < layout.sectors.length; at += 1) expect(layout.sectors[at].start).toBeGreaterThanOrEqual(layout.sectors[at - 1].end);
    expect(layout.sectors.at(-1)!.end - layout.sectors[0].start).toBeLessThanOrEqual(2 * Math.PI + 1e-9);
    for (const node of layout.nodes) {
      const sector = layout.sectors.find((entry) => entry.relation === node.relation)!;
      expect(node.angle).toBeGreaterThan(sector.start);
      expect(node.angle).toBeLessThan(sector.end);
    }
    expect(layout.nodes.map((node) => node.relation)).toEqual([
      "founded_by", "founded_by", "parent", "parent", "parent", "subsidiary", "subsidiary", "subsidiary", "subsidiary",
    ]);
    expect(layout.hidden).toBe(0);
  });

  it("노드의 낭독 이름 — 이름 · 관계(한국어), 키가 없으면 '이름으로 찾기'. 글은 폭에 맞춰 줄임(전체 이름은 낭독 이름에)", () => {
    const layout = linkGraphLayout(linkGroups([link({ name: "Jensen Huang", relation: "founded_by", key: null, kind: "person" }), link({ name: "Mellanox", key: "wd:Q100" })]), {
      width: 360,
      height: 340,
    });
    expect(layout.nodes.map((node) => node.ariaLabel)).toEqual(["Jensen Huang · 창업자 · 이름으로 찾기", "Mellanox · 자회사"]);
    expect(fitGraphLabel("가나다라마바사아자차카타파하", 84)).toBe("가나다라마바…");
    expect(fitGraphLabel("Mellanox", 84)).toBe("Mellanox");
    expect(fitGraphLabel("A VERY LONG LEGAL ENTITY NAME HOLDINGS", 84).endsWith("…")).toBe(true);
  });

  it("30개를 넘으면 30개만 그리고 숨긴 수를 돌려줌, 좁은 화면(330)에서도 모든 노드가 그림 안", () => {
    const layout = linkGraphLayout(linkGroups(many("insider", 45)), linkGraphSize(330));
    expect(layout.nodes.length).toBe(30);
    expect(layout.hidden).toBe(15);
    // 누르는 자리는 노드가 적으면 지름 44(반지름 22)까지, 많으면 이웃과 겹치지 않는 만큼으로 줄어듦(아래 시험).
    expect(layout.hitRadius).toBeLessThan(22);
    expect(linkGraphLayout(linkGroups(many("parent", 2)), linkGraphSize(330)).hitRadius).toBe(22);
    for (const node of layout.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.x).toBeLessThanOrEqual(layout.width);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it("노드는 오른쪽·왼쪽 호에만(위아래 끝에 몰려 이름이 겹치지 않게) — 이름은 바깥쪽으로 뻗음, 노드가 적으면 좌우 한가운데", () => {
    const layout = linkGraphLayout(linkGroups(many("insider", 30)), linkGraphSize(330));
    for (const node of layout.nodes) {
      const cos = Math.cos(node.angle);
      expect(Math.abs(cos)).toBeGreaterThan(Math.cos((66 * Math.PI) / 180));
      expect(node.anchor).toBe(cos >= 0 ? "start" : "end");
      expect(node.anchor === "start" ? node.labelX > node.x : node.labelX < node.x).toBe(true);
    }
    // 같은 쪽 이웃 노드의 세로 간격은 12px 글자가 겹치지 않을 만큼.
    const right = layout.nodes.filter((node) => node.anchor === "start").map((node) => node.y);
    for (let at = 1; at < right.length; at += 1) expect(right[at] - right[at - 1]).toBeGreaterThanOrEqual(13);
    const two = linkGraphLayout(linkGroups([...many("subsidiary", 1), ...many("founded_by", 1)]), { width: 600, height: 450 });
    expect(two.nodes.map((node) => [node.x, node.y])).toEqual([
      [two.cx + two.rx, two.cy],
      [two.cx - two.rx, two.cy],
    ]);
  });

  it("누르는 자리는 어느 두 노드 사이에서도 겹치지 않음(지름 ≤ 거리) — 좁은 화면에 노드 30개여도", () => {
    const mixes = [
      linkGroups(many("insider", 45)),
      linkGroups([...many("founded_by", 1), ...many("ultimate_parent", 1), ...many("parent", 1), ...many("insider", 20), ...many("subsidiary", 1)]),
    ];
    for (const groups of mixes) {
      for (const width of [280, 330, 390, 600]) {
        const layout = linkGraphLayout(groups, linkGraphSize(width));
        expect(layout.hitRadius).toBeGreaterThan(0);
        for (let a = 0; a < layout.nodes.length; a += 1) {
          for (let b = a + 1; b < layout.nodes.length; b += 1) {
            const distance = Math.hypot(layout.nodes[a].x - layout.nodes[b].x, layout.nodes[a].y - layout.nodes[b].y);
            expect(2 * layout.hitRadius).toBeLessThanOrEqual(distance);
          }
        }
      }
    }
  });

  /** 노드가 오른쪽 호(true)인가 왼쪽 호(false)인가. */
  const sideOf = (layout: ReturnType<typeof linkGraphLayout>, relation: string) =>
    new Set(layout.nodes.filter((node) => node.relation === relation).map((node) => node.anchor === "start"));

  it("관계 묶음은 통째로 한쪽 호에 — 노드 간격이 넉넉하면 묶음 단위로 좌우를 나누고, 관계 글은 관계마다 하나", () => {
    for (const width of [330, 600]) {
      const layout = linkGraphLayout(linkGroups([...many("parent", 3), ...many("subsidiary", 6)]), linkGraphSize(width));
      expect(sideOf(layout, "parent").size).toBe(1);
      expect(sideOf(layout, "subsidiary").size).toBe(1);
      expect(layout.tags.map((tag) => tag.relation).sort()).toEqual(["parent", "subsidiary"]);
    }
  });

  it("한 묶음이 한쪽 호에 다 들지 않아 쪼개면(노드 간격) 이어진 호마다 그 관계 글 — 다른 관계의 글 옆에 관계 글 없는 노드가 남지 않음", () => {
    const groups = linkGroups([
      ...many("founded_by", 1), ...many("ultimate_parent", 1), ...many("parent", 1), ...many("insider", 20), ...many("subsidiary", 1),
    ]);
    for (const width of [330, 390, 600]) {
      const layout = linkGraphLayout(groups, linkGraphSize(width), { centerName: "엔비디아" });
      for (const sector of layout.sectors) {
        const sides = sideOf(layout, sector.relation);
        const tagSides = new Set(layout.tags.filter((tag) => tag.relation === sector.relation).map((tag) => tag.side === "right"));
        expect(tagSides).toEqual(sides);
      }
      // 쪼갠 것은 많아야 한 묶음(내부자 20).
      expect(layout.tags.length).toBeLessThanOrEqual(layout.sectors.length + 1);
      expect(sideOf(layout, "insider").size).toBe(2);
    }
    // 하나뿐인 관계(내부자 30)도 양쪽 호에 나뉘면 양쪽에 관계 글.
    const single = linkGraphLayout(linkGroups(many("insider", 30)), linkGraphSize(330));
    expect(single.tags.map((tag) => [tag.relation, tag.side])).toEqual([
      ["insider", "right"],
      ["insider", "left"],
    ]);
  });

  it("관계 글은 가운데 대상 상자와 겹치지 않고, 같은 쪽 관계 글끼리는 세로로 비켜 둠", () => {
    const groups = linkGroups([
      ...many("founded_by", 1), ...many("ultimate_parent", 1), ...many("parent", 1), ...many("insider", 20), ...many("subsidiary", 1),
    ]);
    for (const width of [330, 600]) {
      const layout = linkGraphLayout(groups, linkGraphSize(width), { centerName: "엔비디아" });
      expect(layout.center.label).toBe("엔비디아");
      for (const tag of layout.tags) {
        const clearX = Math.abs(tag.x - layout.cx) >= layout.center.width / 2 + tag.width / 2;
        const clearY = Math.abs(tag.y - layout.cy) >= layout.center.height / 2 + 8;
        expect(clearX || clearY).toBe(true);
      }
      for (const side of ["right", "left"]) {
        const ys = layout.tags
          .filter((tag) => tag.side === side)
          .map((tag) => tag.y)
          .sort((a, b) => a - b);
        for (let at = 1; at < ys.length; at += 1) expect(ys[at] - ys[at - 1]).toBeGreaterThanOrEqual(16);
      }
    }
    // 노드가 좌우 한가운데 둘뿐이면(선이 가로) 관계 글은 선 위에 자리가 있으면 그대로, 없으면(좁은 화면) 선 옆으로 — 노드 원·가운데 상자에 닿지 않음.
    for (const width of [330, 600]) {
      const two = linkGraphLayout(linkGroups([...many("subsidiary", 1), ...many("founded_by", 1)]), linkGraphSize(width), { centerName: "엔비디아" });
      for (const tag of two.tags) {
        const node = two.nodes.find((entry) => entry.relation === tag.relation)!;
        const awayX = Math.abs(tag.x - node.x) >= tag.width / 2 + 4 + 6;
        const awayY = Math.abs(tag.y - node.y) >= 8 + 6;
        expect(awayX || awayY).toBe(true);
        const clearCenterX = Math.abs(tag.x - two.cx) >= two.center.width / 2 + tag.width / 2 + 4;
        const clearCenterY = Math.abs(tag.y - two.cy) >= two.center.height / 2 + 8;
        expect(clearCenterX || clearCenterY).toBe(true);
      }
    }
  });

  it("그린 세로 범위만 뷰로 — 노드가 둘이면 낮은 그림, 많으면 거의 전체", () => {
    const two = linkGraphLayout(linkGroups([...many("subsidiary", 1), ...many("founded_by", 1)]), { width: 600, height: 450 });
    expect(two.view.height).toBeLessThan(120);
    expect(two.view.y).toBeGreaterThan(0);
    const full = linkGraphLayout(linkGroups(many("insider", 30)), { width: 600, height: 450 });
    expect(full.view.height).toBeGreaterThan(380);
    for (const node of full.nodes) {
      expect(node.y).toBeGreaterThanOrEqual(full.view.y);
      expect(node.y).toBeLessThanOrEqual(full.view.y + full.view.height);
    }
  });

  it("연결이 없으면 노드·부채꼴 없음", () => {
    const layout = linkGraphLayout([], { width: 360, height: 340 });
    expect(layout.nodes).toEqual([]);
    expect(layout.sectors).toEqual([]);
    expect(layout.tags).toEqual([]);
  });
});
