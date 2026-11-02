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

    private static ExecFill fill(String source, Instant observedAt) {
        Fill fill = new Fill(0, 1, PaperBooks.KR_CLAUDE2, "005930", PaperBooks.BUY, 10, 71_000, 71_000, 5, 710_000, observedAt, E,
                source, false, null);
        return new ExecFill(fill, null, null);
    }
}
