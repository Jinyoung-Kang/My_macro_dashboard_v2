"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGetShared, UnauthorizedError } from "@/lib/api";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";

interface State<T> {
  data: T | null;
  /** data를 받아 온 경로. 경로가 바뀐 뒤의 실패에 이전 경로의 값을 남기지 않으려고 씁니다. */
  dataPath: string | null;
  loading: boolean;
  /** 보여 줄 값이 없을 때의 오류. 화면은 이것이 있으면 오류 화면을 그립니다. */
  error: string | null;
  /** 값은 있는데 다시 읽기가 실패했을 때의 오류. 값은 그대로 두고 이것만 채웁니다. */
  refreshError: string | null;
  unauthorized: boolean;
  /** 이 브라우저가 마지막으로 응답을 받은 시각. 자동 갱신이 돌고 있는지 화면에 보이려고 씁니다. */
  loadedAt: Date | null;
}

const EMPTY_STATE = {
  data: null,
  dataPath: null,
  loading: false,
  error: null,
  refreshError: null,
  unauthorized: false,
  loadedAt: null,
} as const;

/**
 * 백엔드 GET 요청 훅.
 *
 * @param path      API 경로(lib/endpoints). **null이면 요청하지 않습니다**(조건부 조회에 씁니다)
 * @param refreshMs 자동 갱신 주기(ms). 0이면 갱신하지 않습니다
 * @returns `{ data, loading, error, unauthorized, loadedAt, reload }`
 *
 * 알아 둘 것
 * - 경로가 바뀌면 **이전 요청의 결과를 버립니다**. 느린 응답이 나중에 도착해 화면을
 *   되돌리는 문제를 막습니다. 같은 경로를 동시에 읽는 다른 컴포넌트가 있으면 요청은
 *   한 번만 나가고 결과를 함께 씁니다(lib/sharedRequest).
 * - 이미 값이 있는데 다시 읽기가 실패하면 **값을 지우지 않습니다**. 자동 갱신 중 한 번의
 *   일시 오류로 화면 전체가 오류 화면으로 바뀌던 문제가 있었습니다. 실패는
 *   `refreshError`로 알리고, 값의 수집 시각은 화면의 신선도 배지가 이미 보여 줍니다.
 * - 자동 갱신은 **탭을 보고 있을 때만** 돕니다. 숨으면 멈추고, 돌아오면 즉시 한 번
 *   읽고 다시 겁니다.
 * - 셸의 "데이터 수동 새로고침"(왼쪽 내비, 좁은 화면은 더보기)이 끝나면 공용 신호가 바뀌어 이 훅을 쓰는
 *   모든 화면이 스스로 다시 읽습니다.
 * - 401이면 `unauthorized`가 서고 `data`는 null이 됩니다.
 * - `options.timeoutMs`를 주면 그 시간 안에 응답이 없을 때 오류로 끝냅니다.
 *   주지 않으면 기다립니다(외부 API를 부르는 진단 화면은 오래 걸리는 게 정상).
 * - `options.followRefresh: false`면 수동 새로고침 신호에 반응하지 않습니다. 세션 확인이
 *   그렇습니다 — 새로고침마다 세션을 다시 확인하면 레이아웃이 "세션을 확인하는 중…"으로
 *   바뀌며 화면 전체가 다시 그려지고, 고른 옵션 같은 화면 상태가 초기화됐습니다.
 */
export function useApi<T>(
  path: string | null,
  refreshMs = 0,
  options: { timeoutMs?: number; followRefresh?: boolean } = {},
) {
  const timeoutMs = options.timeoutMs ?? 0;
  const { token, notifyUnauthorized } = useRefreshSignal();
  const refreshToken = options.followRefresh === false ? 0 : token;
  const [state, setState] = useState<State<T>>({ ...EMPTY_STATE, loading: Boolean(path) });

  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!path) {
      setState({ ...EMPTY_STATE });
      return;
    }

    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;

    setState((previous) => ({ ...previous, loading: true, error: null }));

    try {
      const data = await apiGetShared<T>(path, timeoutMs);
      if (controller.signal.aborted) {
        return;   // 그 사이 경로가 바뀌었거나 화면을 떠났습니다
      }
      setState({ ...EMPTY_STATE, data, dataPath: path, loadedAt: new Date() });
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      if (error instanceof UnauthorizedError) {
        setState({ ...EMPTY_STATE, unauthorized: true });
        // 세션이 만료되면(12시간, 다른 탭에서 로그아웃) 레이아웃이 로그인으로 보내게 알립니다.
        // 예전에는 아무 화면도 이 값을 읽지 않아 "수집기를 실행하세요"라는 틀린 안내만 남았습니다.
        notifyUnauthorized();
        return;
      }
      const message = error instanceof Error ? error.message : "알 수 없는 오류";
      setState((previous) =>
        previous.data !== null && previous.dataPath === path
          ? { ...previous, loading: false, error: null, refreshError: message }
          : { ...EMPTY_STATE, error: message },
      );
    }
    // refreshToken은 값 자체를 쓰지 않습니다. 바뀌면 load가 새로 만들어지고,
    // 아래 effect가 다시 돌아 화면이 갱신됩니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, refreshToken, timeoutMs, notifyUnauthorized]);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  // 탭을 백그라운드에 두면 브라우저가 타이머를 늦추기도 하지만, 그보다 큰 문제는
  // 아무도 보지 않는 화면 때문에 백엔드가 수집기를 계속 깨운다는 것입니다.
  // 매크로 화면은 10초 간격을 고를 수 있어 이 낭비가 그대로 외부 API 호출이 됩니다.
  useEffect(() => {
    if (!refreshMs || refreshMs <= 0) {
      return;
    }

    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) {
        timer = setInterval(() => void load(), refreshMs);
      }
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void load();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === "visible") {
      start();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshMs, load]);

  // 경로가 바뀐 직후에는 이전 경로의 값을 내보내지 않습니다. 그대로 두면 응답이 올 때까지
  // KOSDAQ 행이 "KOSPI 외국인 순매수" 제목 아래 보이는 식으로, 새 라벨에 옛 숫자가 붙었습니다
  // (로딩 표시는 `loading && !data`라 뜨지 않음). 같은 경로의 다시 읽기는 값을 유지합니다.
  const data = state.dataPath === path ? state.data : null;
  return { ...state, data, reload: load };
}
