import type { ReactNode } from "react";

import { presentText, statValueText } from "@/lib/patterns";

import { EstimateBadge, StaleBadge } from "./badges";
import { Empty } from "./Empty";

/**
 * 통계 타일 — 라벨 · 값(카드 숫자 24px) · 단위 · 보조 글(백분위·표본).
 *
 * - 값을 모르면 "—"와 사유(`emptyReason`, 예: 표본 부족). 단위는 붙이지 않습니다("—%"는 값이 있는 것처럼 읽힘, QA-049).
 * - 수집기의 "N/A"·빈 글도 값 없음으로 봅니다. 숫자는 `format`(없으면 소수 둘째 자리)으로 찍습니다.
 * - 추정·대리·이전 값 플래그가 있으면 배지가 반드시 보입니다. `isProxy`·`isStale`·`staleReason`은
 *   설계서 §1.5 계약에 더한 선택 props입니다(AssetRowData와 같은 이름).
 * - 타일 하나가 라벨 이름의 묶음(role="group")이라 읽어 주기에서 라벨과 값이 함께 읽힙니다.
 */
export function StatTile({
  label,
  value,
  unit,
  note,
  isEstimated,
  isProxy,
  isStale,
  staleReason,
  emptyReason,
  format,
}: {
  label: string;
  value: number | string | null;
  unit?: string | null;
  note?: string | null;
  isEstimated?: boolean;
  isProxy?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
  emptyReason?: string | null;
  format?: (v: number) => string;
}) {
  const text = statValueText(value, format);
  const flagged = Boolean(isEstimated || isProxy || isStale);
  const detail = presentText(note);
  return (
    <div role="group" aria-label={label} className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3">
      <div className="text-xs font-medium text-text-2">{label}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-1">
        {text === null ? (
          <span className="text-2xl font-semibold text-text-3">
            <Empty reason={emptyReason} />
          </span>
        ) : (
          <>
            <span className="text-2xl font-semibold tabular-nums text-text">{text}</span>
            {unit ? <span className="text-sm text-text-3">{unit}</span> : null}
          </>
        )}
      </div>
      {flagged ? (
        <div className="mt-2 flex flex-wrap gap-1">
          <EstimateBadge estimated={isEstimated} proxy={isProxy} />
          <StaleBadge stale={isStale} reason={staleReason} />
        </div>
      ) : null}
      {detail ? <p className="mt-1 text-xs leading-relaxed text-text-3">{detail}</p> : null}
    </div>
  );
}

// 전체 클래스 이름을 적어 둡니다 — Tailwind는 조립한 이름(`grid-cols-${n}`)을 만들지 않습니다.
const COLS: Record<2 | 3 | 4, string> = {
  2: "grid-cols-2",
  3: "grid-cols-2 md:grid-cols-3",
  4: "grid-cols-2 md:grid-cols-4",
};

/** 통계 타일 격자. 좁은 화면은 두 칸, md(768px) 이상에서 `cols` 칸(기본 4). */
export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: 2 | 3 | 4 }) {
  return <div className={`grid min-w-0 gap-3 ${COLS[cols]}`}>{children}</div>;
}
