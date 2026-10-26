"use client";

import Link from "next/link";
import { Fragment } from "react";
import { Empty, ProvenanceBadge, Skeleton } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import { HOME_REFRESH_MS, storeStatusModel, type StoreStatusModel } from "@/lib/home";
import { SOURCES } from "@/lib/sources";
import type { StatusIssuesResponse } from "@/lib/types";
import { SectionError } from "./HomeCard";

const TITLE = "데이터 저장소 상태";

// 글이 본 뜻(오류 N건)이고 색은 보조입니다. 오류는 danger(상승 빨강과 다른 값), 경고는 warn.
const TONE: Record<StoreStatusModel["tone"], string> = {
  danger: "text-danger",
  warn: "text-warn",
  neutral: "text-text-2",
};

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
      <section aria-label={TITLE} className="min-w-0 rounded-xl border border-border bg-surface px-4 py-3">
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
  return (
    <section aria-label={TITLE} className="min-w-0">
      <Link
        href="/status"
        className="group flex min-h-[54px] flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-surface px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        <span className="font-medium text-text-2 group-hover:underline">{TITLE}</span>
        <span className={`tabular-nums font-semibold ${TONE[model.tone]}`}>
          {model.parts.map((part, index) => (
            <Fragment key={part.label}>
              {index > 0 ? " · " : null}
              {part.label} {part.text ?? <Empty />}
            </Fragment>
          ))}
        </span>
        {model.notice ? (
          <span className="text-xs text-warn">
            <span aria-hidden="true">⚠️ </span>
            <span className="sr-only">주의: </span>
            {model.notice}
          </span>
        ) : null}
        {/* 데이터 카드마다 출처 줄(PRINCIPLES) — 수는 상태 화면의 '수집 오류·경고 로그'와 같은 출처에서 셉니다. */}
        <ProvenanceBadge source={SOURCES.collectorRuns} />
        {model.checkedAt ? <span className="text-xs tabular-nums text-text-3">확인 {model.checkedAt}</span> : null}
        <Freshness refreshError={issues.refreshError} />
      </Link>
    </section>
  );
}
