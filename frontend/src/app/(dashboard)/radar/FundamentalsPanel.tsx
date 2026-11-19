"use client";

import { Banner, Card, ErrorState, Freshness, Loading, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { splitFundamentals } from "@/lib/radar";
import { stableCodesKey } from "@/lib/transforms";
import { deltaColor, EMPTY, formatKrw, formatNumber } from "@/lib/format";
import type { KrFundamentalsResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

/**
 * 순매수 종목의 재무 체크 (DART 사업보고서).
 *
 * 수급은 "누가 샀나"만 말합니다. 같은 순매수라도 부채가 많거나 이익이 줄고
 * 있는 회사라면 해석이 달라지므로 공시 재무를 옆에 둡니다. 비율은 백엔드가
 * 계산하고(analytics/KrFundamentals), 화면은 그대로 보여 주기만 합니다.
 */
export function FundamentalsPanel({ codes }: { codes: string[] }) {
  // 순서를 정렬해 키를 고정합니다. 랭킹 순서만 바뀌어도 다시 요청하지 않게.
  const key = stableCodesKey(codes);
  const { data, loading, error, reload } = useApi<KrFundamentalsResponse>(
    key ? endpoints.publicData.fundamentals(key) : null,
  );
  const { all, rows, empty, covered } = splitFundamentals(codes, data?.companies ?? []);

  const percent = (value: number | null | undefined) =>
    value === null || value === undefined ? EMPTY : `${formatNumber(value, 1)}%`;
  const multiple = (value: number | null | undefined) =>
    value === null || value === undefined ? EMPTY : `${formatNumber(value, 1)}배`;

  return (
    <Card
      title="재무·밸류에이션 체크 (DART 사업보고서 + 금융위 공식 시세)"
      source="금융감독원 Open DART 사업보고서 주요계정 (공식) · 금융위원회 주식시세정보 (공식, 시가총액)"
      subtitle="부채비율 = 부채총계÷자본총계 · 증가율은 전년 대비 · ROE = 순이익÷기말 자본 · PER·PBR = 시가총액÷직전 사업연도 순이익·자본"
      actions={
        <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} stale={data?.stale} />
      }
    >
      {loading && !data && <Loading label="공시 재무를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="info">{data.message}</Banner>}

      {(data?.available || data?.priceDate) && (
        <>
          <p className="mb-2 text-xs text-text-3">
            {covered}/{all.length}개 종목 재무 확보 · ETF·ETN·스팩은 DART 재무 대상이 아닙니다 ·
            이자보상배율은 주요계정에 이자비용이 없어 표시하지 않습니다
            {data.priceDate ? ` · 시가총액 기준일 ${data.priceDate} (재무와 시점이 다름)` : " · 공식 시세 없음 → PER·PBR 생략"}
          </p>
          {empty.length > 0 && (
            <p className="mb-2 text-xs text-text-3">
              재무·시세 모두 없음 {empty.length}개 (ETF·신규 상장·수집 전):{" "}
              {empty.slice(0, 10).map((row) => row.name ?? row.code).join(", ")}
              {empty.length > 10 ? " 외" : ""}
            </p>
          )}
          {rows.length > 0 && (
            <Table
              rows={rows}
              rowKey={(row) => row.code}
              columns={[
                {
                  key: "name",
                  header: "종목",
                  render: (row) => (
                    <span className="flex flex-col">
                      <span className="text-text-2">{row.name ?? row.code}</span>
                      <span className="text-xs text-text-3">
                        {row.available ? `${row.bsnsYear} ${row.fsLabel}` : "재무 없음"}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "debt",
                  header: "부채비율",
                  align: "right",
                  render: (row) =>
                    row.capitalImpaired ? <span className="text-down">자본잠식</span> : percent(row.debtRatio),
                },
                { key: "rev", header: "매출 증가", align: "right", render: (row) => (
                  <span className={deltaColor(row.revenueGrowth)}>{percent(row.revenueGrowth)}</span>
                ) },
                { key: "op", header: "영업이익 증가", align: "right", render: (row) =>
                  row.operatingTurn ? (
                    <span className={row.operatingTurn === "흑자전환" ? "text-up" : "text-down"}>{row.operatingTurn}</span>
                  ) : (
                    <span className={deltaColor(row.operatingIncomeGrowth)}>{percent(row.operatingIncomeGrowth)}</span>
                  ),
                },
                { key: "margin", header: "영업이익률", align: "right", render: (row) => percent(row.operatingMargin) },
                { key: "roe", header: "ROE", align: "right", render: (row) => percent(row.roe) },
                { key: "cap", header: "시가총액", align: "right", render: (row) => formatKrw(row.marketCap) },
                { key: "per", header: "PER", align: "right", render: (row) => multiple(row.per) },
                { key: "pbr", header: "PBR", align: "right", render: (row) => multiple(row.pbr) },
                {
                  key: "link",
                  header: "공시",
                  align: "right",
                  render: (row) =>
                    row.dartUrl ? (
                      <a href={row.dartUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 text-accent underline lg:min-h-6 lg:min-w-6">
                        원문
                      </a>
                    ) : (
                      EMPTY
                    ),
                },
              ]}
            />
          )}
        </>
      )}
    </Card>
  );
}
