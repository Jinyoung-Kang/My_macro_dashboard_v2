"use client";

import { useId, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { Dialog } from "@/components/ui/Dialog";
import { FOCUS_RING, TEXT_TARGET } from "@/components/ui/classes";
import { useSideBySide } from "@/hooks/useSideBySide";
import { useWideShell } from "@/hooks/useWideShell";
import { listKeyAction } from "@/lib/shortcuts";

/**
 * 검사 칸 배치 — md: 틀 폭 32rem부터 옆 15rem(목록-검사 MasterDetail과 같음 — 두세 칸 표·목록), lg: 틀 폭 52rem부터 옆 18rem(네다섯 칸 표 — 매크로 지표 표),
 * dialog: 늘 대화상자(칸이 많아 옆 칸을 두면 표가 눌리는 표 — 섹터 11열 표).
 */
export type InspectorLayout = "md" | "lg" | "dialog";

/** 줄 단추(InspectorTrigger 또는 부르는 쪽의 단추)에 펼치는 속성 — 옆 칸 배치는 aria-controls, 대화상자 배치는 aria-haspopup·aria-expanded. */
export type InspectorTriggerProps = {
  "data-inspect-key": string;
  onClick: (event: MouseEvent<HTMLElement>) => void;
  "aria-controls"?: string;
  "aria-haspopup"?: "dialog";
  "aria-expanded"?: boolean;
};

/** 틀이 표·목록(children)에 넘기는 것. */
export type InspectorContext = {
  /** 옆 검사 칸에 보이는 키 — 표의 고른 행(DataTable selectedKey — 잉크 막대·aria-current)으로 넘깁니다. 대화상자 배치면 늘 null. */
  shownKey: string | null;
  /** 그 키를 검사합니다 — 옆 칸 배치면 고르고, 아니면 대화상자를 엽니다. */
  inspect: (key: string) => void;
  /** 줄 단추에 펼칠 속성(누르면 inspect — 누른 단추로 먼저 포커스를 옮겨 대화상자를 닫으면 그 단추로 돌아옴). */
  triggerProps: (key: string) => InspectorTriggerProps;
};

/*
 * 옆 칸 배치의 기준 폭과 크기 질의 클래스 — 틀이 @container이고, 기준 폭(rem)은 크기 질의와 같은 값이어야 합니다(useSideBySide가 같은 폭으로 동작을 바꿈).
 * Tailwind가 클래스를 글로 찾으므로 통째로 적어 둡니다. @lg = 32rem.
 */
const SIDE: Record<Exclude<InspectorLayout, "dialog">, { minRem: number; grid: string; panel: string }> = {
  md: { minRem: 32, grid: "@lg:grid-cols-[minmax(0,1fr)_15rem]", panel: "@lg:sticky @lg:top-4" },
  lg: { minRem: 52, grid: "@min-[52rem]:grid-cols-[minmax(0,1fr)_18rem]", panel: "@min-[52rem]:sticky @min-[52rem]:top-4" },
};

const DEFAULT_HINT = "줄을 고르면 이 칸에 자세한 값이 나옵니다.";
const VANISHED = "고른 줄이 지금 자료에 없습니다. 다른 줄을 고르세요.";

/**
 * 표·목록의 검사 칸 틀(작업대 실행 명세 §6 SplitPane/MasterDetail 묶음 — 처음 쓰는 곳 매크로 지표 표·섹터 표 P5a, P5b 보유 표·P6 계좌 비교 표):
 * 표(공용 DataTable 등 — 줄 안에 링크·단추가 있는 표)는 부르는 쪽이 그리고, 틀은 고른 줄의 자세한 값을 옆 검사 칸이나 대화상자로 보입니다.
 * 목록 줄 전체가 단추인 목록은 MasterDetail을 씁니다(이 틀은 줄 안 조작이 있는 표 — 줄 이름 칸의 `InspectorTrigger`가 여는 단추).
 *
 * - 옆 검사 칸: 넓은 화면(lg 이상 — useWideShell)이고 틀 폭이 배치의 기준(md 32rem·lg 52rem) 이상이면 표 오른쪽에(크기 질의 — md 15rem·lg 18rem, 스크롤 영역
 *   위쪽에 붙음). 이름 있는 영역 '{label} — {고른 줄 제목}'(고른 줄이 없으면 '{label} — 고른 줄 없음'), 제목(기본 h3 — `headingLevel`) + `renderDetail`.
 *   고른 줄이 없으면 안내 글(`inspectorHint`), `defaultKey`를 주면 아무것도 고르지 않았을 때 그 키를 보입니다(onSelectedKeyChange를 부르지 않음 —
 *   MasterDetail autoSelectFirst와 같은 뜻, 사용자가 고르거나 풀면 그 뒤로는 저절로 보이지 않음).
 *   고른 키의 제목(`titleOf`)이 null이면 자료에서 사라진 키 — 고름이 풀린 것처럼 행 표시가 없고 검사 칸에 그 사실을 적습니다.
 *   Esc(lib/shortcuts listKeyAction 'close' — 틀 안에 포커스가 있을 때)는 사용자가 고른 것이 있을 때만 풂니다(기본 키만 보일 때는 키를 그대로 둠).
 *   검사 칸 안에서 누른 Esc면 풀기 전에 포커스를 그 키의 줄 단추(`data-inspect-key`)로 옮깁니다 — 내용이 사라져 포커스가 body로 떨어지지 않게(QA-642).
 * - 대화상자: 좁은 화면, 넓은 화면의 좁은 틀(기준 폭 미만 — ResizeObserver로 잼, `hooks/useSideBySide`), `layout="dialog"`. 공용 Dialog(넓은 폭·위쪽 고정,
 *   이름 = 제목)로 열고 닫으면 연 단추로 포커스가 돌아옵니다. 줄 단추에는 aria-haspopup="dialog"·aria-expanded.
 * - 대화상자 배치에서 옆 칸 배치로 바뀌면(창을 넓힘·왼쪽 메뉴 접기) 열려 있던 대화상자의 키를 고르고 대화상자를 닫습니다(MasterDetail QA-590과 같은 규칙).
 *   반대로 좁아질 때는 대화상자를 저절로 열지 않습니다(고른 키는 남아 다시 넓어지면 보임).
 * - `renderDetail`은 PropertyList·링크·자리표시(Skeleton·ErrorState)를 그립니다 — 펼칠 때 읽는 자세한 값은 그 안의 자식이 읽습니다(틀은 읽지 않음).
 * - 데이터 영역이라 강조 파랑을 쓰지 않습니다(줄 단추는 중립 잉크 — InspectorTrigger, 고른 행은 표의 잉크 막대 — 데이터 칸 강조색 금지 목록).
 */
export function InspectorFrame({
  label,
  layout = "md",
  titleOf,
  renderDetail,
  selectedKey,
  onSelectedKeyChange,
  defaultKey = null,
  inspectorHint = DEFAULT_HINT,
  headingLevel = 3,
  children,
}: {
  /** 검사 칸 영역 이름의 앞부분 — 예 '지표 미리보기'. */
  label: string;
  layout?: InspectorLayout;
  /** 검사 칸 제목·대화상자 이름. null이면 자료에서 사라진 키입니다. */
  titleOf: (key: string) => string | null;
  /** 검사 칸·대화상자 내용. */
  renderDetail: (key: string) => ReactNode;
  /** 주면 고른 키를 부르는 쪽이 쥡니다. */
  selectedKey?: string | null;
  onSelectedKeyChange?: (key: string | null) => void;
  /** 옆 칸 배치에서 아무것도 고르지 않았을 때 보일 키(콜백 없음). */
  defaultKey?: string | null;
  inspectorHint?: string;
  /** 검사 칸 제목의 단계 — 기본 3(패널 h2 안의 표). */
  headingLevel?: 2 | 3 | 4;
  children: (inspector: InspectorContext) => ReactNode;
}): JSX.Element {
  const wide = useWideShell();
  const side = layout === "dialog" ? null : SIDE[layout];
  const frameRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const measured = useSideBySide(frameRef, wide && side !== null, side?.minRem ?? 32);
  // 옆 검사 칸인가 — 넓은 화면·옆 칸 배치이고 틀 폭이 기준 이상(재지 못했으면 크기 질의 배치에 맡김). 아니면 대화상자로 엽니다.
  const inline = wide && side !== null && measured !== false;
  const Heading = headingLevel === 2 ? "h2" : headingLevel === 4 ? "h4" : "h3";
  const baseId = useId();
  const inspectorId = `${baseId}-inspector`;
  const [ownSelected, setOwnSelected] = useState<string | null>(null);
  // 사용자가 고르거나 푼 뒤에는 기본 키를 저절로 보이지 않습니다.
  const [autoOff, setAutoOff] = useState(false);
  const [dialogKey, setDialogKey] = useState<string | null>(null);

  const chosen = selectedKey !== undefined ? selectedKey : ownSelected;
  const vanished = chosen !== null && titleOf(chosen) === null;
  const fallback = !autoOff && chosen === null && defaultKey !== null && titleOf(defaultKey) !== null ? defaultKey : null;
  const shownKey = inline ? (chosen !== null ? (vanished ? null : chosen) : fallback) : null;
  const shownTitle = shownKey === null ? null : titleOf(shownKey);
  const dialogTitle = !inline && dialogKey !== null ? titleOf(dialogKey) : null;

  const select = (key: string | null) => {
    setAutoOff(true);
    if (selectedKey === undefined) setOwnSelected(key);
    onSelectedKeyChange?.(key);
  };

  // 대화상자로 연 키가 자료에서 사라지면(새로 읽은 자료에 그 줄이 없음) 대화상자는 닫혀 그려지고, 여기서 닫은 것으로 둡니다 — 남겨 두면 그 줄이 다시 오는
  // 새로 읽기에서 대화상자가 저절로 다시 열렸습니다.
  // 대화상자 배치 → 옆 칸 배치로 바뀌는 그리기: 열려 있던 대화상자의 키를 고르고 대화상자를 닫습니다(그대로 두면 다시 좁아질 때 저절로 다시 열림).
  // 고름이 부르는 쪽(onSelectedKeyChange)에 닿으므로 그리는 중이 아니라 화면에 칠하기 전(layout effect)에 맞춥니다 — select와 같은 일을 풀어 씀(의존을 값으로).
  useLayoutEffect(() => {
    if (dialogKey === null) return;
    if (titleOf(dialogKey) === null) {
      setDialogKey(null);
      return;
    }
    if (!inline) return;
    const key = dialogKey;
    setDialogKey(null);
    if (key === chosen) return;
    setAutoOff(true);
    if (selectedKey === undefined) setOwnSelected(key);
    onSelectedKeyChange?.(key);
  }, [inline, dialogKey, chosen, titleOf, selectedKey, onSelectedKeyChange]);

  const inspect = (key: string) => {
    if (inline) {
      if (key !== chosen) select(key);
    } else {
      setDialogKey(key);
    }
  };

  const triggerProps = (key: string): InspectorTriggerProps => ({
    "data-inspect-key": key,
    onClick: (event) => {
      // 누르기가 포커스를 옮기지 않는 브라우저(사파리)에서도 대화상자를 닫은 뒤 이 단추로 돌아오게 먼저 포커스를 둡니다.
      event.currentTarget.focus();
      inspect(key);
    },
    ...(inline ? { "aria-controls": inspectorId } : { "aria-haspopup": "dialog" as const, "aria-expanded": dialogKey === key }),
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!inline || chosen === null || event.defaultPrevented) return;
    if (listKeyAction(event.nativeEvent) !== "close") return;
    event.preventDefault();
    // 검사 칸 안(내용의 링크 등)에서 누른 Esc — 고름을 풀면 그 내용이 사라져 포커스가 body로 떨어지므로(QA-642), 풀기 전에 그 키의 줄 단추로 포커스를
    // 옮깁니다(대화상자를 닫을 때 연 단추로 돌아오는 것과 같은 규칙). 줄 단추를 찾지 못하면(부르는 쪽이 triggerProps를 펼치지 않음) 포커스는 그대로입니다.
    if (event.target instanceof Node && panelRef.current?.contains(event.target)) {
      const row = [...(frameRef.current?.querySelectorAll<HTMLElement>("[data-inspect-key]") ?? [])].find(
        (element) => element.getAttribute("data-inspect-key") === chosen && !panelRef.current?.contains(element),
      );
      row?.focus();
    }
    select(null);
  };

  let panelBody: ReactNode;
  if (shownKey !== null && shownTitle !== null) {
    panelBody = (
      <>
        <Heading className="break-keep wrap-anywhere text-heading-sm text-text">{shownTitle}</Heading>
        <div className="mt-2 min-w-0">{renderDetail(shownKey)}</div>
      </>
    );
  } else {
    panelBody = <p className="text-sm text-text-2">{vanished ? VANISHED : inspectorHint}</p>;
  }

  return (
    // 틀 안 포커스의 Esc만 받습니다(셸 단축키 아님) — 키보드 조작은 안의 표·단추가 받고 이 상자는 거기서 올라온 Esc를 봅니다.
    <div ref={frameRef} onKeyDown={onKeyDown} className="@container min-w-0">
      <div className={`grid min-w-0 gap-3 ${inline && side ? side.grid : ""}`.trim()}>
        <div className="min-w-0">{children({ shownKey, inspect, triggerProps })}</div>
        {inline && side ? (
          // 옆에 놓이면 스크롤 영역 위쪽에 붙어 따라옵니다(긴 표 아래쪽 줄을 골라도 검사 내용이 보임) — self-start가 있어야 격자 칸 안에서 붙습니다.
          <section
            ref={panelRef}
            id={inspectorId}
            aria-label={`${label} — ${shownTitle ?? "고른 줄 없음"}`}
            className={`min-w-0 self-start rounded-control border border-border p-3 ${side.panel}`}
          >
            {panelBody}
          </section>
        ) : null}
      </div>
      {/* 좁은 화면·좁은 틀·대화상자 배치의 검사 대화상자 — 닫혀 있으면 내용이 DOM에 없습니다. 옆 칸 배치로 바뀌면 닫힙니다(위 효과). */}
      <Dialog
        open={dialogTitle !== null}
        onOpenChange={(open) => {
          if (!open) setDialogKey(null);
        }}
        title={dialogTitle ?? label}
        size="lg"
        placement="top"
      >
        {dialogTitle !== null && dialogKey !== null ? <div className="mt-3 min-w-0">{renderDetail(dialogKey)}</div> : null}
      </Dialog>
    </div>
  );
}

/**
 * 줄 단추 — 표의 이름 칸에 두는 검사 여는 단추(`triggerProps`를 펼침). 데이터 칸이라 강조 파랑이 아니라 중립 잉크(본문색)이고 마우스를 올리면 밑줄,
 * 좁은 화면(lg 미만) 누르는 자리 44px(TEXT_TARGET)·넓은 화면 글 높이, 포커스 링. 이름은 말줄임 없이 낱말 사이에서 꺾습니다.
 */
const TRIGGER = `${TEXT_TARGET} rounded-sm text-left text-text break-keep underline-offset-2 hover:underline ${FOCUS_RING}`;

export function InspectorTrigger({
  inspector,
  itemKey,
  children,
  className = "",
}: {
  inspector: InspectorContext;
  itemKey: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <button type="button" {...inspector.triggerProps(itemKey)} className={`${TRIGGER} ${className}`.trim()}>
      {children}
    </button>
  );
}
