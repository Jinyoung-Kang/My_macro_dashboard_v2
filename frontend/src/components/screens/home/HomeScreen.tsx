"use client";

import { AlertsSummary } from "./AlertsSummary";
import { HomeKpis } from "./HomeKpis";
import { MarketPanel } from "./MarketPanel";
import { PaperPnlPanel } from "./PaperPnlPanel";
import { RegimePanel } from "./RegimePanel";
import { useHomeData } from "./useHomeData";

/**
 * 홈(/) — 운영 현황판(작업대 실행 명세 §7 2행). 맨 위 KPI 띠(오늘 요약) 하나와 그 아래 2×2 패널입니다.
 *
 * - 운영자: [오늘의 국면][모의매매 계좌(계좌 손익 표)] / [시장(묶음 표)][알림·끊긴 출처(끊긴 출처·수집 상태 포함)].
 * - 회원·데모: [오늘의 국면][알림] / [시장 — 두 칸을 다 씀]. 모의매매·끊긴 출처·수집 상태는 운영자 전용이라 그리지도 요청하지도 않습니다
 *   (/api/paper/*·/api/status*·/api/info/sources — 회원·데모에게 403 오류 상자를 보이지 않게).
 * - 구성 요소는 KPI 띠 하나 + 패널 넷(회원 셋) — 명세의 '10개 이하'. lg(1024px) 미만은 한 칸으로 쌓고, 누르는 자리는 44px입니다(각 부품).
 * - 같은 줄의 두 패널은 높이가 같습니다(격자 칸 늘이기) — 짧은 쪽 아래가 비어도 줄의 위·아래 선이 맞습니다.
 *
 * 읽기는 화면 훅(useHomeData)이 경로마다 한 번 하고 KPI 띠와 패널은 그 결과를 나눠 씁니다(모의매매만 계좌 패널이 시장을 고른 뒤 따로 읽음).
 * 경로마다 따로 읽으므로 한 경로가 실패해도 그 구역만 오류를 보이고 나머지는 그대로 그립니다(일부 실패).
 */
export default function HomeScreen() {
  const data = useHomeData();
  const { owner } = data;
  const market = <MarketPanel read={data.macro} clock={data.clock} className={owner ? undefined : "lg:col-span-2"} />;
  return (
    <div className="flex min-w-0 flex-col gap-3 lg:gap-4">
      <h1 className="sr-only">홈</h1>
      <HomeKpis data={data} />
      <div className="grid min-w-0 gap-3 lg:grid-cols-2 lg:gap-4">
        <RegimePanel read={data.regime} />
        {owner ? (
          <>
            <PaperPnlPanel />
            {market}
            <AlertsSummary alerts={data.alerts} ops={{ issues: data.issues, sources: data.sources }} />
          </>
        ) : (
          <>
            <AlertsSummary alerts={data.alerts} ops={null} />
            {market}
          </>
        )}
      </div>
    </div>
  );
}
