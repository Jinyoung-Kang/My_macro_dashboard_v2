"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { FOCUS_RING, SELECTED_BAR } from "@/components/ui/classes";
import { Dialog } from "@/components/ui/Dialog";
import { LockIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { rememberRecentEntity, useRecentEntities } from "@/hooks/useRecentEntities";
import { useShellShortcuts } from "@/hooks/useShellShortcuts";
import { endpoints } from "@/lib/endpoints";
import { navSearchItems } from "@/lib/nav";
import {
  COMMAND_GROUP_LABEL,
  RECENT_GROUP_LABEL,
  commandMatches,
  paletteSummary,
  recentEntries,
  recentFromEntry,
  recentSummary,
  type PaletteCommand,
} from "@/lib/palette";
import { isWideShell, onShellCommand, sendShellCommand, type ShellCommand } from "@/lib/shellCommands";
import type { ShortcutConditions } from "@/lib/shortcuts";
import {
  buildSearchIndex,
  indicatorEntries,
  infoSearchEntry,
  institutionEntries,
  menuEntries,
  noResultText,
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

/** 팔레트 결과 한 줄 — 대상·메뉴로 가는 결과, 또는 명령(셸 명령 하나 — 서버를 부르지 않음, lib/palette). */
type PaletteOption = { type: "entry"; entry: SearchEntry } | { type: "command"; command: PaletteCommand };

/** 결과 묶음 — 이름 아래 줄들. `more`는 상한 때문에 보이지 않는 수(제목에 "N개 더"). */
type PaletteGroup = { key: string; label: string; more: number; options: PaletteOption[] };

const entryOption = (entry: SearchEntry): PaletteOption => ({ type: "entry", entry });
const commandOption = (command: PaletteCommand): PaletteOption => ({ type: "command", command });

/** 결과 줄에 그릴 것 — 대상·메뉴는 그 결과 그대로, 명령은 이름과 같은 일을 하는 단축키(원판에 키 글자, 장식). */
type OptionView = Pick<SearchEntry, "id" | "label" | "sub" | "dest" | "avatar" | "locked">;

function optionView(option: PaletteOption): OptionView {
  if (option.type === "entry") return option.entry;
  const { command } = option;
  return { id: command.id, label: command.label, sub: `단축키 ${command.keys}`, dest: null, avatar: { text: command.keys } };
}

/** 도움말 창을 열기 전의 조건(창이 닫혀 있는 동안의 기본값). */
const NO_CONDITIONS: ShortcutConditions = { wide: false, filter: false };

/**
 * 통합 검색(⌘K) — 메뉴·지표·기관·종목을 한 입력칸에서 찾아 그 화면으로 갑니다.
 *
 * - 여는 법: 상단바의 검색 단추(입력칸 모양), 또는 어디서든 맥은 ⌘K, 그 밖은 Ctrl+K(한글 조합 중·열린 메뉴 안에서는 받지 않음 — 단축키 도움말 창이
 *   열려 있으면 그 창을 닫고 엶). 닫기는 Esc·바깥 누르기·닫기 단추.
 * - 셸 단축키(hooks/useShellShortcuts — 셸의 전역 keydown 처리기는 여기 하나): ?는 단축키 도움말 창(ShortcutHelp — 이 컴포넌트가 함께 그림, 셸 명령
 *   open-shortcut-help로도 열림), /는 화면의 거르기 칸(data-shell-filter), [는 넓은 화면에서 왼쪽 메뉴 접기 신호(셸 명령 toggle-nav). 쓰기 동작은 없습니다.
 * - 자료는 열 때만 읽습니다(닫혀 있으면 useApi 경로가 null). 세 경로 모두 회원 경로이고(AccessPolicy), 운영자 전용 자료는 읽지
 *   않습니다 — 운영자 화면은 메뉴 범주에만 있고 그것도 lib/access가 운영자에게만 넣습니다.
 * - 키보드: ↑↓로 결과를 옮기고 Enter로 갑니다(입력칸이 combobox, 결과가 listbox — aria-activedescendant).
 * - 결과는 범주마다 상한까지만 보이고 넘친 수를 범주 제목에 적습니다. 무료 회원에게 잠긴 유료 화면은 자물쇠 아이콘.
 * - 결과 행: 왼쪽 32px 원(메뉴는 그 탭 아이콘, 지표는 시장·기관은 기관 아이콘, 종목은 티커 모노그램 — lib/search `avatar`, 장식) ·
 *   이름과 보조 글 · 오른쪽 '→ 화면' 캡션. 지표·기관·종목은 그 상세 화면으로 갑니다(/markets/i/…·/institutions/…·/s/…).
 * - 색인 밖 종목: 두 글자 이상을 치고 잠시 멈추면 외부 검색(Yahoo·네이버 자동완성, GET /api/detail/symbols — 회원 경로)을 불러 색인 범주 뒤
 *   '종목 찾기' 묶음에 붙입니다(묶음 순서는 색인 범주 → 종목 찾기 → 명령). 색인에 이미 있는 종목은 빼고, 지금 검색어의 응답일 때만 보입니다(앞
 *   검색어의 결과가 남지 않게). 이 묶음은 늦게 와서 명령 묶음 앞에 끼므로 고른 줄은 순번이 아니라 결과 id로 듭니다 — 고른 줄이 그대로 남고
 *   순번(aria-activedescendant)만 따라가며, 밀려서 목록 상자 밖으로 나간 고른 줄은 보이게 스크롤합니다(QA-557).
 * - 결과 맨 아래(목록 밖)의 '‘검색어’ 정보 검색' 링크 — 같은 검색어로 정보 검색 화면(/search?q=, ADR 0041)으로 갑니다. 결과가 없어도 있고,
 *   결과 수·'맞는 결과가 없습니다'에는 세지 않습니다.
 * - 명령 팔레트로 넓힌 범주(최근 연 대상·명령)와 빈 검색어 안내 끝의 도움말 문장은 넓은 화면(lg 이상 — 팔레트를 열 때 셈)에만 있습니다(작업대 실행
 *   명세 §0 W2 — 명령 팔레트는 넓은 화면 항목, 좁은 화면은 지금 통합 검색 그대로).
 */
export function SearchCommand({ user }: { user?: SessionUser }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 고른 결과의 id(optionView(option).id) — 순번으로 들면 늦게 온 묶음이 앞에 낄 때 고른 줄이 다른 결과로 바뀝니다(QA-557). null이면 맨 위.
  const [activeId, setActiveId] = useState<string | null>(null);
  const baseId = useId();
  const listboxId = `${baseId}-results`;
  const recentHintId = `${baseId}-recent-hint`;
  const optionId = (index: number) => `${baseId}-option-${index}`;
  const isMac = useSyncExternalStore(noSubscribe, isMacPlatform, isMacServer);

  // 단축키 도움말 창 — 열 때 조건(넓은 화면·거르기 칸)을 셉니다. `?`, 계정 메뉴(셸 명령 open-shortcut-help)가 엽니다.
  const [help, setHelp] = useState<{ open: boolean; conditions: ShortcutConditions }>({ open: false, conditions: NO_CONDITIONS });
  const openHelp = useCallback(() => setHelp({ open: true, conditions: shortcutConditionsNow() }), []);
  useEffect(() => onShellCommand("open-shortcut-help", openHelp), [openHelp]);

  // 넓은 화면(lg 이상)인가 — 팔레트를 열 때 한 번 셉니다(열린 동안 창 폭이 바뀌어도 그대로). 거짓이면 지금 통합 검색 그대로(최근 연 대상·명령·도움말 안내 없음).
  const [wide, setWide] = useState(false);

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
  // 최근 연 대상(이 브라우저에만 — 닫혀 있어도 localStorage만 읽음, 검색 자료는 읽지 않음). 보이는 것은 넓은 화면에서만입니다.
  const recent = useRecentEntities();
  const trimmed = query.trim();
  // 명령 — 넓은 화면에서 검색어가 맞을 때만(lib/palette — 명령은 모두 wideOnly). 빈 검색어에는 명령이 없어 빈 Enter가 명령(도움말 창 열기·
  // 메뉴 접기)을 실행하지 않습니다.
  const commands = useMemo(() => (open && trimmed !== "" ? commandMatches(trimmed, { wide }) : []), [open, trimmed, wide]);
  // 팔레트 묶음 — 검색어가 비면 최근 연 대상(넓은 화면에서 있을 때만 — 그때 빈 Enter는 맨 위 대상으로 갑니다), 검색어가 있으면 색인 범주
  // (메뉴·지표·기관·종목) → 종목 찾기(늦게 옴) → 명령(맞을 때만). 고른 줄은 id로 들어 늦게 온 묶음이 끼어도 같은 결과에 남습니다(QA-557).
  // 좁은 화면의 빈 검색어는 결과가 없어 Enter가 아무것도 하지 않습니다(지금 그대로).
  const paletteGroups = useMemo<PaletteGroup[]>(() => {
    if (trimmed === "") {
      return wide && recent.length > 0
        ? [{ key: "recent", label: RECENT_GROUP_LABEL, more: 0, options: recentEntries(recent).map(entryOption) }]
        : [];
    }
    const found = groups.map((group) => ({ key: group.kind, label: group.label, more: group.more, options: group.items.map(entryOption) }));
    return commands.length > 0 ? [...found, { key: "command", label: COMMAND_GROUP_LABEL, more: 0, options: commands.map(commandOption) }] : found;
  }, [trimmed, wide, recent, groups, commands]);
  const flat = paletteGroups.flatMap((group) => group.options);
  // 묶음마다 첫 결과의 전체 순번(↑↓·aria-activedescendant는 묶음을 넘어 한 줄로 셉니다).
  const starts = paletteGroups.map((_, at) => paletteGroups.slice(0, at).reduce((sum, group) => sum + group.options.length, 0));
  // 빈 검색어에 펼쳐진 최근 연 대상의 안내(넓은 화면에서 있을 때만 — 빈 검색어의 결과는 최근 연 대상뿐). 입력칸 설명과 status가 함께 읽습니다(QA-560).
  const recentHint = trimmed === "" && flat.length > 0 ? recentSummary(flat.length) : null;
  // 고른 줄의 순번 — 고른 id가 지금 결과에 없으면(아직 고정 전 등) 맨 위.
  const activeIndex = flat.length === 0 ? -1 : Math.max(0, flat.findIndex((option) => optionView(option).id === activeId));
  // 결과가 생긴 첫 그림에서 맨 위 결과의 id로 고정합니다 — ↑↓를 누르지 않은 기본 상태도 늦게 온 묶음에 밀리지 않게. 닫혀 있는 동안은
  // 고정하지 않습니다(다른 탭이 최근 연 대상을 바꿔도 다시 열면 맨 위부터).
  const firstId = open && flat.length > 0 ? optionView(flat[0]).id : null;
  useEffect(() => {
    if (activeId === null && firstId !== null) setActiveId(firstId);
  }, [activeId, firstId]);
  // 고른 줄은 같은데 순번만 바뀌면(늦게 온 묶음이 앞에 낌) 그 줄이 목록 상자의 보이는 영역 밖으로 밀릴 수 있어 보이게 스크롤합니다 — 그대로
  // 두면 보이지 않는 줄을 Enter가 실행했습니다(QA-557 후속). 고른 줄이 바뀐 경우는 건드리지 않습니다(↑↓는 moveTo가 스크롤하고, 마우스로
  // 가리켜 고른 줄은 이미 보이는 줄이라 목록이 튀지 않게). 그린 뒤·칠하기 전에 옮겨 밀린 그림이 한 번도 보이지 않게 합니다.
  const shownActive = useRef<{ id: string | null; index: number }>({ id: null, index: -1 });
  useLayoutEffect(() => {
    const before = shownActive.current;
    shownActive.current = { id: activeId, index: activeIndex };
    if (open && activeId !== null && activeIndex >= 0 && before.id === activeId && before.index !== activeIndex) {
      document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [open, activeId, activeIndex, baseId]);

  const notices = [
    sourceNotice("지표", overview),
    sourceNotice("기관", institutions),
    sourceNotice("종목", universe),
    symbolPath !== null ? symbolNotice(symbols) : null,
  ].filter((notice): notice is string => notice !== null);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (next) {
      setWide(isWideShell());
    } else {
      setQuery("");
      setSettled("");
      setActiveId(null);
    }
  };

  // 맥 ⌘K·그 밖 Ctrl+K(한글 자판 물리 키 포함)·?·/·[ — 판정은 lib/shortcuts. 셸의 전역 keydown 처리기는 이 훅 하나입니다.
  // 도움말 창이 열린 채 ⌘K/Ctrl K를 누르면(도움말 첫 줄을 따라 해 보는 경우) 도움말을 닫고 팔레트를 엽니다 — 겹쳐 열면 팔레트에서 대상을 골라
  // 화면을 옮긴 뒤에도 도움말 창이 남았습니다.
  const openPalette = () => {
    setHelp((current) => (current.open ? { ...current, open: false } : current));
    changeOpen(true);
  };
  useShellShortcuts({ isMac, onPalette: openPalette, onHelp: openHelp });

  // 명령 실행 — 셸 명령뿐입니다(도움말 창은 이 컴포넌트의 상태, 왼쪽 메뉴 접기는 셸 명령 신호). 서버를 부르는 명령은 없습니다.
  const runShellCommand = useCallback(
    (command: ShellCommand) => {
      if (command === "open-shortcut-help") openHelp();
      else sendShellCommand(command);
    },
    [openHelp],
  );
  // 고른 명령은 팔레트가 닫히고 포커스가 돌아간 뒤에 실행합니다. Radix는 닫힌 대화상자의 포커스를 연 자리로 돌려주는 일을 내용이 사라진 뒤
  // setTimeout(0)으로 하므로, 그보다 먼저 도움말 창을 열면 포커스가 새 창 밖으로 끌려갔다 돌아오고 도움말을 닫을 때 돌아갈 곳을 잃습니다.
  // 왼쪽 메뉴 접기도 포커스가 돌아간 자리(접히면 사라지는 하위 칸일 수 있음)를 왼쪽 메뉴가 보고 옮기게 그 뒤에 보냅니다. 이 효과와 Radix의
  // 미룸 가운데 어느 것이 먼저 걸리는지(React가 닫힘을 한 번에 그리는지 두 번에 그리는지)에 기대지 않게 두 번 미룹니다(바로 열면 시험에서 포커스를 잃음).
  const pendingCommand = useRef<ShellCommand | null>(null);
  useEffect(() => {
    const command = pendingCommand.current;
    if (open || command === null) return;
    pendingCommand.current = null;
    let inner: number | undefined;
    const outer = window.setTimeout(() => {
      inner = window.setTimeout(() => runShellCommand(command), 0);
    }, 0);
    return () => {
      window.clearTimeout(outer);
      if (inner !== undefined) window.clearTimeout(inner);
    };
  }, [open, runShellCommand]);

  // 대상(지표·기관·종목·종목 찾기)은 최근 연 대상에 넣고 갑니다. 메뉴는 넣지 않습니다. 명령은 팔레트를 닫은 뒤 실행합니다.
  const go = (option: PaletteOption) => {
    if (option.type === "command") {
      pendingCommand.current = option.command.effect.command;
      changeOpen(false);
      return;
    }
    const entry = option.entry;
    const recentEntity = recentFromEntry(entry);
    if (recentEntity) rememberRecentEntity(recentEntity);
    changeOpen(false);
    router.push(entry.href);
  };

  const moveTo = (next: number) => {
    setActiveId(optionView(flat[next]).id);
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
          // xl 256px) — 남는 폭은 빵부스러기가 씁니다(§5). 176px(lg~xl)에서는 글 칸이 78px뿐이라 앞부분을 숨겨 '검색'만 보입니다(QA-558 —
          // 앱 이름의 hidden xl:inline과 같은 꼴, 접근 이름은 aria-label 전체 글 그대로).
          <button
            type="button"
            aria-label="종목·기관·지표·메뉴 검색"
            aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
            className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-control border border-transparent bg-surface-2 px-4 text-left text-sm text-text-3 hover:text-text-2 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:h-[30px] lg:w-44 lg:flex-none lg:gap-2 lg:px-2.5 xl:w-64"
          >
            <SearchIcon />
            <span className="min-w-0 flex-1 truncate">
              <span className="lg:hidden xl:inline">종목·기관·지표·메뉴 </span>검색
            </span>
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
            aria-describedby={recentHint ? recentHintId : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder="종목·기관·지표·메뉴 검색"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveId(null);
            }}
            onKeyDown={onInputKeyDown}
            // 브라우저 기본 지우기 X는 숨깁니다(QA-515) — 어두운 화면에서 굵은 흰색으로 그려져 바로 옆 대화상자 닫기 X와 헷갈렸습니다. type=search는
            // 휴대폰 자판의 검색 키 때문에 그대로 두고, 따로 지우기 단추는 두지 않습니다(Esc·닫기로 닫으면 다음에 빈 칸으로 열림).
            className="h-12 min-w-0 flex-1 bg-transparent text-[17px] text-text outline-none placeholder:text-text-3 lg:h-[38px] lg:text-base [&::-webkit-search-cancel-button]:hidden"
          />
        </div>

        {/* 범주를 아직 다 읽지 못했으면(읽는 중·실패·저장본 없음) 그 사실도 함께 읽어 줍니다 — "결과 0건"만 말하면 없는 것으로 들립니다.
            빈 검색어에 최근 연 대상이 펼쳐져 있으면 그 안내를 읽습니다 — 검색어를 쳤다가 지워 목록이 다시 펼쳐질 때 '결과 N건'에서 바뀌어 읽힙니다
            (포커스가 그대로인 입력칸의 설명이 바뀌어도 다시 읽히지 않을 수 있음, QA-560 후속). */}
        <p role="status" className="sr-only">
          {trimmed ? paletteSummary(groups, commands.length, notices) : (recentHint ?? "")}
        </p>
        {/* 같은 안내를 입력칸 설명으로도 둡니다(QA-560) — 팔레트를 여는 순간 이미 그려진 status는 라이브 영역으로 읽히지 않을 수 있고, 입력칸
            설명은 열 때 포커스를 받으며 함께 읽힙니다. 문단은 hidden(aria-describedby는 숨긴 요소도 가리킴)이라 대화상자 내용으로 status와
            같은 글이 한 번 더 읽히지 않습니다. */}
        {recentHint && (
          <p id={recentHintId} hidden>
            {recentHint}
          </p>
        )}

        {/* 결과가 없으면(입력칸이 접힘 — aria-expanded false) 빈 목록 상자를 접근성 트리에서 뺍니다. 결과 없음 안내는 위 status가 읽습니다. */}
        <div
          id={listboxId}
          role="listbox"
          aria-label="검색 결과"
          hidden={flat.length === 0}
          className="mt-3 flex max-h-[min(60dvh,28rem)] flex-col gap-3 overflow-y-auto"
        >
          {paletteGroups.map((group, groupAt) => {
            const headingId = `${baseId}-group-${group.key}`;
            return (
              <div key={group.key} role="group" aria-labelledby={headingId}>
                <div id={headingId} role="presentation" className="flex items-baseline justify-between gap-2 px-3 pb-1 text-xs font-semibold text-text-3">
                  <span>{group.label}</span>
                  {group.more > 0 && (
                    <span className="font-normal">
                      {group.options.length}개 표시 · {group.more}개 더 — 검색어를 더 입력하세요
                    </span>
                  )}
                </div>
                {group.options.map((option, itemAt) => {
                  const index = starts[groupAt] + itemAt;
                  const selected = index === activeIndex;
                  const entry = optionView(option);
                  return (
                    <div
                      key={entry.id}
                      id={optionId(index)}
                      role="option"
                      aria-selected={selected}
                      onClick={() => go(option)}
                      onMouseMove={() => {
                        if (!selected) setActiveId(entry.id);
                      }}
                      // 넓은 화면 결과 줄 40px — 두 줄(이름 20 + 보조 16) + 위아래 2px = 40px, 한 줄은 lg:min-h-10이 40px로 맞춥니다(lg:py-1이면 두 줄이 44px).
                      className={`relative flex min-h-12 cursor-pointer items-center gap-3 rounded-control px-3 py-2 lg:min-h-10 lg:py-0.5 ${selected ? "bg-surface" : ""}`}
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

        {/* 두 문단은 목록 상자처럼 위에 12px(mt-3)을 둡니다(QA-559) — 대화상자 본문은 형제 사이 간격을 각 요소의 margin이 정해, 없으면 최근 연 대상
            목록 바로 아래·입력칸 아래 경계에 0px로 붙었습니다. */}
        {trimmed === "" && (
          <p className="mt-3 px-3 text-sm text-text-2">
            메뉴 이름, 매크로 지표 이름·티커, 13F 기관 이름, 종목 이름·티커·국내 코드를 입력하세요. 지표·기관·종목은 시세·지표·뉴스를 모은 상세 화면으로
            갑니다(목록에 없는 종목은 Yahoo·네이버에서 찾음).
            {wide && " ?를 치고 Enter를 누르면 단축키 도움말을 봅니다."}
          </p>
        )}
        {trimmed !== "" && flat.length === 0 && <p className="mt-3 px-3 text-sm text-text-2">{noResultText(trimmed, notices)}</p>}
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
