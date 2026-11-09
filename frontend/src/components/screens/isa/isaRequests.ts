import { apiPost, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { isaErrorCode, isaErrorNeedsReload, isaErrorText } from "@/lib/isa";
import type {
  IsaApplyRequest,
  IsaCommissionRequest,
  IsaEditTradeRequest,
  IsaOkResponse,
  IsaPositionRequest,
  IsaStartRequest,
  IsaTotalRequest,
} from "@/lib/types/isa";

/*
 * ISA 계좌(ADR 0029·0034)의 쓰기 — 이 파일이 ISA 모듈에서 apiPost를 부르는 유일한 곳이고, 경로는 늘 endpoints.isa.*입니다
 * (경계 시험 __tests__/isaBoundary.test.ts가 apiPost의 첫 인자를 봅니다). 증권사로 나가는 주문은 없습니다 — 잔고와 지시 상태만 바꿉니다.
 */

/** 시작(한 번만) — 총 잔고와 줄마다 종목·수량·매입 금액. */
export function postStart(body: IsaStartRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.start, body);
}

/** 총 잔고 다시 맞추기(현금을 다시 셈). */
export function postTotal(body: IsaTotalRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.total, body);
}

/** 수수료율(%, 0~1) 고치기. */
export function postCommission(body: IsaCommissionRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.commission, body);
}

/** 보유 추가·고치기. */
export function postPosition(body: IsaPositionRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.position, body);
}

/** 보유 지우기. */
export function postDeletePosition(symbol: string): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.deletePosition(symbol));
}

/** 지시·스탑 지시 '확인' — 누른 순간의 가격으로 잔고에 한 트랜잭션으로 반영합니다. */
export function postApply(body: IsaApplyRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.apply, body);
}

/** 지시 건너뜀(잔고에 쓰지 않음). */
export function postSkipInstruction(id: number): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.skipInstruction(id));
}

/** 매매 내역 되돌리기(잔고를 되돌리고 지시를 다시 PLANNED로). */
export function postEditTrade(id: number, body: IsaEditTradeRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.editTrade(id), body);
}

export function postUndoTrade(id: number): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.undoTrade(id));
}

/**
 * 쓰기 한 번 — 서버 오류를 코드별 문구(lib/isa `isaErrorText`)의 Error로 바꿔 올립니다. 없는 행·이미 시작·시작 전처럼 화면이 서버와 어긋난 오류면
 * 다시 읽게 `onReload`를 부릅니다. 세션 만료(401)는 그대로 올려 useAsyncAction이 로그인으로 보내게 둡니다. 200인데 `ok:false`인 응답도 실패로 봅니다.
 */
export async function sendIsa(request: () => Promise<IsaOkResponse>, onReload: () => void): Promise<IsaOkResponse> {
  let result: IsaOkResponse;
  try {
    result = await request();
  } catch (error) {
    if (error instanceof UnauthorizedError) throw error;
    const code = isaErrorCode(error);
    if (isaErrorNeedsReload(code)) onReload();
    throw new Error(isaErrorText(code, error instanceof Error ? error.message : null));
  }
  if (result && result.ok === false) {
    throw new Error(isaErrorText(null, null));
  }
  return result;
}
