"use client";

import { useId } from "react";
import { AssetRow, ChangeChip, Empty, Hero, ProvenanceBadge, Skeleton, StaleBadge } from "@/components/patterns";
import { Freshness } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import { HOME_REFRESH_MS, paperHomeModel } from "@/lib/home";
import { PAPER_SOURCES } from "@/lib/paper";
import type { PaperOverviewResponse, PaperStatusResponse } from "@/lib/types";
import { HomeCard, SectionError } from "./HomeCard";

// 불러오는 중·오류·읽은 뒤 모두 같은 구역 이름입니다(HomeCard와 Hero 제목). 큰 숫자가 무엇인지(Claude 계좌 순자산)를 제목에 함께 적어
// 숫자보다 먼저 읽히게 합니다 — 값 아래 설명(heroCaption)에만 있으면 숫자를 본 뒤에야 어느 계좌인지 알았습니다.
const TITLE = "모의매매 · Claude 계좌 순자산";

/**
 * ② 모의매매(미국) 히어로 — 운영자 전용(/api/paper/* 전부 OWNER). 운영자가 아니면 요청하지 않고(null 경로) 그리지 않습니다.
 *
 * 히어로 값은 Claude 계좌 순자산과 그 평가 시각(마지막 관측), 아래로 네 계좌 행(값 = 순자산, 변화율 = 출발 대비 — 일간 변화 필드는
 * 응답에 없어 만들지 않음). 쓰기 버튼(초기화·리스크 실행 등)은 두지 않습니다 — 홈은 읽기만 하고, 조작은 모의매매 화면에서 합니다.
 */
export function PaperHero() {
  const owner = isOwner(useSessionUser());
  const overview = useApi<PaperOverviewResponse>(owner ? endpoints.paper.overview : null, HOME_REFRESH_MS.paper);
  const status = useApi<PaperStatusResponse>(owner ? endpoints.paper.status : null, HOME_REFRESH_MS.paper);

  if (!owner) {
    return null;
  }
  if (!overview.data) {
    return (
      <HomeCard title={TITLE}>
        {overview.error ? (
          <SectionError message={overview.error} onRetry={() => void overview.reload()} />
        ) : (
          <Skeleton lines={5} label="모의매매 계좌를 불러오는 중" />
        )}
      </HomeCard>
    );
  }

  const model = paperHomeModel(overview.data, status.data);
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
          <ProvenanceBadge source={PAPER_SOURCES.ledger} />
          {/* 다시 읽기가 실패하면 앞서 받은 값을 두고 '새로 읽지 못함'을 붙입니다(QA-067). */}
          <Freshness refreshError={overview.refreshError ?? status.refreshError} />
        </>
      }
      tabs={<MarketSwitch />}
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
    </Hero>
  );
}

/**
 * 미국 | 한국 · 준비 중 — 한국 증시 책은 2단계(계획서 §4)라 고를 수 없게 막아 두고, 무엇이 올지는 보입니다.
 *
 * 화면 테마 전환(ThemeSwitch)과 같은 브라우저 기본 라디오 묶음입니다 — 미국이 골라져 있고 한국은 사용 불가(disabled)라 낭독기가
 * "선택됨" / "사용 불가"로 읽습니다(예전 aria-pressed 토글은 눌러도 아무 일이 없어 읽는 말과 동작이 달랐음). 사유("준비 중")는
 * title이 아니라 보이는 글이라 키보드·터치 사용자도 봅니다. 고를 것이 하나뿐이라 상태를 들지 않습니다(defaultChecked).
 */
function MarketSwitch() {
  const name = useId();
  return (
    <div role="radiogroup" aria-label="모의매매 시장" className="inline-flex rounded-lg border border-border p-0.5 text-sm">
      <label className="rounded-md bg-surface-2 px-3 py-1 font-semibold text-text has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus">
        <input type="radio" name={name} value="us" defaultChecked className="sr-only" />
        미국
      </label>
      <label className="cursor-not-allowed rounded-md px-3 py-1 text-text-3">
        <input type="radio" name={name} value="kr" disabled className="sr-only" />
        한국 · 준비 중<span className="sr-only"> (2단계에서 엽니다)</span>
      </label>
    </div>
  );
}
