/**
 * 13F 보유 변화 표기(lib/holdings) — 예전 그림 문자는 떼고, 종류는 글로 알아본다(서버가 기호를 빼도 같은 결과).
 */
import { describe, expect, it } from "vitest";

import { holdingActionView } from "@/lib/holdings";

describe("holdingActionView", () => {
  it("예전 문구(앞 그림 문자)와 새 문구(기호 없음)가 같은 글·종류", () => {
    for (const [old, plain, kind] of [
      ["🆕 신규 매수 (New)", "신규 매수 (New)", "new"],
      ["❌ 전량 매도 (Closed)", "전량 매도 (Closed)", "closed"],
      ["📈 비중 확대 (Added)", "비중 확대 (Added)", "added"],
      ["📉 비중 축소 (Reduced)", "비중 축소 (Reduced)", "reduced"],
      ["⚪ 유지 (Unchanged)", "유지 (Unchanged)", "unchanged"],
      ["⚪ 비교 데이터 없음", "비교 데이터 없음", "none"],
      ["⚪ 비교 불가 (주식 수 없음)", "비교 불가 (주식 수 없음)", "none"],
    ] as const) {
      expect(holdingActionView(old)).toEqual({ kind, text: plain });
      expect(holdingActionView(plain)).toEqual({ kind, text: plain });
    }
  });

  it("모르는 글은 글 그대로(종류 none), 없으면 '—' — 지어내지 않는다", () => {
    expect(holdingActionView("새 표기")).toEqual({ kind: "none", text: "새 표기" });
    expect(holdingActionView(null)).toEqual({ kind: "none", text: "—" });
    expect(holdingActionView("⚪")).toEqual({ kind: "none", text: "—" });
  });
});
