/**
 * 장중 스탑 감시(ADR 0032)의 설정 행 — 미국 stopWatch.mode·한국 kr.stopWatch.mode가 기존 설정 표 생성 방식 그대로 고르기(OFF · SHADOW · ON) 행으로
 * 보이고, 묶음 제목이 키 이름 대신 '장중 스탑 감시'로 나오는지(lib/paper 순수 함수). 값은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import { settingGroups } from "../paper";
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
