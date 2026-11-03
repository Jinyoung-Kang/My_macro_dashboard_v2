"use client";

import { useEffect, useRef, useState } from "react";
import { apiBase, apiGet } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import type { LivePrice, LivePricesResponse } from "@/lib/types";
import { useShownOnce } from "./useShownOnce";

export interface LivePricesState {
  /** 'US:AAPL' → 최근에 받은 가격(이번 구독에서 받은 것만 — 뒤 응답에서 빠져도 남김, 빠졌는지는 missing) */
  prices: Readonly<Record<string, LivePrice>>;
  /** 마지막으로 받은 때(ms, 브라우저 시계) — 받은 적 없으면 null */
  receivedAt: number | null;
  /** 종목마다 마지막으로 받은 때(ms) — 그 종목이 든 응답의 시각(QA-184). 응답 하나의 시각을 모든 종목에 붙이지 않습니다. */
  receivedAtByKey: Readonly<Record<string, number>>;
  /**
   * 마지막 응답에 없던 종목 — 받은 값이 있는데 빠진 것과 응답이 받지 못했다고 밝힌 것(받지 못한 응답이면 받은 종목 모두). 이 종목의 `prices` 값은
   * 지금 값이 아닙니다(QA-184).
   */
  missing: readonly string[];
  /** 받지 못한 이유 한 줄(연결 끊김·서버 응답 없음·출처 거부) — 하나도 받지 못했을 때만, 없으면 null */
  error: string | null;
  /** 마지막 응답이 받지 못한 종목이 있을 때 출처별 사유 한 줄 — 일부만 받았어도(QA-184, 매크로 카드 머리말). 없으면 null. */
  sourceError: string | null;
  /**
   * 연결이 닫혀(200이 아닌 응답 — 브라우저가 다시 잇지 않음) 다시 열기를 기다리거나 여는 중 — 다시 받을 때까지 true(QA-183). 그동안 받은 가격은 멈춘
   * 값이라, 지금 값처럼 보이는 자리(개요 히어로의 실시간 추정)는 쓰지 않습니다.
   */
  disconnected: boolean;
}

const EMPTY_STATE: LivePricesState = {
  prices: {}, receivedAt: null, receivedAtByKey: {}, missing: [], error: null, sourceError: null, disconnected: false,
};

/** EventSource.readyState의 CLOSED — 시험의 가짜 EventSource에는 정적 상수가 없어 숫자로 둡니다. */
const CLOSED = 2;
/** 닫힌 연결을 다시 열기까지 — 처음 5초, 또 닫히면 두 배씩, 최대 60초(QA-183). 받으면 처음부터. */
const REOPEN_FIRST_MS = 5_000;
const REOPEN_MAX_MS = 60_000;
const RECONNECTING = "실시간 시세 연결이 끊겨 다시 잇는 중입니다.";

/** 탭이 보이는지 — 숨기면 연결을 닫고, 다시 보이면 다시 잇습니다(보지 않는 동안 시세를 받지 않음, ADR 0020·0024). */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}

/**
 * 받은 본문 → 다음 상태. 가격은 앞 값 위에 덮고(빠진 종목의 앞 값은 남김), 받은 시각은 이번에 받은 종목에만, 빠진 종목은 `missing`으로(QA-184).
 * 출처 오류는 하나도 받지 못했으면 `error`, 빠진 종목이 있으면 일부만 받았어도 `sourceError`에 한 줄로.
 */
export function mergeLivePrices(previous: LivePricesState, body: LivePricesResponse, now: number): LivePricesState {
  // 응답을 받았으면 연결은 살아 있습니다(닫힌 연결을 다시 연 뒤 첫 응답 — QA-183).
  if (!body.available || !body.prices) {
    return {
      ...previous,
      missing: Object.keys(previous.prices),
      error: body.message ?? "실시간 시세를 받지 못했습니다.",
      sourceError: null,
      disconnected: false,
    };
  }
  const items = body.prices.items ?? {};
  const received = Object.keys(items);
  const errors = Object.entries(body.prices.errors ?? {}).map(([source, why]) => `${source}: ${why}`).join(" · ");
  const reported = body.prices.missing ?? [];
  const receivedAtByKey = { ...previous.receivedAtByKey };
  for (const key of received) receivedAtByKey[key] = now;
  return {
    prices: { ...previous.prices, ...items },
    receivedAt: now,
    receivedAtByKey,
    missing: [...new Set([...Object.keys(previous.prices), ...reported])].filter((key) => !(key in items)),
    error: errors && received.length === 0 ? errors : null,
    sourceError: errors && (received.length === 0 || reported.length > 0) ? errors : null,
    disconnected: false,
  };
}

/**
 * 종목들의 실시간 가격(ADR 0024) — 주기가 있으면 SSE(GET /api/live/prices/stream)로 서버가 그 주기마다 밀어 주고, 끄기(0)면 화면을 열 때 한 번만
 * 읽습니다(GET /api/live/prices — 숨긴 탭으로 열렸으면 처음 보일 때, 그 뒤 탭을 숨기거나 다시 보일 때는 읽지 않음, QA-189). 탭을 숨기면 연결을 닫고
 * 다시 보이면 다시 이어 바로 한 번 받습니다. 연결이 끊기면 브라우저(EventSource)가 다시
 * 잇습니다 — 다만 다시 이은 응답이 200이 아니면(배포 중 502·연결 상한 429·401) 브라우저가 연결을 닫고 다시 잇지 않으므로, 그때는 닫고 5초부터 두
 * 배씩(최대 60초) 기다렸다 새로 엽니다(받으면 처음부터 — QA-183). 표시 전용 — 장부는 이 값을 쓰지 않습니다.
 *
 * @param items   'US:AAPL'·'KR:005930'(lib/livePrices liveKey) — 비면 읽지 않음
 * @param seconds 주기(초, 0 = 끄기)
 * @param enabled false면 읽지 않음(장 밖의 장중 카드 등)
 */
export function useLivePrices(items: readonly string[], seconds: number, enabled = true): LivePricesState {
  const key = items.join(",");
  const visible = useDocumentVisible();
  // 끄기의 한 번 읽기는 탭이 처음 보인 뒤에만 — 숨김·보임이 바뀔 때마다 다시 읽지 않습니다(QA-189, 보지 않는 동안 받지 않음).
  const shown = useShownOnce();
  const [state, setState] = useState<LivePricesState>(EMPTY_STATE);
  // 닫힌 연결을 새로 여는 차례 — 올리면 아래 효과가 새 EventSource를 엽니다(QA-183). 기다린 횟수는 받으면 0(ref — 바꿔도 다시 열지 않음).
  const [reopen, setReopen] = useState(0);
  const closedCount = useRef(0);

  // 끄기(0) — 화면을 열 때 한 번. 의존성에 탭 보임(visible)을 두지 않습니다: 두면 숨길 때 숨은 탭에서, 돌아올 때 또 읽었습니다(QA-189).
  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (!enabled || list.length === 0 || seconds > 0 || !shown) return;
    const controller = new AbortController();
    apiGet<LivePricesResponse>(endpoints.live.prices(list), controller.signal)
      .then((body) => setState((previous) => mergeLivePrices(previous, body, Date.now())))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : "실시간 시세를 받지 못했습니다." }));
        }
      });
    return () => controller.abort();
  }, [key, seconds, enabled, shown]);

  // 주기가 있으면 SSE — 탭이 보이는 동안만 엽니다.
  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (!enabled || list.length === 0 || seconds <= 0) return;
    if (!visible || typeof EventSource === "undefined") return;
    const source = new EventSource(`${apiBase()}${endpoints.live.stream(list, seconds)}`, { withCredentials: true });
    let reopenTimer: ReturnType<typeof setTimeout> | null = null;
    source.addEventListener("prices", (event) => {
      closedCount.current = 0;
      try {
        const body = JSON.parse((event as MessageEvent<string>).data) as LivePricesResponse;
        setState((previous) => mergeLivePrices(previous, body, Date.now()));
      } catch {
        setState((previous) => ({ ...previous, error: "실시간 시세 응답을 읽지 못했습니다.", disconnected: false }));
      }
    });
    source.onerror = () => {
      if (source.readyState !== CLOSED) {
        // 망 오류·서버가 끝낸 연결은 EventSource가 스스로 다시 잇습니다 — 그동안의 표시만 바꿉니다(받은 값은 남김).
        setState((previous) => ({ ...previous, error: RECONNECTING }));
        return;
      }
      // 200이 아닌 응답으로 닫혔습니다 — 브라우저는 다시 잇지 않습니다(QA-183). 닫고, 상한 있는 백오프 뒤 새로 엽니다(바로 열면 서버의 연결 상한과
      // 맞물려 429를 되풀이함). 받은 값은 남기되 멈춘 값이라는 표시(disconnected)를 둡니다.
      source.close();
      const wait = Math.min(REOPEN_FIRST_MS * 2 ** closedCount.current, REOPEN_MAX_MS);
      closedCount.current += 1;
      setState((previous) => ({ ...previous, error: `실시간 시세 연결이 끊김 — ${wait / 1000}초 뒤 다시 연결합니다.`, disconnected: true }));
      reopenTimer = setTimeout(() => {
        setState((previous) => ({ ...previous, error: RECONNECTING }));
        setReopen((count) => count + 1);
      }, wait);
    };
    // 탭을 숨기거나 종목·주기가 바뀌면 기다리던 새로 열기도 지웁니다(보지 않는 동안 받지 않음).
    return () => {
      if (reopenTimer !== null) clearTimeout(reopenTimer);
      source.close();
    };
  }, [key, seconds, enabled, visible, reopen]);

  return state;
}
