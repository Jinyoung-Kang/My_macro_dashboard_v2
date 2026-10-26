"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { auth } from "@/lib/api";
import { Button } from "@/components/ui";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { DEMO_READ_ONLY, LOCAL_NO_LOGIN, isDemo, isLocalOwner, isOwner, lockedFor, roleLabel, visibleMenus } from "@/lib/access";
import { unreadBadge } from "@/lib/alerts";
import type { SessionUser } from "@/lib/types";

/**
 * 실행 중인 코드의 버전(브랜치@커밋)과 그 커밋의 날짜(KST, 최종 수정일).
 *
 * 빌드 시점에 번들에 들어갑니다. NEXT_PUBLIC_ 값은 런타임에 바뀌지 않으므로
 * 여기 적힌 값이 곧 "이 화면을 만든 코드"입니다. 날짜 형식이 아니면 표시하지 않습니다.
 */
function buildInfo(): { version?: string; updated?: string } {
  const updated = process.env.NEXT_PUBLIC_APP_UPDATED;
  return {
    version: process.env.NEXT_PUBLIC_APP_VERSION || undefined,
    updated: updated && /^\d{4}-\d{2}-\d{2}$/.test(updated) ? updated : undefined,
  };
}

/**
 * 좌측 메뉴 — 분석 메뉴 → AI → 알림 → 데이터 상태 → 연결 진단 → 운영 순서입니다.
 */
export const MENUS = [
  { href: "/macro", label: "거시경제 매크로 지표" },
  { href: "/liquidity", label: "연준 순유동성 트래커" },
  { href: "/sector", label: "섹터 & 자산군 로테이션" },
  { href: "/institutions", label: "기관 13F 포트폴리오 분석" },
  { href: "/consensus", label: "기관 13F Money 교집합" },
  { href: "/style", label: "기관 13F 스타일·위험" },
  { href: "/scorecard", label: "종목 스코어카드" },
  { href: "/cot", label: "글로벌 투기세력 (COT)" },
  { href: "/krx", label: "국내 파생 & 투기세력 (KRX)" },
  { href: "/radar", label: "외국인/기관 수급 레이더 (KRX)" },
  { href: "/regime", label: "시장 국면 판정" },
  { href: "/paper", label: "모의 알고리즘 매매(미국)" },
  { href: "/ai/report", label: "AI 종합 데이터 분석" },
  { href: "/alerts", label: "알림" },
  { href: "/correlation", label: "지표 상관관계" },
  { href: "/status", label: "데이터 저장소 상태" },
  { href: "/connections", label: "외부 API 연결 테스트" },
  { href: "/admin/users", label: "사용자 관리" },
];

export function Sidebar({ readMode, user, unread }: { readMode?: string; user?: SessionUser; unread?: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const build = buildInfo();

  /*
    모바일에서는 메뉴를 접어 둡니다.
    좁은 화면에서 사이드바는 본문 위에 세로로 쌓이는데, 메뉴 12개 + 하단
    영역이 730px이라 폰에서는 화면 두 번을 넘겨야 첫 숫자가 보였습니다.
    데스크톱(lg 이상)은 왼쪽 고정 열이라 접을 이유가 없어 그대로 둡니다.
  */
  const [menuOpen, setMenuOpen] = useState(false);

  // 메뉴를 고르면 닫습니다. 열린 채로 두면 이동 후에도 본문이 아래로 밀립니다.
  useEffect(() => setMenuOpen(false), [pathname]);

  const current = MENUS.find(
    (menu) => pathname === menu.href || pathname.startsWith(`${menu.href}/`),
  );

  // 수집 요청 → 끝날 때까지 대기 → 화면 전체 갱신까지 한 번에 처리합니다.
  // (예전에는 router.refresh()만 불렀는데, 화면이 클라이언트에서 데이터를
  //  읽으므로 아무 일도 일어나지 않아 사용자가 직접 새로고침해야 했습니다.)
  const { requestRefresh, collecting, message } = useRefreshSignal();

  const [logoutError, setLogoutError] = useState<string | null>(null);
  const logout = async () => {
    setLogoutError(null);
    try {
      await auth.logout();
      router.push("/login");
    } catch (err) {
      // 실패를 삼키면 버튼이 아무 반응 없이 끝나고 세션은 그대로입니다(QA-051).
      setLogoutError(`로그아웃하지 못했습니다 — ${err instanceof Error ? err.message : "다시 시도하세요"}`);
    }
  };

  return (
    <aside className="flex w-full shrink-0 flex-col gap-4 border-b border-border bg-surface p-4 lg:h-screen lg:w-72 lg:border-b-0 lg:border-r lg:overflow-y-auto">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-sm font-bold text-bright">대시보드 메뉴</h1>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            {/* 좁은 화면에서는 "지금 보고 있는 메뉴"가 소개 문구보다 유용합니다. */}
            <span className="lg:hidden">{current?.label ?? "메뉴를 고르세요"}</span>
            <span className="hidden lg:inline">
              글로벌 매크로 및 시장 수급 정밀 분석 시스템
            </span>
          </p>
        </div>
        <Button
          className="lg:hidden"
          expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? "메뉴 닫기 ✕" : "메뉴 열기 ☰"}
        </Button>
      </div>

      <nav className={`flex-col gap-1 ${menuOpen ? "flex" : "hidden"} lg:flex`}>
        {visibleMenus(MENUS, user).map((menu) => {
          const active = pathname === menu.href || pathname.startsWith(`${menu.href}/`);
          return (
            <Link
              key={menu.href}
              href={menu.href}
              className={`rounded-lg border px-3 py-2 text-xs transition ${
                active
                  ? "border-accent/50 bg-accent/10 text-accent"
                  : "border-border bg-surface text-body hover:translate-x-1 hover:border-accent/30 hover:bg-accent/10"
              }`}
            >
              {menu.label}
              {lockedFor(user, menu.href) && <span className="ml-1" title="유료 등급 기능">🔒</span>}
              {menu.href === "/alerts" && unreadBadge(unread) && (
                <span className="ml-1 rounded-full bg-accent/20 px-1.5 text-[10px] text-accent" aria-label={`읽지 않은 알림 ${unread}건`}>
                  {unreadBadge(unread)}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* 하단 영역도 모바일에서는 메뉴와 함께 접습니다 — 본문이 먼저 보여야 합니다.
          새로고침 버튼만은 접힌 상태에서도 쓸 수 있게 아래에 따로 둡니다. */}
      <div
        className={`mt-auto flex-col gap-2 border-t border-border pt-4 ${
          menuOpen ? "flex" : "hidden"
        } lg:flex`}
      >
        <div className="text-[11px] text-muted">
          읽기 모드:{" "}
          <span className="font-semibold text-body">{readMode ?? "auto"}</span>
          {readMode === "store_only" && (
            <p className="mt-1 leading-relaxed">
              저장본만 사용합니다. 화면이 외부 수집을 기다리지 않습니다.
            </p>
          )}
        </div>

        {/* 수동 새로고침은 수집을 일으키므로 운영자만(백엔드도 403). */}
        {isOwner(user) && (
          <Button
            variant="primary"
            onClick={() => void requestRefresh()}
            disabled={collecting}
          >
            {collecting ? "수집 중… 끝나면 자동 갱신" : "데이터 수동 새로고침 🚀"}
          </Button>
        )}
        {message && <p className="text-[11px] leading-relaxed text-muted">{message}</p>}

        {/* 데모 열람(ADR 0013)은 계정·세션이 없어 내 계정·로그아웃이 없습니다. 접근은 앞단의 접근 코드가 정합니다. */}
        {isDemo(user) ? (
          <p className="rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-body">
            {roleLabel(user)}
            <span className="ml-1 text-muted">· {DEMO_READ_ONLY}</span>
          </p>
        ) : isLocalOwner(user) ? (
          // 로그인 없이 연 로컬 운영자(ADR 0016)는 세션이 없어 로그아웃할 것이 없습니다. 비밀번호 변경은 내 계정에서.
          <Link
            href="/account"
            className="rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-body hover:border-accent/30"
          >
            {LOCAL_NO_LOGIN}
            <span className="ml-1 text-muted">· {roleLabel(user)}</span>
          </Link>
        ) : (
          <>
            {user && (
              <Link
                href="/account"
                className="rounded-lg border border-border bg-surface px-3 py-2 text-[11px] text-body hover:border-accent/30"
              >
                {user.email}
                <span className="ml-1 text-muted">· {roleLabel(user)}</span>
              </Link>
            )}
            <Button onClick={logout}>로그아웃</Button>
            {logoutError && <p className="text-[11px] text-warn" role="alert">{logoutError}</p>}
          </>
        )}
        {/*
          지금 화면이 "어느 코드"인지 항상 보이게 둡니다.
          git pull 뒤에도 화면이 그대로일 때, 코드를 못 받은 것인지 화면이
          안 바뀐 것인지 여기 한 줄로 구분됩니다. 'make up'이 넣어 주며,
          값이 없으면(직접 docker compose로 띄운 경우) 표시하지 않습니다.
        */}
        <p className="text-[11px] text-muted">
          © 2026 My Macro Dashboard v2
          {build.version && (
            <span className="ml-1 tabular-nums" title="실행 중인 코드의 브랜치@커밋">
              · {build.version}
            </span>
          )}
          {build.updated && (
            <span className="block tabular-nums" title="실행 중인 코드의 마지막 커밋 날짜(KST)">
              최종 수정 {build.updated}
            </span>
          )}
        </p>
      </div>

      {/* 메뉴를 접은 모바일 화면에서도 새로고침은 한 번에 닿아야 합니다. */}
      {!menuOpen && isOwner(user) && (
        <Button
          className="lg:hidden"
          variant="primary"
          onClick={() => void requestRefresh()}
          disabled={collecting}
        >
          {collecting ? "수집 중… 끝나면 자동 갱신" : "데이터 수동 새로고침 🚀"}
        </Button>
      )}
    </aside>
  );
}
