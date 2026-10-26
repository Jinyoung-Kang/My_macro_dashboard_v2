"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { navSearchItems } from "@/lib/nav";
import {
  buildSearchIndex,
  indicatorEntries,
  institutionEntries,
  menuEntries,
  resultSummary,
  searchGroups,
  sourceNotice,
  tickerEntries,
  type InstitutionList,
  type SearchEntry,
} from "@/lib/search";
import type { MacroOverview, SessionUser, StockUniverseResponse } from "@/lib/types";
import { SearchIcon } from "./icons";

// 맥이면 ⌘K, 아니면 Ctrl K. 서버 렌더·하이드레이션 첫 그림은 Ctrl로 같게 그립니다(값은 브라우저에만 있음).
const noSubscribe = () => () => {};
const isMacPlatform = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
const isMacServer = () => false;

/**
 * 통합 검색(⌘K) — 메뉴·지표·기관·종목을 한 입력칸에서 찾아 그 화면으로 갑니다.
 *
 * - 여는 법: 상단바의 검색 단추(입력칸 모양), 또는 어디서든 맥은 ⌘K, 그 밖은 Ctrl+K. 닫기는 Esc·바깥 누르기·닫기 단추.
 * - 자료는 열 때만 읽습니다(닫혀 있으면 useApi 경로가 null). 세 경로 모두 회원 경로이고(AccessPolicy), 운영자 전용 자료는 읽지
 *   않습니다 — 운영자 화면은 메뉴 범주에만 있고 그것도 lib/access가 운영자에게만 넣습니다.
 * - 키보드: ↑↓로 결과를 옮기고 Enter로 갑니다(입력칸이 combobox, 결과가 listbox — aria-activedescendant).
 * - 결과는 범주마다 상한까지만 보이고 넘친 수를 범주 제목에 적습니다. 무료 회원에게 잠긴 유료 화면은 🔒.
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

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      // 한글 자판이면 K 자리가 "ㅏ"로 오기도 해 물리 키(code)도 봅니다. 자동 완성이 보내는 keydown은 key가 없을 수 있습니다.
      const isK = event.key === "k" || event.key === "K" || event.code === "KeyK";
      // 맥은 ⌘K만 받습니다 — 맥의 Ctrl+K는 입력칸의 기본 편집 명령(줄 끝까지 지우기)이라, 가로채면 메모·규칙 입력칸에서 그 명령이
      // 사라집니다. 그 밖에서는 화면 안내(Ctrl K)대로 Ctrl+K만 받습니다.
      const modifier = isMacPlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (modifier && !event.altKey && !event.shiftKey && isK) {
        // 브라우저의 같은 단축키(주소창 검색)보다 먼저 받습니다.
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // /api/macro/overview는 live 없이(저장본) — 검색 때문에 외부 시세를 새로 받지 않습니다.
  const overview = useApi<MacroOverview>(open ? endpoints.macro.overview(false) : null);
  const institutions = useApi<InstitutionList>(open ? endpoints.institution.institutions : null);
  const universe = useApi<StockUniverseResponse>(open ? endpoints.insight.stockUniverse : null);

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
  const groups = useMemo(() => searchGroups(index, query), [index, query]);
  const flat = groups.flatMap((group) => group.items);
  // 묶음마다 첫 결과의 전체 순번(↑↓·aria-activedescendant는 묶음을 넘어 한 줄로 셉니다).
  const starts = groups.map((_, at) => groups.slice(0, at).reduce((sum, group) => sum + group.items.length, 0));
  const activeIndex = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);

  const notices = [
    sourceNotice("지표", overview),
    sourceNotice("기관", institutions),
    sourceNotice("종목", universe),
  ].filter((notice): notice is string => notice !== null);

  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery("");
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

  return (
    <Dialog
      open={open}
      onOpenChange={changeOpen}
      title="통합 검색"
      hideTitle
      size="lg"
      trigger={
        <button
          type="button"
          aria-label="종목·기관·지표·메뉴 검색"
          aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"}
          className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[10px] bg-surface-2 px-3 text-left text-sm text-text-3 hover:text-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:max-w-[520px]"
        >
          <SearchIcon />
          <span className="min-w-0 flex-1 truncate">종목·기관·지표·메뉴 검색</span>
          <kbd aria-hidden="true" className="hidden shrink-0 rounded-md border border-border px-1.5 font-sans text-xs text-text-3 sm:inline">
            {isMac ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      }
    >
      <div className="mt-1 flex items-center gap-2.5 rounded-[10px] bg-surface-2 px-3 pr-10 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
        <SearchIcon />
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
          className="h-11 min-w-0 flex-1 bg-transparent text-[15px] text-text outline-none placeholder:text-text-3"
        />
      </div>

      <p role="status" className="sr-only">
        {trimmed ? resultSummary(groups) : ""}
      </p>

      <div id={listboxId} role="listbox" aria-label="검색 결과" className="mt-3 flex max-h-[min(60dvh,28rem)] flex-col gap-3 overflow-y-auto">
        {groups.map((group, groupAt) => {
          const headingId = `${baseId}-group-${group.kind}`;
          return (
            <div key={group.kind} role="group" aria-labelledby={headingId}>
              <div id={headingId} role="presentation" className="flex items-baseline justify-between gap-2 px-2 pb-1 text-xs font-semibold text-text-3">
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
                    className={`flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 ${selected ? "bg-surface-2" : ""}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[15px] text-text">
                        {entry.label}
                        {entry.locked && (
                          <span role="img" aria-label="유료 등급 기능" title="유료 등급 기능" className="ml-1">
                            🔒
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
        <p className="px-2 text-sm text-text-2">
          메뉴 이름, 매크로 지표 이름·티커, 13F 기관 이름, 종목 이름·티커를 입력하세요. 지표·기관·종목은 그 값을 고르는 화면으로 갑니다.
        </p>
      )}
      {trimmed !== "" && flat.length === 0 && (
        <p className="px-2 text-sm text-text-2">‘{trimmed}’와 맞는 결과가 없습니다.</p>
      )}
      {notices.length > 0 && (
        <ul aria-label="검색 자료 상태" className="mt-3 flex flex-col gap-1 border-t border-border px-2 pt-3 text-xs text-text-3">
          {notices.map((notice) => (
            <li key={notice}>{notice}</li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
