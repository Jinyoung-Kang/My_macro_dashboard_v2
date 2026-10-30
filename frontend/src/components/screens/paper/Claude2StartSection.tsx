"use client";

import { useState } from "react";
import { Banner, Button, Card } from "@/components/ui";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { useMinuteClock } from "@/hooks/useMinuteClock";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { claude2CheckpointLine, claude2StartResultView, claude2StartView, type DecisionMetaCell, PAPER_SOURCES } from "@/lib/paper";
import type { PaperInitialDecisionResult, PaperOverviewResponse, PaperStatusResponse } from "@/lib/types";

/**
 * 🧪 개요의 미국 Claude 계좌2 출발(계좌2 명세 §4-1·§5-4, ADR 0022 결정 2) — 계좌2가 시작 전이면 카드, 출발한 뒤에는 결과만 남깁니다.
 *
 * 출발은 앞으로 체결입니다: 설정 claude2.enabled를 켜면(설정 탭 — 사용자가 시작, 명세 L2) 다음 미국 결정 창에 정기 결정 작업이 출발 결정을 내고, 이
 * 카드의 "계좌2 시작"은 같은 출발을 그 창 안에서 지금 한 번 부릅니다(POST run/initial-decision `{book:"claude2"}` — 창 밖·꺼짐은 서버 400, 기록
 * 없음). 설정이 꺼져 있거나 상태를 읽지 못했거나 관측치 사슬 준비 중이면(상태 칸 chainReady false — 켠 직후·새 관측치 직후 몇 분, 서버가 출발을 거절)
 * 단추를 닫고 그 까닭을 적습니다. Claude를 한 번 부르므로 확인 단계를 거칩니다. 미리보기는 없습니다.
 * 창 시각·이번 주기 호출은 상태 응답(claude2 묶음)의 글자 그대로이고, 다음 결정 시각이 이미 지났으면(그 거래일 행이 아직 없음 — 창은 컷오프까지 열림)
 * 지난 시각 대신 창이 열렸다고 적습니다(lib/paper claude2WindowLines). 그 아래 '오늘 장중 확인' 한 줄(단계 2 — 상태 응답 claude2.checkpoint, 칸이 없는
 * 백엔드면 줄 없음).
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
  // 분 시계 — 다음 결정 시각이 지났으면 지난 시각 대신 '결정 창 열림(…부터 컷오프 …까지)'(마운트 전에는 받은 시각 그대로).
  const now = useMinuteClock();
  const view = claude2StartView(overview, status?.available ? status : null, now);
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
        <Banner tone={view.ready ? "info" : "warn"}>{view.armNote}</Banner>
      </div>
      <Claude2WindowList lines={view.lines} className="mt-3" />
      <Claude2CheckpointLine line={claude2CheckpointLine(status?.available ? status.claude2 : null)} />
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
          <Button variant="primary" onClick={() => setConfirming(true)} disabled={start.busy || !view.ready}>
            {view.title}
          </Button>
        </div>
      )}

      {/* 서버 문구(창 밖·설정 꺼짐·호출 상한·개장 전 컷오프·관측치 사슬 준비 중)를 그대로 — 무엇을 기다려야 하는지 서버가 적어 보냅니다. */}
      {start.error && <div className="mt-3"><Banner tone="warn">{start.error}</Banner></div>}
      {resultBanner && <div className="mt-3">{resultBanner}</div>}
    </Card>
  );
}

/** 🧪 '오늘 장중 확인' 한 줄(lib/paper claude2CheckpointLine — 단계 2). 줄이 없으면(칸을 보내지 않는 백엔드) 그리지 않습니다. */
export function Claude2CheckpointLine({ line, className = "mt-2" }: { line: string | null; className?: string }) {
  if (!line) return null;
  return <p aria-label="오늘 장중 확인" className={`text-xs leading-relaxed text-muted ${className}`}>{line}</p>;
}

/**
 * 계좌2 결정 창 세 줄(다음 결정·개장 전 컷오프·이번 결정 주기 호출 — lib/paper claude2WindowLines) — 출발 카드와, 출발 뒤 결정 로그에서 계좌2를 골랐을 때
 * 같은 모양으로 씁니다.
 */
export function Claude2WindowList({ lines, className = "" }: { lines: readonly DecisionMetaCell[]; className?: string }) {
  return (
    <dl aria-label="계좌2 결정 창" className={`grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-3 ${className}`}>
      {lines.map((line) => (
        <div key={line.key} className="min-w-0">
          <dt className="text-muted">{line.label}</dt>
          <dd className="tabular-nums text-bright">{line.value}</dd>
        </div>
      ))}
    </dl>
  );
}
