"use client";

import { useState } from "react";
import { Banner, Button, Card, ErrorState, Freshness, Loading, Select, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { deltaColor, EMPTY, formatKst, formatNumber, formatPercent, formatWithUnit } from "@/lib/format";
import {
  type Badge,
  bookCard,
  bookOptions,
  fillBadges,
  formatSharePrice,
  heldText,
  jsonTitle,
  notStartedNote,
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
import type {
  PaperBookResetResult,
  PaperBookStatusResult,
  PaperBookSummary,
  PaperFill,
  PaperFillsResponse,
  PaperLockout,
  PaperOrder,
  PaperOrdersResponse,
  PaperPosition,
  PaperPositionsResponse,
} from "@/lib/types";

/** 주문·체결 표에 보일 최근 건수. 서버 상한은 500입니다. */
const RECENT_LIMIT = 50;

/**
 * 보유·체결 탭 — 책 하나를 골라 보유·재진입 금지·주문·체결을 봅니다. 일시정지/재개와 책 초기화(확인 입력)도 여기서.
 *
 * 책 목록은 개요 응답에서 받습니다(page.tsx). 책을 바꾸면 useApi가 이전 책의 표를 바로 비워, 새 책 제목 아래 옛 책의
 * 숫자가 잠깐 보이지 않습니다. 버튼이 성공하면 이 탭의 표와 개요(onChanged)를 함께 다시 읽습니다.
 */
export function HoldingsSection({
  books,
  onChanged,
  initialBook = "",
}: {
  books: PaperBookSummary[];
  onChanged: () => void;
  /** 처음 고를 계좌 코드(개요의 계좌 상세에서 넘어올 때). 목록에 없으면 기본 계좌로 엽니다. */
  initialBook?: string;
}) {
  const [picked, setPicked] = useState(initialBook);
  const code = resolveBookCode(picked, books);

  const positions = useApi<PaperPositionsResponse>(code ? endpoints.paper.positions(code) : null, 60_000);
  const orders = useApi<PaperOrdersResponse>(code ? endpoints.paper.orders(code, RECENT_LIMIT) : null, 60_000);
  const fills = useApi<PaperFillsResponse>(code ? endpoints.paper.fills(code, RECENT_LIMIT) : null, 60_000);

  const toggle = useAsyncAction(
    (bookCode: string, status: "ACTIVE" | "PAUSED") =>
      apiPost<PaperBookStatusResult>(endpoints.paper.bookStatus(bookCode), { status }),
    "계좌 상태를 바꾸지 못했습니다.",
  );
  const reset = useAsyncAction(
    (bookCode: string, confirm: string) => apiPost<PaperBookResetResult>(endpoints.paper.bookReset(bookCode), { confirm }),
    "계좌를 초기화하지 못했습니다.",
  );
  const [confirm, setConfirm] = useState("");

  const reloadAll = () => {
    void positions.reload();
    void orders.reload();
    void fills.reload();
    onChanged();
  };

  if (!code) {
    return <Banner tone="info">아직 계좌가 없습니다 — 개요 탭에서 초기화하면 생깁니다.</Banner>;
  }

  // 보유 응답의 책 요약이 가장 새것입니다(버튼 뒤 다시 읽음). 아직 없으면 개요의 책 요약을 씁니다.
  const book = positions.data?.book ?? books.find((entry) => entry.code === code) ?? null;
  const summary = book ? bookCard(book, books) : null;
  const action = statusToggle(book?.status);
  // 버튼 결과는 그 책을 보고 있을 때만 — 다른 책으로 바꾼 뒤 옛 책의 결과가 새 책 이름 아래 남지 않게.
  const toggleResult = toggle.result?.book?.code === code ? toggle.result : null;
  const resetResult = reset.result?.book?.code === code ? resetResultView(reset.result) : null;

  const changeStatus = async () => {
    if (action && (await toggle.run(code, action.next))) reloadAll();
  };
  const runReset = async () => {
    // 성공했을 때만 확인 입력을 지웁니다(실패면 고쳐 다시 누를 수 있게, QA-051과 같음).
    if (await reset.run(code, confirm)) {
      setConfirm("");
      reloadAll();
    }
  };

  return (
    <>
      <Card
        title="계좌"
        source={PAPER_SOURCES.ledger}
        actions={<Freshness refreshError={positions.refreshError ?? orders.refreshError ?? fills.refreshError} />}
      >
        <div className="flex flex-wrap items-end gap-4">
          <Select
            label="계좌 고르기"
            value={code}
            onChange={(value) => {
              setPicked(value);
              setConfirm("");
            }}
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
              <p className="text-xs text-muted">{notStartedNote(book?.kind)}</p>
            )}
            {toggle.error && <Banner tone="warn">{toggle.error}</Banner>}
            {toggleResult && <Banner tone="info">{statusResultText(toggleResult)}</Banner>}
          </div>

          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-bright">계좌 초기화</h3>
            <p className="text-xs leading-relaxed text-muted">
              이 계좌의 체결·주문·보유·재진입 금지·순자산 기록을 모두 지웁니다. 되돌릴 수 없습니다. 벤치마크 계좌는 출발일 종가로
              다시 사후 체결하고(종가가 없으면 &quot;시작 전&quot;으로 남고 사유를 보입니다), 규칙·Claude 계좌는 현금만 든
              &quot;시작 전&quot;으로 돌아갑니다.
            </p>
            <label className="text-xs text-muted">
              확인하려면 계좌 코드 <code className="text-body">{code}</code>를 입력하세요
              <input
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm text-body outline-hidden focus:border-accent sm:max-w-[22rem]"
              />
            </label>
            <div>
              {/* 서버도 confirm이 책 코드와 같은지 다시 봅니다(아니면 400). 여기서는 잘못 누르기를 먼저 막습니다. */}
              <Button onClick={() => void runReset()} disabled={reset.busy || confirm !== code}>
                {reset.busy ? "초기화 중…" : "계좌 초기화"}
              </Button>
            </div>
            {reset.error && <Banner tone="warn">{reset.error}</Banner>}
            {resetResult && <Banner tone={resetResult.tone}>{resetResult.text}</Banner>}
          </div>
        </div>
      </Card>

      <Card
        title="보유"
        subtitle="가격·평가액·비중·스탑은 장부가 계산한 값입니다. 가격이 없는 보유는 지난 값(없으면 평단)으로 평가하고 스탑 판정을 건너뜁니다."
        source={PAPER_SOURCES.ledger}
      >
        {positions.loading && !positions.data && <Loading label="보유를 읽는 중…" />}
        {positions.error && <ErrorState message={positions.error} onRetry={positions.reload} />}
        {positions.data && !positions.data.available && <Banner tone="warn">{positions.data.message}</Banner>}
        {positions.data?.available && (
          <>
            <Table<PaperPosition>
              rows={positions.data.positions ?? []}
              rowKey={(row) => row.ticker}
              emptyMessage="보유가 없습니다 — 현금만 들고 있습니다."
              columns={[
                {
                  key: "ticker",
                  header: "종목",
                  render: (row) => (
                    <span className="flex flex-wrap items-center gap-1">
                      <span className="font-semibold text-bright">{row.ticker}</span>
                      <Badges badges={positionBadges(row)} />
                    </span>
                  ),
                },
                { key: "qty", header: "수량", align: "right", render: (row) => formatNumber(row.qty, 0) },
                // 주당 가격은 4자리(formatSharePrice) — 2자리로 자르면 싼 종목의 5bp 슬리피지가 보이지 않습니다. 총액·비율은 2자리.
                { key: "avgCost", header: "평단(달러)", align: "right", render: (row) => formatSharePrice(row.avgCost) },
                {
                  key: "lastPrice",
                  header: "가격(달러)",
                  align: "right",
                  render: (row) => (
                    <span title={row.lastPriceAtKst ? `${formatKst(row.lastPriceAtKst)} 관측` : undefined}>
                      {formatSharePrice(row.lastPrice)}
                    </span>
                  ),
                },
                { key: "marketValue", header: "평가액(달러)", align: "right", render: (row) => formatNumber(row.marketValue, 2) },
                { key: "weightPct", header: "비중", align: "right", render: (row) => formatWithUnit(row.weightPct, 1, "%") },
                {
                  key: "unrealizedPct",
                  header: "평가 손익",
                  align: "right",
                  render: (row) => <span className={deltaColor(row.unrealizedPct)}>{formatPercent(row.unrealizedPct)}</span>,
                },
                { key: "highWatermark", header: "최고가", align: "right", render: (row) => formatSharePrice(row.highWatermark) },
                { key: "stop", header: "스탑 가격", align: "right", render: (row) => stopText(row) },
                { key: "held", header: "보유 기간", render: (row) => heldText(row) },
              ]}
            />
            <p className="mt-2 text-xs text-muted">현금 {formatNumber(positions.data.cash, 2)} 달러</p>
          </>
        )}
      </Card>

      {positions.data?.available && (
        <Card title="재진입 금지" subtitle="트레일링 스탑으로 판 종목은 정해진 거래일 동안 다시 사지 않습니다." source={PAPER_SOURCES.ledger}>
          <Table<PaperLockout>
            rows={positions.data.lockouts ?? []}
            rowKey={(row) => row.ticker}
            emptyMessage="재진입 금지 종목이 없습니다."
            columns={[
              { key: "ticker", header: "종목", render: (row) => row.ticker },
              { key: "until", header: "이 날까지(미국 거래일)", render: (row) => row.untilTradingDate },
              { key: "reason", header: "사유", render: (row) => row.reason || EMPTY },
            ]}
          />
        </Card>
      )}

      <Card title={`주문 (최근 ${RECENT_LIMIT}건)`} source={PAPER_SOURCES.ledger}>
        {orders.loading && !orders.data && <Loading label="주문을 읽는 중…" />}
        {orders.error && <ErrorState message={orders.error} onRetry={orders.reload} />}
        {orders.data && !orders.data.available && <Banner tone="warn">{orders.data.message}</Banner>}
        {orders.data?.available && (
          <Table<PaperOrder>
            rows={orders.data.orders ?? []}
            rowKey={(row) => String(row.id)}
            emptyMessage="주문이 없습니다."
            columns={[
              { key: "createdAt", header: "낸 시각", render: (row) => formatKst(row.createdAtKst) },
              { key: "ticker", header: "종목", render: (row) => row.ticker },
              { key: "side", header: "방향", render: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
              { key: "size", header: "크기", align: "right", render: (row) => orderSizeText(row) },
              { key: "timing", header: "체결 시점", render: (row) => timingLabel(row.timing) },
              { key: "source", header: "출처", render: (row) => sourceLabel(row.source) },
              {
                key: "status",
                header: "상태",
                render: (row) => (
                  <span className="flex flex-wrap items-center gap-1">
                    <Badges badges={[orderStatusBadge(row.status)]} />
                    {row.rejectReason && <span className="text-xs text-warn">{row.rejectReason}</span>}
                  </span>
                ),
              },
              { key: "asOf", header: "기준 거래일", render: (row) => row.asOfTradingDate ?? EMPTY },
              { key: "expires", header: "만료", render: (row) => row.expiresOn ?? EMPTY },
              { key: "filledAt", header: "체결 시각", render: (row) => formatKst(row.filledAtKst) },
              // 규칙 책 근거는 `rule · signal · kind`가 앞이라 키 순서대로 80자에서 자르면 문장(text)이 안 보입니다 — 결정 로그
              // 탭과 같은 orderReasonText로 문장(없으면 점수 기여)을 먼저 보이고, 전체 JSON은 마우스를 올려 봅니다.
              {
                key: "reason",
                header: "근거",
                render: (row) => (
                  <span className="text-xs text-muted" title={jsonTitle(row.reason)}>
                    {orderReasonText(row.reason, 80)}
                  </span>
                ),
              },
            ]}
          />
        )}
      </Card>

      <Card
        title={`체결 (최근 ${RECENT_LIMIT}건)`}
        subtitle="체결가는 관측가에 슬리피지를 얹은 값입니다. 사후 체결은 그날 종가로 나중에 기록한 것입니다."
        source={PAPER_SOURCES.ledger}
      >
        {fills.loading && !fills.data && <Loading label="체결을 읽는 중…" />}
        {fills.error && <ErrorState message={fills.error} onRetry={fills.reload} />}
        {fills.data && !fills.data.available && <Banner tone="warn">{fills.data.message}</Banner>}
        {fills.data?.available && (
          <Table<PaperFill>
            rows={fills.data.fills ?? []}
            rowKey={(row) => String(row.id)}
            emptyMessage="체결이 없습니다."
            columns={[
              { key: "observedAt", header: "관측 시각", render: (row) => formatKst(row.observedAtKst) },
              {
                key: "ticker",
                header: "종목",
                render: (row) => (
                  <span className="flex flex-wrap items-center gap-1">
                    <span>{row.ticker}</span>
                    <Badges badges={fillBadges(row)} />
                  </span>
                ),
              },
              { key: "side", header: "방향", render: (row) => <span className={sideClass(row.side)}>{sideLabel(row.side)}</span> },
              { key: "qty", header: "수량", align: "right", render: (row) => formatNumber(row.qty, 0) },
              { key: "price", header: "체결가(달러)", align: "right", render: (row) => formatSharePrice(row.price) },
              { key: "rawPrice", header: "관측가", align: "right", render: (row) => formatSharePrice(row.rawPrice) },
              { key: "slippage", header: "슬리피지", align: "right", render: (row) => formatWithUnit(row.slippageBp, 1, "bp") },
              { key: "gross", header: "금액(달러)", align: "right", render: (row) => formatNumber(row.gross, 2) },
              { key: "barDate", header: "봉 날짜", render: (row) => row.observationDate ?? EMPTY },
              { key: "priceSource", header: "가격 출처", render: (row) => row.priceSource ?? EMPTY },
            ]}
          />
        )}
      </Card>
    </>
  );
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
