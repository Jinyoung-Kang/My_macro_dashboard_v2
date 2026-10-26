"use client";

import Link from "next/link";
import { Empty, Hero, ProvenanceBadge, Skeleton, StatGrid, StatTile } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { HOME_REFRESH_MS, HOME_REGIME_YEARS, REGIME_AS_OF_NOTE, regimeHeroModel } from "@/lib/home";
import { SOURCES } from "@/lib/sources";
import type { RegimeResponse } from "@/lib/types";
import { HOME_LINK, HomeCard, SectionError } from "./HomeCard";

const TITLE = "오늘의 국면";

/**
 * ① 오늘의 국면 — 판정 라벨(히어로 값) · 백엔드 판정 문장 · 기준일 · 출처 · 신호 타일 네 개(값+단위, 상태·해석 글) · 백엔드 고지.
 *
 * 판정 글은 백엔드가 보낸 문장 그대로입니다(화면이 판정을 짓지 않음). 입력이 빠지면 "판정 불가"(중립색 — 판정 난 라벨과 구별)와
 * 받지 못한 입력 목록을 보이고, 빠진 신호의 타일은 "—"와 사유로 남깁니다.
 *
 * "3일 확정" 배지는 두지 않습니다 — /api/analytics/regime 응답에 확정 필드가 없고, 연속 일수를 화면에서 세면 알림 규칙
 * (AlertRules.confirmedChanges·QA-054)을 다시 구현하게 됩니다(ADR 0004). 백엔드가 필드를 보내면 meta에 붙입니다.
 */
export function RegimeHero() {
  const { data, error, reload, refreshError } = useApi<RegimeResponse>(
    endpoints.insight.regime(HOME_REGIME_YEARS),
    HOME_REFRESH_MS.regime,
  );

  if (!data) {
    return (
      <HomeCard title={TITLE}>
        {error ? (
          <SectionError message={error} onRetry={() => void reload()} />
        ) : (
          <Skeleton lines={5} label="오늘의 국면을 불러오는 중" />
        )}
      </HomeCard>
    );
  }

  const model = regimeHeroModel(data);
  return (
    <Hero
      label={TITLE}
      // 판정 불가는 판정 난 라벨과 같은 잉크로 그리지 않습니다 — 중립색(브리프 §1.1 neutral = 변화 없음·판정 불가).
      value={model.known ? model.label : <span className="text-neutral">{model.label}</span>}
      verdict={model.summary}
      meta={
        <>
          <span className="text-xs text-text-3">
            기준일 <span className="tabular-nums text-text-2">{model.asOf ?? <Empty />}</span> · {REGIME_AS_OF_NOTE}
          </span>
          <ProvenanceBadge source={SOURCES.regime} />
          {/* 다시 읽기가 실패하면 앞서 받은 판정을 그대로 두고 '새로 읽지 못함'을 붙입니다(QA-067). */}
          <Freshness refreshError={refreshError} />
          <Link href="/regime" className={HOME_LINK}>
            국면 판정 자세히
          </Link>
        </>
      }
    >
      {model.missing.length > 0 ? (
        <p className="mb-3 text-sm text-warn">
          <span aria-hidden="true">⚠️ </span>
          받지 못한 입력: {model.missing.join(" · ")}
        </p>
      ) : null}
      {/* 히어로가 데스크톱에서 반 폭이라 네 칸이면 타일이 60px대로 좁아집니다 — 늘 두 칸(2×2). */}
      <StatGrid cols={2}>
        {model.tiles.map((tile) => (
          <StatTile
            key={tile.id}
            label={tile.label}
            value={tile.valueText}
            unit={tile.unit}
            note={tile.note}
            emptyReason={tile.emptyReason}
          />
        ))}
      </StatGrid>
      {model.note ? <p className="mt-3 text-xs leading-relaxed text-text-3">{model.note}</p> : null}
    </Hero>
  );
}
