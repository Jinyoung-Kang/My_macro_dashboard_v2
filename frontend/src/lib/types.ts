/**
 * src/lib/types.ts
 * 백엔드 응답 계약 — 기능별 파일의 배럴. 가져오는 쪽은 예전처럼 `@/lib/types`를 씁니다.
 *
 * 값이 없을 수 있는 필드는 전부 `| null`입니다. 프런트는 그 null을 그대로
 * "—"로 표시하고, 절대 0으로 바꾸지 않습니다.
 */
export * from "./types/macro";
export * from "./types/institution";
export * from "./types/insight";
export * from "./types/positioning";
export * from "./types/status";
export * from "./types/ai";
export * from "./types/publicData";
export * from "./types/auth";
export * from "./types/alerts";
export * from "./types/paper";
export * from "./types/detail";
