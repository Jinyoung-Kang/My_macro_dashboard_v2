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
 * @param intradayMaxUs 미국 세션마다 계좌별 장중 판단 횟수({@value #US_INTRADAY_MAX} — 저장은 0~{@value #INTRADAY_MAX_SETTING}, 읽을 때 코드가 부를 수 있는
 *                      순번 수 {@value RuleBookService#INTRADAY_MAX}를 넘지 않음, 0이면 장중 판단 없음)
 * @param intradayMaxKr 한국 세션마다 계좌별 장중 판단 횟수({@value #KR_INTRADAY_MAX})
 */
record FreeTimingSettings(boolean claude, boolean claude2, boolean krClaude, boolean krClaude2, int intradayMaxUs,
                          int intradayMaxKr) {

    static final String US_CLAUDE = "claude.freeTiming";
    static final String US_CLAUDE2 = "claude2.freeTiming";
    static final String KR_CLAUDE = "kr.claude.freeTiming";
    static final String KR_CLAUDE2 = "kr.claude2.freeTiming";

    /**
     * 세션마다 계좌별 장중 판단 횟수(ADR 0027 결정 3, ADR 0031 초안 결정 4 — 사용자 결정 2026-11-06 최대 3회). 켠 판의 결정이 예약할 수 있는 수이고, 0이면
     * 예약을 받지 않습니다.
     */
    static final String US_INTRADAY_MAX = "intradayMaxPerSession";
    static final String KR_INTRADAY_MAX = "kr.intradayMaxPerSession";
    /** 설정에 저장할 수 있는 최대 횟수(쓰기 검사 범위 0~3). 읽은 값은 {@link RuleBookService#INTRADAY_MAX}(코드가 부를 수 있는 순번 수)를 넘지 않습니다. */
    static final int INTRADAY_MAX_SETTING = 3;

    /** 이 키가 생기기 전 행·빈 본문의 값. */
    static final boolean DEFAULT = false;
    /** 키가 없는 행의 장중 판단 횟수 — 2(ADR 0027의 값 그대로, 최대 횟수를 올려도 따라가지 않음 — 3은 설정 저장으로). */
    static final int DEFAULT_INTRADAY_MAX = 2;
    static final FreeTimingSettings OFF = new FreeTimingSettings(DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT_INTRADAY_MAX,
            DEFAULT_INTRADAY_MAX);

    /** 설정 본문에서 읽습니다(클래스 설명). null 본문은 모두 꺼짐. */
    static FreeTimingSettings from(JsonNode body) {
        if (body == null) {
            return OFF;
        }
        return new FreeTimingSettings(bool(body, US_CLAUDE), bool(body, US_CLAUDE2), bool(body, KR_CLAUDE), bool(body, KR_CLAUDE2),
                count(body, US_INTRADAY_MAX), count(body, KR_INTRADAY_MAX));
    }

    /** 그 계좌 시장의 세션당 장중 판단 횟수. Claude 계좌 넷 밖이면 0. */
    int intradayMax(String book) {
        if (PaperBooks.CLAUDE.equals(book) || PaperBooks.CLAUDE2.equals(book)) {
            return intradayMaxUs;
        }
        return PaperBooks.KR_CLAUDE.equals(book) || PaperBooks.KR_CLAUDE2.equals(book) ? intradayMaxKr : 0;
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

    /**
     * 0~{@value #INTRADAY_MAX_SETTING}의 정수를 {@value RuleBookService#INTRADAY_MAX}(코드가 부를 수 있는 순번 수)까지로. 없거나 범위 밖이면 기본
     * ({@value #DEFAULT_INTRADAY_MAX}).
     */
    private static int count(JsonNode body, String key) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        if (value != null && value.isIntegralNumber() && value.asInt() >= 0 && value.asInt() <= INTRADAY_MAX_SETTING) {
            return Math.min(value.asInt(), RuleBookService.INTRADAY_MAX);
        }
        return DEFAULT_INTRADAY_MAX;
    }

    private static boolean bool(JsonNode body, String key) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        return value != null && value.isBoolean() ? value.booleanValue() : DEFAULT;
    }
}
