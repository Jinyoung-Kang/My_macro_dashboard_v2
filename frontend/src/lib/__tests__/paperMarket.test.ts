/**
 * 모의매매 시장별 표기(lib/paperMarket) — 한국은 원 단위 정수·주당 가격 0자리, 미국은 예전 글자 그대로.
 *
 *  - 한국 돈은 "100,000,000원"(조·억으로 줄이지 않음, 원 미만 없음), 모르면 "—"(0원으로 채우지 않음)
 *  - 미국 formatMoney는 lib/paper formatDollars와 글자까지 같다(미국 화면 불변)
 *  - 주당 가격: 한국 71300 → "71,300", 미국은 4자리 그대로
 *  - 계좌 코드의 시장: kr_ 접두어만 한국
 *  - 시장 인자를 받은 기존 함수(bookCard·formatSharePrice·bookAssetRow)는 인자를 넘기지 않으면 예전 글자
 */
import { describe, expect, it } from "vitest";

import { bookCard, formatDollars, formatSharePrice, timingLabel } from "../paper";
import { formatMoney, formatSharePriceFor, MARKET_META, marketOfBook } from "../paperMarket";
import { bookAssetRow, PENDING_BACKFILL_WARNING } from "../paperOverview";
import type { PaperBookSummary } from "../types";

const krBook = (overrides: Partial<PaperBookSummary> = {}): PaperBookSummary => ({
  code: "kr_bench_k200",
  kind: "BENCHMARK",
  label: "KODEX 200 계좌",
  status: "ACTIVE",
  startedOn: "2026-10-29",
  initialCash: 100_000_000,
  cash: 34_000,
  nav: 100_312_450,
  equityValue: 100_278_450,
  exposurePct: 99.97,
  returnPct: 0.31,
  lastObservedAtKst: "2026-10-30 22:05 KST",
  positions: 1,
  staleCount: 0,
  stats: null,
  benchmark: null,
  ...overrides,
});

describe("돈", () => {
  it("한국은 원 단위 정수 — 1억은 '100,000,000원', 모르면 '—'", () => {
    expect(formatMoney(1e8, "KR")).toBe("100,000,000원");
    expect(formatMoney(100_312_450, "KR")).toBe("100,312,450원");
    expect(formatMoney(null, "KR")).toBe("—");
    expect(formatMoney(undefined, "KR")).toBe("—");
    expect(formatMoney(Number.NaN, "KR")).toBe("—");
    // 자릿수 인자는 미국만 — 한국은 늘 정수(원 미만이 없는 장부).
    expect(formatMoney(1_234.5, "KR", 2)).toBe("1,235원");
  });

  it("미국 formatMoney는 formatDollars와 글자까지 같다(기본 시장도 미국)", () => {
    for (const value of [100_000, 99_951.004, 0, -12.5, null, undefined]) {
      expect(formatMoney(value, "US")).toBe(formatDollars(value));
      expect(formatMoney(value)).toBe(formatDollars(value));
      expect(formatMoney(value, "US", 0)).toBe(formatDollars(value, 0));
    }
  });

  it("시장 표 — 통화·단위·현금성", () => {
    expect(MARKET_META.US).toMatchObject({ currency: "USD", unitLabel: "달러", cashLike: "SHY", tradingDayLabel: "미국 거래일" });
    expect(MARKET_META.KR).toMatchObject({ currency: "KRW", unitLabel: "원", cashLike: "153130", tradingDayLabel: "KR 거래일" });
  });
});

describe("주당 가격", () => {
  it("한국 0자리, 미국 4자리 그대로", () => {
    expect(formatSharePriceFor(71_300, "KR")).toBe("71,300");
    expect(formatSharePrice(71_300, "KR")).toBe("71,300");
    expect(formatSharePrice(9.0045)).toBe("9.0045");
    expect(formatSharePrice(9.0045, "US")).toBe("9.0045");
    expect(formatSharePrice(null, "KR")).toBe("—");
  });
});

describe("계좌 코드의 시장", () => {
  it("kr_ 접두어만 한국", () => {
    for (const code of ["kr_rules", "kr_claude", "kr_bench_k200", "kr_bench_mix"]) expect(marketOfBook(code)).toBe("KR");
    for (const code of ["rules", "claude", "bench_spy", "bench_mix", "KR_rules", "", null, undefined]) {
      expect(marketOfBook(code), String(code)).toBe("US");
    }
  });
});

describe("시장 인자를 받은 기존 함수", () => {
  it("bookCard — 한국은 원, 인자 없이는 달러(예전 글자)", () => {
    const kr = bookCard(krBook(), [], "KR");
    expect(kr.nav).toBe("100,312,450원");
    expect(kr.cash).toBe("34,000원");
    expect(kr.initialCash).toBe("100,000,000원");
    const us = bookCard(krBook(), []);
    expect(us.nav).toBe(formatDollars(100_312_450));
    expect(us.initialCash).toBe(formatDollars(100_000_000, 0));
  });

  it("bookAssetRow — 한국은 정수 원 글자·단위 '원', 사후 체결 대기 경고 없음", () => {
    const row = bookAssetRow(krBook(), { market: "KR", pendingBackfill: ["kr_bench_k200"] });
    expect(row.valueText).toBe("100,312,450");
    expect(row.unit).toBe("원");
    expect(row.warning).toBeNull();
    expect(bookAssetRow(krBook({ nav: null }), { market: "KR" }).valueText).toBeNull();
    // 미국(기본): 서식 글 칸이 없고 단위 '달러', 사후 체결 대기 경고는 그대로.
    const us = bookAssetRow(krBook({ code: "bench_spy" }), { pendingBackfill: ["bench_spy"] });
    expect(us).not.toHaveProperty("valueText");
    expect(us.unit).toBe("달러");
    expect(us.warning).toBe(PENDING_BACKFILL_WARNING);
  });

  it("체결 시점 이름 — 한국 NEXT_OPEN", () => {
    expect(timingLabel("NEXT_OPEN")).toBe("다음 거래일 시가");
    expect(timingLabel("NEXT_OBSERVATION")).toBe("다음 관측치");
  });
});
