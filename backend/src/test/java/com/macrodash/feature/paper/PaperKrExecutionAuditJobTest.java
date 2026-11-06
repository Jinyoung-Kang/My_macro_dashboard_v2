package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.feature.paper.KrQuotes.Bar1m;
import com.macrodash.feature.paper.KrQuotes.Close1m;
import com.macrodash.feature.paper.KrQuotes.Day;
import com.macrodash.feature.paper.KrQuotes.Quote;
import com.macrodash.feature.paper.KrQuotes.Timed;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.activeBook;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 한국 실행 감사 정기 작업({@link PaperKrExecutionAuditJob} — 단계 2c, 명세 2026-11-02-kr-claude2-stage2 §11): 꺼짐·테이블 없음은 아무것도 안 함, 한국
 * Claude 계좌1·2 주문의 반사실을 시점마다 한 번만 씀(뒤 저장본은 빈 시점만 채움), 지연은 늘 null, 늦게 풂은 계좌2 체결에서 한 번, 감사 폭(최근 8일),
 * 장부 표를 쓰지 않음, 기록은 새로 쓴 때만(이름 kr.exec-audit). 판정 갈래 자체는 {@code KrExecutionAuditTest}.
 */
class PaperKrExecutionAuditJobTest {

    private static final LocalDate D = LocalDate.of(2026, 11, 2);
    private static final LocalDate E = LocalDate.of(2026, 11, 3);
    private static final Instant DECIDED = kst("2026-11-02T22:31");
    private static final Instant NIGHT = kst("2026-11-03T23:21");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = mock(PaperMarketData.class);
        when(marketData.krTimed()).thenReturn(Map.of());
        when(marketData.quotes(any(PaperMarket.class))).thenReturn(Optional.empty());
        activeBook(store, PaperBooks.KR_CLAUDE, PaperBooks.KIND_CLAUDE, 100_000_000, null);
        activeBook(store, PaperBooks.KR_CLAUDE2, PaperBooks.KIND_CLAUDE, 100_000_000, null);
    }

    private PaperKrExecutionAuditJob job(boolean enabled, Instant now) {
        return new PaperKrExecutionAuditJob(store, reader, marketData, new PaperConfig(enabled, PaperFixtures.FRI, 100_000), MAPPER,
                Clock.fixed(now, ZoneOffset.UTC));
    }

    private long order(String book, String ticker, String timing, LocalDate asOf, Instant createdAt) {
        return store.insertOrder(new Order(0, book, 1L, ticker, PaperBooks.BUY, null, 5.0, null, timing, "CLAUDE",
                PaperBooks.ORDER_PENDING, null, null, asOf, createdAt, asOf.plusDays(5), null));
    }

    private static Bar1m bar(String label, long open, long volume) {
        return new Bar1m(label, BigDecimal.valueOf(open), volume);
    }

    /** E 밤 칸 — 개장 R1, 10:00 R1, 15:31 마감 봉(그 밖 창은 비어 있음 — 13:00은 아직 없음). */
    private static Timed night(boolean withThirteen) {
        Map<String, List<Bar1m>> windows = new LinkedHashMap<>();
        windows.put("09:00", List.of(bar("09:01", 70_100, 900)));
        windows.put("10:00", List.of(bar("10:01", 71_000, 10)));
        if (withThirteen) {
            windows.put("13:00", List.of(bar("13:01", 73_000, 5)));
        }
        return new Timed(KrQuotes.TIMED_OK, null, NIGHT, windows, Map.of(),
                Map.of("15:31", new Close1m(BigDecimal.valueOf(75_600), 3_000L)));
    }

    private void timed(String ticker, Timed entry) {
        when(marketData.krTimed()).thenReturn(Map.of(ticker, Map.of(E, entry)));
    }

    private void nxt(String ticker, boolean nxt) {
        Day day = new Day(E, BigDecimal.valueOf(70_000), BigDecimal.valueOf(75_600), 1_000L, KrQuotes.SOURCE_INTEGRATED, null, null);
        Quote quote = new Quote(ticker, NIGHT, "STOCK", nxt, false, List.of(day), "KOSPI", null);
        Bar bar = new Bar(ticker, E, 75_600, false, null, quote);
        when(marketData.quotes(any(PaperMarket.class))).thenReturn(Optional.of(new Quotes(NIGHT, Map.of(ticker, bar), E, Set.of())));
    }

    private JsonNode cf(long orderId) {
        return store.execs.get(orderId).cf();
    }

    @Test
    @DisplayName("꺼져 있으면(PAPER_ENABLED=false — 로컬) 정기 실행은 저장본도 표도 읽지 않고 아무것도 쓰지 않는다 · 테이블이 없으면 건너뜀")
    void disabledAndNotReady() {
        order(PaperBooks.KR_CLAUDE, "005930", PaperBooks.NEXT_OPEN, D, DECIDED);
        job(false, NIGHT.plusSeconds(600)).scheduledRun();
        verify(reader, never()).quietly(any());
        verify(marketData, never()).krTimed();
        assertThat(store.execs).isEmpty();
        assertThat(store.jobRuns).isEmpty();

        store.ready = false;
        assertThat(job(true, NIGHT.plusSeconds(600)).run().skippedReason()).contains("테이블");
        verify(reader, never()).read(any(), anyLong(), any());
        assertThat(store.execs).isEmpty();
    }

    @Test
    @DisplayName("계좌1·2 주문마다 시점별 반사실을 한 번 쓰고(기준 시각·지연 null), 같은 저장본이면 다시 쓰지 않으며 뒤 저장본은 빈 시점만 채운다 — 기록은 쓴 때만")
    void writesOncePerTiming() {
        long book1 = order(PaperBooks.KR_CLAUDE, "005930", PaperBooks.NEXT_OPEN, D, DECIDED);
        long book2 = order(PaperBooks.KR_CLAUDE2, "005930", PaperBooks.AT_1300, D, DECIDED);
        timed("005930", night(false));
        nxt("005930", true);

        PaperKrExecutionAuditJob.Outcome first = job(true, NIGHT.plusSeconds(600)).run();

        assertThat(first.orders()).isEqualTo(2);
        assertThat(first.rowsWritten()).isEqualTo(2);
        assertThat(cf(book1).path(PaperBooks.NEXT_OPEN).path("raw").asDouble()).isEqualTo(70_100);
        assertThat(cf(book1).path(PaperBooks.NEXT_OPEN).path("rung").asString()).isEqualTo(KrExecutionAudit.RUNG_OPEN);
        assertThat(cf(book1).path(PaperBooks.AT_1000).path("raw").asDouble()).isEqualTo(71_000);
        assertThat(cf(book1).path(PaperBooks.AT_1300).isNull()).as("아직 없는 창 — null(0이 아님)").isTrue();
        assertThat(cf(book1).path(PaperBooks.NEXT_CLOSE).path("raw").asDouble()).isEqualTo(75_600);
        assertThat(store.execs.get(book2).targetAt()).isEqualTo(kst("2026-11-03T13:00"));
        assertThat(store.execs.get(book1).targetAt()).as("시가 — 그날 개장").isEqualTo(kst("2026-11-03T09:00"));
        assertThat(store.execs.get(book1).lagSeconds()).isNull();
        assertThat(store.jobRuns).hasSize(1);
        assertThat(store.jobRuns.get(0).job()).isEqualTo("kr.exec-audit");
        assertThat(store.jobRuns.get(0).detail().path("rowsWritten").asInt()).isEqualTo(2);

        PaperKrExecutionAuditJob.Outcome same = job(true, NIGHT.plusSeconds(900)).run();
        assertThat(same.rowsWritten()).isZero();
        assertThat(store.jobRuns).as("새로 쓴 것이 없으면 기록하지 않음").hasSize(1);

        // 뒤 저장본 — 13:00 창이 생기고 시가 값은 바뀜(이미 쓴 시점은 그대로).
        Map<String, List<Bar1m>> windows = new LinkedHashMap<>(night(true).windows());
        windows.put("09:00", List.of(bar("09:01", 99_999, 900)));
        timed("005930", new Timed(KrQuotes.TIMED_OK, null, NIGHT.plusSeconds(3600), windows, Map.of(), night(true).closes()));
        PaperKrExecutionAuditJob.Outcome later = job(true, NIGHT.plusSeconds(3900)).run();
        assertThat(later.valuesFilled()).isEqualTo(2);
        assertThat(cf(book1).path(PaperBooks.NEXT_OPEN).path("raw").asDouble()).isEqualTo(70_100);
        assertThat(cf(book2).path(PaperBooks.AT_1300).path("raw").asDouble()).isEqualTo(73_000);
    }

    @Test
    @DisplayName("분 단위 지정 시각 주문의 행에는 자기 시각 반사실(AT_MINUTE)이 함께 실리고(취소된 주문도), 다른 주문의 행에는 그 키가 없다")
    void ownMinuteKeyOnlyOnMinuteOrders() {
        long minute = store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE2, 1L, "005930", PaperBooks.BUY, null, 5.0, null,
                PaperBooks.AT_MINUTE, "CLAUDE", "CANCELLED", null, null, D, DECIDED, D.plusDays(5), null, java.time.LocalTime.of(10, 47)));
        long open = order(PaperBooks.KR_CLAUDE, "005930", PaperBooks.NEXT_OPEN, D, DECIDED);
        Map<String, List<Bar1m>> windows = new LinkedHashMap<>(night(false).windows());
        windows.put("10:47", List.of(bar("10:48", 71_480, 30)));
        timed("005930", new Timed(KrQuotes.TIMED_OK, null, NIGHT, windows, Map.of(), night(false).closes()));
        nxt("005930", true);

        job(true, NIGHT.plusSeconds(600)).run();

        assertThat(cf(minute).path(KrExecutionAudit.OWN_MINUTE).path("raw").asDouble()).isEqualTo(71_480);
        assertThat(cf(minute).path(KrExecutionAudit.OWN_MINUTE).path("rung").asString()).isEqualTo(KrExecutionAudit.RUNG_AT);
        assertThat(store.execs.get(minute).targetAt()).isEqualTo(kst("2026-11-03T10:47"));
        assertThat(cf(open).has(KrExecutionAudit.OWN_MINUTE)).isFalse();
    }

    @Test
    @DisplayName("늦게 풂 — 계좌2 체결이 생기면 한 번(결정 기한 E+1 01:00 뒤 관측치로 체결이면 참), 계좌1은 null · 감사 폭 밖 주문은 보지 않음 · 장부 표는 쓰지 않음")
    void lateAndWindow() {
        long book1 = order(PaperBooks.KR_CLAUDE, "005930", PaperBooks.NEXT_OPEN, D, DECIDED);
        long book2 = order(PaperBooks.KR_CLAUDE2, "005930", PaperBooks.AT_1000, D, DECIDED);
        long old = order(PaperBooks.KR_CLAUDE2, "005930", PaperBooks.AT_1000, LocalDate.of(2026, 10, 20), kst("2026-10-20T22:31"));
        timed("005930", night(false));
        store.insertFill(new Fill(0, book2, PaperBooks.KR_CLAUDE2, "005930", PaperBooks.BUY, 10, 71_000, 71_000, 5, 710_000,
                kst("2026-11-04T23:30"), E, KrTimedLadder.SOURCE_AT, false, null));
        store.insertFill(new Fill(0, book1, PaperBooks.KR_CLAUDE, "005930", PaperBooks.BUY, 10, 70_100, 70_100, 5, 701_000,
                kst("2026-11-03T23:30"), E, KrQuotes.SOURCE_1M_OPEN, false, null));
        int orders = store.orders.size();
        int fills = store.fills.size();

        job(true, kst("2026-11-05T00:10")).run();

        assertThat(store.execs.get(book2).lateResolved()).as("다음 밤(11-04 23:30)에 체결 — 기한 11-04 01:00 뒤").isTrue();
        assertThat(store.execs.get(book1).lateResolved()).isNull();
        assertThat(store.execs).doesNotContainKey(old);
        assertThat(store.orders).hasSize(orders);
        assertThat(store.fills).hasSize(fills);
    }
}
