package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.SessionWindows;
import com.macrodash.analytics.TradingCalendar;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * 자유 시점 판의 분 단위 지정 시각(ADR 0027 결정 1·8, 명세 docs/specs/2026-11-05-free-fill-timing.md §2·§6) — 응답의 시각 읽기, 그 세션에서 받는
 * 범위, 그 결정만의 검증 표.
 *
 * <p>검증기({@link OrderValidator})의 시장 몫은 시점 이름 하나에 순위·닫힘·이름이 하나씩인 표입니다. 분 단위 지정 시각
 * ({@value PaperBooks#AT_MINUTE})은 주문마다 기준 시각이 달라 이름 하나로는 표를 만들 수 없습니다. 그래서 결정 파이프라인이 그 응답에 나온 시각마다
 * 열쇠 {@code AT_MINUTE@HH:MM}({@link #key})을 만들어 그 결정만의 표({@link #validation})를 넘기고, 판정 뒤 주문 행에서는 열쇠를 다시
 * {@code AT_MINUTE} + {@code target_local}로 되돌립니다({@link #timeOf}). 검증기의 계산과 끈 판의 표는 그대로입니다.
 *
 * <p>받는 범위는 정규장 안입니다 — 개장 {@link #AFTER_OPEN} 뒤부터 그 시장의 장 끝 여유({@link #tail}) 앞까지. 미국은 장중 시장가와 같은
 * 마감 5분 전({@link UsTimedFills#MARKET_BEFORE_CLOSE} — 보통 날 09:31~15:54 ET), 한국은 종가 단일가 시간 앞
 * ({@link KrTimedLadder#CLOSING_AUCTION} — 보통 날 09:01~15:19 KST)입니다. 개장 시각 자체는 시가({@code NEXT_OPEN})가 맡습니다. 조기 폐장·개장 시각
 * 변경일은 그날의 개장·마감으로 셉니다(달력). 상태가 없는 계산입니다.
 */
final class FreeTiming {

    private FreeTiming() {
    }

    /** 자유 시점 판의 아침(한국은 밤) 결정이 받는 체결 시점, 이른 것부터 — 켠 판 응답 스키마의 {@code timing} enum과 같은 목록. */
    static final List<String> DECISION_TIMINGS = List.of(PaperBooks.NEXT_OPEN, PaperBooks.AT_MINUTE, PaperBooks.NEXT_CLOSE);
    /** 자유 시점 판의 장중 판단 응답이 받는 체결 시점 — 장중 시장가 · 그날 남은 지정 시각 · 그날 종가. */
    static final List<String> INTRADAY_TIMINGS = List.of(PaperBooks.MARKET, PaperBooks.AT_MINUTE, PaperBooks.NEXT_CLOSE);

    /** 응답의 시각 글자({@code atLocal}) — 그 시장 현지 시각 'HH:MM'(24시간). 응답 스키마의 pattern과 같은 식. */
    static final String CLOCK_PATTERN = "^([01][0-9]|2[0-3]):[0-5][0-9]$";
    private static final Pattern CLOCK = Pattern.compile(CLOCK_PATTERN);
    /** 가장 이른 지정 시각은 개장 이만큼 뒤 — 개장 순간은 시가(NEXT_OPEN)의 몫. 값은 {@link SessionWindows#OPEN_OFFSET}(단일 출처). */
    static final Duration AFTER_OPEN = SessionWindows.OPEN_OFFSET;
    /** 주문 생성 뒤 이만큼 지나지 않은 시각은 늦은 주문(체결 조건 ⑤ — {@link ExecutionAudit#AFTER_CREATED}와 같은 60초). */
    static final Duration AFTER_CREATED = ExecutionAudit.AFTER_CREATED;

    private static final String KEY_PREFIX = PaperBooks.AT_MINUTE + "@";
    /** 시각이 없는 {@code AT_MINUTE} 주문의 거절 문구. */
    static final String MISSING_TIME = "AT_MINUTE 주문에는 atLocal(그 시장 현지 시각 HH:MM)이 있어야 합니다";

    /** 응답의 시각 글자 → 시각. 없거나 'HH:MM' 모양이 아니면 null(없는 시각을 지어내지 않음). */
    static LocalTime parse(String text) {
        if (text == null || !CLOCK.matcher(text).matches()) {
            return null;
        }
        return LocalTime.of(Integer.parseInt(text.substring(0, 2)), Integer.parseInt(text.substring(3, 5)));
    }

    /** 'HH:MM'(ASCII 숫자 — JVM 로캘과 무관). */
    static String label(LocalTime at) {
        return String.format(Locale.ROOT, "%02d:%02d", at.getHour(), at.getMinute());
    }

    /** 검증 표의 열쇠 — {@code AT_MINUTE@HH:MM}. */
    static String key(LocalTime at) {
        return KEY_PREFIX + label(at);
    }

    /** 검증 표의 열쇠인가. */
    static boolean keyed(String timing) {
        return timing != null && timing.startsWith(KEY_PREFIX);
    }

    /** 열쇠의 시각. 열쇠가 아니면 null. */
    static LocalTime timeOf(String timing) {
        return keyed(timing) ? parse(timing.substring(KEY_PREFIX.length())) : null;
    }

    /**
     * 응답 주문 한 줄의 검증용 시점 글자 — {@code AT_MINUTE}이고 시각을 읽었으면 그 열쇠, 시각이 없거나 모양이 틀리면 {@code AT_MINUTE} 그대로
     * (표에서 닫힌 시점 — {@link #MISSING_TIME}), 그 밖의 시점은 그대로(그 시점의 {@code atLocal}은 보지 않음).
     */
    static String proposedTiming(String timing, String atLocal) {
        if (!PaperBooks.AT_MINUTE.equals(timing)) {
            return timing;
        }
        LocalTime at = parse(atLocal);
        return at == null ? timing : key(at);
    }

    /** 주문 행에 남길 시점 글자 — 열쇠면 {@code AT_MINUTE}, 그 밖은 그대로. */
    static String orderTiming(String timing) {
        return keyed(timing) ? PaperBooks.AT_MINUTE : timing;
    }

    /** 그 시장의 장 끝 여유 — 이 시간 안의 시각은 받지 않습니다(미국 마감 5분 전, 한국 종가 단일가 10분 — {@link SessionWindows#tail}). */
    static Duration tail(boolean korea) {
        return SessionWindows.tail(korea);
    }

    /**
     * 그 세션에서 지정 시각으로 받는 범위 — {@code first} 이상 {@code end} 미만(둘 다 그 세션의 순간).
     *
     * @param first 가장 이른 시각(개장 + {@link SessionWindows#OPEN_OFFSET})
     * @param end   이 시각부터는 받지 않음(마감 − 장 끝 여유)
     */
    record Window(Instant first, Instant end) {

        boolean accepts(Instant at) {
            return at != null && !at.isBefore(first) && at.isBefore(end);
        }

        /** 받는 마지막 분(end − 1분). */
        Instant last() {
            return end.minus(Duration.ofMinutes(1));
        }
    }

    static Window window(LocalDate session, TradingCalendar calendar, boolean korea) {
        return new Window(SessionWindows.first(calendar, session), SessionWindows.end(calendar, session, korea));
    }

    /** 그 세션의 그 현지 시각의 순간. */
    static Instant at(LocalDate session, LocalTime time, TradingCalendar calendar) {
        return ZonedDateTime.of(session, time, calendar.zone()).toInstant();
    }

    /**
     * 그 결정만의 검증 표 — {@code base}(계좌 프로필의 표: 받는 시점에 {@code AT_MINUTE}가 있고, 시가·장중 시장가의 닫힘은 이미 들어 있음)에 응답에 나온
     * 지정 시각마다 열쇠 하나를 더합니다. 순위는 기준 시각 순(같은 시각은 같은 순위 — 매도는 같거나 뒤 시각의 매수에만 자리를 만듦)이고, 열쇠는
     * 범위 밖이면 MALFORMED, 지금 + 60초 이전이면 LATE_FOR_TIMING으로 닫습니다. 시각 없는 {@code AT_MINUTE}는 맨 뒤 순위의 닫힌 시점으로 남습니다.
     *
     * @param base     계좌 프로필의 표(받는 시점은 {@link #DECISION_TIMINGS} 또는 {@link #INTRADAY_TIMINGS})
     * @param minutes  응답 주문들이 적은 시각(읽은 것만 — 겹쳐도 됨)
     * @param session  목표 세션 E
     * @param now      검증하는 순간(주문은 검증 직후 같은 트랜잭션에서 만들어짐 — 장부가 체결 때 실제 생성 시각으로 다시 봄)
     * @param intraday 장중 판단 응답인가(근거 문구의 세션 말 — '이 세션'·'오늘')
     * @throws IllegalArgumentException 표에 {@code AT_MINUTE}가 없음(자유 시점 판의 표가 아님)
     */
    static OrderValidator.Market validation(OrderValidator.Market base, Collection<LocalTime> minutes, LocalDate session,
                                            Instant now, TradingCalendar calendar, boolean korea, boolean intraday) {
        if (!base.timings().contains(PaperBooks.AT_MINUTE)) {
            throw new IllegalArgumentException("자유 시점 판의 검증 표가 아닙니다(AT_MINUTE 없음): " + base.timings());
        }
        Window window = window(session, calendar, korea);
        String zone = korea ? " KST" : " ET";
        String day = korea ? (intraday ? "오늘 " : "다음 거래일 ") : (intraday ? "이 세션 " : "다음 세션 ");
        Map<String, Instant> targets = new LinkedHashMap<>();
        Map<String, String> names = new LinkedHashMap<>(base.timingNames());
        Map<String, OrderValidator.Closed> closed = new LinkedHashMap<>(base.closed());
        for (String timing : base.timings()) {
            if (!PaperBooks.AT_MINUTE.equals(timing)) {
                targets.put(timing, baseTarget(timing, session, now, calendar));
            }
        }
        // 닫힌 열쇠(범위 밖·지난 시각)와 시각 없는 AT_MINUTE는 순서에 넣지 않고 맨 뒤 순위로 — 받는 시점들의 순위·'이른 시점'이 거절될 주문에 끌려가지 않게.
        List<String> shut = new ArrayList<>();
        for (LocalTime minute : new TreeSet<>(minutes)) {
            String key = key(minute);
            Instant target = at(session, minute, calendar);
            names.put(key, day + label(minute) + zone);
            if (!window.accepts(target)) {
                closed.put(key, new OrderValidator.Closed(OrderValidator.MALFORMED, session + " 지정 시각 " + label(minute) + zone
                        + "은 받는 범위(" + label(window.first().atZone(calendar.zone()).toLocalTime()) + "~"
                        + label(window.last().atZone(calendar.zone()).toLocalTime()) + zone + ") 밖이라 받지 않음"));
                shut.add(key);
            } else if (!target.isAfter(now.plus(AFTER_CREATED))) {
                closed.put(key, new OrderValidator.Closed(OrderValidator.LATE_FOR_TIMING, "지정 시각 " + session + " " + label(minute)
                        + zone + "이 주문 생성(지금 " + Kst.stamp(now) + ") + 60초 이전이라 받지 않음"));
                shut.add(key);
            } else {
                targets.put(key, target);
            }
        }
        // 시각 없는 AT_MINUTE — 받는 시점 이름이지만 이 결정에서는 닫힘(시각을 지어내지 않음).
        closed.put(PaperBooks.AT_MINUTE, new OrderValidator.Closed(OrderValidator.MALFORMED, MISSING_TIME));
        shut.add(PaperBooks.AT_MINUTE);

        List<String> ordered = new ArrayList<>(targets.keySet());
        ordered.sort(Comparator.comparing(targets::get));
        Map<String, Integer> ranks = new LinkedHashMap<>();
        int rank = -1;
        Instant previous = null;
        for (String timing : ordered) {
            Instant target = targets.get(timing);
            if (previous == null || target.isAfter(previous)) {
                rank++;
            }
            ranks.put(timing, rank);
            previous = target;
        }
        for (String timing : shut) {
            ranks.put(timing, rank + 1);
        }
        String early = ordered.get(0);
        ordered.addAll(shut);
        return new OrderValidator.Market(ordered, early, names, base.money(), ranks, closed);
    }

    /** 이름이 기준 시각을 정하는 시점의 순간 — 시가는 개장, 종가는 마감, 장중 시장가는 지금 만들 주문의 기준 분. */
    private static Instant baseTarget(String timing, LocalDate session, Instant now, TradingCalendar calendar) {
        if (PaperBooks.NEXT_OPEN.equals(timing)) {
            return calendar.openInstant(session);
        }
        if (PaperBooks.NEXT_CLOSE.equals(timing)) {
            return calendar.closeInstant(session);
        }
        if (PaperBooks.MARKET.equals(timing)) {
            return ExecutionAudit.marketTarget(now);
        }
        throw new IllegalArgumentException("자유 시점 판이 받지 않는 시점입니다: " + timing);
    }
}
