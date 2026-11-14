"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ErrorState, Loading } from "@/components/ui";
import { SELECTED_BAR } from "@/components/ui/classes";
import { ChevronDownIcon, ClockIcon, ExternalLinkIcon, RefreshIcon, SpinnerIcon, StatusText, XIcon } from "@/components/ui/icons";
import { ReaderDialog } from "@/components/screens/info/ReaderDialog";
import { useInfoSearchFeed } from "@/hooks/useInfoSearch";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst } from "@/lib/format";
import type { ReaderEntry } from "@/lib/info";
import {
  NO_FILTERS,
  SEARCH_RANGES,
  applyFilters,
  clusterToggleText,
  cutByRange,
  facetCounts,
  feedClusterCount,
  feedEmptyState,
  feedEntryGroups,
  feedPendingText,
  hasFilters,
  httpUrl,
  isDateOnly,
  itemInPeriod,
  itemKindLabel,
  itemTimeText,
  kstToday,
  nextRowIndex,
  otherDateText,
  periodBars,
  rangeCountsOf,
  readerOfFeedItem,
  refreshNoteText,
  rowTimeText,
  sourceLabel,
  type FeedFacet,
  type FeedFilters,
  type PeriodBin,
  type PeriodUnit,
} from "@/lib/infoSearch";
import type { SearchEntity, SearchEntityKind, SearchFeedItem, SearchFeedTab, SearchRange } from "@/lib/types";
import { AttributesPanel } from "./EntityParts";
import { BUTTON, ItemKindTag, LINK, PANEL, PaneHeading, SourceStatusLine, segmentClass } from "./parts";
import { PeriodBars } from "./PeriodBars";

/**
 * 결과 세 칸(넓은 화면) — 왼쪽 거르기(기간·종류·출처·언어, 건수는 받은 자료 기준), 가운데 KST 날짜별 조밀한 목록(시각 · 종류 · 매체 · 제목),
 * 오른쪽 속성·미리 보기, 아래 출처 상태 줄. 좁은 화면은 한 칸 — 거르기는 접는 서랍, 미리 보기는 아래 시트.
 *
 * 결과는 대상·탭마다 한 번(2년 묶음) 받고, 기간은 화면이 자릅니다(다시 부르지 않음). 목록은 ↑↓로 고르고 Enter로 원문을 새 창으로 엽니다.
 * 날짜만 아는 줄(공시 접수일·리포트 날짜 — timeBasis "date", 계약 §7-1)은 시각 칸에 날짜만 두고, 공시·리서치 줄은 종류를 테두리 표지로 둡니다.
 * 수집 글(readerId)의 원문 팝업은 운영자에게만(그 경로가 운영자 전용 — D-1).
 *
 * 왼쪽 칸 맨 위에는 관심 대상 목록(aside — 단계 3, 좁은 화면은 따로 접힘)을 둡니다. '지금 새로 받기'는 캐시를 건너뛰고(refresh=1 — 사용자당
 * 10분에 1번, 넘으면 서버가 캐시를 그대로 주며 한 줄을 붙임) 데모 열람에는 없습니다(외부를 부르지 않는 열람).
 *
 * 받는 중인 출처(pending — 단계 5의 Finviz, 계약 §8-6)가 있으면 목록 위에 그 이름과 함께 한 줄을 두고 훅이 5초마다 다시 읽어 바꿔 끼웁니다
 * (보이던 줄은 그대로). 12번(1분) 뒤에도 받는 중이면 다시 읽기를 멈추고 '받는 중'과 '다시 확인' 단추를 둡니다.
 *
 * 단계 6(계약 §9-1·9-2): 목록 위에 고른 기간의 건수 막대(PeriodBars — 거르기를 거친 줄, 묶기와 상관없이 줄 수)를 두고, 막대를 누르면 그 날·주로
 * 목록을 좁힙니다(기간을 바꾸면 풂). 목록은 기본으로 같은 사건을 묶어(대표 줄 + '같은 사건 n건 · 매체 m곳 — 펼치기' 줄) 보이고 '묶어 보기'
 * 전환으로 모든 줄을 봅니다. 묶음 줄도 목록의 한 줄이라 ↑↓로 지나가고 Enter·누르기로 펼치거나 접습니다(결과 줄의 Enter는 그대로 원문).
 *
 * 단계 6 묶음 2(계약 §9-4): 이 대상이 내 관심 대상이면 속성 칸에 별칭 편집(aliasEditor)을 두고, 저장하면 이 결과를 다시 부릅니다(별칭이 검색어라).
 */
export function FeedPanel({
  entityKey,
  feedTab,
  range,
  owner,
  demo = false,
  entity,
  kind,
  entityErrors,
  onRange,
  aside = null,
  onShown,
  aliasEditor = null,
}: {
  entityKey: string;
  feedTab: SearchFeedTab;
  range: SearchRange;
  owner: boolean;
  demo?: boolean;
  entity: SearchEntity | null;
  kind: SearchEntityKind | null;
  entityErrors: Record<string, string>;
  onRange: (range: SearchRange) => void;
  /** 왼쪽 칸 맨 위(관심 대상 목록). */
  aside?: ReactNode;
  /** 결과(available:true)를 받아 그렸을 때 — 관심 대상의 '봤음'을 실패·받는 중에는 보내지 않게(EntityView). */
  onShown?: () => void;
  /** 속성 칸의 별칭 편집(관심 대상일 때 — EntityView). 인자는 이 결과를 다시 부르는 함수(저장한 뒤). */
  aliasEditor?: ((reloadFeed: () => void) => ReactNode) | null;
}) {
  const feed = useInfoSearchFeed(endpoints.search.feed(entityKey, feedTab), demo ? null : endpoints.search.feed(entityKey, feedTab, true));
  // 별칭을 저장한 뒤 — 저장 전에 나간 같은 결과 읽기(받는 중 다시 읽기 등)에 합류하지 않는 다시 읽기(useInfoSearchFeed).
  const { reloadAfterWrite } = feed;
  const reloadFeed = useCallback(() => void reloadAfterWrite(), [reloadAfterWrite]);
  const now = useMinuteClock();
  const today = now ? kstToday(now.getTime()) : null;
  const data = feed.data;
  const loaded = data?.available === true;
  useEffect(() => {
    if (loaded) onShown?.();
  }, [loaded, onShown]);
  const [filters, setFilters] = useState<FeedFilters>(NO_FILTERS);
  /** 목록에서 고른 줄의 key(결과 줄은 id, 묶음 줄은 'cluster:' + 묶음 id). */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  /** 막대로 좁힌 칸(단위와 시작 날짜) — 기간을 바꾸면 풉니다. */
  const [period, setPeriod] = useState<{ unit: PeriodUnit; start: string } | null>(null);
  const [periodRange, setPeriodRange] = useState(range);
  if (periodRange !== range) {
    setPeriodRange(range);
    setPeriod(null);
  }
  /** 같은 사건 묶어 보기(기본 켬)와 펼친 묶음. */
  const [grouped, setGrouped] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [drawer, setDrawer] = useState(false);
  const [reader, setReader] = useState<ReaderEntry | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const pendingStatusRef = useRef<HTMLParagraphElement>(null);
  // '다시 확인'을 누를 때 그 단추에 포커스가 있었는가 — 읽기가 끝나 단추가 사라지면(받았거나 아직 받는 중이라 다시 12번) 포커스를 같은 자리
  // (받는 중 줄, 그것도 없으면 결과 목록·빈 결과 안내)로 옮깁니다. 키보드·낭독기 사용자가 처음부터 다시 찾지 않게(WCAG 2.4.3).
  const recheckHadFocus = useRef(false);
  // 빈 결과 안내의 '좁히기 풀기'를 눌렀는가 — 안내가 단추째 사라지므로 포커스를 결과 목록(없으면 안내 자리)으로 옮깁니다(WCAG 2.4.3).
  const periodClearedFromEmpty = useRef(false);
  const baseId = useId();
  const optionId = (index: number) => `${baseId}-row-${index}`;
  const drawerId = `${baseId}-filters`;

  useEffect(() => {
    if (feed.rechecking || !recheckHadFocus.current) return;
    recheckHadFocus.current = false;
    if (feed.pendingPhase === "stalled") return; // 받지 못해 단추가 그대로 — 포커스도 단추에 그대로
    (pendingStatusRef.current ?? listRef.current ?? emptyRef.current)?.focus();
  }, [feed.rechecking, feed.pendingPhase]);

  const statuses = useMemo(() => data?.sources ?? [], [data]);
  const pendingText = data?.available ? feedPendingText(feed.pendingPhase, statuses) : null;
  const inRange = useMemo(() => (data ? cutByRange(data, range, today) : []), [data, range, today]);
  const counts = useMemo(() => (data ? rangeCountsOf(data, today) : null), [data, today]);
  const facets = useMemo(() => facetCounts(inRange, statuses), [inRange, statuses]);
  const shown = useMemo(() => applyFilters(inRange, filters), [inRange, filters]);
  // 막대의 오늘은 기간 자르기와 같은 기준(서버의 오늘 → 브라우저 시계의 KST 날짜).
  const barsToday = data?.window?.to ?? today;
  const bars = useMemo(() => periodBars(shown, range, barsToday), [shown, range, barsToday]);
  const activeBin: PeriodBin | null =
    period && period.unit === bars.unit ? (bars.bins.find((bin) => bin.start === period.start) ?? null) : null;
  const narrowed = useMemo(() => (activeBin ? shown.filter((item) => itemInPeriod(item, activeBin)) : shown), [shown, activeBin]);
  const clusterCount = useMemo(() => feedClusterCount(narrowed), [narrowed]);
  const groups = useMemo(() => feedEntryGroups(narrowed, { grouped, expanded, all: data?.items ?? [] }), [narrowed, grouped, expanded, data]);
  const flat = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const selectedIndex = selectedKey === null ? -1 : flat.findIndex((entry) => entry.key === selectedKey);
  const selectedEntry = selectedIndex >= 0 ? flat[selectedIndex] : null;
  const selected = selectedEntry?.type === "item" ? selectedEntry.item : null;

  const select = (index: number) => {
    const entry = flat[index];
    if (!entry) return;
    setSelectedKey(entry.key);
    document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  };

  const toggleCluster = (clusterId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });

  useEffect(() => {
    if (period !== null || !periodClearedFromEmpty.current) return;
    periodClearedFromEmpty.current = false;
    (listRef.current ?? emptyRef.current)?.focus();
  }, [period]);

  const togglePeriod = (bin: PeriodBin) =>
    setPeriod((current) => (current && current.unit === bars.unit && current.start === bin.start ? null : { unit: bars.unit, start: bin.start }));

  const openOriginal = (item: SearchFeedItem | null) => {
    const url = httpUrl(item?.url);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      select(nextRowIndex(selectedIndex, event.key, flat.length));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      select(event.key === "Home" ? 0 : flat.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedEntry?.type === "cluster") toggleCluster(selectedEntry.clusterId);
      else openOriginal(selected);
    } else if (event.key === "Escape" && selectedEntry) {
      event.preventDefault();
      setSelectedKey(null);
    }
  };

  const toggle = (axis: keyof FeedFilters, key: string) =>
    setFilters((current) => ({
      ...current,
      [axis]: current[axis].includes(key) ? current[axis].filter((value) => value !== key) : [...current[axis], key],
    }));

  // ------------------------------------------------------------------ 가운데 칸
  let body: ReactNode;
  if (!data) {
    body = feed.error ? (
      <ErrorState message={feed.error} onRetry={() => void feed.reload()} />
    ) : (
      <Loading label="결과를 모으는 중… (외부 출처를 부르면 몇 초 걸립니다)" />
    );
  } else if (!data.available) {
    body = <p className="px-3 py-6 text-sm text-text-2">{data.message ?? "결과를 받지 못했습니다."}</p>;
  } else {
    const empty = feedEmptyState({
      total: (data.items ?? []).length,
      inRange: inRange.length,
      shown: shown.length,
      narrowed: activeBin ? narrowed.length : undefined,
      counts: counts ?? { "7d": 0, "30d": 0, "1y": 0, "2y": 0 },
      range,
      olderOnlyLatest: data.olderOnlyLatest,
      sources: statuses,
      pendingStalled: feed.pendingPhase === "stalled",
    });
    body = empty ? (
      <div
        ref={emptyRef}
        role="status"
        tabIndex={-1}
        className="flex flex-col items-start gap-2 px-3 py-8 text-sm outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        <p className="font-medium text-text">{empty.message}</p>
        {empty.note ? <p className="text-text-2">{empty.note}</p> : null}
        {empty.caveat ? (
          <StatusText tone="warn" colorText={false} className="text-text-2">
            {empty.caveat}
          </StatusText>
        ) : null}
        {empty.wider.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {empty.wider.map((wider) => (
              <button key={wider.range} type="button" className={BUTTON} onClick={() => onRange(wider.range)}>
                {wider.label}으로 넓히기 ({wider.count}건)
              </button>
            ))}
          </div>
        ) : null}
        {empty.kind === "filtered" ? (
          <button type="button" className={BUTTON} onClick={() => setFilters(NO_FILTERS)}>
            거르기 모두 풀기
          </button>
        ) : null}
        {empty.kind === "period" ? (
          <button
            type="button"
            className={BUTTON}
            onClick={() => {
              periodClearedFromEmpty.current = true;
              setPeriod(null);
            }}
          >
            좁히기 풀기
          </button>
        ) : null}
      </div>
    ) : (
      <div
        ref={listRef}
        role="listbox"
        aria-label="결과"
        tabIndex={0}
        aria-activedescendant={selectedIndex >= 0 ? optionId(selectedIndex) : undefined}
        onKeyDown={onListKeyDown}
        className="outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        {/* 칸 머리(넓은 화면) — 낭독기는 줄마다 글을 읽으므로 장식으로 둡니다. */}
        <div aria-hidden="true" className="hidden grid-cols-[4.5rem_4rem_9rem_minmax(0,1fr)] gap-3 border-b border-border px-3 py-1.5 text-xs text-text-3 lg:grid">
          <span>시각(KST)</span>
          <span>종류</span>
          <span>매체</span>
          <span>제목</span>
        </div>
        {groups.map((group) => {
          const headingId = `${baseId}-date-${group.date || "none"}`;
          const start = flat.indexOf(group.entries[0]);
          return (
            <div key={group.date || "none"} role="group" aria-labelledby={headingId}>
              <div
                id={headingId}
                role="presentation"
                className="sticky top-0 z-10 border-b border-border bg-surface-2 px-3 py-1 text-xs font-semibold text-text-2"
              >
                {group.label}
              </div>
              {group.entries.map((entry, at) => {
                const index = start + at;
                const isSelected = index === selectedIndex;
                const choose = () => {
                  setSelectedKey(entry.key);
                  listRef.current?.focus({ preventScroll: true });
                };
                if (entry.type === "cluster") {
                  // 대표 줄 아래의 묶음 줄 — 누르기·Enter로 펼침/접기(누를 수 있는 것이라 강조 파랑, 상태는 글 '펼치기·접기'와 화살표 모양).
                  return (
                    <div
                      key={entry.key}
                      id={optionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        choose();
                        toggleCluster(entry.clusterId);
                      }}
                      className={`relative flex min-h-11 cursor-pointer items-center gap-1.5 border-b border-border py-1 pl-24 pr-3 text-xs text-accent lg:min-h-7 ${
                        isSelected ? "bg-surface-2" : "hover:bg-surface-2/60"
                      }`}
                    >
                      {isSelected ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
                      <ChevronDownIcon size={12} className={`shrink-0 ${entry.expanded ? "rotate-180" : ""}`} />
                      <span>{clusterToggleText(entry)}</span>
                    </div>
                  );
                }
                const { item, member } = entry;
                const otherDate = member ? otherDateText(item, group.date) : null;
                return (
                  <div
                    key={entry.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    onClick={choose}
                    onDoubleClick={() => openOriginal(item)}
                    className={`relative grid min-h-11 cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 text-sm lg:min-h-8 lg:grid-cols-[4.5rem_4rem_9rem_minmax(0,1fr)] lg:py-1 ${
                      isSelected ? "bg-surface-2" : "hover:bg-surface-2/60"
                    }`}
                  >
                    {isSelected ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
                    {/* 펼친 묶음의 줄 — 왼쪽 안쪽 세로선(모양)과 낭독용 머리말(글)로 대표 줄에 딸린 줄임을 보입니다. */}
                    {member ? <span aria-hidden="true" className="absolute inset-y-0 left-1.5 w-px bg-border-strong forced-colors:border-l" /> : null}
                    <span className={`flex flex-col text-xs tabular-nums text-text-2 ${isDateOnly(item) ? "whitespace-nowrap" : "lg:text-sm"}`}>
                      {otherDate ? <span className="text-xs text-text-3">{otherDate}</span> : null}
                      <span>{rowTimeText(item)}</span>
                      {item.timeBasis === "fetched" ? <span className="text-xs text-text-3">받은 시각</span> : null}
                    </span>
                    <span className="col-start-2 row-start-2 text-xs text-text-3 lg:col-start-auto lg:row-start-auto">
                      <ItemKindTag kind={item.kind} />
                      <span className="lg:hidden"> · {item.publisher ?? EMPTY}</span>
                    </span>
                    <span className="hidden truncate text-xs text-text-2 lg:block">{item.publisher ?? EMPTY}</span>
                    <span className="col-start-2 row-start-1 min-w-0 truncate text-text lg:col-start-auto lg:row-start-auto">
                      {member ? <span className="sr-only">같은 사건의 다른 보도: </span> : null}
                      {item.title}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  }

  // ------------------------------------------------------------------ 왼쪽 칸(거르기)
  const filterPane = (
    <section aria-label="거르기" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <PaneHeading>기간</PaneHeading>
        <div className="flex flex-wrap gap-1">
          {SEARCH_RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={option.key === range}
              onClick={() => onRange(option.key)}
              className={`${segmentClass(option.key === range)} forced-colors:border`}
            >
              {option.label}{" "}
              <span className="text-xs text-text-3">{counts ? `${counts[option.key]}건` : EMPTY}</span>
            </button>
          ))}
        </div>
      </div>
      <FacetGroup title="종류" facets={facets.kind} off={filters.kind} onToggle={(key) => toggle("kind", key)} />
      <FacetGroup title="출처" facets={facets.source} off={filters.source} onToggle={(key) => toggle("source", key)} />
      <FacetGroup title="언어" facets={facets.lang} off={filters.lang} onToggle={(key) => toggle("lang", key)} />
      {hasFilters(filters) ? (
        <button type="button" className={BUTTON} onClick={() => setFilters(NO_FILTERS)}>
          거르기 모두 풀기
        </button>
      ) : null}
      <p className="text-xs leading-5 text-text-3">
        건수는 받은 자료 기준입니다 — 출처마다 한 번에 주는 건수에 상한이 있어 전체 보도량이 아닙니다. 2년보다 오래된 줄·시각을 모르는 줄·중국어
        제목·제외 매체는 서버가 빼고 출처 상태에 건수만 적습니다.
      </p>
    </section>
  );

  // ------------------------------------------------------------------ 오른쪽 칸(속성·미리 보기)
  const rightPane = selected ? (
    <FeedPreview
      item={selected}
      label={sourceLabel(selected.source, statuses)}
      owner={owner}
      onClose={() => setSelectedKey(null)}
      onRead={() => setReader(readerOfFeedItem(selected, sourceLabel(selected.source, statuses)))}
    />
  ) : (
    <AttributesPanel entity={entity} kind={kind} errors={entityErrors} aliasEditor={aliasEditor ? aliasEditor(reloadFeed) : null} />
  );

  return (
    <div className={`${PANEL} flex flex-col`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 lg:hidden">
        <button type="button" className={BUTTON} aria-expanded={drawer} aria-controls={drawerId} onClick={() => setDrawer((value) => !value)}>
          거르기 · 기간 {SEARCH_RANGES.find((option) => option.key === range)?.label}
        </button>
        {data?.fetchedAt ? <span className="text-xs text-text-3">받은 시각 {formatKst(data.fetchedAt)} KST</span> : null}
      </div>
      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)_18rem]">
        <div className="lg:border-r lg:border-border">
          {aside ? <div className="border-b border-border p-3">{aside}</div> : null}
          <div id={drawerId} className={`${drawer ? "block" : "hidden"} border-b border-border p-3 lg:block lg:border-b-0`}>
            {filterPane}
          </div>
        </div>
        <div className="min-w-0">
          {!demo && data?.available ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5">
              <button type="button" className={BUTTON} disabled={feed.refreshing} onClick={() => void feed.refresh()}>
                {feed.refreshing ? <SpinnerIcon size={14} className="motion-safe:animate-spin" /> : <RefreshIcon size={14} />}
                지금 새로 받기
              </button>
              {/* 실패 글도 이 상태 영역 안에 둡니다 — 낭독기가 진행·결과·실패를 같은 자리에서 듣게. */}
              <span role="status" className="text-xs text-text-3">
                {feed.refreshing ? (
                  "새로 받는 중… (외부 출처를 부르면 몇 초 걸립니다)"
                ) : feed.refreshError ? (
                  <StatusText tone="danger" colorText={false} iconSize={12} className="text-xs text-text-2">
                    새로 받지 못했습니다 — {feed.refreshError}
                  </StatusText>
                ) : feed.refreshed ? (
                  refreshNoteText(feed.refreshed)
                ) : (
                  "캐시를 건너뛰고 출처를 다시 부릅니다(10분에 한 번)"
                )}
              </span>
            </div>
          ) : null}
          {pendingText ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-xs text-text-2">
              {/* 다시 읽는 동안·멈춘 뒤·다시 확인의 실패를 같은 상태 영역에 둡니다(낭독기가 한 자리에서 듣게). */}
              <p
                ref={pendingStatusRef}
                role="status"
                tabIndex={-1}
                className="flex items-center gap-2 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {feed.pendingPhase === "polling" || feed.rechecking ? (
                  <SpinnerIcon size={12} className="shrink-0 motion-safe:animate-spin" />
                ) : (
                  <ClockIcon size={12} className="shrink-0" />
                )}
                <span>
                  {pendingText}
                  {feed.recheckError ? ` 다시 확인하지 못했습니다 — ${feed.recheckError}` : ""}
                </span>
              </p>
              {feed.pendingPhase === "stalled" ? (
                // 읽는 동안 disabled로 바꾸지 않습니다(포커스가 body로 떨어짐) — aria-disabled로 알리고 누름은 훅이 한 번만 보냅니다.
                <button
                  type="button"
                  className={`${BUTTON} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
                  aria-disabled={feed.rechecking || undefined}
                  onClick={(event) => {
                    if (feed.rechecking) return;
                    recheckHadFocus.current = document.activeElement === event.currentTarget;
                    void feed.recheck();
                  }}
                >
                  <RefreshIcon size={14} />
                  다시 확인
                </button>
              ) : null}
            </div>
          ) : null}
          {data?.available && shown.length > 0 ? (
            <PeriodBars bars={bars} active={activeBin} onToggle={togglePeriod} onClear={() => setPeriod(null)} />
          ) : null}
          {data?.available && clusterCount > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-xs text-text-3">
              {/* 이름은 '같은 사건 묶어 보기'(바뀌지 않음), 상태는 aria-checked와 보이는 글 켬·끔(색만이 아님). */}
              <button
                type="button"
                role="switch"
                aria-checked={grouped}
                aria-label="같은 사건 묶어 보기"
                onClick={() => setGrouped((value) => !value)}
                className={`${BUTTON} forced-colors:border`}
              >
                같은 사건 묶어 보기 · <span className="font-semibold">{grouped ? "켬" : "끔"}</span>
              </button>
              <span>
                같은 사건 묶음 {clusterCount}개 — 같은 언어의 두 제목의 낱말을 합친 것 가운데 절반 이상이 겹치고(자카드 0.5 이상) 48시간 안인 줄을
                묶음(받은 자료 기준, 기간 건수·막대는 줄 수)
              </span>
            </div>
          ) : null}
          {body}
        </div>
        <div
          className={`${
            selected
              ? "fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 max-h-[50dvh] overflow-y-auto border-t border-border-strong bg-surface shadow-overlay"
              : "border-t border-border"
          } p-3 lg:static lg:z-auto lg:max-h-none lg:overflow-visible lg:border-l lg:border-t-0 lg:shadow-none`}
        >
          <div className="lg:sticky lg:top-0">{rightPane}</div>
        </div>
      </div>
      <SourceStatusLine sources={statuses} pendingStalled={feed.pendingPhase === "stalled"} />
      {data?.fetchedAt ? <p className="hidden px-3 pb-2 text-xs text-text-3 lg:block">받은 시각 {formatKst(data.fetchedAt)} KST · 결과는 15분 동안 다시 씁니다</p> : null}
      {owner ? <ReaderDialog entry={reader} onClose={() => setReader(null)} /> : null}
    </div>
  );
}

/** 거르기 한 묶음 — 값마다 체크 상자(켜면 보임)와 건수. 값이 없으면 그리지 않습니다. */
function FacetGroup({ title, facets, off, onToggle }: { title: string; facets: FeedFacet[]; off: string[]; onToggle: (key: string) => void }) {
  if (facets.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-0.5">
      <legend className="mb-1 text-xs font-semibold tracking-wide text-text-3">{title}</legend>
      {facets.map((facet) => (
        <label key={facet.key} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-control px-1 text-sm text-text-2 hover:bg-surface-2 lg:min-h-7">
          <input
            type="checkbox"
            checked={!off.includes(facet.key)}
            onChange={() => onToggle(facet.key)}
            aria-label={`${facet.label} ${facet.count}건`}
            className="size-4 accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          />
          <span className="min-w-0 flex-1 truncate">{facet.label}</span>
          <span className="tabular-nums text-xs text-text-3">{facet.count}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** 고른 줄의 미리 보기 — 출처가 준 요약·매체·시각과 원문 열기. 본문은 받지 않습니다(D-3). 수집 글은 운영자에게 받아 둔 글 보기. */
function FeedPreview({
  item,
  label,
  owner,
  onClose,
  onRead,
}: {
  item: SearchFeedItem;
  label: string;
  owner: boolean;
  onClose: () => void;
  onRead: () => void;
}) {
  const url = httpUrl(item.url);
  const rows: [string, string][] = [
    isDateOnly(item)
      ? ["날짜", `${itemTimeText(item)} (출처가 날짜만 줌)`]
      : ["시각", `${itemTimeText(item)}${item.timeBasis === "fetched" ? " (받은 시각 — 출처가 작성 시각을 주지 않음)" : ""}`],
    ["매체", [item.publisher, item.publisherDomain].filter(Boolean).join(" · ") || EMPTY],
    ["종류", itemKindLabel(item.kind)],
    ["받은 곳", label],
  ];
  return (
    <section aria-label="미리 보기" className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <PaneHeading>미리 보기</PaneHeading>
        <button
          type="button"
          onClick={onClose}
          aria-label="미리 보기 닫기"
          className="inline-flex size-11 items-center justify-center rounded-control text-text-3 hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:size-7"
        >
          <XIcon size={14} />
        </button>
      </div>
      <p className="text-sm font-semibold leading-snug text-text">{item.title}</p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-text-3">{name}</dt>
            <dd className="min-w-0 break-words text-text-2">{value}</dd>
          </div>
        ))}
      </dl>
      {item.summary ? (
        <p className="whitespace-pre-wrap rounded-control bg-surface-2 p-2 text-sm leading-6 text-text-2">{item.summary}</p>
      ) : (
        <p className="text-xs text-text-3">출처가 준 요약이 없습니다.</p>
      )}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer" className={`${LINK} gap-1`}>
            원문 열기
            <ExternalLinkIcon size={14} />
            <span className="sr-only">(새 창)</span>
          </a>
        ) : (
          <span className="text-xs text-text-3">원문 주소가 없습니다</span>
        )}
        {owner && item.readerId ? (
          <button type="button" className={BUTTON} onClick={onRead}>
            받아 둔 글 보기
          </button>
        ) : null}
      </div>
      <p className="text-xs text-text-3">기사 본문은 받지 않습니다 — 제목·매체·시각·요약만입니다.</p>
    </section>
  );
}
