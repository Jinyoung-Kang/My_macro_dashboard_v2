import { DataTable, type Column } from "@/components/patterns";
import { formatKst } from "@/lib/format";
import {
  eventDetailText,
  eventKindLabel,
  formatShares,
  formatWon,
  orderStatusText,
  orderTime,
  purposeLabel,
  sideLabel,
  symbolText,
  timeInForceLabel,
} from "@/lib/realtrade";
import type { RealTradeEvent, RealTradeOrderRow } from "@/lib/types/realtrade";

const ORDER_COLUMNS: readonly Column<RealTradeOrderRow>[] = [
  { key: "time", header: "시각", cell: (row) => formatKst(orderTime(row)) },
  { key: "purpose", header: "용도", cell: (row) => purposeLabel(row.purpose) },
  { key: "symbol", header: "종목", cell: (row) => symbolText(row.symbol, row.name) },
  { key: "side", header: "방향", cell: (row) => sideLabel(row.side) },
  { key: "quantity", header: "수량(주)", align: "right", cell: (row) => formatShares(row.quantity) },
  { key: "tif", header: "조건", cell: (row) => timeInForceLabel(row.timeInForce) },
  { key: "status", header: "상태", cell: (row) => orderStatusText(row) },
  { key: "filled", header: "체결(주)", align: "right", cell: (row) => formatShares(row.filledQuantity) },
  { key: "price", header: "평균 체결가", align: "right", cell: (row) => formatWon(row.averageFilledPrice) },
  { key: "amount", header: "체결 금액", align: "right", cell: (row) => formatWon(row.filledAmount) },
  { key: "code", header: "사유", cell: (row) => row.outcomeCode || null },
];

/** 최근 실제 주문(최근 50, 서버 순서 그대로) — 누를 수 없는 표. 토스 주문 번호는 응답에 없어 싣지 않습니다. 모르는 칸은 "—". */
export function RealTradeOrders({ rows }: { rows: readonly RealTradeOrderRow[] }) {
  return (
    <section aria-label="최근 실제 주문" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text">최근 실제 주문</h3>
      <DataTable
        caption="최근 실제 주문"
        columns={ORDER_COLUMNS}
        rows={rows}
        rowKey={(row) => `${orderTime(row) ?? ""}-${row.purpose ?? ""}-${row.symbol ?? ""}-${row.side ?? ""}-${rows.indexOf(row)}`}
        emptyText="이 기능이 낸 실제 주문 없음"
        scrollHint="overflow"
      />
    </section>
  );
}

const EVENT_COLUMNS: readonly Column<RealTradeEvent>[] = [
  { key: "at", header: "시각", cell: (row) => formatKst(row.at) },
  { key: "kind", header: "일", cell: (row) => eventKindLabel(row.kind) },
  { key: "detail", header: "내용", cell: (row) => eventDetailText(row.detail, row.kind) },
];

/** 이벤트(최근 30) — 켜기·끄기·멈춤·창 요약·비밀번호 틀림 등. 내용은 용도·사유 코드·건수만 적습니다. */
export function RealTradeEvents({ rows }: { rows: readonly RealTradeEvent[] }) {
  return (
    <section aria-label="실제 매매 이벤트" className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text">이벤트</h3>
      <DataTable
        caption="실제 매매 이벤트"
        columns={EVENT_COLUMNS}
        rows={rows}
        rowKey={(row) => `${row.at ?? ""}-${row.kind ?? ""}-${rows.indexOf(row)}`}
        emptyText="이벤트 없음"
        maxHeight={320}
      />
    </section>
  );
}
