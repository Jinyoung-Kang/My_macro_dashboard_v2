"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { Empty, Skeleton } from "@/components/patterns";
import { Freshness, Panel } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { homeReadFailed, KPI_READ_FAILED, latestAlerts, sourceIncidentsModel, unreadText } from "@/lib/home";
import type { InfoSourcesResponse } from "@/lib/info";
import { searchWatchInboxHref } from "@/lib/infoSearch";
import type { StatusIssuesResponse } from "@/lib/types";
import { HOME_LINK, SectionError } from "./HomeCard";
import { StoreStatusLine } from "./StoreStatusLine";
import { type ApiRead, type HomeAlertsRead, useHomeAlerts } from "./useHomeData";

/** 운영자만 보는 두 칸(끊긴 출처·수집 상태)이 읽는 것 — 홈 화면 훅이 운영자일 때만 읽습니다. */
export type HomeOpsRead = {
  issues: ApiRead<StatusIssuesResponse>;
  sources: ApiRead<InfoSourcesResponse>;
};

/** 패널 안 작은 제목(h3) — 검사 칸의 작은 제목과 같은 글자(공용 PropertyList 제목과 같음). */
const SUBHEAD = "text-caption font-semibold text-text-2";

/**
 * ④ 알림·끊긴 출처 패널 — 최근 알림 세 건(제목·발생일·읽음 여부)과, 운영자에게는 끊긴 출처(수집 끊김)와 수집 상태 한 줄. 머리에는 읽지 않은 수와
 * '알림 전체 보기'. 회원·데모는 알림만이라 제목도 '알림'입니다. 읽음 처리는 알림 화면에서 합니다.
 *
 * 읽지 않은 수는 셸 레이아웃이 읽는 경로(/api/alerts/unread-count)를 그대로 읽습니다 — 동시에 나가면 요청 하나로 합쳐집니다
 * (lib/sharedRequest). 0으로 적지 않고, 맨 위 KPI 띠의 '읽지 않은 알림' 타일과 같은 갈래로 그립니다(lib/home homeReadFailed — P4 '정한 것' 11, QA-605):
 * 읽는 중이면 글줄 안의 짧은 자리표시(role=status), 읽지 못했으면 '—'(읽어 주기 '값 없음 읽지 못함' — 이 수만의 구역이 없어 오류 글·다시 시도는 두지 않음,
 * 자동 갱신이 다시 읽음), 응답에 수가 없으면 '—'. 지난 사건(late)은 그 수에 들지 않으므로 강조하지 않고 "지난 사건"으로 적습니다(/alerts와 같음).
 *
 * 정보 검색 관심 대상의 새 글 알림(SEARCH_WATCH)은 제목이 그 대상의 타임라인으로 가는 링크입니다(/alerts와 같음 — 정보 검색 화면 안쪽 주소만).
 *
 * 끊긴 출처는 셸의 수집 끊김 안내 띠와 같은 응답(/api/info/sources)이고, 띠를 닫았는지와 상관없이 지금 끊긴 출처를 모두 적습니다(lib/home
 * sourceIncidentsModel — 판정 기록이 없으면 '없다'고 적지 않음). 홈에서는 셸이 그 띠를 그리지 않아 이 칸이 대신합니다(QA-613). 수집 상태 줄은 상태 화면의 오류·경고·누락 수(StoreStatusLine).
 *
 * 알려진 한계: 알림 테이블이 아직 없으면 백엔드가 unread 0·빈 목록을 보내(AlertController — 응답 모양은 1단계에서 바꾸지 않음)
 * 그때는 모름이 "0건"·"새 알림이 없습니다"로 보입니다.
 *
 * 읽기는 홈 화면 훅(useHomeData)이 하고 `alerts`·`ops`로 넘깁니다. `alerts`를 넘기지 않으면(홈 밖 — 알림 화면 시험) 알림 두 경로를 이 패널이 스스로
 * 읽고, `ops`가 없으면(운영자가 아님) 운영자 칸을 그리지 않습니다.
 */
export function AlertsSummary({ alerts, ops }: { alerts?: HomeAlertsRead; ops?: HomeOpsRead | null }) {
  const own = useHomeAlerts(alerts === undefined);
  const { unread, inbox } = alerts ?? own;
  const alertsHeadingId = useId();

  return (
    <Panel
      region
      className="min-w-0"
      title={ops ? "알림·끊긴 출처" : "알림"}
      actions={
        <>
          <span className="text-xs text-text-2">
            읽지 않음 <span className="tabular-nums font-semibold text-text"><UnreadValue unread={unread} /></span>
          </span>
          <Freshness refreshError={inbox.refreshError ?? unread.refreshError} />
          <Link href="/alerts" className={HOME_LINK}>
            알림 전체 보기
          </Link>
        </>
      }
    >
      {/* 운영자 칸이 함께 있을 때만 작은 제목으로 가릅니다(회원은 알림 하나라 패널 제목이 이름을 나름). */}
      {ops ? (
        <h3 id={alertsHeadingId} className={`mb-1 ${SUBHEAD}`}>
          최근 알림
        </h3>
      ) : null}
      <AlertRows inbox={inbox} labelledBy={ops ? alertsHeadingId : undefined} />
      {ops ? (
        <>
          <SourceIncidents read={ops.sources} />
          <h3 className={`mt-4 mb-1 ${SUBHEAD}`}>수집 상태</h3>
          <StoreStatusLine read={ops.issues} />
        </>
      ) : null}
    </Panel>
  );
}

/**
 * 머리의 읽지 않은 수 — 값이 있으면 'N건'(수가 없으면 '—'), 읽지 못했으면 '—'(사유 '읽지 못함'은 읽어 주기로만), 읽는 중이면 글줄 높이 안의 짧은 자리표시.
 * 읽는 중과 실패를 같은 '—'(읽어 주기 '값 없음')로 그리면 눈으로도 낭독으로도 갈리지 않았습니다(QA-605) — 이제 읽는 중은 막대, 실패는 '—'입니다.
 *
 * - 실패의 보이는 글은 '—'만입니다. 사유까지 보이면('— 읽지 못함') 머리 값이 66.7px → 122px로 넓어져, 남은 폭이 적은 360·375px와 1024px(메뉴 256 이상)에서
 *   패널 머리가 두 줄로 꺾였습니다(65 → 97px · 45 → 69px). 보이는 사유는 같은 화면 KPI 띠의 같은 타일이 적습니다.
 * - 실패는 error가 아니라 homeReadFailed(실패 시각 failedAt)로 정합니다 — useApi는 다시 읽기를 시작할 때 error를 비우므로, error로 정하면 수가 계속
 *   실패하는 동안 다시 읽을 때마다(300초 자동 갱신·탭 복귀·수동 새로고침) 실패 → 자리표시 → 실패로 오갔습니다(QA-605 검토, QA-608과 같은 까닭).
 */
function UnreadValue({ unread }: { unread: HomeAlertsRead["unread"] }) {
  if (unread.data !== null) {
    return <>{unreadText(unread.data) ?? <Empty />}</>;
  }
  if (homeReadFailed(unread)) {
    // relative — 안의 sr-only(절대 위치)가 가로 스크롤 상자 밖으로 빠져 문서 폭을 넓히지 않게(Empty와 같은 까닭).
    return (
      <span className="relative">
        <Empty />
        <span className="sr-only">{KPI_READ_FAILED}</span>
      </span>
    );
  }
  return <Skeleton inline label="읽지 않은 수 불러오는 중" />;
}

/** 최근 알림 세 건 — 줄마다 점·제목(관심 대상 새 글이면 링크)·발생일·읽음 글. */
function AlertRows({ inbox, labelledBy }: { inbox: HomeAlertsRead["inbox"]; labelledBy?: string }) {
  const rows = latestAlerts(inbox.data);
  // 줄 번호 → 가는 주소(SEARCH_WATCH만). latestAlerts는 종류·payload를 넘기지 않아 받은 줄에서 찾습니다.
  const hrefs = new Map((inbox.data?.items ?? []).map((item) => [item.id, searchWatchInboxHref(item)] as const));

  if (!inbox.data) {
    return inbox.error ? <SectionError message={inbox.error} onRetry={() => void inbox.reload()} /> : <Skeleton lines={3} label="알림을 불러오는 중" />;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-text-2">새 알림이 없습니다</p>;
  }
  return (
    <ul aria-labelledby={labelledBy} className="divide-y divide-border-subtle">
      {rows.map((row) => (
        <li key={row.id} className="relative flex min-h-14 items-start gap-3 py-2.5">
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

/**
 * 끊긴 출처(운영자) — 출처 이름 · 끊긴 종류(주의 아이콘 + 글) · 사유 · 끊긴 시각, 오른쪽 위 '출처 상태 보기'(/info/status — 셸 안내 띠의 링크와 같은 곳).
 * 끊긴 출처가 없으면 '끊긴 출처가 없습니다', 판정 기록이 없으면 모른다고 적습니다(lib/home sourceIncidentsModel).
 */
function SourceIncidents({ read }: { read: ApiRead<InfoSourcesResponse> }) {
  const headingId = useId();
  const model = sourceIncidentsModel(read.data);
  let body: ReactNode;
  if (!read.data) {
    body = read.error ? <SectionError message={read.error} onRetry={() => void read.reload()} /> : <Skeleton lines={2} label="끊긴 출처를 불러오는 중" />;
  } else if (model.rows.length === 0) {
    body = <p className="text-sm text-text-2">{model.message}</p>;
  } else {
    body = (
      <ul aria-labelledby={headingId} className="divide-y divide-border-subtle">
        {model.rows.map((row) => (
          <li key={row.key} className="flex min-w-0 flex-col gap-0.5 py-2">
            <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="break-keep text-sm text-text">{row.label}</span>
              {/* 끊긴 종류는 주의 아이콘 + 글(색만이 아님) — 셸 안내 띠와 같은 주의 톤. */}
              <StatusText tone="warn" iconSize={12} className="text-xs">
                {row.kindLabel}
              </StatusText>
            </span>
            {row.reason || row.since ? (
              <span className="break-keep text-xs leading-4 text-text-3">
                {[row.reason, row.since ? `${row.since}부터` : null].filter(Boolean).join(" · ")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      <div className="mt-4 mb-1 flex flex-wrap items-center justify-between gap-x-3">
        <h3 id={headingId} className={SUBHEAD}>
          끊긴 출처
        </h3>
        <span className="flex flex-wrap items-center gap-x-3">
          <Freshness refreshError={read.refreshError} />
          <Link href="/info/status" className={HOME_LINK}>
            출처 상태 보기
          </Link>
        </span>
      </div>
      {body}
    </>
  );
}

/**
 * 알림 한 줄의 제목 — 가는 주소가 있으면(관심 대상 새 글 알림) 링크로, 누르는 자리는 줄 전체(줄 높이 56px 이상 — 좁은 화면 44px 조건)로 넓힙니다.
 * 링크는 누를 수 있는 것이라 강조 파랑(명세 A1), 읽지 않음은 굵기로(색만이 아님 — 옆의 '안 읽음' 글).
 *
 * 제목은 두 줄까지 보이고(낱말 사이에서 줄바꿈 — 긴 영문 토큰만 칸 안에서 꺾음) 넘치면 말줄임, 전체 제목은 title로 둡니다(QA-418 관심 대상 이름과 같은 무늬).
 * 한 줄 말줄임이던 때는 반 칸(390·1024·1280)에서 13F 알림의 기관 이름 뒷부분과 종목 수가 가려지고, 링크가 아닌 종류는 홈에서 전체 제목을 볼 길이
 * 없었습니다(QA-606). 링크의 줄 전체 누르는 자리(::after)는 줄(li)이 기준이라 제목의 overflow에 잘리지 않습니다.
 */
function RowTitle({ title, unread, href }: { title: string; unread: boolean; href: string | null }) {
  if (!href) {
    return (
      <span title={title} className={`line-clamp-2 break-keep text-[15px] leading-5 wrap-anywhere ${unread ? "font-semibold text-text" : "text-text-2"}`}>
        {title}
      </span>
    );
  }
  return (
    <Link
      href={href}
      title={title}
      className={`line-clamp-2 break-keep rounded-sm text-[15px] leading-5 text-accent underline-offset-2 wrap-anywhere after:absolute after:inset-0 after:content-[''] hover:text-accent-hover hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
        unread ? "font-semibold" : ""
      }`}
    >
      {title}
    </Link>
  );
}
