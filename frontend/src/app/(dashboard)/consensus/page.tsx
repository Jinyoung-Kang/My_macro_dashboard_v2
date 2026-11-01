"use client";

import { useState } from "react";
import { HorizontalBars } from "@/components/charts";
import {
  Banner,
  Card,
  EmptyState,
  ErrorState,
  filterChipClasses,
  Loading,
  Metric,
  PageHeader,
  Select,
  SourceBadge,
  Table,
} from "@/components/ui";
import { CheckIcon } from "@/components/ui/icons";
import { useApi } from "@/hooks/useApi";
import { useRemembered } from "@/hooks/useRemembered";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import { consensusBars, securityNote } from "@/lib/consensus";
import { EMPTY, formatCurrency, formatNumber } from "@/lib/format";
import { filerName, filerShortName } from "@/lib/holdings";
import { isSelected, toggleSelection } from "@/lib/selection";
import type { ConsensusResponse, NewBuysResponse } from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 기관 13F Money 교집합.
 *
 * 여러 기관이 같은 분기에 공통 보유한 종목과, 동시 순매수/순매도가 몰린
 * 종목을 집계합니다. 기관마다 공시 분기가 다를 수 있으므로 기준 분기를
 * 고르면 그 분기를 공시한 기관만 참여합니다.
 */
export default function ConsensusPage() {
  const institutions = useApi<{ institutions: { name: string; cik: string }[] }>(
    endpoints.institution.institutions,
  );
  // 빈 목록 = 전체. 화면과 요청은 lib/selection의 유효 선택을 씁니다(QA-003).
  const [selected, setSelected] = useState<string[]>([]);
  const allCiks = (institutions.data?.institutions ?? []).map((entry) => entry.cik);
  const [reportDate, setReportDate] = useState("");
  const [minHolders, setMinHolders] = useState("2");

  const ciks = selected.length > 0 ? selected.join(",") : "";
  const { data, loading, error, reload } = useApi<ConsensusResponse>(
    endpoints.institution.consensus({ minHolders, topN: 40, ciks, reportDate }),
  );
  // 매크로 화면이 이미 수집하는 원/달러를 그대로 씁니다.
  const usdKrw = useUsdKrw();

  const toggle = (cik: string) => {
    setSelected((previous) => toggleSelection(allCiks, previous, cik));
  };

  // 기준 분기 선택지는 응답에 딸려 옵니다. 고른 분기의 응답을 기다리는 동안 선택지가 '최신 분기' 하나로 줄면
  // 화면은 최신을 보이는데 요청은 고른 분기로 나갔습니다 — 마지막 목록을 씁니다(QA-047).
  const availableDates = useRemembered(data?.availableDates);
  // 이름이 겹치는 행(CUSIP으로 갈린 같은 이름)만 막대 이름표에 구분자를 붙입니다(QA-114).
  const chartData = consensusBars(data?.rows ?? []);

  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader title="기관 13F Money 교집합" description="여러 기관이 공통 보유한 종목 · 동시 매수/매도 집중도" />

      <Card title="분석 대상" subtitle="전체 기관이 선택된 상태에서 시작합니다. 빼고 싶은 기관을 누르세요(전부 빼면 다시 전체).">
        <div className="flex flex-wrap gap-2">
          {(institutions.data?.institutions ?? []).map((entry) => {
            const active = isSelected(allCiks, selected, entry.cik);
            return (
              <button
                key={entry.cik}
                type="button"
                aria-pressed={active}
                onClick={() => toggle(entry.cik)}
                className={filterChipClasses(active)}
              >
                {active ? <CheckIcon size={14} /> : null}
                {filerName(entry.name) ?? `CIK ${entry.cik}`}
              </button>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <Select
            label="기준 분기"
            value={reportDate}
            onChange={setReportDate}
            options={[
              { value: "", label: "각 기관의 최신 분기" },
              ...(availableDates ?? []).map((date) => ({ value: date, label: date })),
            ]}
          />
          <Select
            label="최소 공통 보유 기관 수"
            value={minHolders}
            onChange={setMinHolders}
            options={["2", "3", "4", "5"].map((value) => ({
              value,
              label: `${value}곳 이상`,
            }))}
          />
        </div>
      </Card>

      {loading && !data && <Loading label="교집합을 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {data && !data.available && (
        <Banner tone="warn">
          조건을 만족하는 공통 보유 종목이 없습니다. 기준 분기나 최소 기관 수를 조정해 보세요.
        </Banner>
      )}

      {data?.available && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="참여 기관" value={`${data.participantCount}곳`} />
            <Metric label="교집합 종목" value={`${data.rows.length}개`} />
            <Metric
              label="기준 분기"
              value={data.reportDate ?? "각 기관 최신"}
            />
          </div>

          <Card title="공통 보유 상위 종목" source={SOURCES.sec13f} subtitle="막대 길이 = 보유 기관 수">
            <HorizontalBars data={chartData} unit="곳" digits={0} neutral height={Math.max(260, chartData.length * 26)} />
          </Card>

          <Card title="교집합 상세" source={SOURCES.sec13f} subtitle={usdKrw.note}>
            <Table
              rows={data.rows}
              rowKey={(row) => row.key}
              columns={[
                { key: "name", header: "종목", render: (row) => <SecurityName row={row} /> },
                {
                  key: "holderCount",
                  header: "보유 기관",
                  align: "right",
                  render: (row) => `${row.holderCount}곳`,
                },
                {
                  key: "buy",
                  header: "동시 매수",
                  align: "right",
                  render: (row) => (
                    <span className={row.buyCount > 0 ? "text-up" : "text-muted"}>
                      {row.buyCount}
                    </span>
                  ),
                },
                {
                  key: "sell",
                  header: "동시 매도",
                  align: "right",
                  render: (row) => (
                    <span className={row.sellCount > 0 ? "text-down" : "text-muted"}>
                      {row.sellCount}
                    </span>
                  ),
                },
                {
                  key: "avgWeight",
                  header: "평균 비중",
                  align: "right",
                  render: (row) => (row.avgWeight == null ? "—" : `${formatNumber(row.avgWeight, 2)}%`),
                },
                {
                  key: "maxWeight",
                  header: "최대 비중",
                  align: "right",
                  render: (row) => (row.maxWeight == null ? "—" : `${formatNumber(row.maxWeight, 2)}%`),
                },
                {
                  key: "totalValue",
                  header: "합산 평가액",
                  align: "right",
                  render: (row) => (
                    <span className="flex flex-col items-end">
                      <span>{formatCurrency(row.totalValue)}</span>
                      {usdKrw.toKrw(row.totalValue) && (
                        <span className="text-xs text-muted">
                          {usdKrw.toKrw(row.totalValue)}
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  key: "holders",
                  header: "보유 기관 목록",
                  render: (row) => (
                    <span className="flex flex-wrap gap-1">
                      {row.holders.map((holder) => (
                        <FilerBadge key={holder} name={holder} />
                      ))}
                    </span>
                  ),
                },
              ]}
            />
          </Card>

          <p className="text-xs text-muted">
            참여 기관: {data.participants.map((name) => filerName(name) ?? name).join(", ") || EMPTY}
          </p>
        </>
      )}

      <NewBuysCard reportDate={reportDate} />
    </div>
  );
}

/**
 * 종목 이름과 그 아래 작은 글씨의 증권 구분자(CUSIP, 합친 행은 발행사). 행은 증권으로 갈리고 표시 이름은 겹칠 수
 * 있어(같은 이름의 다른 ETF, 클래스 표기가 갈려 두 행으로 남은 A·C주), 이름만 적으면 어느 행이 어느 증권인지 알 수
 * 없습니다(QA-114). 기관 포트폴리오 화면의 '종목' 칸과 같은 모양입니다.
 */
function SecurityName({ row }: { row: { key: string; name: string; cusip?: string | null } }) {
  const note = securityNote(row);
  return (
    <span className="flex flex-col">
      <span className="text-body">{row.name}</span>
      {note && <span className="text-xs text-muted">{note}</span>}
    </span>
  );
}

/**
 * 이번 분기에 여러 기관이 <b>함께 새로 담은</b> 종목.
 *
 * <p>교집합은 "지금 누가 무엇을 들고 있는가"를 보여 줍니다. 그런데 더 신호에
 * 가까운 것은 <b>이번 분기에 새로 들어온</b> 종목입니다 — 한 곳이 새로 사면
 * 취향이지만, 여러 곳이 같은 분기에 새로 사면 테마입니다.
 *
 * <p>직전 분기와 비교할 수 없는 항목(주식 수 누락 등)은 세지 않습니다. 모르는
 * 것을 신규 매수로 올리면 없던 테마가 생깁니다.
 */
function NewBuysCard({ reportDate }: { reportDate: string }) {
  const [minHolders, setMinHolders] = useState("3");

  const { data, loading, error, reload } = useApi<NewBuysResponse>(
    endpoints.institution.newBuys(minHolders, reportDate),
  );
  const usdKrw = useUsdKrw();

  return (
    <Card
      title="이번 분기 공통 신규 매수" source={SOURCES.sec13f}
      subtitle={`여러 기관이 같은 분기에 처음 담은 종목 — 교집합보다 한 발 앞선 신호입니다. ${usdKrw.note}`}
      actions={
        <Select
          label="최소 기관 수"
          value={minHolders}
          onChange={setMinHolders}
          options={["2", "3", "4", "5"].map((value) => ({ value, label: `${value}곳 이상` }))}
        />
      }
    >
      {loading && !data && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}

      {data && !data.available && (
        <EmptyState
          message={`${minHolders}곳 이상이 함께 새로 담은 종목이 없습니다. 기준을 낮춰 보세요.`}
        />
      )}

      {data?.available && (
        <>
          <Table
            rows={data.rows}
            rowKey={(row) => row.key}
            columns={[
              { key: "name", header: "종목", render: (row) => <SecurityName row={row} /> },
              {
                key: "buyerCount",
                header: "새로 담은 기관",
                align: "right",
                render: (row) => <span className="font-semibold text-up">{row.buyerCount}곳</span>,
              },
              {
                key: "avgWeight",
                header: "평균 비중",
                align: "right",
                render: (row) => (row.avgWeight == null ? "—" : `${formatNumber(row.avgWeight, 2)}%`),
              },
              {
                key: "totalValue",
                header: "합산 평가액",
                align: "right",
                render: (row) => (
                  <span className="flex flex-col items-end">
                    <span>{formatCurrency(row.totalValue)}</span>
                    {usdKrw.toKrw(row.totalValue) && (
                      <span className="text-xs text-muted">
                        {usdKrw.toKrw(row.totalValue)}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: "buyers",
                header: "기관 목록",
                render: (row) => (
                  <span className="flex flex-wrap gap-1">
                    {row.buyers.map((buyer) => (
                      <FilerBadge key={buyer} name={buyer} />
                    ))}
                  </span>
                ),
              },
            ]}
          />
          <p className="mt-2 text-xs text-muted">
            기준 분기 {data.rows[0]?.reportDate ?? EMPTY} · {data.note}
          </p>
        </>
      )}
    </Card>
  );
}

/** 기관 배지 — 짧은 이름(국기를 뗀 첫 낱말, lib/holdings.filerShortName), 전체 이름은 마우스 설명으로. */
function FilerBadge({ name }: { name: string }) {
  return (
    <span title={filerName(name) ?? name}>
      <SourceBadge>{filerShortName(name)}</SourceBadge>
    </span>
  );
}
