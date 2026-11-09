"use client";

import { DataTable, type Column } from "@/components/patterns";
import { buttonClasses } from "@/components/ui";
import { deltaColor, EMPTY, formatKst, formatKstSeconds, formatPercent, formatSigned } from "@/lib/format";
import {
  autoNoteLabel,
  canConfirm,
  canSkip,
  formatPrice,
  formatShares,
  formatWeight,
  formatWon,
  instructionStatusLabel,
  type IsaPositionView,
  notifiedText,
  sessionLabel,
  sideLabel,
  stopNotifiedText,
  stopTimingLabel,
  stopWindowText,
  symbolText,
  timeSortValue,
  toNumber,
} from "@/lib/isa";
import type { IsaInstructionItem, IsaStopInstruction, IsaTrade } from "@/lib/types/isa";

/*
 * 표 정렬 — 숫자·글 열마다 sortValue를 두어 머리를 누르면 오름 → 내림(lib/dataTable nextSort, 지금 정렬한 열의 머리에 aria-sort). 모르는 값은 방향과 무관하게 맨 뒤입니다.
 * 매매 내역은 처음에 시각 내림차순(최근 순 — 서버 순서와 같음), 잔고·지시는 서버 순서 그대로(지시는 매도 먼저·매수 나중이 매매 순서라 처음부터 정렬하지 않음). 단추 칸은 정렬하지 않습니다.
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

/** 손익 % 칸 — 부호·색(모르면 "—"). */
function pnlPctCell(value: unknown) {
  const pct = toNumber(value);
  return <span className={deltaColor(pct, 0)}>{formatPercent(pct)}</span>;
}

/** 금액 손익 칸 — 부호·색(모르면 "—"). */
function pnlWonCell(value: unknown) {
  const number = toNumber(value);
  return <span className={deltaColor(number, 0)}>{number === null ? EMPTY : `${formatSigned(number, 0)}원`}</span>;
}

/** 가격 칸 — 값과 그 출처(실시간이면 그 가격의 시각, 서버 직전 종가면 '직전 종가'). 가격을 모르면 "—"(표가 값 없음으로 그림). */
function priceCell(row: IsaPositionView) {
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

/** 잔고 줄의 단추 — 고치기·지우기(확인 창). */
function PositionActions({
  row,
  onEdit,
  onDelete,
  disabled,
}: {
  row: IsaPositionView;
  onEdit: (row: IsaPositionView) => void;
  onDelete: (row: IsaPositionView) => void;
  disabled: boolean;
}) {
  const who = symbolText(row.symbol, row.name);
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" onClick={() => onEdit(row)} disabled={disabled} aria-label={`고치기 — ${who}`} className={buttonClasses("secondary", "sm")}>
        고치기
      </button>
      <button type="button" onClick={() => onDelete(row)} disabled={disabled} aria-label={`지우기 — ${who}`} className={buttonClasses("ghost", "sm")}>
        지우기
      </button>
    </div>
  );
}

/** 잔고(첫 열 고치기·지우기) — 실시간 가격(받았으면 — 표시 전용) 또는 서버가 준 직전 종가로 평가(lib/isa isaValuation). */
export function IsaPositionsTable({
  rows,
  onEdit,
  onDelete,
  disabled,
}: {
  rows: readonly IsaPositionView[];
  onEdit: (row: IsaPositionView) => void;
  onDelete: (row: IsaPositionView) => void;
  disabled: boolean;
}) {
  const columns: readonly Column<IsaPositionView>[] = [
    { key: "actions", header: "고치기", cell: (row) => <PositionActions row={row} onEdit={onEdit} onDelete={onDelete} disabled={disabled} /> },
    { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), rowHeader: true, sortValue: (row) => symbolSort(row.symbol, row.name) },
    { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
    { key: "avgPrice", header: "평균 매입가", align: "right", cell: (row) => formatPrice(row.avgPrice), sortValue: (row) => toNumber(row.avgPrice) },
    { key: "purchaseAmount", header: "매입 금액", align: "right", cell: (row) => formatWon(row.purchaseAmount), sortValue: (row) => toNumber(row.purchaseAmount) },
    { key: "lastPrice", header: "현재가", align: "right", cell: priceCell, sortValue: (row) => toNumber(row.lastPrice) },
    { key: "marketValue", header: "평가액", align: "right", cell: (row) => formatWon(row.marketValue), sortValue: (row) => toNumber(row.marketValue) },
    { key: "profitLoss", header: "평가손익", align: "right", cell: (row) => pnlWonCell(row.profitLoss), sortValue: (row) => toNumber(row.profitLoss) },
    { key: "profitLossPct", header: "손익 %", align: "right", cell: (row) => pnlPctCell(row.profitLossPct), sortValue: (row) => toNumber(row.profitLossPct) },
    { key: "weightPct", header: "비중", align: "right", cell: (row) => formatWeight(row.weightPct), sortValue: (row) => toNumber(row.weightPct) },
    { key: "fees", header: "수수료 누적", align: "right", cell: (row) => formatWon(row.feesPaid), sortValue: (row) => toNumber(row.feesPaid) },
    { key: "taxes", header: "세금 누적", align: "right", cell: (row) => formatWon(row.taxesPaid), sortValue: (row) => toNumber(row.taxesPaid) },
  ];
  return (
    <DataTable
      caption="ISA 계좌 잔고"
      columns={columns}
      rows={rows}
      rowKey={(row) => row.symbol}
      emptyText="보유 없음 — 현금만"
      scrollHint="overflow"
    />
  );
}

/** 지시 줄의 단추 — 확인(한 번 누르면 바로 반영)·건너뜀(미확인). 해당하는 단추가 없으면 칸이 비어 "—". */
function InstructionActions({
  item,
  onConfirm,
  onSkip,
  disabled,
}: {
  item: IsaInstructionItem;
  onConfirm: (item: IsaInstructionItem) => void;
  onSkip: (item: IsaInstructionItem) => void;
  disabled: boolean;
}) {
  const who = symbolText(item.symbol, item.name);
  if (!canConfirm(item) && !canSkip(item)) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {canConfirm(item) && (
        <button type="button" onClick={() => onConfirm(item)} disabled={disabled} aria-label={`확인 — ${who}`} className={buttonClasses("primary", "sm")}>
          확인
        </button>
      )}
      {canSkip(item) && (
        <button type="button" onClick={() => onSkip(item)} disabled={disabled} aria-label={`건너뜀 — ${who}`} className={buttonClasses("ghost", "sm")}>
          건너뜀
        </button>
      )}
    </div>
  );
}

/** 지시 표 — 매도 먼저·매수 나중(서버 순서 그대로), 줄마다 확인·건너뜀. */
export function IsaInstructionsTable({
  rows,
  onConfirm,
  onSkip,
  disabled,
  caption = "다음 시가 매매 지시",
}: {
  rows: readonly IsaInstructionItem[];
  onConfirm: (item: IsaInstructionItem) => void;
  onSkip: (item: IsaInstructionItem) => void;
  disabled: boolean;
  caption?: string;
}) {
  const columns: readonly Column<IsaInstructionItem>[] = [
    { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), rowHeader: true, sortValue: (row) => symbolSort(row.symbol, row.name) },
    { key: "side", header: "방향", cell: (row) => sideLabel(row.side), sortValue: (row) => labelSort(sideLabel(row.side)) },
    { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
    { key: "refPrice", header: "기준가", align: "right", cell: (row) => formatPrice(row.refPrice), sortValue: (row) => toNumber(row.refPrice) },
    { key: "weightPct", header: "목표 비중", align: "right", cell: (row) => formatWeight(row.weightPct), sortValue: (row) => toNumber(row.weightPct) },
    { key: "status", header: "상태", cell: (row) => instructionStatusLabel(row.status), sortValue: (row) => labelSort(instructionStatusLabel(row.status)) },
    { key: "note", header: "메모", cell: (row) => autoNoteLabel(row.autoNote) },
    { key: "notified", header: "알림", cell: (row) => notifiedText(row) },
    { key: "actions", header: "확인", cell: (row) => <InstructionActions item={row} onConfirm={onConfirm} onSkip={onSkip} disabled={disabled} /> },
  ];
  return (
    <DataTable caption={caption} columns={columns} rows={rows} rowKey={(row) => String(row.id)} emptyText="매매할 종목 없음" scrollHint="overflow" />
  );
}

const RECENT_COLUMNS: readonly Column<IsaInstructionItem>[] = [
  { key: "session", header: "세션", cell: (row) => sessionLabel(row.session ?? null), sortValue: (row) => row.session ?? null },
  { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), sortValue: (row) => symbolSort(row.symbol, row.name) },
  { key: "side", header: "방향", cell: (row) => sideLabel(row.side), sortValue: (row) => labelSort(sideLabel(row.side)) },
  { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
  { key: "status", header: "상태", cell: (row) => instructionStatusLabel(row.status), sortValue: (row) => labelSort(instructionStatusLabel(row.status)) },
  { key: "note", header: "메모", cell: (row) => autoNoteLabel(row.autoNote) },
  { key: "notified", header: "알림", cell: (row) => notifiedText(row) },
];

/** 지난 지시(최근 30) — 누를 수 없는 표. */
export function IsaRecentInstructionsTable({ rows }: { rows: readonly IsaInstructionItem[] }) {
  return (
    <DataTable caption="지난 지시" columns={RECENT_COLUMNS} rows={rows} rowKey={(row) => String(row.id)} emptyText="지난 지시 없음" maxHeight={360} scrollHint="overflow" />
  );
}

const stopColumns = (onConfirm: (row: IsaStopInstruction) => void, disabled: boolean): readonly Column<IsaStopInstruction>[] => [
  { key: "session", header: "세션", cell: (row) => sessionLabel(row.session ?? null), sortValue: (row) => row.session ?? null },
  { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), rowHeader: true, sortValue: (row) => symbolSort(row.symbol, row.name) },
  { key: "quantity", header: "매도 수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
  { key: "timing", header: "방식", cell: (row) => stopTimingLabel(row.timing), sortValue: (row) => labelSort(stopTimingLabel(row.timing)) },
  { key: "window", header: "매도 창", cell: (row) => stopWindowText(row) },
  { key: "targetAt", header: "규칙 계좌 기준 시각", cell: (row) => formatKst(row.targetAt), sortValue: (row) => timeSortValue(row.targetAt) },
  { key: "status", header: "상태", cell: (row) => instructionStatusLabel(row.status), sortValue: (row) => labelSort(instructionStatusLabel(row.status)) },
  { key: "notified", header: "알림", cell: (row) => stopNotifiedText(row) },
  { key: "note", header: "메모", cell: (row) => autoNoteLabel(row.autoNote) },
  {
    key: "actions",
    header: "확인",
    cell: (row) =>
      canConfirm(row) ? (
        <button type="button" onClick={() => onConfirm(row)} disabled={disabled} aria-label={`확인 — ${symbolText(row.symbol, row.name)}`} className={buttonClasses("primary", "sm")}>
          확인
        </button>
      ) : null,
  },
];

/** 장중 스탑 매도 지시(최근 30 — ADR 0033) — 줄의 '확인'으로 잔고에 반영합니다. */
export function IsaStopInstructionsTable({
  rows,
  onConfirm,
  disabled,
}: {
  rows: readonly IsaStopInstruction[];
  onConfirm: (row: IsaStopInstruction) => void;
  disabled: boolean;
}) {
  return (
    <DataTable
      caption="장중 스탑 매도 지시"
      columns={stopColumns(onConfirm, disabled)}
      rows={rows}
      rowKey={(row) => String(row.id)}
      emptyText="스탑 지시 없음"
      maxHeight={360}
      scrollHint="overflow"
    />
  );
}

/** 매매 내역(최근 200, 읽기 전용 + 되돌리기). 처음에는 시각 내림차순(최근 순). */
export function IsaTradesTable({
  rows,
  onUndo,
  disabled,
}: {
  rows: readonly IsaTrade[];
  onUndo: (row: IsaTrade) => void;
  disabled: boolean;
}) {
  const columns: readonly Column<IsaTrade>[] = [
    { key: "at", header: "시각", cell: (row) => formatKst(row.at), sortValue: (row) => timeSortValue(row.at) },
    { key: "side", header: "방향", cell: (row) => sideLabel(row.side), sortValue: (row) => labelSort(sideLabel(row.side)) },
    { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name), rowHeader: true, sortValue: (row) => symbolSort(row.symbol, row.name) },
    { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity), sortValue: (row) => toNumber(row.quantity) },
    { key: "price", header: "가격", align: "right", cell: (row) => formatPrice(row.price), sortValue: (row) => toNumber(row.price) },
    { key: "amount", header: "금액", align: "right", cell: (row) => formatWon(row.amount), sortValue: (row) => toNumber(row.amount) },
    { key: "fee", header: "수수료", align: "right", cell: (row) => formatWon(row.fee), sortValue: (row) => toNumber(row.fee) },
    {
      key: "tax",
      header: "세금",
      align: "right",
      cell: (row) => `${formatWon(row.tax)}${row.taxAssumed ? " (어림)" : ""}`,
      sortValue: (row) => toNumber(row.tax),
    },
    { key: "realizedPnl", header: "실현 손익", align: "right", cell: (row) => pnlWonCell(row.realizedPnl), sortValue: (row) => toNumber(row.realizedPnl) },
    { key: "realizedPct", header: "손익률", align: "right", cell: (row) => pnlPctCell(row.realizedPct), sortValue: (row) => toNumber(row.realizedPct) },
    { key: "priceSource", header: "가격 출처", cell: (row) => (row.priceSource === "live" ? "실시간" : row.priceSource === "close" ? "직전 종가" : row.priceSource || null) },
    {
      key: "undo",
      header: "되돌리기",
      cell: (row) => (
        <button type="button" onClick={() => onUndo(row)} disabled={disabled} aria-label={`되돌리기 — ${symbolText(row.symbol, row.name)}`} className={buttonClasses("ghost", "sm")}>
          되돌리기
        </button>
      ),
    },
  ];
  return (
    <DataTable
      caption="ISA 계좌 매매 내역"
      columns={columns}
      rows={rows}
      rowKey={(row) => String(row.id)}
      emptyText="아직 확인한 매매 없음"
      initialSort={{ key: "at", dir: "desc" }}
      maxHeight={480}
      scrollHint="overflow"
    />
  );
}
