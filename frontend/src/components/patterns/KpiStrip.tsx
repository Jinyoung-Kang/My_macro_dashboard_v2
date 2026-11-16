import Link from "next/link";
import type { CSSProperties, JSX, ReactNode } from "react";

import { FOCUS_RING } from "@/components/ui/classes";
import { StatusText } from "@/components/ui/icons";
import { isMissingValue, presentText, statValueText } from "@/lib/patterns";

import { EstimateBadge, ProvenanceBadge, StaleBadge } from "./badges";
import { ChangeChip } from "./ChangeChip";
import { Empty } from "./Empty";
import { Skeleton } from "./Skeleton";

/** KPI 띠의 타일 하나. 값을 모르면 `value: null` — 0으로 채우지 않습니다. */
export type KpiItem = {
  key: string;
  /** 타일 이름 — 13px 보조 글, 타일 묶음(role=group)의 이름. */
  label: string;
  /** null·빈 글·"N/A"·NaN이면 "—"(Empty + emptyReason), 0은 값입니다. */
  value: string | number | null;
  /** 숫자 값 서식(없으면 소수 둘째 자리 — lib/patterns statValueText). */
  format?: (value: number) => string;
  /** 단위 — 값이 있을 때만(QA-049). */
  unit?: string | null;
  /** label: 판정 라벨(국면 등 — 숫자가 아님): tabular 없이 16px(lg 20px), 줄바꿈 허용. 기본 number. */
  valueKind?: "number" | "label";
  /** 판정 불가 같은 중립 값 — 중립 잉크(text-neutral). 뜻은 글이 나릅니다. */
  neutral?: boolean;
  /** 변화 — 변화 칩(▲▼·부호·sr '상승/하락')과 12px 캡션('전일 대비'). 변화량·변화율을 둘 다 모르면 줄이 없습니다. */
  change?: { change?: number | null; changePct?: number | null; digits?: number; pctDigits?: number; caption?: string | null };
  /** 상태 글 — 아이콘 + 글(공용 StatusText, 색만이 아님). */
  status?: { tone: "ok" | "warn" | "danger"; text: string };
  /** 12px 보조 글(기준일 등 — 값의 시각은 출처 줄의 `asOf`로). */
  note?: string | null;
  /**
   * 출처 줄(공용 출처 배지 — '출처 · 지연 · 시각', 원칙 '모든 숫자에 출처'): 이 넷 가운데 하나라도 주면 타일 아래에 늘 보입니다(숨기는 옵션 없음).
   * 비공식 참고 시세는 출처 글에 그 사실을 담아 넘깁니다(예 'TradingView Scanner · 참고 시세'). 지연은 장이 열려 있을 때의 시세 지연(분, 0이면 '실시간'),
   * `provenanceTitle`은 배지 툴팁(닫힌 장이라 적지 않은 지연 등). 앱 안에서 센 수(알림·오류 건수)처럼 바깥 출처가 없는 타일은 주지 않습니다.
   */
  source?: string | null;
  asOf?: string | null;
  delayMin?: number | null;
  provenanceTitle?: string | null;
  emptyReason?: string | null;
  /**
   * 읽는 중 — 값 자리에 Skeleton 한 줄(role=status '{label} 불러오는 중'). 이름 칸은 읽는 동안 읽어 주기에서 뺍니다(status 이름이 이름을 담음 —
   * 링크 타일의 이름이 '이름 + 이름 불러오는 중'으로 겹치지 않게, QA-597).
   */
  pending?: boolean;
  /**
   * 읽는 중 자리 줄 수(기본 0) — 값 자리표시 아래 같은 블록에 글 없는 막대(읽어 주기에서 뺌)를 이만큼 더 그려, 값이 온 뒤의 변화·배지·출처 줄 자리를
   * 미리 잡습니다(값이 와도 띠 높이가 크게 뛰지 않게 — QA-598). 한 줄의 칸은 가장 높은 타일까지 늘어나므로 가장 긴 타일에만 주면 됩니다.
   */
  pendingLines?: number;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  /** 주면 타일 전체가 그 대상 화면 링크. */
  href?: string;
};

/**
 * 타일 한 칸 — 4px·1px 경계·surface, 안쪽 12px(위아래 10px) — StatTile과 같은 조밀한 칸(명세 §3-7). 끊을 곳 없는 긴 값·출처(공백 없는 URL 꼬리 등)는
 * 타일 안에서 꺾습니다(wrap-anywhere — 상속되어 값·상태·출처·보조 글 모두에 걸림, 말줄임 없음, PropertyList와 같은 규칙).
 */
const TILE = "block h-full min-w-0 rounded-control border border-border bg-surface px-3 py-2.5 wrap-anywhere";
/**
 * 링크 타일 — 중립 잉크(강조 파랑 아님, A1), 마우스를 올리면 바탕 surface-2 + 이름 밑줄, 포커스 링. 높이는 내용(이름 18 + 값 28 + 위아래 20 = 66px 이상)이
 * 정하지만, 누르는 자리 44px(lg 미만)를 클래스로도 적어 둡니다 — 클래스로 읽는 누름 자리 감사(lib/__tests__/touchTargetAudit)가 이 타일도 보게(겉모양 그대로).
 */
const LINK_TILE = `group min-h-11 text-text hover:bg-surface-2 motion-safe:transition-colors ${FOCUS_RING}`;

/**
 * 읽는 중 자리 줄의 막대 — 공용 Skeleton 막대와 같은 모양(놓인 면보다 한 단계 위 면·motion-safe 깜빡임·고대비 1px 테두리). 막대 14px + 사이 14px로
 * 다섯 줄이면 136px(+ 이름·값 자리표시·여백 64px = 200px) — 홈 시장 타일의 읽은 뒤 높이(QA 스택 1024·1440 191~208px, 390 170~204px)에 맞춘 값입니다.
 */
const PENDING_BAR = "h-3.5 rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border";

function PendingLines({ count }: { count: number | undefined }): JSX.Element | null {
  const lines = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (lines === 0) {
    return null;
  }
  return (
    <div aria-hidden="true" className="mt-2.5 flex flex-col gap-3.5">
      {Array.from({ length: lines }, (_, index) => (
        // 마지막 줄을 짧게 — 글 문단처럼(공용 Skeleton과 같은 규칙).
        <div key={index} className={`${PENDING_BAR} ${lines > 1 && index === lines - 1 ? "w-3/5" : "w-full"}`} />
      ))}
    </div>
  );
}

const VALUE_NUMBER = "text-xl font-semibold tabular-nums lg:text-2xl";
/**
 * 숫자 값 글(flex-nowrap 값 줄의 항목) — 줄어들지 않고(shrink-0) 값 줄 폭까지만(max-w-full). 타일의 wrap-anywhere는 flex 항목의 최소 폭을 한 글자로
 * 내리므로, 줄어들 수 있으면 단위 자리가 2px 모자랄 때 '1,339.2|8'처럼 숫자 안에서 꺾였습니다. 이렇게 두면 짧은 숫자는 꺾이지 않고, 값 줄보다 긴 값만
 * 값 줄 안에서 꺾입니다.
 */
const VALUE_NUMBER_ITEM = "shrink-0 max-w-full";
/**
 * 단위 — 값 글 안 끝에 붙여 값이 꺾여도 마지막 줄을 따라가고(따로 된 flex 항목이면 꺾인 값 상자 뒤에 놓여 타일 밖으로 나갔음), 그 안에서는 꺾지 않습니다.
 * 오른쪽 바깥 여백 −12px: 타일 안쪽 여백(12px)까지는 걸쳐도 되게 해, 단위 자리가 조금 모자랄 때 단위만 다음 줄로 넘어가지 않습니다(1280 일곱 타일
 * '1,339.28' + '원'이 안쪽 폭을 2px 넘음 — QA-599). 간격 4px(ml-1)는 예전 값 줄 간격(gap-x-1)과 같고, 글자는 값의 굵기·크기를 물려받지 않습니다.
 */
const VALUE_UNIT = "-mr-3 ml-1 whitespace-nowrap text-sm font-normal text-text-3";
const VALUE_LABEL = "break-keep text-heading-sm lg:text-heading";

function KpiValue({ item }: { item: KpiItem }): JSX.Element {
  if (item.pending) {
    return (
      <>
        <Skeleton lines={1} label={`${item.label} 불러오는 중`} />
        <PendingLines count={item.pendingLines} />
      </>
    );
  }
  const text = statValueText(item.value, item.format);
  if (text === null) {
    return (
      <span className={`${VALUE_NUMBER} text-text-3`}>
        <Empty reason={item.emptyReason} />
      </span>
    );
  }
  const ink = item.neutral ? "text-neutral" : "text-text";
  return (
    <span className={`${item.valueKind === "label" ? VALUE_LABEL : `${VALUE_NUMBER} ${VALUE_NUMBER_ITEM}`} ${ink}`}>
      {text}
      {item.unit ? <span className={VALUE_UNIT}>{item.unit}</span> : null}
    </span>
  );
}

/**
 * 값 줄 — 읽는 중이면 블록(QA-596). 숫자 값은 단위와 한 덩어리라 줄을 바꾸지 않습니다(flex-nowrap — 숫자는 쉼표에서도 꺾이지 않으므로 넘치는 몫은
 * 단위 폭 하나뿐: 1280 운영자 일곱 타일 한 줄에서 '1,339.28' + '원'이 안쪽 폭을 2px 넘지만 타일 안 — QA-599. 단위는 값 글 안 끝에 걸침 — VALUE_UNIT).
 * 판정 라벨은 낱말 사이에서 꺾습니다.
 */
function valueRowClass(item: KpiItem): string {
  if (item.pending) {
    return "mt-0.5";
  }
  return `mt-0.5 flex ${item.valueKind === "label" ? "flex-wrap" : "flex-nowrap"} items-baseline gap-x-1`;
}

function KpiTileBody({ item }: { item: KpiItem }): JSX.Element {
  const change = item.change && !item.pending ? item.change : null;
  // 변화량·변화율을 둘 다 모르면 칩이 그려지지 않으므로(ChangeChip) 캡션만 남지 않게 줄째 뺍니다.
  const changeShown = change !== null && !(isMissingValue(change.change) && isMissingValue(change.changePct));
  const caption = change ? presentText(change.caption) : null;
  const flagged = Boolean(item.isEstimated || item.isProxy || item.isStale);
  const note = presentText(item.note);
  const sourced =
    !item.pending && (presentText(item.source) !== null || presentText(item.asOf) !== null || (typeof item.delayMin === "number" && Number.isFinite(item.delayMin)));
  return (
    <>
      <div
        aria-hidden={item.pending ? true : undefined}
        className={`text-caption font-medium text-text-2 ${item.href ? "underline-offset-2 group-hover:underline" : ""}`.trim()}
      >
        {item.label}
      </div>
      {/* 읽는 중이면 값 줄은 블록 — flex 행 안의 Skeleton 상자는 폭을 정하지 않아 0으로 줄었습니다(QA-596). */}
      <div className={valueRowClass(item)}>
        <KpiValue item={item} />
      </div>
      {change && changeShown ? (
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
          <ChangeChip size="sm" change={change.change} changePct={change.changePct} digits={change.digits} pctDigits={change.pctDigits} />
          {caption ? <span className="text-xs text-text-3">{caption}</span> : null}
        </div>
      ) : null}
      {item.status && !item.pending ? (
        <div className="mt-1 text-xs leading-4">
          <StatusText tone={item.status.tone} iconSize={12}>
            {item.status.text}
          </StatusText>
        </div>
      ) : null}
      {flagged ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <EstimateBadge estimated={item.isEstimated} proxy={item.isProxy} />
          <StaleBadge stale={item.isStale} reason={item.staleReason} />
        </div>
      ) : null}
      {sourced ? (
        <p className="mt-1 leading-4">
          <ProvenanceBadge source={item.source} asOf={item.asOf} delayMin={item.delayMin} title={item.provenanceTitle} />
        </p>
      ) : null}
      {note ? <p className="mt-1 text-xs leading-4 text-text-3">{note}</p> : null}
    </>
  );
}

/** 타일이 이 수보다 많으면 xl에서도 한 줄로 늘이지 않고 4칸으로 둡니다(한 칸이 너무 좁아짐). */
const MAX_ONE_ROW = 8;

/**
 * KPI 띠(작업대 실행 명세 §6 KpiStrip·W7 — 홈·모의 개요의 44px 히어로 대신): 화면 맨 위 요약 값 타일을 한 줄로.
 *
 * - 값은 20px(lg 24px)·굵게·`tabular-nums`. 판정 라벨(`valueKind: "label"` — 국면)은 숫자가 아니라 tabular 없이 16·20px.
 * - 값을 모르면 "—"와 사유, 단위는 값이 있을 때만. 추정·대리·이전 값 배지는 늘 보입니다. 읽는 중이면 값 자리에 Skeleton(role=status)과
 *   `pendingLines`만큼의 글 없는 자리 줄(값이 온 뒤의 높이를 미리 잡음 — QA-598).
 * - 바깥에서 온 숫자는 출처 줄(공용 출처 배지 — 출처·장 상태·지연·시각, 참고 시세 표기)을 타일 아래에 늘 둡니다(원칙 '모든 숫자에 출처' — 밀도를 위해 숨기지 않음).
 * - 변화는 공용 변화 칩(▲▼ 12px·부호 −·sr '상승/하락')과 12px 캡션, 상태는 공용 상태 글(아이콘 + 글 — 색만으로 뜻을 전하지 않음).
 * - `href`가 있으면 타일 전체가 그 대상 화면 링크입니다(중립 잉크·hover surface-2 + 이름 밑줄·포커스 링 — 데이터 영역이라 강조 파랑을 쓰지 않음, A1).
 *   링크가 아닌 타일은 이름 있는 묶음(role=group)이라 이름과 값이 함께 읽힙니다.
 * - 배치: 좁은 화면 두 칸, sm 세 칸, lg 네 칸, xl은 타일 수만큼 한 줄(8개 넘으면 네 칸). 타일 사이 8px.
 * - 끊을 곳 없는 긴 값·출처는 타일 안에서 꺾음(말줄임 없음 — PropertyList와 같은 규칙). 숫자 값은 단위와 한 줄이고, 값 줄보다 긴 값만 그 안에서 꺾입니다.
 */
export function KpiStrip({ label, items }: { label: string; items: readonly KpiItem[] }): JSX.Element {
  const oneRow = items.length > 0 && items.length <= MAX_ONE_ROW;
  const style = oneRow ? ({ "--kpi-n": items.length } as CSSProperties) : undefined;
  return (
    <section aria-label={label} className="min-w-0">
      <ul
        className={`grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 ${oneRow ? "xl:grid-cols-[repeat(var(--kpi-n),minmax(0,1fr))]" : ""}`.trim()}
        style={style}
      >
        {items.map((item) => {
          let tile: ReactNode;
          if (item.href) {
            tile = (
              <Link href={item.href} className={`${TILE} ${LINK_TILE}`}>
                <KpiTileBody item={item} />
              </Link>
            );
          } else {
            tile = (
              <div role="group" aria-label={item.label} className={TILE}>
                <KpiTileBody item={item} />
              </div>
            );
          }
          return (
            <li key={item.key} className="min-w-0">
              {tile}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
