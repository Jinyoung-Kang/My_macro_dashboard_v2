package com.macrodash.feature.paper;

import com.macrodash.analytics.NewsEvents;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.support.InvalidRequestException;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 정기 결정을 다음 개장 기준으로 내는 판(ADR 0039) — 설정 {@value #US_KEY}·{@value #KR_KEY}(분, 기본 0 = 꺼짐).
 *
 * <p>끈 판의 결정 순간은 '세션 다음 날의 KST 시각'({@code decisionTimeKst}·{@code kr.decisionTimeKst})이라 금요일 세션의 결정이 토요일에 나오고,
 * 미국은 서머타임에 한 시간 어긋납니다. 켠 판은 세션 D의 결정 순간을 <b>D 다음 거래일의 개장 − N분</b>으로 셉니다(그 시장 달력의 개장 순간 —
 * 주말·휴장·서머타임·장 시간 변경일에 그대로 맞음). 기한은 미국(확정 종가를 기다리는 끝)이 결정 순간 + {@link #US_WAIT}, 한국(지나면 그 세션을
 * 결정하지 않는 끝)이 개장 {@link #KR_DEADLINE_BEFORE_OPEN} 전입니다.
 *
 * <p>결정 순간을 읽는 곳은 실행 문맥({@link MarketRun#decisionInstant}·{@link MarketRun#deadlineInstant})을 거치므로 결정 작업·한국 결정 창·한국 사건
 * 뉴스 창·실제 계좌 쪽의 결정 기한 읽기가 같은 순간을 봅니다. 미국 패킷의 사건 뉴스 창은 {@link #usNewsWindow}가 같은 규칙으로 만듭니다.
 */
final class DecisionTiming {

    private DecisionTiming() {
    }

    static final String US_KEY = "decisionBeforeOpenMinutes";
    static final String KR_KEY = "kr.decisionBeforeOpenMinutes";
    /** 저장할 수 있는 가장 큰 값(분) — 개장 10시간 전. */
    static final int MAX_MINUTES = 600;
    /** 켤 때 미국의 가장 작은 값(분) — 호출(최대 300초)과 검증이 계좌2 개장 전 컷오프(09:00 ET)·첫 체결(09:40 ET) 전에 끝나게. */
    static final int US_MIN_MINUTES = 40;
    /** 켤 때 한국의 가장 작은 값(분) — 기한(개장 30분 전)보다 앞이어야 결정할 창이 생깁니다. */
    static final int KR_MIN_MINUTES = 45;
    /** 미국 기한 — 결정 순간 뒤 이만큼까지 확정 종가를 기다립니다(개장 전이라 보통 이미 있음). */
    static final Duration US_WAIT = Duration.ofMinutes(15);
    /** 한국 기한 — 다음 개장 이만큼 전(끈 판 설정 검사의 가장 늦은 기한과 같은 30분). */
    static final Duration KR_DEADLINE_BEFORE_OPEN = Duration.ofMinutes(30);

    /** 그 시장의 분 값 — 켜져 있으면 그 값, 꺼져 있거나(0·없음) 정수가 아니거나 범위 밖이면 null(끈 판). */
    static Integer minutes(JsonNode settingsBody, boolean korea) {
        JsonNode value = settingsBody == null ? null : PaperSettingsService.valueAt(settingsBody, korea ? KR_KEY : US_KEY);
        if (value == null || !value.isIntegralNumber() || value.asInt() < 1 || value.asInt() > MAX_MINUTES) {
            return null;
        }
        return value.asInt();
    }

    /** 세션 D의 결정 순간 — D 다음 거래일의 개장 − {@code minutes}분. */
    static Instant decisionInstant(TradingCalendar calendar, LocalDate session, int minutes) {
        return calendar.openInstant(calendar.nextTradingDay(session)).minus(Duration.ofMinutes(minutes));
    }

    /** 세션 D의 기한(클래스 설명) — 결정 순간보다 이르지 않습니다. */
    static Instant deadlineInstant(TradingCalendar calendar, LocalDate session, int minutes, boolean korea) {
        Instant decision = decisionInstant(calendar, session, minutes);
        Instant open = calendar.openInstant(calendar.nextTradingDay(session));
        Instant deadline = korea ? open.minus(KR_DEADLINE_BEFORE_OPEN) : decision.plus(US_WAIT);
        if (!korea && deadline.isAfter(open)) {
            deadline = open;
        }
        return deadline.isBefore(decision) ? decision : deadline;
    }

    /**
     * 미국 패킷의 사건 뉴스 창 — 켠 판이면 (직전 세션의 결정 순간, 이 세션의 결정 순간], 끈 판이면 예전 그대로({@link NewsEvents#window(LocalDate,
     * java.time.LocalTime)} — {@code decisionTimeKst}).
     */
    static NewsEvents.Window usNewsWindow(LocalDate asOf, JsonNode settingsBody) {
        Integer minutes = minutes(settingsBody, false);
        if (minutes == null) {
            return NewsEvents.window(asOf, PaperDecisionJob.decisionTime(settingsBody));
        }
        TradingCalendar calendar = UsPaperMarket.INSTANCE.calendar();
        return NewsEvents.window(calendar, asOf, d -> decisionInstant(calendar, d, minutes));
    }

    /**
     * 결정 패킷 머리의 {@code decisionAt}(켠 판만 — 끈 판은 null이라 그 칸이 없음) — 방식·분·다음 개장 순간·결정 순간(KST).
     *
     * @param asOf 기준 거래일 D
     */
    static Map<String, Object> basisView(TradingCalendar calendar, LocalDate asOf, JsonNode settingsBody, boolean korea) {
        Integer minutes = minutes(settingsBody, korea);
        if (minutes == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("mode", "BEFORE_NEXT_OPEN");
        out.put("minutesBeforeOpen", minutes);
        out.put("nextOpenKst", com.macrodash.Kst.stamp(calendar.openInstant(calendar.nextTradingDay(asOf))));
        out.put("decisionAtKst", com.macrodash.Kst.stamp(decisionInstant(calendar, asOf, minutes)));
        out.put("note", NOTE);
        return out;
    }

    /** 켠 판 패킷의 설명 한 줄 — 무엇이 기준 거래일 종가 뒤의 값이고 무엇이 종가 그대로인지. */
    static final String NOTE = "이 결정은 다음 세션 개장 전에 낸다 — 매크로 카드·사건 뉴스·수집 글은 기준 거래일 종가 뒤(밤사이·개장 전)의 값까지 담고, "
            + "종목 가격과 장부는 기준 거래일 종가 그대로다(개장 전 시세는 없음). 밤사이 값으로 종목의 개장 가격을 짐작해 숫자를 만들지 않는다";

    /** 설정 저장 검사 — 켠 값(1 이상)이 그 시장의 최소보다 작으면 막습니다(0은 꺼짐). */
    static void requireValid(JsonNode body) {
        check(body, US_KEY, US_MIN_MINUTES);
        check(body, KR_KEY, KR_MIN_MINUTES);
    }

    private static void check(JsonNode body, String key, int min) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        if (value != null && value.isIntegralNumber() && value.asInt() >= 1 && value.asInt() < min) {
            throw new InvalidRequestException("설정을 저장하지 않았습니다 — " + key + "(" + value.asInt() + ")는 0(꺼짐)이거나 " + min
                    + "분 이상이어야 합니다");
        }
    }
}
