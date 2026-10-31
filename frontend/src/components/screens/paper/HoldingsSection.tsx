"use client";

import { type ReactNode, useState } from "react";
import { type Column, DataTable, Empty } from "@/components/patterns";
import { Banner, Button, Card, ErrorState, Freshness, Loading, Select } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { deltaColor, EMPTY, formatKst, formatNumber, formatPercent, formatWithUnit } from "@/lib/format";
import {
  type Badge,
  bookCard,
  bookOptions,
  executionAdvantageText,
  executionByOrder,
  fillBadges,
  fillRungText,
  formatSharePrice,
  heldText,
  isTimedBook,
  jsonTitle,
  notStartedNote,
  orderExecutionNote,
  orderReasonText,
  orderSizeText,
  orderStatusBadge,
  PAPER_SOURCES,
  positionBadges,
  resetResultView,
  resolveBookCode,
  sideClass,
  sideLabel,
  sourceLabel,
  statusResultText,
  statusToggle,
  stopText,
  timingLabel,
} from "@/lib/paper";
import {
  KR_RESET_NOTE,
  krConfirmationCautions,
  krConfirmationCells,
  krConfirmationTotalText,
  krCostText,
  krFillBadges,
  krNavRows,
  type KrNavRow,
  krNotStartedNote,
  krOrderRejectText,
  krPositionBadges,
  krPositionPriceTitle,
  krPriceSourceLabel,
  krStopBasisText,
} from "@/lib/paperKr";
import { formatMoney, type PaperMarketCode } from "@/lib/paperMarket";
import type {
  PaperBookResetResult,
  PaperBookStatusResult,
  PaperBookSummary,
  PaperExecutionOrder,
  PaperExecutionResponse,
  PaperFill,
  PaperFillsResponse,
  PaperLockout,
  PaperNavResponse,
  PaperOrder,
  PaperOrdersResponse,
  PaperPosition,
  PaperPositionsResponse,
  PaperStatusResponse,
} from "@/lib/types";

/** 주문·체결 표에 보일 최근 건수. 서버 상한은 500입니다. */
const RECENT_LIMIT = 50;

/*
 * 표 칸 정의(DataTable). 칸이 "—"(EMPTY)를 돌려주면 표가 Empty("—" + 읽어 주는 "값 없음")로 그립니다 — 글자색·title을 덧입히는 칸도
 * 값이 없으면 글만 돌려줘 같은 모양이 되게 합니다. 숫자 칸은 오른쪽 정렬·tabular-nums(DataTable)입니다.
 * 보유 표만 정렬 단추를 둡니다(종목·수량·평가액·비중·평가 손익 — 모르는 값은 방향과 무관하게 맨 뒤). 주문·체결은 서버의 시각 순서 그대로.
 */
const POSITION_COLUMNS: readonly Column<PaperPosition>[] = [
  {
    key: "ticker",
    header: "종목",
    sortValue: (row) => row.ticker,
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1">
        <span className="font-semibold text-bright">{row.ticker}</span>
        <Badges badges={positionBadges(row)} />
      </span>
    ),
  },
  { key: "qty", header: "수량", align: "right", sortValue: (row) => row.qty, cell: (row) => formatNumber(row.qty, 0) },
  // 주당 가격은 4자리(formatSharePrice) — 2자리로 자르면 싼 종목의 5bp 슬리피지가 보이지 않습니다. 총액·비율은 2자리.
  { key: "avgCost", header: "평단(달러)", align: "right", cell: (row) => formatSharePrice(row.avgCost) },
  {
    key: "lastPrice",
    header: "가격(달러)",
    align: "right",
    cell: (row) => {
      const price = formatSharePrice(row.lastPrice);
      return price === EMPTY ? price : <span title={row.lastPriceAtKst ? `${formatKst(row.lastPriceAtKst)} 관측` : undefined}>{price}</span>;
    },
  },
  { key: "marketValue", header: "평가액(달러)", align: "right", sortValue: (row) => row.marketValue, cell: (row) => formatNumber(row.marketValue, 2) },
  { key: "weightPct", header: "비중", align: "right", sortValue: (row) => row.weightPct, cell: (row) => formatWithUnit(row.weightPct, 1, "%") },
  {
    key: "unrealizedPct",
    header: "평가 손익",
    align: "right",
    sortValue: (row) => row.unrealizedPct,
    cell: (row) => {
      const text = formatPercent(row.unrealizedPct);
      return text === EMPTY ? text : <span className={deltaColor(row.unrealizedPct)}>{text}</span>;
    },
  },
  { key: "highWatermark", header: "최고가", align: "right", cell: (row) => formatSharePrice(row.highWatermark) },
  { key: "stop", header: "스탑 가격", align: "right", cell: (row) => stopText(row) },
  { key: "held", header: "보유 기간", cell: (row) => heldText(row) },
];

const LOCKOUT_COLUMNS: readonly Column<PaperLockout>[] = [
  { key: "ticker", header: "종목", cell: (row) => row.ticker },
  { key: "until", header: "이 날까지(미국 거래일)", cell: (row) => row.untilTradingDate },
  { key: "reason", header: "사유", cell: (row) => row.reason || EMPTY },
];

const ORDER_COLUMNS: readonly Column<PaperOrder>[] = [
  { key: "createdAt", header: "낸 시각", cell: (row) => formatKst(row.createdAtKst) },
  { key: "ticker", header: "종목", cell: (row) => row.ticker },
  { key: "side", header: "방향", cell: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
  { key: "size", header: "크기", align: "right", cell: (row) => orderSizeText(row) },
  { key: "timing", header: "체결 시점", cell: (row) => timingLabel(row.timing) },
  { key: "source", header: "출처", cell: (row) => sourceLabel(row.source) },
  {
    key: "status",
    header: "상태",
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1">
        <Badges badges={[orderStatusBadge(row.status)]} />
        {row.rejectReason && <span className="text-xs text-warn">{row.rejectReason}</span>}
      </span>
    ),
  },
  { key: "asOf", header: "기준 거래일", cell: (row) => row.asOfTradingDate ?? EMPTY },
  { key: "expires", header: "만료", cell: (row) => row.expiresOn ?? EMPTY },
  { key: "filledAt", header: "체결 시각", cell: (row) => formatKst(row.filledAtKst) },
  // 규칙 책 근거는 `rule · signal · kind`가 앞이라 키 순서대로 80자에서 자르면 문장(text)이 안 보입니다 — 결정 로그
  // 탭과 같은 orderReasonText로 문장(없으면 점수 기여)을 먼저 보이고, 전체 JSON은 마우스를 올려 봅니다.
  {
    key: "reason",
    header: "근거",
    cell: (row) => {
      const text = orderReasonText(row.reason, 80);
      return text === EMPTY ? text : (
        <span className="text-xs text-muted" title={jsonTitle(row.reason)}>
          {text}
        </span>
      );
    },
  },
];

const FILL_COLUMNS: readonly Column<PaperFill>[] = [
  { key: "observedAt", header: "관측 시각", cell: (row) => formatKst(row.observedAtKst) },
  {
    key: "ticker",
    header: "종목",
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1">
        <span>{row.ticker}</span>
        <Badges badges={fillBadges(row)} />
      </span>
    ),
  },
  { key: "side", header: "방향", cell: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
  { key: "qty", header: "수량", align: "right", cell: (row) => formatNumber(row.qty, 0) },
  { key: "price", header: "체결가(달러)", align: "right", cell: (row) => formatSharePrice(row.price) },
  { key: "rawPrice", header: "관측가", align: "right", cell: (row) => formatSharePrice(row.rawPrice) },
  { key: "slippage", header: "슬리피지", align: "right", cell: (row) => formatWithUnit(row.slippageBp, 1, "bp") },
  { key: "gross", header: "금액(달러)", align: "right", cell: (row) => formatNumber(row.gross, 2) },
  { key: "barDate", header: "봉 날짜", cell: (row) => row.observationDate ?? EMPTY },
  { key: "priceSource", header: "가격 출처", cell: (row) => row.priceSource ?? EMPTY },
];

/*
 * 🧪 미국 Claude 계좌2(시각 지정 체결 — 계좌2 명세 §13-3)의 주문·체결 표. 목표 시각과 계좌1식 대비는 실행 감사 응답(GET books/{code}/execution)의 그
 * 주문 줄 값 그대로이고, 줄이 없거나 값이 없으면 "—"입니다(반사실이 아직 없음·대체 체결). 다른 미국 계좌의 표는 위 칸 정의 그대로입니다.
 *
 * 한국 표(두 줄 칸)와 같은 방식으로 값을 묶어 칸 수를 줄이고 계좌2 칸(계좌1식 대비·실행 메모·근거)을 앞쪽에 둡니다 — 값마다 한 칸이면 1280px에서
 * 주문 표가 1,809px·체결 표가 1,364px라(카드 안 표 상자 958px) 8주 실험 동안 가장 자주 볼 칸이 가로 스크롤 오른쪽 밖에 숨었습니다(QA 스택 화면).
 * 주문: 낸 시각·기준일, 종목·방향, 체결 시점·목표 시각, 상태(장부 사유 + 출처·만료·체결 시각), 실행 메모·근거를 한 칸 두 줄로. 체결: 관측 시각·봉 날짜,
 * 체결가·관측가, 체결 봉·사다리, 금액·슬리피지를 한 칸 두 줄로. 짧은 칸은 줄바꿈 없이, 글(장부 사유·실행 메모·근거·사다리 이름)은 최소 폭을 두고
 * 낱말 사이에서만 줄바꿈(break-keep — 한 글자씩 접지 않음)합니다. 좁은 화면에서는 상자 안에서 가로로 넘깁니다('좌우로 넘겨 보세요').
 * 두 줄 칸 안의 한 줄만 값이 없으면 그 자리를 part()로 Empty(기호는 읽어 주기에서 빼고 '값 없음')로 그립니다 — 칸 전체가 "—"일 때 표가 그리는 것과 같은 규칙.
 */
function timedOrderColumns(audit: ReadonlyMap<number, PaperExecutionOrder>): Column<PaperOrder>[] {
  return [
    {
      key: "createdAt",
      header: "낸 시각·기준일",
      className: "whitespace-nowrap",
      cell: (row) => <TwoLines top={part(formatKst(row.createdAtKst))} bottom={part(row.asOfTradingDate ?? EMPTY, "기준")} />,
    },
    {
      key: "ticker",
      header: "종목·방향",
      className: "whitespace-nowrap",
      cell: (row) => (
        <span className="flex flex-col">
          <span>{row.ticker}</span>
          <span className={`text-xs ${sideClass(row.side)}`}>{part(sideLabel(row.side))}</span>
        </span>
      ),
    },
    {
      key: "size",
      header: "크기",
      align: "right",
      className: "min-w-[5.5rem]",
      cell: (row) => {
        const text = orderSizeText(row);
        // 오른쪽 정렬 칸은 줄바꿈 없음이 기본 — 긴 크기('순자산의 5.00% 매수 (목표 8.00%)')는 낱말 사이에서 접습니다.
        return text === EMPTY ? text : <span className="whitespace-normal break-keep">{text}</span>;
      },
    },
    {
      key: "timing",
      header: "체결 시점·목표 시각",
      className: "whitespace-nowrap",
      cell: (row) => (
        <TwoLines top={part(timingLabel(row.timing))} bottom={part(formatKst(audit.get(row.id)?.targetAtKst ?? null), "목표")} />
      ),
    },
    {
      key: "advantage",
      header: "계좌1식 대비",
      align: "right",
      cell: (row) => {
        const text = executionAdvantageText(audit.get(row.id));
        return text === EMPTY ? text : (
          <span title="같은 주문을 계좌1식(다음 시간별 관측치)으로 체결했다면의 원가격 대비(양수면 고른 시점이 유리) — 실행 감사">{text}</span>
        );
      },
    },
    {
      key: "status",
      header: "상태·만료·체결",
      className: "min-w-[8.5rem] break-keep",
      cell: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1">
            <Badges badges={[orderStatusBadge(row.status)]} />
            {row.rejectReason && <span className="text-xs text-warn">{row.rejectReason}</span>}
          </span>
          <span className="whitespace-nowrap text-[11px] text-text-3">
            {part(sourceLabel(row.source))} · {part(row.expiresOn ?? EMPTY, "만료")}
          </span>
          <span className="whitespace-nowrap text-[11px] text-text-3">{part(formatKst(row.filledAtKst), "체결")}</span>
        </span>
      ),
    },
    // 실행 메모(왜 그 시점인가 — Claude의 executionNote)와 근거(왜 그 종목인가 — 결정 로그와 같은 orderReasonText, 전체 JSON은 마우스를 올려 봄)를 한 칸에.
    {
      key: "executionNote",
      header: "실행 메모·근거",
      className: "min-w-[12rem] break-keep",
      cell: (row) => {
        const note = orderExecutionNote(row.reason);
        const reason = orderReasonText(row.reason, 80);
        if (note === EMPTY && reason === EMPTY) return EMPTY;
        return (
          <span className="flex flex-col gap-0.5 text-xs">
            <span className={note === EMPTY ? "text-text-3" : "text-body"}>{part(note)}</span>
            <span className="text-muted" title={jsonTitle(row.reason)}>{part(reason)}</span>
          </span>
        );
      },
    },
  ];
}

/** 계좌2 체결 표 — 위 주문 표와 같은 까닭으로 두 줄 칸을 씁니다. 사다리 이름만 낱말 사이에서 접고 나머지는 한 줄. */
function timedFillColumns(audit: ReadonlyMap<number, PaperExecutionOrder>): Column<PaperFill>[] {
  return [
    {
      key: "observedAt",
      header: "관측 시각·봉 날짜",
      className: "whitespace-nowrap",
      cell: (row) => <TwoLines top={part(formatKst(row.observedAtKst))} bottom={part(row.observationDate ?? EMPTY, "봉")} />,
    },
    {
      key: "ticker",
      header: "종목",
      className: "whitespace-nowrap",
      cell: (row) => (
        <span className="flex flex-wrap items-center gap-1">
          <span>{row.ticker}</span>
          <Badges badges={fillBadges(row)} />
        </span>
      ),
    },
    { key: "side", header: "방향", className: "whitespace-nowrap", cell: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
    { key: "qty", header: "수량", align: "right", cell: (row) => formatNumber(row.qty, 0) },
    {
      key: "price",
      header: "체결가·관측가(달러)",
      align: "right",
      cell: (row) => (
        <span className="flex flex-col items-end">
          <span>{part(formatSharePrice(row.price))}</span>
          <span className="text-[11px] text-text-3">{part(formatSharePrice(row.rawPrice), "관측")}</span>
        </span>
      ),
    },
    {
      key: "barAt",
      header: "체결 봉·사다리",
      className: "min-w-[10rem]",
      cell: (row) => {
        const bar = formatKst(row.barAtKst ?? null);
        const rung = fillRungText(row.fillRung);
        // 둘 다 없으면(계좌2 전 체결 등) 표가 값 없음(Empty)으로 그리게 글 그대로.
        if (bar === EMPTY && rung === EMPTY) return EMPTY;
        return (
          <span className="flex flex-col">
            <span className="whitespace-nowrap">{part(bar)}</span>
            <span className="break-keep text-[11px] text-text-3">{part(rung)}</span>
          </span>
        );
      },
    },
    { key: "advantage", header: "계좌1식 대비", align: "right", cell: (row) => executionAdvantageText(audit.get(row.orderId)) },
    {
      key: "gross",
      header: "금액(달러)·슬리피지",
      align: "right",
      cell: (row) => (
        <span className="flex flex-col items-end">
          <span>{part(formatNumber(row.gross, 2))}</span>
          <span className="text-[11px] text-text-3">{part(formatWithUnit(row.slippageBp, 1, "bp"), "슬리피지")}</span>
        </span>
      ),
    },
    { key: "priceSource", header: "가격 출처", className: "whitespace-nowrap", cell: (row) => row.priceSource ?? EMPTY },
  ];
}

/*
 * 한국 계좌의 칸(2단계 명세 §4-16 F2) — 돈·주당 가격은 원 단위 정수, 배지는 '기업행위 확인 필요'·'가격 없음'·확정 상태. 미국 칸 정의는 위
 * 그대로입니다(미국 화면 글자 불변). 체결가는 토스 잠정가(KRX 시가 단일가)이고, 슬리피지는 체결가가 아니라 비용 칸입니다.
 */
const won = (value: number | null | undefined) => formatMoney(value, "KR");
const wonPrice = (value: number | null | undefined) => formatSharePrice(value, "KR");

const KR_POSITION_COLUMNS: readonly Column<PaperPosition>[] = [
  {
    key: "ticker",
    header: "종목",
    sortValue: (row) => row.ticker,
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1">
        <span className="font-semibold text-bright">{row.ticker}</span>
        <Badges badges={krPositionBadges(row)} />
      </span>
    ),
  },
  { key: "qty", header: "수량(주)", align: "right", sortValue: (row) => row.qty, cell: (row) => formatNumber(row.qty, 0) },
  { key: "avgCost", header: "평단(원)", align: "right", cell: (row) => wonPrice(row.avgCost) },
  {
    key: "lastPrice",
    header: "가격(원)",
    align: "right",
    cell: (row) => {
      const price = wonPrice(row.lastPrice);
      return price === EMPTY ? price : <span title={krPositionPriceTitle(row)}>{price}</span>;
    },
  },
  { key: "marketValue", header: "평가액(원)", align: "right", sortValue: (row) => row.marketValue, cell: (row) => formatNumber(row.marketValue, 0) },
  { key: "weightPct", header: "비중", align: "right", sortValue: (row) => row.weightPct, cell: (row) => formatWithUnit(row.weightPct, 1, "%") },
  {
    key: "unrealizedPct",
    header: "평가 손익",
    align: "right",
    sortValue: (row) => row.unrealizedPct,
    cell: (row) => {
      const text = formatPercent(row.unrealizedPct);
      return text === EMPTY ? text : <span className={deltaColor(row.unrealizedPct)}>{text}</span>;
    },
  },
  { key: "highWatermark", header: "최고가(원)", align: "right", cell: (row) => wonPrice(row.highWatermark) },
  // 스탑 가격과 거리는 두 줄 — 한 줄로 두면 1280px 카드에서 보유 기간 칸이 밖으로 밀렸습니다.
  { key: "stop", header: "스탑 가격(원)", align: "right", cell: (row) => krStopCell(row) },
  // 보유 기간은 낱말 사이에서만 줄바꿈(break-keep — 한 글자씩 접지 않음), 최소 폭은 날짜 한 줄.
  { key: "held", header: "보유 기간", className: "min-w-[8rem] break-keep", cell: (row) => <span className="text-xs">{heldText(row, "KR")}</span> },
];

/** 한국 스탑 칸 — 가격 한 줄과 거리('거리 8.7%') 작은 한 줄. 현금성('적용 안 함')·값 없음은 글 그대로. */
function krStopCell(row: PaperPosition): ReactNode {
  const text = stopText(row, "KR");
  const cut = text.indexOf(" · ");
  if (cut < 0) return text;
  return (
    <span className="flex flex-col items-end">
      <span>{text.slice(0, cut)}</span>
      <span className="text-[11px] text-text-3">{text.slice(cut + 3)}</span>
    </span>
  );
}

/** 한 칸 두 줄 — 위는 본문, 아래는 작은 보조 글(같은 행의 관련 값 — 칸 수를 줄여 1280px 카드 안에 표가 들어가게). */
function TwoLines({ top, bottom }: { top: ReactNode; bottom: ReactNode }) {
  return (
    <span className="flex flex-col">
      <span>{top}</span>
      <span className="text-[11px] text-text-3">{bottom}</span>
    </span>
  );
}

/**
 * 두 줄 칸 안의 한 값(앞에 라벨 — '목표'·'체결'·'슬리피지' 등 — 이 붙을 수 있음). 값이 없으면("—") 글 대신 Empty — 기호는 읽어 주기에서 빼고 '값 없음'을
 * 읽습니다(Empty.tsx — 기호만 읽으면 뜻이 전해지지 않음). 칸 전체가 "—"이면 표(DataTable)가 같은 Empty로 그리지만, 칸 안의 한 줄은 표가 알 수 없어
 * 여기서 그립니다. 계좌2 표만 씁니다(한국 표는 그대로).
 */
function part(text: string, label?: string): ReactNode {
  if (text !== EMPTY) return label ? `${label} ${text}` : text;
  return label ? <>{label} <Empty /></> : <Empty />;
}

const KR_LOCKOUT_COLUMNS: readonly Column<PaperLockout>[] = [
  { key: "ticker", header: "종목", cell: (row) => row.ticker },
  { key: "until", header: "이 날까지(KR 거래일)", cell: (row) => row.untilTradingDate },
  { key: "reason", header: "사유", cell: (row) => row.reason || EMPTY },
];

/*
 * 한국 주문 표 — 미국 열 열한 개를 여덟 칸으로 묶습니다(낸 시각·기준일, 체결 시점·출처, 만료·체결 시각을 두 줄로). 열한 칸 그대로면 1280px 카드에서
 * 표가 1.5배로 넓어져 맨 끝 '근거'(명세 §9 F2 — STOP 근거 confirmedHighWatermark·stopBasisNote)가 가로 스크롤 밖으로 숨었습니다. 한국어 칸은
 * 낱말 사이에서만 줄바꿈(break-keep)하고 최소 폭을 두어 좁은 화면에서도 한 글자씩 접지 않습니다.
 */
const KR_ORDER_COLUMNS: readonly Column<PaperOrder>[] = [
  {
    key: "createdAt",
    header: "낸 시각·기준일",
    className: "whitespace-nowrap",
    cell: (row) => <TwoLines top={formatKst(row.createdAtKst)} bottom={`기준 ${row.asOfTradingDate ?? EMPTY}`} />,
  },
  { key: "ticker", header: "종목", className: "whitespace-nowrap", cell: (row) => row.ticker },
  { key: "side", header: "방향", className: "whitespace-nowrap", cell: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
  { key: "size", header: "크기", align: "right", cell: (row) => orderSizeText(row) },
  {
    key: "timing",
    header: "체결 시점·출처",
    className: "min-w-[6.5rem] break-keep",
    cell: (row) => <TwoLines top={timingLabel(row.timing)} bottom={sourceLabel(row.source)} />,
  },
  {
    key: "status",
    header: "상태",
    className: "min-w-[11rem] break-keep",
    cell: (row) => {
      const reject = krOrderRejectText(row.rejectReason);
      return (
        <span className="flex flex-wrap items-center gap-1">
          <Badges badges={[orderStatusBadge(row.status)]} />
          {reject.label && <span className="text-xs font-semibold text-warn">{reject.label}</span>}
          {reject.detail && <span className="text-xs text-warn">{reject.detail}</span>}
        </span>
      );
    },
  },
  {
    key: "expires",
    header: "만료·체결 시각",
    className: "whitespace-nowrap",
    cell: (row) => <TwoLines top={`만료 ${row.expiresOn ?? EMPTY}`} bottom={`체결 ${formatKst(row.filledAtKst)}`} />,
  },
  // 스탑 주문은 감지·재판정 근거(확정값으로 낮춘 최고가·stopBasisNote)를 문장으로 — 그 밖은 미국과 같은 근거 문장.
  {
    key: "reason",
    header: "근거",
    className: "min-w-[11rem] break-keep",
    cell: (row) => {
      const text = krStopBasisText(row.reason) ?? orderReasonText(row.reason, 80);
      return text === EMPTY ? text : <span className="text-xs text-muted" title={jsonTitle(row.reason)}>{text}</span>;
    },
  },
];

const KR_FILL_COLUMNS: readonly Column<PaperFill>[] = [
  // 관측 시각과 봉 날짜는 한 칸 두 줄(칸을 줄여 1280px 카드 안에 표가 들어가게).
  {
    key: "observedAt",
    header: "관측 시각·봉 날짜",
    className: "whitespace-nowrap",
    cell: (row) => <TwoLines top={formatKst(row.observedAtKst)} bottom={`봉 ${row.observationDate ?? EMPTY}`} />,
  },
  {
    key: "ticker",
    header: "종목",
    className: "min-w-[9rem]",
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1">
        <span>{row.ticker}</span>
        <Badges badges={krFillBadges(row)} />
      </span>
    ),
  },
  { key: "side", header: "방향", className: "whitespace-nowrap", cell: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
  { key: "qty", header: "수량(주)", align: "right", cell: (row) => formatNumber(row.qty, 0) },
  {
    key: "price",
    header: "잠정 체결가(원)",
    align: "right",
    cell: (row) => (
      <span className="flex flex-col items-end">
        <span>{wonPrice(row.price)}</span>
        {/* 출처 이름은 낱말 사이에서 줄바꿈(오른쪽 정렬 칸은 줄바꿈 없음이 기본) — 칸 폭이 머리 폭을 넘지 않게. */}
        <span className="whitespace-normal break-keep text-[11px] text-text-3">{krPriceSourceLabel(row.priceSource)}</span>
      </span>
    ),
  },
  // 비용 두 칸은 잠정 체결(토스 잠정가)의 값이고, 확정 조정 행이 있으면 장부가 확정가로 다시 세어 현금을 맞춘 값을 그 아래 '확정'으로 붙입니다.
  // 비용 칸 세 값의 순서(수수료 · 세금 · 슬리피지)는 카드 부제에 — 머리를 짧게 해야 1280px 카드 안에 표가 들어갑니다.
  {
    key: "costs",
    header: "잠정 비용(원)",
    align: "right",
    cell: (row) => withConfirmed(krCostText(row.fee, row.tax, row.slippageCost), krConfirmationCells(row).costs),
  },
  {
    key: "costBp",
    header: "잠정 실효 비용",
    align: "right",
    cell: (row) => withConfirmed(formatWithUnit(row.costBp, 2, "bp"), krConfirmationCells(row).costBp),
  },
  // 확정 조정 행의 세 값(확정가·잠정 대비 가격 차이·현금 차이)을 한 칸에 — 칸을 줄여 1280px 카드 안에 표가 들어가게. 행이 없으면 "—".
  {
    key: "confirmedPrice",
    header: "확정 조정(원)",
    align: "right",
    cell: (row) => {
      const cells = krConfirmationCells(row);
      return cells.price === EMPTY ? cells.price : (
        <span className="flex flex-col items-end">
          <span>{cells.price}</span>
          <span className="text-[11px] text-text-3">차이 {cells.diff}</span>
          <span className="text-[11px] text-text-2">현금 {cells.cash}</span>
        </span>
      );
    },
  },
];

const KR_NAV_COLUMNS: readonly Column<KrNavRow>[] = [
  { key: "date", header: "거래일", className: "whitespace-nowrap", cell: (row) => row.tradingDate },
  { key: "nav", header: "순자산(원)", align: "right", cell: (row) => row.nav },
  { key: "cash", header: "현금(원)", align: "right", cell: (row) => row.cash },
  { key: "exposure", header: "노출", align: "right", cell: (row) => row.exposure },
  {
    key: "final",
    header: "가격",
    cell: (row) => (
      <span className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${row.pricesFinal
        ? "border-ok/40 bg-ok-tint text-ok" : "border-warn/40 bg-warn-tint text-warn"}`}>
        {row.pricesFinal ? "확정(금융위 종가)" : "잠정"}
      </span>
    ),
  },
  {
    key: "reason",
    header: "잠정 사유",
    className: "min-w-[16rem]",
    cell: (row) => (row.reason === null ? EMPTY : row.reason === EMPTY
      ? <span className="text-xs text-muted">{EMPTY} 최근 작업 기록에 사유 없음</span>
      : <span className="text-xs text-body">{row.reason}</span>),
  },
];

/** 순자산 기록 표에 보일 최근 거래일 수(한국). */
const NAV_ROWS = 20;

/**
 * 보유·체결 탭 — 책 하나를 골라 보유·재진입 금지·주문·체결을 봅니다(표는 DataTable — 모르는 칸은 "—"). 일시정지/재개와 책 초기화
 * (확인 창에서 계좌 코드를 그대로 입력)도 여기서.
 *
 * 책 목록은 개요 응답에서 받습니다(PaperScreen). 책을 바꾸면 useApi가 이전 책의 표를 바로 비워, 새 책 제목 아래 옛 책의
 * 숫자가 잠깐 보이지 않습니다. 버튼이 성공하면 이 탭의 표와 개요(onChanged)를 함께 다시 읽습니다.
 */
export function HoldingsSection({
  books,
  onChanged,
  initialBook = "",
  market = "US",
}: {
  books: PaperBookSummary[];
  onChanged: () => void;
  /** 처음 고를 계좌 코드(개요의 계좌 상세에서 넘어올 때). 목록에 없으면 기본 계좌로 엽니다. */
  initialBook?: string;
  /**
   * 화면의 시장(2단계 명세 §4-16) — 한국은 원 단위 정수 칸·세 배지·확정 조정·실효 비용 bp·스탑 근거와 '순자산 기록'(잠정 사유) 카드가 더해지고,
   * 리셋 문구가 다릅니다(사후 체결 없음). 미국 화면은 예전 그대로.
   */
  market?: PaperMarketCode;
}) {
  const korea = market === "KR";
  const [picked, setPicked] = useState(initialBook);
  const code = resolveBookCode(picked, books);

  const positions = useApi<PaperPositionsResponse>(code ? endpoints.paper.positions(code) : null, 60_000);
  const orders = useApi<PaperOrdersResponse>(code ? endpoints.paper.orders(code, RECENT_LIMIT) : null, 60_000);
  const fills = useApi<PaperFillsResponse>(code ? endpoints.paper.fills(code, RECENT_LIMIT) : null, 60_000);
  // 한국만 — 순자산 기록(잠정/확정)과 그 잠정 사유·확정 조정 '주의'를 고를 작업 기록(상태 응답 최근 30건, kr.risk 메모).
  const nav = useApi<PaperNavResponse>(korea && code ? endpoints.paper.nav(code) : null, 60_000);
  // 미국 Claude 계좌2만 — 실행 감사(주문의 목표 시각·계좌1식 대비 bp).
  const timed = !korea && isTimedBook(code);
  const execution = useApi<PaperExecutionResponse>(timed && code ? endpoints.paper.execution(code, RECENT_LIMIT) : null, 60_000);
  const status = useApi<PaperStatusResponse>(korea && code ? endpoints.paper.market("KR").status : null, 60_000);

  const toggle = useAsyncAction(
    (bookCode: string, status: "ACTIVE" | "PAUSED") =>
      apiPost<PaperBookStatusResult>(endpoints.paper.bookStatus(bookCode), { status }),
    "계좌 상태를 바꾸지 못했습니다.",
  );
  const reset = useAsyncAction(
    (bookCode: string, confirm: string) => apiPost<PaperBookResetResult>(endpoints.paper.bookReset(bookCode), { confirm }),
    "계좌를 초기화하지 못했습니다.",
  );
  // 계좌 초기화 확인 창. 입력 글자는 창 안에 있어 창을 닫으면 비워집니다(다시 열면 처음부터 — 계좌 코드를 다시 쳐야 함).
  const [confirmingReset, setConfirmingReset] = useState(false);

  const reloadAll = () => {
    void positions.reload();
    void orders.reload();
    void fills.reload();
    if (korea) {
      void nav.reload();
      void status.reload();
    }
    if (timed) void execution.reload();
    onChanged();
  };

  if (!code) {
    return (
      <Banner tone="info">
        {korea
          ? "아직 한국 계좌가 없습니다 — 출발일이 정해지면 개요 탭의 '한국 초기화'로 네 계좌가 생깁니다(쉬는 사유는 위 경고)."
          : "아직 계좌가 없습니다 — 개요 탭에서 초기화하면 생깁니다."}
      </Banner>
    );
  }

  // 보유 응답의 책 요약이 가장 새것입니다(버튼 뒤 다시 읽음). 아직 없으면 개요의 책 요약을 씁니다.
  const book = positions.data?.book ?? books.find((entry) => entry.code === code) ?? null;
  const summary = book ? bookCard(book, books, market) : null;
  const ledgerSource = korea ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger;
  const jobs = status.data?.available ? (status.data.jobs ?? []) : null;
  const cautions = korea && jobs ? krConfirmationCautions(jobs, code) : [];
  const totalText = korea ? krConfirmationTotalText(fills.data?.confirmationTotal) : null;
  const action = statusToggle(book?.status);
  const audit = executionByOrder(execution.data);
  const orderColumns = korea ? KR_ORDER_COLUMNS : timed ? timedOrderColumns(audit) : ORDER_COLUMNS;
  const fillColumns = korea ? KR_FILL_COLUMNS : timed ? timedFillColumns(audit) : FILL_COLUMNS;
  // 버튼 결과는 그 책을 보고 있을 때만 — 다른 책으로 바꾼 뒤 옛 책의 결과가 새 책 이름 아래 남지 않게.
  const toggleResult = toggle.result?.book?.code === code ? toggle.result : null;
  const resetResult = reset.result?.book?.code === code ? resetResultView(reset.result) : null;

  const changeStatus = async () => {
    if (action && (await toggle.run(code, action.next))) reloadAll();
  };
  const runReset = async (typed: string) => {
    // confirm은 사람이 친 글자 그대로입니다(확인 창은 계좌 코드와 같을 때만 부름) — 서버가 계좌 코드와 같은지 다시 봅니다(아니면 400).
    // 계좌 코드를 대신 채워 보내면 서버 검사가 늘 통과해 두 번째 울타리가 되지 못합니다.
    const ok = await reset.run(code, typed);
    // 성공·실패 모두 창을 닫습니다 — 실패 사유(서버 400 문구)는 아래 경고로 남고, 다시 하려면 창을 열어 코드를 다시 칩니다.
    setConfirmingReset(false);
    if (ok) reloadAll();
  };

  return (
    <>
      <Card
        title="계좌"
        source={ledgerSource}
        actions={<Freshness refreshError={positions.refreshError ?? orders.refreshError ?? fills.refreshError} />}
      >
        <div className="flex flex-wrap items-end gap-4">
          <Select
            label="계좌 고르기"
            value={code}
            onChange={(value) => setPicked(value)}
            options={bookOptions(books)}
          />
          {summary && (
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              <div>
                <dt className="text-muted">상태</dt>
                <dd><span className={`rounded-sm border px-2 py-0.5 text-[11px] ${summary.status.className}`}>{summary.status.label}</span></dd>
              </div>
              <Pair label="순자산" value={summary.nav} />
              <Pair label="수익률" value={summary.returnPct} tone={deltaColor(book?.returnPct)} />
              <Pair label="현금" value={summary.cash} />
              <Pair label="주식 노출" value={summary.exposure} />
              <Pair label="출발" value={summary.startedOn} />
            </dl>
          )}
        </div>

        <div className="mt-4 grid gap-4 border-t border-border pt-4 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-bright">일시정지 · 재개</h3>
            <p className="text-xs leading-relaxed text-muted">
              일시정지하면 대기 주문을 취소하고 새 체결·스탑을 멈춥니다. 평가(순자산 기록)는 계속합니다.
            </p>
            {action ? (
              <div>
                <Button onClick={() => void changeStatus()} disabled={toggle.busy}>
                  {toggle.busy ? "바꾸는 중…" : action.label}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted">{korea ? krNotStartedNote() : notStartedNote(book?.kind, book)}</p>
            )}
            {toggle.error && <Banner tone="warn">{toggle.error}</Banner>}
            {toggleResult && <Banner tone="info">{statusResultText(toggleResult)}</Banner>}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-bright">계좌 초기화</h3>
            {korea ? (
              <p className="text-xs leading-relaxed text-muted">
                이 계좌의 체결·주문·보유·재진입 금지·확정 조정·순자산 기록을 모두 지웁니다. 되돌릴 수 없습니다. {KR_RESET_NOTE}
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-muted">
                이 계좌의 체결·주문·보유·재진입 금지·순자산 기록을 모두 지웁니다. 되돌릴 수 없습니다. 벤치마크 계좌는 출발일 종가로
                다시 사후 체결하고(종가가 없으면 &quot;시작 전&quot;으로 남고 사유를 보입니다), 규칙·Claude 계좌는 현금만 든
                &quot;시작 전&quot;으로 돌아갑니다.
              </p>
            )}
            <div>
              {/* 누르면 확인 창 — 계좌 코드를 그대로 쳐야 확인이 열립니다(잘못 누르기를 먼저 막음). 서버도 confirm을 다시 봅니다. */}
              <Button onClick={() => setConfirmingReset(true)} disabled={reset.busy}>
                {reset.busy ? "초기화 중…" : "계좌 초기화"}
              </Button>
            </div>
            <ConfirmDialog
              open={confirmingReset}
              onOpenChange={setConfirmingReset}
              title={`${book?.label ?? code} 초기화`}
              description={
                <>
                  <p>
                    이 계좌(<code>{code}</code>)의 체결·주문·보유·재진입 금지·순자산 기록을 모두 지웁니다. 되돌릴 수 없습니다.
                  </p>
                  <p className="mt-1">{korea
                    ? KR_RESET_NOTE
                    : book?.kind === "BENCHMARK"
                      ? "벤치마크 계좌는 출발일 종가로 다시 사후 체결합니다(종가가 없으면 \"시작 전\"으로 남고 사유를 보입니다)."
                      : timed
                        ? "Claude 계좌2는 현금만 든 \"시작 전\"으로 돌아갑니다 — 다시 출발은 앞으로 체결 출발뿐입니다(사후 체결로 메우지 않음)."
                        : "규칙·Claude 계좌는 현금만 든 \"시작 전\"으로 돌아갑니다."}</p>
                </>
              }
              confirmLabel={reset.busy ? "초기화 중…" : "초기화 확인"}
              tone="danger"
              busy={reset.busy}
              requireText={code}
              onConfirm={(typed) => void runReset(typed)}
            />
            {/* 결과·오류는 늘 그려 둔 알림 영역(role=status) 안에 — 확인 창이 닫히면 초점이 '계좌 초기화' 단추로 돌아가므로, 이 영역이
                없으면 낭독기 사용자는 성공·실패를 듣지 못합니다(영역이 먼저 있어야 새 내용을 읽음). 비어 있으면 높이·간격이 없습니다. */}
            <div role="status" className="flex flex-col gap-2 empty:-mt-2">
              {reset.error && <Banner tone="warn">{reset.error}</Banner>}
              {resetResult && <Banner tone={resetResult.tone}>{resetResult.text}</Banner>}
            </div>
          </div>
        </div>
      </Card>

      <Card
        title="보유"
        subtitle={korea
          ? "가격·평가액·비중·스탑은 장부가 계산한 값입니다(평가 가격은 토스증권 잠정 — 금융위 확정 종가가 들어온 날은 순자산 기록에서 확정). "
            + "가격이 없는 보유는 지난 값(없으면 평단)으로 평가하고 스탑 판정을 건너뛰며, 미처리 기업행위 보유는 묶인 평가 그대로입니다."
          : "가격·평가액·비중·스탑은 장부가 계산한 값입니다. 가격이 없는 보유는 지난 값(없으면 평단)으로 평가하고 스탑 판정을 건너뜁니다."}
        source={ledgerSource}
      >
        {positions.loading && !positions.data && <Loading label="보유를 읽는 중…" />}
        {positions.error && <ErrorState message={positions.error} onRetry={positions.reload} />}
        {positions.data && !positions.data.available && <Banner tone="warn">{positions.data.message}</Banner>}
        {positions.data?.available && (
          <>
            {korea && (positions.data.positions ?? []).length === 0 ? (
              <KrEmpty>보유가 없습니다 — 현금만 들고 있습니다.</KrEmpty>
            ) : (
              <DataTable<PaperPosition>
                columns={korea ? KR_POSITION_COLUMNS : POSITION_COLUMNS}
                rows={positions.data.positions ?? []}
                rowKey={(row) => row.ticker}
                caption="보유"
                scrollHint="overflow"
                emptyText="보유가 없습니다 — 현금만 들고 있습니다."
              />
            )}
            <p className="mt-2 text-xs text-muted">
              {korea ? `현금 ${formatMoney(positions.data.cash, "KR")}` : `현금 ${formatNumber(positions.data.cash, 2)} 달러`}
            </p>
          </>
        )}
      </Card>

      {positions.data?.available && (
        <Card
          title="재진입 금지"
          subtitle={korea
            ? "트레일링 스탑으로 판 종목은 체결한 날부터 정해진 KR 거래일 동안 다시 사지 않습니다."
            : "트레일링 스탑으로 판 종목은 정해진 거래일 동안 다시 사지 않습니다."}
          source={ledgerSource}
        >
          <DataTable<PaperLockout>
            columns={korea ? KR_LOCKOUT_COLUMNS : LOCKOUT_COLUMNS}
            rows={positions.data.lockouts ?? []}
            rowKey={(row) => row.ticker}
            caption="재진입 금지"
            scrollHint="overflow"
            emptyText="재진입 금지 종목이 없습니다."
          />
        </Card>
      )}

      <Card
        title={`주문 (최근 ${RECENT_LIMIT}건)`}
        subtitle={korea
          ? "한국 주문은 다음 KR 거래일 시가(KRX 시가 단일가)에 체결합니다. 트레일링 스탑은 밤 잠정 종가로 감지해 다음 거래일 시가에 팔고, "
            + "체결 때 감지한 날의 금융위 확정 종가로 다시 판정합니다(스탑가 위면 취소)."
          : timed
            ? "Claude 계좌2 주문은 다음 세션 하루짜리입니다(장중 확인이 장중에 낸 주문은 그 세션 하루 — 장중 시장가는 주문 생성 + 60초 뒤 첫 분이 "
              + "기준 시각이고, 그 1분봉이 들어온 뒤 다른 시점과 같은 사다리로 체결) — 목표 시각은 고른 시점의 시각(KST), 계좌1식 대비는 같은 주문을 다음 시간별 관측치로 "
              + "체결했다면의 원가격 대비 bp(실행 감사 — 양수면 고른 시점이 유리, 반사실이 아직 없거나 대체 체결이면 —)입니다. 1분봉에 그 시각 뒤 "
              + "거래가 없으면 체결하지 않고 그날 마감 뒤 만료합니다(사유 NO_TRADE_AFTER_T 등)."
            : undefined}
        source={ledgerSource}
      >
        {orders.loading && !orders.data && <Loading label="주문을 읽는 중…" />}
        {orders.error && <ErrorState message={orders.error} onRetry={orders.reload} />}
        {orders.data && !orders.data.available && <Banner tone="warn">{orders.data.message}</Banner>}
        {orders.data?.available && (
          korea && (orders.data.orders ?? []).length === 0 ? (
            <KrEmpty>주문이 없습니다.</KrEmpty>
          ) : (
            <DataTable<PaperOrder>
              columns={orderColumns}
              rows={orders.data.orders ?? []}
              rowKey={(row) => String(row.id)}
              caption="주문"
              scrollHint="overflow"
              emptyText="주문이 없습니다."
            />
          )
        )}
      </Card>

      <Card
        title={`체결 (최근 ${RECENT_LIMIT}건)`}
        subtitle={korea
          ? "잠정 체결가는 토스증권(KRX 시가 단일가 — 1분봉 개장 봉, 없으면 일봉 시가)이고, 금융위원회(공공데이터포털) 확정가가 들어오면 "
            + "체결 행은 그대로 둔 채 확정 조정 행으로 현금·평단을 맞춥니다(보통 다음 영업일 13시 뒤). 실효 비용 = (수수료 + 세금 + 슬리피지) "
            + "÷ (체결가 × 수량) — 서버 계산. 비용 칸은 수수료 · 세금 · 슬리피지(원)이고, 두 비용 칸은 잠정 체결의 값 — 확정 조정 행이 있으면 "
            + "확정가로 다시 센 값('확정')을 그 아래에 둡니다."
          : timed
            ? "체결가는 고른 시각의 Yahoo 1분봉 시가(사다리 R1·R2) 또는 표시된 대체 체결가(R2b·R3·확정 종가 — '대체 체결' 배지)에 슬리피지를 얹은 "
              + "값입니다. 관측 시각은 장부가 그 체결을 반영한 관측치의 수집 시각, 체결 봉은 그 가격의 1분봉 시작입니다(종가·관측 종가 칸이면 —)."
            : "체결가는 관측가에 슬리피지를 얹은 값입니다. 사후 체결은 그날 종가로 나중에 기록한 것입니다."}
        source={ledgerSource}
      >
        {fills.loading && !fills.data && <Loading label="체결을 읽는 중…" />}
        {fills.error && <ErrorState message={fills.error} onRetry={fills.reload} />}
        {fills.data && !fills.data.available && <Banner tone="warn">{fills.data.message}</Banner>}
        {fills.data?.available && (
          <>
            {totalText && <p className="mb-2 text-xs font-semibold tabular-nums text-bright">{totalText}</p>}
            {cautions.length > 0 && (
              <div className="mb-2">
                <Banner tone="warn">
                  <strong>확정 조정 주의</strong> — 잠정 체결의 비용 칸이 그 판의 요율로 다시 센 값과 다릅니다(체결 처리 중에 설정이
                  저장됨 등). 현금은 확정 기준으로 맞췄습니다.
                  <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
                    {cautions.map((note) => <li key={note}>{note}</li>)}
                  </ul>
                </Banner>
              </div>
            )}
            {korea && (fills.data.fills ?? []).length === 0 ? (
              <KrEmpty>체결이 없습니다 — 한국 계좌는 출발 결정 다음 KR 거래일 시가에 처음 체결합니다.</KrEmpty>
            ) : (
              <DataTable<PaperFill>
                columns={fillColumns}
                rows={fills.data.fills ?? []}
                rowKey={(row) => String(row.id)}
                caption="체결"
                scrollHint="overflow"
                emptyText="체결이 없습니다."
              />
            )}
          </>
        )}
      </Card>

      {korea && (
        <Card
          title={`순자산 기록 (최근 ${NAV_ROWS}거래일)`}
          subtitle={"거래일마다 한 줄 — 잠정 줄은 토스 잠정 평가이고, 그날까지 체결이 모두 확정되고 보유가 모두 금융위 그날 종가로 평가되고 "
            + "그날 이하 봉으로 체결될 수 있는 대기 주문이 없으면 확정(금융위 종가)으로 다시 씁니다. 잠정 사유는 리스크 점검 작업 기록(최근 30건)의 "
            + "확정 조정 메모입니다."}
          source={`${PAPER_SOURCES.krLedger} · ${PAPER_SOURCES.jobs}`}
        >
          {nav.loading && !nav.data && <Loading label="순자산 기록을 읽는 중…" />}
          {nav.error && <ErrorState message={nav.error} onRetry={nav.reload} />}
          {nav.data && !nav.data.available && <Banner tone="warn">{nav.data.message}</Banner>}
          {status.error && <p className="mb-2 text-xs text-warn">작업 기록을 읽지 못해 잠정 사유를 고르지 못했습니다 — {status.error}</p>}
          {nav.data?.available && ((nav.data.series ?? []).length === 0 ? (
            <KrEmpty>순자산 기록이 없습니다 — 출발일 줄(현금만, 확정)은 출발 결정 때 생깁니다.</KrEmpty>
          ) : (
            <DataTable<KrNavRow>
              columns={KR_NAV_COLUMNS}
              rows={krNavRows(nav.data.series, jobs, code).slice(0, NAV_ROWS)}
              rowKey={(row) => row.tradingDate}
              caption="순자산 기록"
              scrollHint="overflow"
              emptyText="순자산 기록이 없습니다."
            />
          ))}
        </Card>
      )}
    </>
  );
}

/**
 * 잠정 값 한 줄과, 확정 조정 행이 있으면 그 아래 '확정 …' 한 줄(작은 글). 확정 값이 "—"(행 없음)이면 잠정 값 글 그대로 — 그 글이 "—"면 표가
 * 값 없음(Empty)으로 그립니다.
 */
function withConfirmed(provisional: string, confirmed: string): ReactNode {
  if (confirmed === EMPTY) return provisional;
  return (
    <span className="flex flex-col items-end">
      <span>{provisional}</span>
      <span className="whitespace-nowrap text-[11px] text-text-3">{`확정 ${confirmed}`}</span>
    </span>
  );
}

/**
 * 한국 표가 비었을 때의 글 — 칸이 많은 표는 휴대폰 폭에서 가로로 넘쳐, 표 안 가운데 정렬한 빈 줄 글이 화면 밖으로 잘렸습니다(머리만 있는 빈 표는
 * 읽을 것도 없음). 그래서 한국 화면은 빈 표 대신 이 글만 둡니다.
 */
function KrEmpty({ children }: { children: ReactNode }) {
  return <p className="py-2 text-sm leading-relaxed text-text-3">{children}</p>;
}

function Pair({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className={`tabular-nums font-semibold ${tone ?? "text-bright"}`}>{value}</dd>
    </div>
  );
}

function Badges({ badges }: { badges: Badge[] }) {
  return (
    <>
      {badges.map((badge) => (
        <span
          key={badge.key}
          title={badge.title}
          className={`whitespace-nowrap rounded-sm border px-1.5 py-px text-[10px] ${badge.className}`}
        >
          {badge.label}
        </span>
      ))}
    </>
  );
}
