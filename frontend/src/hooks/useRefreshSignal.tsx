"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiGet, apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";

/**
 * 화면 전체를 다시 읽게 만드는 공용 신호.
 *
 * <b>왜 필요한가</b> — 셸의 "데이터 수동 새로고침"(왼쪽 내비, 좁은 화면은 더보기)은 원래
 * `router.refresh()`를 불렀습니다. 그런데 이 앱의 화면은 전부 클라이언트에서
 * fetch로 데이터를 읽습니다. `router.refresh()`는 서버 컴포넌트만 다시 그리므로
 * 클라이언트가 이미 받아 둔 데이터에는 아무 일도 일어나지 않았고, 사용자가
 * 브라우저를 직접 새로고침해야 했습니다.
 *
 * <b>그리고 한 가지 더</b> — 수집은 백그라운드로 돕니다. 버튼을 누른 직후에
 * 다시 읽어 봐야 아직 예전 값입니다. 그래서 수집이 **끝날 때까지 기다렸다가**
 * 다시 읽습니다. 끝났는지는 수집기의 실행 번호(runId)가 바뀌고 finishedAt이
 * 찍혔는지로 판단합니다.
 */
interface RefreshState {
  /** 이 값이 바뀌면 useApi를 쓰는 모든 화면이 다시 읽습니다. */
  token: number;
  /** 수집이 끝나기를 기다리는 중인가. */
  collecting: boolean;
  message: string | null;
  requestRefresh: () => Promise<void>;
  /** 수집 없이 지금 화면만 다시 읽기. */
  reloadAll: () => void;
  /** 어떤 요청이든 401을 받으면 올라갑니다. 레이아웃이 이것을 보고 로그인으로 보냅니다. */
  sessionLost: boolean;
  /** 401을 받은 횟수 — 한 번 켜지면 내려가지 않는 sessionLost와 달리 401마다 바뀌어, 레이아웃이 그때마다 세션을 다시 확인합니다. */
  unauthorizedCount: number;
  notifyUnauthorized: () => void;
}

const FALLBACK: RefreshState = {
  token: 0,
  collecting: false,
  message: null,
  requestRefresh: async () => {},
  reloadAll: () => {},
  sessionLost: false,
  unauthorizedCount: 0,
  notifyUnauthorized: () => {},
};

const RefreshContext = createContext<RefreshState>(FALLBACK);

/** 수집이 끝나기를 기다리는 한도. 넘으면 그냥 다시 읽고 안내합니다. */
const POLL_TIMEOUT_MS = 90_000;
/** 확인 간격 — 2초에서 시작해 1.5배씩, 최대 10초. 예전엔 2초 고정이라 무거운 /api/status를 최대 45번 불렀습니다. */
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 10_000;

interface StatusShape {
  lastRun?: { id?: number | null; finishedAt?: string | null } | null;
}

interface RefreshResponse {
  message?: string;
  triggered?: boolean;
  baselineRunId?: number | null;
}

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(0);
  const [collecting, setCollecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sessionLost, setSessionLost] = useState(false);
  const [unauthorizedCount, setUnauthorizedCount] = useState(0);
  const inFlight = useRef(false);

  const reloadAll = useCallback(() => setToken((n) => n + 1), []);
  const notifyUnauthorized = useCallback(() => {
    setSessionLost(true);
    setUnauthorizedCount((n) => n + 1);
  }, []);

  const requestRefresh = useCallback(async () => {
    // 연타해도 수집 요청이 겹치지 않게 합니다.
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setCollecting(true);
    setMessage(null);

    try {
      const result = await apiPost<RefreshResponse>(
        endpoints.status.refresh(true),
      );
      setMessage(result.message ?? "새로고침을 요청했습니다.");

      if (result.triggered) {
        const finished = await waitForCollection(result.baselineRunId ?? null);
        setMessage(
          finished
            ? "수집이 끝나 화면을 갱신했습니다."
            : "수집이 아직 진행 중입니다. 지금까지 받은 값으로 갱신했습니다.",
        );
      }
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "새로고침에 실패했습니다.",
      );
    } finally {
      // 성공이든 실패든 화면은 다시 읽습니다. 실패했더라도 그 사이 스케줄러가
      // 받아 둔 값이 있을 수 있고, 사용자가 브라우저를 새로고침하게 두는 것보다
      // 낫습니다.
      reloadAll();
      setCollecting(false);
      inFlight.current = false;
    }
  }, [reloadAll]);

  const value = useMemo(
    () => ({ token, collecting, message, requestRefresh, reloadAll, sessionLost, unauthorizedCount, notifyUnauthorized }),
    [token, collecting, message, requestRefresh, reloadAll, sessionLost, unauthorizedCount, notifyUnauthorized],
  );

  return (
    <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
  );
}

/**
 * 수집기의 실행 번호가 바뀌고 끝날 때까지 기다립니다.
 *
 * @returns 끝난 것을 확인했으면 true, 한도를 넘겼으면 false
 */
async function waitForCollection(baselineRunId: number | null): Promise<boolean> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let interval = POLL_INTERVAL_MS;

  while (Date.now() < deadline) {
    await sleep(interval);
    interval = Math.min(POLL_MAX_INTERVAL_MS, Math.round(interval * 1.5));
    try {
      const status = await apiGet<StatusShape>(endpoints.status.overview);
      const run = status.lastRun;
      if (!run?.id) {
        continue;
      }
      const isNewRun = baselineRunId === null || run.id !== baselineRunId;
      if (isNewRun && run.finishedAt) {
        return true;
      }
    } catch {
      // 수집 중에 백엔드가 잠깐 바쁠 수 있습니다. 한도까지는 계속 시도합니다.
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useRefreshSignal(): RefreshState {
  return useContext(RefreshContext);
}
