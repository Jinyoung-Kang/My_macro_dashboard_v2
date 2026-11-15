/*
 * 인증 화면(로그인·가입·인증·재설정·처리방침) 카드의 클래스 — React 없는 순수 모듈이라 서버 컴포넌트(/privacy)와 로그인 화면(클라이언트)이
 * 함께 씁니다. 배치는 docs/specs/2026-10-31-v2-coinbase-ui.md §7-3 그대로이고, 겉모양은 작업대 화면 언어(docs/specs/2026-11-15-v2-workbench-ui.md
 * §7 8번 — 인증 화면은 겉모양만): 4px 모서리, 제목은 글자 단계 heading(20px), 주 단추·입력칸은 큰 조작(넓은 화면 40px, 좁은 화면 44px).
 */
import { buttonClasses, FOCUS_RING, TEXT_TARGET } from "@/components/ui/classes";

/** 화면 가운데 카드 — 4px 모서리(rounded-card), 안쪽 24px. */
export const AUTH_CARD = "w-full max-w-sm rounded-card border border-border bg-surface p-6";

/** 카드 제목(h1) — 글자 단계 heading(20px 굵게). */
export const AUTH_TITLE = "text-heading text-text";

/** 주 단추 — 폭 전체 강조 파랑 큰 단추(누르는 것이라 강조색, 명세 원칙 A1). */
export const AUTH_SUBMIT = `mt-6 w-full ${buttonClasses("primary", "lg")}`;

/**
 * 카드 아래 따로 선 글 링크('← 로그인'·'가입하기'·'비밀번호를 잊었나요?') — 보조 글색에 hover만 강조 파랑, 좁은 화면(lg 미만) 누르는 자리
 * 44px(TEXT_TARGET — 넓은 화면은 글 높이)과 포커스 링. 글 높이 그대로이던 때는 390px에서 19.5px였습니다(QA-465).
 */
export const AUTH_LINK = `${TEXT_TARGET} rounded-sm hover:text-accent ${FOCUS_RING}`;
