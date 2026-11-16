"use client";

import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { ChangeChip, type Column, DataTable, EstimateBadge, ProvenanceBadge, Skeleton, StaleBadge } from "@/components/patterns";
import { Freshness, LINK_CLASSES, Panel, Tabs, tabId } from "@/components/ui";
import { AlertTriangleIcon, StatusText } from "@/components/ui/icons";
import { type HomeRow, MARKET_HREF, type MarketClock, marketGroups, pickMarketGroup } from "@/lib/home";
import { assetValueText } from "@/lib/patternRows";
import { presentText } from "@/lib/patterns";
import type { MacroOverview } from "@/lib/types";
import { HOME_LINK, SectionError } from "./HomeCard";
import type { ApiRead } from "./useHomeData";

const TITLE = "시장";

/**
 * 읽는 중 자리표시 높이(px) — 읽은 뒤 패널 높이에 맞춥니다(QA-598). QA 데이터(루프백 빌드) 1280·1440·1920 읽은 뒤 패널 446px(묶음 탭 + 표 넉 줄 — 변화 칩을 꺾지 않아
 * 넓어진 '변화' 칸 몫만큼 '기준' 칸이 좁아져 넉 줄 모두 출처 두 줄, QA-595 뒤)이고, 자리표시 330px일 때 패널이 417px였습니다. 1024는 470px, 390은 표가
 * 가로로 넘쳐 555px로 더 높지만 첫 화면 밖입니다(패널 위 끝 1024 1120px·390 2153px — 창 높이 900·844px, KPI 띠·국면·계좌 패널 아래).
 */
const MARKET_PENDING_HEIGHT = 359;

/** 지표 한 줄의 칸 — 지표(이름은 그 지표의 상세 링크) · 값 · 변화 · 기준(출처·장 상태·지연·시각과 배지). */
const COLUMNS: readonly Column<HomeRow>[] = [
  {
    key: "name",
    header: "지표",
    rowHeader: true,
    cell: (row) => (
      <Link href={row.href} className={`${LINK_CLASSES} break-keep`}>
        {row.name}
      </Link>
    ),
  },
  { key: "value", header: "값", align: "right", cell: (row) => assetValueText(row.value, row.valueText) },
  {
    key: "change",
    header: "변화",
    align: "right",
    // 직전 값이 없는 카드(delta·pct 모두 null — deltaStr "N/A")는 칩 대신 "—" — 0.00%를 만들지 않습니다. 변화량 자릿수는 수집기 deltaStr을 따릅니다.
    // 칩은 칸 안에서 꺾지 않습니다(nowrap — 변화량과 변화율이 두 줄로 갈리던 것, QA-595).
    cell: (row) =>
      row.change === null && row.changePct === null ? null : (
        <ChangeChip change={row.change} changePct={row.changePct} digits={row.changeDigits ?? 2} pctDigits={2} size="sm" nowrap />
      ),
  },
  {
    key: "basis",
    header: "기준",
    cell: (row) => (
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {/* 출처 · 장 상태 · 지연(열린 장만) · 시각 — 닫힌 장이라 적지 않은 지연은 툴팁(lib/home macroCardRow). */}
        <ProvenanceBadge source={row.source} asOf={row.asOf} delayMin={row.delayMin} title={row.provenanceTitle} />
        <EstimateBadge estimated={row.isEstimated} />
        <StaleBadge stale={row.isStale} reason={row.staleReason} />
        {row.warning ? (
          <StatusText tone="warn" icon={<AlertTriangleIcon size={12} />} className="text-xs">
            {row.warning}
          </StatusText>
        ) : null}
      </span>
    ),
  },
];

/**
 * ③ 시장 묶음 표 패널 — 매크로 카드 전부를 범주(묶음) 탭으로 나누고, 고른 묶음의 지표를 표로(처음은 첫 범주). 지표 이름은 그 지표의 상세(/markets/i/<키>)
 * 링크이고, 전체 표는 '매크로 지표 전체 보기'(/macro)입니다. 고른 탭은 화면 안 상태라 주소는 그대로입니다.
 *
 * 개요는 live 없이 읽습니다(5분 간격) — live=true면 신선도 기준이 60초로 내려가 백엔드가 Yahoo 수집을 자주 깨웁니다(429 이력).
 * 출처·장 상태·지연·시각은 모든 줄에, 추정·이전 값·경고·참고 시세는 해당 줄에 반드시 보입니다. 장 상태(개장·마감·휴장)는 보는 시각으로
 * 판정합니다(/macro SessionBadge와 같은 시계·공휴일 — 화면 훅이 읽음). 지연은 장이 열려 있을 때만 적습니다(lib/home macroCardSession).
 *
 * 개요와 시계는 홈 화면 훅(useHomeData)이 읽어 넘깁니다 — 맨 위 KPI 띠의 시장 타일과 같은 응답입니다.
 */
export function MarketPanel({
  read,
  clock,
  className,
}: {
  read: ApiRead<MacroOverview>;
  clock: Omit<MarketClock, "collectedAt">;
  className?: string;
}) {
  const { data, error, reload, refreshError } = read;
  const groups = marketGroups(data, clock);
  const [picked, setPicked] = useState<string | null>(null);
  const current = pickMarketGroup(groups, picked);
  const idPrefix = useId();
  const panelId = `${idPrefix}-panel`;

  let body: ReactNode;
  if (!data) {
    body = error ? <SectionError message={error} onRetry={() => void reload()} /> : <Skeleton height={MARKET_PENDING_HEIGHT} label="시장 시세를 불러오는 중" />;
  } else if (!current) {
    body = <p className="text-sm text-text-2">{presentText(data.message) ?? "매크로 카드 저장본이 아직 없습니다."}</p>;
  } else {
    body = (
      <>
        <Tabs
          label="시장 묶음"
          items={groups.map((group) => ({ key: group.id, label: group.title }))}
          value={current.id}
          onChange={setPicked}
          idPrefix={idPrefix}
          panelId={panelId}
        />
        <div role="tabpanel" id={panelId} aria-labelledby={tabId(idPrefix, current.id)} className="mt-3 min-w-0">
          <DataTable columns={COLUMNS} rows={current.rows} rowKey={(row) => row.id} caption={`${current.title} 지표`} scrollHint="overflow" />
        </div>
      </>
    );
  }

  return (
    <Panel
      region
      title={TITLE}
      count={current ? `${current.rows.length.toLocaleString("ko-KR")}개` : undefined}
      className={`min-w-0 ${className ?? ""}`.trim()}
      actions={
        <>
          {/* 저장본 전체의 수집 시각·늦음(15분 기준, 백엔드 stale)과 다시 읽기 실패(QA-067). */}
          {data ? (
            <Freshness collectedAt={data.collectedAtKst} ageSeconds={data.ageSeconds} stale={data.stale} refreshError={refreshError} />
          ) : null}
          <Link href={MARKET_HREF} className={HOME_LINK}>
            매크로 지표 전체 보기
          </Link>
        </>
      }
    >
      {body}
    </Panel>
  );
}
