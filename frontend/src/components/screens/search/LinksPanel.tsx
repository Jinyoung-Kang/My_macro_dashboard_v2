"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, SpinnerIcon, StatusText } from "@/components/ui/icons";
import { entityKindLabel, linkSourceLabel, linkTarget, type LinksView, type SearchTarget } from "@/lib/infoSearch";
import { LinksGraph } from "./LinksGraph";
import { BUTTON, KindIcon, PaneHeading, segmentClass } from "./parts";

/**
 * 연결 탭 — 대상 풀기 응답의 links(Wikidata 관계·13F 운용자·기관)와 연결 보강(GET /api/search/links — 미국 상장사의 내부자 명단, LEI가 있는 법인의
 * 최상위 모회사·모회사·자회사 — 계약 §7-5)을 합쳐 관계별로 보입니다. 줄마다 한 줄 설명(직위·최근 거래, 소재지·LEI)이 있으면 함께.
 * 누르면 그 대상으로 넘어가고(키가 있으면), 키가 없으면 그 이름으로 다시 풉니다. 보강 경로의 받는 중·실패는 글로 적고(대상 풀기의 연결은 먼저 보임),
 * 출처마다의 상태(건너뜀·실패와 사유)는 패널 아래 출처 상태 줄(EntityView)이 보입니다.
 *
 * 단계 6(계약 §9-3): 연결이 있으면 '목록 | 그림' 전환을 둡니다(기본 목록). 그림은 대상을 가운데 둔 SVG(LinksGraph — 최대 30 노드,
 * 넘으면 '목록에서 n개 더'로 목록으로 — 누른 단추가 그림과 함께 사라지므로 포커스를 '목록' 전환 단추로 옮김). 받는 중·실패·모름 안내는 두 보기 모두
 * 위에 그대로 둡니다.
 */
export function LinksPanel({
  view,
  centerName,
  onTarget,
  onRetry,
}: {
  view: LinksView;
  /** 그림 가운데에 둘 대상 이름(풀기 전이면 키). */
  centerName: string;
  onTarget: (target: SearchTarget) => void;
  onRetry: () => void;
}) {
  const [mode, setMode] = useState<"list" | "graph">("list");
  const listButton = useRef<HTMLButtonElement>(null);
  /** 그림의 '목록에서 n개 더'로 목록으로 왔는가 — 그 단추가 사라지므로 포커스를 '목록' 단추로(WCAG 2.4.3). */
  const focusList = useRef(false);
  useEffect(() => {
    if (mode !== "list" || !focusList.current) return;
    focusList.current = false;
    listButton.current?.focus();
  }, [mode]);
  const hasLinks = view.groups.length > 0;
  const graph = hasLinks && mode === "graph";
  return (
    <div className="flex flex-col gap-4 py-1">
      {hasLinks ? (
        <div role="group" aria-label="연결 보기 방식" className="flex flex-wrap gap-1">
          {(
            [
              ["list", "목록"],
              ["graph", "그림"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              ref={key === "list" ? listButton : undefined}
              type="button"
              aria-pressed={mode === key}
              onClick={() => setMode(key)}
              className={`${segmentClass(mode === key)} forced-colors:border`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {view.extra ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p role="status" className="flex items-center gap-2 text-xs text-text-2">
            {view.extra.state === "loading" ? (
              <>
                <SpinnerIcon size={12} className="motion-safe:animate-spin" />
                {view.extra.text}
              </>
            ) : (
              <StatusText tone="danger" colorText={false} iconSize={12}>
                {view.extra.text}
              </StatusText>
            )}
          </p>
          {view.extra.state === "error" ? (
            <button type="button" className={BUTTON} onClick={onRetry}>
              다시 받기
            </button>
          ) : null}
        </div>
      ) : null}
      {view.entityNote ? <p className="text-xs text-text-3">{view.entityNote}</p> : null}
      {view.empty ? <p className="py-4 text-sm text-text-2">{view.empty}</p> : null}
      {graph ? (
        <LinksGraph
          groups={view.groups}
          centerName={centerName}
          onTarget={onTarget}
          onShowList={() => {
            focusList.current = true;
            setMode("list");
          }}
        />
      ) : null}
      {graph ? null : view.groups.map((group) => {
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
                    className="flex min-h-11 w-full items-center gap-2 rounded-control px-1.5 py-1 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:min-h-8"
                  >
                    <span className="text-text-3">
                      <KindIcon kind={link.kind} size={14} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-accent">{link.name}</span>
                      {link.detail ? <span className="truncate text-xs text-text-2">{link.detail}</span> : null}
                    </span>
                    <span className="shrink-0 text-xs text-text-3">
                      {[link.kind ? entityKindLabel(link.kind) : null, linkSourceLabel(link.source), link.key ? null : "이름으로 찾기"]
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
      <p className={`text-xs leading-5 text-text-3 ${graph ? "hidden" : ""}`}>
        받은 자료 기준 — 출처에 적힌 관계만 보입니다(없는 관계를 짐작해 넣지 않음). 내부자 명단은 Yahoo가 주는 지금의 명단이고, 사람에서 그 사람이 내부자로 있는
        회사로 가는 방향은 아직 찾지 않습니다.
      </p>
    </div>
  );
}
