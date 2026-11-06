package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.ExecutionAudit.Price;
import com.macrodash.feature.paper.KrQuotes.Bar1m;
import com.macrodash.feature.paper.KrQuotes.Close1m;
import com.macrodash.feature.paper.KrQuotes.Timed;
import com.macrodash.store.PaperStore.ExecFill;
import com.macrodash.store.PaperStore.Order;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 한국 실행 감사의 판정(한국 Claude 계좌2 단계 2c — 명세 docs/specs/2026-11-02-kr-claude2-stage2.md §6·§11): 주문 하나를 시가·매시·종가로 체결했다면의
 * 원가격(반사실)을 목표 세션 E의 토스 1분봉({@code paper.kr.timed} — 수집기 {@code kr_paper_timed})에서 셉니다. 저장본·DB를 읽지 않는 순수 계산이라 정기
 * 작업({@link PaperKrExecutionAuditJob})과 시험이 그대로 부릅니다. 미국 판정({@link ExecutionAudit})과 같은 뜻이고 다른 곳만 적습니다.
 *
 * <p><b>목표 세션 E</b> = 주문 기준 거래일 다음 KR 거래일(그 실행 달력 — 장 시간 변경일 포함). 라벨은 봉 <b>끝</b> 시각(KST)이라 기준 시각 T의 봉은 라벨
 * T + 1분입니다.
 * <ul>
 *   <li><b>시가</b>({@code NEXT_OPEN} — 계좌1식 기준): T = 그날 개장, 창 키는 개장 시각(보통 {@code 09:00}). R1 {@value #RUNG_OPEN} 라벨 개장 + 1분 봉 시가
 *       (거래량 &gt; 0) → R2 {@value #RUNG_NEXT} 창(라벨 + 2~+5분) 안 첫 거래 봉 시가.</li>
 *   <li><b>매시</b>({@code AT_1000}~{@code AT_1500}): 같은 사다리(R1 {@value #RUNG_AT}). T가 그날 개장 전이거나 종가 단일가(마감 10분 전부터 —
 *       {@link KrTimedLadder#CLOSING_AUCTION})면 null(장 시간 변경일 — 검증기가 받지 않는 시각).</li>
 *   <li><b>종가</b>({@code NEXT_CLOSE}): 마감 단일가 봉 종가({@value #RUNG_CLOSE}, 시각 = 그날 마감) — 라벨은 마감 시각, NXT 종목이면 + 1분(G2). NXT 여부를
 *       모르면 null. 마감 + 10분 전에 받은 칸이면 null(마감 봉을 덮지 못함).</li>
 * </ul>
 * 대체(창 밖 늦은 봉·토스 일봉 값)는 반사실에 쓰지 않습니다(미국 §14-1과 같은 '대체 없음'). 아래가 하나라도 어긋나면 그 시점은 null입니다 — T &gt; 주문 생성 +
 * 60초(⑤), 그 종목·세션 칸이 받음({@code OK})이고 주문 뒤에 받았으며(⑧), 창이 다 지난 뒤(T + {@link #WINDOW_DONE} — ⑦ 완성 봉)에 받은 칸.
 *
 * <p><b>기준</b>: 미국은 계좌1 실제 체결 원가격이지만 한국은 시가 반사실입니다 — 한국 계좌1의 체결도 같은 1분봉 개장 봉이라, 두 계좌를 같은 자료로 견줍니다.
 * 지연은 E 마감 뒤에 받은 봉이라 셀 것이 없습니다(행의 {@code lag_seconds}는 늘 null).
 */
final class KrExecutionAudit {

    private KrExecutionAudit() {
    }

    /** 계좌1식 기준 — 한국 계좌1의 체결 시점(시가). */
    static final String BASELINE = PaperBooks.NEXT_OPEN;

    /** 반사실을 적는 시점 전부, 응답·요약 순서 — 계좌1식 기준(시가) + 매시 여섯 + 종가. 이름은 V17 {@code paper_orders.timing} CHECK 글자. */
    static final List<String> TIMINGS = List.of(PaperBooks.NEXT_OPEN, PaperBooks.AT_1000, PaperBooks.AT_1100, PaperBooks.AT_1200,
            PaperBooks.AT_1300, PaperBooks.AT_1400, PaperBooks.AT_1500, PaperBooks.NEXT_CLOSE);

    /** 사다리 칸(반사실 JSON의 {@code rung}) — 한국 체결 출처와 같은 글자. */
    static final String RUNG_OPEN = KrQuotes.SOURCE_1M_OPEN;
    static final String RUNG_AT = KrTimedLadder.SOURCE_AT;
    static final String RUNG_NEXT = KrTimedLadder.SOURCE_NEXT;
    static final String RUNG_CLOSE = KrTimedLadder.SOURCE_CLOSE;

    /**
     * 대체 체결의 출처 — 창 밖 그날 늦은 봉(R2b)·토스 일봉 시가(시가 사다리를 내려감). 고른 시점(M1)의 본 줄에서 빼 따로 세고, 늦게 풂으로 셉니다.
     */
    static final Set<String> FALLBACK_SOURCES = Set.of(KrTimedLadder.SOURCE_LATE, KrQuotes.SOURCE_INTEGRATED, KrQuotes.SOURCE_DAILY);

    /** 창이 다 지났다고 보는 때 — T + 6분(라벨 T + 5분 봉이 끝난 뒤). */
    static final Duration WINDOW_DONE = Duration.ofMinutes(6);

    /** 한국 Claude 계좌(실행 감사 대상) — 한국 책 정의 가운데 kind CLAUDE, 정의 순(계좌1 {@code kr_claude}·계좌2 {@code kr_claude2}). */
    static List<String> auditedBooks() {
        return KrPaperMarket.INSTANCE.books().stream().filter(d -> PaperBooks.KIND_CLAUDE.equals(d.kind()))
                .map(PaperBooks.Definition::code).toList();
    }

    /** 체결 시점을 스스로 고르는 계좌인가(고른 시점 M1·늦게 풂이 있는 계좌) — 한국 계좌2. */
    static boolean choosesTiming(String code) {
        return PaperBooks.KR_CLAUDE2.equals(code);
    }

    /** 목표 세션 E — 기준 거래일 다음 KR 거래일. 기준 거래일이 없으면 null. */
    static LocalDate targetSession(Order order, TradingCalendar calendar) {
        return order.asOfTradingDate() == null ? null : calendar.nextTradingDay(order.asOfTradingDate());
    }

    /** 기준 시각 T — 시가는 그날 개장, 매시·장중 시장가·종가는 장부 사다리와 같은 시각({@link KrTimedLadder#targetOn}), 모르는 시점은 null. */
    static Instant targetAt(String timing, Instant createdAt, LocalDate session, TradingCalendar calendar) {
        if (session == null) {
            return null;
        }
        return PaperBooks.NEXT_OPEN.equals(timing) ? calendar.openInstant(session)
                : KrTimedLadder.targetOn(timing, createdAt, session, calendar);
    }

    /** 그 주문 자신의 기준 시각 T — 분 단위 지정 시각이면 주문의 시각까지 봅니다({@link KrTimedLadder#targetOn(Order, LocalDate, TradingCalendar)}). */
    static Instant targetAt(Order order, LocalDate session, TradingCalendar calendar) {
        if (session == null) {
            return null;
        }
        return PaperBooks.NEXT_OPEN.equals(order.timing()) ? calendar.openInstant(session)
                : KrTimedLadder.targetOn(order, session, calendar);
    }

    /** 시가·매시 시점 하나의 반사실 — 그 창의 R1·R2(클래스 설명). 못 구하면 null. */
    static Price fromWindow(Order order, String timing, LocalDate session, Timed timed, TradingCalendar calendar) {
        boolean open = PaperBooks.NEXT_OPEN.equals(timing);
        if ((!open && KrTimedLadder.hourly(timing) == null) || !usable(order, session, timed, calendar)) {
            return null;
        }
        return fromTarget(order, targetAt(timing, order.createdAt(), session, calendar), session, timed, calendar,
                open ? RUNG_OPEN : RUNG_AT);
    }

    /**
     * 기준 시각 T 하나의 반사실 — 저장본의 T 창(라벨 T+1~T+5)에서 R1(라벨 T+1 봉 — 칸 {@code exactRung})·R2(창 안 첫 거래 봉 — {@value #RUNG_NEXT}).
     * T가 그날 개장 전·종가 단일가 시간·생성 + 60초 이전이거나, 창이 다 지나기 전에 받은 칸·창이 없는 칸이면 null. 칸을 쓸 수 있는지({@link #usable})는
     * 부르는 쪽이 먼저 봅니다.
     */
    private static Price fromTarget(Order order, Instant target, LocalDate session, Timed timed, TradingCalendar calendar,
                                    String exactRung) {
        if (target == null || target.isBefore(calendar.openInstant(session))
                || !target.isBefore(calendar.closeInstant(session).minus(KrTimedLadder.CLOSING_AUCTION))) {
            return null;                                   // 장 시간 변경일 — 개장 전·종가 단일가 시각
        }
        if (!target.isAfter(order.createdAt().plus(ExecutionAudit.AFTER_CREATED))) {
            return null;                                   // ⑤ 주문 생성 + 60초 이전의 시각
        }
        if (timed.fetchedAt().isBefore(target.plus(WINDOW_DONE))) {
            return null;                                   // ⑦ 창이 다 지나기 전에 받은 칸
        }
        LocalTime at = target.atZone(KrxCalendar.SEOUL).toLocalTime();
        List<Bar1m> window = timed.windows().get(KrTimedLadder.label(at));
        if (window == null) {
            return null;                                   // 그 창을 싣지 않은 칸(개장 창 전의 저장본)
        }
        String first = KrTimedLadder.label(at.plusMinutes(1));
        String last = KrTimedLadder.label(at.plusMinutes(WINDOW_DONE.toMinutes() - 1));
        for (Bar1m bar : window) {
            if (!bar.traded() || bar.label().compareTo(first) < 0 || bar.label().compareTo(last) > 0) {
                continue;                                  // 거래 없는 봉 · 창 밖 라벨
            }
            Instant start;
            try {
                start = ZonedDateTime.of(session, LocalTime.parse(bar.label()).minusMinutes(1), KrxCalendar.SEOUL).toInstant();
            } catch (DateTimeParseException e) {
                continue;
            }
            boolean exact = first.equals(bar.label());
            return new Price(bar.open().doubleValue(), start, exact ? exactRung : RUNG_NEXT);
        }
        return null;
    }

    /**
     * 종가 반사실 — 마감 단일가 봉 종가(클래스 설명). 못 구하면 null.
     *
     * @param nxt 그 종목이 NXT 종목인가(지금 관측치의 종목 칸, 모르면 null)
     */
    static Price fromClose(Order order, LocalDate session, Timed timed, Boolean nxt, TradingCalendar calendar) {
        if (nxt == null || !usable(order, session, timed, calendar)) {
            return null;
        }
        Instant close = calendar.closeInstant(session);
        if (!close.isAfter(order.createdAt().plus(ExecutionAudit.AFTER_CREATED))) {
            return null;                                   // ⑤
        }
        if (timed.fetchedAt().isBefore(close.plus(KrTimedLadder.CLOSE_COVERED_AFTER))) {
            return null;                                   // 마감 봉을 덮지 못한 이른 칸
        }
        LocalTime local = close.atZone(KrxCalendar.SEOUL).toLocalTime();
        Close1m bar = timed.closes().get(KrTimedLadder.label(nxt ? local.plusMinutes(1) : local));
        if (bar == null || bar.close() == null || bar.volume() == null || bar.volume() <= 0) {
            return null;
        }
        return new Price(bar.close().doubleValue(), close, RUNG_CLOSE);
    }

    /**
     * 주문 하나의 반사실 전부 — {@link #TIMINGS} 순서의 시점 → 가격(못 구하면 null). 상태가 없는 계산이고, 한 번 쓴 값을 지키는 것은 저장 쪽입니다
     * ({@code PaperStore.mergeOrderExec}).
     *
     * @param timed 그 종목의 E 칸(없으면 null)
     * @param nxt   그 종목이 NXT 종목인가(모르면 null)
     */
    static Map<String, Price> counterfactuals(Order order, Timed timed, Boolean nxt, TradingCalendar calendar) {
        LocalDate session = targetSession(order, calendar);
        Map<String, Price> out = new LinkedHashMap<>();
        for (String timing : TIMINGS) {
            out.put(timing, PaperBooks.NEXT_CLOSE.equals(timing) ? fromClose(order, session, timed, nxt, calendar)
                    : fromWindow(order, timing, session, timed, calendar));
        }
        return out;
    }

    /**
     * 늦게 풀었나({@code paper_order_exec.late_resolved} — 한국 계좌2만): 대체 체결({@link #FALLBACK_SOURCES})이면 참, 아니면 그 체결을 적은 관측치의 수집
     * 시각이 E 밤 한국 결정 기한 뒤면 참(1분봉이 그 밤에 없어 다음 밤에 체결 — 그사이 결정 게이트 ①이 막음). 계좌1·체결 없음·모름은 null.
     *
     * @param deadline E 밤 한국 결정 기한(그 실행 설정 판 — {@link KrPaperMarket#decisionWindow}, 모르면 null)
     */
    static Boolean lateResolved(Order order, ExecFill fill, Instant deadline) {
        if (!choosesTiming(order.bookCode()) || fill == null || fill.fill().priceSource() == null) {
            return null;
        }
        if (FALLBACK_SOURCES.contains(fill.fill().priceSource())) {
            return true;
        }
        if (deadline == null || fill.fill().observedAt() == null) {
            return null;
        }
        return fill.fill().observedAt().isAfter(deadline);
    }

    /** 그 칸을 쓸 수 있나 — 세션이 거래일이고 칸을 받았으며(OK) 주문 뒤에 받음(⑧). */
    private static boolean usable(Order order, LocalDate session, Timed timed, TradingCalendar calendar) {
        return session != null && timed != null && order.createdAt() != null && calendar.isTradingDay(session)
                && KrQuotes.TIMED_OK.equals(timed.status()) && timed.fetchedAt() != null
                && timed.fetchedAt().isAfter(order.createdAt());
    }
}
