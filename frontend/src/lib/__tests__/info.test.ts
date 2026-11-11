/**
 * 정보 수집(ADR 0035)의 순수 규칙 — 안내 띠에 보일 사건, 출처 상태 글·색, 글 제목·시각, 네이버 금액(없으면 '—'), 거장 점수,
 * 원문 팝업에 여는 글과 번역 단추를 낼 조건(ADR 0037).
 */
import { describe, expect, it } from "vitest";
import {
  type InfoIncident,
  bannerText,
  bodyLabel,
  canTranslate,
  eokText,
  hasHangul,
  itemTime,
  itemTitles,
  kstMinute,
  parseInfoTab,
  rankingBasis,
  readerOfHeadline,
  readerOfItem,
  scoreText,
  sharesText,
  splitText,
  stanceTone,
  statusLabel,
  statusTone,
  titleNeedsTranslation,
  unseenIncidents,
} from "../info";

const incident = (task: string, label: string, kind: InfoIncident["kind"] = "blocked"): InfoIncident => ({
  key: `${task}|${kind}`, task, label, kind, kindLabel: kind === "blocked" ? "차단됨 — 그 출처만 잠시 멈춤" : "형식 바뀜",
  reason: "사유", since: "2026-11-11 18:00:00 KST",
});

describe("안내 띠", () => {
  it("닫은 사건은 빼고, 닫은 뒤 새로 생긴 사건은 보인다", () => {
    const all = [incident("a", "Wolf Street"), incident("b", "waedge 시장", "format")];
    expect(unseenIncidents(all, ["a|blocked"]).map((i) => i.key)).toEqual(["b|format"]);
    expect(unseenIncidents(all, [])).toHaveLength(2);
  });

  it("한 줄에 셋까지 이름을 적고 나머지는 '외 N곳'", () => {
    const four = ["A", "B", "C", "D"].map((label) => incident(label, label));
    expect(bannerText(four)).toBe(
      "수집 출처 4곳이 끊겼습니다: A(차단됨 — 그 출처만 잠시 멈춤) · B(차단됨 — 그 출처만 잠시 멈춤) · C(차단됨 — 그 출처만 잠시 멈춤) 외 1곳",
    );
  });
});

describe("출처 상태", () => {
  it("사건이 있으면 사건의 종류, 판정만 있으면 판정, 기록이 없으면 '기록 없음'", () => {
    expect(statusLabel({ status: "ok", incident: null })).toBe("정상");
    expect(statusLabel({ status: "format", incident: null })).toBe("형식 바뀜");
    expect(statusLabel({ status: "ok", incident: { ...incident("a", "A"), kind: "stale", kindLabel: "오래 못 받음" } })).toBe("오래 못 받음");
    expect(statusLabel({ status: null, incident: null })).toBe("기록 없음");
  });

  it("차단·형식 바뀜 사건은 위험, 그 밖의 사건과 한 번의 형식 바뀜은 주의, 정상은 ok", () => {
    expect(statusTone({ status: "blocked", incident: incident("a", "A") })).toBe("danger");
    expect(statusTone({ status: "failed", incident: { ...incident("a", "A"), kind: "failed" } })).toBe("warn");
    expect(statusTone({ status: "format", incident: null })).toBe("warn");
    expect(statusTone({ status: "ok", incident: null })).toBe("ok");
    expect(statusTone({ status: null, incident: null })).toBe("neutral");
  });
});

describe("글", () => {
  it("제목은 원문 그대로 위에, 출처가 붙인 한국어 제목은 아래에 — 번역 단추는 한글이 없고 한국어 제목도 없는 제목에만", () => {
    expect(itemTitles({ title: "Rates Spike", titleKo: "금리 급등" })).toEqual({ primary: "Rates Spike", secondary: "금리 급등" });
    expect(titleNeedsTranslation("Rates Spike")).toBe(true);
    expect(titleNeedsTranslation("Rates Spike", "금리 급등")).toBe(false);
    expect(titleNeedsTranslation("금리 급등")).toBe(false);
    expect(titleNeedsTranslation("2026-11-11 +3.5%")).toBe(false);
    expect(titleNeedsTranslation(null)).toBe(false);
    expect(titleNeedsTranslation("—")).toBe(false);
    expect(itemTitles({ title: "Rates Spike", titleKo: null })).toEqual({ primary: "Rates Spike", secondary: null });
  });

  it("작성 시각을 모르면 받은 시각에 '받음'을 붙인다(작성 시각으로 꾸미지 않음)", () => {
    expect(itemTime({ publishedAt: "2026-11-11 14:30:59 KST", firstSeenAt: "2026-11-11 15:00:00 KST" })).toBe("2026-11-11 14:30 KST");
    expect(itemTime({ publishedAt: null, firstSeenAt: "2026-11-11 15:00:00 KST" })).toBe("2026-11-11 15:00 KST 받음");
    expect(kstMinute("2026-11-11 04:00:00 KST")).toBe("2026-11-11 04:00 KST");
    expect(kstMinute(null)).toBe("—");
  });

  it("본문 판정 글", () => {
    expect([bodyLabel("full"), bodyLabel("partial"), bodyLabel("none")]).toEqual(["본문", "요약만", "제목만"]);
  });

  it("정보 수집 탭 주소 — 아는 조각만, 모르면 null(주소는 404)", () => {
    expect(parseInfoTab("mechanism")).toBe("mechanism");
    expect(parseInfoTab("status")).toBe("status");
    expect(parseInfoTab("sources")).toBeNull();
    expect(parseInfoTab(null)).toBeNull();
  });
});

describe("네이버 수급", () => {
  it("금액이 없으면 '—'(0원이 아님), 있으면 부호와 억", () => {
    expect(eokText(null)).toBe("—");
    expect(eokText(1661.6)).toBe("+1,661.6억");
    expect(eokText(-500)).toBe("-500.0억");
    expect(sharesText(-873324)).toBe("-873,324주");
    expect(sharesText(null)).toBe("—");
  });

  it("순위 기준 — 장중 추정은 금액이 없다고, 확정은 기간을, 받지 못했으면 이전 값이라고", () => {
    const base = { buy: [], sell: [], period: { from: "2026-11-11", to: "2026-11-11" }, rankedAt: null };
    expect(rankingBasis({ ...base, estimated: true, rankedAt: "2026-11-11T16:44:10+09:00" }))
      .toBe("장중 추정 — 금액 없음(주식 수) · 2026-11-11 16:44 KST");
    expect(rankingBasis({ ...base, estimated: false, period: { from: "2026-11-04", to: "2026-11-10" } })).toBe("확정 · 2026-11-04~2026-11-10");
    expect(rankingBasis({ ...base, estimated: false, isStale: true })).toBe("확정 · 2026-11-11 · 이번에 받지 못해 이전 값");
    expect(rankingBasis(undefined)).toBe("받은 순위 없음");
  });
});

describe("거장", () => {
  it("점수·나눔 글과 견해 색", () => {
    expect(scoreText(95)).toBe("+95");
    expect(scoreText(null)).toBe("—");
    expect(splitText({ bull: 95, neutral: 5, bear: 0 })).toBe("강세 95 · 중립 5 · 약세 0");
    expect(splitText({ bull: 95, neutral: null, bear: 0 })).toBe("—");
    expect([stanceTone("강세"), stanceTone("약세"), stanceTone("중립"), stanceTone(null)]).toEqual(["ok", "danger", "neutral", "neutral"]);
  });
});

describe("원문 팝업(ADR 0037)", () => {
  const item = {
    id: "0123456789abcdef01234567", source: "blog.wolfstreet", sourceLabel: "Wolf Street", kind: "article" as const,
    url: "https://wolfstreet.com/x", title: "Rates Spike", titleKo: null, author: null, publishedAt: "2026-11-10 19:21:57 KST",
    firstSeenAt: "2026-11-11 01:00:00 KST", summary: "Short", bodyStatus: "full" as const, fetchTier: "impersonate", category: null,
  };

  it("수집 글은 id로 본문을 읽게 하고, 받아 둔 범위를 한 줄로 알린다", () => {
    const full = readerOfItem(item);
    expect(full).toMatchObject({ key: "item:0123456789abcdef01234567", itemId: item.id, hasBody: true, text: null, titleKo: null, time: "2026-11-10 19:21 KST" });
    expect(full.note).toContain("본문 전체");
    const wire = readerOfItem({ ...item, kind: "headline", bodyStatus: "none", summary: null, titleKo: "금리 급등" });
    expect(wire).toMatchObject({ hasBody: false, titleKo: "금리 급등" });
    expect(wire.note).toContain("한 줄 속보");
    expect(readerOfItem({ ...item, bodyStatus: "partial" }).note).toContain("요약만");
    expect(readerOfItem({ ...item, titleKo: "Rates Spike" }).titleKo).toBeNull();
  });

  it("사건 뉴스는 피드가 준 요약이 전부다 — 없으면 제목뿐이라고 알린다(없는 본문을 만들지 않음)", () => {
    const row = { set: "us" as const, title: "Fed holds", summary: "The Committee decided.", link: "https://example.org/a",
      source: "Federal Reserve", feed: "fed_monetary", publishedAt: "2026-11-11 04:00:00 KST", fetchedAt: null };
    expect(readerOfHeadline(row, 0)).toMatchObject({ itemId: null, hasBody: true, text: "The Committee decided.", titleKo: null, url: "https://example.org/a", time: "2026-11-11 04:00 KST" });
    const bare = readerOfHeadline({ ...row, summary: null, title: null, link: null, source: null, feed: null, publishedAt: null }, 3);
    expect(bare).toMatchObject({ hasBody: false, text: null, title: "—", sourceLabel: "—", time: "—", url: null });
    expect(bare.note).toContain("제목만");
  });

  it("번역 단추는 번역할 글이 있을 때만 — 한국어 글, 이미 번역한 제목뿐인 속보에는 내지 않는다", () => {
    expect(hasHangul("금리")).toBe(true);
    expect(hasHangul("Rates 5%")).toBe(false);
    expect(hasHangul(null)).toBe(false);
    const entry = readerOfItem(item);
    expect(canTranslate(entry, "English body")).toBe(true);
    expect(canTranslate({ ...entry, titleKo: "금리 급등" }, "한국어 본문")).toBe(false);
    expect(canTranslate({ ...entry, titleKo: "금리 급등" }, null)).toBe(false);
    expect(canTranslate(entry, null)).toBe(true);
    expect(canTranslate({ ...entry, title: "금리 급등" }, null)).toBe(false);
    const headline = readerOfHeadline({ set: "kr", title: "한국은행 보도자료", summary: "기준금리를 동결했다", link: null, source: "한국은행", feed: "bok_press",
      publishedAt: null, fetchedAt: null }, 0);
    expect(canTranslate(headline, null)).toBe(false);
  });
});
