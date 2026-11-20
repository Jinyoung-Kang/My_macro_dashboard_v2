"use client";

import { useEffect, useId, useState, type FormEvent, type KeyboardEvent } from "react";
import { buttonClasses, SELECTED_BAR } from "@/components/ui/classes";
import { SearchIcon, SpinnerIcon } from "@/components/ui/icons";
import { useInfoSearchSuggest } from "@/hooks/useInfoSearch";
import { entityKindLabel } from "@/lib/infoSearch";
import type { SearchCandidate } from "@/lib/types";
import { KindIcon } from "./parts";

/**
 * 정보 검색의 검색창 — 치는 동안은 수집기가 이미 가진 색인으로 후보만(외부 호출 없음), Enter나 '찾기'는 그 검색어로 풀기(후보 보기).
 * 후보는 ↓↑로 골라야만 Enter가 그 후보를 엽니다 — 후보가 여럿일 때 자동으로 고르지 않습니다(계약 3-2). '/'로 이 칸에 옵니다 — 입력칸에 셸의 거르기 칸
 * 표지(data-shell-filter — lib/shortcuts)를 달아 셸 단축키(hooks/useShellShortcuts)가 '/'를 이 칸으로 보내고(포커스 + 글 고름) 단축키 도움말이 '/' 줄을
 * 보입니다. 이 화면이 따로 '/'를 받던 처리는 정보 검색 정리(작업대 P7)에서 셸 하나로 합쳤습니다.
 */
export function SearchBox({
  initial,
  onSubmit,
  onChoose,
}: {
  /** 주소의 검색어(후보 보기) — 바뀌면 칸의 글도 따라갑니다(뒤로 가기). 대상을 연 동안(null)은 친 글을 그대로 둡니다. */
  initial: string | null;
  onSubmit: (query: string) => void;
  onChoose: (candidate: SearchCandidate) => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const baseId = useId();
  const listId = `${baseId}-suggest`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (initial !== null) setValue(initial);
  }, [initial]);

  const suggest = useInfoSearchSuggest(value, open);
  const items = suggest.items;
  const expanded = open && items.length > 0;
  const activeIndex = expanded && active < items.length ? active : -1;

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const query = value.trim();
    if (!query) return;
    close();
    onSubmit(query);
  };

  const choose = (candidate: SearchCandidate) => {
    close();
    onChoose(candidate);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 한글 조합 중의 Enter·화살표는 입력기가 씁니다.
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      if (expanded) {
        event.preventDefault();
        close();
      }
      return;
    }
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length > 0) {
      event.preventDefault();
      setOpen(true);
      const next =
        event.key === "ArrowDown" ? Math.min(activeIndex + 1, items.length - 1) : Math.max(activeIndex - 1, -1);
      setActive(next);
      if (next >= 0) document.getElementById(optionId(next))?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) choose(items[activeIndex]);
      else submit();
    }
  };

  const emptyNote =
    open && value.trim() && !suggest.loading && items.length === 0
      ? suggest.message || suggest.error
        ? `후보를 받지 못했습니다 — ${suggest.message ?? suggest.error}. Enter로 찾을 수는 있습니다.`
        : "가진 색인에 맞는 후보가 없습니다 — Enter로 찾을 수는 있습니다."
      : "";

  return (
    <form role="search" aria-label="정보 검색" onSubmit={submit} className="relative flex items-stretch gap-2">
      <div className="relative min-w-0 flex-1">
        <div className="flex min-h-11 items-center gap-2 rounded-control border border-border-strong bg-surface px-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus lg:min-h-[30px]">
          <SearchIcon size={16} className="text-text-3" />
          <input
            type="search"
            role="combobox"
            aria-label="대상 검색"
            aria-expanded={expanded}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-keyshortcuts="/"
            data-shell-filter=""
            autoComplete="off"
            spellCheck={false}
            maxLength={60}
            placeholder="기업·기관·사람 이름, 티커·종목코드, 주제 — 예: NVIDIA, 삼성전자, Ken Griffin"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={close}
            onKeyDown={onKeyDown}
            className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none placeholder:text-text-3"
          />
          {suggest.loading ? <SpinnerIcon size={14} className="text-text-3 motion-safe:animate-spin" /> : null}
          <kbd aria-hidden="true" className="hidden rounded-sm border border-border px-1 font-sans text-xs text-text-3 lg:inline">
            /
          </kbd>
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="입력 후보"
          hidden={!expanded}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-control border border-border-overlay bg-surface-2 py-1 shadow-overlay"
        >
          {items.map((candidate, index) => (
            <div
              key={`${candidate.key ?? "name"}:${candidate.name}:${index}`}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              // 누르기 전에 입력칸이 포커스를 잃어 목록이 닫히지 않게 합니다.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(candidate)}
              onMouseMove={() => setActive(index)}
              // 고른 줄은 덮개 안 눌림 면(surface-3 — QA-858)이라 그 위 보조 글·아이콘은 text-2입니다(surface-3 위 text-3 금지 — 명세 §3-2). 보조 글·아이콘은
              // 이 줄의 글자색을 물려받고(고르지 않은 줄 text-3), 이름은 늘 text입니다.
              className={`relative flex min-h-11 cursor-pointer items-center gap-2 px-3 py-1 text-sm lg:min-h-8 ${index === activeIndex ? "bg-surface-3 text-text-2" : "text-text-3"}`}
            >
              {index === activeIndex ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
              <span className="shrink-0">
                <KindIcon kind={candidate.kind} size={14} />
              </span>
              {/* 이름은 두 줄까지(그 뒤에만 말줄임), 보조 글은 줄어드는 칸이라 이름보다 먼저 줄고 폭의 45%를 넘지 않습니다 — 보조 글이 줄지 않던 때는
                  390에서 긴 보조 글이 이름을 몇 글자로 밀어냈습니다(QA-857). */}
              <span className="min-w-0 flex-1 break-keep wrap-anywhere line-clamp-2 text-text">{candidate.name}</span>
              <span className="min-w-0 max-w-[45%] truncate text-xs">
                {[entityKindLabel(candidate.kind), candidate.sub].filter(Boolean).join(" · ")}
              </span>
            </div>
          ))}
        </div>
        {/* 받지 못한 경우와 0건인 경우 모두 한 줄로 알립니다 — 0건에 아무 글이 없으면 낭독기 사용자에게 '결과 없음'이 전해지지 않았습니다(QA-860).
            알림 영역은 늘 두고 글만 바꿉니다 — 조건이 참일 때 영역째 새로 붙이면 그 첫 글을 낭독기가 대체로 읽지 않았습니다(QA-870). 글이 없으면
            눈에 보이지 않게(sr-only — 절대 위치라 자리를 차지하지 않음) 두어 보이는 자리는 QA-860 그대로입니다. */}
        <p role="status" className={emptyNote ? "mt-1 text-xs text-text-3" : "sr-only"}>
          {emptyNote}
        </p>
      </div>
      <button type="submit" className={buttonClasses("primary")}>
        찾기
      </button>
    </form>
  );
}
