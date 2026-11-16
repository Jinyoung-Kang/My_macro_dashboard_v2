import { isValidElement, type JSX, type ReactNode } from "react";

import { Tag } from "@/components/ui";
import { CandlestickIcon, ChartLineIcon, LandmarkIcon, type IconProps } from "@/components/ui/icons";
import { isMissingValue, presentText, statValueText } from "@/lib/patterns";

import { ChangeChip } from "./ChangeChip";
import { Empty } from "./Empty";

/** 상세 화면 셋의 대상 종류(지표 /markets/i/…·종목 /s/…·기관 /institutions/…) — 이름과 아이콘을 이 패턴이 압니다. */
export type EntityKind = "indicator" | "stock" | "institution";

/** 그 밖의 대상 종류(정보 검색의 회사·인물·주제, 모의 계좌·결정 등) — 부르는 쪽이 종류 글과 장식 아이콘을 넘깁니다. */
export type EntityKindSpec = { label: string; icon: (props: IconProps) => JSX.Element };

const KIND: Record<EntityKind, EntityKindSpec> = {
  indicator: { label: "지표", icon: ChartLineIcon },
  stock: { label: "종목", icon: CandlestickIcon },
  institution: { label: "기관", icon: LandmarkIcon },
};

/** 값 옆 변화 — KPI 띠 타일의 `change`와 같은 꼴(변화 칩 + 12px 캡션 '전일 대비' 등). 변화량·변화율을 둘 다 모르면 줄이 없습니다(0.00%를 만들지 않음). */
export type EntityChange = { change?: number | null; changePct?: number | null; digits?: number; pctDigits?: number; caption?: string | null };

function isEntityChange(value: ReactNode | EntityChange): value is EntityChange {
  return typeof value === "object" && value !== null && !isValidElement(value) && !Array.isArray(value) && ("change" in value || "changePct" in value);
}

/** 구조화된 변화 → 변화 칩(▲▼·부호 −·sr 방향)과 캡션. 둘 다 모르면 null. */
function EntityChangeLine({ value }: { value: EntityChange }): JSX.Element | null {
  if (isMissingValue(value.change) && isMissingValue(value.changePct)) return null;
  const caption = presentText(value.caption);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <ChangeChip change={value.change} changePct={value.changePct} digits={value.digits ?? 2} pctDigits={value.pctDigits ?? 2} />
      {caption ? <span className="text-xs text-text-3">{caption}</span> : null}
    </span>
  );
}

/**
 * 대상 머리(작업대 실행 명세 §6 EntityHeader, P4 — 상세 화면 셋의 맨 위, 지금 화면 머리 PageHeader 자리): 종류 아이콘 · 이름(h1) · 종류·식별자 태그 · 보조 글 ·
 * 주 값 하나(28px) · 배지 줄 · 동작.
 *
 * - 종류는 왼쪽 32px 아이콘 칸(장식)과 이름 옆 중립 태그 글('지표'·'종목'·'기관')로 함께 보입니다 — 아이콘만으로 뜻을 전하지 않습니다. 상세 화면 셋 밖의
 *   대상(정보 검색의 회사·인물·주제, 모의 계좌 등)은 `kind`에 종류 글과 아이콘(`EntityKindSpec`)을 넘깁니다 — 종류를 더하려고 이 패턴을 고치지 않습니다.
 * - 이름은 말줄임하지 않고 낱말 사이에서 줄을 바꿉니다(break-keep wrap-anywhere — 긴 기관 이름·영문 회사 이름). 글자 단계 heading(20px).
 * - 식별자(티커·CIK·시리즈 id)는 고정폭 중립 태그(명세 §3-6 — 시스템 고정폭).
 * - 주 값(`value`)은 28px(text-value-lg)·`tabular-nums` 하나뿐이고, 앞에 12px 캡션(`valueLabel` — 값의 뜻)을 둘 수 있습니다. 값을 모르면 "—"와 사유(단위 없음),
 *   0은 값입니다. `value`를 넘기지 않으면(undefined) 값 줄이 없습니다. 변화(`change`)는 값 옆입니다 — KPI 띠와 같은 꼴(`{ change, changePct, digits,
 *   pctDigits, caption }` — 변화 칩 + 12px 캡션, 둘 다 모르면 없음)이나 그린 요소를 받습니다.
 * - 배지 줄(`badges` — 출처·추정·이전 값·장 상태)은 값 줄 아래에 늘 보이고, 비면(그린 것이 없으면) 접힙니다.
 * - 동작(`actions` — 바로가기 링크·신선도·주기 고르기)은 넓은 화면(lg 이상) 오른쪽, 좁은 화면은 아래로 내려갑니다.
 * - `placeholder`(불러오는 중 Skeleton·오류 글)는 값 줄·배지 줄 자리만 바꿉니다 — 이름·종류·식별자·동작은 그대로 남고 다시 마운트되지 않습니다.
 * - 데이터 영역이라 강조 파랑을 쓰지 않습니다(A1 — 값·태그·아이콘 칸 모두 중립 잉크, lib/__tests__/accentInData.test.ts).
 */
export function EntityHeader({
  kind,
  name,
  headingLevel = 1,
  description,
  identifiers,
  tags,
  valueLabel,
  value,
  format,
  unit,
  emptyReason,
  change,
  badges,
  actions,
  placeholder,
}: {
  kind: EntityKind | EntityKindSpec;
  name: string;
  /** 기본 1(상세 화면). 정보 검색 대상 화면처럼 화면 안의 머리면 2. */
  headingLevel?: 1 | 2;
  /** 이름 아래 한 줄 보조 글 — 예 'AAPL · NasdaqGS · 주식 · USD'. */
  description?: ReactNode;
  /** 고정폭 식별자 태그 — 예 'CIK 0001067983'. */
  identifiers?: readonly string[];
  /** 그 밖의 태그(공용 Tag). */
  tags?: ReactNode;
  /** 주 값의 뜻 — 값 앞 12px 캡션(예 '13F 보고 평가액'). */
  valueLabel?: string;
  /** 주 값. undefined면 값 줄 없음, null·빈 글·"N/A"·NaN이면 "—". */
  value?: string | number | null;
  format?: (value: number) => string;
  /** 단위 — 값이 있을 때만(QA-049). */
  unit?: string | null;
  emptyReason?: string | null;
  /** 값 옆 변화 — 구조화된 꼴(변화 칩 + 캡션, KPI 띠와 같음) 또는 그린 요소. */
  change?: EntityChange | ReactNode;
  /** 값 줄 아래 배지 줄(출처·추정·이전 값·장 상태). */
  badges?: ReactNode;
  /** 넓은 화면 오른쪽 동작 영역. */
  actions?: ReactNode;
  /** 값 줄·배지 줄 대신(불러오는 중·오류). */
  placeholder?: ReactNode;
}): JSX.Element {
  const { label: kindLabel, icon: Icon } = typeof kind === "string" ? KIND[kind] : kind;
  const Heading = headingLevel === 2 ? "h2" : "h1";
  const hasPlaceholder = placeholder !== undefined && placeholder !== null && placeholder !== false;
  const text = value === undefined ? null : statValueText(value, format);
  const hasDescription = description !== undefined && description !== null && description !== false && description !== "";

  return (
    <header className="flex min-w-0 flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
      <div className="flex min-w-0 items-start gap-3">
        {/* 종류 아이콘 칸 — 장식(뜻은 이름 옆 종류 태그가 나름). 넓은 화면에서 제목 줄(28px) 가운데에 오게 2px 내립니다. */}
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-control border border-border bg-surface-2 text-text-2"
        >
          <Icon size={18} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Heading className="min-w-0 break-keep wrap-anywhere text-heading text-text">{name}</Heading>
            <Tag>{kindLabel}</Tag>
            {(identifiers ?? []).map((identifier) => (
              <Tag key={identifier}>
                <span className="font-mono">{identifier}</span>
              </Tag>
            ))}
            {tags}
          </div>
          {hasDescription ? <p className="min-w-0 break-keep wrap-anywhere text-sm text-text-2">{description}</p> : null}
          {hasPlaceholder ? (
            <div className="min-w-0">{placeholder}</div>
          ) : (
            <>
              {value !== undefined ? (
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                  {valueLabel ? <span className="text-xs text-text-3">{valueLabel}</span> : null}
                  {text === null ? (
                    <span className="text-value-lg text-text-3">
                      <Empty reason={emptyReason} />
                    </span>
                  ) : (
                    <span className="inline-flex items-baseline gap-x-1">
                      <span className="text-value-lg tabular-nums text-text">{text}</span>
                      {unit ? <span className="text-sm text-text-3">{unit}</span> : null}
                    </span>
                  )}
                  {isEntityChange(change) ? <EntityChangeLine value={change} /> : change}
                </div>
              ) : null}
              {badges !== undefined && badges !== null && badges !== false ? (
                <div className="flex min-w-0 flex-wrap items-center gap-1.5 empty:hidden">{badges}</div>
              ) : null}
            </>
          )}
        </div>
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">{actions}</div> : null}
    </header>
  );
}
