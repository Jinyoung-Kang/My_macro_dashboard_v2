import { isValidElement, useId, type ReactNode } from "react";

import { changeChipModel, isMissingValue, presentText } from "@/lib/patterns";

import { EstimateBadge } from "./badges";
import { ChangeChip } from "./ChangeChip";
import { Empty } from "./Empty";

/**
 * 문지르는 동안 히어로가 보일 그 점의 값 — `lib/lineChart`의 `scrubModel` 결과를 그대로 넘깁니다(변화량 자릿수만 덧붙여).
 * 설계서 §1.5 계약에 더한 선택 prop의 모양입니다.
 */
export type HeroScrub = {
  /** 그 점의 값 글(모르면 "—"). */
  valueText: string;
  /** 그 점의 날짜 글. */
  dateText: string;
  /** 기간 시작(첫 유효값) 대비 변화량·변화율 — 모르면 칩을 생략합니다. */
  change?: number | null;
  changePct?: number | null;
  /** 변화량 소수 자릿수(기본 2, 원 단위 정수면 0). */
  changeDigits?: number;
  /** 추정 점(장중 값 단계의 오늘 추정 점)이면 추정 배지를 그 점 옆에 보입니다. */
  isEstimated?: boolean;
  /**
   * 꼬리 점의 설명 — 추정 점이면 배지 안('추정 · 23:58'), 추정이 아닌 꼬리 점(현금뿐 계좌의 장부 값)이면 배지 없이 글('장부'). 알림 영역도 읽습니다.
   */
  estimateNote?: string | null;
};

/**
 * 히어로 — 라벨(제목) · 큰 값(글자 단계 display: 좁은 화면 36px, sm 이상 44px) · 단위 · 변화 칩 · 한 줄 판정 글 · 배지(meta) · 기간 탭 · 본문(차트 등).
 *
 * - 판정은 `verdict` 글로 적습니다. 색·선만으로 판정을 전하지 않습니다(PRINCIPLES "선 하나로 판정까지 전하지 않습니다").
 * - 값이 없으면(null·빈 글·"N/A"·NaN) "—". 사유를 보이려면 `value={<Empty reason="…" />}`로 넘깁니다(그때도 값 없음으로 봄).
 *   단위는 값이 있을 때만 붙입니다("— 원"은 값이 있는 것처럼 읽힘, QA-049).
 * - 출처·추정·이전 값 배지는 `meta`로 넘깁니다(ProvenanceBadge·EstimateBadge·StaleBadge).
 * - 제목 수준은 화면 구조에 맞춰 `headingLevel`(기본 2). 영역 이름은 그 제목입니다.
 * - `placeholder`(선택)를 주면 값·변화·판정·배지 대신 그것(불러오는 중 Skeleton·오류)을 그리고, 탭·본문 자리는 그대로 둡니다 — 값을 다시 읽는
 *   동안에도 같은 틀이라 탭(시장 고르기 등)이 다시 마운트되지 않아 초점을 잃지 않습니다.
 * - `tabsPlacement`(선택, 기본 "above"): 탭을 본문 위(홈의 시장 고르기)에 둘지, 본문 아래(차트 아래의 기간 알약 — 명세 §1)에 둘지.
 * - `valueKind`(선택, 기본 "number"): "label"이면 값이 숫자가 아니라 판정 라벨(예: 홈 국면 '후퇴 경계 (Late cycle)')이라 한 단계 작게
 *   (좁은 화면 28px·sm 이상 36px) 그리고 숫자 자리 맞춤(tabular-nums)을 하지 않습니다 — 44px 글자 라벨은 반 폭 히어로에서 세 줄로 접혔습니다.
 * - `scrub`(선택, 명세 §4·D9): 히어로 차트를 문지르는 동안의 그 점 값(`HeroScrub`). 값이 있으면 큰 숫자를 그 값으로, 변화 칩을 '기간 시작 대비'로
 *   바꾸고 날짜를 옆에 적습니다. 판정 글과 meta 배지(추정·이전 값)는 그대로 보입니다(원칙 A3). 큰 숫자에는 aria-live를 달지 않습니다 —
 *   지금 값은 읽어 주기용 '지금 값 …'으로 늘 남고, 문지른 점은 따로 둔 조용한 알림 영역(aria-live="polite")이 '날짜 값'으로 읽습니다
 *   (차트에 초점을 두고 ←·→로 점을 옮기는 낭독기 사용자에게 — 꼬리 점이면 '추정 23:58'·'장부'까지). 문지를 수 있는 히어로는 문지르지 않을 때
 *   `scrub={null}`을 넘깁니다 — 그래야
 *   알림 영역이 미리 있어 첫 점부터 읽힙니다. `undefined`(주지 않음)면 알림 영역도 두지 않습니다.
 */
export function Hero({
  label,
  value,
  unit,
  change,
  verdict,
  meta,
  tabs,
  tabsPlacement = "above",
  valueKind = "number",
  headingLevel = 2,
  placeholder,
  scrub,
  children,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  change?: ReactNode;
  verdict?: string | null;
  meta?: ReactNode;
  tabs?: ReactNode;
  /** 탭 자리 — 본문 위(기본) 또는 아래. */
  tabsPlacement?: "above" | "below";
  /** 값의 종류 — 숫자(기본) 또는 판정 라벨(한 단계 작은 글자, 숫자 자리 맞춤 없음). */
  valueKind?: "number" | "label";
  headingLevel?: 2 | 3;
  /** 값 자리에 대신 그릴 것(불러오는 중·오류) — 주면 값·변화·판정·배지는 그리지 않습니다. */
  placeholder?: ReactNode;
  /** 문지르는 점의 값(위 설명). null이면 문지르지 않는 중, 주지 않으면 문지를 수 없는 히어로. */
  scrub?: HeroScrub | null;
  children?: ReactNode;
}) {
  const headingId = useId();
  const Heading = headingLevel === 3 ? "h3" : "h2";
  // 부르는 쪽이 사유와 함께 넘긴 <Empty />도 값 없음 — 그 요소(사유 포함)를 그대로 그리고 단위만 뺍니다.
  const givenEmpty = isValidElement(value) && value.type === Empty;
  const missing = givenEmpty || isMissingValue(value);
  const sentence = presentText(verdict);
  const scrubbing = placeholder === undefined && scrub != null ? scrub : null;
  const scrubMissing = scrubbing !== null && isMissingValue(scrubbing.valueText);
  const scrubDigits = scrubbing?.changeDigits ?? 2;
  const scrubChip = scrubbing !== null && changeChipModel(scrubbing.change, scrubbing.changePct, scrubDigits, 2) !== null;
  const scrubNote = presentText(scrubbing?.estimateNote);
  const tabsBlock = tabs ? <div className="mt-4">{tabs}</div> : null;
  return (
    <section aria-labelledby={headingId} className="min-w-0 rounded-card border border-border bg-surface p-6 lg:p-8">
      <Heading id={headingId} className="text-[15px] font-medium text-text-2">
        {label}
      </Heading>
      {/* 자리마다 순서를 고정합니다(자리표시 ↔ 값으로 바뀌어도 탭·본문이 같은 자리 — 다시 마운트되지 않음). */}
      {placeholder !== undefined ? (
        <div className="mt-3 min-w-0">{placeholder}</div>
      ) : scrubbing !== null ? (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {/* 문지른 값은 눈으로만 — 읽어 주기는 아래 알림 영역이 하고, 이 자리는 지금 값을 읽습니다. */}
          <span aria-hidden="true" className={`text-display-sm tabular-nums sm:text-display ${scrubMissing ? "text-text-3" : "text-text"}`}>
            {scrubbing.valueText}
          </span>
          {!scrubMissing && unit ? (
            <span aria-hidden="true" className="text-base text-text-3">
              {unit}
            </span>
          ) : null}
          <span className="sr-only">
            지금 값 {missing && !givenEmpty ? <Empty /> : value}
            {!missing && unit ? ` ${unit}` : null}
          </span>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className={`${valueKind === "label" ? "text-title-1 sm:text-display-sm" : "text-display-sm tabular-nums sm:text-display"} ${missing ? "text-text-3" : "text-text"}`}>
            {missing && !givenEmpty ? <Empty /> : value}
          </span>
          {!missing && unit ? <span className="text-base text-text-3">{unit}</span> : null}
        </div>
      )}
      {/* 문지르는 동안: '기간 시작 대비' 칩(모르면 생략)·날짜·추정 배지(장부 값 꼬리 점이면 배지 없이 그 설명) — 눈으로 보는 줄이고 읽어 주기는
          알림 영역이 합니다.
          그 밖에는 부르는 쪽의 칩. 칩이 null(변화를 모름)을 그리면 빈 줄이 되므로 :empty로 접습니다. */}
      {scrubbing !== null ? (
        <div aria-hidden="true" className="mt-1 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
          {scrubChip ? (
            <>
              <ChangeChip change={scrubbing.change} changePct={scrubbing.changePct} digits={scrubDigits} pctDigits={2} />
              <span className="text-[13px] text-text-3">기간 시작 대비 ·</span>
            </>
          ) : null}
          <span className="text-[13px] tabular-nums text-text-2">{scrubbing.dateText}</span>
          {scrubbing.isEstimated ? (
            <EstimateBadge estimated note={scrubbing.estimateNote} />
          ) : scrubNote ? (
            <span className="text-[13px] text-text-2">· {scrubNote}</span>
          ) : null}
        </div>
      ) : placeholder === undefined && change ? (
        <div className="mt-1 empty:hidden">{change}</div>
      ) : null}
      {placeholder === undefined && sentence ? <p className="mt-3 text-body-md text-text">{sentence}</p> : null}
      {placeholder === undefined && meta ? <div className="mt-3 flex flex-wrap items-center gap-2 empty:hidden">{meta}</div> : null}
      {tabsPlacement === "above" ? tabsBlock : null}
      {children ? <div className="mt-4 min-w-0">{children}</div> : null}
      {tabsPlacement === "below" ? tabsBlock : null}
      {scrub !== undefined ? (
        // 조용한 알림 — 문지른 점의 '날짜 값'(추정 점이면 '추정'과 그 설명 — '추정 23:58', 장부 값 꼬리 점이면 '장부'). 문지르지 않으면 비워 둡니다.
        <div className="sr-only" aria-live="polite" aria-atomic="true">
          {scrubbing !== null
            ? `${scrubbing.dateText} ${scrubbing.valueText}${!scrubMissing && unit ? ` ${unit}` : ""}${scrubbing.isEstimated ? " 추정" : ""}${
                scrubNote ? ` ${scrubNote}` : ""
              }`
            : ""}
        </div>
      ) : null}
    </section>
  );
}
