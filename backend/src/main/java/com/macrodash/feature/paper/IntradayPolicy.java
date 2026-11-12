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
 * @param fixedUs  미국 장중 판단을 고정 두 시각(개장 1시간 뒤·마감 40분 전)과 사건으로만 부르는가({@value #US_FIXED} — ADR 0039, 기본 꺼짐)
 * @param fixedKr  한국 장중 판단을 고정 두 시각과 사건으로만 부르는가({@value #KR_FIXED})
 */
record IntradayPolicy(int minUs, int minKr, boolean eventsUs, boolean eventsKr, boolean fixedUs, boolean fixedKr) {

    /** 고정 일정 판 전의 모양(고정 꺼짐). */
    IntradayPolicy(int minUs, int minKr, boolean eventsUs, boolean eventsKr) {
        this(minUs, minKr, eventsUs, eventsKr, false, false);
    }

    static final String US_MIN = "intradayMinPerSession";
    static final String KR_MIN = "kr.intradayMinPerSession";
    static final String US_EVENTS = "intradayEvents";
    static final String KR_EVENTS = "kr.intradayEvents";
    /**
     * 장중 판단 고정 일정(ADR 0039) — 켜면 그 시장 Claude 계좌(자유 시점 판)의 장중 판단을 코드가 정한 두 시각(개장 1시간 뒤·마감 40분 전)과 사건(보유·
     * 지수 하락, 스탑 근접)으로만 부르고, 결정·판단의 예약은 받지 않습니다. 끄면 지금 그대로(예약·보장·사건).
     */
    static final String US_FIXED = "intradayFixed";
    static final String KR_FIXED = "kr.intradayFixed";
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
        return new IntradayPolicy(min(body, US_MIN), min(body, KR_MIN), bool(body, US_EVENTS), bool(body, KR_EVENTS),
                bool(body, US_FIXED), bool(body, KR_FIXED));
    }

    /** 그 계좌 시장의 장중 판단이 고정 일정 판인가. Claude 계좌 넷 밖이면 거짓. */
    boolean fixed(String book) {
        if (PaperBooks.CLAUDE.equals(book) || PaperBooks.CLAUDE2.equals(book)) {
            return fixedUs;
        }
        return (PaperBooks.KR_CLAUDE.equals(book) || PaperBooks.KR_CLAUDE2.equals(book)) && fixedKr;
    }

    /**
     * 결정·장중 판단이 예약할 수 있는 횟수 — 고정 일정 판이면 0(예약을 받지 않음), 아니면 {@code max} 그대로. 패킷의 {@code maxPerSession}과 예약 검사가
     * 이 값을 씁니다(코드가 부르는 고정·사건 판단의 순번 수는 {@code max} 그대로).
     */
    static int reservable(JsonNode body, String book, int max) {
        return from(body).fixed(book) ? 0 : max;
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
