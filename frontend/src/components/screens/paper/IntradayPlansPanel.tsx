"use client";

import { useState } from "react";
import { Banner, Button } from "@/components/ui";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { CLAUDE_COST_NOTE } from "@/lib/paper";
import { intradayBookView, runIntradayResultText } from "@/lib/paperIntraday";
import type { PaperIntradayStatus, PaperMarketCode, PaperRunIntradayResult } from "@/lib/types/paper";

/**
 * 자유 시점 판의 장중 판단(ADR 0027 결정 3) — 그 계좌의 오늘(또는 다음) 세션 계획 행과 '지금 장중 판단 요청' 단추. 상태 응답에 그 계좌의 묶음이
 * 없으면(스위치가 꺼져 있고 계획도 없음) 아무것도 그리지 않습니다. 단추는 예약만 합니다 — Claude 호출은 서버의 장중 판단 작업이 그 시각 + 2분 뒤
 * 창에서 한 번(수동 문턱).
 */
export function IntradayPlansPanel({
  intraday,
  book,
  market = "US",
  onChanged,
}: {
  intraday: PaperIntradayStatus | null | undefined;
  book: string;
  market?: PaperMarketCode;
  onChanged: () => void;
}) {
  const korea = market === "KR";
  const request = useAsyncAction(
    (code: string) => apiPost<PaperRunIntradayResult>(
      korea ? endpoints.paper.market("KR").runIntraday : endpoints.paper.market("US").runIntraday, { book: code },
    ),
    "장중 판단을 예약하지 못했습니다.",
  );
  const [confirming, setConfirming] = useState(false);
  const [requestedFor, setRequestedFor] = useState<string | null>(null);
  const view = intradayBookView(intraday, book, market);
  if (!view) return null;

  const run = async () => {
    setConfirming(false);
    setRequestedFor(book);
    const ok = await request.run(book);
    if (ok) onChanged();
  };
  const result = request.result && requestedFor === book ? runIntradayResultText(request.result, market) : null;
  const error = request.error && requestedFor === book ? request.error : null;

  return (
    <section aria-label="장중 판단" className="mt-3 rounded-control border border-line px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">장중 판단(자유 시점 판)</h3>
          <p className="text-xs text-muted">{view.summary}</p>
        </div>
        <Button onClick={() => setConfirming(true)} disabled={request.busy || confirming || view.blocked !== null}>
          {request.busy ? "예약 중…" : "지금 장중 판단 요청"}
        </Button>
      </div>
      {view.blocked && <p className="mt-2 text-xs text-warn">{view.blocked}</p>}
      {view.rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted">이 세션에 예약된 장중 판단이 없습니다.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1.5">
          {view.rows.map((row) => (
            <li key={row.key} className="text-xs leading-relaxed">
              <span className={`mr-2 inline-flex rounded-control px-1.5 py-0.5 ${row.badge.className}`}>{row.badge.label}</span>
              <span>{row.text}</span>
              {row.question && <span className="text-muted"> — {row.question}</span>}
              {row.trigger && <span className="block text-muted">{row.trigger}</span>}
              {row.reason && <span className="block text-muted">사유: {row.reason}</span>}
            </li>
          ))}
        </ul>
      )}
      {confirming && (
        <div className="mt-3 flex flex-col gap-3 rounded-control border border-warn/30 bg-warn-tint px-4 py-3">
          <p className="text-sm leading-relaxed text-warn">
            장중 판단을 지금으로 당길까요? 가장 이른 남은 예약을 1분 뒤로 옮기거나(없으면 새로 넣고), 서버가 그 시각 + 2분 뒤 창에서 Claude를 한 번
            부릅니다. {CLAUDE_COST_NOTE}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void run()} disabled={request.busy}>요청 확인</Button>
            <Button onClick={() => setConfirming(false)} disabled={request.busy}>취소</Button>
          </div>
        </div>
      )}
      {error && <div className="mt-3"><Banner tone="warn">{error}</Banner></div>}
      {result && <div className="mt-3"><Banner tone="info">{result}</Banner></div>}
    </section>
  );
}
