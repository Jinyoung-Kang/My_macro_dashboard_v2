"use client";

import { AlertsSummary } from "./AlertsSummary";
import { HomeKpis } from "./HomeKpis";
import { MarketPanel } from "./MarketPanel";
import { PaperPnlPanel } from "./PaperPnlPanel";
import { RegimePanel } from "./RegimePanel";
import { StoreStatusLine } from "./StoreStatusLine";
import { useHomeData } from "./useHomeData";

/**
 * 홈(/) — 첫 화면(설계서 §7). 맨 위 KPI 띠(오늘 요약), 그 아래: 오늘의 국면 패널(왼쪽) · 계좌 손익 표 패널(오른쪽, 운영자만), 아래 전체 폭: 시장 묶음 표 → 알림 요약 →
 * 데이터 저장소 상태 한 줄(운영자만). lg(1024px) 미만은 한 칸으로 쌓습니다.
 *
 * 읽기는 화면 훅(useHomeData)이 경로마다 한 번 하고 구역 부품은 그 결과를 받습니다(모의매매만 계좌 패널이 시장을 고른 뒤 따로 읽음).
 * 경로마다 따로 읽으므로 한 경로가 실패해도 그 구역만 오류를 보이고 나머지는 그대로 그립니다(일부 실패).
 * 운영자 전용 구역(/api/paper/*·/api/status*)은 운영자가 아니면 그리지도 요청하지도 않습니다 — 회원·데모에게 403 오류 상자를 보이지 않게.
 */
export default function HomeScreen() {
  const data = useHomeData();
  const { owner } = data;
  return (
    <div className="flex min-w-0 flex-col gap-6 lg:gap-8">
      <h1 className="sr-only">홈</h1>
      <HomeKpis data={data} />
      {/* 회원은 계좌 패널이 없으므로 국면 패널이 한 줄을 다 씁니다(반 칸 빈자리를 남기지 않음). */}
      <div className={`grid min-w-0 gap-6 ${owner ? "lg:grid-cols-2" : ""}`}>
        <RegimePanel read={data.regime} />
        {owner ? <PaperPnlPanel /> : null}
      </div>
      <MarketPanel read={data.macro} clock={data.clock} />
      <AlertsSummary alerts={data.alerts} />
      {owner ? <StoreStatusLine read={data.issues} /> : null}
    </div>
  );
}
