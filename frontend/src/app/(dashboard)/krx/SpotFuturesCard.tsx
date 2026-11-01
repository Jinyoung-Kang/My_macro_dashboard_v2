"use client";

import { Banner, Card, Freshness, Loading, Table } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { deltaColor, formatKst, formatSigned, formatSignedKrw } from "@/lib/format";
import type { SpotFuturesResponse, SpotFuturesRow } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

/**
 * 현물·선물 수급 동조 — 같은 투자자가 코스피 현물과 KOSPI200 선물을 같은 방향으로 샀나.
 *
 * 현물은 토스증권 공식(원), 선물은 Daum(계약)이라 **단위가 달라 크기는 비교하지 않습니다.**
 * 방향만 봅니다. 토스 API에는 선물·옵션 데이터가 없어서, 선물 쪽은 기존 출처를 그대로 씁니다.
 *
 * 읽는 법
 *   - 외국인 "동반 순매수": 현물을 사면서 선물도 삼 — 방향성 베팅이 강한 날
 *   - "현물 매수 · 선물 매도": 현물 보유분을 선물로 헤지했을 수 있음
 *   - 금융투자: 차익거래 주체라 현물·선물이 반대인 것이 보통입니다
 */
function verdictClass(verdict: string): string {
  if (verdict === "동반 순매수") return "text-up font-semibold";
  if (verdict === "동반 순매도") return "text-down font-semibold";
  return "text-muted";
}

export function SpotFuturesCard() {
  const { data, loading, error, refreshError } = useApi<SpotFuturesResponse>(endpoints.positioning.krxSpotFutures, 300_000);

  return (
    <Card
      title="현물·선물 수급 동조 (외국인·기관·개인)"
      subtitle={
        data?.available
          ? `현물 기준일 ${data.spotDate} (코스피 전체) · 선물 기준일 ${data.futuresDate} (KOSPI200 선물)`
          : undefined
      }
      source="현물: 토스증권 Open API (공식, 원) · 선물: Daum 투자주체별 매매동향 (비공식, 계약)"
      actions={<Freshness collectedAt={data?.collectedAtKst} ageSeconds={data?.ageSeconds} refreshError={refreshError} />}
    >
      {loading && !data && <Loading />}
      {error && <Banner tone="warn">{error}</Banner>}
      {data && !data.available && <Banner tone="warn">{data.message ?? "비교할 데이터가 없습니다."}</Banner>}
      {data?.available && (
        <>
          {data.spotIsStale && (
            // 이어받은 현물은 위 수집 시각(다른 시장을 받은 때)과 달리 예전 값입니다(QA-116).
            <Banner tone="warn">
              이전 값 — 이번 수집 실패: {data.spotStaleReason ?? "사유 모름"}
              {data.spotFetchedAt ? ` · ${formatKst(data.spotFetchedAt)}에 받은 값` : ""}
            </Banner>
          )}
          {!data.sameDay && (
            <Banner tone="warn">
              두 출처의 기준일이 달라({data.spotDate} / {data.futuresDate}) 당일 비교는 하지 않습니다. 5·20일
              누적도 하루 어긋나 있을 수 있습니다.
            </Banner>
          )}
          <Table<SpotFuturesRow>
            rows={data.rows ?? []}
            rowKey={(row) => row.key}
            columns={[
              { key: "label", header: "투자자", render: (row) => row.label },
              {
                key: "spot5",
                header: "현물 5일 (원)",
                align: "right",
                render: (row) => <span className={deltaColor(row.spot5, 0)}>{formatSignedKrw(row.spot5)}</span>,
              },
              {
                key: "fut5",
                header: "선물 5일 (계약)",
                align: "right",
                render: (row) => <span className={deltaColor(row.futures5, 0)}>{formatSigned(row.futures5, 0)}</span>,
              },
              { key: "v5", header: "5일 방향", render: (row) => <span className={verdictClass(row.verdict5)}>{row.verdict5}</span> },
              {
                key: "spot20",
                header: "현물 20일 (원)",
                align: "right",
                render: (row) => <span className={deltaColor(row.spot20, 0)}>{formatSignedKrw(row.spot20)}</span>,
              },
              {
                key: "fut20",
                header: "선물 20일 (계약)",
                align: "right",
                render: (row) => <span className={deltaColor(row.futures20, 0)}>{formatSigned(row.futures20, 0)}</span>,
              },
              { key: "v20", header: "20일 방향", render: (row) => <span className={verdictClass(row.verdict20)}>{row.verdict20}</span> },
              { key: "vt", header: "당일", render: (row) => <span className={verdictClass(row.verdictToday)}>{row.verdictToday}</span> },
            ]}
          />
          <p className="mt-2 text-xs leading-relaxed text-muted">
            단위가 달라(원 · 계약) 크기는 비교하지 않고 방향만 봅니다. 금융투자는 현물·선물 가격 차이를 노리는
            차익거래 주체라 두 시장에서 반대로 움직이는 것이 보통입니다. 토스증권 API는 선물·옵션 데이터를
            제공하지 않아 선물 쪽은 Daum(비공식) 값을 씁니다.
          </p>
        </>
      )}
    </Card>
  );
}
