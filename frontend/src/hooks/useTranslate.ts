"use client";

import { useCallback, useRef, useState } from "react";
import { useAsyncAction, useMountedRef } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import type { TranslateResponse } from "@/lib/info";
import { createSharedFetcher } from "@/lib/sharedRequest";

/** `POST /api/info/translate`의 요청 본문 — 수집 글은 id로, 글 표에 없는 것(사건 뉴스·목록의 제목)은 글자로. */
export type TranslateRequest = { itemId: string } | { title?: string; text?: string };

const FAILED = "번역하지 못했습니다.";

/**
 * 진행 중인 같은 번역 요청(요청 본문이 같은 것)은 하나로 묶습니다(QA-410). 번역 중에 팝업을 닫았다 같은 글을 다시 열어 누르면 서버는 같은 글을
 * 한 번 더 번역했습니다(진행 중인 같은 글을 서버가 묶지 않음 — 유료 호출일 수 있음). 끝난 결과는 보관하지 않습니다(서버가 저장본으로 답함).
 */
const sharedTranslate = createSharedFetcher<TranslateResponse>((body) =>
  apiPost<TranslateResponse>(endpoints.info.translate, JSON.parse(body) as TranslateRequest));

/**
 * 번역 단추 하나의 상태(ADR 0037) — 정보 수집의 제목 옆 단추와 원문 팝업이 함께 씁니다. 서버 호출 단추의 공용 훅(`useAsyncAction`) 위에 얹어,
 * 세션이 끝난 뒤(401) 누르면 다른 단추처럼 로그인 화면으로 보냅니다(QA-410).
 *
 * @returns `{ translate, busy, translated, response, error }`
 *   - translate: 서버에 번역을 묻습니다. 시작할 때 오류를 지웁니다. 받은 응답(요청이 실패했으면 null)을 돌려줍니다
 *   - translated: 쓸 번역(제목·본문·'이미 한국어')이 든 마지막 응답. 뒤의 요청이 아무것도 옮기지 못해도 앞서 받은 번역은 남습니다
 *   - response: 마지막으로 받은 응답(쓸 번역이 없어도)
 *   - error: 요청이 실패했거나 응답이 실패(`ok: false`)를 알렸을 때의 글
 */
export function useTranslate() {
  const [translated, setTranslated] = useState<TranslateResponse | null>(null);
  const [rejected, setRejected] = useState<string | null>(null);
  const mounted = useMountedRef();
  // useAsyncAction의 run은 성공 여부만 돌려줍니다. 부른 쪽이 받은 응답으로 다음 일을 정할 수 있게(팝업이 번역 보기로 바꿈) 따로 들고 있습니다.
  const received = useRef<TranslateResponse | null>(null);
  const post = useCallback(async (request: TranslateRequest) => {
    const result = await sharedTranslate(JSON.stringify(request));
    received.current = result;
    return result;
  }, []);
  const { run, busy, result: response, error } = useAsyncAction(post, FAILED);

  const translate = useCallback(
    async (request: TranslateRequest): Promise<TranslateResponse | null> => {
      setRejected(null);
      received.current = null;
      // (바로 위에서 null로 비워 타입이 null로 좁혀져 있습니다 — run 안의 post가 다시 채웁니다.)
      const result = (await run(request)) ? (received.current as TranslateResponse | null) : null;
      if (!result || !mounted.current) return result;
      if (!result.ok) setRejected(result.error ?? FAILED);
      if (result.textKo || result.titleKo || result.alreadyKorean) setTranslated(result);
      return result;
    },
    [mounted, run],
  );

  return { translate, busy, translated, response, error: error ?? rejected };
}
