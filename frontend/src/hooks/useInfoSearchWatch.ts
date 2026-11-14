"use client";

import { useCallback, useState } from "react";
import { useApi } from "@/hooks/useApi";
import { useMountedRef } from "@/hooks/useAsyncAction";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { apiDelete, apiPost, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { writeErrorText, type ExcludeDraft } from "@/lib/infoSearch";
import type { SearchExcludesResponse, SearchWatchResponse } from "@/lib/types";

/**
 * 정보 검색 단계 3(계약 §6-4)의 쓰기 훅 — 관심 대상(목록·등록·해제·봤음)과 매체 제외 목록(읽기·운영자의 더하기·지우기).
 * 규칙(대표 키·새 글 수·더할 값 다듬기·실패 문구)은 lib/infoSearch, 여기서는 요청과 다시 읽기만 잇습니다.
 */

/** 쓰기 하나를 부르고(진행 중·실패 문구), 성공하면 목록을 다시 읽습니다. 화면을 떠난 뒤 끝나면 상태를 바꾸지 않습니다. */
function useWrite(reload: () => Promise<void> | void, conflict: string) {
  const { notifyUnauthorized } = useRefreshSignal();
  const mounted = useMountedRef();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (work: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      setError(null);
      try {
        await work();
        await reload();
        return true;
      } catch (failure: unknown) {
        if (failure instanceof UnauthorizedError) notifyUnauthorized();
        if (mounted.current) setError(writeErrorText(failure, conflict));
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [reload, conflict, mounted, notifyUnauthorized],
  );

  return { run, busy, error, setError };
}

/**
 * 내 관심 대상(GET /api/search/watch)과 등록·해제·봤음. enabled가 false면(데모 열람 — 등록하지 못함) 부르지 않습니다.
 * 등록·해제가 끝나면 목록을 다시 읽어 머리의 단추와 왼쪽 칸이 같은 값을 보입니다. 상한(409)은 서버가 준 사유를 그대로 error에 둡니다.
 */
export function useInfoSearchWatch(enabled: boolean) {
  const list = useApi<SearchWatchResponse>(enabled ? endpoints.search.watch : null);
  const { reload } = list;
  const write = useWrite(reload, "관심 대상 상한을 넘었습니다");
  const { notifyUnauthorized } = useRefreshSignal();
  const { run, setError } = write;

  const add = useCallback((key: string) => run(() => apiPost(endpoints.search.watch, { key })), [run]);
  /** 앞 대상에서 난 실패 문구를 지웁니다(다른 대상을 열 때 — 그 대상의 단추 밑에 남지 않게). */
  const clearActionError = useCallback(() => setError(null), [setError]);
  const remove = useCallback((id: number) => run(() => apiDelete(endpoints.search.watchItem(id))), [run]);

  /** 그 대상을 지금 봤다고 적고(새 글 수 0) 목록을 다시 읽습니다. 실패해도 화면을 막지 않습니다 — 새 글 수가 늦게 줄 뿐입니다. */
  const seen = useCallback(
    async (id: number) => {
      try {
        await apiPost(endpoints.search.watchSeen(id));
        await reload();
      } catch (failure: unknown) {
        if (failure instanceof UnauthorizedError) notifyUnauthorized();
      }
    },
    [reload, notifyUnauthorized],
  );

  return {
    enabled,
    data: list.data,
    loading: list.loading,
    error: list.error,
    reload,
    add,
    remove,
    seen,
    busy: write.busy,
    actionError: write.error,
    clearActionError,
  };
}

export type InfoSearchWatch = ReturnType<typeof useInfoSearchWatch>;

/**
 * 매체 제외 목록(GET /api/search/excludes — 회원 읽기)과 운영자의 더하기·지우기. open이 false면 부르지 않습니다(펼칠 때만 읽음).
 */
export function useInfoSearchExcludes(open: boolean) {
  const list = useApi<SearchExcludesResponse>(open ? endpoints.search.excludes : null);
  const write = useWrite(list.reload, "이미 목록에 있습니다");
  const { run } = write;

  const add = useCallback(
    (draft: Extract<ExcludeDraft, { ok: true }>["body"]) => run(() => apiPost(endpoints.search.excludes, draft)),
    [run],
  );
  const remove = useCallback((id: number) => run(() => apiDelete(endpoints.search.exclude(id))), [run]);

  return {
    data: list.data,
    loading: list.loading,
    error: list.error,
    reload: list.reload,
    add,
    remove,
    busy: write.busy,
    actionError: write.error,
    setActionError: write.setError,
  };
}
