"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { apiPost, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { summaryErrorText, summaryRequestKey, summaryUnavailableText } from "@/lib/infoSearch";
import type { SearchSummaryRequest, SearchSummaryResponse } from "@/lib/types";

/** 요약 패널의 단계 — 누르기 전·읽는 중·받음·실패. */
export type SummaryPhase = "idle" | "loading" | "done" | "error";

type SummaryOutcome = { phase: "done"; response: SearchSummaryResponse } | { phase: "error"; error: string };

/** 이 화면(브라우저 탭)에서 보낸 마지막 요약 요청 — 열쇠(대상·탭·기간), 차례 번호, 결과(읽는 중이면 null). */
type SummarySlot = { key: string; seq: number; outcome: SummaryOutcome | null };

/*
 * 서버는 요약을 한 번에 하나만 만듭니다(다른 요약을 만드는 중이면 429 — 엔진 시간 상한이 길어 그 창이 짧지 않음). 그래서 화면도 앞 요청이
 * 끝나기 전에는 새로 보내지 않습니다. 이 상태는 결과 칸(FeedPanel)이 아니라 모듈에 둡니다 — 탭·대상을 바꾸면 결과 칸이 새로 그려져도
 * 읽는 중인 요청을 잊지 않게(잊으면 다시 누른 요청이 429로 실패). 끝난 결과도 여기 두지만, 화면은 그 요청이 읽는 중일 때 그 열쇠를 보고
 * 있던 훅만 결과를 보입니다(대상·탭·기간을 바꾸면 패널을 비움 — 다른 열쇠에 가 있는 동안 끝난 요약은 돌아와도 보이지 않음).
 */
let slot: SummarySlot | null = null;
let lastSeq = 0;
const listeners = new Set<() => void>();

function publish(next: SummarySlot | null): void {
  slot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const readSlot = (): SummarySlot | null => slot;
const readNoSlot = (): SummarySlot | null => null;

/** 시험이 모듈의 기억을 지웁니다(끝나지 않은 앞 시험의 요청은 끝나도 여기 쓰지 않음 — 같은 차례인지 객체로 봄). */
export function resetSummaryRequestsForTest(): void {
  publish(null);
}

/** 이 훅이 보고 있는 요청 — 열쇠가 바뀌면 비웁니다. skip은 닫은 요청(읽는 중에 닫으면 그 응답을 다시 잡지 않게). */
type SummaryView = { key: string | null; seq: number | null; skip: number | null };

/**
 * 정보 검색 AI 요약(POST /api/search/summary — 계약 §9-6, 운영자 전용). 누를 때만 부르고(유료일 수 있는 호출), 앞 요청이 끝나기 전에는
 * 열쇠와 상관없이 새로 보내지 않습니다(busy — 서버가 한 번에 하나만 만듦). 대상·탭·기간(request)이 바뀌면 패널을 비우고, 읽는 중인 요청의
 * 열쇠로 돌아오면 읽는 중으로 보이고 그 응답을 받습니다. 수집기·엔진에 닿지 못한 응답(available:false)과 요청 실패는 실패 글이고,
 * 세션이 끝났으면(401) 로그인 화면으로 보냅니다.
 *
 * request가 null이면(운영자가 아님·결과를 받지 못함) 부르지 않습니다. 요약은 화면에만 보이고 저장하지 않습니다(모의 매매 입력 아님).
 */
export function useInfoSearchSummary(request: SearchSummaryRequest | null) {
  const { notifyUnauthorized } = useRefreshSignal();
  const key = request ? summaryRequestKey(request) : null;
  const current = useSyncExternalStore(subscribe, readSlot, readNoSlot);
  const [view, setView] = useState<SummaryView>({ key, seq: null, skip: null });
  // 열쇠가 바뀌면 그린 차례에 비우고(효과를 기다리면 앞 기간의 요약이 한 번 그려짐), 이 열쇠의 요청이 읽는 중이면 잡습니다
  // (누른 직후·읽는 중에 그 기간·탭으로 돌아왔을 때). 끝난 요청은 잡지 않습니다 — 읽는 동안 보고 있던 훅만 결과를 보임.
  let next = view.key === key ? view : { key, seq: null, skip: null };
  if (key !== null && current !== null && current.outcome === null && current.key === key && next.seq !== current.seq && next.skip !== current.seq) {
    next = { ...next, seq: current.seq };
  }
  if (next !== view) setView(next);

  const e = request?.e ?? null;
  const tab = request?.tab ?? null;
  const range = request?.range ?? null;

  const summarize = useCallback(async () => {
    if (e === null || tab === null || range === null) return;
    if (readSlot()?.outcome === null) return; // 앞 요청이 아직 읽는 중(이 열쇠든 다른 열쇠든)
    const body: SearchSummaryRequest = { e, tab, range };
    lastSeq += 1;
    const mine: SummarySlot = { key: summaryRequestKey(body), seq: lastSeq, outcome: null };
    publish(mine);
    let outcome: SummaryOutcome;
    try {
      const response = await apiPost<SearchSummaryResponse>(endpoints.search.summary, body);
      outcome = response?.available
        ? { phase: "done", response }
        : { phase: "error", error: summaryUnavailableText(response ?? {}) };
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError) notifyUnauthorized();
      outcome = { phase: "error", error: summaryErrorText(error) };
    }
    // 화면을 떠났어도 씁니다(같은 열쇠로 다시 그린 화면이 읽는 중으로 기다림). 그 사이 지워졌으면(시험) 쓰지 않음.
    if (readSlot() === mine) publish({ ...mine, outcome });
  }, [e, tab, range, notifyUnauthorized]);

  /** 패널 닫기 — 비우고, 읽는 중이면 그 응답도 버립니다(끝날 때까지 새로 보내지 않는 것은 그대로). */
  const clear = useCallback(() => {
    setView({ key, seq: null, skip: readSlot()?.seq ?? null });
  }, [key]);

  const shown = key !== null && current !== null && current.key === key && current.seq === next.seq ? current : null;
  const outcome = shown?.outcome ?? null;
  return {
    phase: (shown === null ? "idle" : (outcome?.phase ?? "loading")) as SummaryPhase,
    response: outcome?.phase === "done" ? outcome.response : null,
    error: outcome?.phase === "error" ? outcome.error : null,
    /** 앞서 보낸 요약이 아직 끝나지 않음 — 이 열쇠든 다른 열쇠든 새로 보내지 않음(단추를 잠금). */
    busy: current !== null && current.outcome === null,
    summarize,
    clear,
  };
}
