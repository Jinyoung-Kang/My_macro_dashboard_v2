"use client";

import { useId, useState } from "react";
import { SELECTED_BAR } from "@/components/ui/classes";
import { ChevronDownIcon, StarIcon, StatusText } from "@/components/ui/icons";
import type { InfoSearchWatch } from "@/hooks/useInfoSearchWatch";
import { DEMO_READ_ONLY } from "@/lib/access";
import {
  entityKindLabel,
  findWatch,
  newCountText,
  watchCollectingNote,
  watchKeyOf,
  watchLimitsText,
  watchNewTotal,
} from "@/lib/infoSearch";
import type { SearchEntity, SearchEntityKind } from "@/lib/types";
import { BUTTON, KindIcon, PaneHeading } from "./parts";

/** 관심 대상 목록 스크롤 영역의 높이 상한 — 화면 높이의 40%, 많아야 24rem. */
const LIST_SCROLL = "max-h-[min(40dvh,24rem)] overflow-y-auto";

/**
 * 왼쪽 칸의 관심 대상 목록(ADR 0041 결정 9 — 계약 §6-4): 이름 · 종류 · 마지막으로 본 뒤 새 글 수. 누르면 그 대상을 엽니다.
 * 알림은 이 수뿐입니다(알림함·텔레그램 없음). 정기 수집이 꺼진 곳(로컬·QA)이면 그렇다고 적습니다.
 *
 * collapsible이면 lg 미만에서 접는 서랍(머리 단추로 펼침 — 머리에 개수와 새 글 수 합계), lg 이상은 늘 펼침. 첫 화면은 접지 않습니다.
 * 목록은 제 높이 상한 안에서 스크롤합니다(상한 50개 — 대상 화면의 거르기 칸·첫 화면의 최근 글을 밀어내지 않게). 그 영역은 Tab으로 닿아
 * 키보드로도 스크롤합니다. 영역이 넘침을 자르므로 줄의 포커스 링은 안쪽에 그립니다.
 */
export function WatchPane({
  watch,
  demo,
  currentKey = null,
  collapsible = false,
  onOpen,
}: {
  watch: InfoSearchWatch;
  demo: boolean;
  /** 지금 연 대상의 대표 키(목록에서 표시). */
  currentKey?: string | null;
  collapsible?: boolean;
  onOpen: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const bodyId = useId();
  const data = watch.data;
  const items = data?.available ? (data.items ?? []) : [];

  let body;
  if (demo) {
    body = <p className="text-xs leading-5 text-text-3">{DEMO_READ_ONLY} — 관심 대상은 계정으로 로그인해야 등록합니다.</p>;
  } else if (!data) {
    body = watch.error ? (
      <div className="flex flex-col items-start gap-1.5 text-xs text-text-2">
        <StatusText tone="danger" colorText={false} iconSize={12}>
          관심 대상을 읽지 못했습니다 — {watch.error}
        </StatusText>
        <button type="button" className={BUTTON} onClick={() => void watch.reload()}>
          다시 읽기
        </button>
      </div>
    ) : (
      <p className="text-xs text-text-3">관심 대상을 읽는 중…</p>
    );
  } else if (!data.available) {
    body = <p className="text-xs leading-5 text-text-2">{data.message ?? "관심 대상을 받지 못했습니다."}</p>;
  } else {
    const limits = watchLimitsText(data.limits);
    const note = watchCollectingNote(data.collecting);
    body = (
      <>
        {items.length === 0 ? (
          <p className="text-xs leading-5 text-text-2">등록한 관심 대상이 없습니다 — 대상을 열고 머리의 &lsquo;관심 대상 등록&rsquo;을 누르세요.</p>
        ) : (
          <div
            role="region"
            aria-label="관심 대상 목록 (위아래 스크롤)"
            tabIndex={0}
            className={`-mx-1 rounded-control ${LIST_SCROLL} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus`}
          >
            <ul aria-label="관심 대상 목록" className="flex flex-col">
              {items.map((item) => {
                const count = newCountText(item.newCount);
                const current = item.key === currentKey;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => onOpen(item.key)}
                      aria-current={current ? "true" : undefined}
                      className={`relative flex min-h-11 w-full items-center gap-2 rounded-control px-2 py-1 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus lg:min-h-8 ${
                        current ? "bg-surface-2" : ""
                      }`}
                    >
                      {current ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
                      <span className="text-text-3">
                        <KindIcon kind={item.kind as SearchEntityKind} size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-accent">{item.name}</span>
                        <span className="block text-xs text-text-3">{entityKindLabel(item.kind as SearchEntityKind)}</span>
                      </span>
                      {count ? (
                        <span className="shrink-0 rounded-control border border-border-strong bg-surface-2 px-1.5 py-0.5 text-xs font-semibold tabular-nums text-text">
                          {count}
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {limits ? <p className="text-xs text-text-3">{limits}</p> : null}
        {note ? <p className="text-xs leading-5 text-text-3">{note}</p> : null}
        <p className="text-xs leading-5 text-text-3">새 글 수는 마지막으로 그 대상의 타임라인을 연 뒤 서버가 처음 받은 글입니다.</p>
      </>
    );
  }

  const count = items.length;
  const newTotal = newCountText(watchNewTotal(items));
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      {collapsible ? (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={() => setExpanded((value) => !value)}
            className={`${BUTTON} justify-between lg:hidden`}
          >
            <span id={headingId}>
              관심 대상{count > 0 ? ` ${count}` : ""}
              {newTotal ? ` · ${newTotal}` : ""}
            </span>
            <ChevronDownIcon size={14} className={expanded ? "rotate-180" : ""} />
          </button>
          <div className="hidden lg:block">
            <PaneHeading>관심 대상</PaneHeading>
          </div>
        </>
      ) : (
        <PaneHeading id={headingId}>관심 대상</PaneHeading>
      )}
      <div id={bodyId} className={`${collapsible && !expanded ? "hidden lg:flex" : "flex"} flex-col gap-2`}>
        {body}
      </div>
    </section>
  );
}

/**
 * 대상 머리의 등록·해제 단추(계약 §6-4) — 대표 키로 등록하고(풀린 대상의 key), 해제는 그 줄의 번호로 지웁니다. 상한(409)은 서버가 준 사유를 글로.
 * 데모 열람은 등록하지 못합니다(단추를 끄고 조회만 된다고 적음). 대상을 다 풀기 전에는 대표 키를 몰라 단추를 끕니다.
 */
export function WatchButton({
  watch,
  demo,
  entityKey,
  entity,
  settled,
}: {
  watch: InfoSearchWatch;
  demo: boolean;
  entityKey: string;
  entity: SearchEntity | null;
  /** 대상 풀기 응답(성공·실패)이 왔는가. */
  settled: boolean;
}) {
  const hintId = useId();
  const data = watch.data;
  const items = data?.available ? (data.items ?? []) : [];
  const watched = findWatch(items, entityKey, entity);

  if (demo) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BUTTON} disabled aria-describedby={hintId}>
          <StarIcon size={14} />
          관심 대상 등록
        </button>
        <span id={hintId} className="text-xs text-text-3">
          {DEMO_READ_ONLY}
        </span>
      </div>
    );
  }

  const unavailable = data !== null && !data.available;
  const ready = data !== null && data.available && settled;
  const onClick = () => {
    if (watched) void watch.remove(watched.id);
    else void watch.add(watchKeyOf(entityKey, entity));
  };

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <button type="button" className={BUTTON} disabled={!ready || watch.busy} onClick={onClick}>
        <StarIcon size={14} filled={watched !== null} className={watched ? "text-accent" : ""} />
        {watched ? "관심 대상 해제" : "관심 대상 등록"}
      </button>
      {unavailable ? <p className="text-xs text-text-3">{data?.message ?? "관심 대상을 받지 못했습니다."}</p> : null}
      {watch.actionError ? (
        <p role="alert" className="max-w-xs text-xs leading-5 text-text-2">
          <StatusText tone="warn" colorText={false} iconSize={12}>
            {watch.actionError}
          </StatusText>
        </p>
      ) : null}
    </div>
  );
}
