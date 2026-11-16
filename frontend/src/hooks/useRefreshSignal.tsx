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
  /**
   * 마지막 새로고침이 실패했는가(QA-552) — 요청 자체가 실패했거나, 200이라도 수집을 시작하지 못했을 때(store_only가 아닌데 triggered=false — 백엔드
   * '수집기에 연결하지 못했습니다…'). 두 갈래 모두 글은 짧은 결과 낱말이 먼저인 '새로고침 실패 — 사유'이고, 셸이 안내를 경고 톤으로 그립니다.
   */
  failed: boolean;
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
  failed: false,
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
/** 실패 안내의 결과 낱말(failureMessage). */
const REFRESH_FAILED = "새로고침 실패";

interface StatusShape {
  lastRun?: { id?: number | null; finishedAt?: string | null } | null;
}

interface RefreshResponse {
  /** 백엔드 읽기 모드(DataStatusService.refresh — 'auto'·'store_only'). store_only면 수집을 일으키지 않는 것이 정상입니다. */
  readMode?: string;
  message?: string;
  triggered?: boolean;
  baselineRunId?: number | null;
}

export function RefreshProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState(0);
  const [collecting, setCollecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
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
    setFailed(false);

    try {
      const result = await apiPost<RefreshResponse>(
        endpoints.status.refresh(true),
      );
      // 프런트는 늘 runFast=true로 부르므로, store_only가 아닌데 triggered=false면 수집기에 닿지 못한 것입니다 — 백엔드 글('수집기에 연결하지
      // 못했습니다. …')은 결과 낱말이 문장 끝이라 요청 실패와 같은 머리말을 붙여 실패 꼴로 둡니다(QA-552).
      if (result.readMode !== "store_only" && result.triggered === false) {
        setMessage(failureMessage(result.message ?? "수집기에 연결하지 못했습니다."));
        setFailed(true);
      } else {
        setMessage(result.message ?? "새로고침을 요청했습니다.");
      }

      if (result.triggered) {
        const finished = await waitForCollection(result.baselineRunId ?? null);
        setMessage(
          finished
            ? "수집이 끝나 화면을 갱신했습니다."
            : "수집이 아직 진행 중입니다. 지금까지 받은 값으로 갱신했습니다.",
        );
      }
    } catch (error) {
      setMessage(failureMessage(error instanceof Error ? error.message : "다시 시도하세요"));
      setFailed(true);
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
    () => ({ token, collecting, message, failed, requestRefresh, reloadAll, sessionLost, unauthorizedCount, notifyUnauthorized }),
    [token, collecting, message, failed, requestRefresh, reloadAll, sessionLost, unauthorizedCount, notifyUnauthorized],
  );

  return (
    <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>
  );
}

/**
 * 실패 안내 — 짧은 결과 낱말을 앞에 둡니다('새로고침 실패 — 사유'). 상단바 안내는 한 줄(말줄임)이라, 사유('백엔드 API(<주소>)에 연결하지
 * 못했습니다')부터 쓰거나 결과 낱말이 길면('새로고침하지 못했습니다' — 11자) 좁은 폭에서 실패를 뜻하는 낱말이 잘려 나갔습니다(QA-552).
 */
function failureMessage(reason: string): string {
  return `${REFRESH_FAILED} — ${reason}`;
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
