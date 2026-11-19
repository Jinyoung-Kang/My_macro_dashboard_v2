/*
 * 인증 화면(로그인·가입·인증·재설정·처리방침) 카드의 클래스 — React 없는 순수 모듈이라 서버 컴포넌트(/privacy)와 로그인 화면(클라이언트)이
 * 함께 씁니다. 배치는 docs/specs/2026-10-31-v2-coinbase-ui.md §7-3 그대로이고, 겉모양은 작업대 화면 언어(docs/specs/2026-11-15-v2-workbench-ui.md
 * §7 8번 — 인증 화면은 겉모양만): 4px 모서리, 제목은 글자 단계 heading(20px), 주 단추·입력칸은 큰 조작(넓은 화면 40px, 좁은 화면 44px).
 */
import { buttonClasses, FOCUS_RING, TEXT_TARGET, TEXT_TARGET_SHORT } from "@/components/ui/classes";

/**
 * 화면 가운데 카드 — 4px 모서리(rounded-card), 안쪽 24px. 카드 안 한국어 글(제목·안내·처리방침 dd·동의 글)은 낱말 사이에서만 줄을 바꾸고 공백 없는 긴
 * 토큰만 칸 안에서 꺾습니다(break-keep wrap-break-word — 상속, 공용 글 부품 규약 QA-568과 같은 짝). 예전에는 '저장하지 않|음'·'동|의합니다'처럼
 * 음절 사이가 갈렸습니다(QA-891 — not-found 카드는 이미 낱말 사이).
 */
export const AUTH_CARD = "w-full max-w-sm rounded-card border border-border bg-surface p-6 break-keep wrap-break-word";

/**
 * 대시보드 레이아웃의 안내 카드(백엔드에 연결하지 못함·운영자 계정 없음 — app/(dashboard)/layout.tsx) — 인증 카드와 같은 4px 모서리·안쪽 24px(모든 폭),
 * 안내 글이 길어 폭은 max-w-lg, 주의 톤 경계, 글은 인증 카드처럼 낱말 사이에서만 줄바꿈(QA-891). 처음에는 넓은 화면 안쪽이 32px(sm:p-8)이라 인증 카드와 달랐습니다(공용 키트 단계가 이 단계로 넘김).
 */
export const AUTH_NOTICE_CARD = "w-full max-w-lg rounded-card border border-warn/40 bg-surface p-6 text-sm break-keep wrap-break-word";

/** 카드 제목(h1) — 글자 단계 heading(20px 굵게). */
export const AUTH_TITLE = "text-heading text-text";

/** 주 단추 — 폭 전체 강조 파랑 큰 단추(누르는 것이라 강조색, 명세 원칙 A1). */
export const AUTH_SUBMIT = `mt-6 w-full ${buttonClasses("primary", "lg")}`;

/**
 * 카드 아래 따로 선 글 링크('← 로그인'·'가입하기'·'비밀번호를 잊었나요?') — 보조 글색에 hover만 강조 파랑, 좁은 화면(lg 미만) 누르는 자리
 * 44px(TEXT_TARGET — 넓은 화면은 글 높이)과 포커스 링. 글 높이 그대로이던 때는 390px에서 19.5px였습니다(QA-465).
 */
export const AUTH_LINK = `${TEXT_TARGET} rounded-sm hover:text-accent ${FOCUS_RING}`;

/**
 * 두세 글자 따로 선 글 링크(없는 주소 화면의 '← 홈') — AUTH_LINK와 같은 색·링에 짧은 글 단추 누름 자리(ui/classes TEXT_TARGET_SHORT — 좁은 화면 높이·폭
 * 44px·글 가운데, 넓은 화면은 글 크기). AUTH_LINK(폭은 글 폭)로는 390px에서 29.6×44px였습니다(QA-862).
 */
export const AUTH_LINK_SHORT = `${TEXT_TARGET_SHORT} rounded-sm hover:text-accent ${FOCUS_RING}`;

/**
 * 결과 상자(오류·성공 — AuthMessage, 로그인 오류) — 4px 모서리, 13px 글. 안은 공용 상태 글(StatusText — 아이콘 칸 + 낭독기 머리말 + 글)이라 색만으로
 * 상태를 가르지 않습니다(명세 §0 W4, QA-855). 톤(테두리·틴트 바탕·글자색)은 AUTH_MESSAGE_TONE.
 */
export const AUTH_MESSAGE = "mt-4 rounded-control border px-3 py-2.5 text-[13px]";

/**
 * 동의 체크 label(가입 — 체크 상자 + 글 두 줄) — 좁은 화면(lg 미만) 누르는 자리 44px(체크 상자 16px는 감싼 label이 누름 자리를 맡음 — QA-856), 넓은 화면은
 * 글 높이 그대로. 체크 상자는 글 첫 줄에 맞춰 위에 둡니다(items-start — 남는 높이는 아래).
 */
export const AUTH_CHECK = "mt-4 flex min-h-11 items-start gap-2 text-xs text-text-2 lg:min-h-0";

/** 결과 상자의 톤 — 오류는 위험 틴트, 성공은 정상 틴트(틴트 위 같은 톤 글자 4.54·6.9:1 — globals.css). */
export const AUTH_MESSAGE_TONE = {
  error: "border-danger/30 bg-danger-tint text-danger",
  ok: "border-ok/30 bg-ok-tint text-ok",
} as const;
