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
import { Callout, ErrorState, LINK_CLASSES, Panel, SKELETON_BAR, SourceBadge, SourceLine } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useWideShell } from "@/hooks/useWideShell";
import { MACRO_PENDING_ROWS, type MacroIndicatorGroup, type MacroIndicatorRow, macroRowIndex } from "@/lib/macroScreen";
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

/** 좁은 화면(md 미만 — 390 등)인가 — 지표 표를 두 줄 행으로 그립니다(결정 9). 질의가 맞지 않거나 모르면(서버·matchMedia 없음) 네 칸 표. */
const NARROW_TABLE_MEDIA = "(width < 48rem)";

/**
 * 좁은 화면 줄의 둘째 줄(이름 칸 안 — 결정 9): 변화 칩과 추정·이전 값 배지·카드 경고. 표가 이름·값 두 칸이라 가로로 넘기지 않아도 한 줄을 읽는 데
 * 필요한 것이 모두 보입니다(추정·이전 값 배지는 늘 보임). 변화 칩 앞에는 낭독기 전용 '변화' — 변화 칸 머리가 없는 표라서.
 * 출처·장 상태·지연·시각(넓은 화면의 기준 칸)은 이름 단추가 여는 미리보기 대화상자에 있습니다.
 */
function NarrowRowLine({ row }: { row: MacroIndicatorRow }) {
  return (
    <span data-macro-narrow-line="" className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="whitespace-nowrap">
        <span className="sr-only">변화 </span>
        {changeCell(row)}
      </span>
      <EstimateBadge estimated={row.isEstimated} />
      <StaleBadge stale={row.isStale} reason={row.staleReason} />
      {row.cardWarning ? <CardWarning text={row.cardWarning} /> : null}
    </span>
  );
}

/**
 * 지표 표의 칸 — 지표(행 머리 — 미리보기를 여는 이름 단추와 '티커 · 시장') · 값 · 변화(칩) · 기준(출처·장 상태·열린 장의 지연·시각, 예전 저장본의 알림,
 * 추정·이전 값 배지, 카드 경고). 홈 시장 표와 같은 칸이고, 이름은 지표 상세 링크 대신 미리보기 단추입니다(상세는 미리보기의 '지표 상세 열기').
 * 좁은 화면(`narrow` — md 미만)은 지표·값 두 칸이고 이름 칸에 둘째 줄(변화 칩·추정·이전 값 배지·경고)을 둡니다 — 2026-11-17 결정 9(사용자 위임 — 권장안 가):
 * 예전에는 332px 상자 안 640px 표라 변화 칸이 잘리고 기준 칸(배지 포함)은 가로로 넘겨야 보였습니다.
 */
function indicatorColumns(inspector: InspectorContext, narrow: boolean): Column<MacroIndicatorRow>[] {
  const name: Column<MacroIndicatorRow> = {
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
        {narrow ? <NarrowRowLine row={row} /> : null}
      </span>
    ),
  };
  const value: Column<MacroIndicatorRow> = { key: "value", header: "값", align: "right", cell: valueCell };
  if (narrow) {
    return [name, value];
  }
  return [
    name,
    value,
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

/** 자리표시 막대(공용 ui/classes SKELETON_BAR — 공용 Skeleton 막대와 같은 모양). */
const BAR = `block ${SKELETON_BAR}`;

/**
 * 개요를 처음 읽는 동안의 지표 패널 — 범주 블록(MACRO_PENDING_ROWS — 범주 다섯·줄 21개, 자리일 뿐 보이는 수가 아님)마다 범주 머리(제목·출처 줄)·표 머리 줄·
 * 줄 자리를 값이 온 뒤의 표와 같은 꼴로 그립니다(QA-653). 줄 자리는 공용 표 줄과 같은 여백·구분선에 이름 칸(이름 단추 줄 — 좁은 화면 44px·넓은 화면 24px,
 * '티커 · 시장' 줄, 좁은 화면 두 줄 행의 둘째 줄)과 값 칸 막대라, 줄 높이가 좁은 화면 109px·md 85px·lg 이상 52px로 값이 온 뒤 기준 칸이 한 줄인 줄과
 * 같습니다(기준 칸이 꺾이거나 배지 줄이 있는 줄·옆 미리보기 배치에서는 값이 온 뒤가 더 깁니다). 예전에는 '불러오는 중' 한 줄(패널 147px)이라 값이 오면
 * 아래 절(환율 비교 — 1024에서 화면 안)이 화면 밖으로 밀렸습니다(첫 적재 CLS 1024 약 0.5). 글·숫자는 없고 막대는 읽기에서 뺍니다(이름 있는 읽는 중 상태 하나).
 */
function IndicatorsPending() {
  return (
    <div role="status" aria-busy="true" aria-label="매크로 지표를 불러오는 중" className="flex min-w-0 flex-col gap-5">
      <span className="sr-only">매크로 지표를 불러오는 중</span>
      {MACRO_PENDING_ROWS.map((rows, block) => (
        <div key={block} aria-hidden="true" data-macro-pending-block="" className="min-w-0">
          {/* 범주 머리 — 제목(14/20)·출처 줄(위 4px + 12/16) */}
          <div className="mb-2">
            <span className="flex h-5 items-center">
              <span className={`h-3.5 w-36 ${BAR}`} />
            </span>
            <span className="mt-1 flex h-4 items-center">
              <span className={`h-3 w-48 max-w-full ${BAR}`} />
            </span>
          </div>
          {/* 표 머리 줄(32px — 아래 선) */}
          <div className="flex h-8 items-center justify-between border-b border-border px-3">
            <span className={`h-3 w-10 ${BAR}`} />
            <span className={`h-3 w-8 ${BAR}`} />
          </div>
          {Array.from({ length: rows }, (_, row) => (
            <div
              key={row}
              data-macro-pending-row=""
              className={`flex items-start justify-between gap-3 px-3 ${row < rows - 1 ? "border-b border-border-subtle py-3 lg:pt-1.5 lg:pb-[5px]" : "py-3 lg:py-1.5"}`}
            >
              <span className="flex min-w-[7.5rem] flex-col">
                <span className="flex h-11 items-center lg:h-6">
                  <span className={`h-3.5 w-36 ${BAR}`} />
                </span>
                <span className="flex h-4 items-center">
                  <span className={`h-3 w-24 ${BAR}`} />
                </span>
                <span className="mt-1 flex h-5 items-center md:hidden">
                  <span className={`h-3.5 w-28 ${BAR}`} />
                </span>
              </span>
              <span className="flex h-11 shrink-0 items-center lg:h-6">
                <span className={`h-3.5 w-16 ${BAR}`} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * 지표 패널 — 범주마다 작은 제목(h3)·지연 요약 부제·출처 줄과 공용 표, 고른 지표의 미리보기 검사 칸(작업대 실행 명세 §7 3행 '목록-검사').
 *
 * - 검사 칸 틀은 `lg` 배치(틀 52rem부터 옆 18rem — 목차가 2xl부터 왼쪽 칸이라 메뉴 220에서 1280부터 옆 칸, 그 아래·좁은 화면은 위쪽 대화상자). 넓은 화면 처음은
 *   첫 지표를 보입니다.
 * - 표는 md~lg(768~1023)에서만 최소 폭 640px + 넘김 안내(이름 칸이 44px 단추라 한 칸에 눌리지 않게). 넓은 화면은 옆 미리보기와 나란히 놓여 표 폭이
 *   532~640px이라 최소 폭을 두지 않습니다(기준 칸이 줄을 바꿈 — 넘김 없이). md 미만은 지표·값 두 칸의 두 줄 행이라 최소 폭·넘김이 없습니다(결정 9 —
 *   기준은 이름 단추가 여는 미리보기 대화상자).
 * - 범주 블록은 절 닻(SectionAnchor — 목차의 범주 칸, id macro-cat-…)입니다.
 * - 값이 오기 전에는 표 꼴 자리(IndicatorsPending — QA-653), 첫 읽기가 실패하면 오류와 다시 시도, 저장본이 없으면 그 안내.
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
  const narrow = useMediaQuery(NARROW_TABLE_MEDIA);
  const rows = groups ?? [];
  const index = macroRowIndex(rows);
  const total = rows.reduce((sum, group) => sum + group.rows.length, 0);
  const first = rows.find((group) => group.rows.length > 0)?.rows[0]?.id ?? null;

  return (
    <Panel title="지표" count={groups === null ? undefined : `${total.toLocaleString("ko-KR")}개`}>
      {loading && groups === null && <IndicatorsPending />}
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
            const columns = indicatorColumns(inspector, narrow);
            return (
              <div className="flex min-w-0 flex-col gap-5">
                {rows.map((group) => (
                  // 범주 절 닻 — 목차의 '지표' 아래 하위 칸이 가리킵니다(id macro-cat-…).
                  <SectionAnchor key={group.id} id={group.anchorId} columnFrom="2xl">
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
                      scrollHint={wide || narrow ? false : "overflow"}
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
