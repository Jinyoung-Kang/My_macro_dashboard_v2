import { apiPost, UnauthorizedError } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { isaErrorCode, isaErrorNeedsReload, isaErrorText } from "@/lib/isa";
import type { IsaLedgerRequest, IsaOkResponse, IsaStartRequest } from "@/lib/types/isa";

/*
 * ISA 계좌(ADR 0029)의 쓰기 넷 — 이 파일이 ISA 모듈에서 apiPost를 부르는 유일한 곳이고, 경로는 늘 endpoints.isa.*입니다
 * (경계 시험 __tests__/isaBoundary.test.ts가 apiPost의 첫 인자를 봅니다). 증권사로 나가는 주문은 없습니다 — 장부와 지시 상태만 바꿉니다.
 */

/** 시작(한 번만) — 시작 현금(입금 행)과 시작 매수 목록(매수 행)을 한 트랜잭션으로. */
export function postStart(body: IsaStartRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.start, body);
}

/** 장부 행 추가(본문에 id 없음)·고치기(id 있음). */
export function postLedger(body: IsaLedgerRequest): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.ledger, body);
}

/** 장부 행 지우기. */
export function postDeleteLedger(id: number): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.deleteLedger(id));
}

/** 지시 건너뜀(장부에 쓰지 않음). */
export function postSkipInstruction(id: number): Promise<IsaOkResponse> {
  return apiPost<IsaOkResponse>(endpoints.isa.skipInstruction(id));
}

/**
 * 쓰기 한 번 — 서버 오류를 코드별 문구(lib/isa `isaErrorText`)의 Error로 바꿔 올립니다. 없는 행·이미 시작·시작 전처럼 화면이 서버와 어긋난 오류면
 * 장부를 다시 읽게 `onReload`를 부릅니다. 세션 만료(401)는 그대로 올려 useAsyncAction이 로그인으로 보내게 둡니다. 200인데 `ok:false`인 응답도 실패로 봅니다.
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
