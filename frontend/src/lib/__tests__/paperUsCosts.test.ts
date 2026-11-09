/**
 * 미국 모의 계좌의 매매 수수료·매도 제비용(ADR 0030, 명세 docs/specs/2026-11-06-us-costs-backfill.md §1·§2·§4)의 화면 표기 — lib/paper 순수 함수.
 *
 *  - 체결 비용 칸: 수수료 · 제비용(달러, 센트까지), 소급 조정 행이 있으면 체결 행의 비용(소급 대상은 0)에 더한 값과 '비용 소급'·현금 흐름
 *  - 비용 칸을 싣지 않는 옛 응답은 '칸 없음'(present false — 화면은 그 줄을 그리지 않거나 "—"), 모르는 값은 "—"(0으로 채우지 않음)
 *  - 체결 표 위 비용 소급 합계(계좌 전체) — 0건·칸 없음이면 줄 없음
 *  - 설정 탭: 새 키 넷(commissionBp·regFees.secPerMillion·regFees.tafPerShare·regFees.tafMaxPerTrade)이 기존 설정 표 생성 방식 그대로 —
 *    commissionBp는 일반 묶음, regFees.*는 '미국 계좌 — 매도 제비용' 묶음, 작은 소수(0.000195)도 그대로 적고 읽음
 * 값은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import {
  parseSettingInput,
  settingGroups,
  settingsDraftView,
  settingsPatch,
  US_COST_RETRO_TEXT,
  US_COST_RETRO_TITLE,
  usCostAdjustmentTotalText,
  usFillCosts,
} from "../paper";
import type { PaperSettingsResponse } from "../types";

describe("미국 체결 비용 칸(usFillCosts)", () => {
  it("비용 칸이 있는 새 체결 — 수수료 · 제비용을 센트까지, 소급 없음", () => {
    expect(usFillCosts({ fee: 8.0, tax: 0 })).toEqual({ present: true, text: "8.00 · 0.00", retro: false, cash: "—" });
    expect(usFillCosts({ fee: 1.23, tax: 0.07 })).toMatchObject({ text: "1.23 · 0.07", retro: false });
  });

  it("소급 조정 행이 있으면 체결 행의 비용(0)에 더한 값과 '비용 소급', 현금 흐름(음수)", () => {
    const costs = usFillCosts({ fee: 0, tax: 0, costAdjustment: { fee: 8.0, tax: 0.18, cashDelta: -8.18 } });
    expect(costs).toEqual({ present: true, text: "8.00 · 0.18", retro: true, cash: "-8.18" });
    // 체결 행에 비용 칸이 없어도(소급만 싣는 응답) 소급 값을 씁니다.
    expect(usFillCosts({ costAdjustment: { fee: 2.5, tax: null, cashDelta: -2.5 } })).toEqual({
      present: true, text: "2.50 · —", retro: true, cash: "-2.50",
    });
  });

  it("비용 칸이 없는 옛 응답은 present false·'—', 값을 모르면 '—'(0으로 채우지 않음)", () => {
    expect(usFillCosts({})).toEqual({ present: false, text: "—", retro: false, cash: "—" });
    expect(usFillCosts({ fee: null, tax: null })).toEqual({ present: true, text: "—", retro: false, cash: "—" });
    expect(usFillCosts({ fee: null, tax: null, costAdjustment: null })).toMatchObject({ retro: false, text: "—" });
    expect(usFillCosts({ fee: 0, tax: 0, costAdjustment: { fee: null, tax: null, cashDelta: null } })).toEqual({
      present: true, text: "0.00 · 0.00", retro: true, cash: "—",
    });
  });

  it("소급 표시 글은 명세 그대로 — '비용 소급 — 수량은 당시 그대로'", () => {
    expect(US_COST_RETRO_TEXT).toBe("비용 소급 — 수량은 당시 그대로");
    expect(US_COST_RETRO_TITLE.startsWith(US_COST_RETRO_TEXT)).toBe(true);
    expect(US_COST_RETRO_TITLE).toContain("수량이 조금 달랐을 것");
  });
});

describe("비용 소급 합계(usCostAdjustmentTotalText)", () => {
  it("조정 행이 있으면 건수·수수료·제비용·현금(부호) — 수량은 당시 그대로", () => {
    expect(usCostAdjustmentTotalText({ rows: 12, fee: 96, tax: 0.18, cashDelta: -96.18 })).toBe(
      "비용 소급 12건(계좌 전체) — 수수료 96.00 · 제비용 0.18 · 현금 -96.18달러 — 수량은 당시 그대로",
    );
  });

  it("0건·칸 없음은 줄 없음(null), 금액을 모르면 '—'", () => {
    expect(usCostAdjustmentTotalText({ rows: 0, fee: null, tax: null, cashDelta: null })).toBeNull();
    expect(usCostAdjustmentTotalText(null)).toBeNull();
    expect(usCostAdjustmentTotalText(undefined)).toBeNull();
    expect(usCostAdjustmentTotalText({ rows: 1, fee: null, tax: null, cashDelta: null })).toBe(
      "비용 소급 1건(계좌 전체) — 수수료 — · 제비용 — · 현금 —달러 — 수량은 당시 그대로",
    );
  });
});

describe("설정 탭 — 미국 비용 키 넷(기존 설정 표 생성 방식 그대로)", () => {
  const RESPONSE: PaperSettingsResponse = {
    available: true,
    version: 16,
    body: { slippageBp: 5, commissionBp: 10, regFees: { secPerMillion: 20.6, tafPerShare: 0.000195, tafMaxPerTrade: 9.79 } },
    defaults: { slippageBp: 5, commissionBp: 10, regFees: { secPerMillion: 20.6, tafPerShare: 0.000195, tafMaxPerTrade: 9.79 } },
    keys: [
      { key: "slippageBp", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "체결가에 얹는 슬리피지(bp)" },
      { key: "commissionBp", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "매매 수수료(bp)" },
      { key: "regFees.secPerMillion", type: "number", min: 0, max: 1000, affectsRules: true, market: "US", description: "SEC fee($/백만 달러, 매도만)" },
      { key: "regFees.tafPerShare", type: "number", min: 0, max: 0.01, affectsRules: true, market: "US", description: "FINRA TAF($/주, 매도만)" },
      { key: "regFees.tafMaxPerTrade", type: "number", min: 0, max: 100, affectsRules: true, market: "US", description: "TAF 1건 상한($)" },
    ],
  } as PaperSettingsResponse;

  it("commissionBp는 일반 묶음, regFees.*는 '미국 계좌 — 매도 제비용' 묶음 — 지금 값·범위·기본값", () => {
    const groups = settingGroups(RESPONSE);
    expect(groups.map((group) => [group.title, group.rows.map((row) => row.key)])).toEqual([
      ["일반 — Claude 계좌 · 장부 · 검증기 · 규칙 계좌 · 메모", ["slippageBp", "commissionBp"]],
      [
        "미국 계좌 — 매도 제비용(SEC fee · FINRA TAF — 매도만, 다섯 계좌 공통, ADR 0030)",
        ["regFees.secPerMillion", "regFees.tafPerShare", "regFees.tafMaxPerTrade"],
      ],
    ]);
    const rows = Object.fromEntries(groups.flatMap((group) => group.rows).map((row) => [row.key, row]));
    expect(rows.commissionBp).toMatchObject({ current: "10", range: "0~100", isDefault: true, kind: "number" });
    expect(rows["regFees.secPerMillion"]).toMatchObject({ current: "20.6", range: "0~1000", initial: "20.6" });
    expect(rows["regFees.tafPerShare"]).toMatchObject({ current: "0.000195", range: "0~0.01", initial: "0.000195" });
    expect(rows["regFees.tafMaxPerTrade"]).toMatchObject({ current: "9.79", range: "0~100" });
  });

  it("작은 소수도 그대로 읽고, 저장 본문은 점 경로 키 그대로(바꾼 키만)", () => {
    const groups = settingGroups(RESPONSE);
    expect(parseSettingInput({ kind: "number" }, "0.000195")).toEqual({ ok: true, value: 0.000195 });
    const { changes, errors } = settingsDraftView(groups, { "regFees.tafPerShare": "0", commissionBp: "10" });
    expect(errors).toEqual({});
    expect(changes.map((change) => `${change.key}: ${change.from} → ${change.to}`)).toEqual(["regFees.tafPerShare: 0.000195 → 0"]);
    expect(settingsPatch(changes)).toEqual({ "regFees.tafPerShare": 0 });
  });
});
