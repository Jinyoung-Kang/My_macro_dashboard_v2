/**
 * 13F 보유 변화 표기(lib/holdings) — 예전 그림 문자는 떼고, 종류는 글로 알아본다(서버가 기호를 빼도 같은 결과).
 */
import { describe, expect, it } from "vitest";

import { filerName, filerShortName, holdingActionView, tickerNoteWarning, tickerProxyWarning } from "@/lib/holdings";

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

describe("기관 이름 — 서버가 붙인 국기는 화면에서 뗀다(서버 원문은 패킷·알림에 그대로)", () => {
  it("국기를 뗀 이름, 이름이 없거나 기호뿐이면 null(부르는 쪽이 CIK로)", () => {
    expect(filerName("🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)")).toBe("버크셔 해서웨이 (Berkshire Hathaway)");
    expect(filerName("버크셔 해서웨이")).toBe("버크셔 해서웨이");
    expect(filerName("🇺🇸")).toBeNull();
    expect(filerName(null)).toBeNull();
  });

  it("좁은 칸의 짧은 이름은 국기를 뗀 이름의 첫 낱말 — 국기만 남지 않는다", () => {
    expect(filerShortName("🇰🇷 국민연금 (National Pension Service)")).toBe("국민연금");
    expect(filerShortName("🇳🇴 노르웨이 국부펀드 (Norges Bank / GPFG)")).toBe("노르웨이");
    expect(filerShortName("국민연금")).toBe("국민연금");
  });
});

describe("tickerNoteWarning — 수집기가 일부러 티커를 뺀 13F 보유의 경고", () => {
  it("채권·보통주 아닌 증권은 고른 종목의 주가와 값이 다르다고 적는다", () => {
    expect(tickerNoteWarning("debt")).toBe("이 줄은 채권(사채·전환사채 등)이라 아래 종목의 주가와 값이 다릅니다.");
    expect(tickerNoteWarning("non_common")).toBe("이 줄은 보통주가 아닌 증권(우선주·워런트 등)이라 아래 종목(보통주)의 주가와 값이 다릅니다.");
  });

  it("까닭이 없으면 null, 모르는 까닭은 그 값을 적은 일반 경고", () => {
    expect(tickerNoteWarning(null)).toBeNull();
    expect(tickerNoteWarning(undefined)).toBeNull();
    expect(tickerNoteWarning("  ")).toBeNull();
    expect(tickerNoteWarning("fund_unit")).toBe("수집기가 일부러 티커를 붙이지 않은 줄입니다(fund_unit) — 아래 종목의 주가와 값이 다를 수 있습니다.");
  });
});

describe("tickerProxyWarning — 수집기 티커가 같은 회사의 다른 클래스일 수 있는 13F 보유의 경고", () => {
  it("티커와 줄의 클래스를 적고 바로 열지 않는 까닭을 말한다", () => {
    expect(tickerProxyWarning("BRK-B", "CL A")).toBe(
      "수집기 이름 매핑표가 붙인 티커(BRK-B)는 회사 단위(클래스를 합침)라 이 줄의 클래스(CL A)와 같은 증권인지 확인되지 않아 바로 열지 않습니다 — 클래스가 다르면 주가도 다릅니다. 아래 후보에서 이 줄의 클래스를 고르세요.",
    );
  });

  it("클래스 표기가 비면 '—'", () => {
    expect(tickerProxyWarning(" GOOGL ", "  ")).toContain("티커(GOOGL)는 회사 단위(클래스를 합침)라 이 줄의 클래스(—)와");
    expect(tickerProxyWarning("GOOGL", null)).toContain("이 줄의 클래스(—)와");
  });
});
