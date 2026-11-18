"use client";

import Link from "next/link";
import {
  ChangeCell,
  type Column,
  DataTable,
  type InspectorContext,
  InspectorFrame,
  InspectorTrigger,
  PropertyList,
} from "@/components/patterns";
import { HoldingQuickLink } from "@/components/screens/detail/HoldingQuickLink";
import { LINK_CLASSES, Panel, Tag } from "@/components/ui";
import {
  ChevronDownIcon,
  ChevronUpIcon,
  CircleDashedIcon,
  MinusIcon,
  PanelRightIcon,
  PlusIcon,
  XCircleIcon,
} from "@/components/ui/icons";
import { useSessionUser } from "@/hooks/useSessionUser";
import { latestHoldingCount } from "@/lib/detailEntity";
import { EMPTY, formatCurrency, formatNumber, formatWeightPercent } from "@/lib/format";
import { holdingActionView, type HoldingActionKind } from "@/lib/holdings";
import { holdingInspectorItems, holdingRowKeys, holdingRowLabels, type KrwConversion } from "@/lib/institutionsScreen";
import { infoSearchEntry } from "@/lib/search";
import { SOURCES } from "@/lib/sources";
import type { Holding, PortfolioResponse } from "@/lib/types";

/**
 * 검사 칸이 표 옆에 놓였는가 — 틀이 줄 단추에 펼치는 속성으로 압니다(옆 칸이면 aria-controls, 대화상자면 aria-haspopup). 틀이 배치를 따로 알려 주지
 * 않아(InspectorContext에 없음) 같은 판단을 다시 하지 않고 틀의 결정을 그대로 읽습니다.
 */
function sideBySide(inspector: InspectorContext): boolean {
  return inspector.triggerProps("")["aria-controls"] !== undefined;
}

/**
 * 13F 포트폴리오 화면의 '보유 종목 상세' 패널 — 최신 분기 보유 줄(응답 holdings — 백엔드가 비중 상위 topN줄로 자름)의 표와 고른 줄의 검사 칸
 * (작업대 실행 명세 §7 4행 '보유 표, 검사 칸'). 원화 병기는 화면이 받은 공용 환율(useUsdKrw)의 환산·문구를 그대로 씁니다.
 *
 * - 검사 칸 틀은 `lg` 배치(틀 52rem부터 옆 18rem — 메뉴 220에서 창 약 1374px 이상, 그 아래·좁은 화면은 위쪽 대화상자). 넓은 화면 처음은 첫 줄을 보입니다.
 * - 줄의 검사 칸은 맨 앞 좁은 칸의 아이콘 단추가 엽니다 — 종목 이름은 시세·후보 창 단추(2026-11-18 사용자 요청)라 검사 단추로 쓰지 않습니다(P5b 결정 1-가).
 *   보유 주식수는 표에서 검사 칸('주식 수'·'주식 수 변화')으로 옮겼습니다(옆 칸 배치의 표 약 598px에 맞춤).
 * - 검사 칸 = 기관 상세 보유 종목 검사 칸과 같은 속성 + '원화 환산' 줄, 그리고 같은 '정보 검색에서 찾기' 링크(정보 검색을 볼 수 있는 사용자만). 고를 때 읽는
 *   것이 없습니다(요청 +0).
 * - 표는 옆 칸 배치가 아니면 최소 640px + 넘칠 때 넘김 안내(`scrollHint="overflow"`), 옆 칸 배치면 최소 폭 없이 칸 폭에 맞춥니다(매크로 지표 표와 같은 꼴).
 */
export function HoldingsPanel({ data, krw }: { data: PortfolioResponse; krw: KrwConversion }) {
  const user = useSessionUser();
  // 보유 표 줄 — 키는 'CUSIP:클래스'(겹치면 '#n' 꼬리), 이름표는 공시 이름(겹치는 줄에만 클래스·CUSIP — QA-587 규칙).
  const holdings = data.holdings ?? [];
  const holdingKeys = holdingRowKeys(holdings);
  const holdingRows: HoldingRow[] = holdings.map((holding, index) => ({ key: holdingKeys[index], holding }));
  const byKey = new Map(holdingRows.map((row) => [row.key, row]));
  const labels = holdingRowLabels(holdings);
  // 개수 줄의 전체 수는 최신 분기 보유 종목 수 — 응답은 이미 상위 topN줄로 잘려 있어 응답 길이로는 알 수 없습니다(기관 상세와 같은 글 — QA-585).
  const heldTotal = latestHoldingCount(data.quarters);
  const countText = (shown: number) =>
    heldTotal !== null && heldTotal > shown
      ? `${formatNumber(heldTotal, 0)}종목 가운데 비중 상위 ${formatNumber(shown, 0)}종목`
      : `${formatNumber(shown, 0)}종목`;
  return (
    <Panel
      title={`보유 종목 상세 (기준일 ${data.latest?.reportDate ?? EMPTY})`} source={`${SOURCES.sec13f} · 원화 환산은 원/달러 최신값(Yahoo Finance)`}
      subtitle={`직전 분기 대비 액션은 비중 변화 ±0.05%p를 기준으로 분류합니다. ${krw.note}`}
    >
      <InspectorFrame
        label="보유 종목 자세히"
        layout="lg"
        titleOf={(key) => labels.get(key) ?? null}
        renderDetail={(key) => {
          const row = byKey.get(key);
          if (!row) return null;
          const search = infoSearchEntry(row.holding.name, user);
          return (
            <div className="flex min-w-0 flex-col gap-2">
              <PropertyList items={holdingInspectorItems(row.holding, krw)} dense />
              {/* 링크는 자기 줄에서 글 폭만(self-start) — 기관 상세 보유 종목 검사 칸과 같은 링크(QA-582). */}
              {search ? (
                <Link href={search.href} className={`${LINK_CLASSES} self-start text-sm`}>
                  정보 검색에서 찾기
                </Link>
              ) : null}
            </div>
          );
        }}
        defaultKey={holdingRows[0]?.key ?? null}
      >
        {(inspector) => (
          <DataTable
            columns={holdingColumns(inspector, labels, krw.toKrw)}
            rows={holdingRows}
            rowKey={(row) => row.key}
            caption="보유 종목 상세"
            count={countText}
            scrollHint={sideBySide(inspector) ? false : "overflow"}
            selectedKey={inspector.shownKey}
          />
        )}
      </InspectorFrame>
    </Panel>
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
 * 보유 표 열 — 검사(아이콘 줄 단추 — 이름 '{줄 이름표} 13F 줄 자세히') · 종목(행 머리 — 이름 단추가 시세·후보 창을 엶, 'CUSIP … · 클래스' 보조 줄) · 비중 ·
 * 비중 변화(공용 표 칸 변화 — QA-696) · 평가액(달러 + 원화 보조 줄 — 환율을 모르면 생략) · 직전 분기 대비(중립 태그, 줄바꿈 없음 — QA-697).
 */
function holdingColumns(
  inspector: InspectorContext,
  labels: ReadonlyMap<string, string>,
  toKrw: (usd: number | null | undefined) => string | null,
): Column<HoldingRow>[] {
  return [
    {
      key: "inspect",
      // 머리 글은 낭독기에만 — 눈에는 빈 좁은 칸.
      header: <span className="sr-only">자세히</span>,
      cell: (row) => (
        <InspectorTrigger inspector={inspector} itemKey={row.key} className="justify-center">
          <PanelRightIcon size={16} />
          <span className="sr-only">{labels.get(row.key) ?? row.holding.name} 13F 줄 자세히</span>
        </InspectorTrigger>
      ),
    },
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
    {
      key: "action",
      header: "직전 분기 대비",
      // 태그가 칸 안에서 두 줄로 접히지 않게(QA-697).
      className: "whitespace-nowrap",
      cell: ({ holding }) => <HoldingActionTag label={holding.action} />,
    },
  ];
}
