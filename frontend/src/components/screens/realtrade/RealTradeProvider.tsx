"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { nextDisableSentMark, type DisableSentMark, type RealTradeDialogMode } from "@/lib/realtrade";
import type { RealTradeActionResponse, RealTradeDisableRequest, RealTradeMarket, RealTradeStatusResponse } from "@/lib/types/realtrade";
import { RealTradeEnableDialog } from "./RealTradeEnableDialog";

/** 상태를 다시 읽는 주기(명세 §8). */
const POLL_MS = 15_000;
/**
 * 상태 읽기 한도 — 백엔드가 수집기 상태를 읽는 최악 시간(연결 5초 + 읽기 20초)보다 길게 둡니다(RT2-FE-1 — 짧으면 백엔드가 늦게라도 줄 상태를 버림).
 * 응답이 오지 않으면 '상태를 읽지 못했습니다'로 바꿉니다. 끄기 단추는 한도와 관계없이 읽는 동안에도 보입니다(RealTradeToggle).
 */
const STATUS_TIMEOUT_MS = 30_000;
/** 실패 문구를 아직 받지 못했을 때(다시 읽기가 이미 시작된 뒤 그린 경우)의 오류 안내 글. */
const STATUS_FAILED_FALLBACK = "응답을 받지 못했습니다";

/** 켜기·바꾸기·해제가 성공한 뒤의 안내. */
const DONE_TEXT: Readonly<Record<RealTradeDialogMode, string>> = {
  enable: "켰습니다 — 다음 시가 맞추기(보통 08:50:30~08:58:30)부터 주문합니다.",
  update: "설정을 바꿨습니다 — 방식을 바꿨으면 옛 책 따라 하기를 멈추고 다음 시가 맞추기에서 새 책 비중으로 맞춥니다.",
  resume: "멈춤을 풀었습니다 — 다음 시가 맞추기부터 다시 주문합니다.",
};

export interface RealTradeContextValue {
  market: RealTradeMarket;
  /** 한국만 — 미국은 '준비 중'(상태도 읽지 않음). */
  supported: boolean;
  status: RealTradeStatusResponse | null;
  loading: boolean;
  /**
   * 보여 줄 상태가 없는데 읽기가 실패한 뒤 아직 한 번도 성공하지 못했으면 그 실패 문구(RT2-FE-1) — 다시 읽는 동안에도 남습니다(useApi의 `error`는 다시
   * 읽기를 시작하면 비워짐). 상태가 있으면 null(그때의 실패는 `refreshError`).
   */
  statusError: string | null;
  refreshError: string | null;
  /** 상태를 모르는가 — 첫 읽기·다시 읽기가 실패했고 그 뒤 아직 성공하지 못함(끄기 단추를 늘 보이고 켜기는 숨김). */
  readFailed: boolean;
  /** 이 브라우저가 상태를 마지막으로 받은 시각 — 응답에 서버 시각(serverTime)이 없을 때 정기 작업 멈춤을 이 시각과 견줍니다. */
  loadedAt: Date | null;
  reload: () => Promise<void>;
  /** 끄기 — 확인 창 없이 바로 POST(명세 §8). */
  disable: () => Promise<void>;
  disableBusy: boolean;
  disableError: string | null;
  /**
   * 이 화면에서 끄기를 보냈는가 — '새 주문 멈춤 — 미체결 취소 중' 안내에 씁니다. 그 뒤 상태가 다시 켜짐·이상 멈춤으로 돌아오거나(끄는 중·꺼짐을 본 뒤)
   * 설정 버전이 끄기 응답보다 커진 켜짐·이상 멈춤을 받으면 지웁니다(RT3-UI-3 — 다른 기기·탭에서 다시 켬, lib/realtrade `nextDisableSentMark`).
   */
  disableSent: boolean;
  openDialog: (mode: RealTradeDialogMode) => void;
  /** 켜기·바꾸기·해제가 성공한 뒤의 안내(없으면 null). */
  notice: string | null;
}

const RealTradeContext = createContext<RealTradeContextValue | null>(null);

/** 실제 매매 칸·단추가 함께 쓰는 상태. 공급자 밖에서는 null(단추·칸은 아무것도 그리지 않음). */
export function useRealTrade(): RealTradeContextValue | null {
  return useContext(RealTradeContext);
}

/**
 * 실제 매매(ADR 0028) 상태 공급자 — 실제 계좌 탭에서 실제 매매 칸(RealTradePanel)과 계좌 요약 옆 단추(RealTradeToggle)가 같은 상태·같은 동작을 쓰게
 * 상태 읽기(15초마다) 하나와 끄기 동작 하나, 켜기 창 하나를 둡니다. 모의 개요·실제 계좌 조회와 따로 읽으므로 그쪽이 실패해도 상태와 끄기는 그대로입니다.
 *
 * <p>쓰기는 이 모듈의 apiPost가 endpoints.realtrade.*로만 보냅니다(경계 시험 __tests__/realtradeBoundary.test.ts). 미국은 상태를 읽지 않고 '준비 중'만 보입니다.
 */
export function RealTradeProvider({ market, children }: { market: RealTradeMarket; children: ReactNode }) {
  const supported = market === "KR";
  const { data, loading, error, refreshError, failedAt, loadedAt, reload } = useApi<RealTradeStatusResponse>(
    supported ? endpoints.realtrade.status(market) : null,
    POLL_MS,
    { timeoutMs: STATUS_TIMEOUT_MS },
  );
  // useApi는 다시 읽기를 시작할 때 error를 비우지만 failedAt(마지막 실패 순간)은 성공할 때까지 남깁니다 — 실패 여부는 failedAt으로 보고,
  // 문구는 마지막으로 받은 것을 기억해 다시 읽는 동안에도 오류 안내가 '읽는 중'으로 돌아가지 않게 합니다(RT2-FE-1). 성공하면 지웁니다.
  const [lastError, setLastError] = useState<string | null>(null);
  useEffect(() => {
    if (error) setLastError(error);
    else if (data) setLastError(null);
  }, [error, data]);
  const statusError = data ? null : (error ?? (failedAt ? (lastError ?? STATUS_FAILED_FALLBACK) : null));
  const readFailed = Boolean(error || refreshError || failedAt);
  const [dialog, setDialog] = useState<RealTradeDialogMode | null>(null);
  // 끄기를 보낸 표시 — null이면 보내지 않음. 끄기 응답의 설정 버전과 그 뒤 끄는 중·꺼짐을 봤는지를 함께 둡니다(RT3-UI-3).
  const [disableMark, setDisableMark] = useState<DisableSentMark | null>(null);
  // 지금 상태로 표시를 다음 값으로 — 그리는 그 순간에 계산해 다시 켜진 상태와 옛 안내가 한 화면에 함께 그려지지 않게 하고, 저장은 아래 effect가 맞춥니다.
  // 같은 상태로 다시 계산해도 값이 같으므로(끄는 중·꺼짐을 봤다는 표시는 남고, 지운 표시는 null) 몇 번 그려도 됩니다.
  const currentMark = nextDisableSentMark(disableMark, data);
  const disableSent = currentMark !== null;
  const [notice, setNotice] = useState<string | null>(null);
  // 끄기 응답이 돌려준 설정 버전(없으면 null) — 그보다 큰 버전의 켜짐·이상 멈춤이 오면 다른 곳에서 다시 켠 것입니다.
  const disabledVersion = useRef<number | null>(null);

  const disableRequest = useCallback(async () => {
    const response = await apiPost<RealTradeActionResponse>(endpoints.realtrade.disable, { market } satisfies RealTradeDisableRequest);
    disabledVersion.current = typeof response?.version === "number" ? response.version : null;
    return response;
  }, [market]);
  const disableAction = useAsyncAction(disableRequest, "실제 매매를 끄지 못했습니다.");
  const runDisable = disableAction.run;

  const disable = useCallback(async () => {
    setNotice(null);
    if (await runDisable()) setDisableMark({ version: disabledVersion.current, sawOff: false });
    // 성공·실패와 관계없이 상태를 다시 읽습니다(끄는 중·꺼짐이 칩에 바로 보이게).
    void reload();
  }, [runDisable, reload]);

  // 계산한 표시를 저장 — 다시 켜짐으로 돌아왔으면 지우고, 끄는 중·꺼짐을 봤으면 그 사실을 남깁니다(끄기 직후 진행 중이던 읽기의 옛 켜짐으로는 지우지 않음).
  // 함수형 갱신이라 방금 끄기가 세운 표시를 옛 계산값으로 덮지 않고, 표시가 바뀌어도 다시 맞춥니다(같은 값이면 그대로 — 끝없이 돌지 않음).
  useEffect(() => {
    setDisableMark((mark) => nextDisableSentMark(mark, data));
  }, [data, disableMark]);

  const openDialog = useCallback((mode: RealTradeDialogMode) => {
    setNotice(null);
    setDialog(mode);
  }, []);

  const value = useMemo<RealTradeContextValue>(
    () => ({
      market,
      supported,
      status: data,
      loading,
      statusError,
      refreshError,
      readFailed,
      loadedAt,
      reload,
      disable,
      disableBusy: disableAction.busy,
      disableError: disableAction.error,
      disableSent,
      openDialog,
      notice,
    }),
    [
      market,
      supported,
      data,
      loading,
      statusError,
      refreshError,
      readFailed,
      loadedAt,
      reload,
      disable,
      disableAction.busy,
      disableAction.error,
      disableSent,
      openDialog,
      notice,
    ],
  );

  return (
    <RealTradeContext.Provider value={value}>
      {children}
      {supported && data && (
        <RealTradeEnableDialog
          mode={dialog}
          status={data}
          market={market}
          onClose={() => setDialog(null)}
          onConflict={() => void reload()}
          onDone={(mode) => {
            setDialog(null);
            setDisableMark(null);
            setNotice(DONE_TEXT[mode]);
            void reload();
          }}
        />
      )}
    </RealTradeContext.Provider>
  );
}
