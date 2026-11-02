"use client";

import { useEffect, useState } from "react";
import { apiBase, apiGet } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import type { LivePrice, LivePricesResponse } from "@/lib/types";

export interface LivePricesState {
  /** 'US:AAPL' → 최근에 받은 가격(이번 구독에서 받은 것만) */
  prices: Readonly<Record<string, LivePrice>>;
  /** 마지막으로 받은 때(ms, 브라우저 시계) — 받은 적 없으면 null */
  receivedAt: number | null;
  /** 받지 못한 이유 한 줄(연결 끊김·서버 응답 없음·출처 거부) — 없으면 null */
  error: string | null;
}

const EMPTY_STATE: LivePricesState = { prices: {}, receivedAt: null, error: null };

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

/** 받은 본문 → 다음 상태(가격은 앞 값 위에 덮음, 출처 오류·빠진 종목은 한 줄로). */
export function mergeLivePrices(previous: LivePricesState, body: LivePricesResponse, now: number): LivePricesState {
  if (!body.available || !body.prices) {
    return { ...previous, error: body.message ?? "실시간 시세를 받지 못했습니다." };
  }
  const errors = Object.entries(body.prices.errors ?? {}).map(([source, why]) => `${source}: ${why}`);
  return {
    prices: { ...previous.prices, ...body.prices.items },
    receivedAt: now,
    error: errors.length > 0 && Object.keys(body.prices.items ?? {}).length === 0 ? errors.join(" · ") : null,
  };
}

/**
 * 종목들의 실시간 가격(ADR 0024) — 주기가 있으면 SSE(GET /api/live/prices/stream)로 서버가 그 주기마다 밀어 주고, 끄기(0)면 화면을 열 때 한 번만
 * 읽습니다(GET /api/live/prices). 탭을 숨기면 연결을 닫고 다시 보이면 다시 이어 바로 한 번 받습니다. 연결이 끊기면 브라우저(EventSource)가 다시
 * 잇습니다. 표시 전용 — 장부는 이 값을 쓰지 않습니다.
 *
 * @param items   'US:AAPL'·'KR:005930'(lib/livePrices liveKey) — 비면 읽지 않음
 * @param seconds 주기(초, 0 = 끄기)
 * @param enabled false면 읽지 않음(장 밖의 장중 카드 등)
 */
export function useLivePrices(items: readonly string[], seconds: number, enabled = true): LivePricesState {
  const key = items.join(",");
  const visible = useDocumentVisible();
  const [state, setState] = useState<LivePricesState>(EMPTY_STATE);

  useEffect(() => {
    const list = key ? key.split(",") : [];
    if (!enabled || list.length === 0) return;
    if (seconds <= 0) {
      const controller = new AbortController();
      apiGet<LivePricesResponse>(endpoints.live.prices(list), controller.signal)
        .then((body) => setState((previous) => mergeLivePrices(previous, body, Date.now())))
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : "실시간 시세를 받지 못했습니다." }));
          }
        });
      return () => controller.abort();
    }
    if (!visible || typeof EventSource === "undefined") return;
    const source = new EventSource(`${apiBase()}${endpoints.live.stream(list, seconds)}`, { withCredentials: true });
    source.addEventListener("prices", (event) => {
      try {
        const body = JSON.parse((event as MessageEvent<string>).data) as LivePricesResponse;
        setState((previous) => mergeLivePrices(previous, body, Date.now()));
      } catch {
        setState((previous) => ({ ...previous, error: "실시간 시세 응답을 읽지 못했습니다." }));
      }
    });
    source.onerror = () => {
      // EventSource가 스스로 다시 잇습니다 — 그동안의 표시만 바꿉니다(받은 값은 남김).
      setState((previous) => ({ ...previous, error: "실시간 시세 연결이 끊겨 다시 잇는 중입니다." }));
    };
    return () => source.close();
  }, [key, seconds, enabled, visible]);

  return state;
}
