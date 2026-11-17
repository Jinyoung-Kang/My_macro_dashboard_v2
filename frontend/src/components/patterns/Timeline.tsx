"use client";

import type { JSX, ReactNode } from "react";

import { Tag, type TagTone } from "@/components/ui";

import { EstimateBadge, StaleBadge } from "./badges";
import { MasterDetail } from "./MasterDetail";

/**
 * 기록의 종류 — 공용 태그(Tag)로 그립니다. 톤(주의·위험·정상)을 주면 아이콘 + 글(주의·위험은 낭독기에 '주의: ' — 색만으로 뜻을 전하지 않음),
 * `icon`으로 톤 기본 아이콘을 바꾸거나(false면 글만) 중립 태그에 아이콘을 붙입니다.
 */
export type TimelineKind = { label: string; tone?: TagTone; icon?: ReactNode | false };

/** 시각순 목록의 기록 하나. */
export type TimelineEntry = {
  key: string;
  /** 보이는 시각 글 — '2026-11-16'·'11-16 22:45'(시각 열 5.5rem, tabular-nums). */
  at: string;
  /** `<time dateTime>` — 기계가 읽는 시각(ISO). 없으면 붙이지 않습니다. */
  dateTime?: string;
  kind: TimelineKind;
  /** 한 줄 요약 — 말줄임 없이 낱말 사이에서 줄을 바꿉니다(줄 단추 안 — 링크·단추를 넣지 않음). */
  summary: ReactNode;
  /** 검사 칸 제목·대화상자 이름(줄 단추 이름은 줄 내용 — 시각·종류·요약). */
  title: string;
  /** 추정·이전 값 배지 — 늘 보입니다. */
  isEstimated?: boolean;
  isStale?: boolean;
  staleReason?: string | null;
};

/**
 * 줄 내용 — 좁은 틀에서는 1행 시각 + 종류 태그, 2행 요약(basis-full), 틀이 24rem(@sm) 이상이면 한 줄(요약이 남은 폭을 차지하고 길면 그 안에서 꺾음).
 * 배지는 요약 뒤(꺾이면 다음 줄). 크기 질의 기준은 목록-검사 틀(@container)입니다.
 */
function TimelineRow({ entry }: { entry: TimelineEntry }): JSX.Element {
  const flagged = Boolean(entry.isEstimated || entry.isStale);
  return (
    <span className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1">
      <time dateTime={entry.dateTime} className="w-[5.5rem] shrink-0 text-sm tabular-nums text-text-2">
        {entry.at}
      </time>
      <span className="shrink-0">
        <Tag tone={entry.kind.tone} icon={entry.kind.icon}>
          {entry.kind.label}
        </Tag>
      </span>
      <span className="min-w-0 basis-full break-keep wrap-anywhere text-text @sm:flex-1 @sm:basis-auto">{entry.summary}</span>
      {flagged ? (
        <span className="flex flex-wrap gap-1">
          <EstimateBadge estimated={entry.isEstimated} />
          <StaleBadge stale={entry.isStale} reason={entry.staleReason} />
        </span>
      ) : null}
    </span>
  );
}

/** 자리표시 막대(공용 Skeleton 막대와 같은 모양 — 놓인 면보다 한 단계 위 면·motion-safe 깜빡임·고대비 1px 테두리). */
const BAR = "block rounded-control bg-control-fill motion-safe:animate-pulse forced-colors:border";

/**
 * 시각순 목록의 읽는 중 자리표시 — 목록 줄과 같은 꼴(목록-검사 줄의 여백·구분선, 시각 열 5.5rem·종류 태그·요약 두 줄)의 글 없는 줄 `rows`개.
 * `placeholder`로 넘깁니다(목록 대신 — 오류면 ErrorState). 응답 전에 목록 높이를 잡아 두어 값이 온 뒤 아래 내용이 덜 밀리게 합니다(줄 수는 부르는 쪽이
 * 요청 한도 안에서 정함 — 보이는 수가 아님). role=status + 이름(`label`), 줄은 읽기에서 뺍니다.
 */
export function TimelineSkeleton({ rows, label = "불러오는 중" }: { rows: number; label?: string }): JSX.Element {
  const count = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 1;
  return (
    <div role="status" aria-busy="true" aria-label={label} className="min-w-0">
      <span className="sr-only">{label}</span>
      <ul aria-hidden="true" data-timeline-pending="" className="flex min-w-0 flex-col">
        {Array.from({ length: count }, (_, index) => (
          <li
            key={index}
            className={`flex min-h-11 min-w-0 items-center px-3 py-2 lg:min-h-0 ${index === count - 1 ? "lg:py-1.5" : "border-b border-border-subtle lg:pt-1.5 lg:pb-[5px]"}`}
          >
            <span className="flex min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1">
              <span className="flex h-5 w-[5.5rem] shrink-0 items-center">
                <span className={`h-3.5 w-20 ${BAR}`} />
              </span>
              <span className={`h-5 w-16 shrink-0 ${BAR}`} />
              <span className="flex min-w-0 basis-full flex-col @sm:flex-1 @sm:basis-auto">
                <span className="flex h-5 items-center">
                  <span className={`h-3.5 w-full ${BAR}`} />
                </span>
                <span className="flex h-5 items-center">
                  <span className={`h-3.5 w-3/5 ${BAR}`} />
                </span>
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 시각순 목록(작업대 실행 명세 §6 Timeline — 처음 쓰는 곳 국면 판정 기록 P5a, P6 결정 로그(W13)·P7 알림): 기록마다 시각 열·종류 태그·한 줄 요약·배지를
 * 줄로 두고, 줄을 고르면 검사 칸(넓은 화면 옆 15rem)이나 대화상자(좁은 화면·좁은 틀)에 자세한 값(`renderDetail`)을 보입니다.
 *
 * - 목록-검사(`MasterDetail`)를 그대로 씁니다 — j/k·↑↓·Home·End·Esc, roving tabindex, 옆 검사 칸/위쪽 고정 대화상자, `autoSelectFirst`(넓은 화면만),
 *   `selectedKey`·`onSelectedKeyChange`, 빈 목록 `emptyText`, 읽는 중·오류 `placeholder`(목록 꼴 자리표시 `TimelineSkeleton`·ErrorState — 목록 대신), `count`.
 * - 기록의 차례는 부르는 쪽이 정합니다(보통 최근이 위). 줄 단추 안이라 요약에 링크·단추를 넣지 않습니다 — 그런 것은 `renderDetail`에.
 * - 펼칠 때 읽는 자세한 값(결정 원문 등)은 `renderDetail` 안의 자식 부품이 읽습니다(목록은 읽지 않음 — 요청 시점은 부르는 쪽 몫).
 * - 날짜 묶음 머리·넓은 검사 칸은 P6이 선택 prop으로 더합니다(지금은 없음).
 * - 데이터 영역이라 강조 파랑을 쓰지 않습니다(종류 태그는 중립·의도 톤, 고른 줄은 잉크 막대 — 데이터 칸 강조색 금지 목록).
 */
export function Timeline({
  label,
  entries,
  renderDetail,
  count,
  emptyText,
  placeholder,
  autoSelectFirst = false,
  selectedKey,
  onSelectedKeyChange,
  inspectorHint,
  headingLevel,
}: {
  /** 목록 이름(ul aria-label) — 예 '판정 기록'. */
  label: string;
  entries: readonly TimelineEntry[];
  renderDetail: (entry: TimelineEntry) => ReactNode;
  count?: boolean | ((count: number) => string);
  emptyText?: ReactNode;
  placeholder?: ReactNode;
  autoSelectFirst?: boolean;
  selectedKey?: string | null;
  onSelectedKeyChange?: (key: string | null) => void;
  inspectorHint?: string;
  headingLevel?: 2 | 3 | 4;
}): JSX.Element {
  return (
    <MasterDetail<TimelineEntry>
      label={label}
      items={entries}
      itemKey={(entry) => entry.key}
      itemLabel={(entry) => entry.title}
      renderItem={(entry) => <TimelineRow entry={entry} />}
      renderDetail={renderDetail}
      count={count}
      emptyText={emptyText}
      placeholder={placeholder}
      autoSelectFirst={autoSelectFirst}
      selectedKey={selectedKey}
      onSelectedKeyChange={onSelectedKeyChange}
      inspectorHint={inspectorHint}
      headingLevel={headingLevel}
    />
  );
}
