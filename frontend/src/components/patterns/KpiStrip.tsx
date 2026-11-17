import Link from "next/link";
import type { JSX, ReactNode } from "react";

import { FOCUS_RING } from "@/components/ui/classes";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import type { KpiItem } from "@/lib/kpi";
import { dateTokenParts, isMissingValue, presentText, statValueText } from "@/lib/patterns";

import { EstimateBadge, ProvenanceBadge, StaleBadge } from "./badges";
import { ChangeChip } from "./ChangeChip";
import { Empty } from "./Empty";
import { Skeleton } from "./Skeleton";

/** KPI 띠의 타일 하나 — 형의 정본은 lib/kpi(화면 모델이 같은 형을 씀)이고 여기서 다시 내보냅니다. */
export type { KpiItem };

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
 * 읽는 중 자리 줄의 막대 — 공용 Skeleton 막대와 같은 모양(놓인 면보다 한 단계 위 면·motion-safe 깜빡임·고대비 1px 테두리). 위 간격 10px + 막대 14px +
 * 사이 14px로 다섯 줄이면 136px(+ 이름·값 자리표시·여백 64px = 200px) — 타일이 좁은 배치(두 칸 390·네 칸 1024)의 홈 시장 타일 읽은 뒤 높이(QA 스택
 * 1024 191~208px, 390 170~204px)에 맞춘 값이고, 한 줄 배치(xl·넓은 띠)에서는 위 간격이 18px라 208px입니다(ONE_ROW_PENDING_GAP — 1440·1920 208px).
 * 타일이 넓은 배치(띠 404px 이상의 두 칸·세 칸 sm~lg·띠 816px 이상의 네 칸)는 `pendingLinesWide`만큼 — 홈 시장 타일은 네 줄 172px(WIDE_PENDING, QA-604).
 */
const PENDING_BAR = "h-3.5 rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border";

function PendingLines({ count, wide, gap, layout }: { count: number | undefined; wide?: number; gap?: string; layout?: WidePending }): JSX.Element | null {
  const lines = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (lines === 0) {
    return null;
  }
  // 넓은 칸 배치에서 남길 줄 수 — 주지 않았거나 줄 수 이상이면 넓은 칸 배치도 다른 배치와 같습니다.
  const wideLines = typeof wide === "number" && Number.isFinite(wide) ? Math.max(0, Math.floor(wide)) : lines;
  const wideClass = (index: number): string => {
    if (!layout || wideLines >= lines) return "";
    if (index >= wideLines) return layout.hide;
    // 넓은 칸 배치에서 보이는 마지막 막대 — 그 배치에서도 마지막 줄을 짧게(한 줄만 남으면 짧게 하지 않음 — 공용 Skeleton과 같은 규칙).
    return wideLines > 1 && index === wideLines - 1 ? layout.short : "";
  };
  return (
    <div aria-hidden="true" className={`mt-2.5 flex flex-col gap-3.5 ${gap ?? ""}`.trim()}>
      {Array.from({ length: lines }, (_, index) => (
        // 마지막 줄을 짧게 — 글 문단처럼(공용 Skeleton과 같은 규칙). 넓은 칸 배치의 감추기·짧게는 그 배치의 변형 클래스(WIDE_PENDING)로 덧붙입니다.
        <div key={index} className={`${PENDING_BAR} ${lines > 1 && index === lines - 1 ? "w-3/5" : "w-full"} ${wideClass(index)}`.trim()} />
      ))}
    </div>
  );
}

const VALUE_NUMBER = "text-xl font-semibold tabular-nums lg:text-2xl";
/**
 * 숫자 값 글(값 줄의 flex 항목 하나) — 줄어들지 않고(shrink-0) 값 줄 폭까지만(max-w-full). 타일의 wrap-anywhere는 flex 항목의 최소 폭을 한 글자로
 * 내리므로, 줄어들 수 있으면 단위 자리가 2px 모자랄 때 '1,339.2|8'처럼 숫자 안에서 꺾였습니다. 이렇게 두면 짧은 숫자는 꺾이지 않고, 값 줄보다 긴 값만
 * 값 줄 안에서 꺾입니다.
 */
const VALUE_NUMBER_ITEM = "shrink-0 max-w-full";
/**
 * 값 끝 묶음 — 값의 마지막 글자와 단위를 줄바꿈 없는 묶음 하나로 둡니다. 숫자 끝과 단위 사이(한글 단위 앞, '%' 앞 — wrap-anywhere)에 줄바꿈 기회가
 * 없어 단위만 다음 줄로 넘어가지 않고, 값 줄보다 긴 값은 숫자 안에서 꺾이되 단위는 마지막 글자에 붙어 갑니다(QA-599).
 */
const VALUE_TAIL = "whitespace-nowrap";
/**
 * 단위 — 값 끝 묶음(VALUE_TAIL) 안, 마지막 글자 뒤. 간격 4px(ml-1)는 예전 값 줄 간격과 같고, 글자는 값의 굵기·크기를 물려받지 않습니다.
 * 타일 안쪽 여백(12px)까지 걸쳐도 되는 여유는 단위가 아니라 값 줄이 갖습니다(VALUE_ROW_UNIT — QA-625).
 */
const VALUE_UNIT = "ml-1 text-sm font-normal text-text-3";
/**
 * 단위가 있는 숫자 값의 값 줄 — 오른쪽 바깥 여백 −12px로 값 줄을 타일 안쪽 여백까지 넓혀, 값 글(max-w-full = 값 줄)이 단위 자리가 조금 모자랄 때
 * 그 여백에 걸쳐 숫자 안에서 꺾이지 않습니다(1280 메뉴 220 일곱 타일 '1,339.28' + '원'이 안쪽 폭을 1.6px 넘음 — QA-599). 이 여유보다 더 모자랄 만큼
 * 좁은 칸은 띠가 만들지 않습니다(한 줄 최소 칸 폭 — ONE_ROW_GRID). 예전에는 여유를 단위 글의 음수 여백으로 두었는데, 크롬이 값 글의 내용 폭을 그만큼
 * 덜 재 그 폭 안에서 숫자를 꺾었습니다 — 좁은 단위('pt')의 '−0.58'이 '−0.5' / '8 pt' 두 줄(QA-625).
 */
const VALUE_ROW_UNIT = "mt-0.5 -mr-3 flex items-baseline";
const VALUE_LABEL = "break-keep text-heading-sm lg:text-heading";

function KpiValue({ item, pendingGap, pendingWide }: { item: KpiItem; pendingGap?: string; pendingWide?: WidePending }): JSX.Element {
  if (item.pending) {
    return (
      <>
        <Skeleton lines={1} label={`${item.label} 불러오는 중`} />
        <PendingLines count={item.pendingLines} wide={item.pendingLinesWide} gap={pendingGap} layout={pendingWide} />
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
      <ValueText text={text} unit={item.unit} />
    </span>
  );
}

/** 값 글 — 단위가 있으면 마지막 글자와 단위를 값 끝 묶음(VALUE_TAIL) 하나로. 글자는 그대로라 값 글의 textContent는 '값 + 단위'입니다. */
function ValueText({ text, unit }: { text: string; unit?: string | null }): JSX.Element {
  if (!unit) {
    return <>{text}</>;
  }
  const chars = Array.from(text);
  const last = chars.pop() ?? "";
  return (
    <>
      {chars.join("")}
      <span className={VALUE_TAIL}>
        {last}
        <span className={VALUE_UNIT}>{unit}</span>
      </span>
    </>
  );
}

/**
 * 값 줄 — 읽는 중이면 블록(QA-596), 값이 오면 값 글 하나를 담는 flex 행(숫자 값 글은 shrink-0 max-w-full — VALUE_NUMBER_ITEM). 값과 단위를 한 줄에
 * 붙드는 것은 값 글 안의 값 끝 묶음(VALUE_TAIL)과, 단위가 있는 숫자 값이면 값 줄의 −12px 여유(VALUE_ROW_UNIT)입니다. 판정 라벨은 낱말 사이에서 꺾습니다(break-keep).
 */
function valueRowClass(item: KpiItem, pendingMatchesValue: boolean): string {
  if (item.pending) {
    // 값 줄 높이(20·24px 글의 줄 28·32px)를 미리 잡을 때(띠의 선택 prop) — 읽는 중 막대(22px) 줄이 값 줄보다 낮아 값이 오면 띠가 6·10px 자랐음.
    return pendingMatchesValue ? "mt-0.5 min-h-7 lg:min-h-8" : "mt-0.5";
  }
  const unitTail = item.valueKind !== "label" && Boolean(item.unit) && statValueText(item.value, item.format) !== null;
  return unitTail ? VALUE_ROW_UNIT : "mt-0.5 flex items-baseline";
}

/** 보조 글 — keepDates면 날짜·시각 마디를 줄바꿈 없는 묶음으로(출처 배지 keepDates와 같은 규칙 — lib/patterns dateTokenParts, 글자는 그대로). */
function NoteText({ text, keepDates }: { text: string; keepDates: boolean }): JSX.Element {
  if (!keepDates) return <>{text}</>;
  return (
    <>
      {dateTokenParts(text).map((part, index) =>
        part.date ? (
          <span key={index} className="whitespace-nowrap">
            {part.text}
          </span>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

function KpiTileBody({
  item,
  pendingGap,
  pendingWide,
  pendingMatchesValue = false,
  keepDates = false,
}: {
  item: KpiItem;
  pendingGap?: string;
  pendingWide?: WidePending;
  pendingMatchesValue?: boolean;
  keepDates?: boolean;
}): JSX.Element {
  const change = item.change && !item.pending ? item.change : null;
  // 변화량·변화율을 둘 다 모르면 칩이 그려지지 않으므로(ChangeChip) 캡션만 남지 않게 줄째 뺍니다.
  const changeShown = change !== null && !(isMissingValue(change.change) && isMissingValue(change.changePct));
  const caption = change ? presentText(change.caption) : null;
  const flagged = Boolean(item.isEstimated || item.isProxy || item.isStale);
  const note = presentText(item.note);
  // 출처 줄 — 값이 온 뒤에 그립니다. 띠가 값 꼴에 맞춘 자리표시를 바라면(pendingMatchesValue) 읽는 중에도 받은 출처 글(정적 — 값이 아님)을 그려 같은 높이를 잡습니다.
  const sourced =
    (!item.pending || pendingMatchesValue) &&
    (presentText(item.source) !== null || presentText(item.asOf) !== null || (typeof item.delayMin === "number" && Number.isFinite(item.delayMin)));
  return (
    <>
      <div
        aria-hidden={item.pending ? true : undefined}
        className={`text-caption font-medium text-text-2 ${item.href ? "underline-offset-2 group-hover:underline" : ""}`.trim()}
      >
        {item.label}
      </div>
      {/* 읽는 중이면 값 줄은 블록 — flex 행 안의 Skeleton 상자는 폭을 정하지 않아 0으로 줄었습니다(QA-596). */}
      <div className={valueRowClass(item, pendingMatchesValue)}>
        <KpiValue item={item} pendingGap={pendingGap} pendingWide={pendingWide} />
      </div>
      {change && changeShown ? (
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5">
          <ChangeChip
            size="sm"
            change={change.change}
            changePct={change.changePct}
            digits={change.digits}
            pctDigits={change.pctDigits}
            unit={change.unit ?? undefined}
          />
          {caption ? <span className="text-xs text-text-3">{caption}</span> : null}
        </div>
      ) : null}
      {item.status && !item.pending ? (
        <div className="mt-1 text-xs leading-4">
          <StatusText
            tone={item.status.tone}
            iconSize={12}
            srPrefix={item.status.srPrefix}
            icon={item.status.icon === "alert" ? <AlertTriangleIcon size={12} /> : undefined}
          >
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
          <ProvenanceBadge source={item.source} asOf={item.asOf} delayMin={item.delayMin} title={item.provenanceTitle} keepDates={keepDates} />
        </p>
      ) : null}
      {/* 보조 글도 한글은 낱말 사이에서만 줄을 바꿉니다(공용 글 부품 규약 QA-568 — 타일의 wrap-anywhere는 공백 없는 긴 토큰만 꺾음, QA-637). */}
      {note ? (
        <p className="mt-1 break-keep text-xs leading-4 text-text-3">
          <NoteText text={note} keepDates={keepDates} />
        </p>
      ) : null}
    </>
  );
}

/**
 * 한 줄 배치(타일 수 1~8) — xl이어도 띠 폭이 '타일 수 × 한 줄 최소 칸 폭 134px + 사이 8px × (타일 수 − 1)'보다 좁으면 한 줄로 늘이지 않고 네 칸(lg)
 * 입니다. 한 줄 여부를 뷰포트가 아니라 띠 폭(컨테이너 질의 — 띠 section이 @container)으로 정합니다: 왼쪽 메뉴 폭(접힘 48px·펼침 220px, 가변 폭 메뉴는
 * 끌어서 206~320px)에 따라 같은 1280에서도 띠 폭이 바뀌어, 뷰포트로만 정하면 메뉴 320px에서 일곱 타일이 121px까지 좁아졌습니다(QA-599).
 * 134px(안쪽 108px)는 넓은 숫자 값 — '1,339.28' + '원'(24px 굵게 약 111px)이 단위 여유(−12px — VALUE_UNIT) 안에서, 단위 없는 다섯 자리
 * '10,123.45'(약 107px)가 여유 없이 — 가 한 줄에 들어가는 폭입니다. Tailwind가 클래스를 글로 찾으므로 적어 둡니다(경계 = n × 134 + (n − 1) × 8px —
 * 시험이 대조).
 */
const ONE_ROW_GRID: Readonly<Record<number, string>> = {
  1: "xl:@min-[134px]:grid-cols-1",
  2: "xl:@min-[276px]:grid-cols-2",
  3: "xl:@min-[418px]:grid-cols-3",
  4: "xl:@min-[560px]:grid-cols-4",
  5: "xl:@min-[702px]:grid-cols-5",
  6: "xl:@min-[844px]:grid-cols-6",
  7: "xl:@min-[986px]:grid-cols-7",
  8: "xl:@min-[1128px]:grid-cols-8",
};

/**
 * 한 줄 배치일 때 읽는 중 자리 줄 위 간격 18px(그 밖 10px — PendingLines). 조건은 ONE_ROW_GRID와 같은 경계입니다. 한 줄 배치의 칸은 좁아 읽은 뒤
 * 타일이 가장 낮아도 208px(1440·1920 홈 시장 타일, 1280은 259px)이라, 자리표시(200px)가 그만큼 모자라 값이 오면 아래 패널이 8px 이상 밀렸습니다(QA-598).
 */
const ONE_ROW_PENDING_GAP: Readonly<Record<number, string>> = {
  1: "xl:@min-[134px]:mt-4.5",
  2: "xl:@min-[276px]:mt-4.5",
  3: "xl:@min-[418px]:mt-4.5",
  4: "xl:@min-[560px]:mt-4.5",
  5: "xl:@min-[702px]:mt-4.5",
  6: "xl:@min-[844px]:mt-4.5",
  7: "xl:@min-[986px]:mt-4.5",
  8: "xl:@min-[1128px]:mt-4.5",
};

/**
 * 넓은 칸 배치의 자리 막대 클래스 — 감출 막대(`pendingLinesWide` 이상 순번)는 `hide`, 그 배치에서 보이는 마지막 막대(`pendingLinesWide` − 1 순번)는
 * `short`(공용 Skeleton의 '마지막 줄을 짧게'를 배치마다 지킴 — 두 글은 같은 변형의 짝이고 시험이 대조).
 *
 * 넓은 칸 배치 = 타일이 198px 이상인 배치: 띠가 404px(= 2 × 198 + 8) 이상인 두 칸(뷰포트 640 미만 — 436~639), 세 칸(sm~lg, 타일 192~312px), 띠가
 * 816px(= 4 × 198 + 3 × 8) 이상인 네 칸(lg 1100~1279 메뉴 220, 그리고 xl이지만 한 줄이 아닌 폭). 이 배치에서는 홈 시장 타일의 출처 줄이 덜 꺾여 읽은 뒤
 * 높이가 QA 자료(이전 값 배지 있음) 154~187px, 새 자료(배지 없음) 128~178px라, 다섯 줄 자리표시(200px)면 값이 올 때 아래 전체가 올라왔습니다(QA-604 —
 * 넷째 줄까지 172px. 두 칸 440~639의 새 자료 CLS 0.115~0.163). 출처 줄이 한 줄 덜 꺾이는 폭은 두 칸·네 칸 모두 타일 196~196.5px(QA 스택 — 두 칸 띠
 * 400→401px, 네 칸 808→810px)이라 기준 198px은 그보다 조금 넓게 잡은 값입니다. 타일이 그보다 좁은 두 칸(390 타일 175px)·네 칸(lg 1024 179px)과 한 줄
 * 배치는 이전 값 자료가 187~208px(390·1024·1440)이라 네 줄로 줄이면 더 밀려 감추지 않습니다. DOM 막대 수는 그대로입니다.
 * Tailwind가 클래스를 글로 찾으므로 두 글 모두 적어 두고, xl 몫은 타일 수별로 적어 둡니다(경계 = ONE_ROW_GRID와 같은 n × 134 + (n − 1) × 8px — 시험이 대조,
 * `@max-[N]`은 '띠 폭 < N'이라 한 줄 배치 `@min-[N]`과 겹치지도 비지도 않음). 한 줄 경계가 816px 이하(타일 5개 이하)면 xl에서 띠 816px 이상은 늘 한 줄이라
 * xl 몫이 없습니다.
 */
type WidePending = { hide: string; short: string };
const WIDE_PENDING: WidePending = {
  hide: "max-sm:@min-[404px]:hidden sm:max-lg:hidden lg:max-xl:@min-[816px]:hidden",
  short: "max-sm:@min-[404px]:w-3/5 sm:max-lg:w-3/5 lg:max-xl:@min-[816px]:w-3/5",
};
const WIDE_PENDING_XL: Readonly<Record<number, WidePending>> = {
  6: { hide: "xl:@min-[816px]:@max-[844px]:hidden", short: "xl:@min-[816px]:@max-[844px]:w-3/5" },
  7: { hide: "xl:@min-[816px]:@max-[986px]:hidden", short: "xl:@min-[816px]:@max-[986px]:w-3/5" },
  8: { hide: "xl:@min-[816px]:@max-[1128px]:hidden", short: "xl:@min-[816px]:@max-[1128px]:w-3/5" },
};
/** 한 줄 배치가 없는 타일 수(8개 초과)는 xl에서도 네 칸이라 띠 폭만 봅니다. */
const WIDE_PENDING_XL_ROWS: WidePending = { hide: "xl:@min-[816px]:hidden", short: "xl:@min-[816px]:w-3/5" };

function widePending(count: number): WidePending {
  const xl = ONE_ROW_GRID[count] === undefined ? WIDE_PENDING_XL_ROWS : WIDE_PENDING_XL[count];
  return xl ? { hide: `${WIDE_PENDING.hide} ${xl.hide}`, short: `${WIDE_PENDING.short} ${xl.short}` } : WIDE_PENDING;
}

/**
 * KPI 띠(작업대 실행 명세 §6 KpiStrip·W7 — 홈·모의 개요의 44px 히어로 대신): 화면 맨 위 요약 값 타일을 한 줄로.
 *
 * - 값은 20px(lg 24px)·굵게·`tabular-nums`. 판정 라벨(`valueKind: "label"` — 국면)은 숫자가 아니라 tabular 없이 16·20px.
 * - 값을 모르면 "—"와 사유, 단위는 값이 있을 때만. 추정·대리·이전 값 배지는 늘 보입니다. 읽는 중이면 값 자리에 Skeleton(role=status)과
 *   `pendingLines`만큼의 글 없는 자리 줄(값이 온 뒤의 높이를 미리 잡음 — QA-598, 넓은 칸 배치는 `pendingLinesWide`만큼 — QA-604).
 * - 바깥에서 온 숫자는 출처 줄(공용 출처 배지 — 출처·장 상태·지연·시각, 참고 시세 표기)을 타일 아래에 늘 둡니다(원칙 '모든 숫자에 출처' — 밀도를 위해 숨기지 않음).
 * - 변화는 공용 변화 칩(▲▼ 12px·부호 −·sr '상승/하락')과 12px 캡션, 상태는 공용 상태 글(아이콘 + 글 — 색만으로 뜻을 전하지 않음).
 * - `href`가 있으면 타일 전체가 그 대상 화면 링크입니다(중립 잉크·hover surface-2 + 이름 밑줄·포커스 링 — 데이터 영역이라 강조 파랑을 쓰지 않음, A1).
 *   링크가 아닌 타일은 이름 있는 묶음(role=group)이라 이름과 값이 함께 읽힙니다.
 * - 배치: 좁은 화면 두 칸, sm 세 칸, lg 네 칸, xl은 타일 수만큼 한 줄 — 띠 폭이 타일마다 최소 칸 폭(ONE_ROW_GRID)을 줄 때만(컨테이너 질의,
 *   좁으면 네 칸, 8개 넘으면 네 칸). 타일 사이 8px.
 * - 끊을 곳 없는 긴 값·출처는 타일 안에서 꺾음(말줄임 없음 — PropertyList와 같은 규칙). 단위는 값의 마지막 글자와 한 묶음이라 홀로 다음 줄로
 *   가지 않고, 값 줄보다 긴 값만 숫자 안에서 꺾입니다.
 */
export function KpiStrip({
  label,
  items,
  pendingMatchesValue = false,
  keepDates = false,
}: {
  label: string;
  items: readonly KpiItem[];
  /**
   * 읽는 중 타일을 값이 온 뒤의 꼴에 맞춥니다(선택, 기본 꺼짐 — 홈 띠는 자리 줄 수 `pendingLines`로 맞춤): 값 자리를 값 줄 높이(28·32px)로 잡고, 출처 줄은
   * 읽는 중에도 받은 출처 글(정적)로 그립니다. 변화·상태·메모가 없는 띠(섹터 SPY 기간 수익률 — 첫 타일만 출처 줄)가 값이 와도 높이가 같게(P5a 검토 CLS).
   */
  pendingMatchesValue?: boolean;
  /**
   * 출처 줄·보조 글의 날짜·시각 마디를 줄바꿈 없는 묶음으로(선택, 기본 꺼짐 — 홈 띠 그대로): 좁은 타일에서 '표본 2016-' / '08-08'처럼 날짜 안에서 꺾이지
   * 않고 마디 사이에서만 꺾입니다(출처 배지 keepDates와 같음 — 시장 화면의 띠가 씀, P5a 검토).
   */
  keepDates?: boolean;
}): JSX.Element {
  // 8개를 넘으면 xl에서도 한 줄로 늘이지 않고 네 칸(한 칸이 너무 좁아짐 — 표에 없음).
  const oneRow = ONE_ROW_GRID[items.length] ?? "";
  const pendingGap = ONE_ROW_PENDING_GAP[items.length];
  const pendingWide = widePending(items.length);
  return (
    <section aria-label={label} className="@container min-w-0">
      <ul className={`grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 ${oneRow}`.trim()}>
        {items.map((item) => {
          let tile: ReactNode;
          if (item.href) {
            tile = (
              <Link href={item.href} className={`${TILE} ${LINK_TILE}`}>
                <KpiTileBody item={item} pendingGap={pendingGap} pendingWide={pendingWide} pendingMatchesValue={pendingMatchesValue} keepDates={keepDates} />
              </Link>
            );
          } else {
            tile = (
              <div role="group" aria-label={item.label} className={TILE}>
                <KpiTileBody item={item} pendingGap={pendingGap} pendingWide={pendingWide} pendingMatchesValue={pendingMatchesValue} keepDates={keepDates} />
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
