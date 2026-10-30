"use client";

import { useState } from "react";
import { type Column, DataTable } from "@/components/patterns";
import { Banner, Card, ErrorState, Freshness, Loading } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { endpoints } from "@/lib/endpoints";
import { type ExecutionTimingRow, executionSummaryView, isTimedBook, PAPER_SOURCES, primaryClaudeBook } from "@/lib/paper";
import type { PaperBookSummary, PaperExecutionResponse } from "@/lib/types";

/** 요약만 쓰므로 주문 줄은 하나만 받습니다(요약은 limit과 상관없이 그 계좌 전부 — docs/API.md). */
const SUMMARY_LIMIT = 1;

const COLUMNS: readonly Column<ExecutionTimingRow>[] = [
  {
    key: "timing",
    header: "시점",
    rowHeader: true,
    className: "whitespace-nowrap",
    cell: (row) => (
      <span className="flex flex-wrap items-center gap-1">
        <span>{row.timing}</span>
        {row.proxy && (
          <span
            className="whitespace-nowrap rounded-sm border border-warn/40 bg-warn-tint px-1.5 py-px text-[10px] text-warn"
            title="Yahoo(yfinance) 1분봉 첫 봉 시가입니다 — 공식 개장 경매가와 같은지 확인하지 못했습니다(명세 §19 X2)."
          >
            대리값
          </span>
        )}
      </span>
    ),
  },
  { key: "n", header: "주문", align: "right", cell: (row) => row.n },
  { key: "days", header: "결정일", align: "right", cell: (row) => row.days },
  // 색을 입히지 않습니다 — 상승·하락색은 값의 방향이지 좋고 나쁨이 아니고, 이 표는 판정이 아닙니다(부호와 머리글로 읽음).
  { key: "mean", header: "평균(계좌1식 대비)", align: "right", cell: (row) => row.mean },
  { key: "interval", header: "90% 구간", align: "right", className: "whitespace-nowrap", cell: (row) => row.interval },
  { key: "verdict", header: "판단", className: "min-w-[12rem] break-keep", cell: (row) => row.verdict ?? "구간 참고(판정은 8주 뒤)" },
  { key: "excluded", header: "뺀 주문", className: "whitespace-nowrap text-xs", cell: (row) => row.excluded },
];

/**
 * 🧪 체결 시점 실험(미국 Claude 계좌2 — 계좌2 명세 §13-3·§14, ADR 0022 결정 13) — GET /api/paper/books/{code}/execution의 요약을 시점마다 한 줄로.
 *
 * 줄마다 "그 계좌 주문을 모두 그 시점에 체결했다면 계좌1식(다음 시간별 관측치)보다 몇 bp 나았나"의 체결 금액 가중 평균과 결정일 묶음 부트스트랩 90%
 * 구간입니다(서버 계산 — 화면은 계산하지 않음). 주문 수·결정일 수가 문턱보다 적으면 서버가 null을 보내고 화면은 '—'와 '판단 보류'로 적습니다. 값이 있어도
 * 화면은 "도움이 됐다/손해였다"를 정하지 않습니다 — 사전 등록 판정은 8주 뒤 계좌2가 고른 시점의 체결로 합니다(§14-3). 시가(NEXT_OPEN)는 대리값 배지.
 *
 * 계좌2가 출발하기 전에도 계좌1 주문의 반사실(기준 분포 — 단계 0부터)을 볼 수 있게 계좌를 고릅니다(처음엔 계좌2).
 */
export function ExecutionExperimentCard({ books }: { books: readonly PaperBookSummary[] }) {
  // 실행 감사가 있는 계좌 — 미국 Claude 계좌(계좌2를 앞에, 그다음 계좌1). 서버는 그 밖의 코드를 400으로 거절합니다.
  const audited = [books.find((book) => isTimedBook(book.code)), primaryClaudeBook(books)]
    .filter((book): book is PaperBookSummary => book !== undefined && book !== null);
  const [picked, setPicked] = useState<string | null>(null);
  const code = audited.find((book) => book.code === picked)?.code ?? audited[0]?.code ?? null;
  const execution = useApi<PaperExecutionResponse>(code ? endpoints.paper.execution(code, SUMMARY_LIMIT) : null, 300_000);
  if (!code) return null;
  const view = executionSummaryView(execution.data);

  return (
    <Card
      title="체결 시점 실험"
      subtitle="시점마다 그 계좌 주문을 그 시점에 체결했다면 계좌1식(다음 시간별 관측치)보다 몇 bp 나았나 — 양수면 그 시점이 유리 · 원가격(슬리피지 전) · 서버 계산"
      source={PAPER_SOURCES.execution}
      actions={<Freshness refreshError={execution.refreshError} />}
    >
      {audited.length > 1 && (
        <div role="group" aria-label="실행 감사 계좌" className="mb-3 inline-flex overflow-hidden rounded-md border border-border">
          {audited.map((book) => {
            const active = book.code === code;
            return (
              <button
                key={book.code}
                type="button"
                aria-pressed={active}
                onClick={() => setPicked(book.code)}
                className={`px-3 py-1.5 text-xs transition-colors duration-150 motion-reduce:transition-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus ${
                  active ? "bg-surface-2 font-semibold text-text" : "text-text-2 hover:bg-surface-2 hover:text-text"
                }`}
              >
                {book.label}
              </button>
            );
          })}
        </div>
      )}
      {execution.loading && !execution.data && <Loading label="실행 감사를 읽는 중…" />}
      {execution.error && <ErrorState message={execution.error} onRetry={execution.reload} />}
      {execution.data && !execution.data.available && <Banner tone="warn">{execution.data.message ?? "실행 감사를 읽을 수 없습니다."}</Banner>}
      {view && (
        <>
          <p className="mb-2 text-xs text-muted">{view.head}</p>
          <DataTable<ExecutionTimingRow>
            columns={COLUMNS}
            rows={view.rows}
            rowKey={(row) => row.key}
            caption="체결 시점 실험"
            scrollHint="overflow"
            emptyText="아직 감사한 주문이 없습니다."
          />
          <ul aria-label="체결 시점 실험 설명" className="mt-2 flex flex-col gap-0.5 text-xs text-text-3">
            {view.formula && <li>계산: {view.formula}</li>}
            {view.method && <li>{view.method}</li>}
            <li>
              판정(사전 등록 — ADR 0022 결정 13)은 8주 뒤 계좌2가 고른 시점의 체결로 합니다. 이 표는 시점마다의 반사실 분포라 판정이 아닙니다 — 대체
              체결·계좌1식 기준이 없는 주문은 빼고 셉니다(뺀 수를 함께 적음).
            </li>
          </ul>
        </>
      )}
    </Card>
  );
}
