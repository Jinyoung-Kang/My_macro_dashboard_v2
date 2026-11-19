"use client";

import type { ReactNode } from "react";
import { BuildingIcon, ClockIcon, LandmarkIcon, LockIcon, PersonIcon, StatusText, TagIcon } from "@/components/ui/icons";
import { entityKindLabel, itemKindLabel, sourceStatusView } from "@/lib/infoSearch";
import type { SearchEntityKind, SearchSourceStatus } from "@/lib/types";

/*
 * 정보 검색 화면(늘 어두운 범위 — globals.css의 [data-scope="search"])의 조각. 조밀한 겉모습: 넓은 화면(lg)에서 글자 14px·보조 12px,
 * 단추·입력 30px, 표 행 28~32px, 모서리 4px(rounded-control — 범위가 4px로 다시 정함), 1px 경계. lg 미만은 누르는 자리 44px.
 * 강조 파랑(accent)은 누를 수 있는 것(링크·주 단추·지금 탭)에만 씁니다(명세 원칙 A1).
 */

/*
 * 조작 조각(단추·기간 고르기·켜고 끄는 단추·글 링크·면)과 꼬리표(Tag)는 공용 키트(components/ui/classes.ts·components/ui)의 이름 그대로 씁니다 —
 * 이 파일이 다시 내보내던 별칭(BUTTON·BUTTON_PRIMARY·LINK·PANEL·segmentClass·toggleClass·Tag)은 정보 검색 정리(작업대 P7)에서 걷었습니다.
 * 여기에는 정보 검색만 쓰는 조각만 남습니다.
 */

/** 작은 글 머리(패널 안 구획 이름). */
export function PaneHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h3 id={id} className="text-xs font-semibold tracking-wide text-text-3">
      {children}
    </h3>
  );
}

/** 대상 종류 아이콘(장식 — 뜻은 옆의 종류 글이 나름). */
export function KindIcon({ kind, size = 16 }: { kind: SearchEntityKind | null | undefined; size?: number }) {
  if (kind === "company") return <BuildingIcon size={size} />;
  if (kind === "institution") return <LandmarkIcon size={size} />;
  if (kind === "person") return <PersonIcon size={size} />;
  return <TagIcon size={size} />;
}

/**
 * 종류 아이콘 + 종류 글(색만으로 가르지 않음). 줄지 않고 한 줄로 둡니다(shrink-0·whitespace-nowrap) — 긴 이름 옆에서 함께 눌리면
 * 한글 종류 글이 음절마다 끊겼습니다(QA-446). 줄어드는 것은 옆의 이름입니다.
 */
export function KindBadge({ kind }: { kind: SearchEntityKind | null | undefined }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-control border border-border px-1.5 py-px align-top text-xs text-text-2">
      <KindIcon kind={kind} size={12} />
      {entityKindLabel(kind)}
    </span>
  );
}

/**
 * 결과 줄의 종류 — 공시·리서치는 테두리 표지로 둬 타임라인에서 뉴스와 갈라 봅니다(글과 테두리로 — 색만이 아니고, 누를 수 없으니 강조 파랑을 쓰지 않음).
 */
export function ItemKindTag({ kind }: { kind: string }) {
  const label = itemKindLabel(kind);
  if (kind !== "filing" && kind !== "research") return <>{label}</>;
  return <span className="inline-flex items-center rounded-control border border-border-strong px-1 leading-4 text-text-2">{label}</span>;
}

/** 상태마다 다른 모양의 아이콘(글과 함께 — 색만으로 가르지 않음). 받는 중은 시계, 운영 서버에서만은 자물쇠, 그 밖은 톤 기본. */
function statusIcon(status: string) {
  if (status === "pending") return <ClockIcon size={12} />;
  if (status === "server_only") return <LockIcon size={12} />;
  return undefined;
}

/**
 * 출처 상태 줄(계약 §5) — 출처마다 이름 · 상태 글(아이콘 + 글, 색만이 아님) · 건수 · 거른 건수 · 사유. 실패한 출처를 빈 목록으로 숨기지 않습니다.
 * pendingStalled = 받는 중 다시 읽기를 멈춘 뒤(계약 §8-6) — 받는 중 글에서 '몇 초 뒤'를 뗍니다.
 */
export function SourceStatusLine({ sources, pendingStalled = false }: { sources: readonly SearchSourceStatus[]; pendingStalled?: boolean }) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label="출처 상태" className="flex flex-col gap-1 border-t border-border px-3 py-2 text-xs text-text-2 lg:flex-row lg:flex-wrap lg:gap-x-5 lg:gap-y-1">
      {sources.map((source) => {
        const view = sourceStatusView(source, { pendingStalled });
        return (
          <li key={source.source} className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-medium text-text">{view.label}</span>
            <span aria-hidden="true">·</span>
            <StatusText tone={view.tone} iconSize={12} icon={statusIcon(source.status)}>
              {view.status}
            </StatusText>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{view.count}</span>
            {view.dropped ? <span className="text-text-3">({view.dropped})</span> : null}
            {view.message ? <span className="text-text-3">— {view.message}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
