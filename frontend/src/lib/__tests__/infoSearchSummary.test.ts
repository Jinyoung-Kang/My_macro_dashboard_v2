/**
 * 정보 검색 단계 6 묶음 3(계약 §9-6)의 화면 규칙 — AI 요약(운영자 전용). 머리 안내 글(받은 자료 n건), 서버가 준 요약 줄 다듬기(글이 있는 줄만,
 * 근거는 글 id만·겹친 것은 하나로), 근거를 지금 목록과 맞추기(갈 수 있는 줄·목록 밖 줄·받은 자료에 없는 근거 건수), 모델·만든 시각(KST) 한 줄,
 * 빈 요약·실패 글, 패널을 비우는 열쇠(대상·탭·기간). 표본은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import {
  SUMMARY_LABEL,
  summaryEmptyText,
  summaryErrorText,
  summaryLinesOf,
  summaryMetaText,
  summaryNoteText,
  summaryOfflineText,
  summaryRefs,
  summaryRequestKey,
  summaryUnavailableText,
} from "@/lib/infoSearch";
import type { SearchFeedItem } from "@/lib/types";

function row(over: Partial<SearchFeedItem>): SearchFeedItem {
  return {
    id: "r", kind: "news", title: "합성 기사", url: "https://news.example/a", publisher: "Example Wire", publisherDomain: "news.example",
    publishedAt: "2026-11-14T00:30:00+00:00", timeBasis: "published", source: "google_en", lang: "en", summary: null, readerId: null,
    clusterId: null, cluster: null, ...over,
  };
}

describe("머리 안내(summaryNoteText)", () => {
  it("서버가 읽은 줄 수(basedOn)를 그대로 — 계약 §9-6의 글", () => {
    expect(summaryNoteText(12)).toBe("AI 요약 — 받은 자료 12건의 제목·요약만 보고 만든 것, 원문 확인 필요");
    expect(summaryNoteText(0)).toBe("AI 요약 — 받은 자료 0건의 제목·요약만 보고 만든 것, 원문 확인 필요");
  });

  it("모르면 건수 없이(0으로 채우지 않음) — null·음수·숫자가 아닌 값", () => {
    const unknown = "AI 요약 — 받은 자료의 제목·요약만 보고 만든 것, 원문 확인 필요";
    expect(summaryNoteText(null)).toBe(unknown);
    expect(summaryNoteText(undefined)).toBe(unknown);
    expect(summaryNoteText(-1)).toBe(unknown);
    expect(summaryNoteText(Number.NaN)).toBe(unknown);
    expect(summaryNoteText("3" as unknown as number)).toBe(unknown);
  });

  it("단추 이름은 '요약'", () => {
    expect(SUMMARY_LABEL).toBe("요약");
  });
});

describe("요약에 들지 않은 출처(summaryOfflineText)", () => {
  it("서버가 받아 둔 결과가 없어 뺀 출처(offlineSources)를 출처 이름으로 한 줄에 — 없으면 null", () => {
    expect(summaryOfflineText({ offlineSources: ["google_en", "bing"] })).toBe(
      "요약에 들지 않은 출처: 구글 뉴스(영어)·Bing 뉴스 — 받은 지 15분이 지나 서버에 남아 있지 않음, 새로 받은 뒤 다시 요약하면 들어갑니다.",
    );
    expect(summaryOfflineText({ offlineSources: [] })).toBeNull();
    expect(summaryOfflineText({})).toBeNull();
    expect(summaryOfflineText({ offlineSources: ["", "  "] })).toBeNull();
  });
});

describe("요약 줄 다듬기(summaryLinesOf)", () => {
  it("글이 있는 줄만, 앞뒤 공백을 떼고 근거는 글 id만 — 겹친 근거는 처음 것 하나(받은 순서)", () => {
    const lines = summaryLinesOf({
      summary: [
        { text: "  첫 줄 요약  ", refs: ["a", "b", "a", "", 7 as unknown as string] },
        { text: "   ", refs: ["c"] },
        { text: "근거 없는 줄", refs: [] },
        { text: "근거 칸이 틀린 줄", refs: "a" as unknown as string[] },
        null as unknown as { text: string; refs: string[] },
        { text: 3 as unknown as string, refs: ["d"] },
      ],
    });
    expect(lines).toEqual([
      { text: "첫 줄 요약", refs: ["a", "b"] },
      { text: "근거 없는 줄", refs: [] },
      { text: "근거 칸이 틀린 줄", refs: [] },
    ]);
  });

  it("칸이 없거나 배열이 아니면 빈 목록", () => {
    expect(summaryLinesOf(null)).toEqual([]);
    expect(summaryLinesOf({})).toEqual([]);
    expect(summaryLinesOf({ summary: null })).toEqual([]);
    expect(summaryLinesOf({ summary: "요약" as unknown as [] })).toEqual([]);
  });
});

describe("근거를 지금 목록과 맞추기(summaryRefs)", () => {
  const items = [row({ id: "a", title: "가 기사" }), row({ id: "b", title: "나 기사" }), row({ id: "c", title: "다 기사" })];

  it("받은 자료에 있는 줄은 제목과 함께 받은 순서로, 지금 목록에서 갈 수 있는지(reachable)를 붙임", () => {
    const view = summaryRefs(["b", "a", "c"], items, new Set(["a", "b"]));
    expect(view.refs).toEqual([
      { id: "b", title: "나 기사", reachable: true },
      { id: "a", title: "가 기사", reachable: true },
      { id: "c", title: "다 기사", reachable: false },
    ]);
    expect(view.missing).toBe(0);
  });

  it("받은 자료에 없는 근거는 줄로 만들지 않고 건수만(서버가 읽은 저장본과 지금 화면의 묶음이 다를 수 있음)", () => {
    const view = summaryRefs(["zz", "a", "yy"], items, new Set(["a"]));
    expect(view.refs).toEqual([{ id: "a", title: "가 기사", reachable: true }]);
    expect(view.missing).toBe(2);
  });

  it("갈 수 있다고 해도 받은 자료에 없으면 건수(목록이 아직 바뀌기 전)", () => {
    expect(summaryRefs(["q"], items, new Set(["q"]))).toEqual({ refs: [], missing: 1 });
  });
});

describe("모델·만든 시각(summaryMetaText)", () => {
  it("모델 이름과 만든 시각(KST)", () => {
    expect(summaryMetaText({ model: "synthetic-model-1", generatedAt: "2026-11-14T01:05:00+00:00" })).toBe(
      "모델 synthetic-model-1 · 만든 시각 2026-11-14 10:05 KST",
    );
  });

  it("모르는 칸은 뺌, 둘 다 모르면 null", () => {
    expect(summaryMetaText({ model: null, generatedAt: "2026-11-14T01:05:00+00:00" })).toBe("만든 시각 2026-11-14 10:05 KST");
    expect(summaryMetaText({ model: "synthetic-model-1", generatedAt: null })).toBe("모델 synthetic-model-1");
    expect(summaryMetaText({ model: "  ", generatedAt: "" })).toBeNull();
    expect(summaryMetaText({})).toBeNull();
  });
});

describe("빈 요약·실패 글", () => {
  it("서버가 읽은 줄이 0건이면 그렇다고, 그 밖에 줄이 없으면 받지 못했다고", () => {
    expect(summaryEmptyText({ basedOn: 0 })).toBe("고른 기간에 받아 둔 자료가 없어 요약하지 않았습니다.");
    expect(summaryEmptyText({ basedOn: 5 })).toBe("요약 줄을 받지 못했습니다.");
    expect(summaryEmptyText({})).toBe("요약 줄을 받지 못했습니다.");
  });

  it("수집기·엔진에 닿지 못한 응답(available:false)은 서버 사유, 없으면 기본 글", () => {
    expect(summaryUnavailableText({ available: false, message: "오늘 AI 글자 상한을 다 썼습니다." })).toBe(
      "요약하지 못했습니다 — 오늘 AI 글자 상한을 다 썼습니다.",
    );
    expect(summaryUnavailableText({ available: false })).toBe("요약하지 못했습니다.");
    expect(summaryUnavailableText({ available: false, message: "  " })).toBe("요약하지 못했습니다.");
  });

  it("요청 실패 — 서버 사유는 그대로, 권한(403)은 사유가 없으면 '이 계정으로는 할 수 없습니다'", () => {
    class FakeApiError extends Error {
      constructor(
        message: string,
        readonly status: number,
      ) {
        super(message);
      }
    }
    expect(summaryErrorText(new FakeApiError("요청 실패 (HTTP 403)", 403))).toBe("요약하지 못했습니다 — 이 계정으로는 할 수 없습니다");
    expect(summaryErrorText(new FakeApiError("하루 상한을 넘었습니다", 429))).toBe("요약하지 못했습니다 — 하루 상한을 넘었습니다");
    expect(summaryErrorText(new Error("네트워크 오류"))).toBe("요약하지 못했습니다 — 네트워크 오류");
    expect(summaryErrorText("이상한 값")).toBe("요약하지 못했습니다 — 알 수 없는 오류");
  });
});

describe("패널을 비우는 열쇠(summaryRequestKey)", () => {
  it("대상·탭·기간 가운데 하나라도 바뀌면 다른 열쇠 — 키 안의 구분 글자가 섞여도 겹치지 않음", () => {
    const base = summaryRequestKey({ e: "us:SYNT", tab: "timeline", range: "30d" });
    expect(summaryRequestKey({ e: "us:SYNT", tab: "timeline", range: "30d" })).toBe(base);
    expect(summaryRequestKey({ e: "us:SYNT", tab: "news", range: "30d" })).not.toBe(base);
    expect(summaryRequestKey({ e: "us:SYNT", tab: "timeline", range: "7d" })).not.toBe(base);
    expect(summaryRequestKey({ e: "kr:000001", tab: "timeline", range: "30d" })).not.toBe(base);
    expect(summaryRequestKey({ e: "topic:a|b", tab: "news", range: "7d" })).not.toBe(summaryRequestKey({ e: "topic:a", tab: "b|news" as never, range: "7d" }));
  });
});
