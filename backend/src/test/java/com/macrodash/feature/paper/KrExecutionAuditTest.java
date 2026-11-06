package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.ExecutionAudit.Price;
import com.macrodash.feature.paper.KrQuotes.Bar1m;
import com.macrodash.feature.paper.KrQuotes.Close1m;
import com.macrodash.feature.paper.KrQuotes.Timed;
import com.macrodash.store.PaperStore.ExecFill;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 실행 감사의 판정({@link KrExecutionAudit} — 단계 2c, 명세 2026-11-02-kr-claude2-stage2 §11): 시가·매시는 그 창의 R1(라벨 T+1 봉)·R2(창 안 첫 거래
 * 봉)만 — 대체 없음, 종가는 마감 단일가 봉(NXT 15:31·그 밖 15:30, NXT 여부 모르면 null), 주문 뒤·창이 다 지난 뒤 받은 칸만, 장 시간 변경일의 개장 창,
 * 늦게 풂은 계좌2만(대체 출처·결정 기한 뒤 체결).
 */
class KrExecutionAuditTest {

    private static final LocalDate D = LocalDate.of(2026, 11, 2);
    private static final LocalDate E = LocalDate.of(2026, 11, 3);
    private static final TradingCalendar CALENDAR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());
    /** E 밤 수집(kr_paper_timed — E 15:40 뒤). */
    private static final Instant NIGHT = kst("2026-11-03T23:21");
    /** 밤 결정(D 22:31)에 만든 주문 시각. */
    private static final Instant DECIDED = kst("2026-11-02T22:31");

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    private static Order order(String book, String timing, Instant createdAt) {
        return new Order(1, book, 1L, "005930", PaperBooks.BUY, null, 5.0, null, timing, "CLAUDE", PaperBooks.ORDER_PENDING, null,
                null, D, createdAt, LocalDate.of(2026, 11, 6), null);
    }

    private static Bar1m bar(String label, long open, long volume) {
        return new Bar1m(label, BigDecimal.valueOf(open), volume);
    }

    /** 개장 창 R1(09:01 거래), 10:00 창 R1 거래 없음 → R2 10:03, 11:00 창 전부 거래 없음, 12:00 창 없음, 마감 봉 15:30·15:31. */
    private static Timed timed(Instant fetchedAt) {
        Map<String, List<Bar1m>> windows = new LinkedHashMap<>();
        windows.put("09:00", List.of(bar("09:01", 70_100, 900), bar("09:02", 70_200, 50)));
        windows.put("10:00", List.of(bar("10:01", 71_000, 0), bar("10:02", 71_050, 0), bar("10:03", 71_100, 10)));
        windows.put("11:00", List.of(bar("11:01", 72_000, 0), bar("11:05", 72_050, 0)));
        windows.put("13:00", List.of(bar("13:01", 73_000, 5)));
        windows.put("14:00", List.of(bar("14:01", 74_000, 5)));
        windows.put("15:00", List.of(bar("15:06", 75_000, 5)));                  // 창 밖 라벨(방어) — 쓰지 않음
        Map<String, Bar1m> after = new LinkedHashMap<>();
        after.put("11:00", bar("11:07", 72_100, 30));                          // 대체(R2b) — 반사실에 쓰지 않음
        Map<String, Close1m> closes = Map.of("15:30", new Close1m(BigDecimal.valueOf(75_500), 2_000L),
                "15:31", new Close1m(BigDecimal.valueOf(75_600), 3_000L));
        return new Timed(KrQuotes.TIMED_OK, null, fetchedAt, windows, after, closes);
    }

    @Test
    @DisplayName("시가·매시는 창의 R1·R2만(대체 없음 — 창 안 거래가 없거나 창이 없으면 null), 시각은 봉 시작(라벨 − 1분), 종가는 NXT면 15:31·아니면 15:30")
    void ladder() {
        Map<String, Price> cf = KrExecutionAudit.counterfactuals(order(PaperBooks.KR_CLAUDE, PaperBooks.NEXT_OPEN, DECIDED),
                timed(NIGHT), true, CALENDAR);

        assertThat(cf.keySet()).containsExactlyElementsOf(KrExecutionAudit.TIMINGS);
        assertThat(cf.get(PaperBooks.NEXT_OPEN)).isEqualTo(new Price(70_100, kst("2026-11-03T09:00"), KrExecutionAudit.RUNG_OPEN));
        assertThat(cf.get(PaperBooks.AT_1000)).isEqualTo(new Price(71_100, kst("2026-11-03T10:02"), KrExecutionAudit.RUNG_NEXT));
        assertThat(cf.get(PaperBooks.AT_1100)).as("창 안 거래 없음 — 창 뒤 첫 거래 봉(대체)은 쓰지 않음").isNull();
        assertThat(cf.get(PaperBooks.AT_1200)).as("창 없음").isNull();
        assertThat(cf.get(PaperBooks.AT_1300)).isEqualTo(new Price(73_000, kst("2026-11-03T13:00"), KrExecutionAudit.RUNG_AT));
        assertThat(cf.get(PaperBooks.AT_1500)).as("창 밖 라벨").isNull();
        assertThat(cf.get(PaperBooks.NEXT_CLOSE)).isEqualTo(new Price(75_600, kst("2026-11-03T15:30"), KrExecutionAudit.RUNG_CLOSE));

        Order book1 = order(PaperBooks.KR_CLAUDE, PaperBooks.NEXT_OPEN, DECIDED);
        assertThat(KrExecutionAudit.fromClose(book1, E, timed(NIGHT), false, CALENDAR).raw()).as("NXT 아님 — 15:30").isEqualTo(75_500);
        assertThat(KrExecutionAudit.fromClose(book1, E, timed(NIGHT), null, CALENDAR)).as("NXT 여부 모름").isNull();
    }

    @Test
    @DisplayName("조건 — 기준 시각이 주문 생성 + 60초 이전·칸이 OK가 아님·주문 전에 받은 칸·창이 다 지나기 전·마감 + 10분 전 칸이면 null")
    void conditions() {
        // 장중 확인(E 10:30)이 낸 주문 — 시가·10:00은 이미 지난 시각, 11:00부터만.
        Map<String, Price> midday = KrExecutionAudit.counterfactuals(order(PaperBooks.KR_CLAUDE2, PaperBooks.MARKET, kst("2026-11-03T10:30")),
                timed(NIGHT), true, CALENDAR);
        assertThat(midday.get(PaperBooks.NEXT_OPEN)).isNull();
        assertThat(midday.get(PaperBooks.AT_1000)).isNull();
        assertThat(midday.get(PaperBooks.AT_1300)).isNotNull();
        assertThat(KrExecutionAudit.fromWindow(order(PaperBooks.KR_CLAUDE2, PaperBooks.AT_1300, kst("2026-11-03T12:59:30")),
                PaperBooks.AT_1300, E, timed(NIGHT), CALENDAR)).as("T ≤ 생성 + 60초").isNull();

        Order night = order(PaperBooks.KR_CLAUDE, PaperBooks.NEXT_OPEN, DECIDED);
        Timed failed = new Timed(KrQuotes.TIMED_FAILED, "HTTP 500", NIGHT, Map.of(), Map.of(), Map.of());
        assertThat(KrExecutionAudit.counterfactuals(night, failed, true, CALENDAR).values()).allMatch(java.util.Objects::isNull);
        assertThat(KrExecutionAudit.counterfactuals(night, null, true, CALENDAR).values()).allMatch(java.util.Objects::isNull);
        assertThat(KrExecutionAudit.counterfactuals(night, timed(kst("2026-11-02T22:30")), true, CALENDAR).values())
                .as("주문 전에 받은 칸").allMatch(java.util.Objects::isNull);

        Timed early = timed(kst("2026-11-03T13:05"));                          // 13:00 창이 다 지나기 전(13:06)
        assertThat(KrExecutionAudit.fromWindow(night, PaperBooks.AT_1000, E, early, CALENDAR)).isNotNull();
        assertThat(KrExecutionAudit.fromWindow(night, PaperBooks.AT_1300, E, early, CALENDAR)).isNull();
        assertThat(KrExecutionAudit.fromClose(night, E, timed(kst("2026-11-03T15:38")), true, CALENDAR)).as("마감 + 10분 전").isNull();
        assertThat(KrExecutionAudit.fromClose(night, E, timed(kst("2026-11-03T15:40")), true, CALENDAR)).isNotNull();

        Order noAsOf = new Order(1, PaperBooks.KR_CLAUDE, 1L, "005930", PaperBooks.BUY, null, 5.0, null, PaperBooks.NEXT_OPEN, "CLAUDE",
                PaperBooks.ORDER_PENDING, null, null, null, DECIDED, null, null);
        assertThat(KrExecutionAudit.counterfactuals(noAsOf, timed(NIGHT), true, CALENDAR).values()).allMatch(java.util.Objects::isNull);
        assertThat(KrExecutionAudit.targetAt(PaperBooks.NEXT_OPEN, DECIDED, null, CALENDAR)).isNull();
    }

    @Test
    @DisplayName("장 시간 변경일(10:00~16:30) — 시가 창 키는 10:00(라벨 10:01이 R1), 매시는 개장 이후·종가 단일가(16:20) 전만, 마감 봉은 16:30·16:31")
    void shiftedHours() {
        TradingCalendar shifted = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
                Map.of(E, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));
        Map<String, List<Bar1m>> windows = Map.of("10:00", List.of(bar("10:01", 71_000, 10)), "15:00", List.of(bar("15:01", 75_000, 10)));
        Map<String, Close1m> closes = Map.of("16:31", new Close1m(BigDecimal.valueOf(76_000), 10L));
        Timed timed = new Timed(KrQuotes.TIMED_OK, null, NIGHT, windows, Map.of(), closes);
        Map<String, Price> cf = KrExecutionAudit.counterfactuals(order(PaperBooks.KR_CLAUDE, PaperBooks.NEXT_OPEN, DECIDED), timed, true,
                shifted);

        assertThat(cf.get(PaperBooks.NEXT_OPEN)).isEqualTo(new Price(71_000, kst("2026-11-03T10:00"), KrExecutionAudit.RUNG_OPEN));
        assertThat(cf.get(PaperBooks.AT_1000)).isEqualTo(new Price(71_000, kst("2026-11-03T10:00"), KrExecutionAudit.RUNG_AT));
        assertThat(cf.get(PaperBooks.AT_1500)).isEqualTo(new Price(75_000, kst("2026-11-03T15:00"), KrExecutionAudit.RUNG_AT));
        assertThat(cf.get(PaperBooks.NEXT_CLOSE)).isEqualTo(new Price(76_000, kst("2026-11-03T16:30"), KrExecutionAudit.RUNG_CLOSE));

        // 보통 날 15:20~15:30은 종가 단일가 — 그 시각의 매시는 없음(검증기가 받지 않는 시각). 여기서는 13:00 개장일의 10:00·11:00.
        TradingCalendar late = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
                Map.of(E, new KrxCalendar.Hours(LocalTime.of(13, 0), LocalTime.of(18, 30))));
        assertThat(KrExecutionAudit.fromWindow(order(PaperBooks.KR_CLAUDE, PaperBooks.NEXT_OPEN, DECIDED), PaperBooks.AT_1000, E,
                timed(NIGHT), late)).as("개장 전 시각").isNull();
    }

    @Test
    @DisplayName("늦게 풂 — 계좌2만: 대체 출처(TOSS_1M_LATE·일봉 시가)면 참, E 밤 결정 기한 뒤 관측치로 체결했으면 참, 그 전이면 거짓, 계좌1·체결 없음은 null")
    void lateResolved() {
        Instant deadline = kst("2026-11-04T01:00");
        Order book2 = order(PaperBooks.KR_CLAUDE2, PaperBooks.AT_1000, DECIDED);
        assertThat(KrExecutionAudit.lateResolved(book2, fill(KrTimedLadder.SOURCE_AT, kst("2026-11-03T23:30")), deadline)).isFalse();
        assertThat(KrExecutionAudit.lateResolved(book2, fill(KrTimedLadder.SOURCE_AT, kst("2026-11-04T23:30")), deadline)).isTrue();
        assertThat(KrExecutionAudit.lateResolved(book2, fill(KrTimedLadder.SOURCE_LATE, kst("2026-11-03T23:30")), deadline)).isTrue();
        assertThat(KrExecutionAudit.lateResolved(book2, fill(KrQuotes.SOURCE_INTEGRATED, kst("2026-11-03T23:30")), deadline)).isTrue();
        assertThat(KrExecutionAudit.lateResolved(book2, fill(KrTimedLadder.SOURCE_AT, kst("2026-11-03T23:30")), null)).isNull();
        assertThat(KrExecutionAudit.lateResolved(book2, null, deadline)).isNull();
        assertThat(KrExecutionAudit.lateResolved(order(PaperBooks.KR_CLAUDE, PaperBooks.NEXT_OPEN, DECIDED),
                fill(KrQuotes.SOURCE_DAILY, kst("2026-11-03T23:30")), deadline)).as("계좌1").isNull();

        assertThat(KrExecutionAudit.auditedBooks()).containsExactly(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE2);
        assertThat(KrExecutionAudit.choosesTiming(PaperBooks.KR_CLAUDE2)).isTrue();
        assertThat(KrExecutionAudit.choosesTiming(PaperBooks.KR_CLAUDE)).isFalse();
    }

    /** 분 단위 지정 시각 주문(밤 결정 — 목표 세션 E의 그 시각, 시각이 없으면 null). */
    private static Order minute(String book, LocalTime at, Instant createdAt) {
        return new Order(1, book, 1L, "005930", PaperBooks.BUY, null, 5.0, null, PaperBooks.AT_MINUTE, "CLAUDE", PaperBooks.ORDER_PENDING,
                null, null, D, createdAt, LocalDate.of(2026, 11, 6), null, at);
    }

    @Test
    @DisplayName("분 단위 지정 시각 주문은 자기 시각 반사실(AT_MINUTE)을 끝에 덧붙임 — 그 시각 창의 R1·R2(대체 없음), 창 없음·시각 없음·생성 + 60초 이전·창이 다 지나기 전·종가 단일가면 null, 다른 시점 주문의 키는 TIMINGS 그대로")
    void ownMinuteCounterfactual() {
        Map<String, List<Bar1m>> windows = new LinkedHashMap<>();
        windows.put("10:47", List.of(bar("10:48", 71_480, 30), bar("10:49", 71_490, 5)));
        windows.put("13:12", List.of(bar("13:13", 73_120, 0), bar("13:15", 73_150, 8)));
        windows.put("15:20", List.of(bar("15:21", 75_200, 8)));
        Timed timed = new Timed(KrQuotes.TIMED_OK, null, NIGHT, windows, Map.of("13:12", bar("13:30", 73_300, 9)), Map.of());

        Map<String, Price> cf = KrExecutionAudit.counterfactuals(minute(PaperBooks.KR_CLAUDE, LocalTime.of(10, 47), DECIDED), timed, true,
                CALENDAR);
        List<String> keys = new java.util.ArrayList<>(KrExecutionAudit.TIMINGS);
        keys.add(KrExecutionAudit.OWN_MINUTE);
        assertThat(cf.keySet()).containsExactlyElementsOf(keys);
        assertThat(cf.get(KrExecutionAudit.OWN_MINUTE)).isEqualTo(new Price(71_480, kst("2026-11-03T10:47"), KrExecutionAudit.RUNG_AT));
        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE2, LocalTime.of(13, 12), DECIDED), E, timed, CALENDAR))
                .as("R1 거래 없음 → 창 안 첫 거래 봉(창 뒤 대체 봉은 쓰지 않음)")
                .isEqualTo(new Price(73_150, kst("2026-11-03T13:14"), KrExecutionAudit.RUNG_NEXT));

        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE, LocalTime.of(11, 11), DECIDED), E, timed, CALENDAR))
                .as("창 없음").isNull();
        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE, null, DECIDED), E, timed, CALENDAR)).as("시각 없음").isNull();
        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE2, LocalTime.of(10, 47), kst("2026-11-03T10:46:30")), E, timed,
                CALENDAR)).as("T ≤ 생성 + 60초(장중 판단이 막 낸 주문)").isNull();
        Timed early = new Timed(KrQuotes.TIMED_OK, null, kst("2026-11-03T10:52:59"), windows, Map.of(), Map.of());
        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE, LocalTime.of(10, 47), DECIDED), E, early, CALENDAR))
                .as("창이 다 지나기 전(T + 6분)에 받은 칸").isNull();
        Timed done = new Timed(KrQuotes.TIMED_OK, null, kst("2026-11-03T10:53"), windows, Map.of(), Map.of());
        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE, LocalTime.of(10, 47), DECIDED), E, done, CALENDAR)).isNotNull();
        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE, LocalTime.of(15, 20), DECIDED), E, timed, CALENDAR))
                .as("종가 단일가 시간(15:20~)").isNull();
        assertThat(KrExecutionAudit.fromOwnMinute(order(PaperBooks.KR_CLAUDE2, PaperBooks.AT_1300, DECIDED), E, timed, CALENDAR))
                .as("지정 시각 주문이 아님").isNull();
        assertThat(KrExecutionAudit.counterfactuals(order(PaperBooks.KR_CLAUDE2, PaperBooks.MARKET, kst("2026-11-03T10:30")), timed, true,
                CALENDAR).keySet()).as("다른 시점 주문 — 키 그대로(끈 판 행 불변)").containsExactlyElementsOf(KrExecutionAudit.TIMINGS);
    }

    @Test
    @DisplayName("장 시간 변경일(10:00~16:30)의 분 단위 지정 시각 — 16:10은 받고(종가 단일가 16:20 앞), 16:20은 null, 09:30(개장 전)도 null")
    void ownMinuteOnShiftedHours() {
        TradingCalendar shifted = new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(),
                Map.of(E, new KrxCalendar.Hours(LocalTime.of(10, 0), LocalTime.of(16, 30))));
        Map<String, List<Bar1m>> windows = Map.of("16:10", List.of(bar("16:11", 76_100, 10)), "16:20", List.of(bar("16:21", 76_200, 10)),
                "09:30", List.of(bar("09:31", 70_300, 10)));
        Timed timed = new Timed(KrQuotes.TIMED_OK, null, NIGHT, windows, Map.of(), Map.of());

        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE, LocalTime.of(16, 10), DECIDED), E, timed, shifted))
                .isEqualTo(new Price(76_100, kst("2026-11-03T16:10"), KrExecutionAudit.RUNG_AT));
        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE, LocalTime.of(16, 20), DECIDED), E, timed, shifted)).isNull();
        assertThat(KrExecutionAudit.fromOwnMinute(minute(PaperBooks.KR_CLAUDE, LocalTime.of(9, 30), DECIDED), E, timed, shifted)).isNull();
    }

    private static ExecFill fill(String source, Instant observedAt) {
        Fill fill = new Fill(0, 1, PaperBooks.KR_CLAUDE2, "005930", PaperBooks.BUY, 10, 71_000, 71_000, 5, 710_000, observedAt, E,
                source, false, null);
        return new ExecFill(fill, null, null);
    }
}
