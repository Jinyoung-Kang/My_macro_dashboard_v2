"use client";

import { type Column, DataTable } from "@/components/patterns";
import { Card, ErrorState, Freshness, Loading } from "@/components/ui";
import { PAPER_SOURCES, quotesLine } from "@/lib/paper";
import { type KrCollectionRow, type KrCollectionState, krCollectionRows } from "@/lib/paperKr";
import type { PaperQuotesSummary, PaperStatusResponse } from "@/lib/types";

/** 판정 배지 색 — 글(정상·늦음·뒤처짐·없음·모름)이 뜻을 나르고 색은 보조입니다(lib/paper 배지와 같은 팔레트). */
const STATE_TONE: Record<KrCollectionState, string> = {
  정상: "border-ok/40 bg-ok-tint text-ok",
  늦음: "border-warn/40 bg-warn-tint text-warn",
  뒤처짐: "border-warn/40 bg-warn-tint text-warn",
  없음: "border-warn/40 bg-warn-tint text-warn",
  모름: "border-border bg-surface-hover text-muted",
};


const COLUMNS: Column<KrCollectionRow>[] = [
  {
    key: "item",
    header: "항목",
    rowHeader: true,
    className: "whitespace-nowrap",
    cell: (row) => (
      <span className="flex flex-col">
        <span className="font-medium text-text">{row.item}</span>
        <span className="text-[11px] font-normal text-text-3">{row.source}</span>
      </span>
    ),
  },
  { key: "basis", header: "기준(세션·기준일)", cell: (row) => row.basis },
  { key: "collectedAt", header: "수집 시각(KST)", className: "whitespace-nowrap", cell: (row) => row.collectedAt },
  { key: "scope", header: "범위·개수", cell: (row) => row.scope },
  {
    key: "state",
    header: "상태",
    cell: (row) => (
      <span className="flex flex-col gap-0.5">
        <span className={`w-fit whitespace-nowrap rounded-sm border px-1.5 py-px text-[11px] ${STATE_TONE[row.state]}`}>{row.state}</span>
        {row.reason && <span className="text-[11px] text-text-2">{row.reason}</span>}
      </span>
    ),
  },
];

/**
 * 한국 수집 상태 카드(2단계 명세 §9 x4 — 사용자 결정 2026-10-29) — 한국 개요에서 미국의 '장부 관측치' 카드 자리에 놓습니다. 상태 응답
 * (`?market=KR`)의 `collection`을 표로(관측치 줄에 개요의 관측치 요약을 함께), 관측치 신선도는 머리에. 상태 응답이 실패하면 이 카드만 오류와
 * 다시 시도이고 계좌 행·곡선은 개요 응답이라 그대로입니다. 이 칸을 보내지 않는 서버(F2 전)면 관측치 한 줄만 적습니다.
 */
export function KrCollectionCard({
  status,
  quotes,
}: {
  status: { data: PaperStatusResponse | null; loading: boolean; error: string | null; reload: () => void };
  quotes: PaperQuotesSummary | null;
}) {
  const collection = status.data?.available ? status.data.collection ?? null : null;
  const rows = krCollectionRows(collection, quotes);
  return (
    <Card
      title="한국 수집 상태"
      subtitle="한국 책이 읽는 수집기 저장본 — 관측치·수급은 KR 거래일 20:30 KST 뒤 하루 한 번(장중 관측치 없음). 늦음: 관측치·수급은 다음 수집 예정 + 2시간 5분, DART·일정 7일, 뉴스 24시간 · 유니버스·금융위는 기준일 비교(뒤처짐)"
      source={PAPER_SOURCES.krCollection}
      actions={quotes && <Freshness collectedAt={quotes.collectedAtKst} ageSeconds={quotes.ageSeconds ?? undefined} stale={quotes.stale} />}
    >
      {status.loading && !status.data && <Loading label="한국 수집 상태를 읽는 중…" />}
      {status.error && <ErrorState message={`한국 수집 상태를 읽지 못했습니다 — ${status.error}`} onRetry={status.reload} />}
      {!status.error && status.data && !collection && (
        <p className="text-sm text-body">
          이 서버는 한국 수집 상태를 보내지 않습니다 — 관측치 한 줄만: {quotesLine(quotes, "KR")}
        </p>
      )}
      {!status.error && collection && (
        <DataTable<KrCollectionRow> columns={COLUMNS} rows={rows} rowKey={(row) => row.key} caption="한국 수집 상태" scrollHint />
      )}
    </Card>
  );
}
