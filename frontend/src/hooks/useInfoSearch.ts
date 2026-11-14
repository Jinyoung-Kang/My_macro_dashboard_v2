"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useApi } from "@/hooks/useApi";
import { useMountedRef } from "@/hooks/useAsyncAction";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { apiGet, apiGetShared, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import {
  FEED_PENDING_MAX_POLLS,
  FEED_PENDING_REFRESH_MS,
  feedPendingPhase,
  isEntityKey,
  isSlashShortcut,
  linksView,
  parseSearchUrl,
  searchHref,
  type SearchTabKey,
} from "@/lib/infoSearch";
import type {
  SearchCandidate,
  SearchEntity,
  SearchFeedResponse,
  SearchLinksResponse,
  SearchRange,
  SearchSuggestResponse,
} from "@/lib/types";

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

/** 보통 읽기 밖에서 받은 응답 — '지금 새로 받기'(refreshed)나 쓰기 뒤 다시 읽기(reloadAfterWrite). 그 뒤의 보통 읽기가 올 때까지 보입니다. */
type FreshFeed = { path: string; data: SearchFeedResponse; at: number; refreshed: boolean };

/**
 * 받는 중 다시 읽기의 상태 — base(지금 보이는 처음 읽기·새로 받기 응답의 시각) 뒤로 다시 읽은 횟수와 마지막으로 받은 응답.
 * 경로나 base가 바뀌면(대상·탭을 바꿈, 새로 받기, 셸의 수동 새로고침) 이 상태는 버려지고 횟수는 0부터 셉니다.
 */
type PendingPoll = { path: string; base: number; count: number; data: SearchFeedResponse | null };

/** '다시 확인'이 받지 못한 사유 — 누른 그 멈춤(같은 경로·같은 base)에만 보입니다. 새로 받기·대상·탭을 바꾼 뒤 다시 멈추면 앞의 실패를 끌어오지 않게. */
type RecheckError = { path: string; base: number; message: string };

/**
 * 결과(GET /api/search/feed) — 대상·탭마다 한 번(2년 묶음). 기간은 화면이 자르므로 다시 부르지 않습니다.
 *
 * 받는 중인 출처가 있으면(pending — 단계 5의 Finviz, 계약 §8-6) 같은 결과를 5초 뒤 다시 읽습니다. 앞 요청이 끝난 뒤에 다음을 걸어
 * 요청이 겹치지 않고, 최대 12번(1분) — 그 뒤에는 pendingPhase가 stalled이고 recheck('다시 확인')를 누를 때 한 번 읽습니다(아직이면 다시 12번).
 * 다시 읽는 동안 보이던 묶음은 그대로 두고 새 응답으로 바꿔 끼우며, 실패하거나 수집기에 닿지 못한 응답(available:false)은 보이던 묶음을 덮지 않고
 * 횟수만 셉니다. 탭이 숨어 있으면 보일 때까지 미룹니다. 경로가 바뀌거나 화면을 떠나면 걸어 둔 다시 읽기를 거두고 늦게 온 응답은 버립니다.
 *
 * refreshPath를 주면 '지금 새로 받기'(계약 §6-4 — `refresh=1`, 캐시를 건너뜀, 사용자당 10분에 1번)를 쓸 수 있습니다. 새로 받은 응답은
 * 그 뒤의 보통 읽기(받는 중 다시 읽기·수동 새로고침)가 올 때까지 보이고, 그 읽기는 서버 캐시(방금 새로 받은 것)를 줍니다.
 * 새로 받기는 그 단추를 누를 때 한 번뿐이고 다시 읽기·새로고침 신호로 되풀이되지 않습니다(외부 호출 상한).
 * 새로 받기가 수집기에 닿지 못하면(available:false) 보이던 묶음을 그대로 두고 refreshError에 사유를 둡니다.
 *
 * reloadAfterWrite는 쓰기(관심 대상 별칭 저장 — 계약 §9-4, 별칭이 검색어라 결과가 바뀜) 뒤 다시 읽기입니다. 보통 읽기는 진행 중인 같은 GET을 함께 쓰므로
 * (lib/sharedRequest) 쓰기 전에 나간 받는 중 다시 읽기·처음 읽기에 합류하면 옛 별칭의 결과를 받습니다. 그래서 공유하지 않는 GET으로 읽고 그 응답을
 * 새로 받기와 같은 자리에 보입니다('새로 받았습니다' 줄은 없음). 처음 읽기가 아직 오는 중이면 먼저 도착하게 기다립니다(뒤에 와서 새 응답을 덮지 않게).
 * 받는 중 다시 읽기는 기준(base)이 바뀌어 늦게 온 앞 응답을 버립니다. 받지 못하면(실패·available:false) 보이던 묶음 그대로입니다.
 */
export function useInfoSearchFeed(path: string | null, refreshPath: string | null = null) {
  const feed = useApi<SearchFeedResponse>(path);
  const { notifyUnauthorized } = useRefreshSignal();
  const mounted = useMountedRef();
  const [fresh, setFresh] = useState<FreshFeed | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [poll, setPoll] = useState<PendingPoll | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [recheckError, setRecheckError] = useState<RecheckError | null>(null);
  // 다시 그리기 전에 두 번 눌러도 한 번만 보내게(단추를 끄는 것은 다시 그린 뒤라).
  const recheckBusy = useRef(false);
  const { reload: reloadFeed, loading: feedLoading } = feed;
  // 마지막으로 그린 때 보통 읽기(처음 읽기·수동 새로고침)가 진행 중이었는가 — 쓰기 뒤 다시 읽기가 그것을 먼저 받게.
  const loadingRef = useRef(feedLoading);
  useEffect(() => {
    loadingRef.current = feedLoading;
  }, [feedLoading]);

  const loadedAt = feed.loadedAt?.getTime() ?? null;
  const freshShown = fresh !== null && fresh.path === path && (loadedAt === null || fresh.at >= loadedAt) ? fresh : null;
  const base = freshShown ? freshShown.at : (loadedAt ?? 0);
  const polled = poll !== null && poll.path === path && poll.base === base ? poll : null;
  const data = polled?.data ?? (freshShown ? freshShown.data : feed.data);
  const polls = polled?.count ?? 0;
  const pendingPhase = feedPendingPhase(data, polls);

  useEffect(() => {
    if (!path || pendingPhase !== "polling") return;
    let cancelled = false;
    const settle = (response: SearchFeedResponse | null, count: number) =>
      setPoll((previous) => ({
        path,
        base,
        count,
        // 받지 못한 다시 읽기는 보이던 묶음을 덮지 않습니다(앞서 다시 읽어 받은 것이 있으면 그것을 그대로).
        data: response?.available ? response : previous?.path === path && previous.base === base ? previous.data : null,
      }));
    const read = () => {
      if (document.visibilityState === "hidden") {
        document.addEventListener("visibilitychange", onVisible);
        return;
      }
      apiGetShared<SearchFeedResponse>(path)
        .then((response) => {
          if (!cancelled) settle(response, polls + 1);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          if (error instanceof UnauthorizedError) {
            notifyUnauthorized();
            settle(null, FEED_PENDING_MAX_POLLS);
          } else settle(null, polls + 1);
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "hidden") return;
      document.removeEventListener("visibilitychange", onVisible);
      read();
    };
    const timer = window.setTimeout(read, FEED_PENDING_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, base, polls, pendingPhase, notifyUnauthorized]);

  const recheck = useCallback(async () => {
    if (!path || recheckBusy.current) return;
    recheckBusy.current = true;
    setRechecking(true);
    setRecheckError(null);
    try {
      const response = await apiGetShared<SearchFeedResponse>(path);
      if (!mounted.current) return;
      // 받았으면 그 응답을 보이고 횟수를 0부터(아직 받는 중이면 다시 12번까지). 수집기에 닿지 못했으면 멈춘 그대로 사유만.
      if (response?.available) setPoll({ path, base, count: 0, data: response });
      else setRecheckError({ path, base, message: response?.message ?? "수집기에서 응답을 받지 못했습니다." });
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError) notifyUnauthorized();
      if (mounted.current) setRecheckError({ path, base, message: error instanceof Error ? error.message : "알 수 없는 오류" });
    } finally {
      recheckBusy.current = false;
      if (mounted.current) setRechecking(false);
    }
  }, [path, base, mounted, notifyUnauthorized]);

  const refresh = useCallback(async () => {
    if (!path || !refreshPath) return;
    setRefreshing(true);
    setRefreshError(null);
    try {
      const response = await apiGet<SearchFeedResponse>(refreshPath);
      if (!mounted.current) return;
      // 수집기에 닿지 못한 응답(available:false)은 보이던 묶음을 덮지 않고 실패로 알립니다 — 잘 보이던 결과가 사유 한 줄로 바뀌지 않게.
      if (response?.available) setFresh({ path, data: response, at: Date.now(), refreshed: true });
      else setRefreshError(response?.message ?? "수집기에서 응답을 받지 못했습니다.");
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError) notifyUnauthorized();
      if (mounted.current) setRefreshError(error instanceof Error ? error.message : "알 수 없는 오류");
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }, [path, refreshPath, mounted, notifyUnauthorized]);

  const reloadAfterWrite = useCallback(async () => {
    if (!path) return;
    if (loadingRef.current) await reloadFeed();
    try {
      const response = await apiGet<SearchFeedResponse>(path);
      if (mounted.current && response?.available) setFresh({ path, data: response, at: Date.now(), refreshed: false });
    } catch (error: unknown) {
      if (error instanceof UnauthorizedError) notifyUnauthorized();
    }
  }, [path, reloadFeed, mounted, notifyUnauthorized]);

  return {
    ...feed,
    data,
    refresh,
    refreshing,
    refreshError,
    /** 쓰기(별칭 저장) 뒤 다시 읽기 — 쓰기 전에 나간 같은 GET에 합류하지 않음. */
    reloadAfterWrite,
    /** 이번 화면에서 새로 받은 응답(보이는 중일 때만 — 받는 중 다시 읽기로 바뀌면 null) — '새로 받았습니다' 한 줄에 씁니다. */
    refreshed: polled?.data ? null : freshShown?.refreshed ? freshShown.data : null,
    /** 받는 중 다시 읽기의 단계(none·polling·stalled)와 '다시 확인'. */
    pendingPhase,
    recheck,
    rechecking,
    /** '다시 확인'이 받지 못했을 때의 사유(멈춘 상태 그대로) — 누른 그 멈춤(같은 경로·같은 base)에만. */
    recheckError:
      pendingPhase === "stalled" && recheckError !== null && recheckError.path === path && recheckError.base === base ? recheckError.message : null,
  };
}

/**
 * 연결 탭(계약 §7-5·7-7) — 연결 보강(GET /api/search/links — 내부자 명단·법인 관계)을 받아 대상 풀기의 links와 합친 화면 상태.
 * entityKey가 null이면 부르지 않습니다(연결 탭을 열었을 때만 — 외부 출처를 부르는 경로라 다른 탭에서는 받지 않음).
 * 합치기·받는 중·실패 글의 규칙은 lib/infoSearch의 linksView입니다(entityErrors = 대상 풀기 응답의 errors — Wikidata를 받지 못했으면 모른다고).
 */
export function useInfoSearchLinks(
  entityKey: string | null,
  entity: SearchEntity | null,
  entitySettled: boolean,
  entityErrors: Readonly<Record<string, string>>,
) {
  const links = useApi<SearchLinksResponse>(entityKey ? endpoints.search.links(entityKey) : null);
  const { data, loading, error, reload } = links;
  const view = useMemo(
    () => linksView({ entity, entitySettled, entityErrors, response: data, loading, error }),
    [entity, entitySettled, entityErrors, data, loading, error],
  );
  return { ...view, fetchedAt: data?.available ? (data.fetchedAt ?? null) : null, reload };
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
