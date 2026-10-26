"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Empty, Skeleton } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { HOME_ALERT_LIMIT, HOME_REFRESH_MS, latestAlerts, unreadText } from "@/lib/home";
import type { InboxResponse } from "@/lib/types";
import { HOME_LINK, HomeCard, SectionError } from "./HomeCard";

/**
 * ④ 알림 요약 — 읽지 않은 수 + 최근 알림 세 건(제목·발생일·읽음 여부) + 알림함 링크. 읽음 처리는 알림 화면에서 합니다.
 *
 * 읽지 않은 수는 셸 레이아웃이 읽는 경로(/api/alerts/unread-count)를 그대로 읽습니다 — 동시에 나가면 요청 하나로 합쳐집니다
 * (lib/sharedRequest). 모르면(읽는 중·실패) "—"이고 0으로 적지 않습니다. 지난 사건(late)은 그 수에 들지 않으므로 강조하지 않고
 * "지난 사건"으로 적습니다(/alerts와 같음).
 *
 * 알려진 한계: 알림 테이블이 아직 없으면 백엔드가 unread 0·빈 목록을 보내(AlertController — 응답 모양은 1단계에서 바꾸지 않음)
 * 그때는 모름이 "0건"·"새 알림이 없습니다"로 보입니다.
 */
export function AlertsSummary() {
  const unread = useApi<{ unread: number }>(endpoints.alerts.unreadCount, HOME_REFRESH_MS.alerts);
  const inbox = useApi<InboxResponse>(endpoints.alerts.inbox(HOME_ALERT_LIMIT), HOME_REFRESH_MS.alerts);
  const rows = latestAlerts(inbox.data);

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
      // 구분선은 카드 가장자리까지(-mx-5·sm:-mx-6 = 카드 안쪽 여백), 줄 글자는 카드 글과 같은 세로줄(px-5·sm:px-6)에 둡니다.
      <ul className="-mx-5 divide-y divide-border border-y border-border sm:-mx-6">
        {rows.map((row) => (
          <li key={row.id} className="flex min-h-[54px] items-start gap-3 px-5 py-2 sm:px-6">
            {/* 점은 보조 표시이고 뜻은 옆의 "읽음·안 읽음·지난 사건" 글자로 전합니다(색만으로 전하지 않음). 읽지 않은 수에 드는 것만 칠합니다. */}
            <span
              aria-hidden="true"
              className={`mt-1.5 size-2 shrink-0 rounded-full ${row.unread ? "bg-accent" : "border border-text-3"}`}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className={`truncate text-[15px] leading-5 ${row.unread ? "font-semibold text-text" : "text-text-2"}`}>
                {row.title}
              </span>
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
