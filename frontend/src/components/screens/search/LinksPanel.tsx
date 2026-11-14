"use client";

import { ChevronRightIcon } from "@/components/ui/icons";
import { entityKindLabel, linkGroups, linkTarget, type SearchTarget } from "@/lib/infoSearch";
import type { SearchEntity } from "@/lib/types";
import { KindIcon, PaneHeading } from "./parts";

const LINK_SOURCES: Record<string, string> = { wikidata: "Wikidata", "13f": "13F 기관 목록" };

/**
 * 연결 탭 — 대상 풀기 응답의 links를 관계별로(계약 3-3). 누르면 그 대상으로 넘어가고(키가 있으면), 키가 없으면 그 이름으로 다시 풉니다.
 * 단계 2는 Wikidata 관계와 13F 운용자·기관만입니다(임원·내부자·모회사 보강은 단계 4).
 */
export function LinksPanel({ entity, onTarget }: { entity: SearchEntity | null; onTarget: (target: SearchTarget) => void }) {
  if (!entity) return <p className="py-6 text-sm text-text-2">대상을 풀지 못해 연결을 모릅니다.</p>;
  const groups = linkGroups(entity.links);
  if (groups.length === 0) {
    return <p className="py-6 text-sm text-text-2">가진 연결이 없습니다 — 지금은 Wikidata 관계와 13F 운용자·기관만 찾습니다.</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => {
        const headingId = `search-links-${group.relation}`;
        return (
          <section key={group.relation} aria-labelledby={headingId} className="flex flex-col gap-1">
            <PaneHeading id={headingId}>{group.label}</PaneHeading>
            <ul className="divide-y divide-border">
              {group.links.map((link, index) => (
                <li key={`${link.key ?? "name"}:${link.name}:${index}`}>
                  <button
                    type="button"
                    onClick={() => onTarget(linkTarget(link))}
                    className="flex min-h-11 w-full items-center gap-2 rounded-control px-1.5 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:min-h-8"
                  >
                    <span className="text-text-3">
                      <KindIcon kind={link.kind} size={14} />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-accent">{link.name}</span>
                    <span className="shrink-0 text-xs text-text-3">
                      {[link.kind ? entityKindLabel(link.kind) : null, LINK_SOURCES[link.source] ?? link.source, link.key ? null : "이름으로 찾기"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    <ChevronRightIcon size={14} className="text-text-3" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <p className="text-xs text-text-3">받은 자료 기준 — 출처에 적힌 관계만 보입니다(없는 관계를 짐작해 넣지 않음).</p>
    </div>
  );
}
