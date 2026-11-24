"use client";

import Link from "@/components/ui/IntentLink";
import { MarketClock } from "@/components/MarketClock";
import { Tooltip } from "@/components/ui/Tooltip";
import { useWideShell } from "@/hooks/useWideShell";
import { unreadBadge } from "@/lib/alerts";
import type { SessionUser } from "@/lib/types";
import { AccountMenu } from "./AccountMenu";
import { Breadcrumbs } from "./Breadcrumbs";
import { RefreshButton } from "./RefreshButton";
import { SearchCommand } from "./SearchCommand";
import { SourceAlertIndicator } from "./SourceAlertIndicator";
import { BellIcon } from "./icons";

/** 앱 이름 전체 — 화면 읽기 프로그램이 모든 폭에서 읽는 글(보이는 글은 2xl 아래에서 'Dashboard'를 줄임). */
const APP_NAME = "My Macro Dashboard v2";

/**
 * 알림 벨의 이름 — 읽지 않은 수를 알면 함께 읽어 줍니다. 아직 모르면(읽는 중·실패) 수를 지어내지 않고 "알림"만.
 */
function bellLabel(unread: number | null | undefined): string {
  return typeof unread === "number" ? `알림 — 읽지 않음 ${unread}건` : "알림";
}

/**
 * 상단바 — 앱 이름, 빵부스러기(넓은 화면만), 수집 끊김 경고(운영자·홈 밖·끊긴 출처가 있을 때만 — SourceAlertIndicator), 통합 검색 단추(⌘K — 명령 팔레트),
 * 데이터 새로고침 아이콘 단추(운영자·넓은 화면만), 장 상태 칩 둘(MarketClock), 알림 벨(/alerts, 읽지 않은 수 배지), 계정 메뉴(넓은 화면만).
 * 넓은 화면(lg 이상)은 화면 폭 전체의 높이 48px 한 줄(앱 이름 · 빵부스러기 · 검색 · 새로고침 · 장 상태 칩 · 벨 · 계정)이고 그 아래 줄에 왼쪽 메뉴와 본문이 놓입니다
 * (작업대 실행 명세 §5, ADR 0042 결정 5). 좁은 화면은 지금 구조 그대로 — 64px 줄(앱 이름·검색·벨) 아래 장 상태 칩 줄을 하나 더 둡니다.
 * 앱 이름은 2xl(1536px) 아래에서 짧게('My Macro v2'), 2xl 이상에서 'My Macro Dashboard v2'로 보입니다(2026-11-16 결정 4 — 사용자 위임, 권장안). 예전에는
 * xl(1280px)부터 길게 써서, 검색 단추(176 → 256px·전체 글)·장 시계 시각과 함께 세 항목이 1280에서 한꺼번에 넓어져 빵부스러기 자리가 1279의 535px에서
 * 1280의 255px로 줄었습니다(기관 상세, 크롬 — 1280~약 1305는 1024의 280px보다도 좁음). 'Dashboard'(88px)를 1536부터로 미뤄 1280~1535의 빵부스러기가
 * 88px 넓어집니다(1280 255 → 343px). 이 px 값은 장 시계 글 폭에 따라 ±13px 안팎 달라지고, 늘어나는 88px은 그대로입니다. 긴 대상 이름이 다 보이는 폭은
 * 국민연금 약 1400 → 1314, 사우디 국부펀드(PIF) 약 1472 → 1384입니다(잘린 칸은 title로 전체 이름). 정보가 담긴 글(장 시계 시각·검색 안내)은 그대로 xl부터입니다.
 * 보이는 글은 aria-hidden이고, 화면 읽기 프로그램에는 sr-only 글 하나로 모든 폭에서 전체 이름('My Macro Dashboard v2')을 읽힙니다 — 숨긴 낱말이
 * display:none이라 보이는 글만 두면 2xl 아래에서는 'My Macro v2'로 읽혔습니다. 'sr-only 2xl:not-sr-only'로 낱말만 숨기는 방식은 쓰지 않습니다 — 앞 공백
 * 없는 'Dashboard'가 따로 읽혀 'My MacroDashboard'로 붙을 수 있습니다.
 * 글 전체는 flex 상자 안의 인라인 span 하나에 담습니다 — 글 조각이 따로 flex 항목이 되면 항목 맨 앞 공백이 접혀 'My MacroDashboardv2'로 붙었습니다(QA-550).
 * sr-only 글(position:absolute)도 그 span 안에 있어 flex 항목이 늘지 않고, 1px로 잘려 배치·넘침에 영향이 없습니다.
 * 장 시계는 인스턴스 하나이고 자리(order)만 바뀝니다 — 둘로 그리면 공휴일 요청·1초 시계·글이 두 번씩 생깁니다.
 * 데스크톱에서는 본문만 스크롤되므로 늘 보이고, 좁은 화면에서는 페이지와 함께 올라갑니다(고정하면 화면 안 #앵커 제목을 가림).
 */
export function TopBar({ pathname, user, unread }: { pathname: string; user?: SessionUser; unread?: number | null }) {
  const badge = unreadBadge(unread);
  const bell = bellLabel(unread);
  // 알림 벨은 두 폭 모두에 있습니다 — 이름 툴팁은 넓은 화면에서만(좁은 화면은 지금 구조 그대로, 명세 §0 W2).
  const wide = useWideShell();
  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 border-b border-border bg-surface px-4 sm:px-6 lg:h-12 lg:flex-nowrap lg:gap-x-2 lg:px-4">
      <span className="flex h-16 shrink-0 items-center whitespace-nowrap text-[15px] font-bold text-text lg:mr-2 lg:h-auto lg:text-base lg:font-semibold">
        <span>
          <span aria-hidden="true">
            My Macro<span className="hidden 2xl:inline"> Dashboard</span> v2
          </span>
          <span className="sr-only">{APP_NAME}</span>
        </span>
      </span>
      {/* 빵부스러기가 자기 글 폭을 주장하고 남는 폭을 차지합니다(lg:flex-auto — 예전 빈칸 자리, 폭 배분은 Breadcrumbs). 좁은 화면에는 없습니다. */}
      <Breadcrumbs pathname={pathname} user={user} />
      {/* 수집 끊김 경고(운영자·홈 밖·끊긴 출처가 있을 때만 — QA-994). 빵부스러기 바로 뒤라 넓은 화면은 빵부스러기가 자기 폭을 내주고 다른 항목은 움직이지
          않습니다. 펼친 안내는 겹치는 판이라 본문을 밀지 않습니다(예전 본문 맨 위의 띠). */}
      <SourceAlertIndicator pathname={pathname} user={user} />
      <SearchCommand user={user} />
      {/* 운영자의 데이터 새로고침 — 넓은 화면만, 결과 안내(role=status)가 단추 왼쪽에(좁은 화면은 더보기 '데이터 읽기'). */}
      <RefreshButton user={user} variant="icon" />
      {/* 좁은 화면: 맨 뒤 순서(order-last)·폭 전체라 둘째 줄로 내려갑니다. 넓은 화면: 원래 순서대로 검색과 벨 사이. 칩이 폭보다 넓으면
          이 줄만 가로로 넘깁니다(페이지 가로 스크롤을 만들지 않음). */}
      <div className="order-last flex h-10 w-full min-w-0 items-start overflow-x-auto lg:order-none lg:h-auto lg:w-auto lg:shrink-0 lg:items-center lg:overflow-visible">
        <MarketClock />
      </div>
      {/* 넓은 화면 상단바의 아이콘 단추 셋(새로고침·벨·계정)은 이름을 같은 글의 툴팁으로도 보입니다(labelOnly — 설명으로 잇지 않음). */}
      <Tooltip content={bell} labelOnly disabled={!wide}>
        <Link
          href="/alerts"
          aria-label={bell}
          aria-current={pathname === "/alerts" ? "page" : undefined}
          className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-control text-text hover:bg-surface-2 lg:size-[30px] motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <BellIcon size={20} />
          {/* 수 배지는 알림을 여는 단추의 일부라 강조 파랑(명세 원칙 A1 — 알림 수). 이름(aria-label)이 수를 읽으므로 배지는 장식입니다.
              벨 단추와 수 배지는 4px 모서리입니다 — 수가 두 자리면 알약이 되던 rounded-full을 공용 단추·태그와 같은 모서리로(작업대 실행 명세 §3-8).
              고대비에서는 바탕이 지워져 배지가 벨을 가린 빈 자리로 보이므로 1px 테두리로 상자를 남깁니다(forced-colors:border — 색은 고대비가 정함, QA-501).
              넓은 화면 30px 벨에서는 배지를 16px로 줄여 아이콘 바깥 오른쪽 위로 뺍니다(lg:h-4 lg:min-w-4 lg:-right-1 lg:-top-1.5 — 44px 벨에 맞춘 값 그대로면
              배지가 아이콘의 42~65%를 덮었음, QA-551). 글자는 12px 그대로입니다. */}
          {badge && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-control bg-accent px-1 text-xs font-semibold leading-none tabular-nums text-accent-fg forced-colors:border lg:-right-1 lg:-top-1.5 lg:h-4 lg:min-w-4"
            >
              {badge}
            </span>
          )}
        </Link>
      </Tooltip>
      {/* 계정 메뉴(계정·단축키 도움말·읽기 모드·빌드 정보·로그아웃) — 넓은 화면만, 좁은 화면은 더보기의 계정 영역. */}
      <AccountMenu user={user} />
    </header>
  );
}
