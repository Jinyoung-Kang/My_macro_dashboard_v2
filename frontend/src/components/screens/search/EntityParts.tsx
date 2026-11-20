"use client";

import Link from "next/link";
import type { ReactNode } from "react";
// 패턴 배럴(@/components/patterns)이 아니라 파일에서 가져옵니다 — 배럴은 모든 패턴 모듈을 실어 정보 검색 경로의 첫 적재가 커집니다(entityGrid.ts와 같은 까닭).
import { EntityHeader as EntityHeaderPattern, type EntityKindSpec } from "@/components/patterns/EntityHeader";
import { type PropertyItem, PropertyList } from "@/components/patterns/PropertyList";
import { Tag } from "@/components/ui";
import { LINK_CLASSES, TEXT_TARGET } from "@/components/ui/classes";
import { BuildingIcon, LandmarkIcon, PersonIcon, TagIcon } from "@/components/ui/icons";
import { entityFailuresText, entityKindLabel, entityShortcuts, entitySourceLabel, identifierChips, shortcutLabelOfKey } from "@/lib/infoSearch";
import type { SearchEntity, SearchEntityKind } from "@/lib/types";
import { PaneHeading } from "./parts";

/** 화면에 보이는 별칭 — 이름과 같은 것은 뺍니다. */
function visibleAliases(entity: SearchEntity): string[] {
  return entity.aliases.filter((alias) => alias && alias !== entity.name);
}

/** 대상 머리 패턴에 넘기는 종류 — 종류 글(모르면 '대상')과 장식 아이콘(parts KindIcon과 같은 짝). */
function kindSpec(kind: SearchEntityKind | null): EntityKindSpec {
  const icon = kind === "company" ? BuildingIcon : kind === "institution" ? LandmarkIcon : kind === "person" ? PersonIcon : TagIcon;
  return { label: entityKindLabel(kind), icon };
}

/**
 * 대상 머리 — 공용 패턴 EntityHeader(작업대 P8 U2 — 상세 화면 셋과 같은 머리)에 종류(아이콘·종류 태그)·이름(h2)·식별자(고정폭 태그)·별칭 태그와
 * 다른 화면 바로가기(종목 상세·기관 상세)·관심 대상 등록 단추(action)를 넘깁니다. 주 값 줄·배지 줄은 없습니다(차트·시세는 그리지 않음 — 지시문 §4.2).
 * 이름은 말줄임하지 않고 낱말 사이에서 줄을 바꾸며(패턴), 식별자·별칭 태그는 이름과 같은 줄에서 이어집니다. 동작은 넓은 화면(lg 이상) 오른쪽, 좁은
 * 화면은 아래입니다. 대상 풀기 응답이 아직 없거나 풀지 못했으면 이름 자리에 키만 보입니다.
 *
 * 응답 전 자리(QA-930): 키로 바로가기를 아는 대상(lib/infoSearch shortcutLabelOfKey)은 응답이 올 때까지 동작 영역에 바로가기와 같은 꼴의 보이지 않는
 * 자리(낭독·포커스 없음 — 링크를 만들지 않음). 식별자·별칭 태그가 이름 줄을 넘쳐 줄이 느는 몫은 응답 전에 알 수 없어 남습니다.
 */
export function EntityHeader({
  entityKey,
  entity,
  kind,
  settled,
  action,
}: {
  entityKey: string;
  entity: SearchEntity | null;
  kind: SearchEntityKind | null;
  /** 대상 풀기 응답(성공·실패)이 왔는가 — 오기 전에만 바로가기 자리를 잡습니다. */
  settled: boolean;
  /** 머리 오른쪽의 단추(관심 대상 등록·해제). */
  action?: ReactNode;
}) {
  const name = entity?.name ?? entityKey.replace(/^topic:/, "");
  const shortcuts = entity ? entityShortcuts(entity) : [];
  const pendingShortcut = !entity && !settled ? shortcutLabelOfKey(entityKey) : null;
  const aliases = entity ? visibleAliases(entity) : [];
  const hasActions = shortcuts.length > 0 || pendingShortcut !== null || Boolean(action);
  return (
    <EntityHeaderPattern
      kind={kindSpec(kind)}
      name={name}
      headingLevel={2}
      identifiers={entity ? identifierChips(entity) : undefined}
      tags={
        aliases.length > 0 ? (
          <>
            <span className="ml-1 text-xs text-text-3">별칭</span>
            {aliases.map((alias) => (
              <Tag key={`alias:${alias}`}>{alias}</Tag>
            ))}
          </>
        ) : undefined
      }
      actions={
        hasActions ? (
          <>
            {shortcuts.length > 0 ? (
              <nav aria-label="바로가기" className="flex flex-wrap gap-3 text-sm">
                {shortcuts.map((shortcut) => (
                  <Link key={shortcut.href} href={shortcut.href} className={LINK_CLASSES}>
                    {shortcut.label}
                  </Link>
                ))}
              </nav>
            ) : pendingShortcut ? (
              <span aria-hidden="true" className={`invisible ${TEXT_TARGET} text-sm`}>
                {pendingShortcut}
              </span>
            ) : null}
            {action}
          </>
        ) : undefined
      }
    />
  );
}

/**
 * 오른쪽 칸(줄을 고르지 않았을 때) — 대상의 속성(공용 패턴 PropertyList — 작업대 P8 U2, 이름 왼쪽·값 오른쪽, 넓은 화면 줄 32px(상세 화면 셋과 같음)·옅은 구분선,
 * 긴 설명은 이름 아래 블록, 식별자는 고정폭). 모르는 값은 '—'.
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
  // 모르는 값은 null — 속성 목록 패턴이 '—'로 그립니다(0·빈 글을 만들지 않음).
  const items: PropertyItem[] = entity
    ? [
        { label: "종류", value: entityKindLabel(entity.kind) },
        { label: "한글 이름", value: entity.nameKo },
        { label: "영문 이름", value: entity.nameEn },
        { label: "설명", value: entity.description, block: true },
        { label: "식별자", value: identifierChips(entity).join(" · ") || null, mono: true },
        // 법인 식별자(계약 §7-5 — 연결 탭의 GLEIF 모회사·자회사를 찾는 키) — 있을 때만.
        ...(entity.ids.lei ? [{ label: "LEI", value: entity.ids.lei, mono: true }] : []),
        { label: "별칭", value: visibleAliases(entity).join(" · ") || null },
        // 출처 키를 이름으로 — 모르는 키 여럿이 '기타 출처'로 거듭 잇지 않게 같은 이름은 한 번만(QA-429).
        { label: "푼 출처", value: [...new Set(entity.sources.map(entitySourceLabel))].join(" · ") || null },
      ]
    : [{ label: "종류", value: kind ? entityKindLabel(kind) : null }];
  return (
    <section aria-labelledby="search-attributes" className="flex flex-col gap-2">
      <PaneHeading id="search-attributes">속성</PaneHeading>
      <PropertyList items={items} />
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
