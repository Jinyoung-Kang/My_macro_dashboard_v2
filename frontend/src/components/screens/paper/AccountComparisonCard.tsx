"use client";

import type { ReactNode } from "react";
import { type Column, DataTable } from "@/components/patterns";
import { Card } from "@/components/ui";
import { EMPTY } from "@/lib/format";
import { PAPER_SOURCES } from "@/lib/paper";
import { comparisonBasis, currentSource } from "@/lib/paperCurrent";
import { accountComparisonRows, type ComparisonRow, sampleNotes } from "@/lib/paperOverview";
import type { PaperMarketCode } from "@/lib/paperMarket";
import type { PaperLiveSessionSummary, PaperOverviewBook } from "@/lib/types";

/** 지금 값이 있는 표 아래의 설명 — 맨 위 기준 줄의 수익률과 통계(거래일 마감)의 누적 수익률이 다를 수 있음(장중 명세 §4·위험 5). */
export const TWO_RETURNS_NOTE =
  "'수익률(출발 이후)'은 맨 위 '기준' 줄의 값이고, 통계 일곱 칸은 거래일 마감 순자산 줄('통계 기준' 줄의 마지막 줄까지)로 계산해 서로 다를 수 있습니다.";

/**
 * 개요의 '계좌 비교' 카드 — 계좌를 항목별로 나란히(행 = 항목 · 열 = 계좌, 값은 lib/paperOverview `accountComparisonRows`), 그 아래 계좌마다의 표본
 * 설명.
 *
 * 지금 값이 있으면 한 표 한 기준(장중 명세 §4): 판정 대상 계좌가 모두 장중 추정이면 순자산·수익률·오늘 변화·노출이 지금 값, 아니면 표 전체가
 * 장부 칸이고 장중 추정인 계좌가 있으면 표 위에 그 사유(경고 배너가 아니라 한 줄 글). 기준 줄·변화 줄·통계 기준 줄은 lib가 만들고, 표 아래에
 * 두 수익률이 다를 수 있다는 설명. 옛 응답(지금 값 없음)은 예전 표 그대로입니다.
 */
export function AccountComparisonCard({
  books,
  market = "US",
  session = null,
}: {
  books: readonly PaperOverviewBook[];
  /** 이 개요의 시장(기본 미국). */
  market?: PaperMarketCode;
  /** 개요의 장 상태(`liveSession`) — '오늘'·단계 표기. */
  session?: PaperLiveSessionSummary | null;
}) {
  const korea = market === "KR";
  const comparison = accountComparisonRows(books, market, { session });
  const basis = comparisonBasis(books, session);
  const live = basis.hasCurrent && basis.mode === "live";
  const ledgerSource = korea ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger;
  const lead = `${korea ? "네 계좌를" : "계좌를"} 항목별로 나란히`;
  const statsNote = "통계는 거래일 마감 기준(초과 수익률·베타는 '비교 기준' 줄의 계좌 대비)";
  const subtitle = !basis.hasCurrent
    ? `${lead} — 순자산·수익률·노출은 마지막 관측치 기준 · 통계는 거래일별 순자산 기준(초과 수익률·베타는 '비교 기준' 줄의 계좌 대비)`
    : live
      ? `${lead} — 순자산·수익률·${basis.dayLabel}·노출은 맨 위 기준 줄(장중 추정은 표시 전용) · ${statsNote}`
      : `${lead} — 순자산·수익률·${basis.dayLabel}·노출은 장부의 마지막 관측치 기준(맨 위 기준 줄) · ${statsNote}`;
  const comparisonColumns: Column<ComparisonRow>[] = [
    // 줄이 항목이라 항목 이름 칸을 행 머리(th scope=row)로 — 낭독기가 칸마다 "순자산 · 규칙 계좌"처럼 항목과 계좌를 함께 읽습니다.
    { key: "label", header: "항목", rowHeader: true, cell: (row) => row.label, className: "whitespace-nowrap text-text-2" },
    ...books.map((book): Column<ComparisonRow> => ({
      key: book.code,
      header: book.label,
      align: "right",
      cell: (row) => comparisonContent(row, book.code),
    })),
  ];

  return (
    <Card title="계좌 비교" subtitle={subtitle} source={live ? currentSource(true, market) : ledgerSource}>
      {basis.reason && <p className="mb-3 text-xs text-text-2">{basis.reason}</p>}
      <DataTable<ComparisonRow>
        columns={comparisonColumns}
        rows={comparison}
        rowKey={(row) => row.key}
        caption="계좌 비교"
        scrollHint="overflow"
      />
      {basis.hasCurrent && <p className="mt-3 text-xs text-text-2">{TWO_RETURNS_NOTE}</p>}
      <ul aria-label="표본 설명" className="mt-3 flex flex-col gap-0.5 text-xs text-text-3">
        {sampleNotes(books).map((note) => (
          <li key={note.code}>
            <span className="font-medium text-text-2">{note.label}</span> — {note.text}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * 계좌 비교 표의 칸 — 상태는 배지, 색이 있는 값(수익률·가격 없음·변화)은 그 색, 나머지는 글 그대로("—"면 표가 Empty로 그림). 값 아래 작은 글
 * (변화의 기준)이 있으면 그 아래 줄에, 기준 줄처럼 긴 글은 칸 안에서 줄을 바꿉니다.
 */
function comparisonContent(row: ComparisonRow, code: string): ReactNode {
  const cell = row.cells[code];
  if (!cell || cell.text === EMPTY) return cell?.text ?? null;
  if (row.badge && cell.className) {
    return <span className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-xs ${cell.className}`}>{cell.text}</span>;
  }
  const text = cell.className ? <span className={cell.className}>{cell.text}</span> : cell.text;
  if (cell.sub) {
    return (
      <span className="flex flex-col items-end">
        {text}
        <span className="text-xs text-text-3">{cell.sub}</span>
      </span>
    );
  }
  return row.wrap ? <span className="inline-block min-w-32 whitespace-normal text-[13px] text-text-2">{cell.text}</span> : text;
}
