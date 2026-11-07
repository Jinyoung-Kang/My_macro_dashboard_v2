/**
 * 장중 스탑 감시(ADR 0032)의 설정 행 — 미국 stopWatch.mode·한국 kr.stopWatch.mode가 기존 설정 표 생성 방식 그대로 고르기(OFF · SHADOW · ON) 행으로
 * 보이고, 묶음 제목이 키 이름 대신 '장중 스탑 감시'로 나오는지(lib/paper 순수 함수). 값은 모두 합성 값입니다.
 */
import { describe, expect, it } from "vitest";
import { accountProfile, accountSettingRows, settingGroups, timingLabel } from "../paper";
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

// QA-313: 리뷰 FW-2·XC-3 — 계좌 설명의 스탑·체결 문장이 장중 스탑 감시 스위치(stopWatch.mode·kr.stopWatch.mode)와 규칙 계좌 체결 시점(rules.timing·
// kr.rules.timing)을 따르지 않음. 켜는 저장 뒤에도 '밤 잠정 평가가로 감지해 다음 거래일 시가에 체결'·'장부가 관측치마다'·'1분봉이 아니라 시간별 관측치'·
// '주문은 다음 KR 거래일 시가'가 남아, 실제 돈이 따라 하는 규칙 계좌의 체결 시각을 화면만 보고 잘못 읽음. 두 경우를 함께 적고 지금 설정 행에 키를 더함.
describe("계좌 설명 — 스탑·체결 문장이 감시 스위치와 규칙 계좌 시점을 따름(QA-313)", () => {
  const text = (code: string, key: string) => accountProfile(code)?.definitions.find((d) => d.key === key)?.text ?? "";
  const keys = (code: string) => accountProfile(code)?.settings.map((spec) => spec.key) ?? [];

  it("한국 — 규칙 계좌 체결은 kr.rules.timing(지정 시각은 확정 조정 없음), 규칙·계좌1 스탑은 kr.stopWatch.mode 두 경우, 지금 설정에 그 키", () => {
    expect(text("kr_rules", "buy")).toContain("체결 시점은 설정 kr.rules.timing을 따릅니다");
    expect(text("kr_rules", "buy")).toContain("확정 조정하지 않으며");
    for (const code of ["kr_rules", "kr_claude"]) {
      expect(text(code, "sell")).toContain("설정 kr.stopWatch.mode를 따릅니다");
      expect(text(code, "sell")).toContain("그 세션 안에 팝니다");
      expect(text(code, "sell")).toContain("밤 잠정 평가가로 감지해 다음 거래일 시가에 팔고");
    }
    expect(keys("kr_rules")).toEqual(expect.arrayContaining(["kr.rules.timing", "kr.rules.timingAtKst", "kr.stopWatch.mode"]));
    expect(keys("kr_claude")).toContain("kr.stopWatch.mode");
    expect(keys("kr_claude2")).toContain("kr.stopWatch.mode");
    const rows = Object.fromEntries(accountSettingRows("kr_rules", { kr: { rules: { timing: "AT_MINUTE", timingAtKst: "09:10" }, stopWatch: { mode: "ON" } } })
      .map((row) => [row.key, row.value]));
    expect(rows["kr.rules.timing"]).toBe("다음 거래일 지정 시각(AT_MINUTE)");
    expect(rows["kr.rules.timingAtKst"]).toBe("09:10");
    expect(rows["kr.stopWatch.mode"]).toBe("켬(ON — 장중 감시 주문)");
  });

  it("미국 — 규칙 계좌 체결은 rules.timing, 스탑은 stopWatch.mode 두 경우(계좌2도 '1분봉이 아니라 시간별 관측치'라 적지 않음), 지금 설정에 그 키", () => {
    expect(text("rules", "buy")).toContain("체결 시점은 설정 rules.timing을 따릅니다");
    expect(text("rules", "sell")).toContain("설정 stopWatch.mode를 따릅니다");
    expect(text("rules", "sell")).toContain("그 세션 안에 팝니다");
    expect(text("rules", "sell")).not.toContain("장부가 관측치마다 트레일링 스탑");
    expect(text("claude", "sell")).toContain("stopWatch.mode");
    expect(text("claude2", "sell")).toContain("stopWatch.mode");
    expect(text("claude2", "sell")).not.toContain("1분봉이 아니라 시간별 관측치로 봅니다");
    expect(keys("rules")).toEqual(expect.arrayContaining(["rules.timing", "rules.timingAtEt", "stopWatch.mode"]));
    expect(keys("claude")).toContain("stopWatch.mode");
    expect(keys("claude2")).toContain("stopWatch.mode");
    const rows = Object.fromEntries(accountSettingRows("rules", { rules: { timing: "NEXT_OBSERVATION" }, stopWatch: { mode: "OFF" } })
      .map((row) => [row.key, row.value]));
    expect(rows["rules.timing"]).toBe("다음 시간별 관측치(NEXT_OBSERVATION)");
    expect(rows["stopWatch.mode"]).toBe("끔(OFF — 시간별 관측치 스탑만)");
  });
});

