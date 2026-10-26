"use client";

import { useState } from "react";
import { Banner, Button, Card } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useElapsedSeconds } from "@/hooks/useElapsedSeconds";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import {
  claudeDecisionView,
  claudePreviewResultView,
  claudeStartPrompt,
  frameworkInfoOf,
  initialDecisionResultView,
  PAPER_SOURCES,
  prettyJson,
} from "@/lib/paper";
import type { PaperClaudePreviewResult, PaperFrameworkResponse, PaperInitialDecisionResult, PaperOverviewResponse } from "@/lib/types";
import { ClaudeDecisionBody } from "./ClaudeDecisionBody";

/** 확인 단계 — 어느 버튼의 확인을 열었는지. */
type Confirming = "preview" | "start" | null;

/**
 * 개요의 Claude 책 시작 — Claude 책이 시작 전이면 카드(미리보기·시작), 시작한 뒤에는 시작 결과만 남깁니다.
 *
 * 두 버튼 모두 Claude를 한 번 부르므로(비용·하루 호출 상한) 확인 단계를 한 번 거치고, 확인 문구에 비용 안내를 적습니다.
 * 미리보기는 POST run/initial-decision `{book, preview:true}` — 호출·검증만 하고 장부·결정 기록에 쓰지 않습니다. 시작은 `{book}` —
 * 통과한 주문을 출발일 종가로 사후 체결하고 책을 운용 중으로 바꿉니다(성공하면 onChanged로 개요를 다시 읽어 카드가 사라짐).
 *
 * 이 컴포넌트는 카드가 사라진 뒤에도 그려져 있어야 시작 결과가 남습니다 — 그래서 시작 전이 아니면 결과만 그리고 끝냅니다.
 *
 * 카드의 프레임 안내(임시 판이면 OS 원문으로 사용자 판을 만든 뒤 시작을 권함)는 지금 판을 읽어 씁니다 — 개요 응답에 지금 판이 없어
 * 카드를 보일 때만 GET /api/paper/framework를 한 번 읽습니다(읽는 중·실패면 안내가 판을 단정하지 않음).
 */
export function ClaudeStartSection({ overview, onChanged }: { overview: PaperOverviewResponse; onChanged: () => void }) {
  const showing = claudeStartPrompt(overview) !== null;
  const framework = useApi<PaperFrameworkResponse>(showing ? endpoints.paper.framework : null);
  const prompt = claudeStartPrompt(overview, framework.data?.available ? frameworkInfoOf(framework.data.current) : null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const preview = useAsyncAction(
    (book: string) => apiPost<PaperClaudePreviewResult>(endpoints.paper.runInitialDecision, { book, preview: true }),
    "미리보기를 하지 못했습니다.",
  );
  const start = useAsyncAction(
    (book: string) => apiPost<PaperInitialDecisionResult>(endpoints.paper.runInitialDecision, { book }),
    "Claude 계좌를 시작하지 못했습니다.",
  );
  const previewElapsed = useElapsedSeconds(preview.busy);
  const startElapsed = useElapsedSeconds(start.busy);
  const busy = preview.busy || start.busy;

  const label = prompt?.bookLabel
    ?? (overview.books ?? []).find((book) => book.kind === "CLAUDE")?.label
    ?? "Claude 계좌";
  const startView = start.result ? initialDecisionResultView(start.result, label) : null;
  const startResult = startView && <Banner tone={startView.tone}>{startView.text}</Banner>;

  if (!prompt) return startResult || null;

  const runPreview = async () => {
    await preview.run(prompt.bookCode);
    // 성공·실패 모두 확인 단계를 닫습니다 — 실패 사유는 아래 경고로 남고, 다시 부르려면 확인을 한 번 더 거칩니다.
    setConfirming(null);
  };
  const runStart = async () => {
    const ok = await start.run(prompt.bookCode);
    setConfirming(null);
    if (ok) onChanged();
  };

  const previewView = preview.result ? claudePreviewResultView(preview.result) : null;
  const previewBody = preview.result
    ? claudeDecisionView({
      book: "claude",
      status: preview.result.status,
      response: preview.result.response,
      validation: preview.result.validation,
      usage: preview.result.usage,
      model: preview.result.model,
    })
    : null;
  const previewPacket = preview.result ? prettyJson(preview.result.packet) : null;

  return (
    <Card title={prompt.title} subtitle="초기 결정 — 출발일 기준 입력 패킷 · 출발일 종가 사후 체결" source={PAPER_SOURCES.decisions}>
      <p className="text-sm leading-relaxed text-body">{prompt.body}</p>
      <div className="mt-3">
        <Banner tone={prompt.framework.tone}>{prompt.framework.text}</Banner>
      </div>
      <p className="mt-2 text-xs text-muted">비용: {prompt.cost}</p>

      {confirming ? (
        <div className="mt-3 flex flex-col gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-3">
          <p className="text-sm leading-relaxed text-warn">{confirming === "preview" ? prompt.confirmPreview : prompt.confirmStart}</p>
          <div className="flex flex-wrap items-center gap-2">
            {confirming === "preview" ? (
              <Button variant="primary" onClick={() => void runPreview()} disabled={busy}>
                {preview.busy ? `미리보기 중… ${previewElapsed}초` : "미리보기 확인"}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void runStart()} disabled={busy}>
                {start.busy ? `시작 중… ${startElapsed}초` : "시작 확인"}
              </Button>
            )}
            <Button onClick={() => setConfirming(null)} disabled={busy}>취소</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button onClick={() => setConfirming("preview")} disabled={busy}>미리보기</Button>
          <Button variant="primary" onClick={() => setConfirming("start")} disabled={busy}>{prompt.title}</Button>
        </div>
      )}

      {/* 서버 문구(이미 시작함·호출 상한·키 없음 등)를 그대로 — 무엇을 해야 하는지 서버가 적어 보냅니다. */}
      {preview.error && <div className="mt-3"><Banner tone="warn">{preview.error}</Banner></div>}
      {start.error && <div className="mt-3"><Banner tone="warn">{start.error}</Banner></div>}
      {startResult && <div className="mt-3">{startResult}</div>}

      {previewView && (
        <section aria-label="미리보기 결과" className="mt-4 flex flex-col gap-3 border-t border-border pt-3">
          <Banner tone={previewView.tone}>{previewView.text}</Banner>
          {previewBody && <ClaudeDecisionBody view={previewBody} />}
          {previewPacket && (
            <details className="rounded-md border border-border px-3 py-2 text-xs">
              <summary className="cursor-pointer text-muted">입력 패킷(JSON)</summary>
              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px] text-body">{previewPacket}</pre>
            </details>
          )}
        </section>
      )}
    </Card>
  );
}
