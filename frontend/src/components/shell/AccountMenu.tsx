"use client";

import { useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "@/components/ui/DropdownMenu";
import { PersonIcon } from "@/components/ui/icons";
import { useLogout } from "@/hooks/useLogout";
import { getNavCollapsed } from "@/hooks/useNavCollapsed";
import { useNavWidth } from "@/hooks/useNavWidth";
import { useWideShell } from "@/hooks/useWideShell";
import { accountInitial, isDemo, isLocalOwner, noLoginName, roleLabel } from "@/lib/access";
import { NAV_WIDTH_PRESETS, navWidthPreset } from "@/lib/navWidth";
import { sendShellCommand } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";
import { AccountAvatar, DemoNote } from "./AccountBox";
import { BuildInfo } from "./BuildInfo";
import { FailureNotice } from "./FailureNotice";
import { ReadModeNote } from "./ReadMode";

/*
 * 여는 단추 — 30px 정사각·4px 모서리·1px 경계의 기본 단추 꼴(누르는 것이라 원이 아님 — 명세 §3-8 2026-11-16 결정), 안에 이메일 첫 글자(없으면 사람 아이콘).
 * 글자는 장식이고 이름은 aria-label('계정 메뉴') — 마우스 사용자에게는 같은 글의 툴팁으로 보입니다(공용 메뉴 tooltip). 열린 동안의 모양은 aria-expanded로
 * 그립니다(툴팁 트리거와 합쳐지면 data-state는 툴팁 것). 넓은 화면에서만 보여(감싼 상자가 hidden lg:flex) 좁은 화면 44px 누름 자리를 두지 않습니다 —
 * 좁은 화면은 더보기의 계정 영역(AccountBox)이 대신합니다.
 */
const TRIGGER =
  "inline-flex size-[30px] shrink-0 items-center justify-center rounded-control border border-border bg-control-fill text-[13px] font-semibold text-text-2 motion-safe:transition-colors motion-safe:duration-150 hover:border-border-strong hover:text-text aria-expanded:border-border-strong aria-expanded:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * 넓은 화면(lg 이상) 상단바 맨 오른쪽의 계정 메뉴(공용 DropdownMenu — 작업대 실행 명세 §5, ADR 0042 결정 5·9). 예전 왼쪽 메뉴 아래에 있던 계정·읽기 모드·
 * 빌드 정보·로그아웃을 이 메뉴로 옮겼습니다. 좁은 화면은 지금처럼 더보기의 계정 영역(AccountBox — 단추·링크)입니다.
 *
 * 내용(누가 보고 있는지에 따라 — AccountBox와 같은 규칙). 항목 아래의 설명 칸(공용 메뉴 description — 메뉴의 aria-describedby)에는 항목이 아닌
 * 글(읽기 모드·빌드 정보, 데모 열람이면 '데모 열람 · 조회만' 줄)을 둡니다 — 메뉴 안 화살표는 항목 사이만 옮기므로 그 글을 항목 사이에 두면 화면 읽기
 * 프로그램이 닿기 어렵습니다.
 * - 계정으로 로그인(회원·쿠키 세션 운영자): 계정 줄(내 계정 링크 — 머리글자 원판·이메일·역할) · 단축키 도움말 · 왼쪽 메뉴 폭 · 로그아웃 | 설명: 읽기 모드 · 빌드 정보.
 * - 로그인 없이 연 로컬·Tailscale 운영자(ADR 0016·0023): 계정 줄('로컬 · 로그인 없음' 등) · 단축키 도움말 · 왼쪽 메뉴 폭 | 설명: 읽기 모드 · 빌드 정보 —
 *   세션이 없어 로그아웃이 없습니다.
 * - 데모 열람(ADR 0013): 단축키 도움말 · 왼쪽 메뉴 폭 | 설명: '데모 열람 · 조회만' 줄 · 읽기 모드 · 빌드 정보 — 계정·세션이 없어 내 계정·로그아웃이 없습니다.
 *
 * **왼쪽 메뉴 폭**(작업대 P3 추가, 2026-11-16 결정 — 사용자 위임, 권장안): 펼친 폭을 손잡이로 끌지 않고 고르는 세 단계 — 좁게 206px(하한) · 기본 220px · 넓게 280px
 * (lib/navWidth NAV_WIDTH_PRESETS). 손잡이(8px)만으로는 임의 폭 맞추기가 WCAG 2.2 2.5.7(끌기 동작)·2.5.8(누름 자리 24px)을 충족하지 못해, 32px 메뉴 항목으로
 * 같은 일을 하는 수단을 둡니다. 이름 있는 단일 선택 묶음(공용 DropdownMenuRadioGroup — role=group '왼쪽 메뉴 폭', 항목 menuitemradio·aria-checked, 고른 항목은
 * 체크 아이콘)이고, 고른 항목은 기억한 펼친 폭(hooks/useNavWidth)과 같은 단계입니다 — 접혀 있어도 펼 때 돌아갈 폭을 보이고, 끌어서 정한 그 밖의 폭이면 고른 항목이
 * 없습니다. 고르면 펼친 폭을 손잡이·키와 같은 길(useNavWidth — 검사·저장)로 바꾸고, 메뉴가 접혀 있으면 셸 명령 toggle-nav로 펼칩니다 — 접기 단추·[와 같은
 * 길(왼쪽 메뉴의 접기·펼치기 — 150ms 전환, 포커스 규칙)이고 그때 읽는 펼친 폭이 방금 고른 폭입니다. 펼친 동안 폭만 바뀌면 전환이 없습니다(손잡이 Home·End와 같음).
 * 이미 고른 단계를 다시 골라도 같습니다(접혀 있으면 펼침). 명령은 이 창의 화면 상태만 바꾸고 서버를 부르지 않습니다(lib/shellCommands).
 * 자리는 단축키 도움말 다음·로그아웃 앞(구분선으로 나눔): 화면 보기 설정이라 계정 동작(로그아웃 — 세션을 끝냄)과 떼어 두고, 항목이 아닌 글(읽기 모드·빌드 정보)은
 * 그대로 설명 칸에 남습니다. 메뉴 전체가 넓은 화면 전용이라(아래) 이 묶음도 넓은 화면(왼쪽 메뉴가 보이는 폭)에서만 보입니다 — 좁은 화면의 더보기 계정 영역에는 없습니다.
 *
 * 로그아웃은 고르면 메뉴를 닫고 요청합니다 — 실패하면 메뉴 밖, 여는 단추 왼쪽에 경고 글(role=alert, QA-051 — 삼키지 않음, 한 줄로 줄이고 전체 글은
 * title, 다음 로그아웃 때 지움), 성공하면 로그인 화면으로. 경고를 메뉴 안에 두지 않는 까닭: 메뉴의 자식은 항목·구분선뿐이고(ARIA), 메뉴가 열린 동안은
 * 뒤 화면이 가려져(aria-hidden) 메뉴 밖의 실시간 영역도 읽히지 않습니다.
 * '단축키 도움말'은 메뉴가 닫히고 포커스가 여는 단추로 돌아온 뒤 셸 명령 신호(open-shortcut-help)를 보냅니다 — 도움말 창은 명령 팔레트 쪽이 엽니다
 * (lib/shellCommands — 두 부분이 서로의 모듈을 가져오지 않음). 창을 닫으면 포커스가 이 여는 단추로 돌아옵니다.
 * 메뉴 항목 글은 text·text-2만 둡니다(가리킨 항목 바탕 surface-3 위 text-3 금지 — 계정 줄의 역할 글도 text-2). 설명 칸의 글은 항목이 아니라
 * 덮개 바탕(surface-2) 위 text-3(5.01:1)을 그대로 씁니다.
 * 넓은 화면 전용이라 열림을 여기서 쥐고, 폭이 넓은 화면에서 좁은 화면(lg 미만 — 태블릿 회전·창 줄이기)으로 바뀌면 닫습니다 — 여는 단추가 CSS로 숨어도
 * Radix는 메뉴를 닫지 않아, 좁은 상단바 왼쪽 위에 모달로 남아 화면을 막았습니다(QA-554). 다시 넓혀도 저절로 열리지 않고, 이름 툴팁도 넓은 화면에서만 엽니다.
 * 닫을 때는 넓음 → 좁음으로 바뀌는 그 순간만 봅니다('열림 && 넓음'으로 두면 matchMedia가 늘 거짓인 시험 환경·첫 하이드레이션에서 메뉴를 열 수 없음).
 */
export function AccountMenu({ user }: { user?: SessionUser }) {
  const { logout, error } = useLogout();
  const wide = useWideShell();
  const [open, setOpen] = useState(false);
  // 넓음 → 좁음으로 바뀐 그리기에서 메뉴를 닫습니다(그리는 중에 앞 값과 견줘 바로 고침 — 효과로 하면 한 번 열린 채 그려짐).
  const [wasWide, setWasWide] = useState(wide);
  if (wasWide !== wide) {
    setWasWide(wide);
    if (!wide) setOpen(false);
  }
  const triggerRef = useRef<HTMLButtonElement>(null);
  // '단축키 도움말'을 골랐는가 — 메뉴가 닫힌 뒤(onCloseAutoFocus) 한 번 신호를 보내고 지웁니다.
  const helpRequested = useRef(false);
  const initial = accountInitial(user);
  const demo = isDemo(user);
  const local = !demo && isLocalOwner(user);
  // 왼쪽 메뉴 펼친 폭 — 고른 항목은 그 폭과 같은 단계(없으면 끌어서 정한 폭이라 고른 항목 없음).
  const [navWidth, setNavWidth] = useNavWidth();
  const chooseNavWidth = (value: string) => {
    const preset = NAV_WIDTH_PRESETS.find((entry) => String(entry.width) === value);
    if (!preset) return;
    setNavWidth(preset.width);
    // 접혀 있으면 펼침 — 접기 단추·[와 같은 길(셸 명령 toggle-nav, 왼쪽 메뉴가 받음). 그때 읽는 펼친 폭이 위에서 바꾼 폭입니다.
    if (getNavCollapsed()) sendShellCommand("toggle-nav");
  };

  return (
    <div className={`hidden items-center gap-2 lg:flex ${error ? "shrink-100000" : "shrink-0"}`}>
      {/* 로그아웃 실패 — 메뉴 밖(메뉴가 닫힌 뒤 나타나 읽힘). 한 줄로 줄이고 전체 글은 title — 새로고침 안내와 같은 폭(160px, xl 288px). 떠 있는 동안
          감싼 상자가 상단바에서 모자란 폭을 먼저 내주되(shrink-100000) 내용의 하한 — 경고 아이콘 + 결과 낱말 '로그아웃 실패'(FailureNotice) + 사이 + 여는
          단추 — 까지만 내주고, 그다음 빵부스러기가 줄어듭니다(QA-547 — 새로고침 안내의 NOTICE_BOX와 같은 규칙). 글이 없으면 상자는 단추 폭 그대로(shrink-0).
          다음 로그아웃 때 지움. */}
      {error && (
        <p role="alert" title={error} className="flex min-w-0 max-w-40 text-xs leading-5 text-warn xl:max-w-72">
          <FailureNotice message={error} oneLine />
        </p>
      )}
      <DropdownMenu
        label="계정 메뉴"
        tooltip="계정 메뉴"
        tooltipDisabled={!wide}
        open={open}
        onOpenChange={setOpen}
        description={
          <>
            {demo && <DemoNote user={user} boxed={false} />}
            <ReadModeNote />
            <BuildInfo />
          </>
        }
        onCloseAutoFocus={(event) => {
          if (!helpRequested.current) return;
          helpRequested.current = false;
          // 여는 단추로 포커스를 먼저 돌려 둡니다 — 도움말 창이 '연 곳'으로 이 단추를 기억해, 닫으면 여기로 돌아옵니다.
          event.preventDefault();
          triggerRef.current?.focus();
          sendShellCommand("open-shortcut-help");
        }}
        trigger={
          <button ref={triggerRef} type="button" aria-label="계정 메뉴" className={TRIGGER}>
            {initial ? <span aria-hidden="true">{initial}</span> : <PersonIcon size={16} />}
          </button>
        }
      >
        {!demo && user ? (
          <DropdownMenuLinkItem href="/account" className="py-1.5">
            <AccountAvatar user={user} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium leading-5 text-text" title={local ? noLoginName(user) : (user.email ?? roleLabel(user))}>
                {local ? noLoginName(user) : (user.email ?? roleLabel(user))}
              </span>
              <span className="text-xs leading-4 text-text-2">{roleLabel(user)}</span>
            </span>
          </DropdownMenuLinkItem>
        ) : null}
        <DropdownMenuItem
          keyshortcuts="?"
          onSelect={() => {
            helpRequested.current = true;
          }}
        >
          단축키 도움말
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup label="왼쪽 메뉴 폭" value={navWidthPreset(navWidth) ? String(navWidth) : undefined} onValueChange={chooseNavWidth}>
          {NAV_WIDTH_PRESETS.map((preset) => (
            <DropdownMenuRadioItem key={preset.width} value={String(preset.width)}>
              {preset.label} <span className="tabular-nums text-text-2">{preset.width}px</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {!demo && !local && (
          <>
            <DropdownMenuSeparator />
            {/* 고르면 메뉴가 닫히고(포커스는 여는 단추로) 요청합니다 — 실패 글은 메뉴 밖(위). */}
            <DropdownMenuItem onSelect={() => void logout()}>로그아웃</DropdownMenuItem>
          </>
        )}
      </DropdownMenu>
    </div>
  );
}
