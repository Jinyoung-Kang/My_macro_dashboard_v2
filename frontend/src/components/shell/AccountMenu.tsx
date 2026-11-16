"use client";

import { useRef } from "react";
import { DropdownMenu, DropdownMenuItem, DropdownMenuLinkItem, DropdownMenuSeparator } from "@/components/ui/DropdownMenu";
import { AlertTriangleIcon, PersonIcon, StatusText } from "@/components/ui/icons";
import { useLogout } from "@/hooks/useLogout";
import { accountInitial, isDemo, isLocalOwner, noLoginName, roleLabel } from "@/lib/access";
import { sendShellCommand } from "@/lib/shellCommands";
import type { SessionUser } from "@/lib/types";
import { AccountAvatar, DemoNote } from "./AccountBox";
import { BuildInfo } from "./BuildInfo";
import { ReadModeNote } from "./ReadMode";

/*
 * 여는 단추 — 30px 정사각·4px 모서리·1px 경계의 기본 단추 꼴(누르는 것이라 원이 아님 — 명세 §3-8 2026-11-16 결정), 안에 이메일 첫 글자(없으면 사람 아이콘).
 * 글자는 장식이고 이름은 aria-label('계정 메뉴'). 넓은 화면에서만 보여(감싼 상자가 hidden lg:flex) 좁은 화면 44px 누름 자리를 두지 않습니다 —
 * 좁은 화면은 더보기의 계정 영역(AccountBox)이 대신합니다.
 */
const TRIGGER =
  "inline-flex size-[30px] shrink-0 items-center justify-center rounded-control border border-border bg-control-fill text-[13px] font-semibold text-text-2 motion-safe:transition-colors motion-safe:duration-150 hover:border-border-strong hover:text-text data-[state=open]:border-border-strong data-[state=open]:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** 메뉴 안 누르지 않는 줄(읽기 모드·빌드 정보)의 안쪽 여백 — 항목 글과 같은 세로줄. */
const NOTE = "px-3 py-1.5 lg:px-2.5";

/**
 * 넓은 화면(lg 이상) 상단바 맨 오른쪽의 계정 메뉴(공용 DropdownMenu — 작업대 실행 명세 §5, ADR 0042 결정 5·9). 예전 왼쪽 메뉴 아래에 있던 계정·읽기 모드·
 * 빌드 정보·로그아웃을 이 메뉴로 옮겼습니다. 좁은 화면은 지금처럼 더보기의 계정 영역(AccountBox — 단추·링크)입니다.
 *
 * 내용(누가 보고 있는지에 따라 — AccountBox와 같은 규칙):
 * - 계정으로 로그인(회원·쿠키 세션 운영자): 계정 줄(내 계정 링크 — 머리글자 원판·이메일·역할) · 단축키 도움말 · 읽기 모드 · 빌드 정보 · 로그아웃.
 * - 로그인 없이 연 로컬·Tailscale 운영자(ADR 0016·0023): 계정 줄('로컬 · 로그인 없음' 등) · 단축키 도움말 · 읽기 모드 · 빌드 정보 — 세션이 없어 로그아웃이 없습니다.
 * - 데모 열람(ADR 0013): '데모 열람 · 조회만' 줄 · 단축키 도움말 · 읽기 모드 · 빌드 정보 — 계정·세션이 없어 내 계정·로그아웃이 없습니다.
 *
 * 로그아웃은 메뉴를 닫지 않고 요청합니다 — 실패하면 메뉴 안에 경고 글(role=alert, QA-051 — 삼키지 않음), 성공하면 로그인 화면으로.
 * '단축키 도움말'은 메뉴가 닫히고 포커스가 여는 단추로 돌아온 뒤 셸 명령 신호(open-shortcut-help)를 보냅니다 — 도움말 창은 명령 팔레트 쪽이 엽니다
 * (lib/shellCommands — 두 부분이 서로의 모듈을 가져오지 않음). 창을 닫으면 포커스가 이 여는 단추로 돌아옵니다.
 * 메뉴 안 글은 text·text-2만 둡니다(가리킨 항목 바탕 surface-3 위 text-3 금지 — 계정 줄의 역할 글도 text-2). 읽기 모드·빌드 정보는 항목이 아닌 글이라
 * 덮개 바탕(surface-2) 위 text-3(5.01:1)을 그대로 씁니다.
 */
export function AccountMenu({ user }: { user?: SessionUser }) {
  const { logout, error } = useLogout();
  const triggerRef = useRef<HTMLButtonElement>(null);
  // '단축키 도움말'을 골랐는가 — 메뉴가 닫힌 뒤(onCloseAutoFocus) 한 번 신호를 보내고 지웁니다.
  const helpRequested = useRef(false);
  const initial = accountInitial(user);
  const demo = isDemo(user);
  const local = !demo && isLocalOwner(user);

  return (
    <div className="hidden shrink-0 lg:flex">
      <DropdownMenu
        label="계정 메뉴"
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
        {demo ? (
          <div className="p-1">
            <DemoNote user={user} />
          </div>
        ) : user ? (
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
        <div className={NOTE}>
          <ReadModeNote />
        </div>
        <div className={NOTE}>
          <BuildInfo />
        </div>
        {!demo && !local && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                // 메뉴를 닫지 않습니다 — 실패하면 경고 글을 이 메뉴 안에 보입니다.
                event.preventDefault();
                void logout();
              }}
            >
              로그아웃
            </DropdownMenuItem>
            {error && (
              <p role="alert" className="px-3 pb-1.5 pt-1 text-xs leading-5 text-warn lg:px-2.5">
                <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />}>
                  {error}
                </StatusText>
              </p>
            )}
          </>
        )}
      </DropdownMenu>
    </div>
  );
}
