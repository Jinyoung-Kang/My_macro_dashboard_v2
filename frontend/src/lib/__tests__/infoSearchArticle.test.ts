/**
 * 정보 검색 본문 보기(ADR 0043)의 순수 함수 — 어느 줄에 '본문 보기'가 붙나(운영자만), 사실 줄(모르는 값은 줄째 뺌·KST 시각), 표지, 사유 글, 번역 단추.
 * 값은 모두 합성 표본입니다(실제 기사 글을 쓰지 않음).
 */
import { describe, expect, it } from "vitest";
import {
  articleActionOf,
  articleFacts,
  articleFlags,
  articleNeedsTranslation,
  articlePreviewNote,
  articleReasonText,
} from "@/lib/infoSearch";
import type { SearchArticle } from "@/lib/types";

const REF = "0123456789abcdef0123456789abcdef";

function article(over: Partial<SearchArticle> = {}): SearchArticle {
  return {
    title: "Synthetic Widgets revenue rises", siteName: "Example Ledger", author: "Jane Placeholder", publishedDate: "2026-11-15",
    lang: "en", paragraphs: ["First synthetic paragraph.", "Second synthetic paragraph."], chars: 54, totalChars: 54, truncated: false,
    short: false, paywalled: false, sourceUrl: "https://news.example.com/a", sourceHost: "news.example.com", viaGoogle: false,
    fetchedAt: "2026-11-17T03:05:00+00:00", cached: false, ...over,
  };
}

describe("articleActionOf — 어느 줄에 '본문 보기'가 붙나", () => {
  it("운영자: 수집 글은 받아 둔 원문(stored), 꼬리표가 있으면 받기(fetch), 까닭이 있으면 단추 없이 그 글", () => {
    expect(articleActionOf({ readerId: "r1", bodyRef: null, bodyNote: null }, true)).toEqual({ mode: "stored" });
    expect(articleActionOf({ readerId: null, bodyRef: REF, bodyNote: null }, true)).toEqual({ mode: "fetch", ref: REF });
    expect(articleActionOf({ readerId: null, bodyRef: null, bodyNote: "네이버 글은 받지 않습니다" }, true))
      .toEqual({ mode: "none", note: "네이버 글은 받지 않습니다" });
    expect(articleActionOf({ readerId: null, bodyRef: null, bodyNote: null }, true)).toEqual({ mode: "none", note: null });
    expect(articleActionOf({ readerId: null }, true)).toEqual({ mode: "none", note: null });
  });

  it("수집 글이 꼬리표보다 먼저이고, 모양이 틀린 꼬리표는 받지 않는다", () => {
    expect(articleActionOf({ readerId: "r1", bodyRef: REF, bodyNote: null }, true)).toEqual({ mode: "stored" });
    expect(articleActionOf({ readerId: null, bodyRef: "../../etc", bodyNote: null }, true)).toEqual({ mode: "none", note: null });
    expect(articleActionOf({ readerId: null, bodyRef: REF.toUpperCase(), bodyNote: null }, true)).toEqual({ mode: "none", note: null });
  });

  it("회원·데모(owner 거짓)에게는 늘 없음", () => {
    expect(articleActionOf({ readerId: "r1", bodyRef: REF, bodyNote: "x" }, false)).toEqual({ mode: "none", note: null });
  });

  it("미리 보기 안내 글", () => {
    expect(articlePreviewNote({ mode: "fetch", ref: REF })).toContain("저장하지 않습니다");
    expect(articlePreviewNote({ mode: "stored" })).toContain("받아 둔 글");
    expect(articlePreviewNote({ mode: "none", note: null })).toBe("기사 본문은 받지 않습니다 — 제목·매체·시각·요약만입니다.");
  });
});

describe("articleFacts — 사실 줄", () => {
  it("매체·글쓴이·글에 적힌 날짜·받은 시각(KST)", () => {
    expect(articleFacts(article(), { publisher: "Row Publisher", publisherDomain: "row.example" })).toEqual([
      ["매체", "Example Ledger"],
      ["글쓴이", "Jane Placeholder"],
      ["글에 적힌 날짜", "2026-11-15"],
      ["받은 시각", "2026-11-17 12:05 KST"],
    ]);
  });

  it("모르는 값은 줄째 빼고(—를 두지 않음), 매체는 결과 줄의 것으로 대신, 받아 둔 것·구글 경유를 적는다", () => {
    const rows = articleFacts(article({ siteName: null, author: null, publishedDate: null, cached: true, viaGoogle: true }),
      { publisher: "Row Publisher", publisherDomain: "row.example" });
    expect(rows).toEqual([
      ["매체", "Row Publisher"],
      ["받은 시각", "2026-11-17 12:05 KST (받아 둔 것 — 서버 메모리 24시간)"],
      ["찾은 길", "구글 경유 주소를 풀어 찾은 원문 주소"],
    ]);
    expect(articleFacts(article({ siteName: null, publishedDate: "Nov 15", fetchedAt: null }), { publisher: null, publisherDomain: null }))
      .toEqual([["글쓴이", "Jane Placeholder"]]);
  });
});

describe("articleFlags·articleReasonText·articleNeedsTranslation", () => {
  it("표지 — 잘림(전체 글자 수)·짧음·유료 표시", () => {
    expect(articleFlags(article())).toEqual([]);
    expect(articleFlags(article({ truncated: true, totalChars: 52_345, short: true, paywalled: true }))).toEqual([
      "글이 길어 앞 40,000자만 보입니다(전체 52,345자).",
      "추린 글이 짧습니다 — 유료·로그인 글이거나 본문이 그림·영상일 수 있습니다.",
      "유료 글 표시가 있어 공개된 앞부분만일 수 있습니다.",
    ]);
  });

  it("사유 글 — 서버 글이 먼저, 없으면 코드마다 글, 모르는 코드는 일반 글, 닿지 못함은 수집기 글", () => {
    expect(articleReasonText({ reason: "blocked", message: "news.example.com가 요청을 거부했습니다(HTTP 403)" }))
      .toBe("news.example.com가 요청을 거부했습니다(HTTP 403)");
    for (const reason of ["server_only", "offline", "user_limit", "unknown_ref", "refused_host", "relay_unresolved", "unsafe_address",
      "bad_redirect", "blocked", "budget", "queue_full", "timeout", "transport", "too_large", "not_html", "http_error", "no_body"]) {
      const text = articleReasonText({ reason, message: null });
      expect(text, reason).not.toBe("본문을 받지 못했습니다.");
      expect(text.length, reason).toBeGreaterThan(5);
    }
    expect(articleReasonText({ reason: "something_new", message: null })).toBe("본문을 받지 못했습니다.");
    expect(articleReasonText({ available: false, reason: null, message: null })).toBe("수집기에서 응답을 받지 못했습니다.");
    expect(articleReasonText({ reason: "server_only", message: null })).toContain("운영 서버에서만");
  });

  it("번역 단추 — 한국어 글에는 없고, 영어·언어를 모르는 영어 글에는 있다", () => {
    expect(articleNeedsTranslation(article())).toBe(true);
    expect(articleNeedsTranslation(article({ lang: "ko", paragraphs: ["합성 한국어 문단입니다."] }))).toBe(false);
    expect(articleNeedsTranslation(article({ lang: null, paragraphs: ["합성 한국어 문단입니다. Some words."] }))).toBe(false);
    expect(articleNeedsTranslation(article({ lang: null }))).toBe(true);
    expect(articleNeedsTranslation(article({ lang: null, paragraphs: ["12345"] }))).toBe(false);
  });
});
