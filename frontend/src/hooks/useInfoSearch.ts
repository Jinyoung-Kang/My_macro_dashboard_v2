"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { useApi } from "@/hooks/useApi";
import { useMountedRef } from "@/hooks/useAsyncAction";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { apiGet, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import {
  feedRefreshMs,
  isEntityKey,
  isSlashShortcut,
  parseSearchUrl,
  searchHref,
  type SearchTabKey,
} from "@/lib/infoSearch";
import type { SearchCandidate, SearchFeedResponse, SearchRange, SearchSuggestResponse } from "@/lib/types";

/**
 * 정보 검색(/search — ADR 0041) 화면의 훅. 규칙은 lib/infoSearch(순수 함수), 여기서는 주소·요청·키보드만 잇습니다.
 */

/**
 * 주소가 화면 상태(계약 §5) — `?q=`(후보 보기) 또는 `?e=&tab=&range=`. 새로고침·뒤로 가기·북마크가 같은 화면이 되게 합니다.
 * 대상·검색어를 바꾸면 기록에 쌓고(pushState — 뒤로 가기), 탭·기간은 바꿔 씁니다(replaceState). Next(앱 라우터)는 이 두 함수를
 * 라우터에 이어 useSearchParams를 바꾸므로, 다른 화면에서 /search?q=로 온 이동(통합 검색 등)도 같은 길로 읽힙니다.
 * useSearchParams를 쓰므로 라우트(page.tsx)가 Suspense로 감쌉니다(정적 빌드 조건).
 */
export function useInfoSearchUrl() {
  const params = useSearchParams();
  const state = useMemo(() => parseSearchUrl(params), [params]);

  const go = useCallback((href: string, mode: "push" | "replace") => {
    if (mode === "push") window.history.pushState(null, "", href);
    else window.history.replaceState(null, "", href);
  }, []);

  const openEntity = useCallback(
    (key: string) => {
      if (isEntityKey(key)) go(searchHref({ e: key }), "push");
    },
    [go],
  );
  /** 자동으로 연 대상 — 후보 보기(?q=) 자리를 바꿔 씁니다. 쌓으면 뒤로 가기가 그 후보 보기로 가서 다시 자동으로 열립니다. */
  const replaceEntity = useCallback(
    (key: string) => {
      if (isEntityKey(key)) go(searchHref({ e: key }), "replace");
    },
    [go],
  );
  const openQuery = useCallback((q: string) => go(searchHref({ q }), "push"), [go]);
  const setTab = useCallback(
    (tab: SearchTabKey) => {
      if (state.e) go(searchHref({ e: state.e, tab, range: state.range }), "replace");
    },
    [go, state.e, state.range],
  );
  const setRange = useCallback(
    (range: SearchRange) => {
      if (state.e) go(searchHref({ e: state.e, tab: state.tab, range }), "replace");
    },
    [go, state.e, state.tab],
  );

  return { state, openEntity, replaceEntity, openQuery, setTab, setRange };
}

/** 치는 동안 묻기 전에 기다리는 시간 — 글자마다 묻지 않게. 후보는 수집기가 가진 색인만 찾습니다(외부 호출 없음). */
export const SUGGEST_DEBOUNCE_MS = 200;
const SUGGEST_MAX_CHARS = 60;

type SuggestState = { query: string; items: SearchCandidate[]; error: string | null; message: string | null };

/**
 * 치는 동안의 후보(GET /api/search/suggest). 입력이 멈춘 뒤 한 번 묻고, 검색어가 바뀌면 앞 요청을 취소합니다(AbortController).
 * 지금 검색어의 응답만 내보냅니다 — 앞 검색어의 후보가 새 검색어 아래 남지 않게.
 */
export function useInfoSearchSuggest(query: string, enabled: boolean) {
  const { notifyUnauthorized } = useRefreshSignal();
  const trimmed = Array.from(query.trim()).slice(0, SUGGEST_MAX_CHARS).join("").trim();
  const active = enabled && trimmed.length > 0;
  const [state, setState] = useState<SuggestState>({ query: "", items: [], error: null, message: null });

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      apiGet<SearchSuggestResponse>(endpoints.search.suggest(trimmed), controller.signal)
        .then((data) => {
          if (controller.signal.aborted) return;
          setState({
            query: trimmed,
            items: data?.available ? (data.items ?? []) : [],
            error: null,
            message: data?.available ? null : (data?.message ?? "후보를 받지 못했습니다."),
          });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          if (error instanceof UnauthorizedError) notifyUnauthorized();
          setState({ query: trimmed, items: [], error: error instanceof Error ? error.message : "알 수 없는 오류", message: null });
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, trimmed, notifyUnauthorized]);

  const current = active && state.query === trimmed;
  return {
    query: trimmed,
    items: current ? state.items : [],
    error: current ? state.error : null,
    message: current ? state.message : null,
    loading: active && !current,
  };
}

type FreshFeed = { path: string; data: SearchFeedResponse; at: number };

/**
 * 결과(GET /api/search/feed) — 대상·탭마다 한 번(2년 묶음). 받는 중인 출처가 있으면(pending — 단계 5의 Finviz) 몇 초 뒤 다시 읽고,
 * 다 받으면 멈춥니다. 기간은 화면이 자르므로 다시 부르지 않습니다.
 *
 * refreshPath를 주면 '지금 새로 받기'(계약 §6-4 — `refresh=1`, 캐시를 건너뜀, 사용자당 10분에 1번)를 쓸 수 있습니다. 새로 받은 응답은
 * 그 뒤의 보통 읽기(받는 중 다시 읽기·수동 새로고침)가 올 때까지 보이고, 그 읽기는 서버 캐시(방금 새로 받은 것)를 줍니다.
 * 새로 받기는 그 단추를 누를 때 한 번뿐이고 다시 읽기·새로고침 신호로 되풀이되지 않습니다(외부 호출 상한).
 * 새로 받기가 수집기에 닿지 못하면(available:false) 보이던 묶음을 그대로 두고 refreshError에 사유를 둡니다.
 */
export function useInfoSearchFeed(path: string | null, refreshPath: string | null = null) {
  const [pollMs, setPollMs] = useState(0);
  const feed = useApi<SearchFeedResponse>(path, pollMs);
  const { notifyUnauthorized } = useRefreshSignal();
  const mounted = useMountedRef();
  const [fresh, setFresh] = useState<FreshFeed | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const loadedAt = feed.loadedAt?.getTime() ?? null;
  const freshShown = fresh !== null && fresh.path === path && (loadedAt === null || fresh.at >= loadedAt) ? fresh : null;
  const data = freshShown ? freshShown.data : feed.data;

  const wanted = feedRefreshMs(data);
  useEffect(() => {
    setPollMs(wanted);
  }, [wanted]);

  const refresh = useCallback(async () => {
    if (!path || !refreshPath) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const response = await apiGet<SearchFeedResponse>(refreshPath);
      if (!mounted.current) return;
      // 수집기에 닿지 못한 응답(available:false)은 보이던 묶음을 덮지 않고 실패로 알립니다 — 잘 보이던 결과가 사유 한 줄로 바뀌지 않게.
      if (response?.available) setFresh({ path, data: response, at: Date.now() });
      else setRefreshError(response?.message ?? "수집기에서 응답을 받지 못했습니다.");
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError) notifyUnauthorized();
      if (mounted.current) setRefreshError(error instanceof Error ? error.message : "알 수 없는 오류");
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [path, refreshPath, mounted, notifyUnauthorized]);

  return {
    ...feed,
    data,
    refresh,
    refreshing,
    refreshError,
    /** 이번 화면에서 새로 받은 응답(보이는 중일 때만) — '새로 받았습니다' 한 줄에 씁니다. */
    refreshed: freshShown?.data ?? null,
  };
}

/**
 * '/'로 검색창에 갑니다(이 화면이 떠 있는 동안만). 다른 입력칸·편집 영역·대화상자 안·한글 조합 중·수식키와 함께면 그대로 둡니다 —
 * 상단 통합 검색의 ⌘K/Ctrl+K와 겹치지 않습니다.
 */
export function useSlashShortcut(target: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSlashShortcut(event)) return;
      const input = target.current;
      if (!input) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target]);
}
