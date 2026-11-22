"use client";

import Link from "@/components/ui/IntentLink";
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
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
import { holdingActionView, type HoldingActionKind, type KrwConversion } from "@/lib/holdings";
import { holdingInspectorItems, holdingRowKeys, holdingRowLabels } from "@/lib/institutionsScreen";
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
 * 옆 칸 배치의 표 칸 좌우 여백 — 공용 표 칸(th·td)의 12px(px-3)을 8px로. 자손 선택자(클래스 + 요소)라 공용 표의 클래스 차례와 상관없이 이깁니다.
 * 표의 최소 폭(칸마다 줄바꿈 없는 가장 긴 조각 + 여백)이 여백 12px로 약 622px(자기 빌드 1440 — 동작 태그 '비중 축소 (Reduced)' 141px·평가액·비중 변화
 * 칩은 줄바꿈 없음)라, 검사 칸 옆 표 598px(1440·메뉴 220)를 넘어 오른쪽이 잘렸습니다. Tailwind가 글로 찾으므로 통째로 적습니다.
 */
const SIDE_COMPACT = "[&_td]:px-2 [&_th]:px-2";

/**
 * 좁은 배치(칸 여백 8px·최소 폭 없음·긴 이름 꺾기)가 넘치지 않고 들어가는 패널 안 폭(px) — 검사 칸 옆 표처럼 약 574px까지 줄어듭니다(위 SIDE_COMPACT).
 * `fit`을 준 패널(기관 상세)은 상자 폭이 이 이상이면 그 배치를 씁니다(QA-984 — 1440의 가운데 칸 584px에서 최소 640px 표가 56px 넘침).
 */
const FIT_MIN_WIDTH = 560;

/**
 * 쌓은 배치가 들어가는 패널 안 폭(px) — '직전 분기 대비' 태그를 종목 칸(이름·CUSIP 아래)으로, '비중 변화'를 비중 칸 아래로 쌓아 칸 넷(자세히 약 40 ·
 * 비중 약 83 · 평가액 약 92px + 종목)으로 줄입니다. 종목 칸에 가장 긴 동작 태그('비중 축소 (Reduced)' 약 141px)가 들어가는 하한입니다(QA-987 —
 * 1024·1280·1366의 기관 상세 가운데 칸 472·424·510px). 이보다 좁으면(폰) 지금처럼 최소 640px와 넘김 안내.
 */
const STACK_MIN_WIDTH = 400;

/**
 * 폰 배치가 들어가는 패널 안 폭(px) — 칸 셋(자세히 약 60 · 비중·평가액 약 92px + 종목)으로, 동작 태그는 한국어만(가장 긴 '비중 축소' 약 75px)
 * 종목 칸에 둡니다(QA-988 — 360·390·430 폰의 가운데 칸 292·322·362px). 이보다 좁으면 지금처럼 최소 640px와 넘김 안내.
 */
const PHONE_MIN_WIDTH = 240;

/**
 * 보유 표 배치 — wide(칸 여섯·최소 640px·넘김 안내), compact(칸 여섯·여백 8px·최소 폭 없음), stacked(칸 넷 — 동작 태그는 종목 칸, 비중 변화는 비중 칸),
 * phone(칸 셋 — 짧은 동작 태그는 종목 칸, 비중·변화·평가액·원화는 오른쪽 한 칸).
 */
type HoldingsLayout = "wide" | "compact" | "stacked" | "phone";

/** 상자 안 폭(px) — ResizeObserver가 없거나 재기 전이면 null(그때는 지금 배치 그대로). */
function useBoxWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const box = ref.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]?.contentRect.width;
      if (typeof next === "number" && next > 0) setWidth((previous) => (previous !== null && Math.abs(previous - next) < 0.5 ? previous : next));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * 13F 포트폴리오 화면·기관 상세 '보유 종목' 탭의 '보유 종목 상세' 패널 — 최신 분기 보유 줄(응답 holdings — 백엔드가 비중 상위 topN줄로 자름)의 표와 고른 줄의 검사 칸
 * (작업대 실행 명세 §7 4행 '보유 표, 검사 칸'). 원화 병기는 화면이 받은 공용 환율(useUsdKrw)의 환산·문구를 그대로 씁니다.
 *
 * - 검사 칸 틀은 `lg` 배치(틀 52rem부터 옆 18rem — 메뉴 220에서 창 약 1374px 이상, 그 아래·좁은 화면은 위쪽 대화상자). 넓은 화면 처음은 첫 줄을 보입니다.
 * - 줄의 검사 칸은 맨 앞 좁은 칸의 아이콘 단추가 엽니다 — 종목 이름은 시세·후보 창 단추(2026-11-18 사용자 요청)라 검사 단추로 쓰지 않습니다(P5b 결정 1-가).
 *   보유 주식수는 표에서 검사 칸('주식 수'·'주식 수 변화')으로 옮겼습니다(옆 칸 배치의 표 약 598px에 맞춤).
 * - 검사 칸 = 기관 상세 보유 종목 검사 칸과 같은 속성 + '원화 환산' 줄, 그리고 같은 '정보 검색에서 찾기' 링크(정보 검색을 볼 수 있는 사용자만). 고를 때 읽는
 *   것이 없습니다(요청 +0).
 * - 표는 옆 칸 배치가 아니면 최소 640px + 넘칠 때 넘김 안내(`scrollHint="overflow"`), 옆 칸 배치면 최소 폭 없이 칸 폭에 맞춥니다(매크로 지표 표와 같은 꼴).
 */
export function PortfolioHoldingsPanel({
  data,
  krw,
  actions,
  fit = false,
}: {
  data: PortfolioResponse;
  krw: KrwConversion;
  /** 패널 머리 동작(기관 상세의 '13F 포트폴리오에서 자세히' 링크 — 13F 화면은 없음). */
  actions?: ReactNode;
  /**
   * 패널 폭이 좁은 배치가 들어가는 폭({@link FIT_MIN_WIDTH} 이상)이면 검사 칸이 대화상자여도 검사 칸 옆 표와 같은 좁은 배치(최소 폭 없음)를 씁니다 —
   * 기관 상세(가운데 칸이 13F 화면 본문보다 좁음, QA-984). 13F 화면은 주지 않아 지금 그대로입니다.
   */
  fit?: boolean;
}) {
  const user = useSessionUser();
  const boxRef = useRef<HTMLDivElement>(null);
  const boxWidth = useBoxWidth(boxRef);
  // fit 패널(기관 상세)의 배치 — 넓으면 좁은 배치, 400px 이상이면 쌓은 배치(QA-987), 240px 이상이면 폰 배치(QA-988), 잴 수 없거나 더 좁으면 지금 그대로.
  const fitLayout: HoldingsLayout | null =
    !fit || boxWidth === null
      ? null
      : boxWidth >= FIT_MIN_WIDTH
        ? "compact"
        : boxWidth >= STACK_MIN_WIDTH
          ? "stacked"
          : boxWidth >= PHONE_MIN_WIDTH
            ? "phone"
            : null;
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
      actions={actions}
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
        {(inspector) => {
          // 옆 칸 배치(또는 fit 패널이 넓을 때)에서는 칸 좌우 여백을 12 → 8px로 줄이고 최소 폭 없이 칸 폭에 맞춥니다(SIDE_COMPACT) — 표가 검사 칸 옆 약
          // 532~598px(메뉴 220에서 창 1374~1440)·기관 상세 가운데 칸(1440에서 584px — QA-984)에 들어가게.
          const layout: HoldingsLayout = sideBySide(inspector) ? "compact" : (fitLayout ?? "wide");
          const narrow = layout !== "wide";
          return (
            <div ref={boxRef} className={narrow ? SIDE_COMPACT : undefined}>
              <DataTable
                columns={holdingColumns(inspector, labels, krw.toKrw, layout)}
                rows={holdingRows}
                rowKey={(row) => row.key}
                caption="보유 종목 상세"
                count={countText}
                scrollHint={narrow ? false : "overflow"}
                selectedKey={inspector.shownKey}
              />
            </div>
          );
        }}
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
function HoldingActionTag({ label, short = false }: { label: string | null | undefined; short?: boolean }) {
  const view = holdingActionView(label);
  const Icon = HOLDING_ACTION_ICON[view.kind];
  // 폰 배치(QA-988)는 끝의 영문 괄호('(Reduced)')를 떼어 종목 칸에 들어가게 — 뜻은 한국어가 나릅니다.
  const text = short ? view.text.replace(/\s*\([A-Za-z][^)]*\)\s*$/, "") || view.text : view.text;
  return <Tag icon={<Icon size={12} className="text-text-3" />}>{text}</Tag>;
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
  layout: HoldingsLayout,
): Column<HoldingRow>[] {
  const side = layout !== "wide";
  const phone = layout === "phone";
  const stacked = layout === "stacked" || phone;
  const columns: Column<HoldingRow>[] = [
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
      // 옆 칸 배치에서는 공백 없는 긴 낱말(회사 이름)도 비상으로 꺾습니다(wrap-anywhere) — 문턱 가까운 폭(표 532px 안팎)에서 표가 넘치지 않게.
      // 1440(표 598px)에서도 QA 자료 12기관 보유 줄 가운데 'STMICROELECTRONICS' 한 낱말은 이름 칸 안에서 꺾입니다(1374에서는 80낱말, 표 넘침은 0px — 693f9b35 본문).
      cell: ({ holding }) => (
        <span className={`flex flex-col items-start${side ? " wrap-anywhere" : ""}`}>
          {/* 이름을 누르면 그 종목의 주가·정보 팝업 창(사용자 요청 2026-11-18 — 티커 없는 줄은 공시 이름으로 찾은 후보를 고름) */}
          <HoldingQuickLink holding={holding} />
          <span className="text-xs text-text-3">
            CUSIP {holding.cusip} · {holding.class}
          </span>
          {/* 쌓은 배치(QA-987)에서는 '직전 분기 대비' 칸 대신 이름 아래 — 태그가 두 줄로 접히지 않게(QA-697). */}
          {stacked ? (
            <span className="mt-1 whitespace-nowrap">
              <HoldingActionTag label={holding.action} short={phone} />
            </span>
          ) : null}
        </span>
      ),
    },
    stacked
      ? {
          key: "weight",
          // 쌓은 배치(QA-987) — 비중 아래 비중 변화(공용 변화 칸 — 방향 기호·부호·낭독 '상승/하락' 그대로).
          header: "비중(변화)",
          align: "right",
          cell: ({ holding }) => (
            <span className="flex flex-col items-end">
              <span>{formatWeightPercent(holding.weight)}</span>
              <span className="text-xs">
                <ChangeCell change={holding.weightDiff} digits={2} unit="%p" />
              </span>
            </span>
          ),
        }
      : { key: "weight", header: "비중", align: "right", cell: ({ holding }) => formatWeightPercent(holding.weight) },
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
      // 평가액을 모르면 null — 공용 표가 모르는 칸의 '—'(보조 글자색·낭독 '값 없음')를 그립니다. 요소로 감싸 '—'를 그리면 그 처리를 거치지 않고 본문 잉크의
      // 기호만 남았습니다(교집합·스타일 표의 금액 칸과 같은 꼴).
      cell: ({ holding }) => {
        const usd = formatCurrency(holding.value);
        if (usd === EMPTY) return null;
        const krw = toKrw(holding.value);
        return (
          <span className="flex flex-col items-end">
            <span>{usd}</span>
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
  if (phone) {
    // 폰 배치(QA-988) — 칸 셋: 오른쪽 한 칸에 비중·변화(공용 변화 칸)·평가액·원화를 쌓습니다(모르는 값은 '—').
    return [
      columns[0],
      columns[1],
      {
        key: "weightValue",
        header: "비중·평가액",
        align: "right",
        cell: ({ holding }) => {
          const usd = formatCurrency(holding.value);
          const krw = usd === EMPTY ? null : toKrw(holding.value);
          return (
            <span className="flex flex-col items-end">
              <span>{formatWeightPercent(holding.weight)}</span>
              <span className="text-xs">
                <ChangeCell change={holding.weightDiff} digits={2} unit="%p" />
              </span>
              <span className="mt-1">{usd}</span>
              {krw && <span className="text-xs text-text-3">{krw}</span>}
            </span>
          );
        },
      },
    ];
  }
  // 쌓은 배치는 비중 변화·직전 분기 대비를 다른 칸 안에 두어 칸 넷(QA-987).
  return stacked ? columns.filter((column) => column.key !== "weightDiff" && column.key !== "action") : columns;
}
