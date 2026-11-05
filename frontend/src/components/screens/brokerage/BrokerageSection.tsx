"use client";

import Link from "next/link";
import { StaleBadge } from "@/components/patterns";
import { Banner, Button, ErrorState, Loading } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { brokerageScope, brokerageStaleNote, brokerageView } from "@/lib/brokerage";
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
 * <p>읽기는 이 탭이 붙을 때 한 번과 '다시 읽기' 단추뿐입니다 — 자동 갱신도, 셸의 수동 새로고침 신호도 따르지 않습니다(토스 계좌 API의 호출
 * 한도와 운영 1분봉이 쓰는 단일 토큰을 아낌). 짧은 간격으로 눌러도 수집기 캐시(60초)가 같은 값을 돌려줍니다.
 *
 * <p>상태: 꺼짐(DISABLED)은 안내만, 그 밖의 실패는 고정 문구와 다시 시도, 서버가 이전 값을 보이거나(isStale) 다시 읽기가 실패하면(refreshError)
 * '이전 값'과 받은 시각, 모르는 숫자는 "—"입니다.
 */
export function BrokerageSection({ market }: { market: PaperMarketCode }) {
  const { data, loading, error, reload, refreshError } = useApi<BrokerageAccountResponse>(endpoints.brokerage.account(market), 0, {
    followRefresh: false,
    timeoutMs: TIMEOUT_MS,
  });
  const scope = brokerageScope(market);
  const view = data ? brokerageView(data) : null;
  const staleNote = data && view?.kind === "ok" ? brokerageStaleNote(data, refreshError) : null;

  return (
    <div className="flex flex-col gap-6">
      <Banner tone="info" icon={<LockIcon size={16} />}>
        <strong>실제 계좌(토스증권) — 모의 장부와 별개 · 읽기 전용 · 이 화면에서는 주문할 수 없습니다</strong>
        <p className="mt-1 text-xs">
          {scope.currencyLabel} 자산만 — {scope.otherCurrencyLabel} 자산은{" "}
          <Link href={paperTabPath("real", scope.other)} className="text-accent underline underline-offset-2">
            {scope.otherScreen}의 실제 계좌 탭
          </Link>
        </p>
      </Banner>

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
              <Button size="sm" onClick={() => void reload()} disabled={loading}>
                {loading ? "다시 읽는 중…" : "다시 읽기"}
              </Button>
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
