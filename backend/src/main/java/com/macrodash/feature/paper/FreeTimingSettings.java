package com.macrodash.feature.paper;

import tools.jackson.databind.JsonNode;

/**
 * 자유 시점 판의 계좌별 스위치(ADR 0027 결정 2, 명세 docs/specs/2026-11-05-free-fill-timing.md §12-1) — 켜면 그 계좌의 다음 결정부터 분 단위
 * 지정 시각({@value PaperBooks#AT_MINUTE})과 시가·종가를 받는 판(새 프로필·응답 스키마·고정 문단)으로 부릅니다. 모두 기본 꺼짐이고, 꺼진 계좌의
 * 시스템 프롬프트·응답 스키마·패킷·검증 결과는 이 키가 생기기 전과 바이트까지 같습니다.
 *
 * <p>키가 없거나 불리언이 아니면 그 키만 꺼짐으로 읽습니다(이 키가 생기기 전에 만든 설정 행 — 배포만으로는 바뀌지 않음). 판은 결정 때 정해지고,
 * 그 세션의 장중 판단은 결정이 쓴 판을 따릅니다(스위치를 저장한 날에도 끈 판 결정의 계획을 켠 판이 받지 않음).
 *
 * @param claude    미국 Claude 계좌1({@value #US_CLAUDE})
 * @param claude2   미국 Claude 계좌2({@value #US_CLAUDE2})
 * @param krClaude  한국 Claude 계좌1({@value #KR_CLAUDE})
 * @param krClaude2 한국 Claude 계좌2({@value #KR_CLAUDE2})
 */
record FreeTimingSettings(boolean claude, boolean claude2, boolean krClaude, boolean krClaude2) {

    static final String US_CLAUDE = "claude.freeTiming";
    static final String US_CLAUDE2 = "claude2.freeTiming";
    static final String KR_CLAUDE = "kr.claude.freeTiming";
    static final String KR_CLAUDE2 = "kr.claude2.freeTiming";

    /** 이 키가 생기기 전 행·빈 본문의 값. */
    static final boolean DEFAULT = false;
    static final FreeTimingSettings OFF = new FreeTimingSettings(DEFAULT, DEFAULT, DEFAULT, DEFAULT);

    /** 설정 본문에서 읽습니다(클래스 설명). null 본문은 모두 꺼짐. */
    static FreeTimingSettings from(JsonNode body) {
        if (body == null) {
            return OFF;
        }
        return new FreeTimingSettings(bool(body, US_CLAUDE), bool(body, US_CLAUDE2), bool(body, KR_CLAUDE), bool(body, KR_CLAUDE2));
    }

    /** 그 계좌가 켠 판인가. Claude 계좌 넷 밖의 코드는 늘 거짓(규칙 계좌의 체결 시각은 다른 키). */
    boolean on(String book) {
        if (book == null) {
            return false;
        }
        return switch (book) {
            case PaperBooks.CLAUDE -> claude;
            case PaperBooks.CLAUDE2 -> claude2;
            case PaperBooks.KR_CLAUDE -> krClaude;
            case PaperBooks.KR_CLAUDE2 -> krClaude2;
            default -> false;
        };
    }

    /** 그 계좌의 스위치 키. Claude 계좌 넷 밖이면 null. */
    static String key(String book) {
        if (book == null) {
            return null;
        }
        return switch (book) {
            case PaperBooks.CLAUDE -> US_CLAUDE;
            case PaperBooks.CLAUDE2 -> US_CLAUDE2;
            case PaperBooks.KR_CLAUDE -> KR_CLAUDE;
            case PaperBooks.KR_CLAUDE2 -> KR_CLAUDE2;
            default -> null;
        };
    }

    private static boolean bool(JsonNode body, String key) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        return value != null && value.isBoolean() ? value.booleanValue() : DEFAULT;
    }
}
