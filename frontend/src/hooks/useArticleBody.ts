"use client";

import { useCallback, useEffect, useState } from "react";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { errorMessage } from "@/hooks/useAsyncAction";
import { apiPost, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import type { SearchArticleResponse } from "@/lib/types";

/**
 * 다시 묻는 간격(밀리초)과 받는 중일 때 다시 묻는 횟수 상한(2초 × 35 ≈ 70초 — 서버 작업 상한 60초보다 조금 길게) — 그 뒤에는 멈추고 '다시 확인'
 * 단추를 둡니다. 시험이 짧게 바꿔 끼우는 자리라 객체로 둡니다(부를 때 읽음).
 */
export const ARTICLE_POLLING = { intervalMs: 2_000, maxPolls: 35 };

/** 팝업의 단계 — 받는 중(처음 부름·다시 묻는 중)·받음·실패(사유)·멈춤(상한까지 받는 중). */
export type ArticlePhase = "loading" | "done" | "error" | "stalled";

/** retryLocked — 서버가 일시 실패에 다시 시도까지 남은 초(retryAfterSeconds)를 줬으면 그동안 참('다시 시도'를 잠금). */
type ArticleState = { phase: ArticlePhase; response: SearchArticleResponse | null; failure: string | null; retryLocked: boolean };

const LOADING: ArticleState = { phase: "loading", response: null, failure: null, retryLocked: false };

/**
 * 본문 보기(POST /api/search/article — ADR 0043, 운영자 전용) 한 건의 상태. ref가 생기면(팝업이 열리면) 바로 부르고, 서버가 받는 중(pending)이면
 * {@link ARTICLE_POLLING}의 간격마다 같은 경로를 다시 부릅니다(상한 횟수 뒤에도 받는 중이면 멈춤 — stalled). ref가 null이 되거나(팝업을
 * 닫음) 화면을 떠나면 다시 묻기를 멈추고 늦게 온 응답은 버립니다. 세션이 끝났으면(401) 로그인 화면으로 보냅니다.
 *
 * @returns `{ phase, response, failure, retryLocked, reload }` — failure는 요청 자체가 실패한 글(서버 사유는 response의 reason·message),
 *   retryLocked는 서버가 준 retryAfterSeconds 동안 참, reload는 처음부터 다시(멈춘 뒤 '다시 확인'·실패 뒤 '다시 시도')
 */
export function useArticleBody(ref: string | null) {
  const { notifyUnauthorized } = useRefreshSignal();
  const [state, setState] = useState<ArticleState>(LOADING);
  const [round, setRound] = useState(0);
  const [shown, setShown] = useState({ ref, round });
  // ref·차례가 바뀌면 그린 차례에 '받는 중'으로(효과를 기다리면 앞 글의 결과가 한 번 그려짐).
  if (shown.ref !== ref || shown.round !== round) {
    setShown({ ref, round });
    setState(LOADING);
  }

  useEffect(() => {
    if (ref === null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unlock: ReturnType<typeof setTimeout> | null = null;
    let polls = 0;

    const ask = async () => {
      try {
        const response = await apiPost<SearchArticleResponse>(endpoints.search.article, { ref });
        if (cancelled) return;
        if (response?.available && response.status === "pending") {
          polls += 1;
          if (polls >= ARTICLE_POLLING.maxPolls) {
            setState({ phase: "stalled", response, failure: null, retryLocked: false });
            return;
          }
          setState({ phase: "loading", response, failure: null, retryLocked: false });
          timer = setTimeout(() => void ask(), ARTICLE_POLLING.intervalMs);
          return;
        }
        const ok = response?.available === true && response.status === "ok" && !!response.article;
        const wait = !ok && response?.retryable ? (response.retryAfterSeconds ?? 0) : 0;
        setState({ phase: ok ? "done" : "error", response: response ?? null, failure: null, retryLocked: wait > 0 });
        if (wait > 0) {
          unlock = setTimeout(() => setState((current) => ({ ...current, retryLocked: false })), wait * 1000);
        }
      } catch (error: unknown) {
        if (cancelled) return;
        if (error instanceof UnauthorizedError) notifyUnauthorized();
        setState({ phase: "error", response: null, failure: errorMessage(error, "본문을 받지 못했습니다."), retryLocked: false });
      }
    };

    void ask();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      if (unlock !== null) clearTimeout(unlock);
    };
  }, [ref, round, notifyUnauthorized]);

  const reload = useCallback(() => setRound((value) => value + 1), []);

  return { ...state, reload };
}
