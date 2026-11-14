"use client";

import { useId, useRef, type KeyboardEvent } from "react";
import { Loading } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { SEARCH_TABS, feedTabOf, kindOfKey, tabFor, tabsFor, type SearchTabKey, type SearchTarget } from "@/lib/infoSearch";
import type { SearchEntityResponse, SearchRange } from "@/lib/types";
import { AttributesPanel, EntityHeader } from "./EntityParts";
import { FeedPanel } from "./FeedPanel";
import { HoldingsPanel } from "./HoldingsPanel";
import { LinksPanel } from "./LinksPanel";
import { PANEL } from "./parts";

const TAB_CLASS =
  "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-sm lg:min-h-[30px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-safe:transition-colors";

/**
 * 대상 하나의 화면 — 머리(종류·이름·식별자·별칭·바로가기), 탭(타임라인·뉴스·글·논평(운영자)·보유(기업·기관)·연결), 탭 내용.
 * 대상 풀기(GET /api/search/entity)와 결과(GET /api/search/feed)는 따로 부릅니다 — 키로 종류를 아는 대상(us:·kr:·cik:·topic:)은 결과를 함께
 * 받기 시작하고, wd: 키는 종류(보유 탭이 있는지)를 안 뒤에 탭을 정합니다. 공시·리서치 탭은 단계 4입니다.
 */
export function EntityView({
  entityKey,
  tab,
  range,
  owner,
  onTab,
  onRange,
  onTarget,
}: {
  entityKey: string;
  tab: SearchTabKey;
  range: SearchRange;
  owner: boolean;
  onTab: (tab: SearchTabKey) => void;
  onRange: (range: SearchRange) => void;
  onTarget: (target: SearchTarget) => void;
}) {
  const resolved = useApi<SearchEntityResponse>(endpoints.search.entity(entityKey));
  const entity = resolved.data?.available ? (resolved.data.entity ?? null) : null;
  const settled = resolved.data !== null || resolved.error !== null;
  // 종류: 풀린 대상 → 키 앞부분 → (wd: 키를 풀지 못했으면) 사람으로 봄(보유 탭 없음).
  const known = entity?.kind ?? kindOfKey(entityKey);
  const kind = known ?? (settled ? "person" : null);
  const tabs = kind ? tabsFor(kind, owner) : [];
  const current = kind ? tabFor(tab, kind, owner) : null;
  const feedTab = current ? feedTabOf(current) : null;
  const errors = resolved.data?.errors ?? {};
  const baseId = useId();
  const tabId = (key: SearchTabKey) => `${baseId}-tab-${key}`;
  const panelId = `${baseId}-panel`;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    // 화살표는 포커스만 옮기고, 탭을 여는 것은 누르기·Enter·Space입니다(탭마다 결과를 부르므로 지나가며 부르지 않게).
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabRefs.current[tabs[next]]?.focus();
  };

  return (
    <div className="flex flex-col gap-3">
      <EntityHeader entityKey={entityKey} entity={entity} kind={known} />
      {resolved.data && !resolved.data.available ? (
        <p className="text-xs text-text-3">{resolved.data.message ?? "대상을 풀지 못했습니다."} 결과는 키로 찾습니다.</p>
      ) : null}
      {resolved.error && !resolved.data ? <p className="text-xs text-text-3">대상을 풀지 못했습니다 — {resolved.error}. 결과는 키로 찾습니다.</p> : null}

      {kind && current ? (
        <>
          <div role="tablist" aria-label="결과 탭" className="flex overflow-x-auto border-b border-border">
            {tabs.map((key, index) => {
              const selected = key === current;
              return (
                <button
                  key={key}
                  ref={(element) => {
                    tabRefs.current[key] = element;
                  }}
                  id={tabId(key)}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelId}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => onTab(key)}
                  onKeyDown={(event) => onTabKeyDown(event, index)}
                  className={`${TAB_CLASS} ${
                    selected ? "border-accent font-semibold text-text" : "border-transparent text-text-2 hover:text-text forced-colors:border-b-0"
                  }`}
                >
                  {SEARCH_TABS.find((entry) => entry.key === key)?.label}
                </button>
              );
            })}
          </div>
          <div id={panelId} role="tabpanel" aria-labelledby={tabId(current)}>
            {feedTab ? (
              <FeedPanel
                key={`${entityKey}:${feedTab}`}
                entityKey={entityKey}
                feedTab={feedTab}
                range={range}
                owner={owner}
                entity={entity}
                kind={kind}
                entityErrors={errors}
                onRange={onRange}
              />
            ) : (
              <div className={`${PANEL} lg:grid lg:grid-cols-[minmax(0,1fr)_18rem]`}>
                <div className="min-w-0 px-3 py-2">
                  {current === "holdings" ? <HoldingsPanel entity={entity} loading={!settled} /> : <LinksPanel entity={entity} onTarget={onTarget} />}
                </div>
                <div className="border-t border-border p-3 lg:border-l lg:border-t-0">
                  <AttributesPanel entity={entity} kind={kind} errors={errors} />
                </div>
              </div>
            )}
          </div>
        </>
      ) : (
        <Loading label="대상을 푸는 중…" />
      )}
    </div>
  );
}
