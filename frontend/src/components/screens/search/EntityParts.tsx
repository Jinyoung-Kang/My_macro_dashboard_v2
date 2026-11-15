"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { EMPTY } from "@/lib/format";
import { entityFailuresText, entityKindLabel, entityShortcuts, entitySourceLabel, identifierChips } from "@/lib/infoSearch";
import type { SearchEntity, SearchEntityKind } from "@/lib/types";
import { KindBadge, KindIcon, LINK, PaneHeading, Tag } from "./parts";

/** 화면에 보이는 별칭 — 이름과 같은 것은 뺍니다. */
function visibleAliases(entity: SearchEntity): string[] {
  return entity.aliases.filter((alias) => alias && alias !== entity.name);
}

/**
 * 대상 머리 — 종류 아이콘·이름·식별자·별칭 꼬리표와 다른 화면 바로가기(종목 상세·기관 상세), 관심 대상 등록 단추(action). 차트·시세는 그리지 않습니다(지시문 §4.2).
 * 대상 풀기 응답이 아직 없거나 풀지 못했으면 키만 보입니다.
 */
export function EntityHeader({
  entityKey,
  entity,
  kind,
  action,
}: {
  entityKey: string;
  entity: SearchEntity | null;
  kind: SearchEntityKind | null;
  /** 머리 오른쪽의 단추(관심 대상 등록·해제). */
  action?: ReactNode;
}) {
  const name = entity?.name ?? entityKey.replace(/^topic:/, "");
  const shortcuts = entity ? entityShortcuts(entity) : [];
  const aliases = entity ? visibleAliases(entity) : [];
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-control border border-border bg-surface-2 text-text-2">
            <KindIcon kind={kind} size={18} />
          </span>
          {/* 이름이 남은 폭을 쓰고 넘치면 말줄임(옆 아이콘·종류 꼬리표는 줄지 않음 — QA-446), 이름 전체는 title. */}
          <h2 className="min-w-0 truncate text-lg font-semibold text-text" title={name}>
            {name}
          </h2>
          <KindBadge kind={kind} />
        </div>
        {entity ? (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {identifierChips(entity).map((chip) => (
              <Tag key={chip}>{chip}</Tag>
            ))}
            {aliases.length > 0 ? <span className="ml-1 text-xs text-text-3">별칭</span> : null}
            {aliases.map((alias) => (
              <Tag key={`alias:${alias}`}>{alias}</Tag>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-text-3">{entityKey}</p>
        )}
      </div>
      {shortcuts.length > 0 || action ? (
        <div className="flex flex-wrap items-start gap-3">
          {shortcuts.length > 0 ? (
            <nav aria-label="바로가기" className="flex flex-wrap gap-3 text-sm">
              {shortcuts.map((shortcut) => (
                <Link key={shortcut.href} href={shortcut.href} className={LINK}>
                  {shortcut.label}
                </Link>
              ))}
            </nav>
          ) : null}
          {action}
        </div>
      ) : null}
    </header>
  );
}

/**
 * 오른쪽 칸(줄을 고르지 않았을 때) — 대상의 속성. 모르는 값은 '—'.
 * aliasEditor(단계 6 묶음 2 — 이 대상이 내 관심 대상일 때의 별칭 편집)를 주면 표 아래에 둡니다. 표의 '별칭' 줄(대상 풀기의 별칭)은 그대로 둡니다 —
 * 결과 검색은 그 별칭에 관심 대상 줄의 별칭을 더해 쓰므로(수집기 with_aliases — 합집합) 편집에서 빼도 쓰이는 별칭을 숨기지 않습니다(편집 칸의 안내).
 * previewHint는 고를 줄이 있을 때만(결과 탭의 결과 목록 — FeedPanel) 줍니다. 그 안내의 미리 보기 자리는 xl부터 이 칸(세 칸의 오른쪽), 그 아래는
 * 화면 아래 시트입니다(FeedPanel 오른쪽 칸의 xl:static·entityGrid의 xl 세 칸과 같은 기준 — QA-420).
 */
export function AttributesPanel({
  entity,
  kind,
  errors,
  aliasEditor = null,
  previewHint = false,
}: {
  entity: SearchEntity | null;
  /** 대상을 풀지 못했을 때 보일 종류 — 확인한 것만(키 앞부분 등, 모르면 null → '—'). 탭을 고르려고 짐작한 종류를 넘기지 않습니다(QA-431). */
  kind: SearchEntityKind | null;
  errors: Record<string, string>;
  aliasEditor?: ReactNode;
  /** 줄을 고르면 미리 보기가 나온다는 안내 — 고를 줄이 있을 때만. */
  previewHint?: boolean;
}) {
  const failures = Object.entries(errors);
  const rows: [string, string][] = entity
    ? [
        ["종류", entityKindLabel(entity.kind)],
        ["한글 이름", entity.nameKo ?? EMPTY],
        ["영문 이름", entity.nameEn ?? EMPTY],
        ["설명", entity.description ?? EMPTY],
        ["식별자", identifierChips(entity).join(" · ") || EMPTY],
        // 법인 식별자(계약 §7-5 — 연결 탭의 GLEIF 모회사·자회사를 찾는 키) — 있을 때만.
        ...(entity.ids.lei ? ([["LEI", entity.ids.lei]] as [string, string][]) : []),
        ["별칭", visibleAliases(entity).join(" · ") || EMPTY],
        // 출처 키를 이름으로 — 모르는 키 여럿이 '기타 출처'로 거듭 잇지 않게 같은 이름은 한 번만(QA-429).
        ["푼 출처", [...new Set(entity.sources.map(entitySourceLabel))].join(" · ") || EMPTY],
      ]
    : [["종류", kind ? entityKindLabel(kind) : EMPTY]];
  return (
    <section aria-labelledby="search-attributes" className="flex flex-col gap-2">
      <PaneHeading id="search-attributes">속성</PaneHeading>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-xs leading-5 text-text-3">{label}</dt>
            <dd className="min-w-0 break-words text-text-2">{value}</dd>
          </div>
        ))}
      </dl>
      {aliasEditor}
      {/* 등록 503 partial 안내와 같은 글 — 사유 안의 ' · '·' — '가 출처 사이 구분과 섞이지 않게 '이름(사유)'를 쉼표로 이음 */}
      {failures.length > 0 ? (
        <p className="text-xs text-text-3">
          대상을 푸는 데 받지 못한 출처 — {entityFailuresText(failures)}
        </p>
      ) : null}
      {previewHint ? (
        <p className="text-xs text-text-3">
          줄을 고르면 <span className="xl:hidden">화면 아래에</span>
          <span className="hidden xl:inline">이 칸에</span> 그 글의 미리 보기가 나옵니다(↑↓로 옮기고 Enter로 원문).
        </p>
      ) : null}
    </section>
  );
}
