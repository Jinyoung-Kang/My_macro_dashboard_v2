"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { FOCUS_RING, SELECTED_BAR } from "@/components/ui/classes";
import { Dialog } from "@/components/ui/Dialog";
import { LockIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useShellShortcuts } from "@/hooks/useShellShortcuts";
import { endpoints } from "@/lib/endpoints";
import { navSearchItems } from "@/lib/nav";
import { onShellCommand } from "@/lib/shellCommands";
import type { ShortcutConditions } from "@/lib/shortcuts";
import {
  buildSearchIndex,
  indicatorEntries,
  infoSearchEntry,
  institutionEntries,
  menuEntries,
  noResultText,
  resultSummary,
  searchGroups,
  sourceNotice,
  symbolNotice,
  symbolGroup,
  tickerEntries,
  type InstitutionList,
  type SearchEntry,
} from "@/lib/search";
import type { DetailSymbolsResponse, MacroOverview, SessionUser, StockUniverseResponse } from "@/lib/types";
import { SearchIcon, TabIcon } from "./icons";
import { ShortcutHelp, shortcutConditionsNow } from "./ShortcutHelp";

// 맥이면 ⌘K, 아니면 Ctrl K. 서버 렌더·하이드레이션 첫 그림은 Ctrl로 같게 그립니다(값은 브라우저에만 있음).
const noSubscribe = () => () => {};
const isMacPlatform = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const isMacServer = () => false;

/** 외부 종목 찾기(GET /api/detail/symbols)를 부르기 전 기다리는 시간과 최소 글자 수 — 글자를 칠 때마다 외부 검색을 부르지 않게. */
const SYMBOL_DEBOUNCE_MS = 350;
const SYMBOL_MIN_CHARS = 2;

/** 도움말 창을 열기 전의 조건(창이 닫혀 있는 동안의 기본값). */
const NO_CONDITIONS: ShortcutConditions = { wide: false, filter: false };

/**
 * 통합 검색(⌘K) — 메뉴·지표·기관·종목을 한 입력칸에서 찾아 그 화면으로 갑니다.
 *
 * - 여는 법: 상단바의 검색 단추(입력칸 모양), 또는 어디서든 맥은 ⌘K, 그 밖은 Ctrl+K(한글 조합 중에는 받지 않음). 닫기는 Esc·바깥 누르기·닫기 단추.
 * - 셸 단축키(hooks/useShellShortcuts — 셸의 전역 keydown 처리기는 여기 하나): ?는 단축키 도움말 창(ShortcutHelp — 이 컴포넌트가 함께 그림, 셸 명령
 *   open-shortcut-help로도 열림), /는 화면의 거르기 칸(data-shell-filter), [는 넓은 화면에서 왼쪽 메뉴 접기 신호(셸 명령 toggle-nav). 쓰기 동작은 없습니다.
 * - 자료는 열 때만 읽습니다(닫혀 있으면 useApi 경로가 null). 세 경로 모두 회원 경로이고(AccessPolicy), 운영자 전용 자료는 읽지
 *   않습니다 — 운영자 화면은 메뉴 범주에만 있고 그것도 lib/access가 운영자에게만 넣습니다.
 * - 키보드: ↑↓로 결과를 옮기고 Enter로 갑니다(입력칸이 combobox, 결과가 listbox — aria-activedescendant).
 * - 결과는 범주마다 상한까지만 보이고 넘친 수를 범주 제목에 적습니다. 무료 회원에게 잠긴 유료 화면은 자물쇠 아이콘.
 * - 결과 행: 왼쪽 32px 원(메뉴는 그 탭 아이콘, 지표는 시장·기관은 기관 아이콘, 종목은 티커 모노그램 — lib/search `avatar`, 장식) ·
 *   이름과 보조 글 · 오른쪽 '→ 화면' 캡션. 지표·기관·종목은 그 상세 화면으로 갑니다(/markets/i/…·/institutions/…·/s/…).
 * - 색인 밖 종목: 두 글자 이상을 치고 잠시 멈추면 외부 검색(Yahoo·네이버 자동완성, GET /api/detail/symbols — 회원 경로)을 불러 마지막 묶음
 *   '종목 찾기'에 붙입니다. 색인에 이미 있는 종목은 빼고, 지금 검색어의 응답일 때만 보입니다(앞 검색어의 결과가 남지 않게).
 * - 결과 맨 아래(목록 밖)의 '‘검색어’ 정보 검색' 링크 — 같은 검색어로 정보 검색 화면(/search?q=, ADR 0041)으로 갑니다. 결과가 없어도 있고,
 *   결과 수·'맞는 결과가 없습니다'에는 세지 않습니다.
 */
export function SearchCommand({ user }: { user?: SessionUser }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const baseId = useId();
  const listboxId = `${baseId}-results`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const isMac = useSyncExternalStore(noSubscribe, isMacPlatform, isMacServer);

  // 단축키 도움말 창 — 열 때 조건(넓은 화면·거르기 칸)을 셉니다. `?`, 계정 메뉴(셸 명령 open-shortcut-help)가 엽니다.
  const [help, setHelp] = useState<{ open: boolean; conditions: ShortcutConditions }>({ open: false, conditions: NO_CONDITIONS });
  const openHelp = useCallback(() => setHelp({ open: true, conditions: shortcutConditionsNow() }), []);
  useEffect(() => onShellCommand("open-shortcut-help", openHelp), [openHelp]);

  // 맥 ⌘K·그 밖 Ctrl+K(한글 자판 물리 키 포함)·?·/·[ — 판정은 lib/shortcuts. 셸의 전역 keydown 처리기는 이 훅 하나입니다.
  useShellShortcuts({ isMac, onPalette: () => setOpen(true), onHelp: openHelp });

  // /api/macro/overview는 live 없이(저장본) — 검색 때문에 외부 시세를 새로 받지 않습니다.
  const overview = useApi<MacroOverview>(open ? endpoints.macro.overview(false) : null);
  const institutions = useApi<InstitutionList>(open ? endpoints.institution.institutions : null);
  const universe = useApi<StockUniverseResponse>(open ? endpoints.insight.stockUniverse : null);
  // 외부 종목 찾기 — 입력이 멈춘 뒤의 검색어로만 부릅니다.
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(query.trim()), SYMBOL_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const symbolPath = open && settled.length >= SYMBOL_MIN_CHARS && settled === query.trim() ? endpoints.detail.symbols(settled) : null;
  const symbols = useApi<DetailSymbolsResponse>(symbolPath);

  const index = useMemo(
    () =>
      buildSearchIndex([
        ...menuEntries(navSearchItems(user)),
        ...indicatorEntries(overview.data),
        ...institutionEntries(institutions.data),
        ...tickerEntries(universe.data),
      ]),
    [user, overview.data, institutions.data, universe.data],
  );
  const indexed = useMemo(() => searchGroups(index, query), [index, query]);
  // useApi는 경로가 바뀐 직후 앞 경로의 값을 내보내지 않습니다 — 앞 검색어의 종목 찾기 결과가 새 검색어 아래 남지 않음.
  const groups = useMemo(() => {
    const remote = symbolGroup(symbols.data, indexed);
    return remote ? [...indexed, remote] : indexed;
  }, [indexed, symbols.data]);
  const flat = groups.flatMap((group) => group.items);
  // 묶음마다 첫 결과의 전체 순번(↑↓·aria-activedescendant는 묶음을 넘어 한 줄로 셉니다).
  const starts = groups.map((_, at) => groups.slice(0, at).reduce((sum, group) => sum + group.items.length, 0));
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);

  const notices = [
    sourceNotice("지표", overview),
    sourceNotice("기관", institutions),
    sourceNotice("종목", universe),
    symbolPath !== null ? symbolNotice(symbols) : null,
  ].filter((notice): notice is string => notice !== null);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
      setSettled("");
      setActive(0);
    }
  };

  const go = (entry: SearchEntry) => {
    changeOpen(false);
    router.push(entry.href);
  };

  const moveTo = (next: number) => {
    setActive(next);
    // 목록이 길면 고른 줄이 보이게 스크롤합니다(옵션은 이미 그려져 있어 지금 찾을 수 있음).
    document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 한글 입력 중(조합 중)의 Enter·화살표는 입력기가 씁니다 — 여기서 받으면 마지막 글자를 확정하기 전에 이동해 버립니다.
    if (event.nativeEvent.isComposing || flat.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveTo((activeIndex + 1) % flat.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveTo((activeIndex - 1 + flat.length) % flat.length);
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      go(flat[activeIndex]);
    }
  };

  const trimmed = query.trim();
  const infoSearch = infoSearchEntry(query, user);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={changeOpen}
        title="통합 검색"
        hideTitle
        size="lg"
        placement="top"
        trigger={
          // 투명 1px 테두리 — 고대비(forced-colors) 모드에서 바탕색이 지워져도 입력칸 모양의 경계가 시스템 색 테두리로 남습니다(단추와 같음, 명세 D9).
          // 모서리는 4px(입력칸·단추와 같음 — 작업대 실행 명세 §3-8, 2026-11-16 알약 정리).
          // 좁은 화면(lg 미만)은 상단바 위 줄의 남는 폭을 다 쓰는 44px. 넓은 화면은 48px 상단바의 조작 높이 30px(§3-7)에 폭을 고정합니다(176px,
          // xl 256px) — 남는 폭은 빵부스러기가 씁니다(§5).
          <button
            type="button"
            aria-label="종목·기관·지표·메뉴 검색"
            aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
            className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-control border border-transparent bg-surface-2 px-4 text-left text-sm text-text-3 hover:text-text-2 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:h-[30px] lg:w-44 lg:flex-none lg:gap-2 lg:px-2.5 xl:w-64"
          >
            <SearchIcon />
            <span className="min-w-0 flex-1 truncate">종목·기관·지표·메뉴 검색</span>
            <kbd aria-hidden="true" className="hidden shrink-0 rounded-sm border border-border px-1.5 font-sans text-xs text-text-3 sm:inline">
              {isMac ? "⌘K" : "Ctrl K"}
            </kbd>
          </button>
        }
      >
        {/* 입력칸은 대화상자 닫기 단추(오른쪽 위) 앞에서 끝납니다 — 안쪽 여백으로 비키면 입력칸 테두리·포커스 링 위에 닫기 단추가 겹쳤습니다.
            덮개 바탕이 surface-2라(작업대 명세 §3-3) 입력칸은 공용 입력칸처럼 한 단계 어두운 surface와 border-strong 경계로 그립니다.
            넓은 화면은 큰 조작 높이 40px(§3-7 — 검색창, 경계 2px 포함)·글 16px, 좁은 화면은 50px·17px 그대로. */}
        <div className="mr-10 mt-1 flex items-center gap-3 rounded-control border border-border-strong bg-surface px-4 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
          <SearchIcon size={18} />
          <input
            type="search"
            role="combobox"
            aria-label="검색어"
            aria-expanded={flat.length > 0}
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="종목·기관·지표·메뉴 검색"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            // 브라우저 기본 지우기 X는 숨깁니다(QA-515) — 어두운 화면에서 굵은 흰색으로 그려져 바로 옆 대화상자 닫기 X와 헷갈렸습니다. type=search는
            // 휴대폰 자판의 검색 키 때문에 그대로 두고, 따로 지우기 단추는 두지 않습니다(Esc·닫기로 닫으면 다음에 빈 칸으로 열림).
            className="h-12 min-w-0 flex-1 bg-transparent text-[17px] text-text outline-none placeholder:text-text-3 lg:h-[38px] lg:text-base [&::-webkit-search-cancel-button]:hidden"
          />
        </div>

        {/* 범주를 아직 다 읽지 못했으면(읽는 중·실패·저장본 없음) 그 사실도 함께 읽어 줍니다 — "결과 0건"만 말하면 없는 것으로 들립니다. */}
        <p role="status" className="sr-only">
          {trimmed ? resultSummary(groups, notices) : ""}
        </p>

        {/* 결과가 없으면(입력칸이 접힘 — aria-expanded false) 빈 목록 상자를 접근성 트리에서 뺍니다. 결과 없음 안내는 위 status가 읽습니다. */}
        <div
          id={listboxId}
          role="listbox"
          aria-label="검색 결과"
          hidden={flat.length === 0}
          className="mt-3 flex max-h-[min(60dvh,28rem)] flex-col gap-3 overflow-y-auto"
        >
          {groups.map((group, groupAt) => {
            const headingId = `${baseId}-group-${group.kind}`;
            return (
              <div key={group.kind} role="group" aria-labelledby={headingId}>
                <div id={headingId} role="presentation" className="flex items-baseline justify-between gap-2 px-3 pb-1 text-xs font-semibold text-text-3">
                  <span>{group.label}</span>
                  {group.more > 0 && (
                    <span className="font-normal">
                      {group.items.length}개 표시 · {group.more}개 더 — 검색어를 더 입력하세요
                    </span>
                  )}
                </div>
                {group.items.map((entry, itemAt) => {
                  const index = starts[groupAt] + itemAt;
                  const selected = index === activeIndex;
                  return (
                    <div
                      key={entry.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={selected}
                      onClick={() => go(entry)}
                      onMouseMove={() => {
                        if (!selected) setActive(index);
                      }}
                      className={`relative flex min-h-12 cursor-pointer items-center gap-3 rounded-control px-3 py-2 lg:min-h-10 lg:py-1 ${selected ? "bg-surface" : ""}`}
                    >
                      {/* 고른 결과 표시 — 초점은 입력칸에 있어 포커스 링이 없고, 고른 줄 바탕(surface — 덮개 surface-2보다 한 단계 어두움)만으로는
                          대비가 1.1:1이라 왼쪽 잉크 막대를 함께 둡니다(계좌 행 AssetRow의 선택 막대와 같은 모양·색, 바탕 대비 3:1 이상 — 명세 D8 d). */}
                      {selected && <span aria-hidden="true" className={SELECTED_BAR} />}
                      <span
                        aria-hidden="true"
                        className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-text-2 ${
                          selected ? "bg-surface-2" : "bg-surface"
                        }`}
                      >
                        {entry.avatar && "tab" in entry.avatar ? <TabIcon tab={entry.avatar.tab} size={16} /> : entry.avatar?.text}
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[15px] text-text lg:text-sm">
                          {entry.label}
                          {entry.locked && (
                            <span title="유료 등급 기능" className="ml-1.5 inline-flex align-[-2px]">
                              <LockIcon size={14} label="유료 등급 기능" />
                            </span>
                          )}
                        </span>
                        {entry.sub && <span className="truncate text-xs text-text-3">{entry.sub}</span>}
                      </span>
                      {entry.dest && <span className="shrink-0 text-xs text-text-3">→ {entry.dest}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {trimmed === "" && (
          <p className="px-3 text-sm text-text-2">
            메뉴 이름, 매크로 지표 이름·티커, 13F 기관 이름, 종목 이름·티커·국내 코드를 입력하세요. 지표·기관·종목은 시세·지표·뉴스를 모은 상세 화면으로
            갑니다(목록에 없는 종목은 Yahoo·네이버에서 찾음).
          </p>
        )}
        {trimmed !== "" && flat.length === 0 && <p className="px-3 text-sm text-text-2">{noResultText(trimmed, notices)}</p>}
        {infoSearch && (
          <Link
            href={infoSearch.href}
            onClick={() => changeOpen(false)}
            className={`mt-2 flex min-h-12 items-center gap-3 rounded-control px-3 py-2 hover:bg-surface lg:min-h-10 lg:py-1 ${FOCUS_RING}`}
          >
            <span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-surface text-text-2">
              <TabIcon tab="search" size={16} />
            </span>
            <span className="min-w-0 flex-1 truncate text-[15px] text-accent lg:text-sm">{infoSearch.label}</span>
            <span aria-hidden="true" className="shrink-0 text-xs text-text-3">
              → 기사·글 모아 보기
            </span>
          </Link>
        )}
        {notices.length > 0 && (
          <ul aria-label="검색 자료 상태" className="mt-3 flex flex-col gap-1 border-t border-border px-3 pt-3 text-xs text-text-3">
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        )}
      </Dialog>
      <ShortcutHelp
        open={help.open}
        onOpenChange={(next) => setHelp((current) => ({ ...current, open: next }))}
        isMac={isMac}
        conditions={help.conditions}
      />
    </>
  );
}
