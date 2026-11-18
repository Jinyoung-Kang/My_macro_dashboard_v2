import { describe, expect, it } from "vitest";

import {
  profileItems,
  profileTitle,
  riskInstitutionName,
  riskKpis,
  signedUnitText,
  similarityHeatmap,
  similarityMax,
  similarityPairs,
  similarityStepLabel,
  similarityBelowText,
  similarityText,
  styleFullName,
  styleShortName,
} from "@/lib/styleScreen";
import type { GuruProfile } from "@/lib/types";

const BERKSHIRE = "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)";
const NORGES = "🇳🇴 노르웨이 국부펀드 (Norges Bank / GPFG)";
const NPS = "🇰🇷 국민연금 (National Pension Service)";
const KRW = { toKrw: (usd: number | null | undefined) => (usd === null || usd === undefined ? null : `약 ${usd}원`), note: "원/달러 1,400.00 기준" };

const profile = (over: Partial<GuruProfile> = {}): GuruProfile => ({
  cik: "0001067983", key: "berkshire", name: BERKSHIRE, desc: "가치 투자 — 집중 보유", reportDate: "2026-06-30", totalValue: 2.5e11, holdingCount: 40,
  effectiveHoldings: 8.24, hhi: 0.1214, top10Weight: 88.12, turnover: 3.25, quarterCount: 8, ...over,
});

/** 속성 줄을 '이름 → 값' 표로(보조 글·까닭이 있으면 ' | '로 덧붙임). */
function table(items: { label: string; value: string | number | null; note?: string | null; emptyReason?: string | null; mono?: boolean; block?: boolean }[]) {
  return Object.fromEntries(
    items.map((item) => [
      item.label,
      [String(item.value), item.note, item.emptyReason, item.mono ? "mono" : null, item.block ? "block" : null].filter(Boolean).join(" | "),
    ]),
  );
}

describe("스타일 화면 — 이름", () => {
  it("짧은 이름은 국기와 끝 괄호를 떼고(QA-153), 전체 이름은 국기만 뗀다", () => {
    expect(styleShortName(BERKSHIRE)).toBe("버크셔 해서웨이");
    expect(styleShortName(NORGES)).toBe("노르웨이 국부펀드");
    expect(styleFullName(BERKSHIRE)).toBe("버크셔 해서웨이 (Berkshire Hathaway)");
    expect(styleShortName("Plain Name")).toBe("Plain Name");
  });
});

describe("스타일 화면 — 유사도", () => {
  const institutions = [
    { cik: "1", name: BERKSHIRE },
    { cik: "2", name: NORGES },
    { cik: "3", name: NPS },
  ];
  const overlap = [[100, 42.5, 12.25], [42.5, 100, null], [12.25, null, 100]];

  it("짝은 행렬 위쪽 삼각형의 값 큰 순(모르는 칸 뺌) — 짧은 이름·전체 이름·순위, 키는 받은 이름 둘", () => {
    expect(similarityPairs(institutions, overlap, 8)).toEqual([
      { key: `${BERKSHIRE}|${NORGES}`, rank: 1, left: "버크셔 해서웨이", leftTitle: "버크셔 해서웨이 (Berkshire Hathaway)", right: "노르웨이 국부펀드",
        rightTitle: "노르웨이 국부펀드 (Norges Bank / GPFG)", value: 42.5 },
      { key: `${BERKSHIRE}|${NPS}`, rank: 2, left: "버크셔 해서웨이", leftTitle: "버크셔 해서웨이 (Berkshire Hathaway)", right: "국민연금",
        rightTitle: "국민연금 (National Pension Service)", value: 12.25 },
    ]);
    expect(similarityPairs(institutions, overlap, 1)).toHaveLength(1);
    expect(similarityPairs(institutions, null)).toEqual([]);
  });

  it("행렬은 행·열 = 기관(짧은 이름·전체 이름), 대각선 = 자기 칸, 행렬에 없는 칸은 모름", () => {
    const heatmap = similarityHeatmap(institutions, [[100, 42.5], [42.5, 100]]);
    expect(heatmap.columns.map((column) => [column.key, column.label, column.title])).toEqual([
      ["1", "버크셔 해서웨이", "버크셔 해서웨이 (Berkshire Hathaway)"],
      ["2", "노르웨이 국부펀드", "노르웨이 국부펀드 (Norges Bank / GPFG)"],
      ["3", "국민연금", "국민연금 (National Pension Service)"],
    ]);
    expect(heatmap.rows.map((row) => [row.label, row.values, row.selfIndex])).toEqual([
      ["버크셔 해서웨이", [100, 42.5, undefined], 0],
      ["노르웨이 국부펀드", [42.5, 100, undefined], 1],
      ["국민연금", [undefined, undefined, undefined], 2],
    ]);
  });

  it("단계 기준·자릿수·범례 글 — 겹침은 100·소수 첫째·'0~20%', 코사인은 1·둘째·'0.0~0.2'", () => {
    expect([similarityMax("overlap"), similarityMax("cosine")]).toEqual([100, 1]);
    expect([similarityText("overlap", 12.25), similarityText("cosine", 0.314)]).toEqual(["12.3", "0.31"]);
    expect(([1, 2, 3, 4, 5] as const).map((step) => similarityStepLabel("overlap", step))).toEqual(["0~20%", "20~40%", "40~60%", "60~80%", "80~100%"]);
    expect(([1, 5] as const).map((step) => similarityStepLabel("cosine", step))).toEqual(["0.0~0.2", "0.8~1.0"]);
  });
});

describe("스타일 화면 — 기관 성격 검사 칸", () => {
  it("제목은 국기를 뗀 이름(자료에 없으면 null), 위험 패널 이름은 없으면 'CIK …'", () => {
    expect(profileTitle([profile()], "0001067983")).toBe("버크셔 해서웨이 (Berkshire Hathaway)");
    expect(profileTitle([profile()], "0000000000")).toBeNull();
    expect(profileTitle([profile({ name: "" })], "0001067983")).toBe("CIK 0001067983");
    expect(riskInstitutionName(undefined, "0001067983")).toBe("CIK 0001067983");
  });

  it("속성 — 소개(긴 글)·CIK(고정폭)·기준 분기·총액·원화·종목 수·유효 종목 수·HHI·상위 10종목·회전율·수집 분기 수", () => {
    expect(table(profileItems(profile(), KRW))).toEqual({
      "기관 소개": "가치 투자 — 집중 보유 | block",
      CIK: "0001067983 | mono",
      "기준 분기": "2026-06-30",
      "포트폴리오 총액": "2,500억 달러",
      "원화 환산": "약 250000000000원 | 원/달러 1,400.00 기준",
      "종목 수": "40종목",
      "유효 종목 수": "8.2 | 1 ÷ HHI",
      HHI: "0.1214 | 비중(0~1) 제곱의 합 — 1이면 한 종목",
      "상위 10종목": "88.1%",
      "분기 회전율": "3.3%",
      "수집 분기 수": "8분기",
    });
  });

  it("모르는 값은 null('—') — 회전율은 까닭, HHI 0(비중 없음)·총액·유효 종목 수 모름, 소개가 없으면 그 줄이 없음", () => {
    const items = table(profileItems(profile({ desc: "", turnover: null, hhi: 0, totalValue: null, effectiveHoldings: null, reportDate: null }), { toKrw: () => null, note: "원/달러 값 없음" }));
    expect(items["기관 소개"]).toBeUndefined();
    expect(items["분기 회전율"]).toBe("null | 직전 분기가 없어 계산할 수 없습니다");
    expect(items.HHI).toBe("null | 비중(0~1) 제곱의 합 — 1이면 한 종목");
    expect(items["포트폴리오 총액"]).toBe("null");
    expect(items["원화 환산"]).toBe("null | 원/달러 값 없음");
    expect(items["유효 종목 수"]).toBe("null | 1 ÷ HHI");
    expect(items["기준 분기"]).toBe("null");
  });
});

describe("스타일 화면 — 위험 지표 KPI 띠", () => {
  const metrics = { volatility: 14.2, var95: -1.13, var99: -1.92, es95: -1.63, es99: -2.27, maxDrawdown: 7.64, beta: -0.05, trackingError: 6.1, samples: 250,
    from: "2025-11-04", to: "2026-11-04" };

  it("여덟 타일 — 이름·값 글(음수 −)·단위·보조 글, 첫 타일 보조 글은 표본·구간, 등락색·출처 없음", () => {
    const tiles = riskKpis(metrics, "SPY");
    expect(tiles.map((tile) => [tile.label, tile.format?.(tile.value as number), tile.unit ?? null, tile.note ?? null])).toEqual([
      ["연율 변동성", "14.20", "%", "표본 250일 · 2025-11-04 ~ 2026-11-04"],
      ["베타 (vs SPY)", "−0.05", null, "1.0이면 벤치마크와 같은 폭으로 움직였다는 뜻"],
      ["추적오차 (연율)", "6.10", "%", "벤치마크와 얼마나 달랐나 — 좋고 나쁨은 말하지 않습니다"],
      ["최대낙폭", "7.64", "%", "구간 내 고점 대비 최대 하락"],
      ["VaR (95%)", "−1.13", "%", "일일 최대 예상 손실"],
      ["VaR (99%)", "−1.92", "%", "극단 상황"],
      ["ES (95%)", "−1.63", "%", "VaR 초과 시 평균 손실"],
      ["ES (99%)", "−2.27", "%", "VaR 초과 시 평균 손실"],
    ]);
    expect(tiles.some((tile) => tile.change || tile.source || tile.neutral)).toBe(false);
  });

  it("모르는 값은 null('—'), 표본·구간을 모르면 첫 타일 보조 글 없음", () => {
    const tiles = riskKpis({ ...metrics, volatility: null, beta: Number.NaN, from: "", samples: 0 }, "QQQ");
    expect(tiles[0]).toMatchObject({ value: null, note: null });
    expect(tiles[1]).toMatchObject({ label: "베타 (vs QQQ)", value: null });
  });

  it("부호 있는 단위 글 — 음수 −, 모르면 '—'(단위 없이)", () => {
    expect(signedUnitText(-0.42, 2, "%p")).toBe("−0.42%p");
    expect(signedUnitText(4.1, 2, "%p")).toBe("4.10%p");
    expect(signedUnitText(null, 1, "%")).toBe("—");
  });
});

describe("유사도 값 글 — 0으로 반올림되는 양수는 '<' 글(QA-718)", () => {
  // 수정 전 실패(plain it): ["0.0", "0.00", "0.0", "0.00", "0.1", "42.5", "0.04"] — 칠하는(단계 1) 아주 작은 양수가 칠하지 않는 참 0과 같은 '0.0'으로 적혀, 행렬에서
  // 칠한 '0.0'과 칠하지 않은 '0.0'이 섞였음(QA 자료 겹침 국민연금·사이언 0.00102 — 검토 자기 빌드 1440 겹침 '0.0' 칸 30개 중 18개를 칠함).
  it("겹침 0.05 미만·코사인 0.005 미만의 양수는 '<0.1'·'<0.01', 참 0은 '0.0'·'0.00', 나머지는 반올림 그대로", () => {
    expect([
      similarityText("overlap", 0.0010198764723578502),
      similarityText("cosine", 0.004),
      similarityText("overlap", 0),
      similarityText("cosine", 0),
      similarityText("overlap", 0.06),
      similarityText("overlap", 42.5),
      similarityText("cosine", 0.04),
    ]).toEqual(["<0.1", "<0.01", "0.0", "0.00", "0.1", "42.5", "0.04"]);
    // 범례 설명 글이 쓰는 같은 글
    expect([similarityBelowText("overlap"), similarityBelowText("cosine")]).toEqual(["<0.1", "<0.01"]);
  });
});
