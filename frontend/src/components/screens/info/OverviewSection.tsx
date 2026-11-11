"use client";

import Link from "next/link";
import { Banner, Card, ErrorState, Loading } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { type CatalogResponse, type InfoItemsResponse, type MechanismResponse, itemTime, itemTitles, tabTone, toneSummary } from "@/lib/info";

const TAB_HREF: Record<string, string> = {
  news: "/info/news", kr: "/info/kr", global: "/info/global", filings: "/info/filings", paper: "/info/paper", ops: "/info/status",
};

/** 개요 — 분류별 상태 요약(누르면 그 분류로), 끊긴 출처, 수집 스위치, 최근 글 다섯. */
export function OverviewSection() {
  const catalog = useApi<CatalogResponse>(endpoints.info.catalog, 120_000);
  const mechanism = useApi<MechanismResponse>(endpoints.info.mechanism, 300_000);
  const latest = useApi<InfoItemsResponse>(endpoints.info.items({ page: 1, size: 5 }), 300_000);
  const data = catalog.data;
  const polite = mechanism.data?.collector?.politeEnabled;
  return (
    <div className="space-y-6">
      {mechanism.data && polite === false && (
        <Banner tone="info">
          이 환경에서는 차단 통과 수집이 꺼져 있습니다(POLITE_FETCH_ENABLED — 운영 서버에서만 켬). 로컬 화면의 블로그·waedge·네이버·KRX 자료는
          운영 서버 백업을 복원했을 때만 보입니다.
        </Banner>
      )}
      <Card
        title="분류별 상태"
        source={data ? `상태 확인 ${data.checkedAt}${data.collectorReachable ? "" : " · 수집기에 닿지 못해 마지막 실행을 모름"}` : undefined}
      >
        {catalog.loading && !data && <Loading />}
        {catalog.error && <ErrorState message={catalog.error} onRetry={catalog.reload} />}
        {data && (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.tabs.map((tab) => (
              <li key={tab.key}>
                <Link
                  href={TAB_HREF[tab.key] ?? "/info/status"}
                  className="flex h-full flex-col gap-1 rounded-control border border-border bg-surface p-3 hover:bg-surface-2"
                >
                  <span className="text-sm font-semibold text-text">{tab.label}</span>
                  <span className="text-xs text-text-2">출처 {tab.sources}곳</span>
                  <StatusText tone={tabTone(tab.tones)}>
                    <span className="text-xs">{toneSummary(tab.tones)}</span>
                  </StatusText>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="끊긴 출처" subtitle="차단·형식 바뀜·연속 실패·오래 못 받음 — 텔레그램으로도 한 통씩 갑니다.">
        {data && data.incidents.length === 0 && <p className="text-sm text-text-2">지금 끊긴 출처가 없습니다.</p>}
        {data && data.incidents.length > 0 && (
          <ul className="space-y-1.5 text-sm">
            {data.incidents.map((incident) => (
              <li key={incident.key}>
                <StatusText tone={incident.kind === "blocked" || incident.kind === "format" ? "danger" : "warn"}>
                  <span className="font-semibold">{incident.label}</span> · {incident.kindLabel}
                  {incident.reason ? <span className="text-text-2"> — {incident.reason}</span> : null}
                </StatusText>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="최근 받은 글" subtitle="모든 글 출처에서 최근 다섯 편 — 전체는 '뉴스·글'.">
        {latest.data?.items.length === 0 && <p className="text-sm text-text-2">아직 받은 글이 없습니다.</p>}
        <ul className="divide-y divide-border">
          {(latest.data?.items ?? []).map((item) => (
            <li key={item.id} className="py-2 text-sm">
              <span className="text-xs text-text-2">
                {item.sourceLabel} · <span className="tabular-nums">{itemTime(item)}</span>
              </span>
              <a href={item.url} target="_blank" rel="noopener noreferrer" className="block font-semibold text-text hover:underline">
                {itemTitles(item).primary}
              </a>
            </li>
          ))}
        </ul>
        <Link href="/info/news" className="mt-2 inline-block text-xs text-accent hover:underline">
          뉴스·글 전체 보기
        </Link>
      </Card>
    </div>
  );
}
