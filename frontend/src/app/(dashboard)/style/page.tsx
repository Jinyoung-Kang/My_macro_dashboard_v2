"use client";

import { useMemo, useState } from "react";
import { HorizontalBars } from "@/components/charts";
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Freshness,
  Loading,
  Metric,
  Select,
  SourceBadge,
  Table,
} from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useUsdKrw } from "@/hooks/useUsdKrw";
import { deltaColor, EMPTY, formatCurrency, formatNumber, formatPercent, formatWithUnit } from "@/lib/format";
import type {
  GuruHoldersResponse,
  GuruProfilesResponse,
  GuruRiskResponse,
  GuruSimilarityResponse,
} from "@/lib/types";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";
import { topPairs } from "@/lib/transforms";

/**
 * 🧬 기관 13F 스타일·위험 (옛 이름: 구루 포트폴리오 분석, 주소 /guru → /style).
 *
 * <p>13F 화면은 "누가 무엇을 들고 있나"를 보여 줍니다. 이 화면은 한 발 더
 * 들어가 <b>어떤 식으로</b> 들고 있는지를 봅니다 — 몇 종목에 쏠려 있는지,
 * 누구와 닮았는지, 그 포트폴리오가 얼마나 흔들렸는지.
 */
export default function GuruPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-bold text-bright">기관 13F 스타일·위험</h1>
        <p className="mt-1 text-xs text-muted">
          집중도 · 회전율 · 기관 간 유사도 · 포트폴리오 위험 (13F 공시 기준)
        </p>
      </header>

      <Banner tone="info">
        13F는 <b>미국 상장 롱 포지션만</b> 공시 대상입니다. 채권·현금·해외 상장분·
        공매도는 이 숫자에 들어 있지 않습니다. 분기말 기준이며 제출까지 최대{" "}
        <b>45일 지연</b>됩니다 — 지금의 포지션이 아닙니다.
      </Banner>

      <ProfilesCard />
      <SimilarityCard />
      <RiskCard />
      <HoldersCard />
    </div>
  );
}

/**
 * 기관별 성격 요약.
 *
 * <p><b>유효 종목 수</b>를 함께 적는 이유 — 종목 수만 세면 인덱스 펀드와 집중
 * 투자자가 같은 칸에 놓입니다. 3,000종목을 들고 있어도 상위 몇 개에 쏠려 있으면
 * 이 값은 수십으로 나옵니다.
 */
function ProfilesCard() {
  const { data, loading, error, reload } = useApi<GuruProfilesResponse>(endpoints.institution.guruProfiles);
  const usdKrw = useUsdKrw();

  return (
    <Card
      title="기관별 성격" source={SOURCES.sec13f}
      subtitle={data?.note}
      actions={<Button onClick={reload}>새로고침</Button>}
    >
      {loading && !data && <Loading label="13F 저장본을 읽는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="warn">{data.message}</Banner>}

      {(data?.rows?.length ?? 0) > 0 && (
        <Table
          rows={data!.rows}
          rowKey={(row) => row.cik}
          columns={[
            {
              key: "name",
              header: "기관",
              render: (row) => (
                <span className="flex flex-col">
                  <span className="text-body">{row.name}</span>
                  <span className="text-[11px] text-muted">{row.desc}</span>
                </span>
              ),
            },
            {
              key: "totalValue",
              header: "포트폴리오 총액",
              align: "right",
              render: (row) => (
                <span className="flex flex-col items-end">
                  <span>{formatCurrency(row.totalValue)}</span>
                  {usdKrw.toKrw(row.totalValue) && (
                    <span className="text-[11px] text-muted">{usdKrw.toKrw(row.totalValue)}</span>
                  )}
                </span>
              ),
            },
            {
              key: "holdingCount",
              header: "종목 수",
              align: "right",
              render: (row) => formatNumber(row.holdingCount, 0),
            },
            {
              key: "effectiveHoldings",
              header: "유효 종목 수",
              align: "right",
              render: (row) => (
                <span className="flex flex-col items-end">
                  <span className="font-semibold">{formatNumber(row.effectiveHoldings, 1)}</span>
                  <span className="text-[11px] text-muted">1 ÷ HHI</span>
                </span>
              ),
            },
            {
              key: "top10Weight",
              header: "상위 10종목",
              align: "right",
              render: (row) => formatWithUnit(row.top10Weight, 1, "%"),
            },
            {
              key: "turnover",
              header: "분기 회전율",
              align: "right",
              render: (row) =>
                row.turnover === null ? (
                  <span className="text-muted" title="직전 분기가 없어 계산할 수 없습니다">
                    {EMPTY}
                  </span>
                ) : (
                  formatWithUnit(row.turnover, 1, "%")
                ),
            },
            {
              key: "reportDate",
              header: "기준 분기",
              render: (row) => <SourceBadge>{row.reportDate ?? EMPTY}</SourceBadge>,
            },
          ]}
        />
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        <b>유효 종목 수</b> = 1 ÷ 허핀달 지수. 한 종목에 몰아넣었으면 1에 가깝고, 고르게
        나눴으면 실제 종목 수에 가까워집니다. <b>회전율</b>은 분기 사이에 갈아탄 비중이며,
        100%면 포트폴리오가 통째로 바뀐 것입니다. 직전 분기가 없으면 {EMPTY}입니다 — 0으로
        두면 &ldquo;한 주도 안 바꿨다&rdquo;로 읽힙니다.
      </p>
    </Card>
  );
}

/** 기관 간 유사도. 머리기사는 겹침 비중입니다 — 코사인보다 그대로 읽힙니다. */
function SimilarityCard() {
  const { data, loading, error, reload } = useApi<GuruSimilarityResponse>(endpoints.institution.guruSimilarity);
  const [mode, setMode] = useState<"overlap" | "cosine">("overlap");

  const matrix = mode === "overlap" ? data?.overlap : data?.cosine;
  const names = useMemo(() => data?.institutions ?? [], [data]);
  const max = mode === "overlap" ? 100 : 1;

  // 짝 순위는 행렬에서 직접 만듭니다. 서버의 topPairs는 겹침 비중 순이라, 코사인을
  // 고르면 목록과 기준이 어긋납니다. 기관 12곳이면 66쌍이라 브라우저에서 충분합니다.
  const pairs = useMemo(() => (matrix ? topPairs(names, matrix, shortName, 8) : []), [matrix, names]);

  return (
    <Card
      title="기관 간 유사도" source={SOURCES.sec13f}
      subtitle={data?.note}
      actions={
        <Select
          label="기준"
          value={mode}
          onChange={(value) => setMode(value === "cosine" ? "cosine" : "overlap")}
          options={[
            { value: "overlap", label: "겹침 비중 (%)" },
            { value: "cosine", label: "코사인 유사도" },
          ]}
        />
      }
    >
      {loading && !data && <Loading label="유사도를 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="warn">{data.message}</Banner>}

      {pairs.length > 0 && (
        <>
          <h3 className="mb-2 text-xs font-semibold text-body">
            가장 닮은 짝 — {mode === "overlap" ? "겹침 비중" : "코사인 유사도"} 순 상위 {pairs.length}
          </h3>
          {/* 막대 차트 축 라벨은 폭이 좁아 두 기관 이름이 "블랙… ↔ 뱅가…"로 잘렸습니다.
              짝 비교는 이름을 읽는 것이 먼저라 전체 이름이 보이는 표로 바꿉니다.
              막대는 크기 감만 주는 보조이고, 색은 중립색(빨강 = 매수·상승 약속과 섞이지 않게). */}
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="text-[11px] text-muted">
                <th className="w-8 px-2 py-1.5 text-right font-medium">#</th>
                <th className="px-2 py-1.5 text-left font-medium">기관 A</th>
                <th className="px-2 py-1.5 text-left font-medium">기관 B</th>
                <th className="w-[40%] px-2 py-1.5 text-left font-medium">
                  {mode === "overlap" ? "겹침 비중 (%)" : "코사인 유사도"}
                </th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((pair, index) => (
                <tr key={`${pair.left}-${pair.right}`} className="border-t border-border">
                  <td className="px-2 py-1.5 text-right tabular-nums text-muted">{index + 1}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-body">{pair.left}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-body">{pair.right}</td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-2 flex-1 rounded-sm bg-canvas">
                        <div
                          className="h-2 rounded-sm bg-accent/70"
                          style={{ width: `${Math.min(100, (pair.value / max) * 100)}%` }}
                        />
                      </div>
                      <span className="w-12 text-right tabular-nums text-body">
                        {formatNumber(pair.value, mode === "overlap" ? 1 : 2)}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {matrix && names.length > 0 && (
        <div className="mt-5 overflow-x-auto" tabIndex={0} role="region" aria-label="기관 간 유사도 행렬 (좌우 스크롤)">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <thead>
              <tr className="text-[11px] text-muted">
                <th className="sticky left-0 bg-surface px-3 py-2 text-left font-medium">기관</th>
                {names.map((entry) => (
                  <th
                    key={entry.cik}
                    title={entry.name}
                    className="whitespace-nowrap px-2 py-2 text-right font-medium"
                  >
                    {shortName(entry.name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {names.map((entry, row) => (
                <tr key={entry.cik} className="border-t border-border">
                  <td
                    title={entry.name}
                    className="sticky left-0 whitespace-nowrap bg-surface px-3 py-2 text-body"
                  >
                    {shortName(entry.name)}
                  </td>
                  {names.map((other, col) => {
                    const value = matrix[row]?.[col];
                    // 대각선은 자기 자신이라 항상 최대입니다. 색을 입히면
                    // 그 줄만 눈에 띄어 정작 읽어야 할 곳에서 시선을 뺏습니다.
                    const self = row === col;
                    const intensity =
                      value === undefined || self ? 0 : Math.min(1, Math.max(0, value / max));
                    return (
                      <td
                        key={other.cik}
                        className="px-2 py-2 text-right tabular-nums"
                        style={{
                          // 농도는 계열 첫 색(SERIES_COLORS.blue #3987e5)의 투명도 — 예전 옛 강조색(#58A6FF) 위 흰 글자는 다크 전용이라
                          // 라이트 표면에서 1.8:1까지 떨어졌습니다. 숫자는 본문색(text)으로, 농도 전 범위(0.08~0.63)에서 라이트 9.0:1·다크 5.7:1 이상.
                          backgroundColor: self
                            ? "rgba(139, 148, 158, 0.12)"
                            : `rgba(57, 135, 229, ${0.08 + intensity * 0.55})`,
                          color: self ? undefined : "var(--text)",
                        }}
                      >
                        {value === undefined
                          ? EMPTY
                          : formatNumber(value, mode === "overlap" ? 1 : 2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 text-[11px] leading-relaxed text-muted">
        <b>겹침 비중</b>은 각 종목에서 작은 쪽 비중을 더한 값입니다 — 애플을 한쪽이 10%,
        다른 쪽이 3% 들고 있으면 겹치는 것은 3%입니다. <b>코사인</b>은 비중의 모양만 봅니다.
        종목 수가 크게 다른 두 곳에서는 두 값이 엇갈릴 수 있고, 그 엇갈림 자체가 정보입니다.
      </p>
    </Card>
  );
}

/** 기관 포트폴리오의 위험. 커버리지를 항상 먼저 보여 줍니다. */
function RiskCard() {
  const profiles = useApi<GuruProfilesResponse>(endpoints.institution.guruProfiles);
  const [cik, setCik] = useState("0001067983");
  const [benchmark, setBenchmark] = useState("SPY");
  const [years, setYears] = useState("1");

  const { data, loading, error, reload, refreshError } = useApi<GuruRiskResponse>(
    endpoints.institution.guruRisk(cik, benchmark, years),
  );

  const coverage = data?.coverage;
  const metrics = data?.metrics;

  return (
    <Card
      title="포트폴리오 위험" source={SOURCES.sec13fWithPrices}
      subtitle="13F 비중으로 수익률을 재구성해 변동성·VaR·베타·추적오차를 잽니다."
      actions={
        <Freshness
          collectedAt={data?.collectedAtKst}
          ageSeconds={data?.ageSeconds}
          stale={data?.stale}
          refreshError={refreshError}
        />
      }
    >
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="기관"
          value={cik}
          onChange={setCik}
          options={(profiles.data?.rows ?? []).map((row) => ({
            value: row.cik,
            label: row.name,
          }))}
        />
        <Select
          label="벤치마크"
          value={benchmark}
          onChange={setBenchmark}
          options={[
            { value: "SPY", label: "S&P 500 (SPY)" },
            { value: "QQQ", label: "나스닥 100 (QQQ)" },
            { value: "ACWI", label: "글로벌 주식 (ACWI)" },
          ]}
        />
        <Select
          label="측정 구간"
          value={years}
          onChange={setYears}
          options={["1", "2", "3", "5"].map((value) => ({ value, label: `최근 ${value}년` }))}
        />
        <Button onClick={reload}>다시 계산</Button>
      </div>

      {loading && !data && <Loading label="포트폴리오 위험을 계산하는 중…" />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <Banner tone="warn">{data.message}</Banner>}

      {/*
        커버리지를 결과보다 **먼저** 보여 줍니다. 13F에는 티커가 없어 이름으로
        가격을 찾는데, 매핑표에 없는 종목은 빠집니다. 덮인 것만으로 계산한 값을
        전체인 것처럼 보여 주면 안 됩니다.
      */}
      {coverage && (
        <Banner tone={coverage.weight >= 70 ? "info" : "warn"}>
          <div>
            커버리지 <b>{formatWithUnit(coverage.weight, 1, "%")}</b> — 보유 {coverage.totalHoldings}종목
            중 <b>{coverage.holdings}종목</b>의 가격을 찾았습니다. 아래 값은 이 비중만으로 낸
            것이며, 나머지 {formatWithUnit(coverage.totalWeight - coverage.weight, 1, "%")}의 위험은
            반영되지 않았습니다.
          </div>
          {coverage.uncovered.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs">
                미커버 {coverage.uncoveredCount}종목 보기
              </summary>
              <ul className="mt-1 space-y-0.5 text-[11px]">
                {/* 같은 회사의 보통주·우선주·사채가 같은 공시 이름으로 여러 줄 옵니다. 응답에 증권을 가르는 필드가 없고
                    목록은 응답마다 통째로 바뀌므로 순서를 키에 넣습니다(QA-135). */}
                {coverage.uncovered.map((row, index) => (
                  <li key={`${index}:${row.name}`}>
                    {row.name} — {formatWithUnit(row.weight, 2, "%")}
                    {row.reason && <span className="text-muted"> · {row.reason}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Banner>
      )}

      {metrics && (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric
              label="연율 변동성"
              value={formatWithUnit(metrics.volatility, 2, "%")}
              caption={`표본 ${metrics.samples}일 · ${metrics.from} ~ ${metrics.to}`}
            />
            <Metric
              label={`베타 (vs ${data!.benchmark})`}
              value={formatNumber(metrics.beta, 2)}
              caption="1.0이면 벤치마크와 같은 폭으로 움직였다는 뜻"
            />
            <Metric
              label="추적오차 (연율)"
              value={formatWithUnit(metrics.trackingError, 2, "%")}
              caption="벤치마크와 얼마나 달랐나 — 좋고 나쁨은 말하지 않습니다"
            />
            <Metric
              label="최대낙폭"
              value={formatWithUnit(metrics.maxDrawdown, 2, "%")}
              caption="구간 내 고점 대비 최대 하락"
            />
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Metric label="VaR (95%)" value={formatWithUnit(metrics.var95, 2, "%")} caption="일일 최대 예상 손실" />
            <Metric label="VaR (99%)" value={formatWithUnit(metrics.var99, 2, "%")} caption="극단 상황" />
            <Metric label="ES (95%)" value={formatWithUnit(metrics.es95, 2, "%")} caption="VaR 초과 시 평균 손실" />
            <Metric label="ES (99%)" value={formatWithUnit(metrics.es99, 2, "%")} caption="VaR 초과 시 평균 손실" />
          </div>
        </>
      )}

      {(data?.sectors?.length ?? 0) > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold text-body">
            섹터 노출 <span className="font-normal text-muted">(커버된 종목만으로 100%)</span>
          </h3>
          <HorizontalBars
            data={data!.sectors!.map((row) => ({ name: row.sector, value: row.weight }))}
            unit="%"
            digits={1}
            valueName="비중"
            neutral
            height={Math.max(200, data!.sectors!.length * 28)}
          />
        </div>
      )}

      {(data?.contributions?.length ?? 0) > 0 && (
        <div className="mt-5">
          <h3 className="mb-2 text-xs font-semibold text-body">종목별 위험 기여</h3>
          <Table
            rows={data!.contributions!}
            rowKey={(row) => row.ticker}
            columns={[
              {
                key: "name",
                header: "종목",
                render: (row) => (
                  <span className="flex flex-col">
                    <span className="text-body">{row.name}</span>
                    <span className="text-[11px] text-muted">
                      {row.ticker}
                      {row.sector ? ` · ${row.sector}` : ""}
                    </span>
                  </span>
                ),
              },
              {
                key: "weight",
                header: "비중",
                align: "right",
                render: (row) => formatWithUnit(row.weight, 2, "%"),
              },
              {
                key: "volatility",
                header: "개별 변동성",
                align: "right",
                render: (row) => formatWithUnit(row.volatility, 1, "%"),
              },
              {
                key: "contribution",
                header: "위험 기여",
                align: "right",
                render: (row) => (
                  <span className={`font-semibold ${deltaColor(row.contribution, 2)}`}>
                    {formatWithUnit(row.contribution, 2, "%p")}
                  </span>
                ),
              },
              {
                key: "share",
                header: "기여 비중",
                align: "right",
                render: (row) => formatWithUnit(row.share, 1, "%"),
              },
            ]}
          />
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            <b>기여의 합 = 포트폴리오 변동성</b>입니다. 개별 변동성을 그냥 더하면 분산 효과가
            사라져 합이 맞지 않습니다. 비중이 큰 종목이 곧 위험이 큰 종목은 아닙니다 — 조용한
            대형주 20%와 널뛰는 종목 5%의 기여가 뒤집히는 일이 흔합니다.
          </p>
        </div>
      )}

      {data?.note && <p className="mt-3 text-[11px] leading-relaxed text-muted">⚠️ {data.note}</p>}
    </Card>
  );
}

/** 이 종목을 누가 들고 있나. */
function HoldersCard() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const { data, loading, error, reload } = useApi<GuruHoldersResponse>(
    query ? endpoints.institution.guruHolders(query) : null,
  );

  return (
    <Card
      title="이 종목을 누가 들고 있나" source={SOURCES.sec13f}
      subtitle="13F 공시 이름은 대문자 영문입니다 (예: APPLE, NVIDIA, BERKSHIRE)."
    >
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(input.trim());
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-muted">종목명 일부</span>
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="NVIDIA"
            className="rounded-md border border-border bg-surface-hover px-3 py-1.5 text-xs text-bright outline-hidden focus:border-accent"
          />
        </label>
        <Button type="submit">찾기</Button>
      </form>

      {loading && query && <Loading />}
      {error && <ErrorState message={error} onRetry={reload} />}
      {data && !data.available && <EmptyState message={data.message ?? "결과가 없습니다."} />}

      {(data?.rows?.length ?? 0) > 0 && (
        <div className="mt-4">
          {/* 백엔드는 비중 상위 200행까지만 보냅니다(QA-133). 말하지 않으면 잘린 목록이 전부처럼 읽힙니다. */}
          {data!.truncated && (
            <p className="mb-2 text-[11px] leading-relaxed text-muted">
              일치 {formatNumber(data!.totalMatches, 0)}건 중 비중 상위 {data!.rows.length}건만 보입니다 — 종목명을
              더 길게 적어 좁히세요.
            </p>
          )}
          <Table
            rows={data!.rows}
            rowKey={(row, index) => `${row.cik}-${row.cusip}-${index}`}
            columns={[
              { key: "institution", header: "기관", render: (row) => row.institution },
              {
                key: "name",
                header: "종목",
                render: (row) => (
                  <span className="flex flex-col">
                    <span className="text-body">{row.name}</span>
                    <span className="text-[11px] text-muted">CUSIP {row.cusip}</span>
                  </span>
                ),
              },
              {
                key: "weight",
                header: "비중",
                align: "right",
                render: (row) => (
                  <span className="font-semibold">{formatPercent(row.weight).replace("+", "")}</span>
                ),
              },
              {
                key: "value",
                header: "평가액",
                align: "right",
                render: (row) => formatCurrency(row.value),
              },
              {
                key: "reportDate",
                header: "기준 분기",
                render: (row) => <SourceBadge>{row.reportDate}</SourceBadge>,
              },
            ]}
          />
        </div>
      )}
    </Card>
  );
}

/** 표 머리글에 들어갈 짧은 이름. 국기 이모지와 괄호 설명을 뗍니다. */
function shortName(name: string): string {
  return name
    .replace(/^[\p{Extended_Pictographic}‍️\s]+/u, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .trim();
}
