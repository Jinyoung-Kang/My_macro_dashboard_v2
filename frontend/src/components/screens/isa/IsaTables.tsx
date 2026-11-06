"use client";

import { DataTable, type Column } from "@/components/patterns";
import { buttonClasses } from "@/components/ui";
import { EMPTY, formatKst, formatKstSeconds } from "@/lib/format";
import {
  canFixFill,
  canSkip,
  formatPrice,
  formatShares,
  formatWeight,
  formatWon,
  instructionStatusLabel,
  type IsaHoldingView,
  kindLabel,
  LEDGER_AMOUNT_NOTE,
  ledgerFormFromRow,
  notifiedText,
  sessionLabel,
  sideLabel,
  sourceLabel,
  symbolText,
  timeSortValue,
  toNumber,
} from "@/lib/isa";
import type { IsaInstructionItem, IsaLedgerRow } from "@/lib/types/isa";

/*
 * 표 정렬(명세 docs/specs/2026-11-06-us-costs-backfill.md §5) — 숫자·글 열마다 sortValue를 두어 머리를 누르면 오름 → 내림(lib/dataTable nextSort,
 * 지금 정렬한 열의 머리에 aria-sort). 모르는 값은 방향과 무관하게 맨 뒤입니다. 장부는 처음에 시각 내림차순(최근 순 — 서버 순서와 같음), 보유·지시는
 * 서버 순서 그대로(지시는 매도 먼저·매수 나중이 매매 순서라 처음부터 정렬하지 않음). 단추 칸(고치기)·메모는 정렬하지 않습니다.
 */

/** 종목 정렬 값 — 화면에 보이는 "이름 코드"(없으면 null — 맨 뒤). */
const symbolSort = (symbol: string | null | undefined, name: string | null | undefined): string | null => {
  const text = symbolText(symbol ?? null, name ?? null);
  return text === EMPTY ? null : text;
};

/** 이름표 정렬 값 — 이름표가 "—"면 null. */
const labelSort = (text: string): string | null => (text === EMPTY ? null : text);

/** 실시간 가격의 시각 → 서울 시각 "HH:mm:ss"(못 읽으면 null). */
function clockOf(at: string | null): string | null {
  return /^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}(?::\d{2})?)$/.exec(formatKstSeconds(at))?.[1] ?? null;
}

/** 가격 칸 — 값과 그 출처(실시간이면 그 가격의 시각, 서버 직전 종가면 '직전 종가'). 가격을 모르면 "—"(표가 값 없음으로 그림). */
function priceCell(row: IsaHoldingView) {
  const price = formatPrice(row.lastPrice);
  if (price === EMPTY) return price;
  const clock = clockOf(row.priceAt);
  const tag = row.priceSource === "live" ? `실시간${clock ? ` ${clock}` : ""}` : row.priceSource === "close" ? "직전 종가" : null;
  return (
    <span className="inline-flex flex-col items-end">
      <span>{price}</span>
      {tag && <span className="text-xs text-text-3">{tag}</span>}
    </span>
  );
}

const HOLDING_COLUMNS: readonly Column<IsaHoldingView>[] = [
  { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), rowHeader: true, sortValue: (row) => symbolSort(row.symbol, row.name) },
  { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
  { key: "avgPrice", header: "평균 단가", align: "right", cell: (row) => formatPrice(row.avgPrice), sortValue: (row) => toNumber(row.avgPrice) },
  { key: "lastPrice", header: "마지막 가격", align: "right", cell: priceCell, sortValue: (row) => toNumber(row.lastPrice) },
  { key: "marketValue", header: "평가액", align: "right", cell: (row) => formatWon(row.marketValue), sortValue: (row) => toNumber(row.marketValue) },
  { key: "weightPct", header: "비중", align: "right", cell: (row) => formatWeight(row.weightPct), sortValue: (row) => toNumber(row.weightPct) },
];

/**
 * 보유 — 장부의 종목별 수량을 실시간 가격(받았으면 — 표시 전용) 또는 서버가 준 직전 종가로 평가(lib/isa isaValuation, 처음에는 서버 순서 그대로).
 * 가격 칸 아래에 그 가격의 출처('실시간 HH:mm:ss'·'직전 종가'). 가격을 모르면 평가액·비중이 "—".
 */
export function IsaHoldingsTable({ rows }: { rows: readonly IsaHoldingView[] }) {
  return (
    <DataTable
      caption="ISA 계좌 보유"
      columns={HOLDING_COLUMNS}
      rows={rows}
      rowKey={(row) => row.symbol}
      emptyText="보유 없음 — 현금만"
      scrollHint="overflow"
    />
  );
}

/** 지시 줄의 단추 — 체결 고치기(기록 전·기록됨)·건너뜀(기록 전). 해당하는 단추가 없으면 칸이 비어 "—". */
function InstructionActions({
  item,
  onFix,
  onSkip,
  disabled,
}: {
  item: IsaInstructionItem;
  onFix: (item: IsaInstructionItem) => void;
  onSkip: (item: IsaInstructionItem) => void;
  disabled: boolean;
}) {
  const who = symbolText(item.symbol, item.name);
  if (!canFixFill(item) && !canSkip(item)) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {canFixFill(item) && (
        <button
          type="button"
          onClick={() => onFix(item)}
          disabled={disabled}
          aria-label={`체결 고치기 — ${who}`}
          className={buttonClasses("secondary", "sm")}
        >
          체결 고치기
        </button>
      )}
      {canSkip(item) && (
        <button
          type="button"
          onClick={() => onSkip(item)}
          disabled={disabled}
          aria-label={`건너뜀 — ${who}`}
          className={buttonClasses("ghost", "sm")}
        >
          건너뜀
        </button>
      )}
    </div>
  );
}

/**
 * 지시 표 — 매도 먼저·매수 나중(서버 순서 그대로), 줄마다 체결 고치기·건너뜀. 다음 시가 매매 지시(세션은 카드 제목에)와
 * 처리 안 된 지난 지시(`withSession` — 줄마다 세션 칸)에 같이 씁니다.
 */
export function IsaInstructionsTable({
  rows,
  onFix,
  onSkip,
  disabled,
  caption = "다음 시가 매매 지시",
  withSession = false,
}: {
  rows: readonly IsaInstructionItem[];
  onFix: (item: IsaInstructionItem) => void;
  onSkip: (item: IsaInstructionItem) => void;
  disabled: boolean;
  caption?: string;
  withSession?: boolean;
}) {
  const columns: readonly Column<IsaInstructionItem>[] = [
    ...(withSession
      ? [{
          key: "session",
          header: "세션",
          cell: (row: IsaInstructionItem) => sessionLabel(row.session ?? null),
          sortValue: (row: IsaInstructionItem) => row.session ?? null,
        }]
      : []),
    { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), rowHeader: true, sortValue: (row) => symbolSort(row.symbol, row.name) },
    { key: "side", header: "방향", cell: (row) => sideLabel(row.side), sortValue: (row) => labelSort(sideLabel(row.side)) },
    { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
    { key: "refPrice", header: "기준가", align: "right", cell: (row) => formatPrice(row.refPrice), sortValue: (row) => toNumber(row.refPrice) },
    { key: "weightPct", header: "목표 비중", align: "right", cell: (row) => formatWeight(row.weightPct), sortValue: (row) => toNumber(row.weightPct) },
    { key: "status", header: "상태", cell: (row) => instructionStatusLabel(row.status), sortValue: (row) => labelSort(instructionStatusLabel(row.status)) },
    { key: "notified", header: "알림", cell: (row) => notifiedText(row) },
    {
      key: "actions",
      header: "고치기",
      cell: (row) => <InstructionActions item={row} onFix={onFix} onSkip={onSkip} disabled={disabled} />,
    },
  ];
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(row) => String(row.id)}
      emptyText="매매할 종목 없음"
      scrollHint="overflow"
    />
  );
}

const RECENT_COLUMNS: readonly Column<IsaInstructionItem>[] = [
  { key: "session", header: "세션", cell: (row) => sessionLabel(row.session ?? null), sortValue: (row) => row.session ?? null },
  { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), sortValue: (row) => symbolSort(row.symbol, row.name) },
  { key: "side", header: "방향", cell: (row) => sideLabel(row.side), sortValue: (row) => labelSort(sideLabel(row.side)) },
  { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
  { key: "status", header: "상태", cell: (row) => instructionStatusLabel(row.status), sortValue: (row) => labelSort(instructionStatusLabel(row.status)) },
  { key: "notified", header: "알림", cell: (row) => notifiedText(row) },
];

/** 지난 지시(최근 30) — 누를 수 없는 표. */
export function IsaRecentInstructionsTable({ rows }: { rows: readonly IsaInstructionItem[] }) {
  return (
    <DataTable
      caption="지난 지시"
      columns={RECENT_COLUMNS}
      rows={rows}
      rowKey={(row) => String(row.id)}
      emptyText="지난 지시 없음"
      maxHeight={360}
      scrollHint="overflow"
    />
  );
}

/** 장부 줄의 단추 — 고치기(아는 종류만)·지우기(확인 창). */
function LedgerActions({
  row,
  onEdit,
  onDelete,
  disabled,
}: {
  row: IsaLedgerRow;
  onEdit: (row: IsaLedgerRow) => void;
  onDelete: (row: IsaLedgerRow) => void;
  disabled: boolean;
}) {
  const what = `${kindLabel(row.kind)}${row.symbol ? ` ${symbolText(row.symbol, row.name)}` : ""} #${row.id}`;
  return (
    <div className="flex flex-wrap gap-1.5">
      {ledgerFormFromRow(row) && (
        <button
          type="button"
          onClick={() => onEdit(row)}
          disabled={disabled}
          aria-label={`고치기 — ${what}`}
          className={buttonClasses("secondary", "sm")}
        >
          고치기
        </button>
      )}
      <button
        type="button"
        onClick={() => onDelete(row)}
        disabled={disabled}
        aria-label={`지우기 — ${what}`}
        className={buttonClasses("ghost", "sm")}
      >
        지우기
      </button>
    </div>
  );
}

/**
 * 장부(최근 200). 처음에는 시각 내림차순(최근 순 — 같은 시각은 서버 순서), 머리를 누르면 그 열로 오름 → 내림. 금액은 입출금이면 입출금액,
 * 매수·매도면 수량×체결가(서버 값), 수량·가격은 매수·매도·조정 행만.
 */
export function IsaLedgerTable({
  rows,
  onEdit,
  onDelete,
  disabled,
}: {
  rows: readonly IsaLedgerRow[];
  onEdit: (row: IsaLedgerRow) => void;
  onDelete: (row: IsaLedgerRow) => void;
  disabled: boolean;
}) {
  const columns: readonly Column<IsaLedgerRow>[] = [
    { key: "at", header: "시각", cell: (row) => formatKst(row.at), sortValue: (row) => timeSortValue(row.at) },
    { key: "kind", header: "종류", cell: (row) => kindLabel(row.kind), sortValue: (row) => labelSort(kindLabel(row.kind)) },
    {
      key: "symbol",
      header: "종목",
      cell: (row) => (row.symbol ? symbolText(row.symbol, row.name) : null),
      sortValue: (row) => (row.symbol ? symbolSort(row.symbol, row.name) : null),
    },
    { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
    { key: "price", header: "체결가", align: "right", cell: (row) => formatPrice(row.price), sortValue: (row) => toNumber(row.price) },
    { key: "amount", header: "금액", align: "right", cell: (row) => formatWon(row.amount), sortValue: (row) => toNumber(row.amount) },
    { key: "fee", header: "수수료", align: "right", cell: (row) => formatWon(row.fee), sortValue: (row) => toNumber(row.fee) },
    { key: "tax", header: "세금", align: "right", cell: (row) => formatWon(row.tax), sortValue: (row) => toNumber(row.tax) },
    { key: "source", header: "기록", cell: (row) => sourceLabel(row.source), sortValue: (row) => labelSort(sourceLabel(row.source)) },
    {
      key: "instruction",
      header: "지시",
      cell: (row) => (typeof row.instructionId === "number" ? `#${row.instructionId}` : null),
      sortValue: (row) => (typeof row.instructionId === "number" ? row.instructionId : null),
    },
    { key: "note", header: "메모", cell: (row) => row.note || null },
    {
      key: "actions",
      header: "고치기",
      cell: (row) => <LedgerActions row={row} onEdit={onEdit} onDelete={onDelete} disabled={disabled} />,
    },
  ];
  return (
    <div className="flex flex-col gap-2">
      <DataTable
        caption="ISA 계좌 장부"
        columns={columns}
        rows={rows}
        rowKey={(row) => String(row.id)}
        emptyText="장부 행 없음"
        initialSort={{ key: "at", dir: "desc" }}
        maxHeight={480}
        scrollHint="overflow"
      />
      <p className="text-xs leading-relaxed text-text-3">{LEDGER_AMOUNT_NOTE}</p>
    </div>
  );
}
