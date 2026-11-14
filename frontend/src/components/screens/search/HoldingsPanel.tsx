"use client";

import Link from "next/link";
import { ErrorState, Loading } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { institutionHref } from "@/lib/detail";
import { endpoints } from "@/lib/endpoints";
import { EMPTY, formatNumber, formatUsd, withoutLeadingIcon } from "@/lib/format";
import { holdersQuery, holdingsWindow, kstToday } from "@/lib/infoSearch";
import type { GuruHoldersResponse, PortfolioResponse, SearchEntity } from "@/lib/types";
import { LINK, PaneHeading } from "./parts";

/** 기관 상세·13F 화면과 같은 값(캐시를 나눔 — InstitutionDetailScreen). */
const QUARTERS = 8;
const TOP_N = 30;
const ROWS_SHOWN = 30;

/** 2년 안내(계약 §5 — 가장 최근 보고가 2년보다 오래면 줄을 보이지 않고 날짜만). */
function TooOld({ latest }: { latest: string | null }) {
  return (
    <div role="status" className="flex flex-col gap-1 py-6 text-sm">
      <p className="font-medium text-text">최근 2년 안의 자료가 없습니다</p>
      {latest ? <p className="text-text-2">가장 최근 자료: {latest}</p> : null}
    </div>
  );
}

/**
 * 보유 탭 — 기업은 이 대시보드가 받는 13F 기관 가운데 그 회사를 든 곳(GET /api/guru/holders — 공시 이름으로 찾음), 13F 기관(cik: 키)은 상위 보유
 * 종목(GET /api/sec13f/portfolio). 둘 다 저장본이고 외부를 부르지 않습니다. 가장 최근 보고가 2년보다 오래면 같은 안내(지시문 §4.3).
 */
export function HoldingsPanel({ entity, loading }: { entity: SearchEntity | null; loading: boolean }) {
  if (!entity) return loading ? <Loading label="대상을 푸는 중…" /> : <p className="py-6 text-sm text-text-2">대상을 풀지 못해 보유 자료를 찾지 못합니다.</p>;
  if (entity.key.startsWith("cik:")) return <PortfolioHoldings cik={entity.key.slice("cik:".length)} />;
  if (entity.kind === "company") {
    const query = holdersQuery(entity);
    return query ? <CompanyHolders query={query} /> : <p className="py-6 text-sm text-text-2">13F 공시 이름으로 찾을 영문 이름·티커가 없습니다.</p>;
  }
  return <p className="py-6 text-sm text-text-2">이 대시보드가 받는 13F 기관(12곳)이 아니라 보유 자료가 없습니다.</p>;
}

function CompanyHolders({ query }: { query: string }) {
  const holders = useApi<GuruHoldersResponse>(endpoints.institution.guruHolders(query));
  const now = useMinuteClock();
  const data = holders.data;
  if (!data || !now) {
    return holders.error ? <ErrorState message={holders.error} onRetry={() => void holders.reload()} /> : <Loading label="13F 보유 기관을 불러오는 중" />;
  }
  if (!data.available) return <p className="py-6 text-sm text-text-2">{data.message ?? "13F 저장본이 아직 없습니다."}</p>;
  const rows = data.rows ?? [];
  if (rows.length === 0) return <p className="py-6 text-sm text-text-2">이 대시보드가 받은 13F 기관 가운데 보유한 곳이 없습니다.</p>;
  const span = holdingsWindow(rows.map((row) => row.reportDate), kstToday(now.getTime()));
  const recent = rows.filter((row) => span.recent.includes(row.reportDate));
  if (recent.length === 0) return <TooOld latest={span.latest} />;
  return (
    <section aria-labelledby="search-holders" className="flex flex-col gap-2">
      <PaneHeading id="search-holders">13F 보유 기관 — 공시 이름에 ‘{query}’가 들어간 줄(비중 순)</PaneHeading>
      <ul className="divide-y divide-border">
        {recent.slice(0, ROWS_SHOWN).map((row) => (
          <li key={`${row.cik}:${row.cusip}`} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-sm lg:min-h-8">
            <span className="min-w-0">
              <Link href={institutionHref(row.cik)} className={LINK}>
                {withoutLeadingIcon(row.institution)}
              </Link>
              <span className="block truncate text-xs text-text-3">
                {row.name} · 보고일 {row.reportDate}
              </span>
            </span>
            <span className="text-right tabular-nums">
              <span className="block text-text">{formatNumber(row.weight, 2)}%</span>
              <span className="block text-xs text-text-3">{formatUsd(row.value)}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-text-3">
        받은 자료 기준 — 이 대시보드가 받는 13F 기관만 봅니다. 이름으로 찾아 다른 회사가 섞일 수 있어 공시 이름을 함께 적습니다.
        {recent.length > ROWS_SHOWN ? ` ${recent.length}줄 가운데 비중 상위 ${ROWS_SHOWN}줄.` : ""}
      </p>
    </section>
  );
}

function PortfolioHoldings({ cik }: { cik: string }) {
  const portfolio = useApi<PortfolioResponse>(endpoints.institution.portfolio(cik, QUARTERS, TOP_N));
  const now = useMinuteClock();
  const data = portfolio.data;
  if (!data || !now) {
    return portfolio.error ? <ErrorState message={portfolio.error} onRetry={() => void portfolio.reload()} /> : <Loading label="13F 포트폴리오를 불러오는 중" />;
  }
  if (!data.available) return <p className="py-6 text-sm text-text-2">{data.message ?? data.error ?? "13F 저장본이 아직 없습니다."}</p>;
  const latest = data.latest?.reportDate ?? null;
  const span = holdingsWindow(latest ? [latest] : [], kstToday(now.getTime()));
  if (span.recent.length === 0) return <TooOld latest={span.latest} />;
  const holdings = data.holdings ?? [];
  return (
    <section aria-labelledby="search-portfolio" className="flex flex-col gap-2">
      <PaneHeading id="search-portfolio">상위 보유 종목 — 보고일 {latest}, 앞 분기와 비교</PaneHeading>
      {holdings.length === 0 ? (
        <p className="text-sm text-text-2">보유 종목이 없습니다.</p>
      ) : (
        <ul className="divide-y divide-border">
          {holdings.slice(0, ROWS_SHOWN).map((holding) => (
            <li key={`${holding.cusip}:${holding.class}`} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 py-1.5 text-sm lg:min-h-8">
              <span className="min-w-0">
                <span className="block truncate text-text">{holding.name}</span>
                <span className="block truncate text-xs text-text-3">{[holding.class, withoutLeadingIcon(holding.action)].filter(Boolean).join(" · ")}</span>
              </span>
              <span className="text-right tabular-nums">
                <span className="block text-text">{holding.weight !== null ? `${formatNumber(holding.weight, 2)}%` : EMPTY}</span>
                <span className="block text-xs text-text-3">{formatUsd(holding.value)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-text-3">받은 자료 기준 — SEC EDGAR 13F(이 대시보드 저장본, 최근 {QUARTERS}분기).</p>
    </section>
  );
}
