"use client";

import Link from "next/link";
import { useId, type JSX, type ReactNode } from "react";

import { SELECTED_BAR } from "@/components/ui/classes";
import { AlertTriangleIcon, ChevronDownIcon, ChevronUpIcon } from "@/components/ui/icons";
import { assetRowModel } from "@/lib/patternRows";
import { presentText } from "@/lib/patterns";

import { Avatar } from "./Avatar";
import { EstimateBadge, ProvenanceBadge, StaleBadge } from "./badges";
import { ChangeChip } from "./ChangeChip";
import { Empty } from "./Empty";
import { Sparkline } from "./Sparkline";

/** 자산 행 한 줄의 자료(설계서 §5). 값을 모르면 `value: null` — 0으로 채우지 않습니다. */
export type AssetRowData = {
  id: string;
  name: string;
  sub?: string | null;
  value: number | null;
  /** 서식된 값(예: 수집기 priceStr) — 있으면 `value` 서식보다 우선. "N/A"는 "—". */
  valueText?: string | null;
  unit?: string | null;
  change?: number | null;
  changePct?: number | null;
  /** 변화량 소수 자릿수(기본 2) — 설계서 §1.5 계약에 더한 선택 prop. 변화율은 늘 소수 둘째입니다(수집기 deltaStr과 같음). */
  changeDigits?: number;
  spark?: readonly (number | null)[];
  asOf?: string | null;
  delayMin?: number | null;
  live?: boolean;
  source?: string | null;
  /** 출처 배지의 툴팁(예: 닫힌 장의 시세 지연 — 배지 글에는 적지 않음). 설계서 §1.5 계약에 더한 선택 필드. */
  provenanceTitle?: string | null;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  warning?: string | null;
  href?: string;
  /**
   * 왼쪽 아바타의 짧은 글(모노그램, 명세 §4 — `lib/patternRows`의 `assetMonogram`·`lib/paperOverview`의 `bookMonogram`). 없으면 아바타 칸을
   * 그리지 않습니다. 장식이라 단추·링크 이름에 들어가지 않습니다.
   */
  avatarText?: string | null;
  /** 아바타 고리 색(예: 그 계좌의 차트 선 색) — 보조 표지일 뿐 뜻은 이름 글이 나릅니다. */
  avatarRing?: string | null;
  /**
   * 값의 기준 한 줄(예: 모의매매 계좌의 지금 값 단계 표기 '장중 추정 23:58 · 장중가 1/2종목 · 오늘 +0.42% · 10-29 잠정 대비') — 배지 줄 맨 앞에
   * 늘 보이고(말줄임 없음 — 보조 글 `sub`는 한 줄로 잘림), 펼침 단추에서는 배지 줄과 함께 설명(aria-describedby)으로 읽힙니다. 설계서 §1.5 계약에
   * 더한 선택 필드. 비었거나 "N/A"면 그리지 않습니다.
   */
  caption?: string | null;
};

/**
 * 행 버튼을 펼침 단추(디스클로저)로 쓸 때 — 누르면 행 밖의 상세 영역(`controls`)이 열리고 닫힙니다(예: 모의매매 개요의 계좌 상세).
 * 설계서 §1.5 계약에 더한 선택 prop입니다. 이때 버튼은 aria-pressed 대신 aria-expanded·aria-controls를 답니다(둘을 함께 달면 낭독기가
 * "눌림"과 "펼침"을 같이 읽음). `hint`(예: "상세 보기")는 이름 바로 뒤에 작게 붙어 버튼 이름의 일부가 됩니다 — 화살표(장식 아이콘)는 읽지 않습니다.
 *
 * 버튼 이름은 이름 + 안내 글뿐입니다(aria-labelledby). 보조 글·값·변화 칩·배지는 설명(aria-describedby)으로 잇습니다 — 행 전체가
 * 단추라 그대로 두면 낭독기가 행의 숫자·배지 전부를 단추 이름으로 읽어, 무엇을 여는 단추인지가 맨 끝에야 나옵니다. 행 전체가 단추이므로
 * 행의 숫자를 끌어 골라 복사할 수는 없습니다(그 값은 행 밖의 표 등 복사할 수 있는 곳에 함께 둡니다 — 모의매매는 계좌 비교 표).
 */
export type AssetRowDisclosure = {
  /** 버튼 id — 상세를 닫은 뒤 초점을 돌려줄 자리. */
  id?: string;
  /** 여닫는 영역의 id(aria-controls). */
  controls: string;
  expanded: boolean;
  hint?: string | null;
};

// 행 높이 64px 이상(명세 §4). 배지가 있으면 둘째 줄로 내려가 행이 늘어납니다.
const ROW = "relative flex min-h-16 w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left lg:px-5";
// 행은 카드 폭을 꽉 채우므로 포커스 링을 안쪽으로 그립니다(바깥으로 그리면 카드 테두리 밖으로 삐져나감).
// 누를 수 있는 행은 hover에 surface-2 바탕을 깝니다 — 그 위에서도 상승·하락·보조 글자가 4.5:1 이상입니다(토큰 대비, 명세 §2-1).
const INTERACTIVE =
  "hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus";
// 고른 행 — 중립 바탕 + 왼쪽 3px 잉크 막대(바탕 차이만으로는 대비가 모자라 막대를 둡니다). 데이터 영역이라 강조 파랑을 쓰지 않습니다(A1).
const SELECTED = "bg-surface-2";

/**
 * 자산 행 — (아바타) → 이름·보조 → (스파크라인) → 값(+단위) → 변화 칩 → 배지 줄(값의 기준 한 줄·추정·이전 값·경고·출처).
 *
 * - 값을 모르면 "—"(단위 없음, QA-049). 변화를 모르면 칩을 생략합니다(0.00%를 만들지 않음).
 * - 추정·대리·이전 값·경고는 있으면 반드시 보입니다(숨기는 옵션 없음). 출처 배지는 `showProvenance`일 때.
 * - `row.href`면 링크, 아니고 `onSelect`면 버튼(aria-pressed = selected, 고른 행은 왼쪽 막대), 둘 다 없으면 그냥 줄입니다.
 * - `disclosure`를 주면 `onSelect` 버튼이 펼침 단추가 됩니다(aria-expanded·aria-controls·id, 이름 뒤 안내 글, 단추 이름은 이름 + 안내 글만 —
 *   나머지는 설명) — 링크 행에는 쓰지 않습니다.
 */
export function AssetRow({
  row,
  onSelect,
  selected = false,
  showProvenance = false,
  disclosure,
}: {
  row: AssetRowData;
  onSelect?: (id: string) => void;
  selected?: boolean;
  showProvenance?: boolean;
  disclosure?: AssetRowDisclosure;
}): JSX.Element {
  const model = assetRowModel(row, showProvenance);
  const selectable = !row.href && onSelect !== undefined;
  const hint = selectable && disclosure ? presentText(disclosure.hint) : null;
  // 펼침 단추일 때만 쓰는 조각 id — 이름(이름 + 안내)은 aria-labelledby, 나머지는 aria-describedby.
  const uid = useId();
  const parts = selectable && disclosure ? { name: `${uid}-name`, sub: `${uid}-sub`, value: `${uid}-value`, badges: `${uid}-badges` } : null;
  const describedBy = parts
    ? [model.sub ? parts.sub : null, parts.value, model.hasBadges ? parts.badges : null].filter(Boolean).join(" ")
    : undefined;
  const body: ReactNode = (
    <>
      {selectable && selected ? (
        <span aria-hidden="true" className={SELECTED_BAR} />
      ) : null}
      {model.avatarText ? <Avatar text={model.avatarText} ring={row.avatarRing} /> : null}
      <span className="flex min-w-0 flex-1 basis-32 flex-col">
        <span id={parts?.name} className="truncate text-[15px] font-semibold leading-5 text-text">
          {row.name}
          {hint ? (
            <>
              {" "}
              <span className="ml-1 inline-flex items-center gap-0.5 align-baseline text-xs font-normal text-text-3">
                {hint}
                {disclosure?.expanded ? <ChevronUpIcon size={14} /> : <ChevronDownIcon size={14} />}
              </span>
            </>
          ) : null}
        </span>
        {model.sub ? (
          <span id={parts?.sub} className="truncate text-xs leading-4 text-text-3">
            {model.sub}
          </span>
        ) : null}
      </span>
      {model.showSpark && row.spark ? (
        // 좁은 화면에서는 값·변화를 먼저 보이려고 스파크라인을 접습니다.
        <span className="hidden shrink-0 sm:block">
          <Sparkline values={row.spark} width={64} height={24} />
        </span>
      ) : null}
      {/* 값·칩은 늘 오른쪽 한 덩어리 — 좁은 화면에서 아바타·이름과 한 줄에 들지 않아 다음 줄로 내려가도 왼쪽이 아니라 오른쪽 끝에 둡니다(ml-auto). */}
      <span id={parts?.value} className="ml-auto flex shrink-0 flex-col items-end">
        {model.valueText === null ? (
          <span className="text-[15px] font-semibold leading-5 text-text-3">
            <Empty />
          </span>
        ) : (
          <span className="text-[15px] font-semibold leading-5 tabular-nums text-text">
            {model.valueText}
            {row.unit ? <span className="ml-0.5 text-xs font-normal text-text-3">{row.unit}</span> : null}
          </span>
        )}
        <ChangeChip change={row.change} changePct={row.changePct} digits={row.changeDigits ?? 2} pctDigits={2} size="sm" />
      </span>
      {model.hasBadges ? (
        // 배지 줄은 아바타가 있으면 이름과 같은 세로줄에서 시작합니다(아바타 36·40px + 간격 12px).
        <span id={parts?.badges} className={`flex basis-full flex-wrap items-center gap-1 ${model.avatarText ? "pl-12 sm:pl-[52px]" : ""}`}>
          {/* 값의 기준 한 줄은 배지보다 앞 — '추정' 배지 바로 뒤에 '장중 추정 …'이 오면 눈에도 낭독에도 '추정 장중 추정'으로 겹칩니다. */}
          {model.caption ? <span className="text-xs leading-4 tabular-nums text-text-2">{model.caption}</span> : null}
          <EstimateBadge estimated={row.isEstimated} proxy={row.isProxy} />
          <StaleBadge stale={row.isStale} reason={row.staleReason} />
          {model.warning ? (
            <span className="inline-flex items-center gap-1 text-xs leading-4 text-warn">
              <AlertTriangleIcon size={12} />
              <span className="sr-only">주의: </span>
              {model.warning}
            </span>
          ) : null}
          {showProvenance ? (
            <ProvenanceBadge source={row.source} asOf={row.asOf} delayMin={row.delayMin} live={row.live} title={row.provenanceTitle} />
          ) : null}
        </span>
      ) : null}
    </>
  );

  if (row.href) {
    return (
      <Link href={row.href} className={`${ROW} ${INTERACTIVE}`}>
        {body}
      </Link>
    );
  }
  if (onSelect && disclosure) {
    return (
      <button
        type="button"
        id={disclosure.id}
        aria-labelledby={parts?.name}
        aria-describedby={describedBy}
        aria-expanded={disclosure.expanded}
        aria-controls={disclosure.controls}
        onClick={() => onSelect(row.id)}
        className={`${ROW} ${INTERACTIVE} ${selected ? SELECTED : ""}`}
      >
        {body}
      </button>
    );
  }
  if (onSelect) {
    return (
      <button type="button" aria-pressed={selected} onClick={() => onSelect(row.id)} className={`${ROW} ${INTERACTIVE} ${selected ? SELECTED : ""}`}>
        {body}
      </button>
    );
  }
  return <div className={ROW}>{body}</div>;
}

/**
 * 자산 행 목록 — 카드(1px 경계, 16px 모서리) 안에 제목(h2, 있으면 영역 이름)과 행들. 행 사이는 1px 윗선으로 나눕니다.
 *
 * - 행이 없으면 `emptyText`(기본 "표시할 항목이 없습니다.").
 * - `onSelect`·`selectedId`는 각 행에 넘깁니다(href가 있는 행은 링크가 이김).
 * - `showProvenance`는 설계서 §1.5 계약에 더한 선택 prop입니다 — 모든 행에 출처 배지를 붙입니다.
 * - `headingLevel`(기본 2, 계약에 더한 선택 prop)이 3이면 제목을 h3으로 그리고 영역(region)으로 만들지 않습니다 — 이미 이름 붙은
 *   구역 안의 소제목이라(예: 홈 "시장" 안의 범주) 랜드마크를 겹쳐 늘리지 않습니다. 제목 탐색은 그대로 됩니다.
 * - `children`은 행 아래에 그립니다(더 보기 링크·주석 등).
 */
export function AssetList({
  title,
  rows,
  emptyText = "표시할 항목이 없습니다.",
  onSelect,
  selectedId,
  showProvenance = false,
  headingLevel = 2,
  children,
}: {
  title?: string;
  rows: readonly AssetRowData[];
  emptyText?: string;
  onSelect?: (id: string) => void;
  selectedId?: string | null;
  showProvenance?: boolean;
  headingLevel?: 2 | 3;
  children?: ReactNode;
}): JSX.Element {
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const labelled = Boolean(title) && headingLevel === 2;
  return (
    <section aria-labelledby={labelled ? headingId : undefined} className="min-w-0 overflow-hidden rounded-card border border-border bg-surface">
      {title ? (
        // 제목 글은 행 글과 같은 세로줄(px-4 · lg:px-5)에 둡니다.
        <Heading id={headingId} className="px-4 pb-2 pt-5 text-title-3 text-text lg:px-5">
          {title}
        </Heading>
      ) : null}
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-text-3 lg:px-5">{emptyText}</p>
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id} className="border-t border-border first:border-t-0">
              <AssetRow
                row={row}
                onSelect={onSelect}
                selected={selectedId === row.id}
                showProvenance={showProvenance}
              />
            </li>
          ))}
        </ul>
      )}
      {children}
    </section>
  );
}
