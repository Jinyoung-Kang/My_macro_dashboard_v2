"use client";

import { useState } from "react";
import { DataTable } from "@/components/patterns";
import { Callout, ErrorState, Loading, Panel, Select } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { historySelection } from "@/lib/radar";
import { EMPTY } from "@/lib/format";
import { signedAmount } from "./RankingDetail";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

export function HistoryPanel({
  market,
  investor,
  tradeType,
}: {
  market: string;
  investor: string;
  tradeType: string;
}) {
  const [date, setDate] = useState("");
  // 고른 거래일 하루치만 받습니다(latest=true — 날짜를 안 골랐으면 이 조건의 가장 최근 거래일).
  // 예전에는 전 기간을 받아 화면에서 30행만 골랐습니다(1년치 합성 데이터: 7,800행·2.3MB).
  const { data, loading, error, reload } = useApi<{
    dates: string[];
    obsDate?: string | null;
    note: string;
    rows: { obsDate: string; code: string; name: string; netAmountEok: number }[];
  }>(
    endpoints.positioning.radarHistory({ market, investor, tradeType, obsDate: date }),
  );

  const { dates, selectedDate, dateOptions, rows } = historySelection(date, data);

  return (
    <Panel
      title="누적 수급 이력" source={SOURCES.radarHistory}
      subtitle={data?.note}
      actions={
        dates.length > 0 ? (
          <Select
            label="거래일"
            value={selectedDate}
            onChange={setDate}
            options={dateOptions.map((value) => ({ value, label: value }))}
          />
        ) : undefined
      }
    >
      {loading && !data && <Loading />}
      {/* 조회가 실패했으면 '이력 없음'이 아니라 실패입니다(QA-046). */}
      {error && <ErrorState message={error} onRetry={reload} />}
      {!loading && !error && dates.length === 0 && (
        <Callout>
          아직 누적된 이력이 없습니다. 수집기를 꾸준히 돌리면 거래일별로 쌓입니다 —
          Naver·Daum은 과거 날짜 조회를 지원하지 않고 KRX 확정 순위는 수집기가 저장한 날짜만 있으므로 이 이력이 곧 백업입니다.
        </Callout>
      )}
      {rows.length > 0 && (
        <DataTable
          dense
          count
          caption="누적 수급 이력"
          // 같은 종목이 한 날에 두 번 와도 갈리게 차례를 붙입니다(예전 표의 '{코드}-{차례}' 키와 같음).
          rows={rows.map((row, index) => ({ ...row, key: `${row.code}-${index}` }))}
          rowKey={(row) => row.key}
          columns={[
            { key: "code", header: "종목코드", className: "whitespace-nowrap", cell: (row) => <span className="font-mono">{row.code}</span> },
            { key: "name", header: "종목명", rowHeader: true, className: "break-keep", cell: (row) => row.name },
            // 순매수 금액은 오르내린 값이 아니라 본문 잉크 + 부호(음수 −).
            { key: "net", header: "순매수대금(억)", align: "right", cell: (row) => signedAmount(row.netAmountEok, 1) },
          ]}
        />
      )}
      {!loading && dates.length > 0 && rows.length === 0 && (
        <p className="text-xs text-text-3">{EMPTY} 해당 조건의 이력이 없습니다.</p>
      )}
    </Panel>
  );
}
