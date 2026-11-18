import { describe, expect, it } from "vitest";

import {
  metricBars,
  metricScoreEmptyReason,
  metricScoreEmptyShort,
  metricValueText,
  priceScoreNote,
  scorecardKpis,
  scorecardRawKpis,
  universeOptions,
} from "@/lib/scorecardScreen";
import type { ScorecardResponse } from "@/lib/types";

const DATA: ScorecardResponse = {
  available: true, symbol: "AAPL", name: "Apple Inc.", sector: "Technology", benchmark: "SPY", years: 1, universeLabel: "S&P 500 대형주", universeSize: 136,
  missing: [], caveat: "", priceScore: 47.4, scoredCount: 4, raw: { momentum1m: -0.297, momentum6m: 4.1, beta: -0.05, samples: 250 },
};

/** 타일을 [이름, 값 글(서식 적용), 단위, 보조 글] 줄로. */
const rows = (tiles: ReturnType<typeof scorecardKpis>) =>
  tiles.map((tile) => [
    tile.label,
    tile.value === null ? null : typeof tile.value === "number" && tile.format ? tile.format(tile.value) : tile.value,
    tile.unit ?? null,
    tile.note ?? null,
  ]);

describe("스코어카드 — 스코어 요약 KPI 띠", () => {
  it("종목(링크 타일 — 종목 상세)·가격 지표 평균·베타(음수 −)·비교 대상, 출처 줄은 가격 지표 평균 타일 하나", () => {
    const tiles = scorecardKpis(DATA, "Yahoo 종가");
    expect(rows(tiles)).toEqual([
      ["종목", "AAPL", null, "Apple Inc. · Technology"],
      ["가격 지표 평균", "47", "점", "4개 지표의 백분위 평균 — 종합 점수가 아닙니다. 재무·성장·밸류에이션은 빠져 있습니다."],
      ["베타 (vs SPY)", "−0.05", null, "1.0이면 기준과 같은 폭으로 움직였다는 뜻"],
      ["비교 대상", "136", "종목", "S&P 500 대형주 — 백분위는 이 집단 안에서의 위치입니다."],
    ]);
    expect(tiles[0]).toMatchObject({ href: "/s/us/AAPL", valueKind: "label" });
    expect(tiles.map((tile) => tile.source ?? null)).toEqual([null, "Yahoo 종가", null, null]);
    expect(tiles.slice(1).some((tile) => tile.href)).toBe(false);
  });

  it("모르는 값은 null('—') — 예전처럼 0점·0종목·0개 지표로 채우지 않음", () => {
    const tiles = scorecardKpis({ ...DATA, priceScore: null, scoredCount: undefined, universeSize: undefined, raw: undefined, name: null, sector: null }, "S");
    expect(rows(tiles)).toEqual([
      ["종목", "AAPL", null, null],
      ["가격 지표 평균", null, "점", "지표 백분위 평균 — 종합 점수가 아닙니다. 재무·성장·밸류에이션은 빠져 있습니다."],
      ["베타 (vs SPY)", null, null, "1.0이면 기준과 같은 폭으로 움직였다는 뜻"],
      ["비교 대상", null, "종목", "S&P 500 대형주 — 백분위는 이 집단 안에서의 위치입니다."],
    ]);
    expect(priceScoreNote(0)).toMatch(/^0개 지표/);
  });

  it("원자료 — 1·6개월 수익률(음수 −)·표본(거래일)·측정 구간", () => {
    expect(rows(scorecardRawKpis(DATA))).toEqual([
      ["1개월 수익률", "−0.30", "%", null],
      ["6개월 수익률", "4.10", "%", null],
      ["표본", "250", "일", "거래일 수"],
      ["측정 구간", "최근 1년", null, null],
    ]);
    expect(rows(scorecardRawKpis({ raw: undefined, years: Number.NaN })).map((row) => row[1])).toEqual([null, null, null, null]);
  });
});

describe("스코어카드 — 지표 표·막대", () => {
  it("실제 값 글은 숫자 + 단위, 음수 −, 모르면 null", () => {
    expect(metricValueText({ value: -5.24, unit: "%" })).toBe("−5.2%");
    expect(metricValueText({ value: 23.4, unit: "%" })).toBe("23.4%");
    expect(metricValueText({ value: null, unit: "%" })).toBeNull();
  });

  it("백분위를 모르는 까닭은 값이 없을 때(표본 부족)와 비교 대상이 모자랄 때를 나눈다(QA-088), 백분위가 있으면 null", () => {
    expect(metricScoreEmptyReason({ value: null, score: null })).toBe("표본이 부족해 값을 잴 수 없어 백분위도 없습니다");
    expect(metricScoreEmptyReason({ value: 3, score: null })).toBe("비교 대상이 10개 미만이라 백분위를 내지 않습니다");
    // 표 칸 '—' 옆의 짧은 까닭(QA-719) — 백분위가 있으면 없음
    expect([metricScoreEmptyShort({ value: null, score: null }), metricScoreEmptyShort({ value: 3, score: null }), metricScoreEmptyShort({ value: 3, score: 40 })]).toEqual([
      "표본 부족",
      "비교 대상 10개 미만",
      null,
    ]);
    expect(metricScoreEmptyReason({ value: 3, score: 0 })).toBeNull();
  });

  it("막대는 백분위를 아는 지표만(0은 값), 종목 선택지는 '티커 · 이름'", () => {
    expect(metricBars([
      { label: "A", how: "", value: 1, unit: "%", score: 0, direction: "" },
      { label: "B", how: "", value: 1, unit: "%", score: null, direction: "" },
    ])).toEqual([{ name: "A", value: 0 }]);
    expect(universeOptions([{ ticker: "MSFT", name: "Microsoft Corp.", sector: null }])).toEqual([{ value: "MSFT", label: "MSFT · Microsoft Corp." }]);
    expect(universeOptions(undefined)).toEqual([]);
  });
});
