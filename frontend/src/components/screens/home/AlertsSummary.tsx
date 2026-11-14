"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Empty, Skeleton } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { HOME_ALERT_LIMIT, HOME_REFRESH_MS, latestAlerts, unreadText } from "@/lib/home";
import { searchWatchInboxHref } from "@/lib/infoSearch";
import type { InboxResponse } from "@/lib/types";
import { HOME_LINK, HomeCard, SectionError } from "./HomeCard";

/**
 * ④ 알림 요약 — 읽지 않은 수 + 최근 알림 세 건(제목·발생일·읽음 여부) + 알림함 링크. 읽음 처리는 알림 화면에서 합니다.
 *
 * 읽지 않은 수는 셸 레이아웃이 읽는 경로(/api/alerts/unread-count)를 그대로 읽습니다 — 동시에 나가면 요청 하나로 합쳐집니다
 * (lib/sharedRequest). 모르면(읽는 중·실패) "—"이고 0으로 적지 않습니다. 지난 사건(late)은 그 수에 들지 않으므로 강조하지 않고
 * "지난 사건"으로 적습니다(/alerts와 같음).
 *
 * 정보 검색 관심 대상의 새 글 알림(SEARCH_WATCH)은 제목이 그 대상의 타임라인으로 가는 링크입니다(/alerts와 같음 — 정보 검색 화면 안쪽 주소만).
 *
 * 알려진 한계: 알림 테이블이 아직 없으면 백엔드가 unread 0·빈 목록을 보내(AlertController — 응답 모양은 1단계에서 바꾸지 않음)
 * 그때는 모름이 "0건"·"새 알림이 없습니다"로 보입니다.
 */
export function AlertsSummary() {
  const unread = useApi<{ unread: number }>(endpoints.alerts.unreadCount, HOME_REFRESH_MS.alerts);
  const inbox = useApi<InboxResponse>(endpoints.alerts.inbox(HOME_ALERT_LIMIT), HOME_REFRESH_MS.alerts);
  const rows = latestAlerts(inbox.data);
  // 줄 번호 → 가는 주소(SEARCH_WATCH만). latestAlerts는 종류·payload를 넘기지 않아 받은 줄에서 찾습니다.
  const hrefs = new Map((inbox.data?.items ?? []).map((item) => [item.id, searchWatchInboxHref(item)] as const));

  let body: ReactNode;
  if (!inbox.data) {
    body = inbox.error ? (
      <SectionError message={inbox.error} onRetry={() => void inbox.reload()} />
    ) : (
      <Skeleton lines={3} label="알림을 불러오는 중" />
    );
  } else if (rows.length === 0) {
    body = <p className="text-sm text-text-2">새 알림이 없습니다</p>;
  } else {
    body = (
      // 구분선은 카드 가장자리까지(-mx-5·lg:-mx-6 = 카드 안쪽 여백), 줄 글자는 카드 글과 같은 세로줄(px-5·lg:px-6)에 둡니다.
      <ul className="-mx-5 divide-y divide-border border-y border-border lg:-mx-6">
        {rows.map((row) => (
          <li key={row.id} className="relative flex min-h-14 items-start gap-3 px-5 py-2.5 lg:px-6">
            {/* 점은 보조 표시이고 뜻은 옆의 "읽음·안 읽음·지난 사건" 글자로 전합니다(색만으로 전하지 않음). 읽지 않은 수에 드는 것만 칠합니다 —
                잉크(강조 파랑 아님, 명세 A1)를 굵은 테두리로 칠해 고대비 모드에서도 찬 점과 빈 고리가 갈립니다(바탕색은 그 모드에서 지워짐). */}
            <span
              aria-hidden="true"
              className={`mt-1.5 size-2 shrink-0 rounded-full ${row.unread ? "border-4 border-text" : "border border-text-3"}`}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <RowTitle title={row.title} unread={row.unread} href={hrefs.get(row.id) ?? null} />
              <span className="text-xs leading-4 text-text-3">
                <span className="tabular-nums">{row.occurredOn}</span> · {row.readLabel}
              </span>
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <HomeCard
      title="알림"
      actions={
        <>
          <span className="text-xs text-text-2">
            읽지 않음 <span className="tabular-nums font-semibold text-text">{unreadText(unread.data) ?? <Empty />}</span>
          </span>
          <Freshness refreshError={inbox.refreshError ?? unread.refreshError} />
          <Link href="/alerts" className={HOME_LINK}>
            알림 전체 보기
          </Link>
        </>
      }
    >
      {body}
    </HomeCard>
  );
}

/**
 * 알림 한 줄의 제목 — 가는 주소가 있으면(관심 대상 새 글 알림) 링크로, 누르는 자리는 줄 전체(줄 높이 56px 이상 — 좁은 화면 44px 조건)로 넓힙니다.
 * 링크는 누를 수 있는 것이라 강조 파랑(명세 A1), 읽지 않음은 굵기로(색만이 아님 — 옆의 '안 읽음' 글).
 */
function RowTitle({ title, unread, href }: { title: string; unread: boolean; href: string | null }) {
  if (!href) {
    return <span className={`truncate text-[15px] leading-5 ${unread ? "font-semibold text-text" : "text-text-2"}`}>{title}</span>;
  }
  return (
    <Link
      href={href}
      className={`truncate rounded-sm text-[15px] leading-5 text-accent underline-offset-2 after:absolute after:inset-0 after:content-[''] hover:text-accent-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
        unread ? "font-semibold" : ""
      }`}
    >
      {title}
    </Link>
  );
}
