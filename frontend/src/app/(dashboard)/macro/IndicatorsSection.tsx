"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import {
  ChangeCell,
  type Column,
  DataTable,
  Empty,
  EstimateBadge,
  type InspectorContext,
  InspectorFrame,
  InspectorTrigger,
  type PropertyItem,
  PropertyList,
  ProvenanceBadge,
  SectionAnchor,
  StaleBadge,
} from "@/components/patterns";
import { Callout, ErrorState, LINK_CLASSES, Loading, Panel, SourceBadge, SourceLine } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { useWideShell } from "@/hooks/useWideShell";
import { type MacroIndicatorGroup, type MacroIndicatorRow, macroRowIndex } from "@/lib/macroScreen";
import { assetValueText } from "@/lib/patternRows";

/** 값 칸 — 수집기 priceStr('N/A'면 '—'), 수집 실패는 '—'와 사유. */
function valueCell(row: MacroIndicatorRow): ReactNode {
  if (row.failed) {
    return (
      <span className="text-text-3">
        <Empty reason="수집 실패" />
      </span>
    );
  }
  return assetValueText(row.value, row.valueText);
}

/** 변화 칸 — 공용 표 칸 변화(ChangeCell): 직전 값이 없는 카드(delta·pct 모두 null)는 '—'(0.00%를 만들지 않음). 변화량 자릿수는 수집기 deltaStr을 따르고 칸 안에서 꺾지 않습니다. */
function changeCell(row: MacroIndicatorRow): ReactNode {
  return <ChangeCell change={row.change} changePct={row.changePct} digits={row.changeDigits ?? 2} pctDigits={2} />;
}

/** 미리보기의 변화 — 모르면 null(속성 목록이 '—'를 그림), 알면 표 칸과 같은 칩. */
function previewChange(row: MacroIndicatorRow): ReactNode {
  return row.change === null && row.changePct === null ? null : changeCell(row);
}

/** 카드 경고(선물 대신 지수 값 등) — 경고 아이콘 + 글 + 낭독 머리말 '주의: '(색만으로 전하지 않음). */
function CardWarning({ text }: { text: string }) {
  return (
    <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />} className="text-xs">
      {text}
    </StatusText>
  );
}

/**
 * 지표 표의 칸 — 지표(행 머리 — 미리보기를 여는 이름 단추와 '티커 · 시장') · 값 · 변화(칩) · 기준(출처·장 상태·열린 장의 지연·시각, 예전 저장본의 알림,
 * 추정·이전 값 배지, 카드 경고). 홈 시장 표와 같은 칸이고, 이름은 지표 상세 링크 대신 미리보기 단추입니다(상세는 미리보기의 '지표 상세 열기').
 */
function indicatorColumns(inspector: InspectorContext): Column<MacroIndicatorRow>[] {
  return [
    {
      key: "name",
      header: "지표",
      rowHeader: true,
      // 이름 칸은 최소 7.5rem — 옆 미리보기와 나란한 넓은 화면(표 약 590px)에서 기준 칸이 폭을 다 가져가 'DX-Y.NYB · 외환시장'·짧은 이름까지
      // 줄을 바꾸던 것(자기 빌드 1440 — 이름 칸 약 100px).
      cell: (row) => (
        <span className="flex min-w-[7.5rem] flex-col items-start">
          <InspectorTrigger inspector={inspector} itemKey={row.id}>
            {row.name}
          </InspectorTrigger>
          {row.sub ? <span className="break-keep text-xs text-text-3">{row.sub}</span> : null}
        </span>
      ),
    },
    { key: "value", header: "값", align: "right", cell: valueCell },
    { key: "change", header: "변화", align: "right", cell: changeCell },
    {
      key: "basis",
      header: "기준",
      cell: (row) => (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {/* 출처 · 장 상태 · 지연(열린 장만) · 시각 — 닫힌 장이라 적지 않은 지연은 툴팁(lib/marketRows macroCardRow). 실시간 줄의 시각은 받은·거래 시각.
              날짜·시각은 마디 사이에서만 꺾습니다(keepDates — 좁은 기준 칸에서 '2026-11-' / '04'로 갈렸음). */}
          <ProvenanceBadge source={row.source} asOf={row.asOf} delayMin={row.delayMin} title={row.provenanceTitle} keepDates />
          {row.legacyNote ? <SourceBadge>{row.legacyNote}</SourceBadge> : null}
          <EstimateBadge estimated={row.isEstimated} />
          <StaleBadge stale={row.isStale} reason={row.staleReason} />
          {row.cardWarning ? <CardWarning text={row.cardWarning} /> : null}
        </span>
      ),
    },
  ];
}

/**
 * 미리보기 — 고른 지표의 속성(값 · 변화 · 전일 · 기준 시각 · 장 상태·지연 · 출처 · 전일값 출처 · 티커 · 알림)과 지표 상세 링크.
 * 개요 응답에 기간 시계열이 없어 스파크라인은 두지 않습니다(고를 때마다 시계열을 읽으면 화면의 요청 수가 바뀜) — 차트는 지표 상세가 그립니다.
 */
function IndicatorPreview({ row }: { row: MacroIndicatorRow }) {
  const items: PropertyItem[] = [
    {
      label: "값",
      value: row.failed ? null : assetValueText(row.value, row.valueText),
      emptyReason: row.failed ? "수집 실패" : null,
      isEstimated: row.isEstimated,
      isStale: row.isStale,
      staleReason: row.staleReason,
    },
    { label: "변화", value: previewChange(row) },
    { label: "전일", value: row.prevText },
    { label: "기준 시각", value: row.timeText },
    // 닫힌 장이라 출처 배지에 적지 않은 시세 지연은 여기서는 글로(툴팁에만 두지 않음).
    { label: "장 상태·지연", value: row.sessionText, note: row.provenanceTitle },
    { label: "출처", value: row.originSource },
    ...(row.prevSource ? [{ label: "전일값 출처", value: row.prevSource }] : []),
    { label: "티커", value: row.ticker, mono: true },
    ...(row.legacyNote ? [{ key: "legacy", label: "알림", value: row.legacyNote }] : []),
    ...(row.cardWarning ? [{ key: "warning", label: "경고", value: <CardWarning text={row.cardWarning} /> }] : []),
  ];
  return (
    <>
      <PropertyList items={items} dense />
      <Link href={row.href} className={`${LINK_CLASSES} mt-2`}>
        지표 상세 열기
      </Link>
    </>
  );
}

/**
 * 지표 패널 — 범주마다 작은 제목(h3)·지연 요약 부제·출처 줄과 공용 표, 고른 지표의 미리보기 검사 칸(작업대 실행 명세 §7 3행 '목록-검사').
 *
 * - 검사 칸 틀은 `lg` 배치(틀 52rem부터 옆 18rem — 1440에서 표 약 592px + 미리보기, 그 아래·좁은 화면은 위쪽 대화상자). 넓은 화면 처음은 첫 지표를 보입니다.
 * - 표는 좁은 화면(lg 미만)에서만 최소 폭 640px + 넘김 안내(이름 칸이 44px 단추라 한 칸에 눌리지 않게). 넓은 화면은 옆 미리보기와 나란히 놓여 표 폭이
 *   532~640px이라 최소 폭을 두지 않습니다(기준 칸이 줄을 바꿈 — 넘김 없이).
 * - 범주 블록은 절 닻(SectionAnchor — 목차의 범주 칸, id macro-cat-…)입니다.
 * - 값이 오기 전에는 읽는 중, 첫 읽기가 실패하면 오류와 다시 시도, 저장본이 없으면 그 안내.
 */
export function IndicatorsSection({
  groups,
  loading,
  error,
  onRetry,
  unavailableMessage,
}: {
  /** 개요를 받기 전이면 null. */
  groups: readonly MacroIndicatorGroup[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** 개요가 저장본 없음(available=false)이면 그 안내 — 아니면 null. */
  unavailableMessage: string | null;
}) {
  const wide = useWideShell();
  const rows = groups ?? [];
  const index = macroRowIndex(rows);
  const total = rows.reduce((sum, group) => sum + group.rows.length, 0);
  const first = rows.find((group) => group.rows.length > 0)?.rows[0]?.id ?? null;

  return (
    <Panel title="지표" count={groups === null ? undefined : `${total.toLocaleString("ko-KR")}개`}>
      {loading && groups === null && <Loading label="매크로 지표를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={onRetry} />}
      {unavailableMessage !== null && (
        <div className="mb-3">
          <Callout tone="warn">{unavailableMessage}</Callout>
        </div>
      )}
      {rows.length > 0 && (
        <InspectorFrame
          label="지표 미리보기"
          layout="lg"
          titleOf={(key) => index.get(key)?.name ?? null}
          renderDetail={(key) => {
            const row = index.get(key);
            return row ? <IndicatorPreview row={row} /> : null;
          }}
          defaultKey={first}
        >
          {(inspector) => {
            const columns = indicatorColumns(inspector);
            return (
              <div className="flex min-w-0 flex-col gap-5">
                {rows.map((group) => (
                  // 범주 절 닻 — 목차의 '지표' 아래 하위 칸이 가리킵니다(id macro-cat-…).
                  <SectionAnchor key={group.id} id={group.anchorId} columnFrom="xl">
                    <div className="mb-2">
                      <h3 className="text-sm font-semibold text-text">{group.title}</h3>
                      {group.subtitle ? <p className="mt-0.5 break-keep text-caption text-text-2">{group.subtitle}</p> : null}
                      {group.source ? <SourceLine>{group.source}</SourceLine> : null}
                    </div>
                    <DataTable
                      columns={columns}
                      rows={group.rows}
                      rowKey={(row) => row.id}
                      caption={`${group.title} 지표`}
                      scrollHint={wide ? false : "overflow"}
                      selectedKey={inspector.shownKey}
                    />
                  </SectionAnchor>
                ))}
              </div>
            );
          }}
        </InspectorFrame>
      )}
    </Panel>
  );
}
