import { isValidElement, useId, type ReactNode } from "react";

import { isMissingValue, presentText } from "@/lib/patterns";

import { Empty } from "./Empty";

/**
 * 히어로 — 라벨(제목) · 큰 값(36~44px) · 단위 · 변화 칩 · 한 줄 판정 글 · 배지(meta) · 기간 탭 · 본문(차트 등).
 *
 * - 판정은 `verdict` 글로 적습니다. 색·선만으로 판정을 전하지 않습니다(PRINCIPLES "선 하나로 판정까지 전하지 않습니다").
 * - 값이 없으면(null·빈 글·"N/A"·NaN) "—". 사유를 보이려면 `value={<Empty reason="…" />}`로 넘깁니다(그때도 값 없음으로 봄).
 *   단위는 값이 있을 때만 붙입니다("— 원"은 값이 있는 것처럼 읽힘, QA-049).
 * - 출처·추정·이전 값 배지는 `meta`로 넘깁니다(ProvenanceBadge·EstimateBadge·StaleBadge).
 * - 제목 수준은 화면 구조에 맞춰 `headingLevel`(기본 2). 영역 이름은 그 제목입니다.
 * - `placeholder`(선택)를 주면 값·변화·판정·배지 대신 그것(불러오는 중 Skeleton·오류)을 그리고, 탭·본문 자리는 그대로 둡니다 — 값을 다시 읽는
 *   동안에도 같은 틀이라 탭(시장 고르기 등)이 다시 마운트되지 않아 초점을 잃지 않습니다.
 */
export function Hero({
  label,
  value,
  unit,
  change,
  verdict,
  meta,
  tabs,
  headingLevel = 2,
  placeholder,
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  change?: ReactNode;
  verdict?: string | null;
  meta?: ReactNode;
  tabs?: ReactNode;
  headingLevel?: 2 | 3;
  /** 값 자리에 대신 그릴 것(불러오는 중·오류) — 주면 값·변화·판정·배지는 그리지 않습니다. */
  placeholder?: ReactNode;
  children?: ReactNode;
}) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";
  // 부르는 쪽이 사유와 함께 넘긴 <Empty />도 값 없음 — 그 요소(사유 포함)를 그대로 그리고 단위만 뺍니다.
  const givenEmpty = isValidElement(value) && value.type === Empty;
  const missing = givenEmpty || isMissingValue(value);
  const sentence = presentText(verdict);
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-xl border border-border bg-surface p-5 sm:p-6">
      <Heading id={headingId} className="text-sm font-medium text-text-2">
        {label}
      </Heading>
      {/* 자리마다 순서를 고정합니다(자리표시 ↔ 값으로 바뀌어도 탭·본문이 같은 자리 — 다시 마운트되지 않음). */}
      {placeholder !== undefined ? (
        <div className="mt-3 min-w-0">{placeholder}</div>
      ) : (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className={`text-[36px] font-semibold leading-tight tabular-nums sm:text-[44px] ${missing ? "text-text-3" : "text-text"}`}
          >
            {missing && !givenEmpty ? <Empty /> : value}
          </span>
          {!missing && unit ? <span className="text-base text-text-3">{unit}</span> : null}
        </div>
      )}
      {/* 칩이 null(변화를 모름)을 그리면 빈 줄이 되므로 :empty로 접습니다. */}
      {placeholder === undefined && change ? <div className="mt-1 empty:hidden">{change}</div> : null}
      {placeholder === undefined && sentence ? <p className="mt-3 text-base leading-relaxed text-text">{sentence}</p> : null}
      {placeholder === undefined && meta ? <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden">{meta}</div> : null}
      {tabs ? <div className="mt-4">{tabs}</div> : null}
      {children ? <div className="mt-4 min-w-0">{children}</div> : null}
    </section>
  );
}
