import { type Column, DataTable } from "@/components/patterns";
import { StockQuickLink } from "@/components/screens/detail/StockQuickLink";
import { Card } from "@/components/ui";
import {
  amountDigits,
  formatAmount,
  formatPrice,
  formatQuantity,
  formatSignedAmount,
  orderKindText,
  orderPriceText,
  orderSideLabel,
  orderStatusLabel,
} from "@/lib/brokerage";
import { deltaColor, EMPTY, formatKst, formatPercent } from "@/lib/format";
import { marketMeta, type PaperMarketCode } from "@/lib/paperMarket";
import { SOURCES } from "@/lib/sources";
import type { BrokerageHoldingRow, BrokerageOrderRow } from "@/lib/types/brokerage";

/*
 * 실제 계좌의 보유·주문 표(DataTable). 칸이 "—"(EMPTY)를 돌려주면 표가 Empty("—" + 읽어 주는 "값 없음")로 그립니다 — 손익 색을 입히는
 * 칸도 값이 없으면 글만 돌려줘 같은 모양이 되게 합니다. 행을 누를 수 없고(모의 계좌 행처럼 읽히지 않게) 칸 안에 단추가 없습니다.
 * 금액 단위는 표 머리가 적습니다("평가금액(원)").
 */

/** 손익(금액) 칸 — 부호와 색(표시 자릿수 기준). */
function signedAmountCell(value: number | null, market: PaperMarketCode) {
  const text = formatSignedAmount(value, market);
  return text === EMPTY ? text : <span className={deltaColor(value, amountDigits(market))}>{text}</span>;
}

/** 손익률(%) 칸 — 부호와 색. */
function percentCell(value: number | null) {
  const text = formatPercent(value);
  return text === EMPTY ? text : <span className={deltaColor(value)}>{text}</span>;
}

/** 종목 칸 — 이름(없으면 코드)과 작은 코드. */
function symbolCell(name: string | null, symbol: string | null) {
  const shown = name && name.trim() !== "" ? name : symbol;
  if (!shown) return EMPTY;
  return (
    <span className="flex flex-col">
      <span className="font-semibold text-bright">{shown}</span>
      {name && symbol && name !== symbol ? <span className="text-xs text-text-3">{symbol}</span> : null}
    </span>
  );
}

/** 보유 종목 칸 — 누르면 종목 팝업 창(코드를 모르면 글자만). */
function holdingSymbolCell(row: BrokerageHoldingRow, market: PaperMarketCode) {
  const cell = symbolCell(row.name, row.symbol);
  return row.symbol ? <StockQuickLink market={market === "KR" ? "kr" : "us"} code={row.symbol}>{cell}</StockQuickLink> : cell;
}

function holdingColumns(market: PaperMarketCode): Column<BrokerageHoldingRow>[] {
  const unit = marketMeta(market).unitLabel;
  return [
    { key: "symbol", header: "종목", rowHeader: true, sortValue: (row) => row.name ?? row.symbol, cell: (row) => holdingSymbolCell(row, market) },
    { key: "quantity", header: "수량", align: "right", sortValue: (row) => row.quantity, cell: (row) => formatQuantity(row.quantity) },
    { key: "avg", header: `평균 매입가(${unit})`, align: "right", cell: (row) => formatPrice(row.averagePurchasePrice, market) },
    { key: "last", header: `현재가(${unit})`, align: "right", cell: (row) => formatPrice(row.lastPrice, market) },
    { key: "purchase", header: `매입금액(${unit})`, align: "right", cell: (row) => formatAmount(row.purchaseAmount, market) },
    {
      key: "marketValue",
      header: `평가금액(${unit})`,
      align: "right",
      sortValue: (row) => row.marketValue,
      cell: (row) => formatAmount(row.marketValue, market),
    },
    {
      key: "profitLoss",
      header: `평가손익(${unit})`,
      align: "right",
      sortValue: (row) => row.profitLoss,
      cell: (row) => signedAmountCell(row.profitLoss, market),
    },
    { key: "profitLossPct", header: "손익률", align: "right", sortValue: (row) => row.profitLossPct, cell: (row) => percentCell(row.profitLossPct) },
    {
      key: "daily",
      header: `일간 손익(${unit})`,
      align: "right",
      cell: (row) => {
        const amount = signedAmountCell(row.dailyProfitLoss, market);
        const pct = formatPercent(row.dailyProfitLossPct);
        if (amount === EMPTY && pct === EMPTY) return EMPTY;
        return (
          <span className="inline-flex flex-col items-end">
            <span>{amount === EMPTY ? <span className="text-text-3">{EMPTY}</span> : amount}</span>
            {pct === EMPTY ? null : <span className={`text-xs ${deltaColor(row.dailyProfitLossPct)}`}>{pct}</span>}
          </span>
        );
      },
    },
  ];
}

/** 행 키 — 응답에 식별 번호가 없어(주문 번호는 싣지 않음) 받은 순번을 붙입니다. 정렬해도 같은 행이 같은 키를 가지게 행 객체로 찾습니다. */
function rowKeys<T>(rows: readonly T[], label: (row: T) => string): (row: T) => string {
  const keys = new Map(rows.map((row, index) => [row, `${index}:${label(row)}`]));
  return (row) => keys.get(row) ?? label(row);
}

/** 보유 종목(실제) — 이 화면 통화의 종목만(백엔드가 나눔). 없으면 '보유 종목 없음'. 처음에는 평가금액이 큰 순서. */
export function BrokerageHoldings({ rows, market }: { rows: readonly BrokerageHoldingRow[]; market: PaperMarketCode }) {
  return (
    <Card title="보유 종목(실제)" source={SOURCES.tossAccount}>
      <DataTable
        columns={holdingColumns(market)}
        rows={rows}
        rowKey={rowKeys(rows, (row) => row.symbol)}
        caption="실제 계좌 보유 종목"
        emptyText="보유 종목 없음"
        initialSort={{ key: "marketValue", dir: "desc" }}
        scrollHint="overflow"
      />
    </Card>
  );
}

function orderColumns(market: PaperMarketCode, closed: boolean): Column<BrokerageOrderRow>[] {
  const unit = marketMeta(market).unitLabel;
  const base: Column<BrokerageOrderRow>[] = [
    { key: "orderedAt", header: "주문 시각", cell: (row) => formatKst(row.orderedAtKst) },
    { key: "symbol", header: "종목", cell: (row) => symbolCell(row.name, row.symbol) },
    { key: "side", header: "방향", cell: (row) => orderSideLabel(row.side) },
    { key: "kind", header: "호가·조건", cell: (row) => orderKindText(row) },
    { key: "status", header: "상태", cell: (row) => orderStatusLabel(row.status) },
    { key: "price", header: `주문 가격(${unit})`, align: "right", cell: (row) => orderPriceText(row, market) },
    { key: "quantity", header: "주문 수량", align: "right", cell: (row) => formatQuantity(row.quantity) },
    { key: "filledQuantity", header: "체결 수량", align: "right", cell: (row) => formatQuantity(row.filledQuantity) },
    { key: "averageFilledPrice", header: `평균 체결가(${unit})`, align: "right", cell: (row) => formatPrice(row.averageFilledPrice, market) },
  ];
  if (!closed) return base;
  return [
    ...base,
    { key: "filledAmount", header: `체결 금액(${unit})`, align: "right", cell: (row) => formatAmount(row.filledAmount, market) },
    { key: "commission", header: `수수료(${unit})`, align: "right", cell: (row) => formatAmount(row.commission, market) },
    { key: "tax", header: `세금(${unit})`, align: "right", cell: (row) => formatAmount(row.tax, market) },
    { key: "filledAt", header: "체결 시각", cell: (row) => formatKst(row.filledAtKst) },
    { key: "canceledAt", header: "취소 시각", cell: (row) => formatKst(row.canceledAtKst) },
  ];
}

/**
 * 주문 표(실제) — 진행 중이거나 최근 끝난 주문. 서버 순서 그대로
 * (끝난 주문은 최신순). 취소·정정 단추는 없습니다(읽기 전용).
 */
export function BrokerageOrders({
  title,
  subtitle,
  rows,
  market,
  emptyText,
  closed = false,
  note,
}: {
  title: string;
  subtitle?: string;
  rows: readonly BrokerageOrderRow[];
  market: PaperMarketCode;
  emptyText: string;
  closed?: boolean;
  note?: string | null;
}) {
  return (
    <Card title={title} subtitle={subtitle} source={SOURCES.tossAccount}>
      {note && <p className="mb-3 text-xs text-warn">{note}</p>}
      <DataTable
        columns={orderColumns(market, closed)}
        rows={rows}
        rowKey={rowKeys(rows, (row) => `${row.orderedAtKst ?? ""}:${row.symbol ?? ""}`)}
        caption={title}
        emptyText={emptyText}
        scrollHint="overflow"
      />
    </Card>
  );
}
