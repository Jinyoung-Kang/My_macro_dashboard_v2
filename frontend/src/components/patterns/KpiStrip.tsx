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
  /** 읽는 중 — 값 자리에 Skeleton 한 줄(role=status '{label} 불러오는 중'). */
  pending?: boolean;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  /** 주면 타일 전체가 그 대상 화면 링크. */
  href?: string;
};

/** 타일 한 칸 — 4px·1px 경계·surface, 안쪽 12px(위아래 10px) — StatTile과 같은 조밀한 칸(명세 §3-7). */
const TILE = "block h-full min-w-0 rounded-control border border-border bg-surface px-3 py-2.5";
/**
 * 링크 타일 — 중립 잉크(강조 파랑 아님, A1), 마우스를 올리면 바탕 surface-2 + 이름 밑줄, 포커스 링. 높이는 내용(이름 18 + 값 28 + 위아래 20 = 66px 이상)이
 * 정하지만, 누르는 자리 44px(lg 미만)를 클래스로도 적어 둡니다 — 클래스로 읽는 누름 자리 감사(lib/__tests__/touchTargetAudit)가 이 타일도 보게(겉모양 그대로).
 */
const LINK_TILE = `group min-h-11 text-text hover:bg-surface-2 motion-safe:transition-colors ${FOCUS_RING}`;

const VALUE_NUMBER = "text-xl font-semibold tabular-nums lg:text-2xl";
const VALUE_LABEL = "break-keep text-heading-sm lg:text-heading";

function KpiValue({ item }: { item: KpiItem }): JSX.Element {
  if (item.pending) {
    return <Skeleton lines={1} label={`${item.label} 불러오는 중`} />;
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
    <>
      <span className={`${item.valueKind === "label" ? VALUE_LABEL : VALUE_NUMBER} ${ink}`}>{text}</span>
      {item.unit ? <span className="text-sm text-text-3">{item.unit}</span> : null}
    </>
  );
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
      <div className={`text-caption font-medium text-text-2 ${item.href ? "underline-offset-2 group-hover:underline" : ""}`.trim()}>{item.label}</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1">
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
 * - 값을 모르면 "—"와 사유, 단위는 값이 있을 때만. 추정·대리·이전 값 배지는 늘 보입니다. 읽는 중이면 값 자리에 Skeleton(role=status).
 * - 바깥에서 온 숫자는 출처 줄(공용 출처 배지 — 출처·장 상태·지연·시각, 참고 시세 표기)을 타일 아래에 늘 둡니다(원칙 '모든 숫자에 출처' — 밀도를 위해 숨기지 않음).
 * - 변화는 공용 변화 칩(▲▼ 12px·부호 −·sr '상승/하락')과 12px 캡션, 상태는 공용 상태 글(아이콘 + 글 — 색만으로 뜻을 전하지 않음).
 * - `href`가 있으면 타일 전체가 그 대상 화면 링크입니다(중립 잉크·hover surface-2 + 이름 밑줄·포커스 링 — 데이터 영역이라 강조 파랑을 쓰지 않음, A1).
 *   링크가 아닌 타일은 이름 있는 묶음(role=group)이라 이름과 값이 함께 읽힙니다.
 * - 배치: 좁은 화면 두 칸, sm 세 칸, lg 네 칸, xl은 타일 수만큼 한 줄(8개 넘으면 네 칸). 타일 사이 8px.
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
