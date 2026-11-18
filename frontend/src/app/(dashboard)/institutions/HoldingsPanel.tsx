"use client";

import { ChangeCell, type Column, DataTable } from "@/components/patterns";
import { HoldingQuickLink } from "@/components/screens/detail/HoldingQuickLink";
import { Card, Tag } from "@/components/ui";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  MinusIcon,
  PlusIcon,
  XCircleIcon,
} from "@/components/ui/icons";
import { EMPTY, formatCurrency, formatNumber, formatWeightPercent } from "@/lib/format";
import { holdingActionView, type HoldingActionKind } from "@/lib/holdings";
import { holdingRowKeys, type KrwConversion } from "@/lib/institutionsScreen";
import { SOURCES } from "@/lib/sources";
import type { Holding, PortfolioResponse } from "@/lib/types";

/**
 * 13F 포트폴리오 화면의 '보유 종목 상세' 패널 — 최신 분기 보유 줄(응답 holdings — 백엔드가 비중 상위 topN줄로 자름)의 표. 원화 병기는 화면이 받은
 * 공용 환율(useUsdKrw)의 환산·문구를 그대로 씁니다.
 */
export function HoldingsPanel({ data, krw }: { data: PortfolioResponse; krw: KrwConversion }) {
  // 보유 표 줄 — 키는 'CUSIP:클래스'(겹치면 '#n' 꼬리).
  const holdings = data.holdings ?? [];
  const holdingKeys = holdingRowKeys(holdings);
  const holdingRows: HoldingRow[] = holdings.map((holding, index) => ({ key: holdingKeys[index], holding }));
  return (
    <Card
      title={`보유 종목 상세 (기준일 ${data.latest?.reportDate ?? EMPTY})`} source={`${SOURCES.sec13f} · 원화 환산은 원/달러 최신값(Yahoo Finance)`}
      subtitle={`직전 분기 대비 액션은 비중 변화 ±0.05%p를 기준으로 분류합니다. ${krw.note}`}
    >
      <DataTable
        columns={holdingColumns(krw.toKrw)}
        rows={holdingRows}
        rowKey={(row) => row.key}
        caption="보유 종목 상세"
        scrollHint
      />
    </Card>
  );
}

const HOLDING_ACTION_ICON: Record<HoldingActionKind, typeof PlusIcon> = {
  new: PlusIcon,
  closed: XCircleIcon,
  added: ChevronUpIcon,
  reduced: ChevronDownIcon,
  unchanged: MinusIcon,
  none: CircleDashedIcon,
};

/**
 * 직전 분기 대비 변화 태그 — 글(신규 매수·비중 확대 …)이 뜻을 나르고, 앞의 아이콘은 장식입니다. 색은 중립 —
 * 상승·하락 색(up·down)은 값이 오르내린 방향 전용이라 매수·매도 판정에 쓰지 않습니다(명세 §7-3).
 * 테두리 있는 공용 Tag(중립)입니다 — 테두리 없는 배지(SourceBadge)는 바탕이 표의 고른 행·hover 바탕(surface-2)과 같아 그 행에서 상자가 사라졌습니다(QA-697).
 */
function HoldingActionTag({ label }: { label: string | null | undefined }) {
  const view = holdingActionView(label);
  const Icon = HOLDING_ACTION_ICON[view.kind];
  return <Tag icon={<Icon size={12} className="text-text-3" />}>{view.text}</Tag>;
}

/** 보유 표 줄 — 줄 키('CUSIP:클래스', 겹치면 '#n' — lib/institutionsScreen holdingRowKeys)와 보유 줄. */
type HoldingRow = { key: string; holding: Holding };

/**
 * 보유 표 열 — 종목(행 머리 — 이름 단추가 시세·후보 창을 엶, 'CUSIP … · 클래스' 보조 줄) · 비중 · 비중 변화(공용 표 칸 변화 — QA-696) · 평가액(달러 +
 * 원화 보조 줄 — 환율을 모르면 생략) · 보유 주식수 · 직전 분기 대비(중립 태그, 줄바꿈 없음 — QA-697).
 */
function holdingColumns(toKrw: (usd: number | null | undefined) => string | null): Column<HoldingRow>[] {
  return [
    {
      key: "name",
      header: "종목",
      rowHeader: true,
      cell: ({ holding }) => (
        <span className="flex flex-col items-start">
          {/* 이름을 누르면 그 종목의 주가·정보 팝업 창(사용자 요청 2026-11-18 — 티커 없는 줄은 공시 이름으로 찾은 후보를 고름) */}
          <HoldingQuickLink holding={holding} />
          <span className="text-xs text-text-3">
            CUSIP {holding.cusip} · {holding.class}
          </span>
        </span>
      ),
    },
    { key: "weight", header: "비중", align: "right", cell: ({ holding }) => formatWeightPercent(holding.weight) },
    {
      key: "weightDiff",
      header: "비중 변화",
      align: "right",
      // 공용 표 칸 변화(ChangeCell) — ▲▼·부호(−는 U+2212)·sr '상승/하락'과 등락색, 모르면 '—'(QA-696: 예전에는 색과 ASCII '-'만으로 방향을 나름).
      cell: ({ holding }) => <ChangeCell change={holding.weightDiff} digits={2} unit="%p" />,
    },
    {
      key: "value",
      header: "평가액",
      align: "right",
      // 총액만 원화로 적으면, 종목 하나가 얼마짜리인지는 여전히 머리로 곱해야 합니다. 같은 환율로 여기도 함께 적습니다.
      cell: ({ holding }) => {
        const krw = toKrw(holding.value);
        return (
          <span className="flex flex-col items-end">
            <span>{formatCurrency(holding.value)}</span>
            {krw && <span className="text-xs text-text-3">{krw}</span>}
          </span>
        );
      },
    },
    { key: "shares", header: "보유 주식수", align: "right", cell: ({ holding }) => formatNumber(holding.shares, 0) },
    {
      key: "action",
      header: "직전 분기 대비",
      // 태그가 칸 안에서 두 줄로 접히지 않게(QA-697).
      className: "whitespace-nowrap",
      cell: ({ holding }) => <HoldingActionTag label={holding.action} />,
    },
  ];
}
