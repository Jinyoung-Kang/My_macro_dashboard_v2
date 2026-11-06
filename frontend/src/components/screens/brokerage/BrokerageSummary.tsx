import type { ReactNode } from "react";
import { StatGrid, StatTile } from "@/components/patterns";
import { Card } from "@/components/ui";
import {
  amountDigits,
  brokerageScope,
  BUYING_POWER_NOTE,
  DAILY_PROFIT_NOTE,
  formatAmount,
  formatSignedAmount,
  marketValueNote,
  profitLossNote,
} from "@/lib/brokerage";
import { deltaColor, formatKstSeconds } from "@/lib/format";
import { marketMeta, type PaperMarketCode } from "@/lib/paperMarket";
import { SOURCES } from "@/lib/sources";
import type { BrokerageAccountResponse } from "@/lib/types/brokerage";

/**
 * 실제 계좌 요약 — 그 통화의 평가금액·매입금액·평가손익(대시보드 계산 손익률과 함께)·일간 손익(금액만)·매수 가능 금액.
 *
 * 토스 요약의 비율은 원화·달러 자산을 원화로 환산해 합친 값이라 싣지 않습니다 — 손익률은 백엔드가 같은 통화끼리 계산해 보낸 값이고
 * "대시보드 계산"이라고 적습니다. 예수금 엔드포인트가 없어 '예수금'·'총자산'이라 부르지 않습니다(현금 쪽 수치는 매수 가능 금액 하나).
 * 모르는 값은 타일이 "—"로 그립니다(0으로 채우지 않음). 평가손익·일간 손익은 아래 보유 표와 같은 색(이익 빨강·손실 파랑, 보이는 값이 0이면
 * 보조색)이고, 부호(+·−)를 함께 찍어 색만으로 뜻을 전하지 않습니다.
 */
export function BrokerageSummary({
  data,
  market,
  actions,
}: {
  data: BrokerageAccountResponse;
  market: PaperMarketCode;
  actions?: ReactNode;
}) {
  const scope = brokerageScope(market);
  const unit = marketMeta(market).unitLabel;
  const summary = data.summary;
  const amount = (value: number) => formatAmount(value, market);
  const signed = (value: number) => formatSignedAmount(value, market);
  const tone = (value: number | null | undefined) => deltaColor(value, amountDigits(market));
  // 받은 시각은 탭 머리의 기준 시각과 같은 값(초까지 — 명세 2026-11-06-us-costs-backfill §6).
  const received = data.fetchedAtKst ? `받은 시각 ${formatKstSeconds(data.fetchedAtKst)}` : "받은 시각 —";

  return (
    <Card
      title={`실제 계좌 요약 — ${scope.currencyLabel}`}
      subtitle={`${data.accountLabel ?? "토스증권"} · ${received}`}
      source={SOURCES.tossAccount}
      actions={actions}
    >
      <StatGrid cols={3}>
        <StatTile label="평가금액" value={summary?.marketValue ?? null} format={amount} unit={unit} note={marketValueNote(summary, market)} />
        <StatTile label="매입금액" value={summary?.purchaseAmount ?? null} format={amount} unit={unit} />
        <StatTile
          label="평가손익"
          value={summary?.profitLoss ?? null}
          format={signed}
          unit={unit}
          note={profitLossNote(summary, market)}
          valueClassName={tone(summary?.profitLoss)}
        />
        <StatTile
          label="일간 손익"
          value={summary?.dailyProfitLoss ?? null}
          format={signed}
          unit={unit}
          note={DAILY_PROFIT_NOTE}
          valueClassName={tone(summary?.dailyProfitLoss)}
        />
        <StatTile
          label={`매수 가능 금액(${scope.currencyLabel})`}
          value={data.buyingPower ?? null}
          format={amount}
          unit={unit}
          note={BUYING_POWER_NOTE}
        />
      </StatGrid>
      {data.unclassifiedCount > 0 && (
        <p className="mt-3 text-xs text-text-3">
          분류하지 못한 항목 {data.unclassifiedCount}개 — 시장·통화가 이 화면({scope.currencyLabel})과 맞지 않아 아래 표에서 뺐습니다(위 요약은 토스가
          통화별로 준 값 그대로).
        </p>
      )}
    </Card>
  );
}
