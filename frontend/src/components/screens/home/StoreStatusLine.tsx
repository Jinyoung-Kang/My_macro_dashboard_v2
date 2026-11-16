"use client";

import Link from "next/link";
import { Fragment } from "react";
import { Empty, ProvenanceBadge, Skeleton } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { storeStatusModel } from "@/lib/home";
import { SOURCES } from "@/lib/sources";
import type { StatusIssuesResponse } from "@/lib/types";
import { SectionError } from "./HomeCard";
import type { ApiRead } from "./useHomeData";

/**
 * 수집 상태 한 줄(알림·끊긴 출처 패널 안, 운영자만) — "수집 태스크 오류 N건 · 경고 M건 · 누락 데이터셋 K개"(누르면 상태 화면 /status). 수를 모르면
 * "—"이고 0으로 적지 않습니다. 수집기에 닿지 못하면 그 안내를 붙입니다(그때 수는 DB 기록만으로 센 것 — lib/home storeStatusModel).
 *
 * 수는 홈 화면 훅(useHomeData)이 운영자일 때만 읽어 넘기고, 패널은 운영자에게만 이 줄을 그립니다. 이름은 패널 안 제목('수집 상태')이 나르므로
 * 줄 안에 따로 적지 않습니다. 읽는 중·실패에도 같은 자리(제목 아래)에 자리표시·오류만 둡니다.
 */
export function StoreStatusLine({ read: issues }: { read: ApiRead<StatusIssuesResponse> }) {
  if (!issues.data) {
    return issues.error ? (
      <SectionError message={issues.error} onRetry={() => void issues.reload()} />
    ) : (
      <Skeleton lines={1} label="수집 상태를 불러오는 중" />
    );
  }

  const model = storeStatusModel(issues.data);
  // 항목(이름 + 수)마다 줄 바꿈 없는 덩어리 — 좁은 화면에서 줄은 ' · ' 자리에서만 바뀌고 '누락 데이터셋' / '1개'처럼 이름과 수가
  // 갈라지지 않습니다(QA-505 — 아이콘이 붙자 390px에서 한 줄이 넘쳤음).
  const counts = model.parts.map((part, index) => (
    <Fragment key={part.label}>
      {index > 0 ? " · " : null}
      <span className="whitespace-nowrap">
        {part.label} {part.text ?? <Empty />}
      </span>
    </Fragment>
  ));
  return (
    // 줄 전체가 상태 화면 링크 — 좁은 화면 누르는 높이 44px, 마우스를 올리면 바탕(surface-2)과 수 글 밑줄. 바탕이 패널 글 세로줄 밖으로 6px 나가게
    // 좌우 여백을 음수 여백으로 되돌립니다(글은 패널 글과 같은 세로줄).
    <Link
      href="/status"
      className="group -mx-1.5 flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 rounded-control px-1.5 py-1 text-sm hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:min-h-0"
    >
      {/* 글이 본 뜻(오류 N건)이고 색은 보조입니다. 오류는 danger, 경고는 warn — danger는 상승 빨강과 거의 같은 색(ΔE 4.4 — W4)이라
            늘 아이콘과 함께 그립니다(QA-505). 글에 이미 '오류'·'경고'가 있어 읽어 주는 머리말은 비웁니다. 모두 0이면 상태가 아니라 아이콘이 없습니다.
            수집기 연결 안 됨은 옆 안내가 주의 아이콘과 함께 나르므로 수 묶음의 톤에 넣지 않습니다(lib/home storeStatusModel). */}
      {model.tone === "neutral" ? (
        <span className="tabular-nums font-semibold text-text-2 group-hover:underline">{counts}</span>
      ) : (
        <StatusText tone={model.tone} srPrefix="" className="tabular-nums font-semibold group-hover:underline">
          {counts}
        </StatusText>
      )}
      {model.notice ? (
        <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />} className="text-xs">
          {model.notice}
        </StatusText>
      ) : null}
      {/* 데이터 카드마다 출처 줄(PRINCIPLES) — 수는 상태 화면의 '수집 오류·경고 로그'와 같은 출처에서 셉니다. */}
      <ProvenanceBadge source={SOURCES.collectorRuns} />
      {model.checkedAt ? <span className="text-xs tabular-nums text-text-3">확인 {model.checkedAt}</span> : null}
      <Freshness refreshError={issues.refreshError} />
    </Link>
  );
}
