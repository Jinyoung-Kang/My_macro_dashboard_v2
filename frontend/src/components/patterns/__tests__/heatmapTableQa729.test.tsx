/**
 * 표 히트맵(HeatmapTable)의 기본 최소 폭이 열 수와 무관한 경우(QA-729). 값은 합성입니다(가상 이름).
 *
 * `minWidth`를 주지 않은 표는 열 수와 상관없이 최소 640px(클래스 `min-w-[640px]`)였습니다. 표 자동 배치는 640px에서 열의 max-content 합보다 남는 폭을
 * 그 비율로 나누므로, 분기 열이 적으면(13F 조회 분기 1·2, 4분기뿐인 기관) 고정(sticky) 행 머리(종목 이름)가 남는 폭 대부분을 받았습니다 — P5b QA 재확인
 * (qa@01693937)의 /institutions 비중 히트맵 행 머리 폭 8분기 128·4분기 260·2분기 370·1분기 469px. 390(상자 332px)에서 분기 2·1이면 값 칸이 어느 스크롤
 * 자리에서도 다 보이지 않았고(1px씩 훑어 0/30·0/15), 끝 자리에서 행 머리가 왼쪽으로 잘려 이름이 잘리거나 사라졌으며, 1024(상자 482px) 분기 1은 값 띠 13px(0/15).
 * jsdom은 배치를 계산하지 않으므로 표의 최소 폭(클래스 또는 인라인 모양)이 열 수에 따라 정해지는지를 봅니다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { WeightHeatmap } from "@/components/charts";

import { HeatmapTable, type HeatmapColumn } from "../HeatmapTable";

afterEach(cleanup);

const DATES = ["2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30"];

/** 최근 n개 분기 열(오래된 것 → 최근). */
function columnsOf(count: number): HeatmapColumn[] {
  return DATES.slice(DATES.length - count).map((date) => ({ key: date, label: date.slice(2), title: date, nowrap: true }));
}

/** 표의 최소 폭(px) — 인라인 모양이 있으면 그것, 없으면 클래스 `min-w-[Npx]`, 둘 다 없으면 null. */
function tableMinWidth(): number | null {
  const table = screen.getByRole("table");
  if (table.style.minWidth) return Number.parseFloat(table.style.minWidth);
  const match = /(?:^|\s)min-w-\[(\d+)px\](?:\s|$)/.exec(table.className);
  return match ? Number(match[1]) : null;
}

/** 열 n개·행 둘인 표 히트맵의 최소 폭. */
function minWidthFor(count: number, minWidth?: number): number | null {
  const columns = count > DATES.length ? Array.from({ length: count }, (_, index) => ({ key: `c${index}`, label: `열 ${index + 1}` })) : columnsOf(count);
  const { unmount } = render(
    <HeatmapTable
      caption="합성 히트맵"
      rowHeader="종목"
      columns={columns}
      rows={[
        { key: "alpha", label: "SYNTHETIC ALPHA HOLDINGS INC", values: columns.map((_, index) => index + 1) },
        { key: "beta", label: "SYNTHETIC BETA CO", values: columns.map(() => 0.5) },
      ]}
      max={count}
      format={(value) => value.toFixed(1)}
      legend={{ stepLabel: (step) => `단계 ${step}` }}
      minWidth={minWidth}
    />,
  );
  const width = tableMinWidth();
  unmount();
  return width;
}

describe("표 히트맵의 기본 최소 폭은 열 수에 맞춘다(QA-729)", () => {
  // 수정 전 실패(plain it): [640, 640, 640, 640] — 열 수와 상관없이 640(기대 [192, 256, 384, 640]).
  it.fails("minWidth를 주지 않으면 최소 폭이 '행 머리 128 + 열 수 × 64'(열 1·2·4·8 → 192·256·384·640px)", () => {
    expect([1, 2, 4, 8].map((count) => minWidthFor(count))).toEqual([192, 256, 384, 640]);
  });

  it("열이 여덟보다 많아도 기본 최소 폭은 640px을 넘지 않는다(상한 — 더 넓은 몫은 표 자동 배치가 정함)", () => {
    expect([8, 9, 12].map((count) => minWidthFor(count))).toEqual([640, 640, 640]);
  });

  it("minWidth를 준 표(/style 유사도 행렬 등)는 열 수와 상관없이 그 폭", () => {
    expect([1, 2, 4, 8, 12].map((count) => minWidthFor(count, 720))).toEqual([720, 720, 720, 720, 720]);
  });

  // 수정 전 실패(plain it): [640, 640, 640, 640] — 13F 화면 조회 분기 1·2·4·8(기대 [192, 256, 384, 640]).
  it.fails("13F 비중 히트맵(WeightHeatmap)도 조회 분기 수(1·2·4·8)에 따라 최소 폭이 192·256·384·640px", () => {
    const widths = [1, 2, 4, 8].map((count) => {
      const dates = DATES.slice(DATES.length - count);
      const { unmount } = render(
        <WeightHeatmap dates={dates} series={{ "SYNTHETIC ALPHA HOLDINGS INC": dates.map(() => 12.5), "SYNTHETIC BETA CO": dates.map(() => 0) }} />,
      );
      const width = tableMinWidth();
      unmount();
      return width;
    });
    expect(widths).toEqual([192, 256, 384, 640]);
  });
});
