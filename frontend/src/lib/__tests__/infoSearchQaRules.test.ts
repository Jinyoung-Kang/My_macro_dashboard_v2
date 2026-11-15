/**
 * 정보 검색 같은 사건 묶음의 매체 수(계약 §9-2·§9-7)의 QA 결함 재현·고정 시험(QA-442).
 *
 * 수집기 search_rules._publisher_count·publisher_key(규칙 원본)와 같은 고정본 `collector/tests/fixtures/search/publisher_keys.json`을 읽어,
 * 보이는 줄이 묶음의 일부일 때 화면이 세는 매체 수(publisherCount)와 매체 키(publisherKey)가 수집기와 같은지 봅니다. 매체 이름은 모두 합성
 * 값입니다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { feedEntryGroups, publisherKey, type FeedClusterEntry } from "@/lib/infoSearch";
import type { SearchFeedItem } from "@/lib/types";

type PublisherCase = { about: string; rows: [string | null, string | null][]; publishers: number };
type Shared = { keys: [string | null, string][]; sameOutlet: PublisherCase[]; distinctOutlets: PublisherCase[] };

const shared: Shared = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../collector/tests/fixtures/search/publisher_keys.json"), "utf8"),
);

/** 고정본의 줄 → 한 묶음(대표 줄 c0에 서버 값이 없어 화면이 보이는 줄로 셈) → 묶음 줄의 매체 수. */
function counted(rows: PublisherCase["rows"]): number | null {
  const items: SearchFeedItem[] = rows
    .map(([publisher, publisherDomain], n): SearchFeedItem => ({
      id: `c${n}`, kind: "news", title: "SynthChip recalls accelerator boards", url: `https://news.example/c${n}`, publisher, publisherDomain,
      publishedAt: `2026-11-13T${String(n + 1).padStart(2, "0")}:00:00+00:00`, timeBasis: "published", source: "bing", lang: "en",
      summary: null, readerId: null, clusterId: "c0", cluster: null,
    }))
    .reverse();
  const entry = feedEntryGroups(items, { grouped: true, expanded: new Set() })
    .flatMap((group) => group.entries)
    .find((candidate): candidate is FeedClusterEntry => candidate.type === "cluster");
  expect(entry?.size).toBe(rows.length);
  return entry?.publishers ?? null;
}

describe("같은 사건 묶음의 매체 수 — 수집기와 같은 고정본(QA-442)", () => {
  // QA-442: 같은 매체의 다른 표기('www.…com'·붙여 쓴 이름·꼬리 'Media')를 다른 매체로 셈. 수정 전 실패: 6곳(기대 3곳)·2곳(기대 1곳)
  // (재현 커밋에서는 it.fails).
  it("같은 매체의 다른 표기는 한 곳으로 센다", () => {
    for (const sample of shared.sameOutlet) expect(counted(sample.rows), sample.about).toBe(sample.publishers);
  });

  it("서로 다른 매체는 그대로 따로 센다", () => {
    for (const sample of shared.distinctOutlets) expect(counted(sample.rows), sample.about).toBe(sample.publishers);
  });

  it("매체 세기 키는 수집기(publisher_key)와 같은 고정본대로", () => {
    for (const [name, key] of shared.keys) expect(publisherKey(name), String(name)).toBe(key);
  });
});
