"use client";

import type { ReactNode } from "react";
import { type Column, DataTable } from "@/components/patterns";
import { Card } from "@/components/ui";
import { EMPTY } from "@/lib/format";
import { PAPER_SOURCES } from "@/lib/paper";
import { accountComparisonRows, type ComparisonRow, sampleNotes } from "@/lib/paperOverview";
import type { PaperMarketCode } from "@/lib/paperMarket";
import type { PaperBookSummary } from "@/lib/types";

/**
 * 개요의 '계좌 비교' 카드 — 계좌를 항목별로 나란히(행 = 항목 · 열 = 계좌, 값은 lib/paperOverview `accountComparisonRows`), 그 아래 계좌마다의 표본
 * 설명. 개요(OverviewSection)에서 떼어 냈습니다(동작 그대로).
 */
export function AccountComparisonCard({
  books,
  market = "US",
}: {
  books: readonly PaperBookSummary[];
  /** 이 개요의 시장(기본 미국). */
  market?: PaperMarketCode;
}) {
  const korea = market === "KR";
  const comparison = accountComparisonRows(books, market);
  const ledgerSource = korea ? PAPER_SOURCES.krLedger : PAPER_SOURCES.ledger;
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
    <Card
      title="계좌 비교"
      subtitle={`${korea ? "네 계좌를" : "계좌를"} 항목별로 나란히 — 순자산·수익률·노출은 마지막 관측치 기준 · 통계는 거래일별 순자산 기준(초과 수익률·베타는 '비교 기준' 줄의 계좌 대비)`}
      source={ledgerSource}
    >
      <DataTable<ComparisonRow>
        columns={comparisonColumns}
        rows={comparison}
        rowKey={(row) => row.key}
        caption="계좌 비교"
        scrollHint="overflow"
      />
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

/** 계좌 비교 표의 칸 — 상태는 배지, 색이 있는 값(수익률·가격 없음)은 그 색, 나머지는 글 그대로("—"면 표가 Empty로 그림). */
function comparisonContent(row: ComparisonRow, code: string): ReactNode {
  const cell = row.cells[code];
  if (!cell || cell.text === EMPTY) return cell?.text ?? null;
  if (row.badge && cell.className) {
    return <span className={`whitespace-nowrap rounded-sm border px-2 py-0.5 text-xs ${cell.className}`}>{cell.text}</span>;
  }
  return cell.className ? <span className={cell.className}>{cell.text}</span> : cell.text;
}
