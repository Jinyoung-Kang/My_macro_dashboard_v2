"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Empty, PropertyList, ProvenanceBadge, Skeleton } from "@/components/patterns";
import { Freshness, Panel } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { REGIME_AS_OF_NOTE, regimeHeroModel } from "@/lib/home";
import { SOURCES } from "@/lib/sources";
import type { RegimeResponse } from "@/lib/types";
import { HOME_LINK, SectionError } from "./HomeCard";
import type { ApiRead } from "./useHomeData";

const TITLE = "오늘의 국면";

/**
 * ① 오늘의 국면 패널 — 판정 라벨 · 백엔드 판정 문장 · 기준일(뜻 포함) · 출처 · 받지 못한 입력 · 신호 넷(속성 목록 — 값+단위, 상태·해석 글) · 백엔드 고지.
 * 머리에는 다시 읽기 실패 표시와 '국면 판정 자세히'(/regime).
 *
 * 판정 글은 백엔드가 보낸 문장 그대로입니다(화면이 판정을 짓지 않음). 입력이 빠지면 "판정 불가"(중립색 — 판정 난 라벨과 구별)와
 * 받지 못한 입력 목록을 보이고, 빠진 신호의 줄은 "—"와 사유로 남깁니다(lib/home regimeHeroModel이 네 자리를 고정).
 *
 * "3일 확정" 배지는 두지 않습니다 — /api/analytics/regime 응답에 확정 필드가 없고, 연속 일수를 화면에서 세면 알림 규칙
 * (AlertRules.confirmedChanges·QA-054)을 다시 구현하게 됩니다(ADR 0004). 백엔드가 필드를 보내면 라벨 옆에 붙입니다.
 *
 * 국면 응답은 홈 화면 훅(useHomeData)이 읽어 넘깁니다 — 맨 위 KPI 띠의 국면 타일과 같은 응답입니다.
 */
export function RegimePanel({ read }: { read: ApiRead<RegimeResponse> }) {
  const { data, error, reload, refreshError } = read;
  const actions = (
    <>
      {/* 다시 읽기가 실패하면 앞서 받은 판정을 그대로 두고 '새로 읽지 못함'을 붙입니다(QA-067). */}
      <Freshness refreshError={refreshError} />
      <Link href="/regime" className={HOME_LINK}>
        국면 판정 자세히
      </Link>
    </>
  );

  let body: ReactNode;
  if (!data) {
    body = error ? <SectionError message={error} onRetry={() => void reload()} /> : <Skeleton lines={5} label="오늘의 국면을 불러오는 중" />;
  } else {
    const model = regimeHeroModel(data);
    body = (
      <>
        {/* 값은 숫자가 아니라 판정 라벨 — 패널 제목과 같은 글자 단계(heading-sm). 판정 불가는 판정 난 라벨과 같은 잉크로 그리지 않습니다(중립색). */}
        <p className={`text-heading-sm ${model.known ? "text-text" : "text-neutral"}`}>{model.label}</p>
        {model.summary ? <p className="mt-1 text-sm leading-relaxed text-text-2">{model.summary}</p> : null}
        <p className="mt-2 text-xs text-text-3">
          기준일 <span className="tabular-nums text-text-2">{model.asOf ?? <Empty />}</span> · {REGIME_AS_OF_NOTE}
        </p>
        <p className="mt-1 leading-4">
          <ProvenanceBadge source={SOURCES.regime} />
        </p>
        {model.missing.length > 0 ? (
          <p className="mt-3 text-sm text-warn">
            <StatusText tone="warn">받지 못한 입력: {model.missing.join(" · ")}</StatusText>
          </p>
        ) : null}
        <div className="mt-3">
          <PropertyList
            dense
            items={model.tiles.map((tile) => ({
              key: tile.id,
              label: tile.label,
              value: tile.valueText,
              unit: tile.unit,
              note: tile.note,
              emptyReason: tile.emptyReason,
            }))}
          />
        </div>
        {model.note ? <p className="mt-3 text-xs leading-relaxed text-text-3">{model.note}</p> : null}
      </>
    );
  }

  return (
    <Panel region className="min-w-0" title={TITLE} actions={actions}>
      {body}
    </Panel>
  );
}
