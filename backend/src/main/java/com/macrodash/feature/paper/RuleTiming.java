package com.macrodash.feature.paper;

import com.macrodash.analytics.SessionWindows;
import com.macrodash.analytics.TradingCalendar;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;

/**
 * 규칙 계좌의 체결 시각 설정(ADR 0027 결정 5, 명세 docs/specs/2026-11-05-free-fill-timing.md §8) — 미국 {@value #US_TIMING}·{@value #US_AT},
 * 한국 {@value #KR_TIMING}·{@value #KR_AT}. 기본값은 지금 그대로(미국 다음 시간별 관측치, 한국 다음 거래일 시가)이고, 기본값이면 규칙 계좌의 결정·주문이
 * 이 설정이 생기기 전과 같습니다. 그 밖의 값은 그 결정의 주문 전부(신호·재선정·현금 관리)를 다음 세션 E의 그 시각에 냅니다 — 스탑 주문은 그대로입니다.
 *
 * <p>설정 시점이 그 결정에서 닫혔으면({@link #choose} — 조기 폐장일의 범위 밖 시각, 세션 도중의 결정에서 이미 지난 시가·지정 시각) 그 결정의 주문은
 * 기본 시점으로 내고 사유를 결정 기록에 남깁니다(주문을 버리지 않음). 받는 범위는 Claude 계좌의 지정 시각과 같은 함수입니다({@link FreeTiming#window} —
 * 개장 10분 뒤 ~ 장 끝 여유 앞, ADR 0031). 두 가지 예외(ADR 0031 — 2026-11-06 사용자 결정 '규칙 계좌는 개장 10분 뒤'):
 * <ul>
 *   <li><b>개장이 늦은 날</b>(수능일·신년 첫 거래일 — 그날 첫 분이 설정 시각보다 늦음): 기본 시점으로 떨어뜨리지 않고 그날 첫 분(개장 + 10분)의 지정 시각으로
 *       옮깁니다(두 시장 모두 — 사유를 남김).</li>
 *   <li><b>한국 지정 시각 설정의 대체 시점</b>: 그 밖의 이유로 닫히면(장 시간 변경일의 범위 밖·지정 시각 없음) 시가가 아니라 목표 세션 첫 분의 지정 시각으로
 *       냅니다(그 첫 분도 이미 지났으면 기본 시점 — 세션 도중의 결정). 장부의 한국 규칙 주문 다시 내기도 같은 규칙입니다({@link #reissueAt}).
 *       미국 대체 시점(다음 관측치)은 그대로입니다 — slow 회차 :15 고정이라 개장 뒤 첫 관측치가 개장 45분 뒤입니다.</li>
 * </ul>
 *
 * @param timing 체결 시점 값(그 시장의 받는 목록 안)
 * @param at     분 단위 지정 시각({@link PaperBooks#AT_MINUTE}일 때만 읽음 — 그 시장 현지 시각)
 */
record RuleTiming(String timing, LocalTime at) {

    static final String US_TIMING = "rules.timing";
    static final String US_AT = "rules.timingAtEt";
    static final String KR_TIMING = "kr.rules.timing";
    static final String KR_AT = "kr.rules.timingAtKst";

    /** 미국 규칙 계좌가 받는 체결 시점 — 첫째가 기본. */
    static final List<String> US_OPTIONS = List.of(ExecutionAudit.NEXT_OBSERVATION, PaperBooks.NEXT_OPEN, PaperBooks.AT_MINUTE,
            PaperBooks.NEXT_CLOSE);
    /** 한국 규칙 계좌가 받는 체결 시점 — 첫째가 기본. */
    static final List<String> KR_OPTIONS = List.of(PaperBooks.NEXT_OPEN, PaperBooks.AT_MINUTE, PaperBooks.NEXT_CLOSE);
    /** 지정 시각 키의 기본값(시점이 {@code AT_MINUTE}일 때만 읽음). */
    static final String DEFAULT_AT = "10:00";
    /**
     * 저장할 때 받는 지정 시각의 범위(보통 날의 받는 범위 — 조기 폐장·개장 시각 변경일은 그 결정에서 {@link #choose}가 봄). 값은
     * {@link SessionWindows#regularFirst}·{@link SessionWindows#regularLast}(Claude 계좌의 지정 시각 범위 {@link FreeTiming#window}와 같은 출처).
     */
    static final LocalTime US_FIRST = SessionWindows.regularFirst(false);
    static final LocalTime US_LAST = SessionWindows.regularLast(false);
    static final LocalTime KR_FIRST = SessionWindows.regularFirst(true);
    static final LocalTime KR_LAST = SessionWindows.regularLast(true);

    /** 미국 규칙 계좌의 설정 — 키가 없거나 받는 목록 밖이면 기본(이 키가 생기기 전에 만든 설정 행). */
    static RuleTiming us(JsonNode body) {
        return read(body, US_TIMING, US_AT, US_OPTIONS);
    }

    /** 한국 규칙 계좌의 설정. */
    static RuleTiming kr(JsonNode body) {
        return read(body, KR_TIMING, KR_AT, KR_OPTIONS);
    }

    private static RuleTiming read(JsonNode body, String timingKey, String atKey, List<String> options) {
        JsonNode value = body == null ? null : PaperSettingsService.valueAt(body, timingKey);
        String timing = value != null && value.isString() && options.contains(value.asString()) ? value.asString() : options.get(0);
        JsonNode time = body == null ? null : PaperSettingsService.valueAt(body, atKey);
        return new RuleTiming(timing, time != null && time.isString() ? FreeTiming.parse(time.asString()) : null);
    }

    /** 기본 시점인가(그 시장의 받는 목록 첫째) — 기본이면 규칙 계좌의 결정·주문이 이 설정 전과 같습니다. */
    boolean standard(boolean korea) {
        return (korea ? KR_OPTIONS : US_OPTIONS).get(0).equals(timing);
    }

    /**
     * 그 결정의 주문이 쓸 시점.
     *
     * @param timing 주문 행의 시점
     * @param at     분 단위 지정 시각(그 밖의 시점은 null)
     * @param note   설정 시점 대신 기본 시점으로 낸 사유, 또는 설정 시각을 그날 첫 분으로 옮긴 사유 — 설정 시점 그대로(또는 기본 설정)면 null
     */
    record Chosen(String timing, LocalTime at, String note) {
    }

    /**
     * 기준 거래일 {@code asOf}의 결정이 지금({@code now}) 내는 주문의 시점 — 설정 시점의 기준 시각이 목표 세션 E(다음 거래일)에서 받는 범위 안이고 지금 +
     * 60초보다 뒤면 그 시점, 아니면 기본 시점과 사유(클래스 설명). 지정 시각이 그날 첫 분보다 이르면(개장이 늦은 날) 그날 첫 분으로 옮기고, 한국 지정 시각
     * 설정이 그 밖의 이유로 닫히면 E의 첫 분 지정 시각으로 냅니다(클래스 설명의 두 예외). 기본 설정이면 늘 기본 시점입니다.
     */
    Chosen choose(LocalDate asOf, Instant now, TradingCalendar calendar, boolean korea) {
        String fallback = (korea ? KR_OPTIONS : US_OPTIONS).get(0);
        if (standard(korea)) {
            return new Chosen(fallback, null, null);
        }
        LocalDate session = calendar.nextTradingDay(asOf);
        String zone = korea ? " KST" : " ET";
        Instant earliest = now.plus(FreeTiming.AFTER_CREATED);
        String closed = null;
        if (PaperBooks.AT_MINUTE.equals(timing)) {
            FreeTiming.Window window = FreeTiming.window(session, calendar, korea);
            LocalTime first = window.first().atZone(calendar.zone()).toLocalTime();
            if (at == null) {
                closed = "지정 시각이 없음";
            } else {
                Instant target = FreeTiming.at(session, at, calendar);
                if (target.isBefore(window.first()) && window.first().isAfter(earliest)) {
                    // 개장이 늦은 날(장 시간 변경일) — 설정 시각이 그날 첫 분 앞이면 기본 시점이 아니라 그날 첫 분으로 옮깁니다(ADR 0031).
                    return new Chosen(PaperBooks.AT_MINUTE, first, "체결 시각 설정(" + label() + ")이 " + session + " 개장 10분 뒤("
                            + FreeTiming.label(first) + zone + ")보다 일러 그날 첫 분(AT_MINUTE " + FreeTiming.label(first) + ")으로 옮김");
                }
                if (!window.accepts(target)) {
                    closed = session + " 지정 시각 " + FreeTiming.label(at) + zone + "이 그날 받는 범위("
                            + FreeTiming.label(window.first().atZone(calendar.zone()).toLocalTime()) + "~"
                            + FreeTiming.label(window.last().atZone(calendar.zone()).toLocalTime()) + zone + ") 밖";
                } else if (!target.isAfter(earliest)) {
                    closed = "지정 시각 " + session + " " + FreeTiming.label(at) + zone + "이 이미 지남";
                }
            }
        } else if (PaperBooks.NEXT_OPEN.equals(timing)) {
            if (!calendar.openInstant(session).isAfter(earliest)) {
                closed = session + " 개장이 이미 지남";
            }
        } else if (!calendar.closeInstant(session).isAfter(earliest)) {
            closed = session + " 마감이 이미 지남";
        }
        if (closed != null && korea && PaperBooks.AT_MINUTE.equals(timing)) {
            // 한국 지정 시각 설정의 대체 시점(R4) — 시가(개장 단일가)가 아니라 목표 세션 첫 분의 지정 시각. 그 첫 분도 지났으면(세션 도중의 결정) 아래 기본 시점.
            LocalTime first = reissueAt(session, calendar);
            if (FreeTiming.at(session, first, calendar).isAfter(earliest)) {
                return new Chosen(PaperBooks.AT_MINUTE, first, "체결 시각 설정(" + label() + ")을 이 결정에는 그대로 쓰지 못해 " + session
                        + " 첫 분(AT_MINUTE " + FreeTiming.label(first) + zone + ")으로 냄 — " + closed);
            }
        }
        if (closed != null) {
            return new Chosen(fallback, null, "체결 시각 설정(" + label() + ")을 이 결정에는 쓰지 못해 기본 시점(" + fallback + ")으로 냄 — " + closed);
        }
        return new Chosen(timing, PaperBooks.AT_MINUTE.equals(timing) ? at : null, null);
    }

    /**
     * 한국 지정 시각 규칙 주문의 대체·다시 내기 시각 — 그 세션의 첫 분(개장 + {@link SessionWindows#OPEN_OFFSET}, 그날 달력 — 보통 날 09:10, 수능일 10:10).
     * {@link #choose}의 한국 대체 시점과 장부의 다시 내기({@code PaperLedgerService})가 같은 값을 씁니다(R4 — 개장 단일가로 돌아가지 않게).
     */
    static LocalTime reissueAt(LocalDate session, TradingCalendar calendar) {
        return SessionWindows.firstLocal(calendar, session);
    }

    /** 한국 규칙 주문을 다시 낼 때 지정 시각 주문으로 내는가 — 지금 설정이 {@code kr.rules.timing = AT_MINUTE}(되돌리면 예전처럼 시가). */
    boolean reissuesAtMinute() {
        return PaperBooks.AT_MINUTE.equals(timing);
    }

    /** 설정 값의 표시 — 'AT_MINUTE 10:47'·'NEXT_CLOSE'. */
    String label() {
        return PaperBooks.AT_MINUTE.equals(timing) && at != null ? timing + " " + FreeTiming.label(at) : timing;
    }

    /**
     * 저장할 본문의 규칙 계좌 체결 시각이 받을 수 있는 값인가 — {@code AT_MINUTE}이면 지정 시각이 'HH:MM'이고 그 시장의 보통 날 범위 안이어야 합니다.
     *
     * @return 막을 사유(없으면 null)
     */
    static String invalid(JsonNode body) {
        for (boolean korea : new boolean[]{false, true}) {
            String timingKey = korea ? KR_TIMING : US_TIMING;
            String atKey = korea ? KR_AT : US_AT;
            JsonNode value = PaperSettingsService.valueAt(body, timingKey);
            if (value == null || !value.isString() || !PaperBooks.AT_MINUTE.equals(value.asString())) {
                continue;
            }
            JsonNode time = PaperSettingsService.valueAt(body, atKey);
            LocalTime at = time != null && time.isString() ? FreeTiming.parse(time.asString()) : null;
            LocalTime first = korea ? KR_FIRST : US_FIRST;
            LocalTime last = korea ? KR_LAST : US_LAST;
            if (at == null || at.isBefore(first) || at.isAfter(last)) {
                return timingKey + "가 AT_MINUTE이면 " + atKey + "는 " + FreeTiming.label(first) + "~" + FreeTiming.label(last)
                        + (korea ? " KST" : " ET") + " 안의 HH:MM이어야 합니다" + (time == null || time.isNull() ? "" : " — " + time.asString(""));
            }
        }
        return null;
    }
}
