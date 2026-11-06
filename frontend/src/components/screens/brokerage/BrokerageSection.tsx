"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { LiveIntervalSelect } from "@/components/LiveIntervalSelect";
import { StaleBadge } from "@/components/patterns";
import { Banner, Button, ErrorState, Loading } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useLiveSeconds } from "@/hooks/useLiveSeconds";
import {
  brokerageBasisText,
  brokerageRefreshMs,
  brokerageRefreshNote,
  brokerageScope,
  brokerageStaleNote,
  brokerageView,
} from "@/lib/brokerage";
import { endpoints } from "@/lib/endpoints";
import type { PaperMarketCode } from "@/lib/paperMarket";
import { paperTabPath } from "@/lib/paperRoutes";
import type { BrokerageAccountResponse } from "@/lib/types/brokerage";
import { BrokerageSummary } from "./BrokerageSummary";
import { BrokerageHoldings, BrokerageOrders } from "./BrokerageTables";

/** 화면이 기다리는 한도 — 백엔드가 수집기를 기다리는 35초(수집기 갱신 예산 12초 + 끊지 않는 토큰 발급 최대 16초)보다 조금 길게. */
const TIMEOUT_MS = 40_000;

/**
 * 모의매매 화면의 '실제 계좌' 탭(ADR 0025, 명세 docs/specs/2026-11-05-toss-account-readonly.md §5) — 토스증권 실제 계좌를 읽기만 합니다.
 *
 * <p>모의 장부와 별개입니다. 한국 화면은 원화 쪽(국내 주식·원화 매수 가능 금액), 미국 화면은 달러 쪽만 보입니다(백엔드가 시장 쪽 하나만
 * 보냄). 모의 계좌처럼 읽히지 않게 히어로·계좌 행·'출발 이후' 칩을 쓰지 않고 통계 타일과 표만 쓰며, 주문·취소 단추와 쓰기 호출이 없습니다
 * (경계 시험 __tests__/brokerageBoundary.test.ts).
 *
 * <p>읽기는 이 탭이 붙을 때 한 번, '다시 읽기' 단추, 그리고 탭 머리의 주기 상자(명세 docs/specs/2026-11-06-us-costs-backfill.md §6 —
 * components/LiveIntervalSelect, 값은 다른 화면의 '실시간 시세'와 같은 hooks/useLiveSeconds)로 고른 주기입니다. 주기는 끄기 또는 10초 이상이고
 * 5초는 10초로 올려 씁니다 — 수집기 계좌 캐시(성공값 10초)보다 자주 읽어도 같은 값이고, 토스 계좌 API의 호출 한도와 운영 1분봉이 쓰는 단일 토큰을
 * 아낍니다. 셸의 수동 새로고침 신호는 따르지 않고, 탭을 숨기면 멈춥니다(useApi). 꺼짐(DISABLED)이면 주기와 상관없이 다시 읽지 않습니다.
 * 머리의 기준 시각은 수집기가 토스에서 그 값을 받은 시각(`fetchedAtKst`, 초까지)입니다 — 토스가 그 시각 가격으로 계산한 평가·손익.
 *
 * <p>상태: 꺼짐(DISABLED)은 안내만, 그 밖의 실패는 고정 문구와 다시 시도, 서버가 이전 값을 보이거나(isStale) 다시 읽기가 실패하면(refreshError)
 * '이전 값'과 받은 시각, 모르는 숫자는 "—"입니다.
 *
 * <p>`extraActions`는 부르는 쪽(PaperScreen)이 넘기는 단추로, 요약 카드의 '다시 읽기' 옆에 그대로 그립니다 — 실제 매매 켜기·끄기(ADR 0028)가 여기
 * 들어옵니다. 이 모듈은 그 단추가 무엇인지 모르고 실제 매매 모듈을 가져오지 않습니다(조회는 여전히 읽기 전용).
 */
export function BrokerageSection({ market, extraActions }: { market: PaperMarketCode; extraActions?: ReactNode }) {
  const [seconds] = useLiveSeconds();
  // 꺼짐(DISABLED) 응답을 받았으면 고른 주기와 상관없이 다시 읽지 않습니다(운영 서버에서만 켜는 기능 — 켜질 때까지 같은 안내).
  const [disabled, setDisabled] = useState(false);
  const { data, loading, error, reload, refreshError } = useApi<BrokerageAccountResponse>(
    endpoints.brokerage.account(market),
    disabled ? 0 : brokerageRefreshMs(seconds),
    { followRefresh: false, timeoutMs: TIMEOUT_MS },
  );
  useEffect(() => {
    setDisabled(data?.state === "DISABLED");
  }, [data]);
  const scope = brokerageScope(market);
  const view = data ? brokerageView(data) : null;
  const staleNote = data && view?.kind === "ok" ? brokerageStaleNote(data, refreshError) : null;

  return (
    <div className="flex flex-col gap-6">
      <Banner tone="info" icon={<LockIcon size={16} />}>
        <strong>실제 계좌(토스증권) — 모의 장부와 별개 · 조회는 읽기 전용 — 자동 매매는 위 실제 매매 칸</strong>
        <p className="mt-1 text-xs">
          {scope.currencyLabel} 자산만 — {scope.otherCurrencyLabel} 자산은{" "}
          <Link href={paperTabPath("real", scope.other)} className="text-accent underline underline-offset-2">
            {scope.otherScreen}의 실제 계좌 탭
          </Link>
        </p>
      </Banner>

      {view?.kind !== "disabled" && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="text-xs tabular-nums text-text-2">
            <p>
              기준 시각 <strong className="font-semibold text-bright">{view?.kind === "ok" ? brokerageBasisText(data) : "—"}</strong>
            </p>
            <p className="mt-0.5 text-text-3">토스가 그 시각 가격으로 계산한 평가·손익(수집기가 토스에서 받은 시각)</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LiveIntervalSelect label="새로고침" />
            <span className="text-xs text-text-3">{brokerageRefreshNote(seconds)} · 실시간 시세와 같은 주기</span>
          </div>
        </div>
      )}

      {loading && !data && <Loading label="실제 계좌를 읽는 중…" />}
      {/* 요청 자체가 실패(권한·백엔드 오류·시간 초과)하면 빈 표가 아니라 이유를 보입니다 — 앞서 받은 값이 있으면 아래 '이전 값'으로. */}
      {error && <ErrorState message={`실제 계좌를 읽지 못했습니다 — ${error}`} onRetry={reload} />}

      {view?.kind === "disabled" && <Banner tone="info">{view.text}</Banner>}

      {view?.kind === "failure" && data && (
        <Banner tone="warn">
          <p>{view.text}</p>
          {data.upstreamCode && <p className="mt-1 text-xs">토스 오류 코드 {data.upstreamCode}</p>}
          <Button size="sm" className="mt-2" onClick={() => void reload()} disabled={loading}>
            {loading ? "읽는 중…" : "다시 시도"}
          </Button>
        </Banner>
      )}

      {view?.kind === "ok" && data && (
        <>
          {staleNote && (
            <div>
              <StaleBadge stale reason={staleNote} />
            </div>
          )}
          <BrokerageSummary
            data={data}
            market={market}
            actions={
              <>
                <Button size="sm" onClick={() => void reload()} disabled={loading}>
                  {loading ? "다시 읽는 중…" : "다시 읽기"}
                </Button>
                {extraActions}
              </>
            }
          />
          <BrokerageHoldings rows={data.holdings ?? []} market={market} />
          <BrokerageOrders
            title="진행 중 주문(실제)"
            rows={data.openOrders ?? []}
            market={market}
            emptyText="진행 중 주문 없음"
          />
          <BrokerageOrders
            title="최근 끝난 주문(실제)"
            subtitle={`${data.closedFromDate ? `${data.closedFromDate} 이후 ` : "최근 30일 "}· 최신순`}
            rows={data.closedOrders ?? []}
            market={market}
            emptyText="최근 끝난 주문 없음"
            closed
            note={data.closedTruncated ? "최근 끝난 주문은 일부만 받았습니다(토스에 더 남아 있음)." : null}
          />
        </>
      )}
    </div>
  );
}
