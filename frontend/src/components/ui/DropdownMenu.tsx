"use client";

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import Link from "@/components/ui/IntentLink";
import { useId, type ReactElement, type ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon } from "@/components/ui/icons";
import { Tooltip } from "./Tooltip";

/*
 * 움직임은 나타날 때의 짧은 흐려짐(150ms) 하나뿐이고, 움직임 줄이기(prefers-reduced-motion)면 없습니다 — 대화상자(ui/Dialog)의 FADE_IN과 같습니다.
 */
const FADE_IN = "motion-safe:transition-opacity motion-safe:duration-150 motion-safe:starting:opacity-0";

/** 메뉴 상자 — 덮개 3층(바탕 surface-2·안쪽 1px 밝은 경계·바깥 그림자·4px 모서리, 작업대 실행 명세 §3-3). */
const CONTENT = `z-50 min-w-56 max-w-xs rounded-card border border-border-overlay bg-surface-2 p-1 text-text shadow-overlay outline-none ${FADE_IN}`;

/*
 * 메뉴 항목 — 좁은 화면(lg 미만 — 손가락) 높이 44px, 넓은 화면 32px(명세 §3-7 표 행과 같은 단계). 가리킨 항목(Radix data-highlighted — 마우스를 올리거나
 * 화살표로 옮긴 항목)의 바탕은 조작 바탕(bg-control-fill — 덮개 안이라 surface-3)이고, 그 위 글자는 text·text-2만 둡니다(surface-3 위 text-3·accent·danger는
 * 4.5:1 미만 — 금지 쌍). 키보드로 옮긴 항목에는 포커스 링(2px, 안쪽)도 그립니다 — 고대비(forced-colors)에서는 바탕이 지워져도 링이 남습니다.
 * 항목에는 outline-none을 두지 않습니다 — Tailwind 4의 outline-none은 --tw-outline-style을 none으로 두어 focus-visible:outline-2의 선 모양까지 none이 됩니다.
 * 마우스로 가리켜도 Radix는 그 항목에 실제 포커스를 줍니다(item.focus() — 마우스로 열 때도 메뉴 상자에 스크립트 포커스). 크로미움은 스크립트 포커스의
 * :focus-visible을 직전 포커스 상태로 정하므로, 화면을 연 뒤 마우스 클릭으로 포커스가 옮겨진 적이 없거나 직전 포커스가 키보드였으면 마우스로 가리킨 항목에도
 * 링이 그려지고, 클릭으로 포커스가 옮겨진 뒤에는 바탕만 바뀝니다(QA 스택 Chrome 157에서 확인 — 브라우저 표준 판단이라 막지 않음, 링도 Enter가 고를 지금
 * 항목을 맞게 가리킴). 바탕만 바뀌는 경우 고대비에서는 그 바탕이 Canvas로 지워지므로 가리킨 항목에 안쪽 2px 시스템 강조색(Highlight) 테두리를 그 모드에서만
 * 둡니다(검토 지적 — 마우스 사용자에게 지금 항목 표시가 없었음). 링이 그려지는 경우에는 같은 2px 안쪽 선으로 겹쳐 해가 없습니다.
 * 클래스는 이 파일 안에만 둡니다(ui/classes.ts에 내보내지 않음 — 그 표의 누르는 조각 검사(touchTargets)와 따로).
 */
const ITEM =
  "flex min-h-11 w-full items-center gap-2 rounded-control px-3 text-sm text-text lg:min-h-8 lg:px-2.5 data-[highlighted]:bg-control-fill data-[disabled]:opacity-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus forced-colors:data-[highlighted]:outline-2 forced-colors:data-[highlighted]:-outline-offset-2 forced-colors:data-[highlighted]:outline-[Highlight]";

/** 묶음 이름표 — 누르지 않는 글(보조 글 text-2). */
const LABEL = "px-3 pb-1 pt-2 text-xs font-semibold text-text-2 lg:px-2.5";

/*
 * 단일 선택 항목의 고름 표시 자리 — 항목 오른쪽 끝의 16px 칸. 고른 항목에만 체크 아이콘(선 2px, 글자색 currentColor — 항목 글과 같은 text)이 들어가
 * 색이 아니라 모양으로 가릅니다(WCAG 1.4.1). 고대비(forced-colors)에서도 아이콘 선은 시스템 글자색으로 남습니다. 칸은 늘 두어(고르지 않은 항목은 빈 칸)
 * 항목 글의 오른쪽 끝이 고름에 따라 흔들리지 않게 합니다. 고름의 뜻은 항목의 aria-checked가 나르고 아이콘은 장식입니다(aria-hidden — IconBase 기본).
 */
const RADIO_MARK = "ml-auto inline-flex size-4 shrink-0 items-center justify-center";

/** 구분선 — 덮개 안쪽 폭 전체(상자 안쪽 여백만큼 바깥으로). */
const SEPARATOR = "-mx-1 my-1 border-t border-border";

/*
 * 설명 칸 — 항목 아래 구분선 다음의 누르지 않는 글(덮개 안쪽 폭 전체, 글은 항목 글과 같은 세로줄 — 상자 여백 4px + 항목 여백). 덮개 바탕(surface-2) 위라
 * text-3(5.01:1)까지 씁니다(가리킨 항목 바탕 surface-3 위가 아님).
 */
const DESCRIPTION = "-mx-1 mt-1 flex flex-col gap-1.5 border-t border-border px-4 pb-1.5 pt-2 lg:px-3.5";

/**
 * 메뉴(드롭다운) — Radix DropdownMenu를 토큰 색으로 감싼 것(ADR 0042 결정 9, 실행 명세 §6 '메뉴·툴팁'). 처음 쓰는 곳은 넓은 화면 상단바의 계정 메뉴(P3)이고,
 * 모의매매 머리의 '동작' 메뉴(P6)가 다음입니다 — 위험 항목 모양 등은 그 단계가 더합니다.
 *
 * - 여는 단추(`trigger`, 요소 하나)를 Radix Trigger로 감쌉니다 — aria-haspopup="menu"·aria-expanded가 붙고, Enter·Space·아래 화살표로 엽니다.
 * - 열린 동안은 모달입니다(Radix 기본): 포커스가 메뉴 안에 갇히고, 화살표로 항목을 옮기고(끝에서 처음으로 돌아감), Esc·바깥 누르기로 닫히며,
 *   닫히면 여는 단추로 포커스가 돌아옵니다. 뒤 화면은 보조 기술에서 가려집니다(aria-hidden).
 * - 글자 찾기(typeahead — 글자를 치면 그 글자로 시작하는 항목으로)는 한국어 항목에 그대로는 듣지 않습니다. Radix는 키 한 번의 글자(event.key)와 항목 글의
 *   첫 글자를 견주는데, 한글 자판의 키 한 번은 자모(ㄷ)나 로마자(e)라 완성 음절('단축키'의 '단')과 맞지 않습니다. 항목이 둘셋인 메뉴(계정 메뉴)는
 *   화살표로 충분하고, 별칭이 필요한 항목은 `DropdownMenuItem`의 `textValue`(Radix Item textValue — 로마자·초성 등)로 찾게 합니다(작업대 P6).
 * - 상자에 덮개 범위 표지(data-overlay)를 붙여, 안의 조작 바탕(bg-control-fill)이 한 단계 위(surface-3)가 되게 합니다(명세 §3-4 2026-11-16 결정).
 * - `label`을 주면 메뉴의 이름이 됩니다(없으면 여는 단추의 이름 — Radix가 aria-labelledby로 잇습니다).
 * - `description`은 항목이 아닌 글(상태·안내 — 계정 메뉴의 읽기 모드·빌드 정보 등)을 두는 자리입니다. 항목 아래 구분선 다음에 그리고 메뉴의 설명
 *   (aria-describedby)으로 잇습니다 — 메뉴 안에서 화살표는 항목 사이만 옮기므로(Radix), 글을 항목 사이에 그냥 두면 화면 읽기 프로그램이 닿기 어렵습니다.
 *   역할이 있는 요소(role=alert·status 등)는 두지 않습니다 — 메뉴(role=menu)의 자식은 항목·구분선·묶음뿐이고(ARIA), 열린 동안 뒤 화면이 가려져
 *   실시간 영역은 메뉴 밖에 두어도 읽히지 않습니다(결과 안내는 메뉴를 닫은 뒤 메뉴 밖에).
 * - `onCloseAutoFocus`는 닫힌 뒤 포커스를 옮기기 직전에 불립니다(Radix 그대로) — 부르는 쪽이 event.preventDefault()로 기본 동작(여는 단추로)을 바꿀 수 있습니다.
 * - `tooltip`은 아이콘 여는 단추의 이름을 마우스 사용자에게 보이는 툴팁입니다(공용 Tooltip labelOnly — 글은 단추의 접근 이름과 같게). 툴팁 트리거가 메뉴
 *   트리거를 감싸 두 Radix 트리거의 속성·처리기가 한 단추에 합쳐지는데, data-state는 툴팁 것이 남으므로 여는 단추의 열림 모양은 data-state가 아니라
 *   aria-expanded로 그립니다(`aria-expanded:` 변형). `tooltipDisabled`면 그 툴팁을 열지 않습니다(구조는 그대로 — 공용 Tooltip disabled) — 넓은 화면
 *   전용 여는 단추가 좁은 화면에서 숨는 동안(QA-554).
 * - `open`·`onOpenChange`를 주면 열림을 부르는 쪽이 쥡니다(Radix Root 제어 — 주지 않으면 지금처럼 Radix가 쥠). 넓은 화면 전용 메뉴가 폭이 lg 아래로
 *   바뀔 때 닫는 데 씁니다(계정 메뉴 — QA-554: 여는 단추가 CSS로 숨어도 Radix는 메뉴를 닫지 않아 좁은 상단바 왼쪽 위에 남았음).
 */
export function DropdownMenu({
  trigger,
  children,
  align = "end",
  label,
  description,
  tooltip,
  tooltipDisabled = false,
  onCloseAutoFocus,
  open,
  onOpenChange,
}: {
  /** 여는 단추(요소 하나). */
  trigger: ReactElement;
  children: ReactNode;
  /** 여는 단추에 맞출 쪽 — 상단바 오른쪽 끝 메뉴는 end(기본). */
  align?: "start" | "center" | "end";
  /** 메뉴의 이름. 없으면 여는 단추의 이름. */
  label?: string;
  /** 항목이 아닌 글 — 항목 아래에 그리고 메뉴의 설명(aria-describedby)으로 잇습니다. 역할 있는 요소는 두지 않습니다. */
  description?: ReactNode;
  /** 아이콘 여는 단추의 이름 툴팁(글은 단추의 접근 이름과 같게 — 설명으로 잇지 않음). */
  tooltip?: string;
  /** 이름 툴팁을 열지 않음(구조는 그대로). */
  tooltipDisabled?: boolean;
  /** 닫힌 뒤 포커스를 옮기기 직전(Radix onCloseAutoFocus). */
  onCloseAutoFocus?: (event: Event) => void;
  /** 열림(제어) — 주면 onOpenChange와 함께. 주지 않으면 Radix가 쥡니다. */
  open?: boolean;
  /** 열림이 바뀌려 할 때(Radix onOpenChange — 여는 단추·Esc·바깥 누르기·항목 고르기). */
  onOpenChange?: (open: boolean) => void;
}) {
  const descriptionId = useId();
  // aria-labelledby(여는 단추)가 aria-label보다 앞서므로, 이름을 따로 줄 때는 그것을 지웁니다.
  const naming = label ? { "aria-label": label, "aria-labelledby": undefined } : {};
  const hasDescription = description !== undefined && description !== null && description !== false;
  const menuTrigger = <DropdownMenuPrimitive.Trigger asChild>{trigger}</DropdownMenuPrimitive.Trigger>;
  return (
    <DropdownMenuPrimitive.Root open={open} onOpenChange={onOpenChange}>
      {tooltip ? (
        <Tooltip content={tooltip} labelOnly disabled={tooltipDisabled}>
          {menuTrigger}
        </Tooltip>
      ) : (
        menuTrigger
      )}
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          data-overlay=""
          align={align}
          sideOffset={4}
          collisionPadding={8}
          loop
          onCloseAutoFocus={onCloseAutoFocus}
          className={CONTENT}
          aria-describedby={hasDescription ? descriptionId : undefined}
          {...naming}
        >
          {children}
          {hasDescription && (
            <div id={descriptionId} className={DESCRIPTION}>
              {description}
            </div>
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/**
 * 메뉴 항목(단추 꼴) — 고르면(누르기·Enter·Space) `onSelect`가 불리고 메뉴가 닫힙니다. 닫지 않으려면 `onSelect`에서 event.preventDefault().
 * 결과 안내(실패 글 등)는 메뉴 안에 두지 않습니다(위 DropdownMenu 설명 — 역할 있는 요소 금지). `keyshortcuts`는 같은 일을 하는 단축키
 * (aria-keyshortcuts — 예: "?"). `disabled`(막힌 항목 — 화살표·글자 찾기가 건너뜀)는 P6 '동작' 메뉴(ui/ActionBar)가 처음 씁니다.
 * - `textValue`(작업대 P6): 글자 찾기가 견줄 글 — 항목 글 대신 이 글의 첫 글자로 찾습니다(한국어 항목에 로마자·초성 별칭, 예 '계좌 초기화' → 'gyejwa').
 *   이름(낭독 글)은 항목 글 그대로입니다.
 * - `tone="danger"`(작업대 P6): 확인 대화상자를 거치는 파괴적 동작의 표지 — 글 앞에 경고 삼각형 아이콘(장식, 글자색 currentColor)을 둡니다. 글자색은
 *   다른 항목과 같은 text입니다(가리킨 항목 바탕 surface-3 위 danger 글자는 4.5:1 미만 — 금지 쌍). 항목에 data-tone="danger"가 붙습니다.
 */
export function DropdownMenuItem({
  onSelect,
  disabled = false,
  keyshortcuts,
  textValue,
  tone,
  children,
}: {
  onSelect?: (event: Event) => void;
  disabled?: boolean;
  keyshortcuts?: string;
  /** 글자 찾기가 견줄 글(별칭). 없으면 항목 글. */
  textValue?: string;
  /** 위험 표지(경고 삼각형 아이콘) — 확인을 거치는 파괴적 동작에만. */
  tone?: "danger";
  children: ReactNode;
}) {
  return (
    <DropdownMenuPrimitive.Item
      onSelect={onSelect}
      disabled={disabled}
      aria-keyshortcuts={keyshortcuts}
      textValue={textValue}
      data-tone={tone}
      className={ITEM}
    >
      {tone === "danger" ? <AlertTriangleIcon size={16} className="shrink-0" /> : null}
      {children}
    </DropdownMenuPrimitive.Item>
  );
}

/** 메뉴 항목(링크 꼴) — 화면 이동. Radix 항목이 링크(a[role=menuitem][href])에 붙고, 고르면 그 주소로 갑니다. */
export function DropdownMenuLinkItem({ href, children, className = "" }: { href: string; children: ReactNode; className?: string }) {
  return (
    <DropdownMenuPrimitive.Item asChild>
      <Link href={href} className={`${ITEM} ${className}`.trim()}>
        {children}
      </Link>
    </DropdownMenuPrimitive.Item>
  );
}

/**
 * 이름 있는 단일 선택 묶음(라디오) — 넓은 화면 계정 메뉴의 '왼쪽 메뉴 폭'(작업대 P3 추가, 2026-11-16 결정)이 처음 씁니다.
 * 묶음 이름표(`label` — 누르지 않는 글, DropdownMenuLabel과 같은 모양)를 위에 그리고 묶음(Radix RadioGroup — role=group)의 이름으로 잇습니다
 * (aria-labelledby — 메뉴 안 화살표는 항목 사이만 옮기므로 이름표 글 자체에는 서지 않고, 묶음에 들어설 때 이름으로 읽힘). 항목은 DropdownMenuRadioItem
 * (role=menuitemradio·aria-checked)이고 다른 항목과 같은 화살표 순서에 섭니다.
 * `value`가 어느 항목과도 같지 않으면(undefined 포함) 고른 항목이 없습니다(예: 보는 사람이 끌어서 정한 폭). 항목을 고르면(누르기·Enter·Space)
 * `onValueChange`가 불리고 메뉴가 닫힙니다 — 이미 고른 항목을 다시 골라도 불립니다(Radix 그대로 — 부르는 쪽이 같은 값의 뜻을 정함).
 */
export function DropdownMenuRadioGroup({
  label,
  value,
  onValueChange,
  children,
}: {
  /** 묶음 이름(보이는 이름표 글이자 묶음의 접근 이름). */
  label: string;
  /** 고른 항목의 값 — 어느 항목과도 같지 않으면 고른 항목 없음. */
  value: string | undefined;
  /** 항목을 고를 때(이미 고른 항목이어도). */
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <>
      <DropdownMenuPrimitive.Label id={labelId} className={LABEL}>
        {label}
      </DropdownMenuPrimitive.Label>
      <DropdownMenuPrimitive.RadioGroup aria-labelledby={labelId} value={value} onValueChange={onValueChange}>
        {children}
      </DropdownMenuPrimitive.RadioGroup>
    </>
  );
}

/**
 * 단일 선택 항목 — DropdownMenuRadioGroup 안에만 둡니다. 모양은 다른 항목과 같은 칸(좁은 화면 44px·넓은 화면 32px, 가리킨 바탕·포커스 링·고대비 윤곽선)이고,
 * 고른 항목은 오른쪽 끝의 체크 아이콘으로 가릅니다(RADIO_MARK — 색에 기대지 않음). `disabled`면 화살표가 건너뜁니다.
 */
export function DropdownMenuRadioItem({ value, disabled = false, children }: { value: string; disabled?: boolean; children: ReactNode }) {
  return (
    <DropdownMenuPrimitive.RadioItem value={value} disabled={disabled} className={ITEM}>
      <span className="min-w-0 truncate">{children}</span>
      <span className={RADIO_MARK}>
        <DropdownMenuPrimitive.ItemIndicator className="inline-flex">
          <CheckIcon size={16} />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
    </DropdownMenuPrimitive.RadioItem>
  );
}

/** 묶음 이름표(누르지 않음) — P6 '동작' 메뉴가 처음 씁니다. */
export function DropdownMenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenuPrimitive.Label className={LABEL}>{children}</DropdownMenuPrimitive.Label>;
}

/** 구분선. */
export function DropdownMenuSeparator() {
  return <DropdownMenuPrimitive.Separator className={SEPARATOR} />;
}
