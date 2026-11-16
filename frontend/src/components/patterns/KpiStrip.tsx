import Link from "next/link";
import type { JSX, ReactNode } from "react";

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
  /**
   * 넓은 칸 배치의 자리 줄 수 — `pendingLines`보다 작으면 이 수 이상 순번의 덧 막대를 넓은 칸 배치(세 칸 sm~lg, 띠 816px 이상인 네 칸 — WIDE_PENDING_HIDE)
   * 에서만 CSS로 감춥니다(DOM 막대 수는 그대로). 타일이 넓으면 출처 줄이 덜 꺾여 읽은 뒤 타일이 낮기 때문입니다(QA-604). 주지 않으면 모든 배치에서 `pendingLines`.
   */
  pendingLinesWide?: number;
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
 * 읽는 중 자리 줄의 막대 — 공용 Skeleton 막대와 같은 모양(놓인 면보다 한 단계 위 면·motion-safe 깜빡임·고대비 1px 테두리). 위 간격 10px + 막대 14px +
 * 사이 14px로 다섯 줄이면 136px(+ 이름·값 자리표시·여백 64px = 200px) — 타일이 좁은 배치(두 칸 390·네 칸 1024)의 홈 시장 타일 읽은 뒤 높이(QA 스택
 * 1024 191~208px, 390 170~204px)에 맞춘 값이고, 한 줄 배치(xl·넓은 띠)에서는 위 간격이 18px라 208px입니다(ONE_ROW_PENDING_GAP — 1440·1920 208px).
 * 타일이 넓은 배치(세 칸 sm~lg·띠 816px 이상의 네 칸)는 `pendingLinesWide`만큼 — 홈 시장 타일은 네 줄 172px(WIDE_PENDING_HIDE, QA-604).
 */
const PENDING_BAR = "h-3.5 rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border";

function PendingLines({ count, wide, gap, hide }: { count: number | undefined; wide?: number; gap?: string; hide?: string }): JSX.Element | null {
  const lines = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (lines === 0) {
    return null;
  }
  // 넓은 칸 배치에서 남길 줄 수 — 주지 않았거나 줄 수 이상이면 감추는 막대가 없습니다.
  const wideLines = typeof wide === "number" && Number.isFinite(wide) ? Math.max(0, Math.floor(wide)) : lines;
  return (
    <div aria-hidden="true" className={`mt-2.5 flex flex-col gap-3.5 ${gap ?? ""}`.trim()}>
      {Array.from({ length: lines }, (_, index) => (
        // 마지막 줄을 짧게 — 글 문단처럼(공용 Skeleton과 같은 규칙). 넓은 칸 배치에서 감출 막대는 hide(WIDE_PENDING_HIDE)를 덧붙입니다.
        <div
          key={index}
          className={`${PENDING_BAR} ${lines > 1 && index === lines - 1 ? "w-3/5" : "w-full"} ${index >= wideLines && hide ? hide : ""}`.trim()}
        />
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
 * 단위 — 값 끝 묶음(VALUE_TAIL) 안, 마지막 글자 뒤. 오른쪽 바깥 여백 −12px: 타일 안쪽 여백(12px)까지는 걸쳐도 되게 해, 단위 자리가 조금 모자랄 때
 * 숫자 안에서 꺾이지 않습니다(1280 메뉴 220 일곱 타일 '1,339.28' + '원'이 안쪽 폭을 1.6px 넘음). 이 여유보다 더 모자랄 만큼 좁은 칸은 띠가
 * 만들지 않습니다(한 줄 최소 칸 폭 — ONE_ROW_GRID). 간격 4px(ml-1)는 예전 값 줄 간격과 같고, 글자는 값의 굵기·크기를 물려받지 않습니다.
 */
const VALUE_UNIT = "-mr-3 ml-1 text-sm font-normal text-text-3";
const VALUE_LABEL = "break-keep text-heading-sm lg:text-heading";

function KpiValue({ item, pendingGap, pendingHide }: { item: KpiItem; pendingGap?: string; pendingHide?: string }): JSX.Element {
  if (item.pending) {
    return (
      <>
        <Skeleton lines={1} label={`${item.label} 불러오는 중`} />
        <PendingLines count={item.pendingLines} wide={item.pendingLinesWide} gap={pendingGap} hide={pendingHide} />
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
 * 붙드는 것은 값 줄이 아니라 값 글 안의 값 끝 묶음(VALUE_TAIL)과 단위의 −12px 여유(VALUE_UNIT)입니다. 판정 라벨은 낱말 사이에서 꺾습니다(break-keep).
 */
function valueRowClass(item: KpiItem): string {
  if (item.pending) {
    return "mt-0.5";
  }
  return "mt-0.5 flex items-baseline";
}

function KpiTileBody({ item, pendingGap, pendingHide }: { item: KpiItem; pendingGap?: string; pendingHide?: string }): JSX.Element {
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
        <KpiValue item={item} pendingGap={pendingGap} pendingHide={pendingHide} />
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

/**
 * 한 줄 배치(타일 수 1~8) — xl이어도 띠 폭이 '타일 수 × 한 줄 최소 칸 폭 134px + 사이 8px × (타일 수 − 1)'보다 좁으면 한 줄로 늘이지 않고 네 칸(lg)
 * 입니다. 한 줄 여부를 뷰포트가 아니라 띠 폭(컨테이너 질의 — 띠 section이 @container)으로 정합니다: 왼쪽 메뉴 폭(접힘 48px·펼침 220px, 가변 폭 메뉴는
 * 끌어서 200~320px)에 따라 같은 1280에서도 띠 폭이 바뀌어, 뷰포트로만 정하면 메뉴 320px에서 일곱 타일이 121px까지 좁아졌습니다(QA-599).
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
 * 넓은 칸 배치에서 감출 자리 막대(`pendingLinesWide` 이상 순번)의 클래스 — 세 칸(sm~lg, 타일 192~312px)과 띠가 816px(= 4 × 198 + 3 × 8 — 타일 198px)
 * 이상인 네 칸(lg 1100~1279 메뉴 220, 그리고 xl이지만 한 줄이 아닌 폭)입니다. 이 배치에서는 출처 줄이 덜 꺾여 홈 시장 타일의 읽은 뒤 높이가 QA 자료(이전 값
 * 배지 있음) 154~187px, 새 자료(배지 없음) 128~178px라 다섯 줄 자리표시(200px)가 커 값이 오면 아래 전체가 올라왔습니다(QA-604 — 넷째 줄까지 172px).
 * 두 칸(390, 171px)·좁은 네 칸(lg 1024~1060, 179~188px)·한 줄 배치는 네 줄로 줄이면 이전 값 자료에서 더 밀려 감추지 않습니다. DOM 막대 수는 그대로입니다.
 * Tailwind가 클래스를 글로 찾으므로 xl 몫은 타일 수별로 적어 둡니다(경계 = ONE_ROW_GRID와 같은 n × 134 + (n − 1) × 8px — 시험이 대조, `@max-[N]`은
 * '띠 폭 < N'이라 한 줄 배치 `@min-[N]`과 겹치지도 비지도 않음). 한 줄 경계가 816px 이하(타일 5개 이하)면 xl에서 띠 816px 이상은 늘 한 줄이라 xl 몫이 없습니다.
 */
const WIDE_PENDING_HIDE = "sm:max-lg:hidden lg:max-xl:@min-[816px]:hidden";
const WIDE_PENDING_HIDE_XL: Readonly<Record<number, string>> = {
  6: "xl:@min-[816px]:@max-[844px]:hidden",
  7: "xl:@min-[816px]:@max-[986px]:hidden",
  8: "xl:@min-[816px]:@max-[1128px]:hidden",
};
/** 한 줄 배치가 없는 타일 수(8개 초과)는 xl에서도 네 칸이라 띠 폭만 봅니다. */
const WIDE_PENDING_HIDE_XL_ROWS = "xl:@min-[816px]:hidden";

function widePendingHide(count: number): string {
  const xl = ONE_ROW_GRID[count] === undefined ? WIDE_PENDING_HIDE_XL_ROWS : (WIDE_PENDING_HIDE_XL[count] ?? "");
  return `${WIDE_PENDING_HIDE} ${xl}`.trim();
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
export function KpiStrip({ label, items }: { label: string; items: readonly KpiItem[] }): JSX.Element {
  // 8개를 넘으면 xl에서도 한 줄로 늘이지 않고 네 칸(한 칸이 너무 좁아짐 — 표에 없음).
  const oneRow = ONE_ROW_GRID[items.length] ?? "";
  const pendingGap = ONE_ROW_PENDING_GAP[items.length];
  const pendingHide = widePendingHide(items.length);
  return (
    <section aria-label={label} className="@container min-w-0">
      <ul className={`grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 ${oneRow}`.trim()}>
        {items.map((item) => {
          let tile: ReactNode;
          if (item.href) {
            tile = (
              <Link href={item.href} className={`${TILE} ${LINK_TILE}`}>
                <KpiTileBody item={item} pendingGap={pendingGap} pendingHide={pendingHide} />
              </Link>
            );
          } else {
            tile = (
              <div role="group" aria-label={item.label} className={TILE}>
                <KpiTileBody item={item} pendingGap={pendingGap} pendingHide={pendingHide} />
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
