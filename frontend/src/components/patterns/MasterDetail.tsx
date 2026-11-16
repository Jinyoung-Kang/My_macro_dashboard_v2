"use client";

import { useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";

import { Dialog } from "@/components/ui/Dialog";
import { FOCUS_RING, SELECTED_BAR } from "@/components/ui/classes";
import { useWideShell } from "@/hooks/useWideShell";
import { listKeyAction, SHELL_LIST_ATTR } from "@/lib/shortcuts";

const DEFAULT_HINT = "줄을 고르면 이 칸에 자세한 값이 나옵니다(j/k·↑↓로 옮김).";

/**
 * 줄 단추 — 좁은 화면(lg 미만) 44px 누름 자리, 넓은 화면 32px(14/20 글 + 위 6px + 아래 5px + 구분선 1px, 마지막 줄은 위아래 6px — DataTable과 같은 셈).
 * 마우스를 올린 줄·고른 줄은 중립 바탕(surface-2)이고 고른 줄에는 왼쪽 3px 잉크 막대(SELECTED_BAR) — 데이터 영역이라 강조 파랑을 쓰지 않습니다(A1).
 */
const ROW = `relative flex min-h-11 w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-body text-text hover:bg-surface-2 motion-safe:transition-colors lg:min-h-0 ${FOCUS_RING}`;
const ROW_LINED = "border-b border-border-subtle lg:pt-1.5 lg:pb-[5px]";
const ROW_LAST = "lg:py-1.5";

/** 검사 칸이 목록 옆에 놓이는 칸 폭(rem) — 아래 크기 질의 `@lg`(32rem)와 같은 값입니다. 바꾸면 둘을 함께 고칩니다. */
const SIDE_MIN_REM = 32;

/**
 * 목록-검사 틀의 폭이 검사 칸을 옆에 둘 만한가(32rem 이상) — ResizeObserver로 잽니다. 폭이 0이면(숨긴 탭 안·배치를 하지 않는 시험 대역) 모른다(null)로 두고,
 * 보이게 되어 폭이 생기면 그때 정합니다. 크기 질의(CSS)가 자리를 정하고, 이 값은 아래로 쌓인 배치에서 동작(대화상자로 엶)을 바꾸는 데 씁니다.
 */
function useSideBySide(ref: RefObject<HTMLDivElement | null>, enabled: boolean): boolean | null {
  const [side, setSide] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return undefined;
    const measure = () => {
      const width = element.getBoundingClientRect().width;
      if (!(width > 0)) return;
      const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setSide(width >= SIDE_MIN_REM * rem);
    };
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return side;
}

/**
 * 목록-검사(작업대 실행 명세 §6 SplitPane/MasterDetail — 상세 화면의 보유 탭 등, P4): 왼쪽 목록에서 줄을 고르면 그 줄의 자세한 값을 검사 칸에.
 *
 * - 넓은 화면(lg 이상 — 왼쪽 메뉴가 보이는 폭, useWideShell)이고 이 틀의 폭이 32rem 이상이면: 목록 오른쪽에 검사 칸(15rem — 크기 질의 @container, 그래서 이
 *   부품의 바깥은 폭을 정해 주는 자리여야 합니다: 격자 minmax(0,1fr)·flex 늘임 등, 내용 폭에 맞춰 줄어드는 부모 안에서는 크기 질의 기준이 0으로 줄어듦).
 *   검사 칸은 이름 있는 영역 '{목록 이름} — {고른 줄 이름}'(낭독기 영역 목록에서 무엇을 위한 칸인지 보이게 — 고른 줄이 없으면 '{목록 이름} — 고른 줄 없음')이고,
 *   고른 줄 이름은 제목(h3)으로도 보입니다. 고른 줄이 없으면 안내 글(`inspectorHint`)입니다. 목록이 길어도 고른 줄의 내용이 화면 밖에서 바뀌지
 *   않게 검사 칸은 스크롤 영역 위쪽에 붙어 따라옵니다(sticky).
 *   고름이 포커스를 따라갑니다 — j/k·↑↓·Home·End가 포커스와 고름을 함께 옮기고, 누르기·Enter·Space도 고릅니다. Esc는 고른 줄이 있을 때만 고름을 풉니다.
 *   줄 단추는 고른 줄에 aria-current="true", 모든 줄에 aria-controls(검사 칸).
 * - 넓은 화면이라도 틀의 폭이 32rem 미만이면(1024~약 1053·1280~약 1357의 좁은 가운데 칸 — 기본 폭 나무 메뉴, 잰 값은 진행 기록 §P4) 검사 칸을 목록 아래에
 *   두지 않고 좁은 화면처럼 대화상자로 엽니다 — 아래로 쌓으면 30줄 목록에서 고름이 바뀐 내용이 약 1,350px 아래(화면 밖)에서 그려졌습니다. 폭은
 *   ResizeObserver로 재고(폭 0 — 숨긴 탭·시험 대역 — 이면 모름으로 두고 크기 질의 배치 그대로), 폭이 바뀌면 동작도 따라 바뀝니다.
 * - 좁은 화면(과 위의 좁은 틀): 목록만. 키는 포커스만 옮기고, 누르기·Enter·Space가 공용 대화상자(위쪽 고정·넓은 폭)로 검사 내용을 엽니다(줄 단추 aria-haspopup="dialog").
 *   닫으면 그 줄로 포커스가 돌아갑니다(대화상자의 여는 단추 되돌리기). Esc는 대화상자(Radix)가 닫습니다. 화면을 열 때 대화상자가 저절로 열리지 않게
 *   `autoSelectFirst`는 넓은 화면에서만 씁니다.
 * - 목록 키는 목록에 포커스가 있을 때만 이 목록이 받습니다(셸 단축키 아님 — 판정은 lib/shortcuts listKeyAction, 도움말 창의 '목록' 묶음은 이 목록의
 *   data-shell-list 표지로 보임). 처리한 키만 기본 동작을 막습니다. Tab 정지점은 목록에 하나(roving tabindex — 고른 줄, 없으면 마지막 포커스 줄·첫 줄).
 * - 줄 내용(`renderItem`)은 단추 안이라 링크·단추를 넣지 않습니다 — 그런 것은 검사 칸(`renderDetail`)에 둡니다. 줄 안 조작이 필요하면 이 부품이 아니라 DataTable입니다.
 * - `autoSelectFirst`의 첫 줄은 보이는 고름일 뿐 `onSelectedKeyChange`를 부르지 않습니다(사용자가 고르거나 닫으면 그때부터 부름). Esc로 닫은 뒤에는 다시 저절로
 *   고르지 않습니다.
 * - 줄이 없으면 `emptyText`, 불러오는 중·오류면 `placeholder`(목록 대신). `count`는 목록 위 개수 줄('12건' — 함수면 그 글).
 */
export function MasterDetail<T>({
  label,
  items,
  itemKey,
  itemLabel,
  renderItem,
  renderDetail,
  selectedKey,
  onSelectedKeyChange,
  autoSelectFirst = false,
  count,
  emptyText = "표시할 항목이 없습니다.",
  placeholder,
  inspectorHint = DEFAULT_HINT,
}: {
  /** 목록 이름(ul aria-label) — 예 '상위 보유 종목'. */
  label: string;
  items: readonly T[];
  itemKey: (item: T) => string;
  /** 검사 칸 제목(h3)·대화상자 이름 — 줄 단추 안에는 `renderItem`만 그립니다(줄 단추 이름은 그 글). */
  itemLabel: (item: T) => string;
  /** 줄 내용(단추 안 — 링크·단추를 넣지 않음). */
  renderItem: (item: T) => ReactNode;
  /** 검사 칸 내용(PropertyList·링크). */
  renderDetail: (item: T) => ReactNode;
  /** 주면 고른 줄을 부르는 쪽이 쥡니다. */
  selectedKey?: string | null;
  onSelectedKeyChange?: (key: string | null) => void;
  /** 넓은 화면에서 고른 줄이 없으면 첫 줄을 보입니다. */
  autoSelectFirst?: boolean;
  count?: boolean | ((count: number) => string);
  emptyText?: ReactNode;
  placeholder?: ReactNode;
  inspectorHint?: string;
}): JSX.Element {
  const wide = useWideShell();
  const frameRef = useRef<HTMLDivElement>(null);
  const side = useSideBySide(frameRef, wide);
  // 검사 칸을 목록 옆에 두는가 — 넓은 화면이고 틀 폭이 32rem 이상(재지 못했으면 크기 질의 배치에 맡김). 아니면 좁은 화면처럼 대화상자로 엽니다.
  const inline = wide && side !== false;
  const baseId = useId();
  const inspectorId = `${baseId}-inspector`;
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  // 사용자가 직접 고르거나 닫은 뒤에는 첫 줄을 저절로 고르지 않습니다.
  const [autoOff, setAutoOff] = useState(false);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [dialogKey, setDialogKey] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const keys = items.map(itemKey);
  const chosen = selectedKey !== undefined ? selectedKey : ownSelected;
  const known = chosen !== null && keys.includes(chosen) ? chosen : null;
  const autoKey = inline && autoSelectFirst && !autoOff && keys.length > 0 ? keys[0] : null;
  // 옆 검사 칸의 고른 줄(검사 칸에 보이는 줄). 대화상자로 여는 배치에는 고른 줄이 없습니다.
  const current = inline ? (known ?? autoKey) : null;
  const currentItem = current === null ? null : items[keys.indexOf(current)];
  const tabStop = current ?? (focusKey !== null && keys.includes(focusKey) ? focusKey : null) ?? keys[0] ?? null;
  // 옆 검사 칸 배치로 바뀌면 열려 있던 대화상자를 닫은 것으로 칩니다 — 그대로 두면 다시 좁아질 때 대화상자가 저절로 다시 열립니다(그리는 중 상태 맞추기).
  if (inline && dialogKey !== null) setDialogKey(null);
  const dialogIndex = !inline && dialogKey !== null ? keys.indexOf(dialogKey) : -1;
  const dialogItem = dialogIndex >= 0 ? items[dialogIndex] : null;

  const select = (key: string | null) => {
    setAutoOff(true);
    if (selectedKey === undefined) setOwnSelected(key);
    onSelectedKeyChange?.(key);
  };

  const onRowClick = (key: string, event: MouseEvent<HTMLButtonElement>) => {
    // 누르기가 포커스를 옮기지 않는 브라우저(사파리)에서도 대화상자를 닫은 뒤 이 줄로 돌아오게 먼저 포커스를 둡니다.
    event.currentTarget.focus();
    setFocusKey(key);
    if (inline) {
      if (key !== current) select(key);
    } else {
      setDialogKey(key);
    }
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const action = listKeyAction(event.nativeEvent);
    if (action === null || keys.length === 0) return;
    if (action === "close") {
      if (inline && current !== null) {
        event.preventDefault();
        select(null);
      }
      return;
    }
    const fromKey = (event.target as HTMLElement).closest?.("[data-item-key]")?.getAttribute("data-item-key") ?? tabStop;
    const from = fromKey === null ? -1 : keys.indexOf(fromKey);
    const last = keys.length - 1;
    const to =
      action === "first" ? 0 : action === "last" ? last : action === "next" ? Math.min(from + 1, last) : Math.max(from - 1, 0);
    event.preventDefault();
    const key = keys[to];
    buttons.current.get(key)?.focus();
    setFocusKey(key);
    if (inline && key !== current) select(key);
  };

  const countText =
    count === undefined || count === false ? null : typeof count === "function" ? count(items.length) : `${items.length.toLocaleString("ko-KR")}건`;
  const hasPlaceholder = placeholder !== undefined && placeholder !== null && placeholder !== false;

  let list: ReactNode;
  if (hasPlaceholder) {
    list = <div className="min-w-0">{placeholder}</div>;
  } else if (items.length === 0) {
    list = <div className="min-w-0 py-1 text-sm text-text-2">{emptyText}</div>;
  } else {
    list = (
      <ul aria-label={label} {...{ [SHELL_LIST_ATTR]: "" }} onKeyDown={onListKeyDown} className="flex min-w-0 flex-col">
        {items.map((item, index) => {
          const key = keys[index];
          const isCurrent = key === current;
          return (
            <li key={key} className="min-w-0">
              <button
                type="button"
                ref={(element) => {
                  if (element) buttons.current.set(key, element);
                  else buttons.current.delete(key);
                }}
                data-item-key={key}
                tabIndex={key === tabStop ? 0 : -1}
                aria-current={inline && isCurrent ? "true" : undefined}
                aria-controls={inline ? inspectorId : undefined}
                aria-haspopup={inline ? undefined : "dialog"}
                aria-expanded={inline ? undefined : dialogKey === key}
                onClick={(event) => onRowClick(key, event)}
                onFocus={() => setFocusKey(key)}
                className={`${ROW} ${index === items.length - 1 ? ROW_LAST : ROW_LINED} ${isCurrent ? "bg-surface-2" : ""}`.trim()}
              >
                {isCurrent ? <span aria-hidden="true" className={SELECTED_BAR} /> : null}
                <span className="min-w-0 flex-1">{renderItem(item)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div ref={frameRef} className="@container min-w-0">
      {countText !== null && !hasPlaceholder ? <p className="mb-1 text-xs tabular-nums text-text-2">{countText}</p> : null}
      <div className={`grid min-w-0 gap-3 ${inline ? "@lg:grid-cols-[minmax(0,1fr)_15rem]" : ""}`.trim()}>
        {list}
        {inline && !hasPlaceholder && items.length > 0 ? (
          // 옆에 놓이면 스크롤 영역 위쪽에 붙어 따라옵니다(긴 목록 아래쪽 줄을 골라도 검사 내용이 보임) — self-start가 있어야 격자 칸 안에서 붙습니다.
          <section
            id={inspectorId}
            aria-label={`${label} — ${currentItem !== null && currentItem !== undefined ? itemLabel(currentItem) : "고른 줄 없음"}`}
            className="min-w-0 self-start rounded-control border border-border p-3 @lg:sticky @lg:top-4"
          >
            {currentItem !== null && currentItem !== undefined ? (
              <>
                <h3 className="break-keep wrap-anywhere text-heading-sm text-text">{itemLabel(currentItem)}</h3>
                <div className="mt-2 min-w-0">{renderDetail(currentItem)}</div>
              </>
            ) : (
              <p className="text-sm text-text-2">{inspectorHint}</p>
            )}
          </section>
        ) : null}
      </div>
      {/* 좁은 화면·좁은 틀의 검사 대화상자 — 닫혀 있으면 내용이 DOM에 없습니다. 옆 검사 칸 배치로 바뀌면(dialogItem이 없어짐) 닫힙니다. */}
      <Dialog
        open={dialogItem !== null && dialogItem !== undefined}
        onOpenChange={(open) => {
          if (!open) setDialogKey(null);
        }}
        title={dialogItem !== null && dialogItem !== undefined ? itemLabel(dialogItem) : label}
        size="lg"
        placement="top"
      >
        {dialogItem !== null && dialogItem !== undefined ? <div className="mt-3 min-w-0">{renderDetail(dialogItem)}</div> : null}
      </Dialog>
    </div>
  );
}
