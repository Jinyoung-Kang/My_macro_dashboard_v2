/**
 * 13F 즐겨찾기 기관(ADR 0048)의 화면 규칙 — 검색어 종류(이름·CIK), 쓰기 실패 문구, 거르기 목록 줄.
 */
import { ApiError } from "./api";

/** 이름 검색어 상한(백엔드 Sec13FFavoriteService.MAX_DISPLAY_NAME과 같음). */
export const FAVORITE_QUERY_MAX = 60;

/** 즐겨찾기 상한(백엔드 InstitutionCatalog.FAVORITE_LIMIT와 같음 — 시험이 대조). */
export const FAVORITE_LIMIT = 20;

/**
 * 찾기 칸의 글 → 숫자 1~10자리면 CIK(10자리로 채움 — SEC 이름 검색 없이), 2~60자면 이름, 그 밖은 까닭.
 */
export function favoriteQueryKind(raw: string):
  | { kind: "cik"; cik: string }
  | { kind: "name"; text: string }
  | { kind: "invalid"; reason: string } {
  const text = raw.trim().replace(/\s+/g, " ");
  if (/^\d{1,10}$/.test(text)) {
    return Number(text) > 0 ? { kind: "cik", cik: text.padStart(10, "0") } : { kind: "invalid", reason: "CIK는 0이 아닌 숫자입니다." };
  }
  const length = Array.from(text).length;
  if (length < 2 || length > FAVORITE_QUERY_MAX) {
    return { kind: "invalid", reason: `기관 이름은 2~${FAVORITE_QUERY_MAX}자, CIK는 숫자 1~10자리로 넣으세요.` };
  }
  return { kind: "name", text };
}

/** 쓰기·검색 실패 문구 — 서버가 준 글(message) 그대로, 없으면 상태별 기본 글. */
export function favoriteWriteError(error: unknown): string {
  if (!(error instanceof Error)) return "알 수 없는 오류";
  const status = error instanceof ApiError ? error.status : null;
  if (error.message && !/^요청 실패 \(HTTP \d+\)$/.test(error.message)) return error.message;
  if (status === 403) return "즐겨찾기는 운영자만 바꿀 수 있습니다.";
  if (status === 409) return "이미 있거나 상한에 닿았습니다.";
  return error.message || "알 수 없는 오류";
}
