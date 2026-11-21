"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { UnauthorizedError } from "@/lib/api";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";

/** 오류를 화면 문구로. Error가 아니면(드묾) 기본 문구를 씁니다. */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** 화면을 떠났는지. 떠난 뒤 끝난 요청의 결과는 버립니다. */
export function useMountedRef() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

/**
 * 버튼으로 서버를 부르는 동작 하나의 상태(진행 중·결과·오류).
 *
 * 화면마다 같은 `busy`/`result`/`error` 세 줄과 try/catch/finally를 반복하던 것을 모았습니다.
 *
 * @param action         실제로 부를 함수
 * @param failureMessage 오류가 Error가 아닐 때 보여 줄 문구
 * @returns `{ run, busy, result, error }`
 *   - run: 부르기. 시작할 때 오류를 지우고, 실패해도 앞서 받은 결과는 남깁니다. 성공하면 true, 실패하면 false를
 *     돌려줍니다 — 성공했을 때만 입력을 지우는 화면이 씁니다(QA-051)
 *   - 화면을 떠난 뒤 끝나면 상태를 바꾸지 않습니다
 *   - busy는 누른 단추의 `busy`(공용 Button — aria-disabled + 누름 무시)로 넘깁니다. `disabled`로 넘기면 누른 단추가 꺼져 크롬이 포커스를
 *     body로 보냅니다(QA-899). run 자체는 겹쳐 불러도 막지 않습니다 — 같은 동작을 줄마다 따로 부르는 화면이 있습니다(알림 '읽음' QA-863).
 */
export function useAsyncAction<Args extends unknown[], T>(
  action: (...args: Args) => Promise<T>,
  failureMessage: string,
) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useMountedRef();
  const { notifyUnauthorized } = useRefreshSignal();

  const run = useCallback(
    async (...args: Args): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        const value = await action(...args);
        if (mounted.current) setResult(value);
        return true;
      } catch (err) {
        // 세션이 끝났으면 화면 읽기(useApi)와 같이 로그인 화면으로 보냅니다 — 예전에는 배너만 떴습니다(QA-044).
        if (err instanceof UnauthorizedError) notifyUnauthorized();
        if (mounted.current) setError(errorMessage(err, failureMessage));
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [action, failureMessage, mounted, notifyUnauthorized],
  );

  return { run, busy, result, error };
}
