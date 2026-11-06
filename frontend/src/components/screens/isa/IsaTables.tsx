"use client";

import { DataTable, type Column } from "@/components/patterns";
import { buttonClasses } from "@/components/ui";
import { formatKst } from "@/lib/format";
import {
  canFixFill,
  canSkip,
  formatPrice,
  formatShares,
  formatWeight,
  formatWon,
  instructionStatusLabel,
  kindLabel,
  LEDGER_AMOUNT_NOTE,
  ledgerFormFromRow,
  notifiedText,
  sessionLabel,
  sideLabel,
  sourceLabel,
  symbolText,
} from "@/lib/isa";
import type { IsaHolding, IsaInstructionItem, IsaLedgerRow } from "@/lib/types/isa";

const HOLDING_COLUMNS: readonly Column<IsaHolding>[] = [
  { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), rowHeader: true },
  { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity) },
  { key: "avgPrice", header: "평균 단가", align: "right", cell: (row) => formatPrice(row.avgPrice) },
  { key: "lastPrice", header: "마지막 가격", align: "right", cell: (row) => formatPrice(row.lastPrice) },
  { key: "marketValue", header: "평가액", align: "right", cell: (row) => formatWon(row.marketValue) },
  { key: "weightPct", header: "비중", align: "right", cell: (row) => formatWeight(row.weightPct) },
];

/** 보유 — 장부의 종목별 수량을 마지막 가격으로 평가(서버 순서 그대로). 가격을 모르면 평가액·비중이 "—". */
export function IsaHoldingsTable({ rows }: { rows: readonly IsaHolding[] }) {
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
    ...(withSession ? [{ key: "session", header: "세션", cell: (row: IsaInstructionItem) => sessionLabel(row.session ?? null) }] : []),
    { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), rowHeader: true },
    { key: "side", header: "방향", cell: (row) => sideLabel(row.side) },
    { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity) },
    { key: "refPrice", header: "기준가", align: "right", cell: (row) => formatPrice(row.refPrice) },
    { key: "weightPct", header: "목표 비중", align: "right", cell: (row) => formatWeight(row.weightPct) },
    { key: "status", header: "상태", cell: (row) => instructionStatusLabel(row.status) },
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
  { key: "session", header: "세션", cell: (row) => sessionLabel(row.session ?? null) },
  { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name) },
  { key: "side", header: "방향", cell: (row) => sideLabel(row.side) },
  { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity) },
  { key: "status", header: "상태", cell: (row) => instructionStatusLabel(row.status) },
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

/** 장부(최근 200, 최근 순 — 서버 순서 그대로). 금액은 입출금이면 입출금액, 매수·매도면 수량×체결가(서버 값), 수량·가격은 매수·매도·조정 행만. */
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
    { key: "at", header: "시각", cell: (row) => formatKst(row.at) },
    { key: "kind", header: "종류", cell: (row) => kindLabel(row.kind) },
    { key: "symbol", header: "종목", cell: (row) => (row.symbol ? symbolText(row.symbol, row.name) : null) },
    { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity) },
    { key: "price", header: "체결가", align: "right", cell: (row) => formatPrice(row.price) },
    { key: "amount", header: "금액", align: "right", cell: (row) => formatWon(row.amount) },
    { key: "fee", header: "수수료", align: "right", cell: (row) => formatWon(row.fee) },
    { key: "tax", header: "세금", align: "right", cell: (row) => formatWon(row.tax) },
    { key: "source", header: "기록", cell: (row) => sourceLabel(row.source) },
    { key: "instruction", header: "지시", cell: (row) => (typeof row.instructionId === "number" ? `#${row.instructionId}` : null) },
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
        maxHeight={480}
        scrollHint="overflow"
      />
      <p className="text-xs leading-relaxed text-text-3">{LEDGER_AMOUNT_NOTE}</p>
    </div>
  );
}
