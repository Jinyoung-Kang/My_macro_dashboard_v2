"use client";

import { MultiLineSeries, WeightHeatmap } from "@/components/charts";
import { EmptyState, Panel } from "@/components/ui";
import { weightHistoryRows } from "@/lib/chartData";
import { weightLines } from "@/lib/institutionsScreen";
import { SOURCES } from "@/lib/sources";
import type { PortfolioResponse } from "@/lib/types";
import { WEIGHT_LINE_COLORS } from "./weightLineColors";

/**
 * 13F 상위 종목 분기별 비중 — 히트맵 패널과 비중 추이(선) 패널 둘(13F 포트폴리오 화면과 기관 상세 개요 탭이 함께 씀). 값은 포트폴리오 응답의
 * `weightHistory`(백엔드가 비중 상위 topN줄로 자름) 그대로라 요청이 늘지 않습니다.
 *
 * @param history 포트폴리오 응답의 비중 이력(없으면 두 패널 모두 '분기 데이터 부족' 빈 상태)
 * @param title 선 차트 이름의 앞머리(기관 이름 — 낭독기 '… 상위 종목 분기별 비중 추이')
 */
export function WeightHistoryPanels({ history, title }: { history: PortfolioResponse["weightHistory"]; title: string }) {
  const chartData = history ? weightHistoryRows(history.dates, history.series) : [];
  // 범례·툴팁 이름표(구분자를 남기고 이름 쪽을 줄임 — QA-120)와 선 색(WEIGHT_LINE_COLORS 차례) — lib/institutionsScreen weightLines.
  const chartSeries = weightLines(history?.series, WEIGHT_LINE_COLORS);
  return (
    <>
      <Panel
        title="상위 종목 분기별 비중 히트맵" source={SOURCES.sec13f}
        // 히트맵 범례(순차 팔레트 — 어두운 단계 = 0에 가까움, 밝은 단계일수록 큼)와 같은 말로 적습니다(예전 계열 파랑 농도 때의 '진할수록'은 반대로 읽힘).
        subtitle="칸이 밝을수록 비중이 큽니다. 어느 칸이 밝아지는지만 보면 흐름이 읽힙니다."
      >
        {/*
          선 차트로 15개 종목을 겹쳐 그리면 색이 모자라고 선이 엉켜서, 정작
          "무엇이 늘고 무엇이 줄었나"가 보이지 않았습니다. 히트맵은 같은 값을
          칸 바탕의 순차 단계로 칠하고 숫자도 함께 적습니다(색만으로 값을 나르지 않습니다).
        */}
        {Object.keys(history?.series ?? {}).length === 0 ? (
          <EmptyState message="비중 이력을 그릴 분기 데이터가 부족합니다." />
        ) : (
          <WeightHeatmap
            dates={history?.dates ?? []}
            series={history?.series ?? {}}
          />
        )}
      </Panel>

      <Panel
        title="상위 종목 분기별 비중 추이 (선)" source={SOURCES.sec13f}
        subtitle="같은 값을 선으로 본 것입니다. 특정 종목의 방향을 좇을 때 씁니다."
      >
        {chartSeries.length === 0 ? (
          <EmptyState message="비중 추이를 그릴 분기 데이터가 부족합니다." />
        ) : (
          <MultiLineSeries
            data={chartData}
            series={chartSeries}
            unit="%"
            height={320}
            // 큰 분석 차트라 가로 격자(명세 W6), 이름은 무엇을 그린 차트인지(낭독기 — 차트 래퍼의 기본 이름은 계열 이름 나열).
            grid
            ariaLabel={`${title} 상위 종목 분기별 비중 추이`}
            // 툴팁은 그 분기의 비중 순위 차례로, 글자는 선 색으로(2026-11-17 사용자 요구 — 기본은 이름 차례·본문색).
            tooltipOrder="value"
            tooltipSeriesColors
          />
        )}
      </Panel>
    </>
  );
}
