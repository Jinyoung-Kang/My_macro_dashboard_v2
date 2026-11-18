"use client";

import { useState } from "react";
import { HorizontalBars } from "@/components/charts";
import { DataTable, Empty, KpiStrip } from "@/components/patterns";
import { Callout, ErrorState, Freshness, Loading, PageHeader, Panel, Select, SKELETON_BAR, Tag } from "@/components/ui";
import { firstLoadPending, useApi } from "@/hooks/useApi";
import { formatNumber } from "@/lib/format";
import {
  metricBars,
  metricScoreEmptyReason,
  metricScoreEmptyShort,
  metricValueText,
  scorecardKpis,
  scorecardRawKpis,
  universeOptions,
} from "@/lib/scorecardScreen";
import type { ScorecardResponse, StockUniverseResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 주의 안내의 대체 본문 글(처음 읽는 동안·응답에 글이 없을 때) — 백엔드(ScorecardService)가 늘 보내는 caveat와 같은 글입니다. 예전 대체 글은 '종합 점수가 아니며,'가
 * 없어 응답이 오면 안내 상자 글이 늘며 아래를 밀었습니다(QA-716). 백엔드 글을 바꾸면 여기도 같이 고칩니다.
 */
const CAVEAT_FALLBACK = "가격으로 잴 수 있는 것만 담은 카드입니다. 종합 점수가 아니며, 재무가 부실한 회사도 주가가 오르면 높은 점수를 받습니다.";

/** 처음 읽는 동안 빠진 것 목록 자리의 줄 수 — 백엔드가 늘 보내는 missing(재무 안정성·성장성·밸류에이션) 세 줄. 자리일 뿐 보이는 글이 아닙니다. */
const MISSING_PENDING_LINES = 3;

/**
 * 종목 스코어카드 — <b>가격으로 잴 수 있는 것만</b>.
 *
 * <p>이 화면은 빠진 것을 먼저 말합니다. 재무 안정성과 성장성은 여기 없습니다 —
 * 이 프로젝트가 재무 데이터를 수집하지 않기 때문입니다. 그래서 이것은 종합
 * 점수가 아니며, 부실기업도 주가만 오르면 높은 점수를 받습니다.
 *
 * 배치(작업대 화면 언어 — 명세 §7 4행): 머리(신선도) → 주의 안내 상자 '이 카드는 종합 점수가 아닙니다.'(결과보다 먼저, 늘 보임) → '조회 조건'
 * (고르기 셋) → '스코어 요약' KPI 띠(종목 타일은 종목 상세 링크) → '지표별 점수'(백분위 막대 + 공용 표) → '원자료' KPI 띠. 한 칸입니다 — 고르기 셋뿐이라
 * 왼쪽 칸을 두어 가운데를 줄일 까닭이 없습니다.
 */
export default function ScorecardPage() {
  const universe = useApi<StockUniverseResponse>(endpoints.insight.stockUniverse);
  const [symbol, setSymbol] = useState("AAPL");
  const [benchmark, setBenchmark] = useState("SPY");
  const [years, setYears] = useState("1");

  const scorecard = useApi<ScorecardResponse>(endpoints.insight.scorecard(symbol, benchmark, years));
  const { data, loading, error, reload, refreshError } = scorecard;

  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <PageHeader
        title="종목 스코어카드"
        description={<>모멘텀 · 변동성 · 낙폭 · 추세를 {data?.universeLabel ?? "대형주"} 대비 백분위로</>}
        actions={
          <Freshness
            collectedAt={data?.collectedAtKst}
            ageSeconds={data?.ageSeconds}
            stale={data?.stale}
            refreshError={refreshError}
          />
        }
      />

      {/*
        빠진 것을 결과보다 **먼저** 보여 줍니다. 점수를 본 뒤에 "사실 재무는
        안 봤습니다"를 읽으면, 이미 그 점수로 판단이 끝난 뒤입니다.
      */}
      <Callout tone="warn" title="이 카드는 종합 점수가 아닙니다.">
        <div className="mt-1">{data?.caveat ?? CAVEAT_FALLBACK}</div>
        {(data?.missing?.length ?? 0) > 0 ? (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
            {data!.missing.map((item) => (
              <li key={item}>{item} — 수집하지 않습니다</li>
            ))}
          </ul>
        ) : firstLoadPending(scorecard) ? (
          // 처음 읽는 동안은 빠진 것 목록의 자리(같은 꼴의 줄 MISSING_PENDING_LINES — 글 없이 막대, 읽기에서 뺌). 없으면 응답이 온 뒤에 목록이 생기며 안내 상자가
          // 자라 아래 조회 조건·결과를 밀었습니다(QA-716).
          <ul aria-hidden="true" className="mt-2 list-disc space-y-0.5 pl-5 text-xs">
            {Array.from({ length: MISSING_PENDING_LINES }, (_, index) => (
              <li key={index} className="h-4">
                <span className={`inline-block h-3 w-2/3 align-middle ${SKELETON_BAR}`} />
              </li>
            ))}
          </ul>
        ) : null}
      </Callout>

      <Panel title="조회 조건">
        <div className="flex flex-wrap items-end gap-3">
          <Select label="종목" value={symbol} onChange={setSymbol} options={universeOptions(universe.data?.rows)} />
          <Select
            label="베타 기준"
            value={benchmark}
            onChange={setBenchmark}
            options={[
              { value: "SPY", label: "S&P 500 (SPY)" },
              { value: "QQQ", label: "나스닥 100 (QQQ)" },
              { value: "ACWI", label: "글로벌 주식 (ACWI)" },
            ]}
          />
          <Select
            label="측정 구간"
            value={years}
            onChange={setYears}
            options={["1", "2", "3", "5"].map((value) => ({ value, label: `최근 ${value}년` }))}
          />
        </div>
        {universe.data && !universe.data.available && (
          <div className="mt-3">
            <Callout tone="warn">{universe.data.message}</Callout>
          </div>
        )}
      </Panel>

      {loading && !data && <Loading label="스코어카드를 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Callout tone="warn">{data.message}</Callout>}

      {data?.available && (
        <>
          {/* 종목 타일은 그 종목의 상세 화면 링크(요청 없음 — 목록 → 대상 화면, 명세 W5). 값은 등락색 없이 본문 잉크, 모르는 값은 '—'. */}
          <KpiStrip label="스코어 요약" items={scorecardKpis(data, SOURCES.equityPrices)} />

          {(data.metrics?.length ?? 0) > 0 && (
            <Panel
              title="지표별 점수" source={SOURCES.equityPrices} count={`${data.metrics!.length.toLocaleString("ko-KR")}개`}
              subtitle="막대 = 백분위(0~100). 원자료를 함께 적어 점수를 검증할 수 있게 합니다."
            >
              <HorizontalBars
                data={metricBars(data.metrics)}
                unit="점"
                digits={0}
                valueName="백분위"
                neutral
                ariaLabel={`${data.symbol} 지표별 백분위`}
                height={Math.max(220, (data.metrics?.length ?? 1) * 32)}
              />

              <div className="mt-4">
                <DataTable
                  caption="지표별 점수"
                  rows={data.metrics!}
                  rowKey={(row) => row.label}
                  columns={[
                    {
                      key: "label",
                      header: "지표",
                      rowHeader: true,
                      className: "break-keep",
                      cell: (row) => (
                        <span className="flex flex-col">
                          <span className="text-text-2">{row.label}</span>
                          <span className="text-xs text-text-3">{row.how}</span>
                        </span>
                      ),
                    },
                    // 변동성·최대낙폭·추세 위치는 크기·위치라 오르내린 값이 아닙니다 — 모든 행을 본문 잉크로, 음수는 −(U+2212)(QA-705).
                    // 좋고 나쁨은 '방향' 칸과 백분위가 나릅니다. 모르면 '—'.
                    { key: "value", header: "실제 값", align: "right", cell: (row) => metricValueText(row) },
                    {
                      key: "score",
                      header: "백분위",
                      align: "right",
                      cell: (row) =>
                        row.score === null ? (
                          // 값 자체가 없으면(표본 부족) 원인은 비교 대상 수가 아닙니다 — 두 경우를 나눠 적습니다(QA-088).
                          // 짧은 까닭은 '—' 아래 줄에 늘 보이게, 긴 글은 마우스 설명(QA-719 — 예전에는 마우스 설명에만 있었음). 옆에 두면 줄바꿈 없는 숫자 열이
                          // 넓어집니다(스타일 화면 회전율 칸과 같은 꼴).
                          <span className="flex flex-col items-end text-text-3" title={metricScoreEmptyReason(row) ?? undefined}>
                            <Empty align="end" />
                            <span className="text-xs">{metricScoreEmptyShort(row)}</span>
                          </span>
                        ) : (
                          <span className="font-semibold">{formatNumber(row.score, 0)}점</span>
                        ),
                    },
                    // 방향은 지표의 읽는 법(높을수록·낮을수록 좋음) — 등락이 아니라 중립 태그입니다.
                    { key: "direction", header: "방향", className: "whitespace-nowrap", cell: (row) => <Tag>{row.direction}</Tag> },
                  ]}
                />
              </div>
            </Panel>
          )}

          <Panel title="원자료" source={SOURCES.equityPrices} subtitle="점수로 바꾸기 전의 값입니다.">
            <KpiStrip label="원자료" items={scorecardRawKpis(data)} />
          </Panel>
        </>
      )}
    </div>
  );
}
