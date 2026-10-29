"use client";

import { useId, useState } from "react";
import { AssetRow, ChangeChip, Empty, Hero, ProvenanceBadge, Skeleton, StaleBadge } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import { HOME_REFRESH_MS, paperHomeModel } from "@/lib/home";
import { PAPER_SOURCES } from "@/lib/paper";
import type { PaperMarketCode } from "@/lib/paperMarket";
import type { PaperOverviewResponse, PaperStatusResponse } from "@/lib/types";
import { HomeCard, SectionError } from "./HomeCard";

// 불러오는 중·오류·읽은 뒤 모두 같은 구역 이름입니다(HomeCard와 Hero 제목). 큰 숫자가 무엇인지(Claude 계좌 순자산)를 제목에 함께 적어
// 숫자보다 먼저 읽히게 합니다 — 값 아래 설명(heroCaption)에만 있으면 숫자를 본 뒤에야 어느 계좌인지 알았습니다.
const TITLE = "모의매매 · Claude 계좌 순자산";

/**
 * ② 모의매매 히어로 — 운영자 전용(/api/paper/* 전부 OWNER). 운영자가 아니면 요청하지 않고(null 경로) 그리지 않습니다.
 *
 * 히어로 값은 Claude 계좌 순자산과 그 평가 시각(마지막 관측), 아래로 네 계좌 행(값 = 순자산, 변화율 = 출발 대비 — 일간 변화 필드는
 * 응답에 없어 만들지 않음). 쓰기 버튼(초기화·리스크 실행 등)은 두지 않습니다 — 홈은 읽기만 하고, 조작은 모의매매 화면에서 합니다.
 *
 * 미국 | 한국 탭(2단계 명세 §4-16): 미국이 기본이고, 한국을 처음 고를 때부터 `?market=KR` 개요·상태를 읽습니다(고르기 전에는 한국 요청 없음 —
 * 한 번 고른 뒤에는 미국으로 돌아가도 두 시장 값을 계속 읽어 두어, 어느 쪽으로 돌아와도 자리표시 없이 바로 보임). 한국은 원 단위 정수, 행 링크
 * /paper/kr. 두 탭 모두 '두 책 수익률은 서로 비교하지 않음' 문구를 적습니다(§3 '탭마다'). 한국을 읽는 중·실패에도 같은 히어로 틀(Hero의
 * placeholder)이라 탭이 같은 자리에 남아 — 다시 마운트되지 않아 키보드 초점을 잃지 않음 — 미국으로 돌아갈 수 있습니다.
 */
export function PaperHero() {
  const owner = isOwner(useSessionUser());
  const [market, setMarket] = useState<PaperMarketCode>("US");
  // 한국을 한 번이라도 골랐나 — 그 뒤로는 한국 경로를 비우지 않습니다(비우면 useApi가 값을 지워 다시 고를 때마다 자리표시).
  const [krPicked, setKrPicked] = useState(false);
  const korea = market === "KR";
  const pick = (next: PaperMarketCode) => {
    setMarket(next);
    if (next === "KR") setKrPicked(true);
  };
  const usOverview = useApi<PaperOverviewResponse>(owner ? endpoints.paper.overview : null, HOME_REFRESH_MS.paper);
  const usStatus = useApi<PaperStatusResponse>(owner ? endpoints.paper.status : null, HOME_REFRESH_MS.paper);
  const krPaths = endpoints.paper.market("KR");
  const krOverview = useApi<PaperOverviewResponse>(owner && krPicked ? krPaths.overview : null, HOME_REFRESH_MS.paper);
  const krStatus = useApi<PaperStatusResponse>(owner && krPicked ? krPaths.status : null, HOME_REFRESH_MS.paper);
  const overview = korea ? krOverview : usOverview;
  const status = korea ? krStatus : usStatus;

  if (!owner) {
    return null;
  }
  const marketSwitch = <MarketSwitch value={market} onChange={pick} />;
  if (!overview.data) {
    const placeholder = overview.error ? (
      <SectionError message={overview.error} onRetry={() => void overview.reload()} />
    ) : (
      <Skeleton lines={5} label={korea ? "한국 모의매매 계좌를 불러오는 중" : "모의매매 계좌를 불러오는 중"} />
    );
    // 미국을 처음 읽는 동안은 고를 것이 없어 탭 없는 카드(예전 그대로). 한국을 고른 뒤의 읽는 중·실패는 아래 히어로와 같은 틀에 자리표시만 바꿔
    // 그립니다 — 틀이 다르면 시장 라디오가 다시 마운트되어 초점이 body로 빠지고 자리도 옮겨 갔습니다.
    if (!korea) return <HomeCard title={TITLE}>{placeholder}</HomeCard>;
    return <Hero label={TITLE} value={null} placeholder={placeholder} tabs={marketSwitch} />;
  }

  const model = paperHomeModel(overview.data, status.data, { market });
  return (
    <Hero
      label={TITLE}
      value={model.heroValueText}
      unit={model.heroUnit}
      change={
        model.heroReturnPct !== null ? (
          <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
            <ChangeChip changePct={model.heroReturnPct} />
            <span className="text-xs text-text-3">출발 대비</span>
          </span>
        ) : undefined
      }
      meta={
        <>
          {/* 평가 시각은 정기 작업이 켜져 있어도 늘 적습니다 — 리스크 작업이 멈추면 오래된 순자산이 시각 없이 지금 값처럼 보입니다. */}
          <span className="text-xs text-text-2">
            {model.heroCaption} · 마지막 관측 <span className="tabular-nums">{model.heroAsOf ?? <Empty />}</span>
          </span>
          <StaleBadge stale={model.heroStale} reason={model.heroStaleReason} />
          <ProvenanceBadge source={korea ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger} />
          {/* 다시 읽기가 실패하면 앞서 받은 값을 두고 '새로 읽지 못함'을 붙입니다(QA-067). */}
          <Freshness refreshError={overview.refreshError ?? status.refreshError} />
        </>
      }
      tabs={marketSwitch}
    >
      {model.message ? (
        <p className="text-sm text-text-2">{model.message}</p>
      ) : (
        // 구분선은 카드 가장자리까지 펼치고(-mx-5·sm:-mx-6 = 카드 안쪽 여백), 줄 안쪽 여백(px-1·sm:px-2)을 더해 행 글자(행 자체 px-4)를
        // 히어로 글과 같은 세로줄(20·24px)에 맞춥니다.
        <ul className="-mx-5 divide-y divide-border border-y border-border sm:-mx-6">
          {model.rows.map((row) => (
            <li key={row.id} className="px-1 sm:px-2">
              <AssetRow row={row} />
            </li>
          ))}
        </ul>
      )}
      {model.available ? <p className="mt-3 text-xs leading-relaxed text-text-3">{model.startLine}</p> : null}
      {model.dormantNote ? (
        <p className="mt-1 text-xs leading-relaxed text-warn">
          <span aria-hidden="true">⚠️ </span>
          <span className="sr-only">주의: </span>
          {model.dormantNote}
        </p>
      ) : null}
      {model.disabledNote ? (
        <p className="mt-1 text-xs leading-relaxed text-warn">
          <span aria-hidden="true">⚠️ </span>
          <span className="sr-only">주의: </span>
          {model.disabledNote}
        </p>
      ) : null}
      {/* 정기 작업이 켜졌는지 모르면(상태 응답 실패) 모른다고 적습니다 — 꺼짐 안내가 없다고 켜진 것은 아닙니다. */}
      {!status.data && status.error ? (
        <p className="mt-1 text-xs text-text-3">정기 작업 상태를 확인하지 못했습니다 — {status.error}</p>
      ) : null}
      <p className="mt-1 text-xs leading-relaxed text-text-3">{model.compareNote}</p>
    </Hero>
  );
}

/**
 * 미국 | 한국 — 화면 테마 전환(ThemeSwitch)과 같은 브라우저 기본 라디오 묶음입니다(고른 시장이 "선택됨"으로 읽힘). 고르면 그 시장의 개요를
 * 히어로에 그립니다(한국 2단계 명세 §4-16 — 예전 '한국 · 준비 중' 막힘 해제).
 */
function MarketSwitch({ value, onChange }: { value: PaperMarketCode; onChange: (market: PaperMarketCode) => void }) {
  const name = useId();
  const options: { market: PaperMarketCode; label: string }[] = [
    { market: "US", label: "미국" },
    { market: "KR", label: "한국" },
  ];
  return (
    <div role="radiogroup" aria-label="모의매매 시장" className="inline-flex rounded-lg border border-border p-0.5 text-sm">
      {options.map((option) => {
        const checked = option.market === value;
        return (
          <label
            key={option.market}
            className={`inline-flex min-h-11 cursor-pointer items-center rounded-md px-3 py-1 lg:min-h-0 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus ${
              checked ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:text-text"
            }`}
          >
            <input
              type="radio"
              name={name}
              value={option.market.toLowerCase()}
              checked={checked}
              onChange={() => onChange(option.market)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}
