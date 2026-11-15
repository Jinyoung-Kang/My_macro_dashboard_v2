"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ErrorState, Loading } from "@/components/ui";
import { SELECTED_BAR } from "@/components/ui/classes";
import { ChevronDownIcon, ClockIcon, ExternalLinkIcon, RefreshIcon, SpinnerIcon, StatusText, XIcon } from "@/components/ui/icons";
import { ReaderDialog } from "@/components/screens/info/ReaderDialog";
import { useBottomSheet, type BottomSheetSpace } from "@/hooks/useBottomSheet";
import { useInfoSearchFeed } from "@/hooks/useInfoSearch";
import { useInfoSearchSummary } from "@/hooks/useInfoSearchSummary";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatKst } from "@/lib/format";
import type { ReaderEntry } from "@/lib/info";
import {
  NO_FILTERS,
  SEARCH_RANGES,
  applyFilters,
  clusterSizeText,
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
  publisherLabel,
  rangeCountsOf,
  readerOfFeedItem,
  refreshNoteText,
  rowTimeText,
  sourceLabel,
  type FeedClusterEntry,
  type FeedEntry,
  type FeedFacet,
  type FeedFilters,
  type PeriodBin,
  type PeriodUnit,
} from "@/lib/infoSearch";
import type { SearchEntity, SearchEntityKind, SearchFeedItem, SearchFeedTab, SearchRange } from "@/lib/types";
import { AttributesPanel } from "./EntityParts";
import { ENTITY_GRID, ENTITY_LEFT } from "./entityGrid";
import { BUTTON, ItemKindTag, LINK, PANEL, PaneHeading, SourceStatusLine, segmentClass } from "./parts";
import { PeriodBars } from "./PeriodBars";
import { SummaryButton, SummaryPanel } from "./SummaryPanel";

/**
 * 결과 세 칸(넓은 화면) — 왼쪽 거르기(기간·종류·출처·언어, 건수는 받은 자료 기준), 가운데 KST 날짜별 조밀한 목록(시각 · 종류 · 매체 · 제목),
 * 오른쪽 속성·미리 보기, 아래 출처 상태 줄. 좁은 화면은 한 칸 — 거르기는 접는 서랍, 미리 보기는 아래 시트. 세 칸은 xl(1280) 이상이고,
 * lg(1024~1279)는 두 칸(왼쪽 · 가운데 — 속성은 가운데 아래, 미리 보기는 아래 시트)입니다(entityGrid — QA-420).
 * 아래 시트가 열려 있으면 그 높이를 재서(useBottomSheet) 결과 아래에 같은 여백을 두고(끝 줄·출처 상태 줄이 시트 위로 올라오게), 스크롤 여백
 * (globals.css의 --bottom-sheet)으로 ↑↓·End로 고른 줄이 시트 밑에 숨지 않게 하며, 시트가 열리거나 높이가 바뀌어 고른 줄을 덮으면 그 줄을 시트 위로 옮깁니다.
 * 열린 동안 창 폭이 바뀌어(휴대폰을 돌림) 고른 줄이 화면 위나 시트 아래로 밀려나도 옮깁니다(QA-447 — 높이만 바뀐 때는 덮을 때만).
 * 열린 동안 시트는 줄지 않습니다(sheetStyle — 닫으면 처음 높이부터).
 * 넓은 화면(lg)에서는 시트가 본문의 스크롤 막대를 덮지 않게 그 폭만큼 오른쪽을 비웁니다.
 *
 * 결과는 대상·탭마다 한 번(2년 묶음) 받고, 기간은 화면이 자릅니다(다시 부르지 않음). 목록은 ↑↓로 고르고 Enter로 원문을 새 창으로 엽니다
 * (마우스로는 줄을 두 번 눌러도 — 터치·펜으로 빠르게 두 번 누른 것은 열지 않음).
 * Escape는 목록에서든 미리 보기(아래 시트·xl 오른쪽 칸) 안에서든 미리 보기를 닫고 포커스를 결과 목록에 둡니다(닫기 단추와 같은 자리).
 * 닫은 뒤의 ↑↓는 닫기 전에 고른 줄의 앞·다음 줄로 이어 갑니다(목록이 바뀌면 처음부터 — Home·End는 늘 양 끝).
 * 날짜만 아는 줄(공시 접수일·리포트 날짜·거장 견해 기준일 — timeBasis "date", 계약 §7-1)은 시각 칸에 날짜만 두고, 공시·리서치 줄은 종류를 테두리 표지로 둡니다.
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
 * 묶음 줄을 ↑↓·Home·End로 고르면 미리 보기 자리(xl 미만은 아래 시트)에 그 묶음(건수·매체 수, 펼치는 법, 대표 줄, 다른 보도)을 보입니다 — ↑↓로
 * 지나갈 때 시트가 닫혔다 열리며 화면 아래가 깜빡이지 않게. 묶음 미리 보기는 결과 줄의 미리 보기보다 대개 높아(1024에서 약 343px 대 240~265px)
 * 지날 때 시트가 커지지만, 열린 동안 줄지는 않으므로(sheetStyle) 다음 줄로 옮길 때 본문 높이가 줄어 고른 줄이 움직이지 않습니다.
 * 누르기(터치·마우스)로 고른 묶음 줄은 펼치기·접기만 하고 미리 보기를 열지 않습니다(열려 있던 미리 보기는 닫힘) — 누르기의 목적은 펼친 줄을 보는
 * 것인데, 열린 시트가 누른 줄을 시트 위로 옮기면 바로 밑에 펼친 줄이 시트에 덮였습니다. 고른 줄은 남아 ↑↓가 거기서 이어 갑니다.
 *
 * 단계 6 묶음 2(계약 §9-4): 이 대상이 내 관심 대상이면 속성 칸에 별칭 편집(aliasEditor)을 두고, 저장하면 이 결과를 다시 부릅니다(별칭이 검색어라).
 *
 * 단계 6 묶음 3(계약 §9-6): 운영자에게는 결과 머리에 '요약' 단추(데모·회원에게는 없음, 고른 기간에 받은 줄이 없으면 없음)를 두고, 누르면 이 대상·탭·기간의
 * AI 요약을 결과 위 패널(SummaryPanel)에 보입니다. 줄마다 근거 줄로 가는 단추는 그 줄을 목록에서 고르고(접힌 같은 사건 묶음이면 펼침), 지금 목록에서
 * 갈 수 없는 줄(거르기·막대 좁히기 밖)은 글로만 둡니다. 기간을 바꾸면 패널을 비웁니다(대상·탭을 바꾸면 이 컴포넌트가 새로 그려짐). 서버는 요약을
 * 한 번에 하나만 만들므로(겹치면 429), 앞서 누른 요약이 끝나기 전에는 기간·탭을 바꿔도 단추를 잠그고 그 까닭을 적습니다(훅이 모듈에 기억 —
 * 읽는 중인 기간·탭으로 돌아오면 읽는 중으로 보이고 그 응답을 받음).
 */
/** 시트가 열려 있을 때 시트 위로 올라간 TOP 단추(ScrollTopButton)가 차지하는 띠 — lg 미만 16 + 44, lg 이상 24 + 34px를 덮는 64px.
 *  globals.css의 스크롤 여백(min(--bottom-sheet, 64px))과 같은 값이어야 합니다(QA-420 후속). */
const SHEET_TOP_BUTTON_BAND = 64;

/**
 * 고른 줄이 보이는 자리 밖에 걸쳤는가(QA-447) — 보이는 자리는 스크롤 상자의 위끝(lg 이상은 본문 main, 그 밑은 창 위끝 — 본문이 창 위로
 * 올라가 있으면 창 위끝)에서 줄의 scroll-margin-top(붙는 날짜 머리 자리 — scroll-mt-7, QA-435)만큼 아래부터 bottom(시트 위 TOP 단추 띠의
 * 위끝)까지입니다. nearest로 옮기면 줄이 멈추는 자리와 같은 경계입니다(아래는 스크롤 여백 — globals.css).
 */
function rowOutsideView(row: Element, box: DOMRect, bottom: number): boolean {
  const scrollerTop = Math.max(0, document.getElementById("main")?.getBoundingClientRect().top ?? 0);
  const margin = Number.parseFloat(window.getComputedStyle(row).scrollMarginTop) || 0;
  return box.top < scrollerTop + margin || box.bottom > bottom;
}

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
  /** 속성 칸에 보일 종류 — 확인한 것만(모르면 null). 탭을 고르려고 짐작한 종류는 넘기지 않습니다(QA-431). */
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
  /** 누르기로 고른 묶음 줄의 key — 그 줄은 미리 보기를 열지 않습니다. 키보드로 고르면(select) 지웁니다. */
  const [pointerCluster, setPointerCluster] = useState<string | null>(null);
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
  // 결과 목록을 마지막으로 누른 포인터의 종류(pointerdown) — 줄을 두 번 눌러 원문 열기는 마우스 단축 동작이라 터치·펜이면 하지 않습니다. 휴대폰에서
  // 줄을 빠르게 두 번 누르면 브라우저가 dblclick을 내 뜻하지 않게 원문 새 창이 열렸습니다(QA 스택 기록 R3-SG3-4). Enter는 입력 장치와 상관없이 엶.
  const lastPointer = useRef("");
  const emptyRef = useRef<HTMLDivElement>(null);
  const pendingStatusRef = useRef<HTMLParagraphElement>(null);
  // '다시 확인'을 누를 때 그 단추에 포커스가 있었는가 — 읽기가 끝나 단추가 사라지면(받았거나 아직 받는 중이라 다시 12번) 포커스를 같은 자리
  // (받는 중 줄, 그것도 없으면 결과 목록·빈 결과 안내)로 옮깁니다. 키보드·낭독기 사용자가 처음부터 다시 찾지 않게(WCAG 2.4.3).
  const recheckHadFocus = useRef(false);
  // 빈 결과 안내의 '좁히기 풀기'를 눌렀는가 — 안내가 단추째 사라지므로 포커스를 결과 목록(없으면 안내 자리)으로 옮깁니다(WCAG 2.4.3).
  const periodClearedFromEmpty = useRef(false);
  // '거르기 모두 풀기'를 누른 자리 — 단추가 사라지므로(빈 결과 안내는 결과 목록으로 바뀌고, 거르기 칸의 단추는 거른 것이 없어져 빠짐) 포커스를
  // 빈 결과 안내에서는 결과 목록(없으면 안내 자리)으로, 거르기 칸에서는 그 칸의 첫 체크 상자(없으면 지금 기간 단추)로 옮깁니다(WCAG 2.4.3 — QA-434).
  const filtersClearedFrom = useRef<"empty" | "pane" | null>(null);
  const filterPaneRef = useRef<HTMLElement>(null);
  const baseId = useId();
  const optionId = (index: number) => `${baseId}-row-${index}`;
  const drawerId = `${baseId}-filters`;
  // AI 요약(운영자만 — 계약 §9-6). 데모 열람에는 두지 않습니다(서버도 403).
  const summaryAllowed = owner && !demo;
  const summary = useInfoSearchSummary(summaryAllowed ? { e: entityKey, tab: feedTab, range } : null);
  const summaryButtonRef = useRef<HTMLButtonElement>(null);
  // 근거 단추로 접힌 묶음을 펼쳤을 때 — 펼친 줄이 그려진 뒤 그 줄로 옮기고 포커스를 목록에 둡니다.
  const revealPending = useRef<string | null>(null);
  // 미리 보기를 닫을 때 고른 줄과 그때의 목록(flat) — 닫으면 고른 줄이 풀려(aria-activedescendant 없음) ↓가 첫 줄로 돌아갔습니다. 같은 목록일
  // 때만 그 줄에서 이어 가고, 목록이 바뀌면(거르기·기간·막대 좁히기·묶어 보기·펼침·받은 자료) 버립니다(flat이 새로 만들어짐).
  const closedAt = useRef<{ key: string; flat: readonly FeedEntry[] } | null>(null);

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
  /** 미리 보기가 열려 있는가 — 고른 결과 줄, 또는 키보드로 고른 묶음 줄(묶음 미리 보기). 누르기로 고른 묶음 줄은 펼치기만. */
  const previewOpen = selectedEntry !== null && !(selectedEntry.type === "cluster" && selectedEntry.key === pointerCluster);
  /** 요약의 근거 단추로 갈 수 있는 줄 — 기간·거르기·막대 좁히기를 거친 줄(접힌 같은 사건 묶음의 줄 포함 — 누르면 펼침). */
  const reachableIds = useMemo(() => new Set(narrowed.map((item) => item.id)), [narrowed]);
  /** 오른쪽 칸 — xl 미만에서 줄을 고르면 아래 시트(고정)가 됩니다. 시트의 높이·본문 스크롤 막대 폭(QA-420 검토). */
  const sheetRef = useRef<HTMLDivElement>(null);
  const sheet = useBottomSheet(sheetRef, previewOpen);

  // 시트가 열리거나 높이가 바뀌어 고른 줄을 덮으면 그 줄을 시트 위로 옮깁니다(스크롤 여백을 따름 — nearest). 처음 고른 줄은 시트가 열리기
  // 전에 옮겨졌고, 누른 줄은 열린 시트에 덮일 수 있습니다. 덮지 않았으면(사용자가 다른 곳으로 스크롤한 뒤 휴대폰 주소 막대로 시트 높이가
  // 바뀐 때 등) 옮기지 않고, 거르기·막대로 목록이 바뀔 때도 옮기지 않습니다(왼쪽 칸에서 고르는 중일 수 있음).
  // 다만 열린 동안 창 폭이 바뀌면(휴대폰을 돌림·창 폭 조절) 줄 바꿈이 달라져 고른 줄이 화면 위나 시트 아래로 밀려나므로 — 사용자가 스크롤한
  // 것이 아니라 배치가 바뀐 것 — 그 줄이 보이는 자리(rowOutsideView) 밖에 걸쳤으면 옮깁니다(QA-447). 높이만 바뀐 때는 위 규칙 그대로입니다.
  const sheetWidth = useRef(0);
  useEffect(() => {
    // 열린 동안의 폭끼리만 견줍니다 — 닫히면 0이라 다시 열 때는 바뀐 것으로 보지 않음(그때는 덮는지만).
    const widthChanged = sheetWidth.current > 0 && sheet.width > 0 && sheet.width !== sheetWidth.current;
    sheetWidth.current = sheet.width;
    const row = listRef.current?.querySelector('[role="option"][aria-selected="true"]');
    const pane = sheetRef.current;
    if (sheet.height <= 0 || !row || !pane) return;
    const box = row.getBoundingClientRect();
    const top = pane.getBoundingClientRect().top;
    // 시트 위로 올라간 TOP 단추 자리(SHEET_TOP_BUTTON_BAND)에 걸친 줄도 옮깁니다 — 스크롤 여백도 그만큼 더 두므로 nearest가 단추 위에 멈춥니다(QA-420 후속).
    const band = Math.min(sheet.height, SHEET_TOP_BUTTON_BAND);
    const covered = box.bottom > top - band && box.top < top + sheet.height;
    if (covered || (widthChanged && rowOutsideView(row, box, top - band))) row.scrollIntoView({ block: "nearest" });
  }, [sheet.height, sheet.width]);

  const select = (index: number) => {
    const entry = flat[index];
    if (!entry) return;
    setSelectedKey(entry.key);
    setPointerCluster(null);
    document.getElementById(optionId(index))?.scrollIntoView({ block: "nearest" });
  };

  /** 요약의 근거 단추 — 그 줄을 목록에서 고르고 포커스를 목록에 둡니다(↑↓로 이어 감). 접힌 같은 사건 묶음의 줄이면 펼친 뒤에. */
  const revealRow = (id: string) => {
    const index = flat.findIndex((entry) => entry.type === "item" && entry.key === id);
    if (index >= 0) {
      select(index);
      listRef.current?.focus({ preventScroll: true });
      return;
    }
    const clusterId = narrowed.find((item) => item.id === id)?.clusterId;
    if (!clusterId) return;
    revealPending.current = id;
    setExpanded((current) => new Set(current).add(clusterId));
    setSelectedKey(id);
  };

  useEffect(() => {
    const id = revealPending.current;
    if (id === null) return;
    const index = flat.findIndex((entry) => entry.key === id);
    if (index < 0) return;
    revealPending.current = null;
    document.getElementById(`${baseId}-row-${index}`)?.scrollIntoView({ block: "nearest" });
    listRef.current?.focus({ preventScroll: true });
  }, [flat, baseId]);

  const closeSummary = () => {
    summary.clear();
    summaryButtonRef.current?.focus();
  };

  // 미리 보기의 '닫기' — 단추가 미리 보기째 사라지므로 포커스를 고른 줄이 있던 결과 목록(Escape로 닫을 때와 같은 자리)으로 옮깁니다(WCAG 2.4.3).
  // 미리 보기는 목록의 줄을 골랐을 때만 그려지므로 목록이 있습니다. 아래 시트가 닫히며 페이지가 튀지 않게 preventScroll(QA-430).
  // 닫기 단추·목록의 Escape·미리 보기 안의 Escape가 모두 이 길로 닫습니다 — 닫기 전 줄을 기억해 다음 ↑↓가 그 줄에서 이어 가게.
  const closePreview = () => {
    if (selectedKey !== null) closedAt.current = { key: selectedKey, flat };
    setSelectedKey(null);
    listRef.current?.focus({ preventScroll: true });
  };

  /** 고른 줄이 없을 때 ↑↓가 이어 갈 줄 — 같은 목록에서 미리 보기를 닫기 전에 고른 줄, 없으면 -1(첫 줄부터). */
  const resumeIndex = () => {
    const closed = closedAt.current;
    return closed !== null && closed.flat === flat ? flat.findIndex((entry) => entry.key === closed.key) : -1;
  };

  // 미리 보기 안(아래 시트·xl 오른쪽 칸 — '원문 열기'·'받아 둔 글 보기'·닫기 단추)에 포커스가 있을 때의 Escape — 목록에서처럼 닫고 포커스를 결과
  // 목록으로(닫기 단추와 같은 자리). 원문 팝업(ReaderDialog — Radix 대화상자)의 키가 지금 이 영역의 onKeyDown에 오지 않는 것은 팝업이 React
  // 트리에서 이 영역 밖(FeedPanel 루트의 자식)에 그려지기 때문입니다 — DOM에서 body 끝에 그려져서가 아닙니다. React 합성 이벤트는 포털 안에서 나도
  // DOM이 아니라 React 트리를 따라 올라가므로, 팝업을 미리 보기 안으로 옮기면 그 안의 Escape가 이 영역까지 옵니다. 그때는 아래 두 가드가 막습니다
  // — Radix가 Escape를 문서 캡처 단계에서 먼저 받아 preventDefault한 뒤 팝업을 닫으므로 이미 처리된 Escape를 건너뛰고(defaultPrevented), 팝업이
  // 열려 있는 동안도 건너뜁니다(reader). 한 번의 Escape가 팝업과 미리 보기를 함께 닫지 않게(팝업이 닫히면 포커스는 '받아 둔 글 보기'로 돌아오고
  // 다음 Escape가 미리 보기를 닫음).
  const onPreviewKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented || reader !== null) return;
    event.preventDefault();
    closePreview();
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

  const clearFilters = (from: "empty" | "pane") => {
    filtersClearedFrom.current = from;
    setFilters(NO_FILTERS);
  };

  // 거르기를 모두 푼 그림이 그려진 뒤에 옮깁니다. 거르기 칸에서는 기간 단추가 체크 상자보다 앞에 있으므로 체크 상자를 먼저 따로 찾습니다.
  useEffect(() => {
    const from = filtersClearedFrom.current;
    if (from === null || filters !== NO_FILTERS) return;
    filtersClearedFrom.current = null;
    if (from === "empty") {
      (listRef.current ?? emptyRef.current)?.focus();
      return;
    }
    const pane = filterPaneRef.current;
    (pane?.querySelector<HTMLElement>('input[type="checkbox"]') ?? pane?.querySelector<HTMLElement>('button[aria-pressed="true"]'))?.focus();
  }, [filters]);

  const togglePeriod = (bin: PeriodBin) =>
    setPeriod((current) => (current && current.unit === bars.unit && current.start === bin.start ? null : { unit: bars.unit, start: bin.start }));

  const openOriginal = (item: SearchFeedItem | null) => {
    const url = httpUrl(item?.url);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      select(nextRowIndex(selectedIndex >= 0 ? selectedIndex : resumeIndex(), event.key, flat.length));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      select(event.key === "Home" ? 0 : flat.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (selectedEntry?.type === "cluster") toggleCluster(selectedEntry.clusterId);
      else openOriginal(selected);
    } else if (event.key === "Escape" && selectedEntry) {
      event.preventDefault();
      closePreview();
    }
  };

  const toggle = (axis: keyof FeedFilters, key: string) =>
    setFilters((current) => ({
      ...current,
      [axis]: current[axis].includes(key) ? current[axis].filter((value) => value !== key) : [...current[axis], key],
    }));

  // ------------------------------------------------------------------ 가운데 칸
  let body: ReactNode;
  /** 고를 줄이 있는가(결과 목록을 그림) — 속성 칸의 미리 보기 안내는 이때만 둡니다(빈 결과·받는 중·실패에는 고를 줄이 없음). */
  let selectable = false;
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
    selectable = empty === null;
    // 코드가 포커스를 보내는 자리(빈 결과 안내·결과 목록·목록 위 받는 중 줄)에는 outline-none을 붙이지 않습니다 — Tailwind v4의 outline-none은
    // --tw-outline-style까지 none으로 둬 focus-visible:outline-2가 선을 그리지 못합니다(QA-433). 브라우저 기본 테두리도 :focus-visible에서만
    // 그려지고 이 클래스가 덮으므로, 마우스로 눌러 옮긴 포커스에는 테두리가 없습니다(같은 화면 단추의 FOCUS와 같은 모양).
    // 결과 목록만 테두리를 상자 바깥(offset 0)에 그립니다. 안쪽(-outline-offset-2)이면 위치를 가진 자식(sticky 날짜 머리 z-10·고른 줄 relative,
    // 둘 다 불투명 바탕)이 목록의 테두리보다 나중에 칠해져 날짜 머리·고른 줄마다 좌우 변이 끊기고, 칸 머리가 없는 좁은 목록에서는 첫 자식이 날짜
    // 머리라 윗변이 보이지 않았습니다. 바깥 2px는 이웃의 경계선(위 줄 border-b, lg 이상 왼쪽 칸 border-r·xl 오른쪽 칸 border-l) 위에 겹쳐 그려집니다.
    // 뒤에 오는 xl 오른쪽 칸(불투명 바탕)은 위치가 없어도 목록보다 나중에 칠해져 오른쪽 변을 덮으므로, :focus-visible일 때만 목록을 위치를 가진
    // 층(relative z-10)으로 올립니다(QA-433 후속). z-10은 아래 시트(z-30)·TOP 단추(z-20)·하단 탭 바(z-40)보다 낮아 그것들을 덮지 않습니다.
    body = empty ? (
      <div
        ref={emptyRef}
        role="status"
        tabIndex={-1}
        className="flex flex-col items-start gap-2 px-3 py-8 text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
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
          <button type="button" className={BUTTON} onClick={() => clearFilters("empty")}>
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
        onPointerDown={(event) => {
          lastPointer.current = event.pointerType;
        }}
        className="@container focus-visible:relative focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-focus"
      >
        {/* 줄의 배치는 창 폭이 아니라 이 목록의 폭(@container)으로 정합니다. 36rem(@xl, 576px) 이상이면 네 칸(시각 · 종류 · 매체 · 제목 — 제목 칸
            236px 이상)과 칸 머리, 그 밑은 두 칸(시각 · 제목 두 줄까지 + 그 밑 종류 · 매체 줄)입니다. 창 폭으로 가르면 xl 1280의 가운데 칸(429px)에서
            제목 칸이 89px, lg 1024(461px)에서 121px로 줄어 앞머리가 같은 제목을 가를 수 없었습니다. 목록 폭은 lg 1024~약 1138·xl 1280~약 1426에서
            576px 미만입니다(entityGrid). 누르는 자리(lg 미만 44px)는 입력 장치를 따르므로 창 폭(lg:) 그대로입니다.
            칸 머리 — 낭독기는 줄마다 글을 읽으므로 장식으로 둡니다. */}
        <div aria-hidden="true" className="hidden grid-cols-[4.5rem_4rem_9rem_minmax(0,1fr)] gap-3 border-b border-border px-3 py-1.5 text-xs text-text-3 @xl:grid">
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
                // 줄마다 scroll-mt-7(28px — 붙어 있는 날짜 머리 약 25px보다 큼): ↑↓로 고른 줄을 scrollIntoView(block nearest)로 옮길 때
                // 날짜 머리 밑이 아니라 그 아래에 멈추게 합니다(QA-435). 날짜 머리가 붙지 않는 좁은 화면(창이 스크롤)에서는 위 여백 28px만 더해집니다.
                if (entry.type === "cluster") {
                  // 대표 줄 아래의 묶음 줄 — 누르기·Enter로 펼침/접기(누를 수 있는 것이라 강조 파랑, 상태는 글 '펼치기·접기'와 화살표 모양).
                  // 누르면 고르되 미리 보기는 열지 않습니다(pointerCluster — 아래 시트가 펼친 줄을 덮지 않게).
                  return (
                    <div
                      key={entry.key}
                      id={optionId(index)}
                      role="option"
                      aria-selected={isSelected}
                      onClick={() => {
                        choose();
                        setPointerCluster(entry.key);
                        toggleCluster(entry.clusterId);
                      }}
                      className={`relative flex min-h-11 scroll-mt-7 cursor-pointer items-center gap-1.5 border-b border-border py-1 pl-24 pr-3 text-xs text-accent lg:min-h-7 ${
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
                // 매체 칸 — 이름이 없으면 도메인(묶음 매체 수도 그것으로 셈, 이름보다 덜 눈에 띄게), 둘 다 없으면 '—'.
                const publisher = publisherLabel(item);
                return (
                  <div
                    key={entry.key}
                    id={optionId(index)}
                    role="option"
                    aria-selected={isSelected}
                    onClick={choose}
                    onDoubleClick={() => {
                      if (lastPointer.current !== "touch" && lastPointer.current !== "pen") openOriginal(item);
                    }}
                    className={`relative grid min-h-11 scroll-mt-7 cursor-pointer grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-b border-border px-3 py-1.5 text-sm lg:min-h-8 lg:py-1 @xl:grid-cols-[4.5rem_4rem_9rem_minmax(0,1fr)] ${
                      isSelected ? "bg-surface-2" : "hover:bg-surface-2/60"
                    }`}
                  >
                    {isSelected ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
                    {/* 펼친 묶음의 줄 — 왼쪽 안쪽 세로선(모양)과 낭독용 머리말(글)로 대표 줄에 딸린 줄임을 보입니다. */}
                    {member ? <span aria-hidden="true" className="absolute inset-y-0 left-1.5 w-px bg-border-strong forced-colors:border-l" /> : null}
                    <span className={`flex flex-col text-xs tabular-nums text-text-2 ${isDateOnly(item) ? "whitespace-nowrap" : "@xl:text-sm"}`}>
                      {otherDate ? <span className="text-xs text-text-3">{otherDate}</span> : null}
                      <span>{rowTimeText(item)}</span>
                      {item.timeBasis === "fetched" ? <span className="text-xs text-text-3">받은 시각</span> : null}
                    </span>
                    <span className="col-start-2 row-start-2 text-xs text-text-3 @xl:col-start-auto @xl:row-start-auto">
                      <ItemKindTag kind={item.kind} />
                      <span className="@xl:hidden"> · {publisher?.text ?? EMPTY}</span>
                    </span>
                    <span className={`hidden truncate text-xs @xl:block ${publisher?.domain ? "text-text-3" : "text-text-2"}`}>{publisher?.text ?? EMPTY}</span>
                    {/* 제목 — 두 칸 배치에서는 두 줄까지(넘으면 말줄임), 네 칸에서는 한 줄 말줄임. 전체 제목은 고르면 미리 보기에. */}
                    <span className="col-start-2 row-start-1 line-clamp-2 min-w-0 break-words text-text @xl:col-start-auto @xl:row-start-auto @xl:block @xl:truncate">
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
    <section ref={filterPaneRef} aria-label="거르기" className="flex flex-col gap-4">
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
        <button type="button" className={BUTTON} onClick={() => clearFilters("pane")}>
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
      onClose={closePreview}
      onKeyDown={onPreviewKeyDown}
      onRead={() => setReader(readerOfFeedItem(selected, sourceLabel(selected.source, statuses)))}
    />
  ) : previewOpen && selectedEntry?.type === "cluster" ? (
    <ClusterPreview entry={selectedEntry} onClose={closePreview} onKeyDown={onPreviewKeyDown} />
  ) : (
    <AttributesPanel
      entity={entity}
      kind={kind}
      errors={entityErrors}
      aliasEditor={aliasEditor ? aliasEditor(reloadFeed) : null}
      previewHint={selectable}
    />
  );

  return (
    <div className={`${PANEL} flex flex-col`} style={sheet.height > 0 ? { marginBottom: sheet.height } : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 lg:hidden">
        <button type="button" className={BUTTON} aria-expanded={drawer} aria-controls={drawerId} onClick={() => setDrawer((value) => !value)}>
          거르기 · 기간 {SEARCH_RANGES.find((option) => option.key === range)?.label}
        </button>
        {data?.fetchedAt ? <span className="text-xs text-text-3">받은 시각 {formatKst(data.fetchedAt)} KST</span> : null}
      </div>
      <div className={ENTITY_GRID}>
        <div className={`lg:border-r lg:border-border ${ENTITY_LEFT}`}>
          {aside ? <div className="border-b border-border p-3">{aside}</div> : null}
          <div id={drawerId} className={`${drawer ? "block" : "hidden"} border-b border-border p-3 lg:block lg:border-b-0`}>
            {filterPane}
          </div>
        </div>
        <div className="min-w-0">
          {!demo && data?.available ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5">
              {/* 받는 동안 disabled로 바꾸지 않습니다(누른 단추가 disabled가 되면 포커스가 body로 떨어짐 — QA-444) — aria-disabled·aria-busy로
                  알리고 누름은 훅이 한 번만 보냅니다. */}
              <button
                type="button"
                className={`${BUTTON} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
                aria-disabled={feed.refreshing || undefined}
                aria-busy={feed.refreshing || undefined}
                onClick={() => {
                  if (!feed.refreshing) void feed.refresh();
                }}
              >
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
              {summaryAllowed && inRange.length > 0 ? (
                <SummaryButton
                  ref={summaryButtonRef}
                  className="lg:ml-auto"
                  loading={summary.phase === "loading"}
                  busy={summary.busy}
                  onClick={() => void summary.summarize()}
                />
              ) : null}
            </div>
          ) : null}
          {pendingText ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1.5 text-xs text-text-2">
              {/* 다시 읽는 동안·멈춘 뒤·다시 확인의 실패를 같은 상태 영역에 둡니다(낭독기가 한 자리에서 듣게). */}
              <p
                ref={pendingStatusRef}
                role="status"
                tabIndex={-1}
                className="flex items-center gap-2 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
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
          {summaryAllowed && data?.available ? (
            <SummaryPanel
              phase={summary.phase}
              response={summary.response}
              error={summary.error}
              waiting={summary.busy && summary.phase !== "loading"}
              items={data.items ?? []}
              reachable={reachableIds}
              onRef={revealRow}
              onClose={closeSummary}
            />
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
        {/* 오른쪽 칸 — xl 미만은 가운데 아래(속성)이고, 고른 줄(묶음 줄 포함)의 미리 보기는 아래 시트(lg는 하단 탭 바가 없어 바닥에, 왼쪽 메뉴
            232px 옆, 본문 스크롤 막대 옆까지). */}
        <div
          ref={sheetRef}
          style={sheetStyle(sheet)}
          className={`${
            previewOpen
              ? "fixed inset-x-0 bottom-[calc(64px+env(safe-area-inset-bottom))] z-30 max-h-[50dvh] overflow-y-auto border-t border-border-strong bg-surface shadow-overlay lg:bottom-0 lg:left-[232px]"
              : "border-t border-border"
          } p-3 xl:static xl:z-auto xl:max-h-none xl:overflow-visible xl:border-l xl:border-t-0 xl:shadow-none`}
        >
          <div className="xl:sticky xl:top-0">{rightPane}</div>
        </div>
      </div>
      <SourceStatusLine sources={statuses} pendingStalled={feed.pendingPhase === "stalled"} />
      {data?.fetchedAt ? <p className="hidden px-3 pb-2 text-xs text-text-3 lg:block">받은 시각 {formatKst(data.fetchedAt)} KST · 결과는 15분 동안 다시 씁니다</p> : null}
      {owner ? <ReaderDialog entry={reader} onClose={() => setReader(null)} /> : null}
    </div>
  );
}

/**
 * 열린 아래 시트(xl 미만)의 모양 — 오른쪽은 본문 스크롤 막대만큼 비우고(sheet.gutter), 높이는 잰 높이(sheet.height) 아래로 줄지 않게
 * min-height로 둡니다(시트의 max-h와 같은 50dvh 상한 안). 그러면 잰 높이는 열린 동안 커지기만 해서, ↑↓로 높은 미리 보기(묶음 줄·긴 요약)에서
 * 낮은 미리 보기(요약 없는 줄 등)로 옮겨도 시트·결과 아래 여백(marginBottom)·--bottom-sheet·TOP 단추가 내려오지 않습니다. 줄면 본문의 스크롤
 * 높이가 줄어 목록 끝 근처에서 스크롤 위치가 당겨지고 고른 줄이 그만큼 움직였습니다(1024에서 묶음 343px → 결과 줄 240px이면 약 103px).
 * 닫으면 잰 높이가 0이 되어 풀립니다(다음에 열 때는 그 미리 보기의 높이부터). 시트가 흐름 안(xl 오른쪽 칸)이면 잰 높이가 0이라 두지 않습니다.
 */
function sheetStyle(sheet: BottomSheetSpace): CSSProperties | undefined {
  if (sheet.height <= 0 && sheet.gutter <= 0) return undefined;
  return {
    ...(sheet.gutter > 0 ? { right: sheet.gutter } : {}),
    ...(sheet.height > 0 ? { minHeight: `min(${sheet.height}px, 50dvh)` } : {}),
  };
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

/** 미리 보기의 닫기 — 닫기 단추와 영역 안의 키(Escape). 닫으면 부르는 쪽이 포커스를 결과 목록으로 옮깁니다(QA-430). */
type PreviewClose = { onClose: () => void; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void };

/** 미리 보기의 틀 — 이름이 '미리 보기'인 영역, 머리와 닫기 단추. 결과 줄(FeedPreview)과 묶음 줄(ClusterPreview)이 같이 씁니다. */
function PreviewFrame({ onClose, onKeyDown, children }: PreviewClose & { children: ReactNode }) {
  return (
    <section aria-label="미리 보기" onKeyDown={onKeyDown} className="flex flex-col gap-2">
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
      {children}
    </section>
  );
}

/** 줄의 시각(날짜만 아는 줄은 날짜)과 매체 — 미리 보기의 속성 줄. */
function itemFactRows(item: SearchFeedItem): [string, string][] {
  return [
    isDateOnly(item)
      ? ["날짜", `${itemTimeText(item)} (출처가 날짜만 줌)`]
      : ["시각", `${itemTimeText(item)}${item.timeBasis === "fetched" ? " (받은 시각 — 출처가 작성 시각을 주지 않음)" : ""}`],
    ["매체", [item.publisher, item.publisherDomain].filter(Boolean).join(" · ") || EMPTY],
  ];
}

function FactList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-text-3">{name}</dt>
          <dd className="min-w-0 break-words text-text-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 묶음 미리 보기에 이름을 보일 다른 보도 수 — 나머지는 건수만(펼치면 목록에 모두). 시트 높이가 묶음 크기(최대 30줄)만큼 늘지 않게. */
const CLUSTER_PREVIEW_MEMBERS = 5;

/**
 * 고른 묶음 줄의 미리 보기 — 묶음 줄과 같은 건수·매체 수(같은 셈), 그 바로 아래 펼치는 법, 대표 줄의 제목·매체·시각, 같은 사건의 다른 보도
 * (앞 5건의 제목·매체·시각). 묶음 줄을 지날 때 미리 보기(xl 미만은 아래 시트)가 닫히지 않게 합니다.
 */
function ClusterPreview({ entry, onClose, onKeyDown }: PreviewClose & { entry: FeedClusterEntry }) {
  const shown = entry.members.slice(0, CLUSTER_PREVIEW_MEMBERS);
  const more = entry.members.length - shown.length;
  return (
    <PreviewFrame onClose={onClose} onKeyDown={onKeyDown}>
      <p className="text-sm font-semibold leading-snug text-text">{clusterSizeText(entry)}</p>
      {/* 펼치는 법은 머리 바로 아래 — 끝에 두면 다른 보도가 많은 묶음에서 시트(50dvh 상한) 밑으로 밀려 시트 안을 스크롤해야 보였습니다. */}
      <p className="text-xs text-text-3">
        {entry.expanded
          ? "접기: 결과 목록에서 Enter(또는 묶음 줄 누르기) — 대표 줄만 남습니다."
          : `펼치기: 결과 목록에서 Enter(또는 묶음 줄 누르기) — 나머지 ${entry.members.length}건이 대표 줄 아래에 나옵니다.`}
      </p>
      <div className="flex flex-col gap-1">
        <p className="text-xs text-text-3">대표 보도 — 가장 이른 줄</p>
        <p className="text-sm leading-snug text-text">{entry.lead.title}</p>
        <FactList rows={itemFactRows(entry.lead)} />
      </div>
      {shown.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs text-text-3">같은 사건의 다른 보도 {entry.members.length}건</p>
          <ul aria-label="같은 사건의 다른 보도" className="flex flex-col gap-1.5">
            {shown.map((item) => (
              <li key={item.id} className="flex flex-col gap-0.5 border-l border-border-strong pl-2">
                <span className="line-clamp-2 break-words text-sm leading-snug text-text-2">{item.title}</span>
                <span className="text-xs text-text-3">
                  {publisherLabel(item)?.text ?? EMPTY} · {itemTimeText(item)}
                </span>
              </li>
            ))}
          </ul>
          {/* 펼친 상태에 맞게 — 접혀 있으면 펼치는 길, 펼쳤으면 이미 목록에 있음(위 펼치기·접기 안내와 같은 상태). */}
          {more > 0 ? (
            <p className="text-xs text-text-3">
              {`그 밖에 ${more}건 — ${entry.expanded ? "목록에 모두 나와 있습니다." : "펼치면 목록에 모두 나옵니다."}`}
            </p>
          ) : null}
        </div>
      ) : null}
    </PreviewFrame>
  );
}

/** 고른 줄의 미리 보기 — 출처가 준 요약·매체·시각과 원문 열기. 본문은 받지 않습니다(D-3). 수집 글은 운영자에게 받아 둔 글 보기. */
function FeedPreview({
  item,
  label,
  owner,
  onClose,
  onKeyDown,
  onRead,
}: PreviewClose & {
  item: SearchFeedItem;
  label: string;
  owner: boolean;
  onRead: () => void;
}) {
  const url = httpUrl(item.url);
  const rows: [string, string][] = [...itemFactRows(item), ["종류", itemKindLabel(item.kind)], ["받은 곳", label]];
  return (
    <PreviewFrame onClose={onClose} onKeyDown={onKeyDown}>
      <p className="text-sm font-semibold leading-snug text-text">{item.title}</p>
      <FactList rows={rows} />
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
    </PreviewFrame>
  );
}
