"use client";

import Link from "next/link";
import { type KpiItem, KpiStrip } from "@/components/patterns";
import { Callout, Card, ErrorState, LINK_CLASSES, Loading } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { formatNumber } from "@/lib/format";
import {
  type CatalogResponse,
  type InfoItemsResponse,
  type MechanismResponse,
  itemTime,
  itemTitles,
  tabTone,
  toneSummary,
} from "@/lib/info";

const TAB_HREF: Record<string, string> = {
  news: "/info/news", kr: "/info/kr", global: "/info/global", filings: "/info/filings", paper: "/info/paper", ops: "/info/status",
};

/**
 * 분류 타일 — 값은 그 분류의 출처 수('곳' — 앱이 catalog에서 센 수라 바깥 출처 줄은 없음), 상태는 색별 수(정상·주의·위험이면 아이콘 + 글, 기록만 없으면
 * 보조 글), 타일 전체가 그 분류 탭 링크.
 */
function tabTiles(data: CatalogResponse): KpiItem[] {
  return data.tabs.map((tab) => {
    const tone = tabTone(tab.tones);
    const summary = toneSummary(tab.tones);
    return {
      key: tab.key,
      label: tab.label,
      value: tab.sources,
      format: (value: number) => formatNumber(value, 0),
      unit: "곳",
      status: tone === "neutral" ? undefined : { tone, text: summary },
      note: tone === "neutral" ? summary : null,
      href: TAB_HREF[tab.key] ?? "/info/status",
    };
  });
}

/** 개요 — 분류별 상태 띠(누르면 그 분류로), 수집 스위치, 끊긴 출처·최근 글 다섯(넓은 화면 두 칸). */
export function OverviewSection() {
  const catalog = useApi<CatalogResponse>(endpoints.info.catalog, 120_000);
  const mechanism = useApi<MechanismResponse>(endpoints.info.mechanism, 300_000);
  const latest = useApi<InfoItemsResponse>(endpoints.info.items({ page: 1, size: 5 }), 300_000);
  const data = catalog.data;
  const polite = mechanism.data?.collector?.politeEnabled;
  const items = latest.data?.items ?? [];
  return (
    <div className="space-y-6">
      {/* 띠 자신이 이름 있는 영역('분류별 상태' — KpiStrip)이라 바깥 묶음은 영역으로 두지 않습니다(같은 이름의 영역이 둘이 되지 않게). */}
      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-heading-sm text-text">
            분류별 상태
          </h2>
          {data && (
            <p className="break-keep text-xs tabular-nums text-text-3">
              상태 확인 {data.checkedAt}
              {data.collectorReachable ? "" : " · 수집기에 닿지 못해 마지막 실행을 모름"}
            </p>
          )}
        </div>
        {catalog.loading && !data && <Loading />}
        {catalog.error && <ErrorState message={catalog.error} onRetry={catalog.reload} />}
        {data && <KpiStrip label="분류별 상태" items={tabTiles(data)} />}
      </div>
      {mechanism.data && polite === false && (
        <Callout title="이 환경의 수집 스위치">
          이 환경에서는 차단 통과 수집이 꺼져 있습니다(POLITE_FETCH_ENABLED — 운영 서버에서만 켬). 로컬 화면의 블로그·waedge·네이버·KRX 자료는
          운영 서버 백업을 복원했을 때만 보입니다.
        </Callout>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card
          title="끊긴 출처"
          count={data ? `${data.incidents.length.toLocaleString("ko-KR")}곳` : undefined}
          subtitle="차단·형식 바뀜·연속 실패·오래 못 받음 — 텔레그램으로도 한 통씩 갑니다."
        >
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
        <Card
          title="최근 받은 글"
          count={latest.data && items.length > 0 ? `${items.length.toLocaleString("ko-KR")}편` : undefined}
          subtitle="모든 글 출처에서 최근 다섯 편 — 전체는 '뉴스·글'."
        >
          {latest.data?.items.length === 0 && <p className="text-sm text-text-2">아직 받은 글이 없습니다.</p>}
          <ul className="divide-y divide-border">
            {items.map((item) => (
              <li key={item.id} className="py-2 text-sm">
                <span className="text-xs text-text-2">
                  {item.sourceLabel} · <span className="tabular-nums">{itemTime(item)}</span>
                </span>
                {/* 데이터 줄의 제목 링크 — 본문 잉크(강조 파랑 아님, 밑줄은 마우스를 올릴 때), 좁은 화면 44px 누름 자리. */}
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-11 items-center rounded-sm font-semibold text-text underline-offset-2 wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:min-h-0"
                >
                  {itemTitles(item).primary}
                </a>
              </li>
            ))}
          </ul>
          <Link href="/info/news" className={`${LINK_CLASSES} mt-2 text-xs`}>
            뉴스·글 전체 보기
          </Link>
        </Card>
      </div>
    </div>
  );
}
