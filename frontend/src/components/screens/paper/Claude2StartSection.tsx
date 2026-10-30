"use client";

import { useState } from "react";
import { Banner, Button, Card } from "@/components/ui";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { claude2StartResultView, claude2StartView, PAPER_SOURCES } from "@/lib/paper";
import type { PaperInitialDecisionResult, PaperOverviewResponse, PaperStatusResponse } from "@/lib/types";

/**
 * 🧪 개요의 미국 Claude 계좌2 출발(계좌2 명세 §4-1·§5-4, ADR 0022 결정 2) — 계좌2가 시작 전이면 카드, 출발한 뒤에는 결과만 남깁니다.
 *
 * 출발은 앞으로 체결입니다: 설정 claude2.enabled를 켜면(설정 탭 — 사용자가 시작, 명세 L2) 다음 미국 결정 창에 정기 결정 작업이 출발 결정을 내고, 이
 * 카드의 "계좌2 시작"은 같은 출발을 그 창 안에서 지금 한 번 부릅니다(POST run/initial-decision `{book:"claude2"}` — 창 밖·꺼짐은 서버 400, 기록
 * 없음). 설정이 꺼져 있거나 상태를 읽지 못했으면 단추를 닫고 그 까닭을 적습니다. Claude를 한 번 부르므로 확인 단계를 거칩니다. 미리보기는 없습니다.
 * 창 시각·이번 주기 호출은 상태 응답(claude2 묶음)의 글자 그대로입니다.
 */
export function Claude2StartSection({
  overview,
  status,
  onChanged,
}: {
  overview: PaperOverviewResponse;
  status: PaperStatusResponse | null;
  onChanged: () => void;
}) {
  const view = claude2StartView(overview, status?.available ? status : null);
  const [confirming, setConfirming] = useState(false);
  const start = useAsyncAction(
    (book: string) => apiPost<PaperInitialDecisionResult>(endpoints.paper.runInitialDecision, { book }),
    "Claude 계좌2를 출발시키지 못했습니다.",
  );
  const elapsed = useElapsedSeconds(start.busy);
  const label = view?.bookLabel ?? "Claude 계좌2";
  const result = start.result ? claude2StartResultView(start.result, label) : null;
  const resultBanner = result && <Banner tone={result.tone}>{result.text}</Banner>;

  if (!view) return resultBanner || null;

  const runStart = async () => {
    const ok = await start.run(view.bookCode);
    // 성공·실패 모두 확인 단계를 닫습니다 — 실패 사유(창 밖·꺼짐·상한)는 아래 경고로 남고, 다시 부르려면 확인을 한 번 더 거칩니다.
    setConfirming(false);
    if (ok) onChanged();
  };

  return (
    <Card
      title={`${view.bookLabel} — ${view.title}`}
      subtitle="앞으로 체결 출발 — 마감이 끝난 최근 미국 세션 기준 출발 결정 · 다음 세션에 고른 시점으로 체결 · 사후 체결·미리보기 없음"
      source={PAPER_SOURCES.decisions}
    >
      <p className="text-sm leading-relaxed text-body">{view.body}</p>
      <div className="mt-3">
        <Banner tone={view.armed === true ? "info" : "warn"}>{view.armNote}</Banner>
      </div>
      <dl aria-label="계좌2 결정 창" className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {view.lines.map((line) => (
          <div key={line.key} className="min-w-0">
            <dt className="text-muted">{line.label}</dt>
            <dd className="tabular-nums text-bright">{line.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-muted">비용: {view.cost}</p>

      {confirming ? (
        <div className="mt-3 flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
          <p className="text-sm leading-relaxed text-warn">{view.confirm}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void runStart()} disabled={start.busy}>
              {start.busy ? `출발 중… ${elapsed}초` : "출발 확인"}
            </Button>
            <Button onClick={() => setConfirming(false)} disabled={start.busy}>취소</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={start.busy || view.armed !== true}>
            {view.title}
          </Button>
        </div>
      )}

      {/* 서버 문구(창 밖·설정 꺼짐·호출 상한·개장 전 컷오프)를 그대로 — 무엇을 기다려야 하는지 서버가 적어 보냅니다. */}
      {start.error && <div className="mt-3"><Banner tone="warn">{start.error}</Banner></div>}
      {resultBanner && <div className="mt-3">{resultBanner}</div>}
    </Card>
  );
}
