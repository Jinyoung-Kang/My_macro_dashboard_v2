"use client";

import { useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { ariaSortOf, nextSort, sortRows, type SortState, type SortValue } from "@/lib/dataTable";
import { isMissingValue } from "@/lib/patterns";

import { Empty } from "./Empty";

/**
 * 열 정의.
 *
 * - `align: "right"`는 숫자 열 — 머리·칸을 오른쪽 정렬하고 `tabular-nums`로 자릿수를 맞춥니다.
 * - `sortValue`가 있는 열만 머리에 정렬 단추가 생깁니다. 모르는 값(null·"N/A"·"—")은 방향과 무관하게 맨 뒤(`lib/dataTable.ts`).
 * - `cell`이 null·빈 글·"N/A"를 돌려주면 칸에 "—"(Empty)를 그립니다 — 0으로 채우지 않습니다.
 */
export type Column<T> = {
  key: string;
  header: string;
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
  sortValue?: (row: T) => SortValue;
  className?: string;
};

/** 칸 안의 링크·단추·입력에서 시작한 클릭인가 — 그 조작을 행 클릭으로 한 번 더 받지 않습니다. */
function fromInnerControl(event: MouseEvent<HTMLTableRowElement>): boolean {
  const target = event.target as HTMLElement | null;
  const control = target?.closest("a, button, input, select, textarea, label, summary");
  return control !== null && control !== undefined && event.currentTarget.contains(control);
}

/**
 * 밀도 높은 표 — 열 정렬, 고정 머리, 행 클릭(선택), 가로 스크롤.
 *
 * - 정렬 단추는 머리 칸(`<th>`) 안의 `<button>`이고, 지금 정렬한 열의 `<th>`에만 `aria-sort`가 붙습니다. 새 열은 오름차순부터, 다시 누르면 반대로.
 * - 넓은 표는 감싼 상자(overflow-x-auto) 안에서만 좌우로 넘어갑니다 — 페이지 폭을 넓히지 않습니다. 상자는 Tab으로 닿아 화살표로 넘길 수 있습니다.
 * - 머리는 `sticky top-0`입니다. 가로 스크롤 상자는 CSS상 세로로도 스크롤 상자가 되므로, 머리가 실제로 붙어 있으려면 상자에 높이 한도가
 *   있어야 합니다 — `maxHeight`(px)를 주면 그 높이에서 세로로도 스크롤되고 머리가 위에 남습니다(설계서 §1.5 계약에 더한 선택 props).
 * - `onRowClick`이 있으면 행이 Tab으로 닿고(tabIndex 0) Enter·Space로도 열립니다. 마우스를 올리면 첫 칸에 밑줄 — 바탕은 칠하지 않습니다
 *   (surface-2 위에서는 칸 안의 상승·하락 글자가 4.5:1을 밑돎, AssetRow와 같은 규칙).
 * - 모르는 칸의 "—"는 보조 글자색(text-3) — 타일·히어로·자산 행과 같습니다.
 * - 행이 없으면 머리는 그대로 두고 `emptyText` 한 줄.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  emptyText = "표시할 데이터가 없습니다.",
  onRowClick,
  initialSort,
  maxHeight,
}: {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** 표 이름 — 화면 낭독기용 `<caption>`(눈에는 숨김, 보이는 제목은 카드가 적음). */
  caption?: string;
  emptyText?: string;
  onRowClick?: (row: T) => void;
  initialSort?: SortState;
  maxHeight?: number;
}): JSX.Element {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const sortColumn = sort ? columns.find((column) => column.key === sort.key && column.sortValue) : undefined;
  // 정렬할 수 없는 열을 가리키는 정렬 상태(잘못된 initialSort)는 없는 것으로 봅니다 — aria-sort도 붙이지 않음.
  const activeSort = sortColumn ? sort : null;
  const shown = sortColumn && activeSort ? sortRows(rows, sortColumn.sortValue, activeSort.dir) : rows;

  const alignOf = (column: Column<T>) =>
    column.align === "right" ? "text-right tabular-nums whitespace-nowrap" : "text-left";

  const activate = onRowClick
    ? {
        onClick: (row: T) => (event: MouseEvent<HTMLTableRowElement>) => {
          if (!fromInnerControl(event)) {
            onRowClick(row);
          }
        },
        onKeyDown: (row: T) => (event: KeyboardEvent<HTMLTableRowElement>) => {
          // 행 자신에 포커스가 있을 때만 — 칸 안 단추의 Enter·Space는 그 단추의 몫입니다.
          if (event.target !== event.currentTarget) {
            return;
          }
          if (event.key === "Enter" || event.key === " ") {
            // Space의 기본 동작(페이지 스크롤)을 막습니다.
            event.preventDefault();
            onRowClick(row);
          }
        },
      }
    : null;

  return (
    <div
      className="w-full min-w-0 max-w-full overflow-x-auto rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      style={maxHeight !== undefined && maxHeight > 0 ? { maxHeight, overflowY: "auto" } : undefined}
      tabIndex={0}
      role="region"
      aria-label={`${caption ?? "표"} (좌우 스크롤)`}
    >
      <table className="w-full border-collapse text-sm">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className="sticky top-0 z-10 bg-surface">
          <tr className="border-b border-border">
            {columns.map((column) => {
              const ariaSort = ariaSortOf(activeSort, column.key);
              const arrow = ariaSort === "ascending" ? "↑" : ariaSort === "descending" ? "↓" : "↕";
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={`whitespace-nowrap px-3 py-2 text-xs font-medium text-text-3 ${alignOf(column)} ${column.className ?? ""}`}
                >
                  {column.sortValue ? (
                    <button
                      type="button"
                      onClick={() => setSort(nextSort(activeSort, column.key))}
                      className={`inline-flex items-center gap-1 rounded-sm hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                        ariaSort ? "text-text" : ""
                      }`}
                    >
                      {column.header}
                      {/* 방향은 aria-sort가 읽어 줍니다. 화살표는 눈으로 보는 보조 표시(정렬 전에는 흐린 ↕). */}
                      <span aria-hidden="true" className={ariaSort ? "" : "opacity-50"}>
                        {arrow}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {shown.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-3 py-6 text-center text-sm text-text-3">
                {emptyText}
              </td>
            </tr>
          ) : (
            shown.map((row) => (
              <tr
                key={rowKey(row)}
                tabIndex={activate ? 0 : undefined}
                onClick={activate ? activate.onClick(row) : undefined}
                onKeyDown={activate ? activate.onKeyDown(row) : undefined}
                className={`border-b border-border last:border-0 ${
                  activate
                    ? "group cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                    : ""
                }`}
              >
                {columns.map((column, index) => {
                  const content = column.cell(row);
                  return (
                    <td
                      key={column.key}
                      className={`px-3 py-2 text-text ${activate && index === 0 ? "group-hover:underline" : ""} ${alignOf(column)} ${column.className ?? ""}`}
                    >
                      {isMissingValue(content) ? (
                        <span className="text-text-3">
                          <Empty />
                        </span>
                      ) : (
                        content
                      )}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
