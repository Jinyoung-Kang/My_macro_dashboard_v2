/**
 * 화면 안에 있던 데이터 가공 규칙 — React 없이 테스트합니다(ADR 0004 규칙 3).
 */
import { describe, expect, it } from "vitest";
import { visualWidth } from "@/lib/chartAxis";
import { consensusBars, securityNote } from "@/lib/consensus";
import { correlationStrength } from "@/lib/correlation";
import { stanceText, streakText } from "@/lib/flows";
import { liquidityChartSeries } from "@/lib/liquidity";
import { sortBySourceOrder, sourceLabel, splitFundamentals, historySelection } from "@/lib/radar";
import { spreadSummary } from "@/lib/spread";
import type { KrFundamentalsCompany, LiquidityRow } from "@/lib/types";

describe("radar", () => {
  it("소스는 폴백 체인 순서로, 모르는 소스는 뒤로", () => {
    const rows = sortBySourceOrder({ toss: { ok: true }, kis: { ok: false }, mystery: { ok: true }, daum: { ok: true } });
    expect(rows.map((r) => r.name)).toEqual(["kis", "daum", "toss", "mystery"]);
    expect(sourceLabel("toss")).toBe("토스증권 (공식)");
    expect(sourceLabel("mystery")).toBe("MYSTERY");
  });

  it("재무 패널은 자료가 있는 종목만 표에 두고 나머지를 센다", () => {
    const companies = [
      { code: "005930", available: true } as KrFundamentalsCompany,
      { code: "000660", available: false, marketCap: 1.0 } as KrFundamentalsCompany,
    ];
    const { rows, empty, covered } = splitFundamentals(["005930", "000660", "035420"], companies);
    expect(rows.map((r) => r.code)).toEqual(["005930", "000660"]);
    expect(empty.map((r) => r.code)).toEqual(["035420"]);
    expect(covered).toBe(1);
  });
});

describe("liquidity", () => {
  it("십억 달러 계열은 억으로(×10), 모르는 값은 null", () => {
    const rows = [{ date: "2026-09-30", netLiquidityT: 6.1, walclT: 6.6, wtregenB: 877, rrpB: null }] as unknown as LiquidityRow[];
    const { netLiquidity, components } = liquidityChartSeries(rows);
    expect(netLiquidity).toEqual([{ date: "2026-09-30", value: 6.1 }]);
    expect(components.walcl[0].value).toBe(6.6);
    expect(components.tga[0].value).toBe(8770);
    expect(components.rrp[0].value).toBeNull();
  });
});

describe("spread", () => {
  it("한쪽을 모르면 변화도 모르고, 역전은 아는 값에서만", () => {
    const base = { longId: "DGS10", shortId: "DGS2", points: [] };
    expect(spreadSummary({ ...base, latest: -0.2, previous: 0.1 } as never)).toMatchObject({
      change: -0.30000000000000004, inverted: true, pair: "10Y−2Y",
    });
    expect(spreadSummary({ ...base, latest: null, previous: 0.1 } as never)).toMatchObject({ change: null, inverted: false });
    expect(spreadSummary(undefined).subtitle).toContain("FRED");
  });
});

describe("correlation", () => {
  it("세기와 방향", () => {
    expect(correlationStrength(null)).toBe("계산할 수 없습니다.");
    expect(correlationStrength(0.1)).toBe("거의 무관합니다.");
    expect(correlationStrength(-0.35)).toBe("약하게 반대 방향으로 움직였습니다.");
    expect(correlationStrength(0.5)).toBe("어느 정도 같은 방향으로 움직였습니다.");
    expect(correlationStrength(0.9)).toBe("뚜렷하게 같은 방향으로 움직였습니다.");
  });
});

describe("flows", () => {
  it("연속 일수 표기 — 기록 전부가 같은 방향이면 +", () => {
    expect(streakText(undefined, 20)).toBe("—");
    expect(streakText(0, 20)).toBe("—");
    expect(streakText(3, 20)).toBe("3일 순매수");
    expect(streakText(-20, 20)).toBe("20일+ 순매도");
  });

  it("KRX 포지션 성향은 앞의 색 원 기호를 떼고 글만 — 모르면 —", () => {
    expect(stanceText("🟢 매수 우위(Long)")).toBe("매수 우위(Long)");
    expect(stanceText("🔴 매도 우위(Short)")).toBe("매도 우위(Short)");
    expect(stanceText("⚪ 판정 불가")).toBe("판정 불가");
    expect(stanceText("중립")).toBe("중립");
    expect(stanceText(null)).toBe("—");
    expect(stanceText("⚪")).toBe("—");
  });
});

describe("레이더 누적 이력 — 고른 날·선택지·행 (화면에서 옮김, 동작 동일)", () => {
  const row = (obsDate: string, code: string) => ({ obsDate, code });
  const data = { dates: ["2026-10-08", "2026-10-07"], obsDate: "2026-10-08",
    rows: [row("2026-10-08", "A"), row("2026-10-07", "B")] };

  it("고른 날이 없으면 응답이 알려 준 날, 행은 그날 것만", () => {
    expect(historySelection("", data)).toEqual({
      dates: ["2026-10-08", "2026-10-07"], selectedDate: "2026-10-08",
      dateOptions: ["2026-10-08", "2026-10-07"], rows: [row("2026-10-08", "A")],
    });
  });

  it("고른 날이 새 조건의 선택지에 없으면 앞에 붙인다(선택 상자와 표가 같은 날을 가리키게)", () => {
    const picked = historySelection("2026-10-01", data);
    expect(picked.selectedDate).toBe("2026-10-01");
    expect(picked.dateOptions).toEqual(["2026-10-01", "2026-10-08", "2026-10-07"]);
    expect(picked.rows).toEqual([]);
  });

  it("응답이 없으면 빈 목록, 행은 30개까지", () => {
    expect(historySelection("", null)).toEqual({ dates: [], selectedDate: "", dateOptions: [], rows: [] });
    const many = { dates: ["d"], obsDate: "d", rows: Array.from({ length: 40 }, (_, i) => row("d", String(i))) };
    expect(historySelection("", many).rows).toHaveLength(30);
  });
});

describe("consensus (QA-114)", () => {
  const bar = (key: string, name: string, cusip: string) => ({ key, name, cusip, holderCount: 2 });

  it("합친 행은 발행사, 증권 하나면 CUSIP, 모르면 빈 문자열", () => {
    expect(securityNote({ key: "issuer:02079K", cusip: "02079K305" })).toBe("발행사 02079K · 보통주 합산");
    expect(securityNote({ key: "cusip:464287200", cusip: "464287200" })).toBe("CUSIP 464287200");
    expect(securityNote({ key: "name:X CORP|COM", cusip: null })).toBe("");
  });

  it("막대 이름표는 이름이 겹칠 때만 구분자를 붙이고, 구분자가 이름표 칸(24)에서 잘리지 않게 이름 쪽을 줄인다", () => {
    const bars = consensusBars([
      bar("cusip:464287200", "ISHARES TR", "464287200"),
      bar("cusip:464287655", "ISHARES TR", "464287655"),
      bar("issuer:084670", "BERKSHIRE HATHAWAY INC DEL", "084670702"),
      bar("cusip:99999X109", "VERY LONG COMPANY NAME HOLDINGS", "99999X109"),
      bar("issuer:99999X", "VERY LONG COMPANY NAME HOLDINGS", "99999X208"),
    ]);

    expect(bars.map((b) => b.name)).toEqual([
      "ISHARES TR · 464287200",
      "ISHARES TR · 464287655",
      "BERKSHIRE HATHAW…",
      "VERY LONG C… · 99999X109",
      "VERY LO… · 발행사 99999X",
    ]);
    expect(bars.every((b) => visualWidth(b.name) <= 24)).toBe(true);
    expect(bars.map((b) => b.value)).toEqual([2, 2, 2, 2, 2]);
  });

  it("막대는 상위 15개까지", () => {
    const rows = Array.from({ length: 20 }, (_, i) => bar(`cusip:${i}`, `CO ${i}`, String(i)));
    expect(consensusBars(rows)).toHaveLength(15);
  });
});
