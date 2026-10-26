"use client";

import { useSessionUser } from "@/hooks/useSessionUser";
import { isOwner } from "@/lib/access";
import { AlertsSummary } from "./AlertsSummary";
import { MarketRows } from "./MarketRows";
import { PaperHero } from "./PaperHero";
import { RegimeHero } from "./RegimeHero";
import { StoreStatusLine } from "./StoreStatusLine";

/**
 * 🏠 홈(/) — 첫 화면(설계서 §7). 위: 오늘의 국면(왼쪽) · 모의매매(오른쪽, 운영자만), 아래 전체 폭: 시장 행 → 알림 요약 →
 * 데이터 저장소 상태 한 줄(운영자만). lg(1024px) 미만은 한 칸으로 쌓습니다.
 *
 * 구역마다 따로 읽습니다(useApi) — 한 경로가 실패해도 그 구역만 오류를 보이고 나머지는 그대로 그립니다(일부 실패).
 * 운영자 전용 구역(/api/paper/*·/api/status*)은 운영자가 아니면 그리지도 요청하지도 않습니다 — 회원·데모에게 403 오류 상자를 보이지 않게.
 */
export default function HomeScreen() {
  const owner = isOwner(useSessionUser());
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h1 className="sr-only">홈</h1>
      {/* 회원은 모의매매 히어로가 없으므로 국면 히어로가 한 줄을 다 씁니다(반 칸 빈자리를 남기지 않음). */}
      <div className={`grid min-w-0 gap-4 ${owner ? "lg:grid-cols-2" : ""}`}>
        <RegimeHero />
        {owner ? <PaperHero /> : null}
      </div>
      <MarketRows />
      <AlertsSummary />
      {owner ? <StoreStatusLine /> : null}
    </div>
  );
}
