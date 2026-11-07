package com.macrodash.feature.paper;

import tools.jackson.databind.JsonNode;

/**
 * 자유 시점 판 장중 판단의 코드 규칙 스위치(ADR 0031 결정 4·6·7) — 세션당 최소 횟수(보장, {@value #US_MIN}·{@value #KR_MIN}),
 * 사건이 판단을 당기는가({@value #US_EVENTS}·{@value #KR_EVENTS}), 장중 판단만의 effort({@value #EFFORT}, 두 책 공통). 최대 횟수는
 * {@link FreeTimingSettings}가 읽습니다.
 *
 * <p>모두 기본은 지금 동작입니다 — 최소 0(보장 없음), 사건 꺼짐, effort 키 없음(결정과 같은 {@code effort}). 키가 없거나 형·범위 밖이면 그 키만
 * 기본으로 읽습니다(이 키가 생기기 전 설정 행 — 배포만으로는 바뀌지 않음). Claude 계좌 넷 밖의 계좌는 늘 0·꺼짐입니다.
 *
 * @param minUs    미국 세션마다 계좌별 최소 장중 판단 수(0~{@value #MAX_MIN})
 * @param minKr    한국 세션마다 계좌별 최소 장중 판단 수
 * @param eventsUs 미국 사건(보유 ±4%·지수 ±1.5%·스탑 2% 안)이 장중 판단을 당기는가
 * @param eventsKr 한국 사건이 장중 판단을 당기는가
 */
record IntradayPolicy(int minUs, int minKr, boolean eventsUs, boolean eventsKr) {

    static final String US_MIN = "intradayMinPerSession";
    static final String KR_MIN = "kr.intradayMinPerSession";
    static final String US_EVENTS = "intradayEvents";
    static final String KR_EVENTS = "kr.intradayEvents";
    /** 장중 판단만의 effort(두 책 공통) — 없거나 {@link ClaudeBookService#EFFORTS} 밖이면 결정과 같은 {@code effort}. */
    static final String EFFORT = "intradayEffort";

    /** 최소 횟수의 상한 — 사용자 결정(2026-11-06) '최소 1'. */
    static final int MAX_MIN = 1;
    static final int DEFAULT_MIN = 0;
    static final boolean DEFAULT_EVENTS = false;
    static final IntradayPolicy OFF = new IntradayPolicy(DEFAULT_MIN, DEFAULT_MIN, DEFAULT_EVENTS, DEFAULT_EVENTS);

    /** 설정 본문에서 읽습니다(클래스 설명). null 본문은 모두 기본. */
    static IntradayPolicy from(JsonNode body) {
        if (body == null) {
            return OFF;
        }
        return new IntradayPolicy(min(body, US_MIN), min(body, KR_MIN), bool(body, US_EVENTS), bool(body, KR_EVENTS));
    }

    /** 그 계좌 시장의 세션당 최소 장중 판단 수. Claude 계좌 넷 밖이면 0. */
    int minPerSession(String book) {
        if (PaperBooks.CLAUDE.equals(book) || PaperBooks.CLAUDE2.equals(book)) {
            return minUs;
        }
        return PaperBooks.KR_CLAUDE.equals(book) || PaperBooks.KR_CLAUDE2.equals(book) ? minKr : 0;
    }

    /** 그 계좌 시장의 사건이 장중 판단을 당기는가. Claude 계좌 넷 밖이면 거짓. */
    boolean events(String book) {
        if (PaperBooks.CLAUDE.equals(book) || PaperBooks.CLAUDE2.equals(book)) {
            return eventsUs;
        }
        return (PaperBooks.KR_CLAUDE.equals(book) || PaperBooks.KR_CLAUDE2.equals(book)) && eventsKr;
    }

    /** 장중 판단을 부를 effort — {@value #EFFORT}가 받는 값이면 그 값, 아니면 {@code base}(결정의 effort). */
    static String effort(JsonNode body, String base) {
        JsonNode value = body == null ? null : PaperSettingsService.valueAt(body, EFFORT);
        if (value != null && value.isString() && ClaudeBookService.EFFORTS.contains(value.asString())) {
            return value.asString();
        }
        return base;
    }

    private static int min(JsonNode body, String key) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        if (value != null && value.isIntegralNumber() && value.asInt() >= 0 && value.asInt() <= MAX_MIN) {
            return value.asInt();
        }
        return DEFAULT_MIN;
    }

    private static boolean bool(JsonNode body, String key) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        return value != null && value.isBoolean() ? value.booleanValue() : DEFAULT_EVENTS;
    }
}
