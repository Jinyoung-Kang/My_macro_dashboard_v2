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

/**
 * 시각순 목록(작업대 실행 명세 §6 Timeline — 처음 쓰는 곳 국면 판정 기록 P5a, P6 결정 로그(W13)·P7 알림): 기록마다 시각 열·종류 태그·한 줄 요약·배지를
 * 줄로 두고, 줄을 고르면 검사 칸(넓은 화면 옆 15rem)이나 대화상자(좁은 화면·좁은 틀)에 자세한 값(`renderDetail`)을 보입니다.
 *
 * - 목록-검사(`MasterDetail`)를 그대로 씁니다 — j/k·↑↓·Home·End·Esc, roving tabindex, 옆 검사 칸/위쪽 고정 대화상자, `autoSelectFirst`(넓은 화면만),
 *   `selectedKey`·`onSelectedKeyChange`, 빈 목록 `emptyText`, 읽는 중·오류 `placeholder`(Skeleton·ErrorState — 목록 대신), `count`.
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
