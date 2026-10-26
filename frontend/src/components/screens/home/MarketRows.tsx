"use client";

import Link from "next/link";
import { useId, type ReactNode } from "react";
import { AssetList, Skeleton } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useKrOfficialHolidays } from "@/hooks/useKrOfficialHolidays";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { endpoints } from "@/lib/endpoints";
import { HOME_REFRESH_MS, MARKET_HREF, marketGroups } from "@/lib/home";
import { presentText } from "@/lib/patterns";
import type { MacroOverview } from "@/lib/types";
import { HOME_LINK, SectionError } from "./HomeCard";

/**
 * ③ 시장 — 매크로 카드 전부를 범주별 자산 행으로(데스크톱 두 칸, lg 미만 한 칸). 행을 누르면 매크로 지표 화면으로 갑니다.
 *
 * 개요는 live 없이 읽습니다(5분 간격) — live=true면 신선도 기준이 60초로 내려가 백엔드가 Yahoo 수집을 자주 깨웁니다(429 이력).
 * 출처·장 상태·지연·시각 배지는 모든 행에, 추정·이전 값·경고·참고 시세는 해당 행에 반드시 보입니다. 스파크라인은 개요에 이력이 없어 그리지 않습니다.
 *
 * 장 상태(개장·마감·휴장)는 보는 시각으로 판정합니다(/macro SessionBadge와 같은 시계·공휴일 훅, 데이터를 다시 받지 않음) —
 * 지연은 장이 열려 있을 때만 적습니다(lib/home macroCardSession). 범주 제목은 "시장" 아래의 h3입니다.
 */
export function MarketRows() {
  const headingId = useId();
  const { data, error, reload, refreshError } = useApi<MacroOverview>(endpoints.macro.overview(false), HOME_REFRESH_MS.macro);
  const now = useMinuteClock();
  const krOfficial = useKrOfficialHolidays(now);
  const groups = marketGroups(data, { now, krOfficial });

  let body: ReactNode;
  if (!data) {
    body = error ? (
      <SectionError message={error} onRetry={() => void reload()} />
    ) : (
      <Skeleton lines={6} label="시장 시세를 불러오는 중" />
    );
  } else if (groups.length === 0) {
    body = (
      <p className="rounded-xl border border-border bg-surface px-4 py-6 text-sm text-text-2">
        {presentText(data.message) ?? "매크로 카드 저장본이 아직 없습니다."}
      </p>
    );
  } else {
    body = (
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {groups.map((group) => (
          <AssetList key={group.id} title={group.title} rows={group.rows} showProvenance headingLevel={3} />
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={headingId} className="text-base font-semibold text-text">
          시장
        </h2>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          {/* 저장본 전체의 수집 시각·늦음(15분 기준, 백엔드 stale)과 다시 읽기 실패(QA-067). */}
          {data ? (
            <Freshness
              collectedAt={data.collectedAtKst}
              ageSeconds={data.ageSeconds}
              stale={data.stale}
              refreshError={refreshError}
            />
          ) : null}
          <Link href={MARKET_HREF} className={HOME_LINK}>
            매크로 지표 전체 보기
          </Link>
        </div>
      </div>
      {body}
    </section>
  );
}
