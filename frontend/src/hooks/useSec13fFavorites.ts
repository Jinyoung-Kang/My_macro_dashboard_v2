"use client";

import { useCallback, useState } from "react";
import { useMountedRef } from "@/hooks/useAsyncAction";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { apiDelete, apiGet, apiPost, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { favoriteWriteError } from "@/lib/institutionFavorites";

/** 이름 검색 후보 — status는 이미 기본 12곳('default')·즐겨찾기('favorite')인지, name이 null이면 CIK로 넣은 줄(더할 때 서버가 SEC 이름을 확인). */
export type FavoriteCandidate = { cik: string; name: string | null; status: "default" | "favorite" | null };

export type FavoriteMessage = { tone: "ok" | "error"; text: string };

export type Sec13fFavoritesEditor = {
  busy: boolean;
  message: FavoriteMessage | null;
  setMessage: (message: FavoriteMessage | null) => void;
  search: (q: string) => Promise<FavoriteCandidate[] | null>;
  add: (body: { cik: string; displayName?: string; description?: string }) => Promise<boolean>;
  remove: (cik: string) => Promise<boolean>;
};

/**
 * 13F 즐겨찾기 편집(운영자, ADR 0048) — 이름 검색(GET, 누를 때만)·더하기(POST)·지우기(DELETE). 쓰기가 성공하면 `reload`(기관 목록)를 부릅니다 —
 * 목록 응답에 즐겨찾기가 함께 와서 두 거르기 목록이 같은 값을 봅니다. 화면을 떠난 뒤 끝나면 상태를 바꾸지 않습니다.
 */
export function useSec13fFavorites(reload: () => Promise<void> | void): Sec13fFavoritesEditor {
  const { notifyUnauthorized } = useRefreshSignal();
  const mounted = useMountedRef();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<FavoriteMessage | null>(null);

  const run = useCallback(
    async <T,>(work: () => Promise<T>, done?: (value: T) => FavoriteMessage | null): Promise<T | null> => {
      setBusy(true);
      setMessage(null);
      try {
        const value = await work();
        if (mounted.current) setMessage(done ? done(value) : null);
        return value;
      } catch (failure: unknown) {
        if (failure instanceof UnauthorizedError) notifyUnauthorized();
        if (mounted.current) setMessage({ tone: "error", text: favoriteWriteError(failure) });
        return null;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
    [mounted, notifyUnauthorized],
  );

  const search = useCallback(
    async (q: string) => {
      const found = await run(() => apiGet<{ candidates: FavoriteCandidate[] }>(endpoints.institution.favoriteSearch(q)));
      return found ? (found.candidates ?? []).map((row) => ({ cik: row.cik, name: row.name, status: row.status ?? null })) : null;
    },
    [run],
  );

  const add = useCallback(
    async (body: { cik: string; displayName?: string; description?: string }) => {
      const done = await run(
        () => apiPost<{ message?: string }>(endpoints.institution.favorites, body),
        (value) => ({ tone: "ok", text: value?.message ?? "즐겨찾기에 더했습니다." }),
      );
      if (done === null) return false;
      await reload();
      return true;
    },
    [run, reload],
  );

  const remove = useCallback(
    async (cik: string) => {
      const done = await run(
        () => apiDelete<{ message?: string }>(endpoints.institution.favorite(cik)),
        (value) => ({ tone: "ok", text: value?.message ?? "즐겨찾기에서 지웠습니다." }),
      );
      if (done === null) return false;
      await reload();
      return true;
    },
    [run, reload],
  );

  return { busy, message, setMessage, search, add, remove };
}
