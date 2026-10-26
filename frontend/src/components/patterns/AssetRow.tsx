"use client";

import Link from "next/link";
import { useId, type JSX, type ReactNode } from "react";

import { assetRowModel } from "@/lib/patternRows";

import { EstimateBadge, ProvenanceBadge, StaleBadge } from "./badges";
import { ChangeChip } from "./ChangeChip";
import { Empty } from "./Empty";
import { Sparkline } from "./Sparkline";

/** 자산 행 한 줄의 자료(설계서 §5). 값을 모르면 `value: null` — 0으로 채우지 않습니다. */
export type AssetRowData = {
  id: string;
  name: string;
  sub?: string | null;
  value: number | null;
  /** 서식된 값(예: 수집기 priceStr) — 있으면 `value` 서식보다 우선. "N/A"는 "—". */
  valueText?: string | null;
  unit?: string | null;
  change?: number | null;
  changePct?: number | null;
  spark?: readonly (number | null)[];
  asOf?: string | null;
  delayMin?: number | null;
  live?: boolean;
  source?: string | null;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  warning?: string | null;
  href?: string;
};

// 행 높이 54px(데스크톱 한 줄). 배지가 있으면 둘째 줄로 내려가 행이 늘어납니다.
const ROW = "relative flex min-h-[54px] w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-left";
// 행은 카드 폭을 꽉 채우므로 포커스 링을 안쪽으로 그립니다(바깥으로 그리면 카드 테두리 밖으로 삐져나감).
// hover에 surface-2 바탕을 깔지 않습니다 — 그 위에서는 상승·하락 글자가 4.5:1을 밑돕니다. 이름 밑줄로 대신합니다.
const INTERACTIVE = "group focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";

/**
 * 자산 행 — 이름·보조 → (스파크라인) → 값(+단위) → 변화 칩 → 배지(추정·이전 값·경고·출처).
 *
 * - 값을 모르면 "—"(단위 없음, QA-049). 변화를 모르면 칩을 생략합니다(0.00%를 만들지 않음).
 * - 추정·대리·이전 값·경고는 있으면 반드시 보입니다(숨기는 옵션 없음). 출처 배지는 `showProvenance`일 때.
 * - `row.href`면 링크, 아니고 `onSelect`면 버튼(aria-pressed = selected, 고른 행은 왼쪽 막대), 둘 다 없으면 그냥 줄입니다.
 */
export function AssetRow({
  row,
  onSelect,
  selected = false,
  showProvenance = false,
}: {
  row: AssetRowData;
  onSelect?: (id: string) => void;
  selected?: boolean;
  showProvenance?: boolean;
}): JSX.Element {
  const model = assetRowModel(row, showProvenance);
  const selectable = !row.href && onSelect !== undefined;
  const body: ReactNode = (
    <>
      {selectable && selected ? (
        <span aria-hidden="true" className="absolute inset-y-1 left-0 w-[3px] rounded-r bg-accent" />
      ) : null}
      <span className="flex min-w-0 flex-1 basis-32 flex-col">
        <span className="truncate text-[15px] font-medium leading-5 text-text group-hover:underline">{row.name}</span>
        {model.sub ? <span className="truncate text-xs leading-4 text-text-3">{model.sub}</span> : null}
      </span>
      {model.showSpark && row.spark ? (
        // 좁은 화면에서는 값·변화를 먼저 보이려고 스파크라인을 접습니다.
        <span className="hidden shrink-0 sm:block">
          <Sparkline values={row.spark} width={64} height={24} />
        </span>
      ) : null}
      <span className="flex shrink-0 flex-col items-end">
        {model.valueText === null ? (
          <span className="text-[15px] font-semibold leading-5 text-text-3">
            <Empty />
          </span>
        ) : (
          <span className="text-[15px] font-semibold leading-5 tabular-nums text-text">
            {model.valueText}
            {row.unit ? <span className="ml-0.5 text-xs font-normal text-text-3">{row.unit}</span> : null}
          </span>
        )}
        <ChangeChip change={row.change} changePct={row.changePct} size="sm" />
      </span>
      {model.hasBadges ? (
        <span className="flex basis-full flex-wrap items-center gap-1">
          <EstimateBadge estimated={row.isEstimated} proxy={row.isProxy} />
          <StaleBadge stale={row.isStale} reason={row.staleReason} />
          {model.warning ? (
            <span className="inline-flex items-center gap-1 text-xs leading-4 text-warn">
              <span aria-hidden="true">⚠️</span>
              <span className="sr-only">주의: </span>
              {model.warning}
            </span>
          ) : null}
          {showProvenance ? (
            <ProvenanceBadge source={row.source} asOf={row.asOf} delayMin={row.delayMin} live={row.live} />
          ) : null}
        </span>
      ) : null}
    </>
  );

  if (row.href) {
    return (
      <Link href={row.href} className={`${ROW} ${INTERACTIVE}`}>
        {body}
      </Link>
    );
  }
  if (onSelect) {
    return (
      <button type="button" aria-pressed={selected} onClick={() => onSelect(row.id)} className={`${ROW} ${INTERACTIVE}`}>
        {body}
      </button>
    );
  }
  return <div className={ROW}>{body}</div>;
}

/**
 * 자산 행 목록 — 카드(1px 경계) 안에 제목(h2, 있으면 영역 이름)과 행들. 행 사이는 1px 윗선으로 나눕니다.
 *
 * - 행이 없으면 `emptyText`(기본 "표시할 항목이 없습니다.").
 * - `onSelect`·`selectedId`는 각 행에 넘깁니다(href가 있는 행은 링크가 이김).
 * - `showProvenance`는 설계서 §1.5 계약에 더한 선택 prop입니다 — 모든 행에 출처 배지를 붙입니다.
 * - `children`은 행 아래에 그립니다(더 보기 링크·주석 등).
 */
export function AssetList({
  title,
  rows,
  emptyText = "표시할 항목이 없습니다.",
  onSelect,
  selectedId,
  showProvenance = false,
  children,
}: {
  title?: string;
  rows: readonly AssetRowData[];
  emptyText?: string;
  onSelect?: (id: string) => void;
  selectedId?: string | null;
  showProvenance?: boolean;
  children?: ReactNode;
}): JSX.Element {
  const headingId = useId();
  return (
    <section aria-labelledby={title ? headingId : undefined} className="min-w-0 rounded-xl border border-border bg-surface">
      {title ? (
        <h2 id={headingId} className="px-4 pb-1 pt-4 text-sm font-medium text-text-2">
          {title}
        </h2>
      ) : null}
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-text-3">{emptyText}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="border-t border-border first:border-t-0">
              <AssetRow
                row={row}
                onSelect={onSelect}
                selected={selectedId === row.id}
                showProvenance={showProvenance}
              />
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}
