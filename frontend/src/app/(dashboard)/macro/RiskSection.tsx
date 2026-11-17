"use client";

import { type Column, DataTable, KpiStrip } from "@/components/patterns";
import { EmptyState, Freshness, Loading, Panel } from "@/components/ui";
import { riskKpis } from "@/lib/macroScreen";
import type { RiskIndicators } from "@/lib/types";
import { CriteriaDetails } from "./CriteriaDetails";

const RISK_TABLE = [
  {
    // 값은 변동성 시계열(일봉, Yahoo ^VIX 15분 지연)의 마지막 봉이고, 그 시계열은 1시간마다 받습니다(QA-137).
    name: "CBOE VIX [15분 지연 일봉 · 1시간마다 수집]",
    normal: "15 ~ 20 (15 미만: 과도한 낙관)",
    danger: "30 이상 (패닉 / 급락 / 투매)",
    note: "주식 시장의 단기 공포 측정기. 급등 시 주가 급락·투매 신호.",
  },
  {
    name: "ICE BofA MOVE [지연/마감]",
    normal: "80 ~ 120 (80 미만: 금리 초안정)",
    danger: "140 이상 (채권 발작 / 긴축 충격)",
    note: "채권 시장의 공포 지수. 이 화면의 값은 추정치이므로 이 임계치를 그대로 적용하지 마세요.",
  },
  {
    name: "하이일드 스프레드 [1일 지연]",
    normal: "3.5% ~ 5.0%",
    danger: "7.0% 이상 (본격 신용경색)",
    note: "한계 기업 부도 리스크 프리미엄. 침체 진입 시 가장 먼저 급등하는 선행 지표.",
  },
  {
    name: "3M 금융 CP 스프레드 [1일 지연]",
    normal: "0.20%p ~ 0.50%p",
    danger: "0.80%p 이상 (단기 자금시장 경색)",
    note: "은행권 3개월 단기 자금조달 가산금리(현대판 TED 스프레드).",
  },
  {
    name: "STLFSI4 금융스트레스 [주간]",
    normal: "0.0 이하 (장기 평균)",
    danger: "+1.0 이상 (시스템 위기 경보)",
    note: "18개 금융시장 지표를 종합한 복합 척도.",
  },
];

/** 해석 기준표의 칸 — 지표(행 머리)·정상 범위·위험 임계치·해석. */
const RISK_COLUMNS: readonly Column<(typeof RISK_TABLE)[number]>[] = [
  { key: "name", header: "지표 (지연 수준)", rowHeader: true, cell: (row) => row.name },
  { key: "normal", header: "정상 / 안정 범위", cell: (row) => row.normal },
  { key: "danger", header: "위험 / 발작 임계치", cell: (row) => row.danger },
  { key: "note", header: "성격 및 핵심 해석", cell: (row) => row.note },
];

const TITLE = "신용 리스크, 은행권 및 시장 변동성";

export function RiskSection({
  risk,
  loading,
  refreshError,
}: {
  risk: RiskIndicators | null;
  loading: boolean;
  /** 새로 읽기가 실패했으면 그 문구 — 앞서 받은 값을 보이는 중이라고 알립니다(QA-067). */
  refreshError?: string | null;
}) {
  if (loading && !risk) {
    return (
      <Panel title={TITLE}>
        <Loading />
      </Panel>
    );
  }
  if (!risk) {
    return (
      <Panel title={TITLE}>
        <EmptyState message="리스크 지표를 불러오지 못했습니다." />
      </Panel>
    );
  }

  return (
    <Panel
      title={TITLE}
      subtitle="주식·채권 변동성, 기업 부도 위험, 단기 자금경색, 종합 금융스트레스"
      source="FRED (공식) — 하이일드·CP·STLFSI4 · Yahoo Finance — ^VIX · MOVE는 ^TNX 변동성 기반 추정"
      actions={<Freshness refreshError={refreshError} />}
    >
      {/* 값·단위·변화(직전 대비)·기준일·출처 — 받지 못한 지표는 '—'와 '수집 실패', MOVE(추정)는 '대리 지표' 배지와 주의 상태 글(lib/macroScreen riskKpis). */}
      <KpiStrip label="신용·변동성 지표" items={riskKpis(risk)} keepDates />

      <div className="mt-4">
        {/* 참고 표라 처음에는 접어 둡니다(긴 화면 — 실행 명세 §9-10). */}
        <CriteriaDetails summary="신용·은행권·변동성 핵심 해석 기준표">
          <DataTable columns={RISK_COLUMNS} rows={RISK_TABLE} rowKey={(row) => row.name} caption="신용·은행권·변동성 핵심 해석 기준표" scrollHint="overflow" />
        </CriteriaDetails>
      </div>
    </Panel>
  );
}
