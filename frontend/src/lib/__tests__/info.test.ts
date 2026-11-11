/**
 * 정보 수집(ADR 0035)의 순수 규칙 — 안내 띠에 보일 사건, 출처 상태 글·색, 글 제목·시각, 네이버 금액(없으면 '—'), 거장 점수.
 */
import { describe, expect, it } from "vitest";
import {
  type InfoIncident,
  bannerText,
  bodyLabel,
  eokText,
  itemTime,
  itemTitles,
  parseInfoTab,
  rankingBasis,
  scoreText,
  sharesText,
  splitText,
  stanceTone,
  statusLabel,
  statusTone,
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
  it("한국어 제목이 있으면 위에, 원문 제목은 아래에", () => {
    expect(itemTitles({ title: "Rates Spike", titleKo: "금리 급등" })).toEqual({ primary: "금리 급등", secondary: "Rates Spike" });
    expect(itemTitles({ title: "Rates Spike", titleKo: null })).toEqual({ primary: "Rates Spike", secondary: null });
  });

  it("작성 시각을 모르면 받은 시각에 '받음'을 붙인다(작성 시각으로 꾸미지 않음)", () => {
    expect(itemTime({ publishedAt: "2026-11-11 14:30:59 KST", firstSeenAt: "2026-11-11 15:00:00 KST" })).toBe("2026-11-11 14:30");
    expect(itemTime({ publishedAt: null, firstSeenAt: "2026-11-11 15:00:00 KST" })).toBe("2026-11-11 15:00 받음");
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
      .toBe("장중 추정 — 금액 없음(주식 수) · 2026-11-11 16:44");
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
