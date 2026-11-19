"use client";

import { ChangeCell, DataTable } from "@/components/patterns";
import { Callout, ErrorState, Freshness, Loading, Panel, Tag } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { ratioText, splitFundamentals } from "@/lib/radar";
import { stableCodesKey } from "@/lib/transforms";
import { formatKrw } from "@/lib/format";
import type { KrFundamentalsResponse } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

/**
 * 종목들의 공시 재무(DART)·공식 시세 — 코드가 없으면 읽지 않습니다(자동 갱신 없음). 순서를 정렬해 키를 고정합니다 — 랭킹 순서만 바뀌어도 다시 요청하지 않게.
 * 순위 검사 칸이 같은 응답을 쓰도록 화면이 한 번 읽어 패널에 넘깁니다.
 */
export function useFundamentals(codes: readonly string[]) {
  const key = stableCodesKey([...codes]);
  return useApi<KrFundamentalsResponse>(key ? endpoints.publicData.fundamentals(key) : null);
}

export type FundamentalsRead = ReturnType<typeof useFundamentals>;

/**
 * 순매수 종목의 재무 체크 (DART 사업보고서).
 *
 * 수급은 "누가 샀나"만 말합니다. 같은 순매수라도 부채가 많거나 이익이 줄고
 * 있는 회사라면 해석이 달라지므로 공시 재무를 옆에 둡니다. 비율은 백엔드가
 * 계산하고(analytics/KrFundamentals), 화면은 그대로 보여 주기만 합니다.
 * `fundamentals`는 화면이 useFundamentals로 한 번 읽은 것(순위 검사 칸과 같은 응답) — 패널은 스스로 읽지 않습니다(예전 대체 길은 쓰는 화면이 없어 뗌 — P7 검토).
 */
export function FundamentalsPanel({ codes, fundamentals }: { codes: string[]; fundamentals: FundamentalsRead }) {
  const { data, loading, error, reload } = fundamentals;
  const { all, rows, empty, covered } = splitFundamentals(codes, data?.companies ?? []);

  // 비율·배수는 음수 부호 −(U+2212 — QA-889), 모르면 null — 공용 표가 '—'(읽기 '값 없음')를 그립니다.
  const percent = (value: number | null | undefined) => ratioText(value, "%");
  const multiple = (value: number | null | undefined) => ratioText(value, "배");

  return (
    <Panel
      title="재무·밸류에이션 체크 (DART 사업보고서 + 금융위 공식 시세)"
      source="금융감독원 Open DART 사업보고서 주요계정 (공식) · 금융위원회 주식시세정보 (공식, 시가총액)"
      subtitle="부채비율 = 부채총계÷자본총계 · 증가율은 전년 대비 · ROE = 순이익÷기말 자본 · PER·PBR = 시가총액÷직전 사업연도 순이익·자본"
      actions={
        <Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} stale={data?.stale} />
      }
    >
      {loading && !data && <Loading label="공시 재무를 불러오는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Callout>{data.message}</Callout>}

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
            <DataTable
              dense
              count
              scrollHint="overflow"
              caption="재무·밸류에이션 체크"
              rows={rows}
              rowKey={(row) => row.code}
              columns={[
                {
                  key: "name",
                  header: "종목",
                  rowHeader: true,
                  className: "break-keep",
                  cell: (row) => (
                    <span className="flex flex-col">
                      <span>{row.name ?? row.code}</span>
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
                  // 자본잠식은 비율이 아니라 상태 — 주의 태그(아이콘 + 글, 예전에는 하락색 글만).
                  cell: (row) => (row.capitalImpaired ? <Tag tone="warn">자본잠식</Tag> : percent(row.debtRatio)),
                },
                // 증가율은 오르내린 값 — 공용 변화 칸(▲▼·부호·sr 글).
                { key: "rev", header: "매출 증가", align: "right", cell: (row) => <ChangeCell changePct={row.revenueGrowth} pctDigits={1} /> },
                {
                  key: "op",
                  header: "영업이익 증가",
                  align: "right",
                  // 흑자·적자 전환은 판정 글(증가율이 없음) — 본문 잉크 글(예전에는 상승·하락색만으로 갈랐음).
                  cell: (row) => (row.operatingTurn ? row.operatingTurn : <ChangeCell changePct={row.operatingIncomeGrowth} pctDigits={1} />),
                },
                { key: "margin", header: "영업이익률", align: "right", cell: (row) => percent(row.operatingMargin) },
                { key: "roe", header: "ROE", align: "right", cell: (row) => percent(row.roe) },
                { key: "cap", header: "시가총액", align: "right", cell: (row) => (row.marketCap === null || row.marketCap === undefined ? null : formatKrw(row.marketCap)) },
                { key: "per", header: "PER", align: "right", cell: (row) => multiple(row.per) },
                { key: "pbr", header: "PBR", align: "right", cell: (row) => multiple(row.pbr) },
                {
                  key: "link",
                  header: "공시",
                  align: "right",
                  cell: (row) =>
                    row.dartUrl ? (
                      <a href={row.dartUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 min-w-11 items-center justify-center px-1 text-accent underline lg:min-h-6 lg:min-w-6">
                        원문
                      </a>
                    ) : null,
                },
              ]}
            />
          )}
        </>
      )}
    </Panel>
  );
}
