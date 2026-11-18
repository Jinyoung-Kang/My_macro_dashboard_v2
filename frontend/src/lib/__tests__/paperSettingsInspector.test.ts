/**
 * 모의매매 설정 탭의 순수 규칙(lib/paperSettingsInspector — 작업대 P6): 설명 앞마디 이름, 키 하나의 바꾼 기록, 검사 칸 속성, 목차 칸 이름·두 칸·닻 id.
 */
import { describe, expect, it } from "vitest";

import { settingGroups } from "../paper";
import {
  settingDescriptionRest,
  settingGroupAnchorId,
  settingGroupNavLabel,
  settingInspectorProperties,
  settingInspectorTitle,
  settingKeyHistory,
  settingLeadName,
  settingNavParts,
} from "../paperSettingsInspector";
import type { PaperSettingsResponse } from "../types";

describe("settingLeadName·settingDescriptionRest", () => {
  it("괄호 밖 첫 ' — ' 앞이 이름, 뒤가 나머지 — 이으면 설명 그대로", () => {
    const description = "하루(KST) Claude 호출 상한(D18) — 정기·수동 결정을 모두 셈. 0이면 부르지 않음";
    expect(settingLeadName(description)).toBe("하루(KST) Claude 호출 상한(D18)");
    expect(settingDescriptionRest(description)).toBe("정기·수동 결정을 모두 셈. 0이면 부르지 않음");
    expect(`${settingLeadName(description)} — ${settingDescriptionRest(description)}`).toBe(description);
  });

  it("괄호 안의 ' — '에서는 가르지 않음 — 이름이 설명 전체, 나머지 없음", () => {
    const description = "미국 매매 수수료(bp, 체결 금액 × 이 값 — 토스 미국 0.1% = 10, ADR 0030)";
    expect(settingLeadName(description)).toBe(description);
    expect(settingDescriptionRest(description)).toBeNull();
    // 괄호 뒤의 ' — '는 괄호 밖 — 거기서 가름.
    expect(settingLeadName("한국 슬리피지(bp — 가정) — 매수·매도")).toBe("한국 슬리피지(bp — 가정)");
  });

  it("' — '가 없으면 설명 전체가 이름, 설명이 없거나 비면 이름 없음", () => {
    expect(settingLeadName("트랙레코드 창(년)")).toBe("트랙레코드 창(년)");
    expect(settingDescriptionRest("트랙레코드 창(년)")).toBeNull();
    expect(settingLeadName(null)).toBeNull();
    expect(settingLeadName("   ")).toBeNull();
    expect(settingDescriptionRest(null)).toBeNull();
  });

  it("검사 칸 제목은 '{이름} · {키}', 이름이 없으면 키", () => {
    expect(settingInspectorTitle({ key: "gate.vixHigh", description: "OS 게이트 참고 — VIX 높음" })).toBe("OS 게이트 참고 · gate.vixHigh");
    expect(settingInspectorTitle({ key: "cashLikeTickers", description: null })).toBe("cashLikeTickers");
  });
});

describe("settingKeyHistory", () => {
  const HISTORY = [
    { version: 12, changedKeys: ["slippageBp", "trackRecord.windowYears"], createdAtKst: "2026-11-02 21:00 KST", body: { slippageBp: 7, trackRecord: { windowYears: 6 } } },
    { version: 11, changedKeys: ["model"], createdAtKst: "2026-11-01 09:00 KST", body: { slippageBp: 5 } },
    { version: 3, changedKeys: ["slippageBp"], createdAtKst: null },
    { version: 1, changedKeys: [], createdAtKst: "2026-10-24 09:00 KST", body: { slippageBp: 5 } },
  ];

  it("changedKeys에 그 키가 든 판만(최근 순 그대로) — 값은 그 판 본문에서, 본문이 없으면 '—'", () => {
    expect(settingKeyHistory(HISTORY, "slippageBp")).toEqual([
      { key: "0-12", version: "v12", createdAt: "2026-11-02 21:00", value: "7" },
      { key: "2-3", version: "v3", createdAt: "—", value: "—" },
    ]);
    expect(settingKeyHistory(HISTORY, "trackRecord.windowYears").map((row) => row.value)).toEqual(["6"]);
  });

  it("처음 판(바꾼 키 없음)은 바꾼 판이 아님, 이력이 없거나 모양이 다르면 빈 목록", () => {
    expect(settingKeyHistory(HISTORY, "parkCashInShy")).toEqual([]);
    expect(settingKeyHistory(null, "slippageBp")).toEqual([]);
    expect(settingKeyHistory([null, "x", { version: 2 }], "slippageBp")).toEqual([]);
  });
});

const RESPONSE: PaperSettingsResponse = {
  available: true,
  version: 4,
  body: { model: "claude-sonnet-5-5", slippageBp: 5, kr: { slippageBp: 7 }, regFees: { secPerMillion: 20.6 } },
  defaults: { model: "claude-sonnet-5-5", slippageBp: 5, parkCashInShy: true, kr: { slippageBp: 5 }, regFees: { secPerMillion: 20.6 } },
  keys: [
    { key: "model", type: "string", min: null, max: null, affectsRules: false, market: null, description: "Claude 계좌 모델(D5) — 자동 전환 없음", options: ["claude-sonnet-5-5", "claude-haiku-5-5"] },
    { key: "slippageBp", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "체결 슬리피지(bp)" },
    { key: "parkCashInShy", type: "boolean", min: null, max: null, affectsRules: true, market: "US", description: null },
    { key: "regFees.secPerMillion", type: "number", min: 0, max: 1000, affectsRules: true, market: "US", description: "SEC fee" },
    { key: "kr.slippageBp", type: "number", min: 0, max: 50, affectsRules: true, market: "KR", description: "한국 슬리피지(bp)" },
  ],
};

describe("settingInspectorProperties", () => {
  const rows = settingGroups(RESPONSE).flatMap((group) => group.rows);
  const row = (key: string) => rows.find((entry) => entry.key === key)!;
  const asObject = (key: string, version: number | null = 4) =>
    Object.fromEntries(settingInspectorProperties(row(key), RESPONSE.keys!.find((meta) => meta.key === key), version).map((item) => [item.label, item.value]));

  it("고르는 키 — 설명 전체·형(서버 표기)·고를 값·시장(공용)·지금 값·기본값·같음·영향 없음·설정 행 있음", () => {
    expect(asObject("model")).toEqual({
      설명: "Claude 계좌 모델(D5) — 자동 전환 없음",
      키: "model",
      형: "string",
      범위: null,
      "고를 수 있는 값": "claude-sonnet-5-5 · claude-haiku-5-5",
      시장: "두 시장 공용",
      "지금 값": "claude-sonnet-5-5",
      기본값: "claude-sonnet-5-5",
      "기본값과 같은가": "같음",
      "규칙 계좌 영향": "없음",
      "설정 행": "있음(설정 v4)",
    });
  });

  it("숫자 키 — 범위, 한국 키의 영향은 한국 규칙 계좌, 기본값과 다름", () => {
    const kr = asObject("kr.slippageBp");
    expect([kr.범위, kr.시장, kr["지금 값"], kr.기본값, kr["기본값과 같은가"], kr["규칙 계좌 영향"]]).toEqual([
      "0~50", "한국 계좌", "7", "5", "다름", "한국 규칙 계좌 영향",
    ]);
    expect(asObject("slippageBp")["규칙 계좌 영향"]).toBe("규칙 계좌 영향");
  });

  it("설정 행에 없는 키는 기본값으로 읽음, 설명이 없으면 '—'(까닭), 설정 행 자체가 없으면 그렇게", () => {
    const missing = settingInspectorProperties(row("parkCashInShy"), RESPONSE.keys![2], 4);
    expect(missing.find((item) => item.label === "설명")).toMatchObject({ value: null, emptyReason: "서버가 설명을 보내지 않음" });
    expect(missing.find((item) => item.label === "설정 행")?.value).toBe("설정 행에 없음 — 기본값으로 읽음");
    expect(missing.find((item) => item.label === "지금 값")?.value).toBe("예 (설정 행에 없음 — 기본값으로 읽음)");
    expect(asObject("slippageBp", null)["설정 행"]).toBe("설정 행 없음(초기화 전) — 기본값으로 읽음");
    // 서버 형을 모르면 화면이 정한 입력 종류.
    expect(settingInspectorProperties(row("slippageBp"), null, 4).find((item) => item.label === "형")?.value).toBe("number");
  });
});

describe("목차 — 묶음 칸 이름·두 칸·닻 id", () => {
  it("묶음 제목의 괄호 앞 앞마디, 시장 앞마디면 뒷마디", () => {
    expect(settingGroupNavLabel("일반 — Claude 계좌 · 장부 · 검증기 · 규칙 계좌 · 메모")).toBe("일반");
    expect(settingGroupNavLabel("기관 선정 — 트랙레코드(그룹 A)")).toBe("기관 선정");
    expect(settingGroupNavLabel("두 기관 그룹 섞기(D27)")).toBe("두 기관 그룹 섞기");
    expect(settingGroupNavLabel("미국 계좌 — 매도 제비용(SEC fee · FINRA TAF — 매도만, 다섯 계좌 공통, ADR 0030)")).toBe("매도 제비용");
    expect(settingGroupNavLabel("한국 계좌 — 비용 · 장부 · 검증기 · 규칙 계좌 · 결정 시각(kr.*)")).toBe("비용 · 장부 · 검증기 · 규칙 계좌 · 결정 시각");
    expect(settingGroupNavLabel("pricing")).toBe("pricing");
  });

  it("두 칸 — 공용·미국 키가 먼저(미국 키가 없으면 '공용 키'), 한국 키(kr.*)가 뒤, 개수는 키 수", () => {
    const parts = settingNavParts(settingGroups(RESPONSE));
    expect(parts.map((part) => [part.key, part.label, part.count, part.groups.map((group) => group.key)])).toEqual([
      ["shared", "공용·미국 키", 4, ["", "regFees"]],
      ["kr", "한국 키", 1, ["kr"]],
    ]);
    const krView = settingNavParts(settingGroups(RESPONSE, { market: "KR" }));
    expect(krView.map((part) => [part.label, part.count])).toEqual([["공용 키", 1], ["한국 키", 1]]);
    expect(settingNavParts([])).toEqual([]);
  });

  it("닻 id — 'paper-settings-{묶음}', 일반은 general, 점은 '-'", () => {
    expect(settingGroupAnchorId("")).toBe("paper-settings-general");
    expect(settingGroupAnchorId("kr.tax")).toBe("paper-settings-kr-tax");
    expect(settingGroupAnchorId("regFees")).toBe("paper-settings-regFees");
  });
});
