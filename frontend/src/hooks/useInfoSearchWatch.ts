"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useApi } from "@/hooks/useApi";
import { useMountedRef } from "@/hooks/useAsyncAction";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { apiDelete, apiPatch, apiPost, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { writeErrorText, type ExcludeDraft } from "@/lib/infoSearch";
import type { SearchExcludesResponse, SearchWatchPatch, SearchWatchResponse } from "@/lib/types";

/**
 * 정보 검색 단계 3(계약 §6-4)의 쓰기 훅 — 관심 대상(목록·등록·해제·봤음, 단계 6 묶음 2의 별칭·알림 고치기 — §9-4·9-5)과
 * 매체 제외 목록(읽기·운영자의 더하기·지우기).
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

/** 알림 단추를 누른 자리 — 실패 문구를 그 자리에만 보입니다(목록 줄과 대상 머리가 함께 보여도 두 번 읽히지 않게). */
export type NotifyFrom = "list" | "header";

/**
 * 내 관심 대상(GET /api/search/watch)과 등록·해제·봤음, 줄의 별칭·알림 고치기(PATCH — 단계 6 묶음 2). enabled가 false면(데모 열람 — 등록하지 못함)
 * 부르지 않습니다. 쓰기가 끝나면 목록을 다시 읽어 머리의 단추와 왼쪽 칸이 같은 값을 보입니다. 상한(409)은 서버가 준 사유를 그대로 error에 둡니다.
 * 등록·해제, 별칭, 알림은 진행 중·실패 상태를 따로 둡니다 — 별칭 저장 실패가 머리의 등록 단추 밑에 뜨지 않게.
 *
 * 쓰기 뒤 다시 읽기는 쓰기 전에 나간 목록 읽기(앞 쓰기·'봤음' 뒤의 다시 읽기)에 합류하지 않습니다 — 목록 읽기는 진행 중인 같은 GET을 함께 쓰므로
 * (lib/sharedRequest) 그대로 다시 읽으면 쓰기 전의 값(알림 '끔' 등)을 받습니다. 그래서 읽기가 진행 중이면 그것이 도착하기를 기다린 뒤 한 번 더 읽습니다.
 */
export function useInfoSearchWatch(enabled: boolean) {
  const list = useApi<SearchWatchResponse>(enabled ? endpoints.search.watch : null);
  const { reload, loading } = list;
  // 마지막으로 그린 때 목록 읽기가 진행 중이었는가 — 쓰기(사용자의 누름 뒤 응답까지 걸림)가 끝날 때에는 늘 지금 값입니다.
  const loadingRef = useRef(loading);
  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);
  /** 쓰기 뒤 다시 읽기 — 진행 중인 읽기(쓰기 전에 나간 것)가 있으면 먼저 받고, 그 뒤 새로 읽습니다(쓰기 뒤에 시작한 GET만 믿음). */
  const reloadAfterWrite = useCallback(async () => {
    if (loadingRef.current) await reload();
    await reload();
  }, [reload]);
  const write = useWrite(reloadAfterWrite, "관심 대상 상한을 넘었습니다");
  const aliasWrite = useWrite(reloadAfterWrite, "별칭을 저장하지 못했습니다");
  const notifyWrite = useWrite(reloadAfterWrite, "알림을 바꾸지 못했습니다");
  const [notifyAt, setNotifyAt] = useState<{ id: number; from: NotifyFrom } | null>(null);
  const { notifyUnauthorized } = useRefreshSignal();
  const { run, setError } = write;
  const { run: runAlias, setError: setAliasError } = aliasWrite;
  const { run: runNotify, setError: setNotifyError } = notifyWrite;

  const add = useCallback((key: string) => run(() => apiPost(endpoints.search.watch, { key })), [run]);
  /** 앞 대상에서 난 실패 문구(등록·별칭·알림)를 지웁니다(다른 대상을 열 때 — 그 대상의 단추 밑에 남지 않게). */
  const clearActionError = useCallback(() => {
    setError(null);
    setAliasError(null);
    setNotifyError(null);
  }, [setError, setAliasError, setNotifyError]);
  const remove = useCallback((id: number) => run(() => apiDelete(endpoints.search.watchItem(id))), [run]);

  /** 그 줄의 별칭을 바꿉니다(PATCH {aliases} — 다듬기·검사는 lib/infoSearch의 aliasesForSave를 거친 값). 성공하면 true(목록은 다시 읽은 뒤). */
  const saveAliases = useCallback(
    (id: number, aliases: string[]) => runAlias(() => apiPatch(endpoints.search.watchItem(id), { aliases } satisfies SearchWatchPatch)),
    [runAlias],
  );
  /** 편집을 그만둘 때 앞 저장 실패 문구를 지웁니다. */
  const clearAliasError = useCallback(() => setAliasError(null), [setAliasError]);

  /** 그 줄의 새 글 알림을 켜고 끕니다(PATCH {notify}). from = 누른 자리(실패 문구를 그 자리에만). 성공하면 true(목록은 다시 읽은 뒤). */
  const setNotify = useCallback(
    (id: number, notify: boolean, from: NotifyFrom) => {
      setNotifyAt({ id, from });
      return runNotify(() => apiPatch(endpoints.search.watchItem(id), { notify } satisfies SearchWatchPatch));
    },
    [runNotify],
  );

  /** 그 대상을 지금 봤다고 적고(새 글 수 0) 목록을 다시 읽습니다. 실패해도 화면을 막지 않습니다 — 새 글 수가 늦게 줄 뿐입니다. */
  const seen = useCallback(
    async (id: number) => {
      try {
        await apiPost(endpoints.search.watchSeen(id));
        await reloadAfterWrite();
      } catch (failure: unknown) {
        if (failure instanceof UnauthorizedError) notifyUnauthorized();
      }
    },
    [reloadAfterWrite, notifyUnauthorized],
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
    saveAliases,
    aliasBusy: aliasWrite.busy,
    aliasError: aliasWrite.error,
    clearAliasError,
    setNotify,
    /** 알림을 바꾸는 중인 줄의 번호(없으면 null) — 그동안 다른 알림 단추도 누르지 않게 합니다. */
    notifyBusyId: notifyWrite.busy ? (notifyAt?.id ?? null) : null,
    /** 알림 바꾸기 실패 — 누른 줄·자리와 사유. */
    notifyError: notifyWrite.error && notifyAt ? { ...notifyAt, message: notifyWrite.error } : null,
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
