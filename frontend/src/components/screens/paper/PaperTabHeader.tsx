"use client";

import { createContext, useContext, useMemo, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { NativeSelect } from "@/components/ui";
import { ActionBar, type ActionBarItem } from "@/components/ui/ActionBar";

/**
 * 모의매매 머리 칸 계약(작업대 P6 — 명세 §7-1 '한 줄 머리: 제목 · 시장 · 계좌 선택 · 동작'). 머리(PaperScreen)가 칸 둘(계좌 고르기·동작)을 두고, 탭 패널 안의
 * 섹션이 자기 계좌 고르기 상자와 동작 목록을 그 칸으로 보냅니다(React 포털). 고르기·동작의 상태와 확인 창(ConfirmDialog)·화면 안 확인 상자·결과 알림은
 * 섹션에 그대로 남습니다 — 칸으로 가는 것은 조작 요소뿐입니다.
 *
 * - 공급자(`PaperHeaderSlotsProvider`) 안: 칸 요소가 생기면 그 칸으로 그리고(createPortal), 칸이 아직 null이면 아무것도 그리지 않습니다 — 서버 그리기와
 *   첫 하이드레이션에는 칸이 없어 둘이 같고, 칸이 생기는 다음 그리기에서 나타납니다.
 * - 공급자 밖(섹션만 그린 시험 등): 제자리에 그립니다.
 * - 한 번에 탭 패널 하나만 마운트되므로 칸을 다투는 일이 없습니다. 탭을 바꾸면 섹션과 함께 칸의 내용도 빠집니다.
 * - 이 파일은 패턴 단계가 만들고 세 갈래(셸·로그·설정)가 함께 쓰는 계약이라 얼립니다 — 바꿀 일이 생기면 통합 단계에서.
 */
type Slots = { account: HTMLElement | null; actions: HTMLElement | null };

const PaperHeaderSlotsContext = createContext<Slots | null>(null);

/** 머리 칸 공급자 — 칸 요소는 머리가 콜백 ref로 받아(상태) 넘깁니다. */
export function PaperHeaderSlotsProvider({
  account,
  actions,
  children,
}: {
  account: HTMLElement | null;
  actions: HTMLElement | null;
  children: ReactNode;
}): JSX.Element {
  const value = useMemo(() => ({ account, actions }), [account, actions]);
  return <PaperHeaderSlotsContext.Provider value={value}>{children}</PaperHeaderSlotsContext.Provider>;
}

/** 칸 하나로 보내기 — 공급자 안이면 그 칸(없으면 null), 밖이면 제자리. */
function HeaderSlot({ slot, children }: { slot: keyof Slots; children: ReactNode }): JSX.Element | null {
  const slots = useContext(PaperHeaderSlotsContext);
  if (slots === null) return <>{children}</>;
  const target = slots[slot];
  return target ? createPortal(children, target) : null;
}

/** 계좌 고르기 상자의 선택지. */
export type PaperAccountOption = { value: string; label: string };

/**
 * 머리의 계좌 고르기 — 공용 고르기 상자(NativeSelect md — 넓은 화면 30px·좁은 화면 44px, 머리 단추와 같은 높이)에 이름(`label`, 기본 '계좌 고르기')을 붙이고,
 * 보이는 짧은 글 '계좌'는 읽기에서 뺍니다(이름 '계좌 고르기'에 들어 있음 — 보이는 글이 이름 안에, WCAG 2.5.3). 선택지가 없으면 그리지 않습니다.
 */
export function PaperTabAccount({
  label = "계좌 고르기",
  value,
  options,
  onChange,
}: {
  label?: string;
  value: string;
  options: readonly PaperAccountOption[];
  onChange: (value: string) => void;
}): JSX.Element | null {
  if (options.length === 0) return null;
  return (
    <HeaderSlot slot="account">
      <span className="inline-flex min-w-0 max-w-full items-center gap-2">
        <span aria-hidden="true" className="shrink-0 text-[13px] text-text-2">
          계좌
        </span>
        <NativeSelect aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} wrapperClassName="inline-flex min-w-0">
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </span>
    </HeaderSlot>
  );
}

/** 머리의 동작 — 탭마다 동작 목록(ui/ActionBar — 빈 목록이면 그리지 않음). `label`은 묶음 이름(예 '보유·체결 동작'). */
export function PaperTabActions({ label, actions }: { label: string; actions: readonly ActionBarItem[] }): JSX.Element | null {
  if (actions.length === 0) return null;
  return (
    <HeaderSlot slot="actions">
      <ActionBar label={label} actions={actions} />
    </HeaderSlot>
  );
}
