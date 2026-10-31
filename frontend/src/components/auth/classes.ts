/*
 * 인증 화면(로그인·가입·인증·재설정·처리방침) 카드의 클래스 — React 없는 순수 모듈이라 서버 컴포넌트(/privacy)와 로그인 화면(클라이언트)이
 * 함께 씁니다. 모양의 근거는 docs/specs/2026-10-31-v2-coinbase-ui.md §7-3.
 */
import { buttonClasses } from "@/components/ui/classes";

/** 화면 가운데 카드 — 16px 모서리, 좁은 화면 안쪽 24px·sm 이상 32px. */
export const AUTH_CARD = "w-full max-w-sm rounded-card border border-border bg-surface p-6 sm:p-8";

/** 카드 제목(h1) — 24px 굵게. */
export const AUTH_TITLE = "text-2xl font-bold text-text";

/** 주 단추 — 폭 전체 강조 파랑 알약(누르는 것이라 강조색, 명세 원칙 A1). */
export const AUTH_SUBMIT = `mt-6 w-full ${buttonClasses("primary")}`;
