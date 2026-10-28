/**
 * 모의 매매 설정 탭(명세 S1~S3)의 표기 — 키별 줄·입력 읽기·바뀐 값·저장 확인·저장 결과·이력.
 * 형·범위 검사는 서버 몫이고 화면은 입력 글자를 그 키의 형으로 읽기만 한다. 모르는 값은 "—".
 */
import { describe, expect, it } from "vitest";
import {
  KR_RULES_FROZEN_WARNING,
  PAPER_TABS,
  parseSettingInput,
  RULES_FROZEN_WARNING,
  settingGroups,
  settingRangeText,
  settingsConfirmText,
  settingsDraftView,
  settingsHistoryRows,
  settingsPatch,
  settingsSaveResultView,
  settingText,
  settingValueAt,
} from "../paper";
import { settingMarketLabel, settingsScopeOptions } from "../paper";
import type { PaperSettingKey, PaperSettingsResponse } from "../types";

function key(name: string, over: Partial<PaperSettingKey> = {}): PaperSettingKey {
  return { key: name, type: "number", min: null, max: null, affectsRules: false, description: null, ...over };
}

const RESPONSE: PaperSettingsResponse = {
  available: true,
  version: 3,
  body: {
    model: "claude-sonnet-5-5",
    slippageBp: 5,
    maxPositions: 20,
    parkCashInShy: true,
    cashLikeTickers: ["SHY"],
    trackRecord: { windowYears: 5, candidateCiks: ["0001067983", "0001061768"] },
    blend: { groupB: { topN: 4 } },
    gate: { us10yStage1: 4.8 },
    odd: { nested: 1 },
    decisionTimeKst: "07:30",
  },
  defaults: {
    model: "claude-sonnet-5-5",
    slippageBp: 5,
    maxPositions: 20,
    parkCashInShy: true,
    cashLikeTickers: ["SHY"],
    trackRecord: { windowYears: 7, candidateCiks: ["0001067983", "0001061768"] },
    blend: { groupB: { topN: 4 } },
    gate: { us10yStage1: 4.8 },
    decisionTimeKst: "07:30",
  },
  keys: [
    key("model", { type: "string", options: ["claude-sonnet-5-5", "claude-haiku-5-5"], description: "Claude 계좌·제안 모델" }),
    key("slippageBp", { min: 0, max: 100, description: "체결가 슬리피지(bp)" }),
    key("trackRecord.windowYears", { type: "integer", min: 3, max: 10, affectsRules: true }),
    key("maxPositions", { type: "integer", min: 1, max: 50, affectsRules: true }),
    key("blend.groupB.topN", { type: "integer", min: 1, max: 12, affectsRules: true }),
    key("parkCashInShy", { type: "boolean", affectsRules: true }),
    key("cashLikeTickers", { type: "list" }),
    key("trackRecord.candidateCiks", { type: "list", affectsRules: true }),
    key("gate.us10yStage1", { min: null, max: null }),
    key("decisionTimeKst", { type: "time" }),
    key("odd", { type: "mystery" }),
  ],
};

describe("설정 값 찾기·표기", () => {
  it("점 경로로 묶음을 따라 내려가고, 맨 위에 점 이름 그대로 든 키가 있으면 그것 — 없으면 undefined", () => {
    expect(settingValueAt(RESPONSE.body, "blend.groupB.topN")).toBe(4);
    expect(settingValueAt({ "a.b": 1, a: { b: 2 } }, "a.b")).toBe(1);
    expect(settingValueAt(RESPONSE.body, "blend.groupB.missing")).toBeUndefined();
    expect(settingValueAt(null, "model")).toBeUndefined();
  });

  it("표기 — 참·거짓은 예·아니오, 목록은 쉼표, 빈 목록은 (없음), 숫자는 입력과 같은 글자, 모르면 —", () => {
    expect(settingText(true)).toBe("예");
    expect(settingText(["SHY", "TLT"])).toBe("SHY, TLT");
    expect(settingText([])).toBe("(없음)");
    expect(settingText(1500)).toBe("1500");
    expect(settingText(0.5)).toBe("0.5");
    expect(settingText(null)).toBe("—");
    expect(settingText({ a: 1 })).toBe('{"a":1}');
  });

  it("범위 — 서버 값 그대로 '0~20' · 'n 이상' · 'n 이하', 없으면 null", () => {
    expect(settingRangeText(0, 20)).toBe("0~20");
    expect(settingRangeText(1, null)).toBe("1 이상");
    expect(settingRangeText(null, 100)).toBe("100 이하");
    expect(settingRangeText(null, null)).toBeNull();
  });
});

describe("설정 줄", () => {
  const groups = settingGroups(RESPONSE);
  const row = (name: string) => groups.flatMap((group) => group.rows).find((entry) => entry.key === name)!;

  it("묶음은 점 경로의 첫 마디 — 서버 키 순서대로 처음 나온 묶음 순, 이름표는 알려진 묶음만", () => {
    expect(groups.map((group) => [group.key, group.title])).toEqual([
      ["", "일반 — Claude 계좌 · 장부 · 검증기 · 규칙 계좌 · 메모"],
      ["trackRecord", "기관 선정 — 트랙레코드(그룹 A)"],
      ["blend", "두 기관 그룹 섞기(D27)"],
      ["gate", "OS 게이트 지표 — 참고 임계치(구속하지 않음)"],
    ]);
    expect(groups[0].rows.map((entry) => entry.key)).toEqual([
      "model", "slippageBp", "maxPositions", "parkCashInShy", "cashLikeTickers", "decisionTimeKst", "odd",
    ]);
  });

  it("입력 종류 — 선택지가 있으면 선택, 서버 형 이름대로, 모르는 형은 값 모양으로(객체는 바꾸지 않음)", () => {
    expect(row("model").kind).toBe("choice");
    expect(row("slippageBp").kind).toBe("number");
    expect(row("trackRecord.windowYears").kind).toBe("integer");
    expect(row("parkCashInShy").kind).toBe("boolean");
    expect(row("cashLikeTickers").kind).toBe("list");
    expect(row("decisionTimeKst").kind).toBe("text");
    expect(row("odd").kind).toBe("json");
  });

  it("지금 값·기본값·범위·규칙 책 영향 — 기본값과 다르면 isDefault:false, 기본값을 모르면 null", () => {
    const window = row("trackRecord.windowYears");
    expect(window).toMatchObject({
      initial: "5", current: "5", defaultText: "7", isDefault: false, range: "3~10", affectsRules: true,
    });
    expect(row("slippageBp")).toMatchObject({ initial: "5", isDefault: true, range: "0~100", description: "체결가 슬리피지(bp)" });
    expect(row("parkCashInShy")).toMatchObject({ initial: "true", current: "예" });
    expect(row("trackRecord.candidateCiks").initial).toBe("0001067983, 0001061768");
    expect(row("gate.us10yStage1").range).toBeNull();
    expect(row("odd")).toMatchObject({ defaultText: "—", isDefault: null });
  });

  it("지금 값이 선택지에 없으면 뒤에 붙인다 — 선택 상자가 다른 값을 가리키지 않게", () => {
    const odd = settingGroups({ ...RESPONSE, body: { ...RESPONSE.body, model: "claude-old" } });
    expect(odd[0].rows[0].options).toEqual(["claude-sonnet-5-5", "claude-haiku-5-5", "claude-old"]);
  });

  it("회귀(B-SET-UI-1): 본문에 없는 키(2단계 B 전 설정 행의 news.*)는 서버가 읽는 기본값으로 — 켜짐이 꺼짐으로, 사전이 빈 칸으로 보이지 않음", () => {
    const old = settingGroups({
      available: true,
      version: 7,
      body: { slippageBp: 5 },
      defaults: { slippageBp: 5, news: { enabled: true, keywords: ["Fed", "rate decision"], feeds: ["sec_press", "bls_cpi"] } },
      keys: [
        key("slippageBp"),
        key("news.enabled", { type: "boolean" }),
        key("news.keywords", { type: "phrases" }),
        key("news.feeds", { type: "list", options: null }),
      ],
    });
    const at = (name: string) => old.flatMap((group) => group.rows).find((entry) => entry.key === name)!;
    expect(at("news.enabled")).toMatchObject({
      kind: "boolean", value: true, missing: true, initial: "true", isDefault: true,
      current: "예 (설정 행에 없음 — 기본값으로 읽음)",
    });
    expect(at("news.keywords")).toMatchObject({ initial: "Fed, rate decision", isDefault: true, missing: true });
    expect(at("news.feeds").initial).toBe("sec_press, bls_cpi");
    expect(at("slippageBp").missing).toBe(false);

    // 손대지 않았거나 기본값 그대로 두면 바뀐 값이 아니고, 끄면 false가 저장되며, 키워드를 더하면 사전을 지우지 않고 더한 목록이 저장됩니다.
    expect(settingsDraftView(old, { "news.enabled": "true", "news.keywords": "Fed, rate decision" }).changes).toEqual([]);
    const off = settingsDraftView(old, { "news.enabled": "false", "news.keywords": "Fed, rate decision, tariff" });
    expect(off.changes.map((change) => [change.key, change.value])).toEqual([
      ["news.enabled", false], ["news.keywords", ["Fed", "rate decision", "tariff"]],
    ]);
    expect(off.changes[0].from).toBe("예 (설정 행에 없음 — 기본값으로 읽음)");
  });

  it("응답이 없거나 키가 없으면 빈 목록", () => {
    expect(settingGroups(null)).toEqual([]);
    expect(settingGroups({ available: true, version: null, body: {}, keys: [] })).toEqual([]);
  });
});

describe("입력 읽기·바뀐 값", () => {
  const groups = settingGroups(RESPONSE);

  it("형으로 읽기 — 숫자·정수·참거짓·목록(쉼표·공백·줄바꿈)·글자, 범위는 검사하지 않는다", () => {
    expect(parseSettingInput({ kind: "number" }, " 7.5 ")).toEqual({ ok: true, value: 7.5 });
    expect(parseSettingInput({ kind: "number" }, "abc")).toEqual({ ok: false, error: "숫자가 아닙니다." });
    expect(parseSettingInput({ kind: "number" }, "")).toEqual({ ok: false, error: "값을 넣으세요." });
    expect(parseSettingInput({ kind: "integer" }, "2.5")).toEqual({ ok: false, error: "정수를 넣으세요." });
    // 범위(3~10) 밖이어도 읽기는 됩니다 — 범위는 저장할 때 서버가 봅니다.
    expect(parseSettingInput({ kind: "integer" }, "99")).toEqual({ ok: true, value: 99 });
    expect(parseSettingInput({ kind: "boolean" }, "false")).toEqual({ ok: true, value: false });
    expect(parseSettingInput({ kind: "list" }, "SHY, TLT\nGLD  ,")).toEqual({ ok: true, value: ["SHY", "TLT", "GLD"] });
    expect(parseSettingInput({ kind: "list" }, "")).toEqual({ ok: true, value: [] });
    expect(parseSettingInput({ kind: "text" }, "  ")).toEqual({ ok: false, error: "값을 넣으세요." });
    expect(parseSettingInput({ kind: "json" }, "{}").ok).toBe(false);
  });

  it("바뀐 값 — 손댄 키만, 읽은 값이 지금 값과 같으면(되돌림·표기만 다름) 바뀐 것이 아님, 못 읽은 키는 오류", () => {
    const view = settingsDraftView(groups, {
      slippageBp: "5",                      // 같은 값
      cashLikeTickers: "SHY,",               // 표기만 다름
      "trackRecord.windowYears": "6",
      model: "claude-haiku-5-5",
      maxPositions: "스물",
      parkCashInShy: "false",
    });
    expect(view.changes).toEqual([
      { key: "model", from: "claude-sonnet-5-5", to: "claude-haiku-5-5", value: "claude-haiku-5-5", affectsRules: false, market: null },
      { key: "parkCashInShy", from: "예", to: "아니오", value: false, affectsRules: true, market: null },
      { key: "trackRecord.windowYears", from: "5", to: "6", value: 6, affectsRules: true, market: null },
    ]);
    expect(view.errors).toEqual({ maxPositions: "숫자가 아닙니다." });
  });

  it("저장 본문은 바뀐 키만, 키는 점 경로 그대로", () => {
    const { changes } = settingsDraftView(groups, { "blend.groupB.topN": "3", cashLikeTickers: "SHY TLT" });
    expect(settingsPatch(changes)).toEqual({ "blend.groupB.topN": 3, cashLikeTickers: ["SHY", "TLT"] });
    expect(settingsPatch([])).toEqual({});
  });

  it("저장 전 확인 — 규칙 책 영향 키가 있을 때만 경고와 키 목록, 없으면 null(바로 저장)", () => {
    const rules = settingsDraftView(groups, { "trackRecord.windowYears": "6", slippageBp: "10" }).changes;
    const text = settingsConfirmText(rules);
    expect(text).toContain(RULES_FROZEN_WARNING);
    expect(text).toContain("바꾸는 규칙 계좌 영향 키: trackRecord.windowYears.");
    expect(text).not.toContain("slippageBp");
    expect(settingsConfirmText(settingsDraftView(groups, { slippageBp: "10" }).changes)).toBeNull();
  });
});

describe("저장 결과·이력", () => {
  it("저장 결과 — 새 버전과 바뀐 키, 서버 경고는 따로, 바뀐 키가 없으면 그대로라고, ok:false는 경고", () => {
    expect(settingsSaveResultView({ version: 4, changedKeys: ["trackRecord.windowYears"], warning: `${RULES_FROZEN_WARNING}` })).toEqual({
      tone: "info",
      text: "설정 v4(으)로 저장했습니다 — 바뀐 키 trackRecord.windowYears. 재기동 없이 다음 작업부터 씁니다.",
      warning: RULES_FROZEN_WARNING,
    });
    expect(settingsSaveResultView({ version: 3, changedKeys: [], warning: null }))
      .toEqual({ tone: "info", text: "바뀐 값이 없습니다 — 설정 v3 그대로입니다.", warning: null });
    expect(settingsSaveResultView({ ok: false, version: null, changedKeys: [], warning: null, message: "테이블 없음" }))
      .toEqual({ tone: "warn", text: "테이블 없음", warning: null });
  });

  it("이력 — 서버 순서 그대로, 바뀐 키는 그 버전의 값과 함께(본문이 없으면 키만), 처음 버전은 '처음 값', 규칙 책 영향 표시", () => {
    const rows = settingsHistoryRows([
      {
        version: 3, changedKeys: ["trackRecord.windowYears", "slippageBp"], createdAtKst: "2026-10-25 10:02",
        body: { slippageBp: 7, trackRecord: { windowYears: 5 } },
      },
      { version: 2, changedKeys: ["model"], createdAtKst: null },
      { version: 1, changedKeys: [], createdAtKst: "2026-10-24 09:00" },
      "깨진 줄",
    ], RESPONSE.keys);
    expect(rows.map((row) => [row.version, row.createdAt, row.changes, row.rulesAffected])).toEqual([
      ["v3", "2026-10-25 10:02", "trackRecord.windowYears = 5 · slippageBp = 7", true],
      ["v2", "—", "model", false],
      ["v1", "2026-10-24 09:00", "처음 값(초기화)", false],
    ]);
    expect(settingsHistoryRows(undefined, undefined)).toEqual([]);
  });

  it("탭 — 설정은 이제 내용이 있다(준비 중 아님), 프레임·메모도 단계 3b에서 열렸다", () => {
    expect(PAPER_TABS.find((tab) => tab.key === "settings")?.opensIn).toBeNull();
    expect(PAPER_TABS.find((tab) => tab.key === "framework")?.opensIn).toBeNull();
    expect(PAPER_TABS.find((tab) => tab.key === "notes")?.opensIn).toBeNull();
  });
});

describe("구절 목록(사건 뉴스 키워드, 2단계 B)", () => {
  const NEWS = {
    available: true,
    version: 3,
    body: { news: { keywords: ["Fed", "rate decision"], feeds: ["sec_press"] } },
    defaults: { news: { keywords: ["Fed", "rate decision"], feeds: ["sec_press", "bls_cpi"] } },
    keys: [
      key("news.keywords", { type: "phrases", description: "매크로 키워드" }),
      key("news.feeds", { type: "list", options: null, description: "피드 키" }),
    ],
  };
  const groups = settingGroups(NEWS);
  const row = (name: string) => groups.flatMap((group) => group.rows).find((entry) => entry.key === name)!;

  it("서버 형 phrases는 공백으로 나누지 않는 목록, 피드는 목록 — 묶음 이름표는 사건 뉴스", () => {
    expect(groups.map((group) => group.title)).toEqual(["사건 뉴스 — Claude 계좌 패킷 11b(2단계 B, 규칙 계좌 영향 없음)"]);
    expect(row("news.keywords")).toMatchObject({ kind: "phrases", initial: "Fed, rate decision", isDefault: true });
    expect(row("news.feeds")).toMatchObject({ kind: "list", initial: "sec_press", isDefault: false });
  });

  it("쉼표·줄바꿈으로만 나누고 항목 안의 공백은 한 칸으로 — 'rate decision'이 두 낱말로 갈라지지 않음", () => {
    expect(parseSettingInput({ kind: "phrases" }, " rate   decision, Fed\nMiddle East ,, ")).toEqual({
      ok: true, value: ["rate decision", "Fed", "Middle East"],
    });
    expect(parseSettingInput({ kind: "phrases" }, "")).toEqual({ ok: true, value: [] });
    const view = settingsDraftView(groups, { "news.keywords": "Fed, rate decision", "news.feeds": "sec_press, bls_cpi" });
    expect(view.changes.map((change) => change.key)).toEqual(["news.feeds"]);
    expect(view.changes[0].value).toEqual(["sec_press", "bls_cpi"]);
  });
});

describe("한국 키(2단계 C1b — kr.*·공유 스위치)", () => {
  const KR = {
    available: true,
    version: 5,
    body: {
      apiScheduledReserve: 7,
      claude: { schemaV3: false },
      kr: {
        slippageBp: 5,
        tax: { kospi: { sttBp: 5 }, effectiveFrom: "2026-01-01" },
        rules: { weighting: "EQUAL" },
        calendar: {
          extraClosures: ["2026-11-02"],
          openTimeOverrides: { "2026-11-19": { open: "10:00", close: "16:30" }, "2027-01-04": { open: "10:00", close: "15:30" } },
        },
        news: { aliases: { "000660": ["하이닉스", "SK 하이닉스"], "005930": ["삼전"] } },
      },
    },
    defaults: {
      apiScheduledReserve: 7,
      claude: { schemaV3: false },
      kr: {
        slippageBp: 5,
        tax: { kospi: { sttBp: 5 }, effectiveFrom: "2026-01-01" },
        rules: { weighting: "EQUAL" },
        calendar: { extraClosures: [], openTimeOverrides: {} },
        news: { aliases: {} },
      },
    },
    keys: [
      key("apiScheduledReserve", { type: "integer", min: 0, max: 50, market: null }),
      key("claude.schemaV3", { type: "boolean", market: null }),
      key("kr.slippageBp", { min: 0, max: 100, affectsRules: true, market: "KR" }),
      key("kr.tax.kospi.sttBp", { min: 0, max: 100, affectsRules: true, market: "KR" }),
      key("kr.tax.effectiveFrom", { type: "date", affectsRules: true, market: "KR" }),
      key("kr.rules.weighting", { type: "string", options: ["EQUAL", "SCORE"], affectsRules: true, market: "KR" }),
      key("kr.calendar.extraClosures", { type: "dates", market: "KR" }),
      key("kr.calendar.openTimeOverrides", { type: "dateTimeMap", market: "KR" }),
      key("kr.news.aliases", { type: "aliasMap", market: "KR" }),
    ],
  } satisfies PaperSettingsResponse;
  const groups = settingGroups(KR);
  const row = (name: string) => groups.flatMap((group) => group.rows).find((entry) => entry.key === name)!;

  it("묶음 — 공유 키는 그 첫 마디, 한국 키는 둘째 마디까지(kr·kr.tax·kr.rules·kr.calendar·kr.news), 이름표가 있다", () => {
    expect(groups.map((group) => [group.key, group.title])).toEqual([
      ["", "일반 — Claude 계좌 · 장부 · 검증기 · 규칙 계좌 · 메모"],
      ["claude", "Claude 계좌 3단계 스위치 — 두 책 공통(규칙 계좌 영향 없음)"],
      ["kr", "한국 책 — 비용 · 장부 · 검증기 · 규칙 계좌 · 결정 시각(kr.*)"],
      ["kr.tax", "한국 책 — 매도 세금(세율 · 시행일)"],
      ["kr.rules", "한국 책 — 규칙 계좌(수급 신호 · 재선정)"],
      ["kr.calendar", "한국 책 — 거래일 달력(임시휴장 · 장 시간 변경일)"],
      ["kr.news", "한국 책 — 사건 뉴스(Claude 계좌 패킷 11b, 규칙 계좌 영향 없음)"],
    ]);
    expect(groups.find((group) => group.key === "kr.tax")!.rows.map((entry) => entry.key))
      .toEqual(["kr.tax.kospi.sttBp", "kr.tax.effectiveFrom"]);
  });

  it("입력 종류 — 서버 형 date·dates·dateTimeMap·aliasMap(대소문자 무시), 시장은 서버 market 그대로", () => {
    expect(row("kr.tax.effectiveFrom").kind).toBe("date");
    expect(row("kr.calendar.extraClosures").kind).toBe("dates");
    expect(row("kr.calendar.openTimeOverrides").kind).toBe("dateTimeMap");
    expect(row("kr.news.aliases").kind).toBe("aliasMap");
    expect(settingGroups({ ...KR, keys: [key("kr.calendar.openTimeOverrides", { type: "DATETIMEMAP" })] })[0].rows[0].kind)
      .toBe("dateTimeMap");
    expect(row("kr.slippageBp").market).toBe("KR");
    expect(row("apiScheduledReserve").market).toBeNull();
  });

  it("표기·입력 글자 — 날짜별 개장·마감은 '날짜 개장~마감', 별칭은 '코드: 별칭, 별칭', 빈 표는 (없음) · 입력은 한 줄에 한 항목", () => {
    const overrides = row("kr.calendar.openTimeOverrides");
    expect(overrides.current).toBe("2026-11-19 10:00~16:30, 2027-01-04 10:00~15:30");
    expect(overrides.initial).toBe("2026-11-19 10:00~16:30\n2027-01-04 10:00~15:30");
    expect(overrides).toMatchObject({ defaultText: "(없음)", isDefault: false });
    const aliases = row("kr.news.aliases");
    expect(aliases.current).toBe("000660: 하이닉스, SK 하이닉스 · 005930: 삼전");
    expect(aliases.initial).toBe("000660: 하이닉스, SK 하이닉스\n005930: 삼전");
    expect(row("kr.calendar.extraClosures")).toMatchObject({ initial: "2026-11-02", defaultText: "(없음)" });
    expect(row("kr.tax.effectiveFrom")).toMatchObject({ initial: "2026-01-01", isDefault: true });
    expect(settingText({})).toBe("(없음)");
    expect(settingText({ "2026-11-19": { open: "10:00" } })).toBe('{"2026-11-19":{"open":"10:00"}}');
  });

  it("읽기 — 날짜 하나는 글자 그대로(형식은 서버), 날짜 목록은 쉼표·공백, 표는 줄마다(키 순서로 맞춤) — 줄 모양이 틀리거나 같은 키가 두 줄이면 오류", () => {
    expect(parseSettingInput({ kind: "date" }, " 2026-10-27 ")).toEqual({ ok: true, value: "2026-10-27" });
    expect(parseSettingInput({ kind: "date" }, " ")).toEqual({ ok: false, error: "값을 넣으세요." });
    expect(parseSettingInput({ kind: "dates" }, "2026-12-30, 2026-11-02\n2026-12-30")).toEqual({
      ok: true, value: ["2026-11-02", "2026-12-30"],
    });
    expect(parseSettingInput({ kind: "dateTimeMap" }, " 2027-01-04 10:00 ~ 15:30\n\n2026-11-19 10:00~16:30 ")).toEqual({
      ok: true,
      value: { "2026-11-19": { open: "10:00", close: "16:30" }, "2027-01-04": { open: "10:00", close: "15:30" } },
    });
    expect(parseSettingInput({ kind: "dateTimeMap" }, "")).toEqual({ ok: true, value: {} });
    expect(parseSettingInput({ kind: "dateTimeMap" }, "2026-11-19 10:00")).toMatchObject({ ok: false });
    expect(parseSettingInput({ kind: "dateTimeMap" }, "2026-11-19 10:00~16:30\n2026-11-19 09:00~15:30"))
      .toEqual({ ok: false, error: "같은 날짜가 두 줄에 있습니다 — 2026-11-19" });
    expect(parseSettingInput({ kind: "aliasMap" }, "005930: 삼전\n000660 : 하이닉스,  SK   하이닉스 ,")).toEqual({
      ok: true, value: { "000660": ["하이닉스", "SK 하이닉스"], "005930": ["삼전"] },
    });
    expect(parseSettingInput({ kind: "aliasMap" }, "")).toEqual({ ok: true, value: {} });
    expect(parseSettingInput({ kind: "aliasMap" }, "하이닉스")).toMatchObject({ ok: false });
    expect(parseSettingInput({ kind: "aliasMap" }, "000660: a\n000660: b"))
      .toEqual({ ok: false, error: "같은 종목 코드가 두 줄에 있습니다 — 000660" });
  });

  it("바뀐 값 — 줄 순서만 바꾸면 바뀐 것이 아님, 고치면 표 통째로(시장 KR), 비우면 빈 표", () => {
    expect(settingsDraftView(groups, {
      "kr.calendar.openTimeOverrides": "2027-01-04 10:00~15:30\n2026-11-19 10:00~16:30",
      "kr.news.aliases": "005930: 삼전\n000660: 하이닉스, SK 하이닉스",
    }).changes).toEqual([]);
    const view = settingsDraftView(groups, { "kr.calendar.openTimeOverrides": "2026-11-19 10:00~16:30", "kr.news.aliases": "" });
    expect(view.changes).toEqual([
      {
        key: "kr.calendar.openTimeOverrides", from: "2026-11-19 10:00~16:30, 2027-01-04 10:00~15:30", to: "2026-11-19 10:00~16:30",
        value: { "2026-11-19": { open: "10:00", close: "16:30" } }, affectsRules: false, market: "KR",
      },
      {
        key: "kr.news.aliases", from: "000660: 하이닉스, SK 하이닉스 · 005930: 삼전", to: "(없음)", value: {}, affectsRules: false,
        market: "KR",
      },
    ]);
    expect(settingsPatch(view.changes)).toEqual({
      "kr.calendar.openTimeOverrides": { "2026-11-19": { open: "10:00", close: "16:30" } }, "kr.news.aliases": {},
    });
  });

  it("저장 전 확인 — 한국 규칙 계좌 영향 키는 한국 문장, 미국 키와 함께면 미국 · 한국(서버 warning과 같은 순서), 미국 키만이면 예전 문장 그대로", () => {
    const kr = settingsDraftView(groups, { "kr.slippageBp": "7", "kr.rules.weighting": "SCORE" }).changes;
    const text = settingsConfirmText(kr)!;
    expect(text.startsWith(`${KR_RULES_FROZEN_WARNING}. 바꾸는 규칙 계좌 영향 키: kr.slippageBp, kr.rules.weighting.`)).toBe(true);
    expect(text).not.toContain(RULES_FROZEN_WARNING);
    const both = settingsConfirmText([...kr, { key: "slippageBp", from: "5", to: "6", value: 6, affectsRules: true, market: "US" }])!;
    expect(both.startsWith(`${RULES_FROZEN_WARNING} · ${KR_RULES_FROZEN_WARNING}.`)).toBe(true);
    expect(settingsDraftView(groups, { "kr.calendar.extraClosures": "2026-11-02" }).changes).toEqual([]);
    expect(settingsConfirmText(settingsDraftView(groups, { "kr.calendar.extraClosures": "2026-12-30, 2026-11-02" }).changes))
      .toBeNull();
    expect(KR_RULES_FROZEN_WARNING).toBe("한국 규칙 계좌(kr_rules)는 동결된 대조군입니다 — 이 변경은 한국 책의 실험 조건을 바꿉니다");
  });
});

describe("설정 보기 거르기 — 한국 화면 '한국 + 공용'(사용자 결정 2026-10-29)", () => {
  const key = (name: string, market: string | null | undefined): PaperSettingKey => ({
    key: name, type: "integer", min: null, max: null, affectsRules: false, ...(market === undefined ? {} : { market }), description: null,
  });
  const MIXED: PaperSettingsResponse = {
    available: true, version: 3, body: { model: "m", rulesMaxNames: 15, kr: { rulesMaxNames: 12 }, old: 1 }, defaults: {},
    keys: [key("model", null), key("rulesMaxNames", "US"), key("kr.rulesMaxNames", "KR"), key("old", undefined)],
  };
  const keysOf = (groups: ReturnType<typeof settingGroups>) => groups.flatMap((group) => group.rows.map((row) => row.key));

  it("미국(인자 없음)은 예전 그대로 전부, KR은 한국 키 + 공용(market null·없음), 빈 묶음은 만들지 않음", () => {
    // 묶음 순서(일반 → kr) 안에서 서버 keys 순서.
    expect(keysOf(settingGroups(MIXED))).toEqual(["model", "rulesMaxNames", "old", "kr.rulesMaxNames"]);
    expect(settingGroups(MIXED, {})).toEqual(settingGroups(MIXED));
    expect(keysOf(settingGroups(MIXED, { market: "KR" }))).toEqual(["model", "old", "kr.rulesMaxNames"]);
    expect(keysOf(settingGroups(MIXED, { market: "US" }))).toEqual(["model", "rulesMaxNames", "old"]);
    expect(settingGroups({ ...MIXED, keys: [key("rulesMaxNames", "US")] }, { market: "KR" })).toEqual([]);
  });

  it("보기 이름에 키 수, 키마다 책 이름(공용은 '두 책 공용')", () => {
    expect(settingsScopeOptions(MIXED)).toEqual([
      { value: "market", label: "한국 + 공용 (3개)" },
      { value: "all", label: "전체 — 미국 키 포함 (4개)" },
    ]);
    expect(settingsScopeOptions(null).map((option) => option.label)).toEqual(["한국 + 공용 (0개)", "전체 — 미국 키 포함 (0개)"]);
    expect([settingMarketLabel("KR"), settingMarketLabel("US"), settingMarketLabel(null), settingMarketLabel("JP")])
      .toEqual(["한국 책", "미국 책", "두 책 공용", "JP"]);
  });
});
