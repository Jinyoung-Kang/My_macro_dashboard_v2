/**
 * 계좌 상세(개요의 계좌 카드를 누르면 열림)의 표기 — 정의·지금 설정·구성 묶음.
 *
 *  - 정의 문장에는 설정에서 오는 숫자를 적지 않고, 숫자는 설정 응답에서 읽는다(못 읽으면 숫자 없이)
 *  - 구성: 상위 3종목(색) + 기타 n종목(하나뿐이면 그 티커) + 현금·현금성(현금성 종목이 없으면 그냥 "현금"), 비중은 장부 weightPct,
 *    현금 몫만 현금 ÷ 순자산. 넷째 색(노랑)은 쓰지 않는다(주황과 모든 쌍에서 가까움)
 *  - 의미 있는 묶음이 둘 이하면 도넛 대신 한 줄 막대, 비중을 모르면 그리지 않는다(0으로 채우지 않음)
 *  - 같은 장부면 늘 같은 순서(비중 큰 순, 같으면 티커 순)
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PROFILES,
  accountComposition,
  accountProfile,
  accountSettingRows,
  COMPOSITION_TOP_N,
  DIRECT_LABEL_MAX_SEGMENTS,
} from "../paper";
import type { PaperPosition } from "../types";

function position(ticker: string, weightPct: number | null, marketValue: number | null, over: Partial<PaperPosition> = {}): PaperPosition {
  return {
    ticker, qty: 10, avgCost: 100, lastPrice: 101, lastPriceAtKst: "2026-10-24 05:15", marketValue, weightPct, unrealizedPct: 1,
    highWatermark: 102, stopPrice: 93.84, stopDistancePct: 7.6, openedOn: "2026-10-23", holdingTradingDays: 1, priceStale: false,
    splitNote: null, cashLike: false, backfilled: true, ...over,
  };
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

describe("계좌 정의", () => {
  it("미국 다섯 계좌 모두 한 줄 소개와 정의 여섯 줄(운용 방식 · 매수 · 매도·리스크 · 현금 · 시작·출발일 · 비교 목적)", () => {
    expect(Object.keys(ACCOUNT_PROFILES)).toEqual(["rules", "claude", "claude2", "bench_spy", "bench_mix"]);
    for (const code of ["rules", "claude", "claude2", "bench_spy", "bench_mix"]) {
      const profile = accountProfile(code);
      expect(profile?.summary.length).toBeGreaterThan(0);
      expect(profile?.definitions.map((definition) => definition.label)).toEqual([
        "운용 방식", "매수", "매도·리스크", "현금", "시작·출발일", "비교 목적",
      ]);
    }
  });

  it("모르는 코드는 null — 객체의 내장 이름도 계좌로 읽지 않는다", () => {
    expect(accountProfile("mystery")).toBeNull();
    expect(accountProfile("constructor")).toBeNull();
    expect(accountProfile(null)).toBeNull();
  });

  it("정의 문장에는 설정에서 오는 숫자(스탑 %, 거래일, 종목 수, 상한)를 박지 않는다 — 코드·명세에 고정된 +30%·60/40·100%·0%만", () => {
    for (const profile of Object.values(ACCOUNT_PROFILES)) {
      for (const text of [profile.summary, ...profile.definitions.map((definition) => definition.text)]) {
        expect(text).not.toMatch(/\d+\s*(거래일|곳|종목|회|건|bp|달러)/);
        // 남는 % 숫자는 확대 기준 30%, 벤치마크 구성 60%·40%·100%, 노출 0%·100%도 거절하지 않는다(D7)뿐입니다.
        for (const match of text.matchAll(/(\d+)%/g)) expect(["0", "30", "60", "40", "100"]).toContain(match[1]);
      }
    }
  });

  it("정의는 백엔드 규칙의 예외까지 말한다 — 일시정지 중 스탑, 현금성의 최소 보유일·상한 예외, 100% 초과, 초기 패킷의 매크로 카드", () => {
    const text = (code: string, key: string) => accountProfile(code)?.definitions.find((d) => d.key === key)?.text ?? "";
    // PaperLedgerService.processBook — 스탑은 ACTIVE에서만(일시정지는 최고가만 따라감)
    expect(text("rules", "sell")).toContain("일시정지 중에는 스탑도 보지 않습니다");
    expect(text("claude", "sell")).toContain("일시정지 중에는 스탑도 보지 않습니다");
    // OrderValidator — 현금성은 MIN_HOLD·WEIGHT_CAP·MAX_POSITIONS에서 빠지고, OVER_ALLOCATED는 큰 비중부터 받는다
    expect(text("claude", "sell")).toContain("최소 보유 거래일이 지난 종목만 통과합니다(현금성 종목은 예외)");
    expect(text("claude", "buy")).toContain("종목·ETF 비중 상한(현금성 제외)");
    expect(text("claude", "buy")).toContain("보유 합계 100% 초과(큰 비중부터 받고 넘치는 매수는 거절)");
    // PacketBuilder initial=true — 매크로 카드만 그날 이력이 없어 지금 수집본(asOfMismatch)
    expect(text("claude", "start")).toContain("매크로 카드는 그날 이력이 없어 지금 수집본을 참고로");
    expect(text("claude", "start")).not.toContain("(그날 이하 값만)");
  });

  it("계좌2(체결 시점 실험)만 시각 지정 체결 계좌 — 앞으로 체결 출발·메뉴·같은 한도를 말하고, 시작 전·결정 안내를 따로 둔다", () => {
    const text = (key: string) => accountProfile("claude2")?.definitions.find((d) => d.key === key)?.text ?? "";
    expect(Object.entries(ACCOUNT_PROFILES).filter(([, profile]) => profile.timed).map(([code]) => code)).toEqual(["claude2"]);
    expect(text("start")).toContain("앞으로 체결로 출발");
    expect(text("start")).toContain("사후 체결·미리보기는 없습니다");
    expect(text("buy")).toContain("계좌1과 같은 검증기·같은 한도");
    expect(text("buy")).toContain("10:00~15:00 ET 매시");
    expect(text("cash")).toContain("멈춘 가격으로 채우지 않습니다");
    expect(text("method")).toContain("계좌1의 결정·주문은 넣지 않습니다");
    expect(accountProfile("claude2")?.notStartedNote).toContain("claude2.enabled");
    expect(accountProfile("claude2")?.decisionNote).toContain("개장 전 컷오프");
    // 계좌1의 시작 단추 이름은 계좌 이름 + " 시작"(서버 이름 'Claude 계좌1').
    expect(accountProfile("claude")?.definitions.find((d) => d.key === "start")?.text).toContain("'Claude 계좌1 시작'");
    expect(accountProfile("claude")?.timed).toBeUndefined();
  });

  it("규칙·Claude 계좌는 결정 계좌의 규칙을, 벤치마크는 '결정을 내지 않음'을 말한다", () => {
    expect(accountProfile("rules")?.definitions.find((d) => d.key === "buy")?.text).toContain("재선정일");
    expect(accountProfile("claude")?.definitions.find((d) => d.key === "buy")?.text).toContain("검증기");
    expect(accountProfile("bench_spy")?.definitions.find((d) => d.key === "method")?.text).toContain("결정을 내지 않습니다");
    expect(accountProfile("bench_mix")?.definitions.find((d) => d.key === "sell")?.text).toContain("리밸런싱이 없어");
  });
});

describe("계좌의 지금 설정", () => {
  const body = {
    trailingStopPct: 8, lockoutTradingDays: 20, minHolders: 2, rulesMaxNames: 10, maxWeightStockPct: 10, maxWeightEtfPct: 20,
    parkCashInShy: true, minOrderNotional: 500, cashLikeTickers: ["SHY"],
    rules: { parkCashThresholdPct: 2 }, blend: { allocation: "CONVICTION" }, slippageBp: 5,
  };

  it("설정을 읽지 못했으면 빈 목록 — 화면은 숫자 없이 정의만", () => {
    expect(accountSettingRows("rules", null)).toEqual([]);
    expect(accountSettingRows("rules", undefined)).toEqual([]);
    expect(accountSettingRows("mystery", body)).toEqual([]);
  });

  it("값은 설정 본문 그대로 단위를 붙이고, 묶음 키(rules.·blend.)도 따라 내려가 읽는다", () => {
    const rows = Object.fromEntries(accountSettingRows("rules", body).map((row) => [row.key, row.value]));
    expect(rows.trailingStopPct).toBe("8%");
    expect(rows.lockoutTradingDays).toBe("20거래일");
    expect(rows.rulesMaxNames).toBe("10종목");
    expect(rows.minOrderNotional).toBe("500 달러");
    expect(rows.parkCashInShy).toBe("예");
    expect(rows["rules.parkCashThresholdPct"]).toBe("2%");
    expect(rows["blend.allocation"]).toBe("확신도 비례(CONVICTION)");
    expect(rows.cashLikeTickers).toBe("SHY");
  });

  it("본문에 없는 키는 '—' — 기본값으로 채우지 않는다(지금 설정과 다를 수 있음)", () => {
    const rows = Object.fromEntries(accountSettingRows("claude", { trailingStopPct: 8 }).map((row) => [row.key, row.value]));
    expect(rows.trailingStopPct).toBe("8%");
    expect(rows.maxPositions).toBe("—");
    expect(rows.model).toBe("—");
  });

  it("벤치마크는 공통 슬리피지(60/40은 현금성 종목도)만 — 미국 계좌 다섯이 함께 쓰는 값", () => {
    expect(accountSettingRows("bench_spy", body)).toEqual([{ key: "slippageBp", label: "체결 슬리피지(미국 계좌 공통)", value: "5bp" }]);
    expect(accountSettingRows("bench_mix", body).map((row) => row.key)).toEqual(["slippageBp", "cashLikeTickers"]);
  });

  it("계좌2는 claude2.* 묶음 키를 따라 내려가 읽는다 — 없는 키는 '—'(기본값으로 채우지 않음)", () => {
    const rows = Object.fromEntries(accountSettingRows("claude2", {
      ...body, claude2: { enabled: false, maxCallsPerCycle: 2, barsWaitMinutes: 15 },
    }).map((row) => [row.key, row.value]));
    expect(rows["claude2.enabled"]).toBe("아니오");
    expect(rows["claude2.maxCallsPerCycle"]).toBe("2회");
    expect(rows["claude2.barsWaitMinutes"]).toBe("15분");
    expect(rows["claude2.executionRecord"]).toBe("—");
    expect(rows.slippageBp).toBe("5bp");
  });
});

describe("계좌 구성", () => {
  // 규칙 계좌 모양 — 종목 여섯 + SHY + 현금. 비중은 장부가 보낸 weightPct(2자리 반올림) 그대로.
  const rulesPositions = [
    position("NVDA", 10.02, 10020),
    position("AAPL", 9.5, 9500),
    position("MSFT", 9.5, 9500),
    position("AMZN", 8.25, 8250),
    position("META", 7.4, 7400),
    position("GOOG", 6.01, 6010),
    position("SHY", 48.82, 48820, { cashLike: true, stopPrice: null }),
  ];
  const rulesCash = 500;
  const rulesNav = 100000;

  it("상위 3종목 + 기타 n종목 + 현금·현금성(SHY) — 다섯 묶음 도넛, 상위 셋은 색 순서 0~2", () => {
    const view = accountComposition(rulesPositions, rulesCash, rulesNav);

    expect(view.form).toBe("donut");
    expect(view.segments.map((segment) => segment.label)).toEqual([
      "NVDA", "AAPL", "MSFT", "기타 3종목", "현금·현금성(SHY)",
    ]);
    expect(view.segments.map((segment) => segment.slot)).toEqual([0, 1, 2, null, null]);
    expect(view.segments.map((segment) => segment.kind)).toEqual(["holding", "holding", "holding", "other", "cash"]);
    const other = view.segments[3];
    expect(other.detail).toBe("AMZN·META·GOOG");
    expect(other.shareText).toBe("21.7%");
    expect(other.valueText).toBe("21,660.00 달러");
    // SHY는 현금성으로 현금과 한 묶음 — 내역에 둘을 따로 적습니다.
    const cash = view.segments[4];
    expect(cash.shareText).toBe("49.3%");
    expect(cash.detail).toBe("현금 500.00 달러 + SHY 48,820.00 달러");
    expect(cash.valueText).toBe("49,320.00 달러");
    // 묶음이 넷보다 많으면 직접 라벨 없이 범례·툴팁·표가 나릅니다.
    expect(view.segments.every((segment) => segment.directLabel === null)).toBe(true);
    expect(view.note).toBeNull();
  });

  it("DV-1: 종목이 아무리 많아도 색 자리는 셋(0~2)까지 — 넷째 색(주황과 가까운 노랑)이 생기지 않는다", () => {
    const many = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].map((ticker, index) => position(ticker, 9 - index * 0.5, (9 - index * 0.5) * 1000));
    const view = accountComposition([...many, position("SHY", 30, 30000, { cashLike: true })], 2750, 100000);
    const slots = view.segments.map((segment) => segment.slot).filter((slot): slot is number => slot !== null);
    expect(slots).toEqual([0, 1, 2]);
    expect(COMPOSITION_TOP_N).toBe(3);
    expect(view.segments.length).toBeLessThanOrEqual(COMPOSITION_TOP_N + 2);
  });

  it("ACCT-4: 남은 종목이 하나뿐이면 '기타 1종목'으로 감추지 않고 그 티커를 그대로(회색 묶음, 내역 없음)", () => {
    const four = [position("AAA", 30, 30000), position("BBB", 25, 25000), position("CCC", 20, 20000), position("DDD", 10, 10000)];
    const withCash = accountComposition(four, 15000, 100000);
    expect(withCash.segments.map((segment) => segment.label)).toEqual(["AAA", "BBB", "CCC", "DDD", "현금"]);
    expect(withCash.segments[3]).toMatchObject({ key: "other", kind: "other", slot: null, label: "DDD", detail: null, shareText: "10.0%" });
    // 표의 그 줄도 같은 묶음(색 표식이 조각과 같게)
    expect(withCash.rows.find((row) => row.label === "DDD")?.segmentKey).toBe("other");

    // 현금이 0이면 묶음 넷 — 직접 라벨도 '기타'가 아니라 그 티커
    const noCash = accountComposition(four.map((p) => ({ ...p, weightPct: (p.weightPct as number) / 0.85 })), 0, 100000);
    expect(noCash.segments).toHaveLength(DIRECT_LABEL_MAX_SEGMENTS);
    expect(noCash.segments[3].directLabel).toBe("DDD 11.8%");
  });

  it("DV-3: 현금성 종목이 든 묶음의 직접 라벨은 '현금'이 아니라 '현금·현금성' — 현금 칸(현금만)과 다른 숫자를 현금이라 적지 않는다", () => {
    const view = accountComposition(
      [position("AAA", 12, 12000), position("BBB", 10, 10000), position("CCC", 7.5, 7500), position("SHY", 70, 70000, { cashLike: true })],
      500,
      100000,
    );
    expect(view.form).toBe("donut");
    const cash = view.segments[3];
    expect(cash.label).toBe("현금·현금성(SHY)");
    expect(cash.directLabel).toBe("현금·현금성 70.5%");
  });

  it("묶음 비중의 합은 반올림 오차 안에서 100%", () => {
    const view = accountComposition(rulesPositions, rulesCash, rulesNav);
    expect(Math.abs((view.totalPct ?? 0) - 100)).toBeLessThan(0.1);
    expect(Math.abs(sum(view.segments.map((segment) => segment.sharePct)) - 100)).toBeLessThan(0.1);
  });

  it("같은 장부면 순서가 늘 같다 — 비중 큰 순, 같으면 티커 순(입력 순서와 무관)", () => {
    const forward = accountComposition(rulesPositions, rulesCash, rulesNav);
    const reversed = accountComposition([...rulesPositions].reverse(), rulesCash, rulesNav);
    expect(reversed.segments).toEqual(forward.segments);
    expect(reversed.rows).toEqual(forward.rows);
    // AAPL·MSFT는 9.5%로 같아 티커 순
    expect(forward.segments[1].label).toBe("AAPL");
    expect(forward.segments[2].label).toBe("MSFT");
  });

  it("표는 종목(비중 큰 순) → 현금성 → 현금 순이고, 줄마다 든 차트 묶음을 안다", () => {
    const view = accountComposition(rulesPositions, rulesCash, rulesNav);
    expect(view.rows.map((row) => row.label)).toEqual(["NVDA", "AAPL", "MSFT", "AMZN", "META", "GOOG", "SHY", "현금"]);
    expect(view.rows.map((row) => row.segmentKey)).toEqual([
      "holding:NVDA", "holding:AAPL", "holding:MSFT", "other", "other", "other", "cash", "cash",
    ]);
    const shy = view.rows[6];
    expect(shy.cashLike).toBe(true);
    const cashRow = view.rows[7];
    expect(cashRow).toMatchObject({ isCash: true, shareText: "0.5%", valueText: "500.00 달러", unrealizedText: "—", qtyText: "—" });
    expect(view.rows[0]).toMatchObject({ shareText: "10.0%", valueText: "10,020.00 달러", unrealizedText: "+1.00%", qtyText: "10" });
  });

  it(`종목이 ${COMPOSITION_TOP_N}개 이하면 기타 없이, 묶음 넷 이하는 큰 조각에 직접 라벨`, () => {
    const view = accountComposition(
      [position("AAA", 50, 50000), position("BBB", 30, 30000), position("CCC", 2, 2000)],
      18000,
      100000,
    );
    expect(view.form).toBe("donut");
    expect(view.segments.map((segment) => segment.label)).toEqual(["AAA", "BBB", "CCC", "현금"]);
    // 작은 조각(3% 미만)은 이웃 라벨과 겹치므로 라벨 없이
    expect(view.segments.map((segment) => segment.directLabel)).toEqual(["AAA 50.0%", "BBB 30.0%", null, "현금 18.0%"]);
  });

  it("현금성 종목이 없으면 묶음 이름은 그냥 '현금'(현금성이라 부르지 않음), 현금이 0이면 묶음도 없다", () => {
    const noCashLike = accountComposition([position("AAA", 60, 60000), position("BBB", 40, 40000)], 0, 100000);
    expect(noCashLike.segments.map((segment) => segment.label)).toEqual(["AAA", "BBB"]);
    const withCash = accountComposition([position("AAA", 60, 60000), position("BBB", 30, 30000)], 10000, 100000);
    expect(withCash.segments[2]).toMatchObject({ label: "현금", detail: null });
  });

  it("의미 있는 묶음이 둘 이하면 도넛 대신 한 줄 막대 — SPY 계좌(SPY + 잔돈), 60/40(SPY + SHY), 현금만 든 계좌", () => {
    const spy = accountComposition([position("SPY", 99.8, 99800)], 200, 100000);
    expect(spy.form).toBe("meter");
    expect(spy.segments.map((segment) => `${segment.label} ${segment.shareText}`)).toEqual(["SPY 99.8%", "현금 0.2%"]);

    const mix = accountComposition(
      [position("SPY", 59.9, 59900), position("SHY", 39.95, 39950, { cashLike: true })],
      150,
      100000,
    );
    expect(mix.form).toBe("meter");
    expect(mix.segments.map((segment) => segment.label)).toEqual(["SPY", "현금·현금성(SHY)"]);

    const cashOnly = accountComposition([], 100000, 100000);
    expect(cashOnly.form).toBe("meter");
    expect(cashOnly.segments).toHaveLength(1);
    expect(cashOnly.segments[0]).toMatchObject({ label: "현금", shareText: "100.0%" });
    expect(cashOnly.rows.map((row) => row.label)).toEqual(["현금"]);
  });

  it("순자산을 모르면 그리지 않고 이유를 적는다 — 표는 장부 값 그대로, 비중은 '—'", () => {
    const view = accountComposition([position("SPY", null, 99850)], null, null);
    expect(view.form).toBe("none");
    expect(view.segments).toEqual([]);
    expect(view.totalPct).toBeNull();
    expect(view.note).toMatch(/구성 차트를 그리지 않습니다/);
    expect(view.rows.map((row) => [row.label, row.shareText, row.valueText])).toEqual([
      ["SPY", "—", "99,850.00 달러"],
      ["현금", "—", "—"],
    ]);
  });

  it("비중이 빠진 보유는 평가액 ÷ 순자산으로 — 평가액도 모르면 그리지 않는다(일부만 그린 도넛은 틀린 그림)", () => {
    const filled = accountComposition([position("AAA", null, 25000), position("BBB", 25, 25000), position("CCC", 25, 25000)], 25000, 100000);
    expect(filled.form).toBe("donut");
    expect(filled.segments[0]).toMatchObject({ label: "AAA", shareText: "25.0%" });

    const unknown = accountComposition([position("AAA", null, null), position("BBB", 50, 50000)], 25000, 100000);
    expect(unknown.form).toBe("none");
    expect(unknown.rows[unknown.rows.length - 1]).toMatchObject({ label: "현금", shareText: "25.0%" });
  });

  it("보유 응답이 비어도(null) 현금 줄만 — 지어내지 않는다", () => {
    const view = accountComposition(null, null, 100000);
    expect(view.form).toBe("none");
    expect(view.rows).toEqual([expect.objectContaining({ label: "현금", valueText: "—" })]);
  });
});
