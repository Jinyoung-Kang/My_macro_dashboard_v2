"use client";

import type { Ref } from "react";
import { ClockIcon, SpinnerIcon, StatusText, XIcon } from "@/components/ui/icons";
import type { SummaryPhase } from "@/hooks/useInfoSearchSummary";
import {
  SUMMARY_LABEL,
  SUMMARY_WAITING_TEXT,
  summaryEmptyText,
  summaryOfflineText,
  summaryLinesOf,
  summaryMetaText,
  summaryNoteText,
  summaryRefs,
} from "@/lib/infoSearch";
import type { SearchFeedItem, SearchSummaryResponse } from "@/lib/types";
import { BUTTON, LINK, Tag } from "./parts";

/*
 * AI 요약(단계 6 묶음 3 — 계약 §9-6, 운영자 전용)의 단추와 패널. 요약은 서버가 받아 둔 줄의 제목·매체·날짜·출처 요약만 보고 만든 것이라
 * 패널 머리에 늘 그렇다고 적고, 줄마다 근거 줄로 가는 단추를 둡니다(원문 확인은 그 줄의 미리 보기에서). 모델이 낸 글은 글로만 그립니다
 * (링크·태그로 바꾸지 않음 — 근거는 받은 자료의 줄 id만 따라감). 요약은 화면에만 있고 저장하지 않습니다(모의 매매 입력 아님).
 */

/**
 * 결과 머리의 '요약' 단추 — 앞서 보낸 요약이 끝나기 전에는(이 기간이든 다른 기간·탭이든 — 서버가 한 번에 하나만 만듦) aria-disabled
 * (포커스가 떨어지지 않게 disabled를 쓰지 않음, 누름은 훅도 한 번만 보냄). 돌이 아이콘은 이 열쇠의 요약을 읽는 중일 때만.
 */
export function SummaryButton({
  loading,
  busy,
  onClick,
  ref,
  className = "",
}: {
  loading: boolean;
  busy: boolean;
  onClick: () => void;
  ref?: Ref<HTMLButtonElement>;
  className?: string;
}) {
  const locked = loading || busy;
  return (
    <button
      ref={ref}
      type="button"
      className={`${BUTTON} aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ${className}`}
      aria-disabled={locked || undefined}
      onClick={() => {
        if (!locked) onClick();
      }}
    >
      {loading ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : null}
      {SUMMARY_LABEL}
    </button>
  );
}

/**
 * 결과 위의 요약 자리. 읽는 중·받음·앞 요약을 기다림은 늘 있는 상태 영역(role=status — 낭독기가 바뀐 글을 듣게, 누르기 전에는 빈 글)에,
 * 실패는 role=alert 글로, 받은 요약은 'AI 요약' 구역으로 둡니다. 서버가 읽은 줄이 없어 요약 줄이 없으면 'AI 요약 … 보고 만든 것' 안내 대신
 * 그 사유만 적습니다(만든 요약이 없음).
 *
 * @param waiting 앞서 다른 기간·탭에서 누른(또는 닫은) 요약이 아직 끝나지 않음 — 단추가 잠긴 까닭을 적음
 * @param items 받은 2년 묶음(근거 줄의 제목을 찾음)
 * @param reachable 지금 목록에서 갈 수 있는 줄 id(기간·거르기·막대 좁히기 안 — 접힌 같은 사건 묶음 포함). 그 밖의 근거는 글로만
 * @param onRef 근거 단추를 눌렀을 때(그 줄을 목록에서 고름)
 */
export function SummaryPanel({
  phase,
  response,
  error,
  waiting,
  items,
  reachable,
  onRef,
  onClose,
}: {
  phase: SummaryPhase;
  response: SearchSummaryResponse | null;
  error: string | null;
  waiting: boolean;
  items: readonly SearchFeedItem[];
  reachable: ReadonlySet<string>;
  onRef: (id: string) => void;
  onClose: () => void;
}) {
  const lines = response ? summaryLinesOf(response) : [];
  const meta = response ? summaryMetaText(response) : null;
  // 요약 줄이 없으면(서버가 읽은 줄 0건 등) 만든 요약이 없으니 'AI 요약 … 보고 만든 것' 대신 그 사유만.
  const empty = response && lines.length === 0 ? summaryEmptyText(response) : null;
  // 받아 둔 결과가 없어 요약에 들지 않은 바깥 출처 — 목록에는 보일 수 있으니 이름을 적음(실패를 '없음'으로 보이지 않게).
  const offline = response ? summaryOfflineText(response) : null;
  // 단추가 잠긴 까닭(앞서 다른 기간·탭에서 누른 요약을 만드는 중) — 이 기간의 요약을 읽는 중이거나 받았으면 그 글이 먼저.
  const waitingShown = waiting && phase !== "loading" && phase !== "done";
  return (
    <>
      <p role="status" className={phase === "loading" || waitingShown ? "flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-text-2" : "sr-only"}>
        {phase === "loading" ? (
          <>
            <SpinnerIcon size={12} className="shrink-0 motion-safe:animate-spin" />
            <span>요약하는 중… (AI를 부르면 몇 초 걸립니다)</span>
          </>
        ) : waitingShown ? (
          <>
            <ClockIcon size={12} className="shrink-0" />
            <span>{SUMMARY_WAITING_TEXT}</span>
          </>
        ) : phase === "done" ? (
          [empty ?? "AI 요약을 받았습니다", offline].filter(Boolean).join(" ")
        ) : null}
      </p>
      {phase === "error" && error ? (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-xs">
          <StatusText tone="danger" colorText={false} iconSize={12} className="min-w-0 break-words text-text-2">
            {error}
          </StatusText>
        </div>
      ) : null}
      {phase === "done" && response ? (
        <section aria-label="AI 요약" className="flex flex-col gap-2 border-b border-border bg-surface-2/40 px-3 py-2">
          <div className="flex items-start justify-between gap-2">
            <p className={empty ? "pt-1 text-sm text-text-2 lg:pt-0.5" : "pt-1 text-xs font-semibold text-text-2 lg:pt-0.5"}>
              {empty ?? summaryNoteText(response.basedOn)}
            </p>
            <button
              type="button"
              onClick={onClose}
              aria-label="요약 닫기"
              className="inline-flex size-11 shrink-0 items-center justify-center rounded-control text-text-3 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:size-7"
            >
              <XIcon size={14} />
            </button>
          </div>
          {offline ? (
            <StatusText tone="warn" colorText={false} iconSize={12} className="min-w-0 break-words text-xs text-text-2">
              {offline}
            </StatusText>
          ) : null}
          {lines.length > 0 ? (
            <ol className="flex flex-col gap-2">
              {lines.map((line, at) => {
                const view = summaryRefs(line.refs, items, reachable);
                return (
                  <li key={at} className="flex min-w-0 flex-col gap-0.5">
                    <p className="break-words text-sm leading-6 text-text">{line.text}</p>
                    {view.refs.length > 0 || view.missing > 0 ? (
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
                        <span className="text-text-3">근거</span>
                        <ul aria-label="근거" className="flex min-w-0 flex-wrap items-center gap-x-3">
                          {view.refs.map((ref) => {
                            const title = ref.title ?? "제목 없는 줄";
                            return (
                              <li key={ref.id} className="flex min-w-0 max-w-full lg:max-w-[22rem]">
                                {ref.reachable ? (
                                  <button type="button" className={`${LINK} min-w-0 max-w-full text-left text-xs`} onClick={() => onRef(ref.id)}>
                                    <span className="min-w-0 truncate">{title}</span>
                                    <span className="sr-only"> — 목록에서 이 줄 고르기</span>
                                  </button>
                                ) : (
                                  // 지금 목록에서 갈 수 없는 줄(거르기·막대 좁히기 밖) — 누를 수 없으니 강조 파랑을 쓰지 않음.
                                  <span className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1 text-text-2 lg:min-h-0">
                                    <span className="min-w-0 truncate">{title}</span>
                                    <span className="shrink-0 text-text-3">(지금 목록에 없음)</span>
                                  </span>
                                )}
                              </li>
                            );
                          })}
                          {view.missing > 0 ? (
                            <li className="inline-flex min-h-11 items-center text-text-3 lg:min-h-0">받은 자료에서 찾지 못한 근거 {view.missing}건</li>
                          ) : null}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
          {meta || response.cached ? (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-3">
              {meta ? <span className="min-w-0 break-words">{meta}</span> : null}
              {response.cached ? <Tag>캐시</Tag> : null}
              {response.cached ? <span>같은 자료로 6시간 안에 만든 요약을 다시 보임</span> : null}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
