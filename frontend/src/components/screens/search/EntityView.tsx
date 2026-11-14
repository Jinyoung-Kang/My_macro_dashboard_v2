"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Loading } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useInfoSearchLinks } from "@/hooks/useInfoSearch";
import type { InfoSearchWatch } from "@/hooks/useInfoSearchWatch";
import { endpoints } from "@/lib/endpoints";
import { formatKst } from "@/lib/format";
import {
  SEARCH_TABS,
  feedTabOf,
  findWatch,
  isListedEntity,
  kindOfKey,
  revealScrollDelta,
  tabFor,
  tabsFor,
  watchKeyOf,
  type SearchTabKey,
  type SearchTarget,
} from "@/lib/infoSearch";
import type { SearchEntityResponse, SearchRange } from "@/lib/types";
import { AttributesPanel, EntityHeader } from "./EntityParts";
import { FeedPanel } from "./FeedPanel";
import { HoldingsPanel } from "./HoldingsPanel";
import { LinksPanel } from "./LinksPanel";
import { PANEL, SourceStatusLine } from "./parts";
import { WatchButton, WatchPane } from "./WatchPane";

/** 대상 풀기 응답에 errors가 없을 때 — 그릴 때마다 새 객체를 만들지 않게(연결 탭 상태의 useMemo 의존값). */
const NO_ERRORS: Readonly<Record<string, string>> = {};

const TAB_CLASS =
  "inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3 text-sm lg:min-h-[30px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-safe:transition-colors";

/**
 * 대상 하나의 화면 — 머리(종류·이름·식별자·별칭·바로가기·관심 대상 등록), 탭(타임라인·뉴스·공시(주제 밖)·리서치(상장 기업)·글·논평(운영자)·
 * 보유(기업·기관)·연결), 탭 내용. 대상 풀기(GET /api/search/entity)와 결과(GET /api/search/feed)는 따로 부릅니다 — 키로 종류를 아는 대상
 * (us:·kr:·cik:·topic:)은 결과를 함께 받기 시작하고, wd: 키는 종류(공시·리서치·보유 탭이 있는지)를 안 뒤에 탭을 정합니다.
 * 연결 탭은 열었을 때만 연결 보강(GET /api/search/links — 내부자 명단·법인 관계, 계약 §7-5)을 부르고 대상 풀기의 links와 합쳐 보이며,
 * 그 출처 상태 줄을 패널 아래에 둡니다.
 *
 * 왼쪽 칸에 내 관심 대상 목록(단계 3)을 두고, 이 대상이 관심 대상이면 타임라인 결과를 받아 그렸을 때 '봤음'(POST /api/search/watch/{id}/seen)을
 * 이 화면에서 한 번만 보냅니다(새 글 수가 0이 됨). 결과를 받지 못했거나 받는 중이면 보내지 않습니다(보지 못한 새 글 수를 지우지 않게).
 * 이 컴포넌트는 대상 키로 다시 그려지므로(SearchScreen의 key) 다른 대상을 열면 다시 보냅니다.
 *
 * 주소의 탭을 이 대상에서 고를 수 없으면(주제 + 공시 등) 타임라인을 보이고 주소의 탭도 바꿔 씁니다(기록에 쌓지 않음) — 종류를 아는 때만
 * (풀린 대상이나 키 앞부분, wd: 키를 풀지 못해 사람으로 짐작한 때는 그대로). 좁은 화면에서 탭 줄이 가로로 넘치면 고른 탭이 보이게 줄을 옮깁니다
 * (주소로 연 탭 포함 — 세로로는 화면을 움직이지 않음).
 */
export function EntityView({
  entityKey,
  tab,
  range,
  owner,
  demo,
  watch,
  onTab,
  onRange,
  onTarget,
  onOpen,
}: {
  entityKey: string;
  tab: SearchTabKey;
  range: SearchRange;
  owner: boolean;
  demo: boolean;
  watch: InfoSearchWatch;
  onTab: (tab: SearchTabKey) => void;
  onRange: (range: SearchRange) => void;
  onTarget: (target: SearchTarget) => void;
  /** 관심 대상 목록에서 다른 대상을 열 때. */
  onOpen: (key: string) => void;
}) {
  const resolved = useApi<SearchEntityResponse>(endpoints.search.entity(entityKey));
  const entity = resolved.data?.available ? (resolved.data.entity ?? null) : null;
  const settled = resolved.data !== null || resolved.error !== null;
  // 종류: 풀린 대상 → 키 앞부분 → (wd: 키를 풀지 못했으면) 사람으로 봄(보유 탭 없음).
  const known = entity?.kind ?? kindOfKey(entityKey);
  const kind = known ?? (settled ? "person" : null);
  const listed = isListedEntity(entityKey, entity);
  const tabs = kind ? tabsFor(kind, owner, listed) : [];
  const current = kind ? tabFor(tab, kind, owner, listed) : null;
  const feedTab = current ? feedTabOf(current) : null;
  const errors = resolved.data?.errors ?? NO_ERRORS;
  const links = useInfoSearchLinks(current === "links" ? entityKey : null, entity, settled, errors);
  const baseId = useId();
  const tabId = (key: SearchTabKey) => `${baseId}-tab-${key}`;
  const panelId = `${baseId}-panel`;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tablistRef = useRef<HTMLDivElement>(null);

  // 주소의 탭을 고를 수 없어 타임라인으로 보였으면 주소도 맞춰 바꿔 씁니다(뒤로 가기에 남지 않게 — onTab은 바꿔 쓰기).
  useEffect(() => {
    if (known !== null && current !== null && current !== tab) onTab(current);
  }, [known, current, tab, onTab]);

  // 고른 탭이 탭 줄 밖(가로)이면 줄을 옮깁니다. scrollIntoView는 세로로 화면 전체를 움직일 수 있어 줄의 가로 스크롤만 바꿉니다.
  const tabsKey = tabs.join(",");
  useEffect(() => {
    const list = tablistRef.current;
    const selected = current ? tabRefs.current[current] : null;
    if (!list || !selected) return;
    const delta = revealScrollDelta(list.getBoundingClientRect(), selected.getBoundingClientRect());
    if (delta !== 0) list.scrollLeft += delta;
  }, [current, tabsKey]);

  // 관심 대상이면 타임라인 결과를 받아 그렸을 때 '봤음' — 이 화면에서 대상마다 한 번(목록을 다시 읽어도 또 보내지 않음).
  const [timelineShown, setTimelineShown] = useState(false);
  const markTimelineShown = useCallback(() => setTimelineShown(true), []);
  const watchItems = watch.data?.available ? (watch.data.items ?? []) : [];
  const watchedId = findWatch(watchItems, entityKey, entity)?.id ?? null;
  const seenSent = useRef<Set<number>>(new Set());
  const { seen, clearActionError } = watch;
  // 앞 대상의 등록 실패 문구(상한 등)를 이 대상의 단추 밑에 남기지 않습니다(대상을 바꾸면 이 컴포넌트가 새로 그려짐).
  useEffect(() => clearActionError(), [clearActionError]);
  useEffect(() => {
    if (current !== "timeline" || !timelineShown || watchedId === null || seenSent.current.has(watchedId)) return;
    seenSent.current.add(watchedId);
    void seen(watchedId);
  }, [current, timelineShown, watchedId, seen]);

  const watchPane = <WatchPane watch={watch} demo={demo} currentKey={watchKeyOf(entityKey, entity)} collapsible onOpen={onOpen} />;

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
      <EntityHeader
        entityKey={entityKey}
        entity={entity}
        kind={known}
        action={<WatchButton watch={watch} demo={demo} entityKey={entityKey} entity={entity} settled={settled} />}
      />
      {resolved.data && !resolved.data.available ? (
        <p className="text-xs text-text-3">{resolved.data.message ?? "대상을 풀지 못했습니다."} 결과는 키로 찾습니다.</p>
      ) : null}
      {resolved.error && !resolved.data ? <p className="text-xs text-text-3">대상을 풀지 못했습니다 — {resolved.error}. 결과는 키로 찾습니다.</p> : null}

      {kind && current ? (
        <>
          <div ref={tablistRef} role="tablist" aria-label="결과 탭" className="flex overflow-x-auto border-b border-border">
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
                demo={demo}
                entity={entity}
                kind={kind}
                entityErrors={errors}
                onRange={onRange}
                aside={watchPane}
                onShown={feedTab === "timeline" ? markTimelineShown : undefined}
              />
            ) : (
              <div className={`${PANEL} flex flex-col`}>
                <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)_18rem]">
                  <div className="border-b border-border p-3 lg:border-b-0 lg:border-r">{watchPane}</div>
                  <div className="min-w-0 px-3 py-2">
                    {current === "holdings" ? (
                      <HoldingsPanel entity={entity} loading={!settled} />
                    ) : (
                      <LinksPanel view={links} onTarget={onTarget} onRetry={() => void links.reload()} />
                    )}
                  </div>
                  <div className="border-t border-border p-3 lg:border-l lg:border-t-0">
                    <AttributesPanel entity={entity} kind={kind} errors={errors} />
                  </div>
                </div>
                {current === "links" ? (
                  <>
                    <SourceStatusLine sources={links.sources} />
                    {links.fetchedAt ? (
                      <p className="hidden px-3 pb-2 text-xs text-text-3 lg:block">받은 시각 {formatKst(links.fetchedAt)} KST</p>
                    ) : null}
                  </>
                ) : null}
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
