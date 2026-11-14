"use client";

import type { ReactNode } from "react";
import { BuildingIcon, LandmarkIcon, PersonIcon, StatusText, TagIcon } from "@/components/ui/icons";
import { entityKindLabel, itemKindLabel, sourceStatusView } from "@/lib/infoSearch";
import type { SearchEntityKind, SearchSourceStatus } from "@/lib/types";

/*
 * 정보 검색 화면(늘 어두운 범위 — globals.css의 [data-scope="search"])의 조각. 조밀한 겉모습: 넓은 화면(lg)에서 글자 14px·보조 12px,
 * 단추·입력 30px, 표 행 28~32px, 모서리 4px(rounded-control — 범위가 4px로 다시 정함), 1px 경계. lg 미만은 누르는 자리 44px.
 * 강조 파랑(accent)은 누를 수 있는 것(링크·주 단추·지금 탭)에만 씁니다(명세 원칙 A1).
 */

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** 조밀한 단추 바탕 — 좁은 화면 44px, 넓은 화면 30px. */
const CONTROL = `inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-control border px-3 text-sm lg:min-h-[30px] lg:px-2.5 motion-safe:transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export const BUTTON = `${CONTROL} border-border bg-surface-2 font-medium text-text hover:border-border-strong`;
export const BUTTON_PRIMARY = `${CONTROL} border-transparent bg-accent font-semibold text-accent-fg hover:bg-accent-hover`;
/** 데이터를 자르는 고르기(기간) — 고른 칸도 강조 파랑이 아니라 중립 바탕·굵은 글, 고대비 모드에서는 테두리(명세 D9). */
export function segmentClass(active: boolean): string {
  return `${CONTROL} tabular-nums ${
    active ? "border-border-strong bg-surface-2 font-semibold text-text" : "border-transparent font-medium text-text-2 hover:bg-surface-2 hover:text-text"
  }`;
}

/** 글 링크(누를 수 있는 것이라 강조 파랑) — 따로 선 링크라 좁은 화면에서도 누르는 자리 44px(ADR 0041 결정 11), 넓은 화면은 글 높이. */
export const LINK = `inline-flex min-h-11 items-center rounded-sm text-accent underline-offset-2 hover:text-accent-hover hover:underline lg:min-h-0 ${FOCUS}`;

/** 면(패널) — 1px 경계, 모서리 4px. */
export const PANEL = "rounded-card border border-border bg-surface";

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

/** 종류 아이콘 + 종류 글(색만으로 가르지 않음). */
export function KindBadge({ kind }: { kind: SearchEntityKind | null | undefined }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-control border border-border px-1.5 py-0.5 text-xs text-text-2">
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

/** 별칭·식별자 꼬리표. */
export function Tag({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-control border border-border bg-surface-2 px-1.5 py-0.5 text-xs text-text-2">{children}</span>;
}

/**
 * 출처 상태 줄(계약 §5) — 출처마다 이름 · 상태 글(아이콘 + 글, 색만이 아님) · 건수 · 거른 건수 · 사유. 실패한 출처를 빈 목록으로 숨기지 않습니다.
 */
export function SourceStatusLine({ sources }: { sources: readonly SearchSourceStatus[] }) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label="출처 상태" className="flex flex-col gap-1 border-t border-border px-3 py-2 text-xs text-text-2 lg:flex-row lg:flex-wrap lg:gap-x-5 lg:gap-y-1">
      {sources.map((source) => {
        const view = sourceStatusView(source);
        return (
          <li key={source.source} className="flex flex-wrap items-baseline gap-x-1.5">
            <span className="font-medium text-text">{view.label}</span>
            <span aria-hidden="true">·</span>
            <StatusText tone={view.tone} iconSize={12}>
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
