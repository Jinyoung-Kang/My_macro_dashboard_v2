import { apiPost, NetworkError, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { isaErrorCode, isaErrorNeedsReload, isaErrorText, isaTimeoutText } from "@/lib/isa";
import type {
  IsaApplyRequest,
  IsaCommissionRequest,
  IsaDirectTradeRequest,
  IsaEditTradeRequest,
  IsaOkResponse,
  IsaPositionRequest,
  IsaStartRequest,
  IsaTotalRequest,
} from "@/lib/types/isa";

/*
 * ISA 계좌(ADR 0029·0034)의 쓰기 — 이 파일이 ISA 모듈에서 apiPost를 부르는 유일한 곳이고, 경로는 늘 endpoints.isa.*입니다
 * (경계 시험 __tests__/isaBoundary.test.ts가 apiPost의 첫 인자를 봅니다). 증권사로 나가는 주문은 없습니다 — 잔고와 지시 상태만 바꿉니다.
 *
 * 쓰기 11개는 모두 시간 한도(ISA_WRITE_TIMEOUT_MS)를 겁니다(QA-1035) — 응답이 오지 않을 때 단추가 '반영하는 중…'에 묶여, 새로 고친 뒤 같은 매매를 다시
 * 적게 되는 일을 줄입니다. 서버 쪽은 DB 읽기·쓰기뿐이라 20초면 넉넉하다는 전제입니다. 끊긴 요청은 서버가 처리했을 수 있으므로 sendIsa가 계좌를 다시 읽게 합니다.
 */

/** ISA 쓰기의 시간 한도 — 20초. */
export const ISA_WRITE_TIMEOUT_MS = 20_000;
const WITHIN = { timeoutMs: ISA_WRITE_TIMEOUT_MS };

/** 시작(한 번만) — 총 잔고와 줄마다 종목·수량·매입 금액. */
export function postStart(body: IsaStartRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.start, body, WITHIN);
}

/** 총 잔고 다시 맞추기(현금을 다시 셈). */
export function postTotal(body: IsaTotalRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.total, body, WITHIN);
}

/** 수수료율(%, 0~1) 고치기. */
export function postCommission(body: IsaCommissionRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.commission, body, WITHIN);
}

/** 보유 추가·고치기. */
export function postPosition(body: IsaPositionRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.position, body, WITHIN);
}

/** 보유 지우기. */
export function postDeletePosition(symbol: string): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.deletePosition(symbol), undefined, WITHIN);
}

/** 지시·스탑 지시 '확인' — 누른 순간의 가격으로 잔고에 한 트랜잭션으로 반영합니다. */
export function postApply(body: IsaApplyRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.apply, body, WITHIN);
}

/** 지시 건너뜀(잔고에 쓰지 않음). */
export function postSkipInstruction(id: number): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.skipInstruction(id), undefined, WITHIN);
}

/** 장중 스탑 매도 지시 건너뜀(매매하지 않음 — 잔고에 쓰지 않음, QA-990). */
export function postSkipStopInstruction(id: number): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.skipStopInstruction(id), undefined, WITHIN);
}

/**
 * 지시에 없던 매매 적기(잔고에 바로 반영, 지시 번호 없는 내역). 본문의 `requestId`가 같으면 서버가 다시 적지 않고 첫 줄의 결과에 `replayed`를 붙여 돌려줍니다
 * (QA-1035 — 쓰기 11개 가운데 같은 요청이 두 번 오면 두 번 반영되는 것은 이것 하나).
 */
export function postDirectTrade(body: IsaDirectTradeRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.recordTrade, body, WITHIN);
}

/** 확인한 매매를 실제 수량·체결 금액·수수료로 고치기. */
export function postEditTrade(id: number, body: IsaEditTradeRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.editTrade(id), body, WITHIN);
}

/** 매매 내역 되돌리기(잔고를 되돌리고 지시를 다시 PLANNED로 — 지시 없이 적은 매매는 다시 열 지시가 없음). */
export function postUndoTrade(id: number): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.undoTrade(id), undefined, WITHIN);
}

/**
 * 쓰기 한 번 — 서버 오류를 코드별 문구(lib/isa `isaErrorText`)의 Error로 바꿔 올립니다. 없는 행·이미 시작·시작 전처럼 화면이 서버와 어긋난 오류면
 * 다시 읽게 `onReload`를 부릅니다. 세션 만료(401)는 그대로 올려 useAsyncAction이 로그인으로 보내게 둡니다. 200인데 `ok:false`인 응답도 실패로 봅니다.
 * 시간 한도를 넘겨 끊긴 요청(lib/api `NetworkError.timedOut`)은 서버가 처리했을 수 있으므로 다시 읽고 '처리됐을 수 있음' 안내로 올립니다(QA-1035). 연결하지
 * 못한 실패는 서버가 받지 않았으므로 그 문구 그대로입니다.
 */
export async function sendIsa(request: () => Promise<IsaOkResponse>, onReload: () => void): Promise<IsaOkResponse> {
  let result: IsaOkResponse;
  try {
    result = await request();
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    if (error instanceof NetworkError && error.timedOut) {
      onReload();
      throw new Error(isaTimeoutText(ISA_WRITE_TIMEOUT_MS / 1000));
    }
    const code = isaErrorCode(error);
    if (isaErrorNeedsReload(code)) onReload();
    throw new Error(isaErrorText(code, error instanceof Error ? error.message : null));
  }
  if (result && result.ok === false) {
    throw new Error(isaErrorText(null, null));
  }
  return result;
}
