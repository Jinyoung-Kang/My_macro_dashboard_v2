"use client";

import Link from "next/link";
import { Fragment } from "react";
import { Empty, ProvenanceBadge, Skeleton } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import { HOME_REFRESH_MS, storeStatusModel } from "@/lib/home";
import { SOURCES } from "@/lib/sources";
import type { StatusIssuesResponse } from "@/lib/types";
import { SectionError } from "./HomeCard";

const TITLE = "데이터 저장소 상태";

/**
 * ⑤ 데이터 저장소 상태 한 줄 — "수집 태스크 오류 N건 · 경고 M건 · 누락 데이터셋 K개"(누르면 상태 화면). 운영자 전용(/api/status* OWNER)이라
 * 운영자가 아니면 요청하지 않고 그리지 않습니다. 수를 모르면 "—"이고 0으로 적지 않습니다. 수집기에 닿지 못하면 그 안내를 붙입니다
 * (그때 수는 DB 기록만으로 센 것 — lib/home storeStatusModel).
 */
export function StoreStatusLine() {
  const owner = isOwner(useSessionUser());
  const issues = useApi<StatusIssuesResponse>(owner ? endpoints.status.issues : null, HOME_REFRESH_MS.storeStatus);

  if (!owner) {
    return null;
  }
  if (!issues.data) {
    return (
      <section aria-label={TITLE} className="min-w-0 rounded-card border border-border bg-surface p-3 lg:p-4">
        <p className="text-sm font-medium text-text-2">{TITLE}</p>
        <div className="mt-2">
          {issues.error ? (
            <SectionError message={issues.error} onRetry={() => void issues.reload()} />
          ) : (
            <Skeleton lines={1} label="데이터 저장소 상태를 불러오는 중" />
          )}
        </div>
      </section>
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
    <section aria-label={TITLE} className="min-w-0">
      <Link
        href="/status"
        className="group flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-border bg-surface p-3 text-sm hover:bg-surface-2 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:p-4"
      >
        <span className="font-medium text-text-2 group-hover:underline">{TITLE}</span>
        {/* 글이 본 뜻(오류 N건)이고 색은 보조입니다. 오류는 danger, 경고는 warn — danger는 상승 빨강과 거의 같은 색(ΔE 4.4 — W4)이라
            늘 아이콘과 함께 그립니다(QA-505). 글에 이미 '오류'·'경고'가 있어 읽어 주는 머리말은 비웁니다. 모두 0이면 상태가 아니라 아이콘이 없습니다.
            수집기 연결 안 됨은 옆 안내가 주의 아이콘과 함께 나르므로 수 묶음의 톤에 넣지 않습니다(lib/home storeStatusModel). */}
        {model.tone === "neutral" ? (
          <span className="tabular-nums font-semibold text-text-2">{counts}</span>
        ) : (
          <StatusText tone={model.tone} srPrefix="" className="tabular-nums font-semibold">
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
    </section>
  );
}
