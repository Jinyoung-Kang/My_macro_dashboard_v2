"use client";

import { useCallback, useState } from "react";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import type { TranslateResponse } from "@/lib/info";

/** `POST /api/info/translate`의 요청 본문 — 수집 글은 id로, 글 표에 없는 것(사건 뉴스·목록의 제목)은 글자로. */
export type TranslateRequest = { itemId: string } | { title?: string; text?: string };

const FAILED = "번역하지 못했습니다.";

/**
 * 번역 단추 하나의 상태(ADR 0037) — 정보 수집의 제목 옆 단추와 원문 팝업이 함께 씁니다.
 *
 * @returns `{ translate, busy, translated, response, error }`
 *   - translate: 서버에 번역을 묻습니다. 시작할 때 오류를 지웁니다
 *   - translated: 쓸 번역(제목·본문·'이미 한국어')이 든 마지막 응답. 뒤의 요청이 아무것도 옮기지 못해도 앞서 받은 번역은 남습니다
 *   - response: 마지막으로 받은 응답(쓸 번역이 없어도)
 *   - error: 요청이 실패했거나 응답이 실패(`ok: false`)를 알렸을 때의 글
 */
export function useTranslate() {
  const [translated, setTranslated] = useState<TranslateResponse | null>(null);
  const [response, setResponse] = useState<TranslateResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const translate = useCallback(async (request: TranslateRequest): Promise<TranslateResponse | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<TranslateResponse>(endpoints.info.translate, request);
      setResponse(result);
      if (!result.ok) setError(result.error ?? FAILED);
      if (result.textKo || result.titleKo || result.alreadyKorean) setTranslated(result);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : FAILED);
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  return { translate, busy, translated, response, error };
}
