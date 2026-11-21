"use client";

import Link from "@/components/ui/IntentLink";
import { useSessionUser } from "@/hooks/useSessionUser";
import { lockedFor } from "@/lib/access";
import { INFO_GROUP, KR_MARKET_GROUP, TABS, visibleItems, type NavItem } from "@/lib/nav";
import type { SessionUser } from "@/lib/types";
import { AccountBox } from "./AccountBox";
import { BuildInfo } from "./BuildInfo";
import { PageHeader } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";
import { ReadModeNote } from "./ReadMode";
import { RefreshButton } from "./RefreshButton";
import { ChevronRightIcon, MenuIcon } from "./icons";

const MORE = TABS.find((tab) => tab.key === "more");

/** 묶음 제목의 id(묶음 이름 → 영역 이름표). 표에 없는 묶음은 순서 번호로. */
const GROUP_IDS: Record<string, string> = { [KR_MARKET_GROUP]: "more-kr", [INFO_GROUP]: "more-info" };

/**
 * 더보기 화면(/more) — 더보기 하위 화면 목록(행) + 계정 영역 + 읽기 모드·수동 새로고침(운영자) + 빌드 정보.
 *
 * 좁은 화면에서는 상단바의 계정 메뉴·새로고침 아이콘 단추가 없어 계정·읽기 모드·새로고침·빌드 정보를 여기서 씁니다. 데스크톱에서도 열립니다(계정·읽기 모드는
 * 상단바의 계정 메뉴에도 있음). 새로고침 단추와 그 안내는 lg 미만에서만 여기 있습니다 — 넓은 화면은 상단바 아이콘 단추 하나라 안내(live region)도 하나입니다
 * (QA-564, 명세 §5). 새로고침·로그아웃은 홀로 선 단추라 기본 크기(좁은 화면 44px, 로그아웃은 넓은 화면 30px)입니다.
 * 테마 전환 행은 없습니다(어두운 한 벌 — ADR 0042 결정 2). 운영자 전용 화면은 운영자에게만, 유료 화면은 무료 회원에게 자물쇠 아이콘.
 * 하위 화면은 작업대 목록 줄(좁은 화면 48px·넓은 화면 40px — 20px 아이콘(장식, 원판 없음) · 화면 이름 14px 굵게(말줄임 없이 낱말 사이 줄바꿈) · 오른쪽 화살표)이고,
 * 행 전체가 링크입니다(hover 바탕). 예전 64px 줄·40px 원판보다 줄마다 16px 낮아 390에서 아래 묶음이 첫 화면에 더 들어옵니다(작업대 P7).
 * 묶음은 '메뉴'(묶음 없는 더보기 화면)와 그다음 메뉴 표(lib/nav TABS)의 묶음 차례 — '한국 시장'(옛 한국 탭의 수급 레이더·파생·투기세력, ADR 0041 결정 1),
 * '정보 수집'(여덟 분류, 운영자에게만 — 2026-11-18 사용자 요청으로 맨 위 단계 탭에서 이 묶음으로, 그 전에는 '메뉴' 맨 위 행 하나).
 */
export function MoreMenu() {
  const user = useSessionUser();
  const visible = MORE ? visibleItems(MORE, user) : [];
  const items = visible.filter((item) => !item.group);
  const groups: { label: string; items: NavItem[] }[] = [];
  for (const item of visible) {
    if (!item.group) continue;
    const group = groups.find((entry) => entry.label === item.group);
    if (group) group.items.push(item);
    else groups.push({ label: item.group, items: [item] });
  }
  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      {/* 설명의 묶음 이름은 이 사용자에게 보이는 묶음 그대로(운영자에게만 '정보 수집'). */}
      <PageHeader title="더보기" description={["알림", ...groups.map((group) => group.label), "계정·운영 화면과 빌드 정보"].join("·")} />

      <section aria-labelledby="more-menus" className="flex flex-col gap-2">
        <h2 id="more-menus" className="text-sm font-semibold text-text-2">메뉴</h2>
        <MenuRows items={items} user={user} />
      </section>

      {groups.map((group, index) => {
        const id = GROUP_IDS[group.label] ?? `more-group-${index}`;
        return (
          <section key={group.label} aria-labelledby={id} className="flex flex-col gap-2">
            <h2 id={id} className="text-sm font-semibold text-text-2">{group.label}</h2>
            <MenuRows items={group.items} user={user} />
          </section>
        );
      })}

      <section aria-labelledby="more-account" className="flex flex-col gap-2">
        <h2 id="more-account" className="text-sm font-semibold text-text-2">계정</h2>
        <div className="max-w-sm">
          <AccountBox user={user} />
        </div>
      </section>

      <section aria-labelledby="more-data" className="flex flex-col gap-2">
        <h2 id="more-data" className="text-sm font-semibold text-text-2">데이터 읽기</h2>
        <div className="flex max-w-sm flex-col gap-3">
          <ReadModeNote />
          <div className="lg:hidden">
            <RefreshButton user={user} />
          </div>
        </div>
      </section>

      <section aria-labelledby="more-build" className="flex flex-col gap-2">
        <h2 id="more-build" className="text-sm font-semibold text-text-2">빌드 정보</h2>
        <BuildInfo />
      </section>
    </div>
  );
}

/** 묶음 하나의 행 목록 — 아이콘(장식) · 화면 이름(유료 잠금 표시) · 오른쪽 화살표, 행 전체가 링크. */
function MenuRows({ items, user }: { items: readonly { href: string; label: string }[]; user: SessionUser | null | undefined }) {
  return (
    <ul className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface">
      {items.map((item) => (
        <li key={item.href}>
          <Link
            href={item.href}
            className="flex min-h-12 items-center gap-3 px-3 text-body font-semibold text-text hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus lg:min-h-10 lg:px-4"
          >
            <span aria-hidden="true" className="inline-flex shrink-0 items-center text-text-2">
              <MenuIcon href={item.href} size={20} />
            </span>
            <span className="min-w-0 flex-1 break-keep">
              {item.label}
              {lockedFor(user, item.href) && (
                <span title="유료 등급 기능" className="ml-1.5 inline-flex align-[-2px]">
                  <LockIcon size={14} label="유료 등급 기능" />
                </span>
              )}
            </span>
            <span className="text-text-3">
              <ChevronRightIcon />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
