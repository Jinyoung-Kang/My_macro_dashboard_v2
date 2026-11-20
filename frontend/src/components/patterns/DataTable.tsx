"use client";

import { useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { SELECTED_BAR } from "@/components/ui/classes";
import { ariaSortOf, nextSort, sortRows, type SortState, type SortValue } from "@/lib/dataTable";
import { isMissingValue } from "@/lib/patterns";

import { Empty } from "./Empty";
import { useScrollRegion } from "./useScrollRegion";

/**
 * 열 정의.
 *
 * - `align: "right"`는 숫자 열 — 머리·칸을 오른쪽 정렬하고 `tabular-nums`로 자릿수를 맞춥니다.
 * - `sortValue`가 있는 열만 머리에 정렬 단추가 생깁니다. 모르는 값(null·"N/A"·"—")은 방향과 무관하게 맨 뒤(`lib/dataTable.ts`).
 * - `cell`이 null·빈 글·"N/A"를 돌려주면 칸에 "—"(Empty)를 그립니다 — 0으로 채우지 않습니다.
 */
export type Column<T> = {
  key: string;
  /**
   * 머리 글 — 보통 글 하나. 보이는 표지와 읽는 글이 다른 머리(장식 기호는 aria-hidden, 뜻은 sr-only 글 — 섹터 표의 순위 기준 열, QA-649)는 요소로 줍니다.
   * 글로 주면 예전과 같습니다.
   */
  header: ReactNode;
  align?: "left" | "right";
  cell: (row: T) => ReactNode;
  sortValue?: (row: T) => SortValue;
  className?: string;
  /**
   * 이 열의 칸을 행 머리(`<th scope="row">`)로 그립니다 — 줄이 항목인 표(예: 계좌 비교 — 줄 = 항목, 열 = 계좌)에서 낭독기가 칸을 옮길 때
   * 열 머리(계좌)와 함께 그 줄의 항목 이름도 읽게. 설계서 §1.5 계약에 더한 선택 prop입니다(보통은 첫 열 하나에만).
   */
  rowHeader?: boolean;
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
 * - 넓은 표는 감싼 상자(overflow-x-auto) 안에서만 좌우로 넘어갑니다 — 페이지 폭을 넓히지 않습니다. 상자가 실제로 넘칠 때만 Tab으로 닿아 화살표로 넘길 수
 *   있는 이름 있는 영역 '{caption} (좌우 스크롤)'입니다(공용 계약 useScrollRegion — 재기 전·잴 수 없으면 정지점을 둠, QA-939). 넘치지 않으면 정지점·영역·이름이
 *   없고(표 이름은 caption), 부르는 쪽 포커스 되돌림 자리로 tabIndex -1과 `data-scroll-box` 표지만 남습니다.
 * - 머리는 `sticky top-0`입니다. 가로 스크롤 상자는 CSS상 세로로도 스크롤 상자가 되므로, 머리가 실제로 붙어 있으려면 상자에 높이 한도가
 *   있어야 합니다 — `maxHeight`(px)를 주면 그 높이에서 세로로도 스크롤되고 머리가 위에 남습니다(설계서 §1.5 계약에 더한 선택 props).
 *   선은 행(tr)이 아니라 칸(th·td)의 아래 테두리로 긋고 표는 `border-separate border-spacing-0`입니다 — 겹친 테두리(border-collapse) 표의
 *   선은 sticky 칸을 따라 움직이지 않아, 표를 내리면 머리 아래 선이 사라지고 행이 경계 없이 머리 밑으로 들어갔습니다. 그림자(box-shadow)로
 *   긋지 않는 까닭은 고대비(forced-colors) 모드가 그림자를 지워 머리 선이 늘 없어지기 때문입니다(테두리는 시스템 색으로 남음).
 * - 행 높이(작업대 실행 명세 docs/specs/2026-11-15-v2-workbench-ui.md §3-7): 넓은 화면(lg 이상) 기본 32px, `dense`(로그·출처 같은 조밀 표)면
 *   28px — 칸 글(14/20)에 위아래 여백과 칸 아래 구분선(1px)을 더한 높이입니다. 구분선을 높이 안에 넣으려고 선이 있는 칸은 아래 여백을 1px 줄입니다
 *   (6 + 20 + 5 + 1 = 32, 4 + 20 + 3 + 1 = 28 — 선이 없는 마지막 행은 위아래 같은 여백, 머리 줄도 아래 선까지 32·28px). 예전에는 선을 더해 33·29px였습니다
 *   (2026-11-16 검토 지적, 머리 없는 크롬으로 잼). 칸 안이 두 줄이면 그만큼 늘어납니다. 좁은 화면(lg 미만)에서는 모든 행이 44px 이상입니다 —
 *   누를 수 있는 행(`onRowClick`)은 손가락 누름 자리(원칙 A8)이고, 누를 수 없는 행도 칸 안 종목 글 단추처럼 행마다 있는 작은 단추 사이를
 *   좁히지 않으려고 예전 높이를 둡니다(밀도는 넓은 화면에서만 올림 — 명세 §10 '휴대폰 밀도'). 머리 줄은 32·28px이고, 정렬 머리 단추는 lg 미만에서
 *   44px입니다(그 위에 포커스 링 자리 4px). 행 사이 구분선은 옅은 경계(border-subtle), 머리 아래 선은 경계(border)입니다.
 *   칸 안의 테두리 있는 태그(추정·이전 값 배지·공용 Tag — 12/16 글 + 위아래 1px + 테두리 = 20px, 글 흐름 안에서는 줄 위에 맞춤 — 2026-11-16 결정)는
 *   칸 글줄(20px)과 같은 높이라 태그가 든 행도 넓은 화면 32·28px 그대로입니다(머리 없는 크롬으로 잼 — 태그 없는 행과 같음. 예전 22px 태그는 그 행을
 *   2px 늘렸음). 태그가 두 줄로 접히면 그만큼 늘어납니다.
 * - 칸 안 조작(단추·고르기 상자)은 작은 크기(sm — 넓은 화면 24px)로 둡니다(명세 §3-7 '작은 것 24px(표 안)') — 기본 30px이면 행이 32·28px 단계에 오지 못합니다
 *   (D1 QA 'table-cell-controls-md-30' — 그 세 자리는 P7 화면). 칸 안에 링크만 있는 표는 그대로입니다.
 * - `onRowClick`이 있으면 행이 Tab으로 닿고(tabIndex 0) Enter·Space로도 열립니다. 마우스를 올리면 바탕(surface-2)과 첫 칸 밑줄 —
 *   surface-2 위에서도 칸 안의 상승·하락·보조 글자가 4.5:1 이상입니다(토큰 대비, 명세 §3-2 — AssetRow와 같은 규칙). 누를 수 없는 행에는 hover 표시가 없습니다.
 * - `count`(선택): 표 위에 행 개수 줄('12건' — 함수를 주면 그 글)을 둡니다(명세 §3-7 '표와 목록 머리에는 개수'). 보이는 제목·개수를 이미 적는
 *   카드 머리가 있는 화면은 주지 않습니다. 행이 없으면 '0건'입니다.
 * - `selectedKey`(선택, 기본 없음): 고른 행(옆 칸에 상세가 열린 행 등)의 `rowKey` — 그 행에 중립 바탕(surface-2)과 첫 칸 왼쪽 3px 잉크 막대
 *   (`SELECTED_BAR` — 자산 행·정보 검색과 같은 꼴, 명세 §3-8, 고대비 모드에서는 같은 폭의 테두리)를 그리고 `aria-current="true"`로 읽힙니다.
 *   데이터 영역이라 강조 파랑을 쓰지 않습니다(A1). 무엇을 고를지와 고른 뒤의 일은 부르는 쪽이 정합니다(보통 `onRowClick`과 함께).
 * - 모르는 칸의 "—"는 보조 글자색(text-3) — 타일·히어로·자산 행과 같습니다. 칸 글자는 모두 `tabular-nums`(날짜·시각 열도 자릿수가 맞게).
 * - `scrollHint`(계약에 더한 선택 prop): 폰에서 좌우로 넘겨야 하는 넓은 표 — 표를 최소 640px로 두고 그 폭(sm) 아래에서만 "← 표를 좌우로
 *   넘겨 보세요" 한 줄을 띄웁니다(옛 ui Table과 같음). 스크롤바가 안 보이는 기기에서는 오른쪽에 칸이 더 있다는 것을 알 수 없어서이고,
 *   최소 폭과 안내가 같은 경계라 안내가 거짓이 되지 않습니다. 행이 없으면 둘 다 없습니다(넘길 칸이 없음).
 *   `scrollHint="overflow"`는 여기에 더해 상자 폭을 재서(ResizeObserver) 표가 상자보다 넓으면 폭과 상관없이 안내를 보입니다 — 데스크톱에서도
 *   칸이 많은 표가 넘치면(스크롤바가 숨는 환경에서는 단서가 없음) 가려진 칸이 있다는 것을 알 수 있게. 잴 수 없는 환경이면 `true`와 같습니다.
 * - 행이 없으면 머리는 그대로 두고 `emptyText` 한 줄 — 상자의 보이는 폭에 붙입니다. 열이 많은 표는 머리 칸이 줄을 바꾸지 않아 좁은 화면에서
 *   상자보다 넓어지는데, 문구를 표 전체 폭의 가운데에 두면 상자 밖으로 밀려 잘렸습니다(QA-503 — 390px '최근 실제 주문'). 그래서 행이 없을 때만
 *   상자를 크기 질의 기준(`@container`, container-type: inline-size)으로 두고, 합친 칸 안의 문구를 `sticky left-0`·상자 폭(`100cqw`)으로 그려
 *   좌우로 넘겨도 그 자리에 남습니다. 크기 질의 기준은 내용 폭을 바깥에 알리지 않아(0) 내용 폭에 맞춰 줄어드는 부모(자동 basis flex 행 항목·
 *   inline-block·w-fit·auto 격자 칸)에서는 상자가 옆 글 폭까지 줄어듭니다 — 그래서 행이 있는 표에는 붙이지 않습니다(2026-11-16 검토 지적:
 *   붙이면 그런 부모 안에서 상자가 표보다 좁아져 표가 잘림). 행 없는 표를 그런 자리에 둘 때만 바깥이 폭을 정해 줍니다(minmax(0,1fr)·flex-1 등).
 *   칸 안의 크기 질의(@ 변형·cq 단위)는 이 상자를 기준으로 삼지 않습니다(행이 있을 때 상자는 기준이 아님).
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
  scrollHint = false,
  dense = false,
  count,
  selectedKey,
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
  scrollHint?: boolean | "overflow";
  /** 조밀 표(행 28px — 로그·출처 같은 표). 기본은 32px. */
  dense?: boolean;
  /** 표 위 행 개수 줄 — true면 'N건', 함수면 그 글(위 설명). */
  count?: boolean | ((count: number) => string);
  /** 고른 행의 rowKey — 막대·바탕·aria-current(위 설명). */
  selectedKey?: string | null;
}): JSX.Element {
  const [sort, setSort] = useState<SortState | null>(initialSort ?? null);
  const sortColumn = sort ? columns.find((column) => column.key === sort.key && column.sortValue) : undefined;
  // 정렬할 수 없는 열을 가리키는 정렬 상태(잘못된 initialSort)는 없는 것으로 봅니다 — aria-sort도 붙이지 않음.
  const activeSort = sortColumn ? sort : null;
  const shown = sortColumn && activeSort ? sortRows(rows, sortColumn.sortValue, activeSort.dir) : rows;

  const alignOf = (column: Column<T>) => (column.align === "right" ? "text-right whitespace-nowrap" : "text-left");
  // 칸·머리의 위아래 여백 — 행 높이를 정합니다(위 설명: 넓은 화면 32·28px — 아래 구분선 1px 포함, 좁은 화면의 행은 모두 44px 이상).
  // 아래 선이 있는 칸(lined)은 넓은 화면 아래 여백을 1px 줄여 선까지 32·28px로 둡니다. Tailwind가 찾도록 클래스 이름을 통째로 적습니다.
  const cellY = (lined: boolean) =>
    dense ? (lined ? "py-3 lg:pt-1 lg:pb-[3px]" : "py-3 lg:py-1") : lined ? "py-3 lg:pt-1.5 lg:pb-[5px]" : "py-3 lg:py-1.5";
  const headY = dense ? "pt-1 pb-[3px]" : "pt-1.5 pb-[5px]";
  // 정렬 머리는 lg 미만에서 단추(44px)가 높이를 정하므로 아래 여백을 두지 않고, 위에만 4px를 남깁니다 — 머리 줄이 가로 스크롤 상자(세로로도 자르는
  // 스크롤 상자)의 위 끝에 붙어 있어, 여백이 없으면 단추의 바깥 포커스 링(2px + 간격 2px)의 위 변이 잘렸습니다(2026-11-16 검토 지적). 넓은 화면은 위 여백이 6·4px라 그대로.
  const sortHeadY = dense ? "pt-1 pb-0 lg:pb-[3px]" : "pt-1 pb-0 lg:pt-1.5 lg:pb-[5px]";
  const countText =
    count === undefined || count === false ? null : typeof count === "function" ? count(rows.length) : `${rows.length.toLocaleString("ko-KR")}건`;
  const wide = scrollHint !== false && shown.length > 0;
  // 스크롤 상자 — 넘칠 때만 Tab 정지점·이름 있는 영역(공용 계약 useScrollRegion, QA-939). 세로 한도(maxHeight)가 있으면 위아래 넘침도 봅니다.
  const boxRef = useRef<HTMLDivElement>(null);
  const { overflow, regionProps } = useScrollRegion(boxRef, `${caption ?? "표"} (좌우 스크롤)`, {
    axis: maxHeight !== undefined && maxHeight > 0 ? "both" : "x",
    watch: shown.length,
  });
  // "overflow" — 상자보다 표가 넓은지 재서 안내를 폭과 상관없이 보입니다(첫 관찰은 ResizeObserver가 observe 때 한 번 알려 줌).
  const measured = scrollHint === "overflow" && shown.length > 0;
  const overflowing = overflow?.x === true;

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
    <>
      {/* 눈으로 보는 안내 — 낭독기에는 감싼 상자의 이름("… (좌우 스크롤)")이 같은 말을 하므로 숨깁니다. 개수 줄이 있으면 그 줄 오른쪽에 둡니다. */}
      {countText !== null ? (
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-3">
          <p className="text-xs tabular-nums text-text-2">{countText}</p>
          {wide ? (
            <p aria-hidden="true" className={`text-xs text-text-3 ${measured && overflowing ? "" : "sm:hidden"}`}>
              ← 표를 좌우로 넘겨 보세요
            </p>
          ) : null}
        </div>
      ) : wide ? (
        <p aria-hidden="true" className={`mb-1 text-xs text-text-3 ${measured && overflowing ? "" : "sm:hidden"}`}>
          ← 표를 좌우로 넘겨 보세요
        </p>
      ) : null}
      <div
        ref={boxRef}
        // relative — 칸 안의 절대 위치 요소(변화 칩의 낭독용 글 sr-only 등)의 위치 기준을 이 상자로 둡니다. 아니면 그 요소가 상자에 잘리지 않고 본문의
        // 넘침이 되어, 넓은 화면(본문 overflow-x hidden)에서 그 글로 scrollIntoView(낭독기 훑기·찾기)하면 본문 전체가 옆으로 밀렸습니다(QA-631).
        className={`${shown.length === 0 ? "@container " : ""}relative w-full min-w-0 max-w-full overflow-x-auto rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
        style={maxHeight !== undefined && maxHeight > 0 ? { maxHeight, overflowY: "auto" } : undefined}
        data-scroll-box=""
        {...regionProps}
      >
        <table className={`w-full border-separate border-spacing-0 text-sm ${wide ? "min-w-[640px]" : ""}`}>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              {columns.map((column) => {
                const ariaSort = ariaSortOf(activeSort, column.key);
                const arrow = ariaSort === "ascending" ? "↑" : ariaSort === "descending" ? "↓" : "↕";
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={`whitespace-nowrap border-b border-border px-3 text-caption leading-5 font-medium text-text-2 ${column.sortValue ? sortHeadY : headY} ${alignOf(column)} ${column.className ?? ""}`}
                  >
                    {column.sortValue ? (
                      <button
                        type="button"
                        onClick={() => setSort(nextSort(activeSort, column.key))}
                        className={`inline-flex min-h-11 items-center gap-1 rounded-sm hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:min-h-0 ${
                          ariaSort ? "text-text" : ""
                        }`}
                      >
                        {column.header}
                        {/* 방향은 aria-sort가 읽어 줍니다. 화살표는 눈으로 보는 보조 표시(정렬 전에는 흐린 ↕ — 흐린 단계는 불투명도가 아니라 글자 토큰
                            text-3: 머리 바탕 surface 위 5.62:1. opacity-50은 토큰에 없는 색 #71767d(3.54:1)를 만들었음, QA-504). */}
                        <span aria-hidden="true" className={ariaSort ? "" : "text-text-3"}>
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
                {/* 문구는 표 전체 폭이 아니라 상자의 보이는 폭(100cqw — 행이 없을 때만 상자가 크기 질의 기준)에 붙입니다 — 넓은 표에서 상자 밖으로 밀리지 않게(위 설명, QA-503). */}
                <td colSpan={columns.length} className="p-0">
                  <div className="sticky left-0 w-[100cqw] px-3 py-6 text-center text-sm text-text-3">{emptyText}</div>
                </td>
              </tr>
            ) : (
              shown.map((row, rowIndex) => {
                const key = rowKey(row);
                const selected = selectedKey !== undefined && selectedKey !== null && key === selectedKey;
                const rowClass = [
                  activate
                    ? "group cursor-pointer hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
                    : "",
                  selected ? "bg-surface-2" : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr
                    key={key}
                    tabIndex={activate ? 0 : undefined}
                    onClick={activate ? activate.onClick(row) : undefined}
                    onKeyDown={activate ? activate.onKeyDown(row) : undefined}
                    aria-current={selected ? "true" : undefined}
                    className={rowClass || undefined}
                  >
                    {columns.map((column, index) => {
                      const content = column.cell(row);
                      // 행 사이 구분선은 칸의 아래 테두리(위 설명 — sticky 머리) — 마지막 행에는 긋지 않습니다(감싼 상자의 끝).
                      const lined = rowIndex < shown.length - 1;
                      const divider = lined ? "border-b border-border-subtle" : "";
                      // 고른 행의 막대는 첫 칸 안에 둡니다(칸이 relative — 행(tr)을 기준 상자로 쓰지 않음).
                      const bar = selected && index === 0;
                      const className = `px-3 ${cellY(lined)} ${divider} ${bar ? "relative" : ""} tabular-nums text-text ${activate && index === 0 ? "group-hover:underline" : ""} ${alignOf(column)} ${column.className ?? ""}`;
                      const value = isMissingValue(content) ? (
                        <span className="text-text-3">
                          <Empty />
                        </span>
                      ) : (
                        content
                      );
                      // 첫 칸은 고름과 상관없이 늘 '막대 자리 + 내용' 두 자식으로 그립니다 — 고를 때만 조각으로 바꾸면 React가 칸 안의 요소를 새로 만들어
                      // 첫 칸의 단추(검사 칸 틀의 줄 단추 등)로 그 행을 고를 때 누른 단추가 떨어져 포커스를 잃었습니다(QA-624 —
                      // 섹터·COT 갈래가 /cot 자산 단추로 따로 찾은 QA-630과 같은 결함, 통합 때 이 고침 하나로 합침). 막대가 없으면 자리는 비어 DOM이 같습니다.
                      const shownContent =
                        index === 0 ? (
                          <>
                            {bar ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
                            {value}
                          </>
                        ) : (
                          value
                        );
                      // 행 머리 칸은 굵게 그리지 않습니다(th 기본) — 보이는 모양은 다른 칸과 같고, 낭독기만 항목 이름으로 씁니다.
                      return column.rowHeader ? (
                        <th key={column.key} scope="row" className={`font-normal ${className}`}>
                          {shownContent}
                        </th>
                      ) : (
                        <td key={column.key} className={className}>
                          {shownContent}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
