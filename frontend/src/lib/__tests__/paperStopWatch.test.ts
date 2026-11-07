/**
 * 장중 스탑 감시(ADR 0032)의 설정 행 — 미국 stopWatch.mode·한국 kr.stopWatch.mode가 기존 설정 표 생성 방식 그대로 고르기(OFF · SHADOW · ON) 행으로
 * 보이고, 묶음 제목이 키 이름 대신 '장중 스탑 감시'로 나오는지(lib/paper 순수 함수). 값은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import { settingGroups, timingLabel } from "../paper";
import type { PaperSettingsResponse } from "../types";

describe("설정 탭 — 장중 스탑 감시 스위치", () => {
  const RESPONSE: PaperSettingsResponse = {
    available: true,
    version: 17,
    body: { slippageBp: 5, stopWatch: { mode: "OFF" }, kr: { stopWatch: { mode: "SHADOW" } } },
    defaults: { slippageBp: 5, stopWatch: { mode: "OFF" }, kr: { stopWatch: { mode: "OFF" } } },
    keys: [
      { key: "slippageBp", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "체결가에 얹는 슬리피지(bp)" },
      { key: "stopWatch.mode", type: "string", options: ["OFF", "SHADOW", "ON"], affectsRules: true, market: "US", description: "미국 장중 스탑 감시" },
      { key: "kr.stopWatch.mode", type: "string", options: ["OFF", "SHADOW", "ON"], affectsRules: true, market: "KR", description: "한국 장중 스탑 감시" },
    ],
  } as PaperSettingsResponse;

  it("미국·한국 스위치는 각자 '장중 스탑 감시' 묶음의 고르기 행 — 지금 값과 기본값 표시", () => {
    const groups = settingGroups(RESPONSE);
    expect(groups.map((group) => [group.key, group.title])).toEqual([
      ["", "일반 — Claude 계좌 · 장부 · 검증기 · 규칙 계좌 · 메모"],
      ["stopWatch", "미국 책 — 장중 스탑 감시(OFF · SHADOW 기록만 · ON 주문, 규칙 계좌 영향, ADR 0032)"],
      ["kr.stopWatch", "한국 책 — 장중 스탑 감시(OFF · SHADOW 기록만 · ON 주문, 규칙 계좌 영향, ADR 0032)"],
    ]);
    const rows = Object.fromEntries(groups.flatMap((group) => group.rows).map((row) => [row.key, row]));
    expect(rows["stopWatch.mode"]).toMatchObject({ kind: "choice", current: "OFF", isDefault: true });
    expect(rows["stopWatch.mode"].options).toEqual(["OFF", "SHADOW", "ON"]);
    expect(rows["kr.stopWatch.mode"]).toMatchObject({ kind: "choice", current: "SHADOW", isDefault: false });
  });
});

describe("주문 표 — 장중 감시 STOP의 체결 시점(QA-312)", () => {
  const watch = { source: "STOP", reason: { trigger: "TRAILING_STOP", stopMode: "INTRADAY_WATCH" } };

  it("감시가 낸 종가 STOP은 '그날 종가', 시장가 STOP은 '감지 직후 첫 분' — 감지한 그 세션에 팔림", () => {
    expect(timingLabel("NEXT_CLOSE", "KR", null, watch)).toBe("그날 종가");
    expect(timingLabel("NEXT_CLOSE", "US", null, watch)).toBe("그날 종가");
    expect(timingLabel("MARKET", "KR", null, watch)).toBe("장중 시장가(감지 직후 첫 분)");
    expect(timingLabel("AT_MINUTE", "KR", "09:10", watch)).toBe("지정 시각 09:10 KST");
  });

  it("감시 밖 주문은 그대로 — 결정의 종가·장중 확인 시장가·밤 대체 STOP·근거 없는 STOP", () => {
    expect(timingLabel("NEXT_CLOSE", "KR", null, { source: "CLAUDE", reason: null })).toBe("다음 종가");
    expect(timingLabel("MARKET", "US", null, { source: "CLAUDE", reason: { stopMode: "INTRADAY_WATCH" } })).toBe("장중 시장가(확인 직후 첫 분)");
    expect(timingLabel("AT_MINUTE", "KR", "09:10", { source: "STOP", reason: { stopMode: "NIGHT_FALLBACK" } })).toBe("지정 시각 09:10 KST");
    expect(timingLabel("NEXT_CLOSE", "US", null, { source: "STOP", reason: "{}" })).toBe("다음 종가");
    expect(timingLabel("NEXT_CLOSE", "US")).toBe("다음 종가");
  });
});
