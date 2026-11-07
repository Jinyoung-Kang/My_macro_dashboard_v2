package com.macrodash.feature.realtrade;

import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.collector.CollectorTradeClient.BrokerOrder;
import com.macrodash.collector.CollectorTradeClient.Reply;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.store.RealTradeStore;
import com.macrodash.store.RealTradeStore.Config;
import com.macrodash.store.RealTradeStore.OrderRow;
import com.macrodash.store.SchemaCheck;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/**
 * 실제 매매 시험의 공통 자리 — 테스트 DB(이름이 {@code _test}로 끝나야 함)의 {@code real_trade_*} 표, 움직이는 시계, 합성 수집기 응답. 종목·금액·주문 번호는
 * 모두 합성 값입니다.
 */
final class RealTradeFixtures {

    private RealTradeFixtures() {
    }

    static final ObjectMapper MAPPER = new ObjectMapper();
    static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    static final LocalDate SESSION = LocalDate.of(2026, 11, 6);
    static final String BOOK = "kr_claude2";
    static final String GENERATION = "2026-10-30|2026-10-29T13:00:00Z";

    static Instant kst(String local) {
        return LocalDateTime.parse(local).atZone(SEOUL).toInstant();
    }

    static BigDecimal d(String value) {
        return new BigDecimal(value);
    }

    static JdbcTemplate jdbc() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        return new JdbcTemplate(new DriverManagerDataSource(url, System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
    }

    static RealTradeStore store(JdbcTemplate jdbc) {
        return new RealTradeStore(jdbc, MAPPER, new SchemaCheck(jdbc));
    }

    /** 네 표를 비웁니다(이 기능만 쓰는 표). */
    static void clean(JdbcTemplate jdbc) {
        jdbc.update("DELETE FROM real_trade_orders");
        jdbc.update("DELETE FROM real_trade_batches");
        jdbc.update("DELETE FROM real_trade_events");
        jdbc.update("DELETE FROM real_trade_config");
        jdbc.update("DELETE FROM real_trade_valuation");
    }

    /** 한국 설정을 켜짐(따라 하는 책 {@link #BOOK}, 세대 {@link #GENERATION})으로. */
    static Config live(RealTradeStore store, boolean syncPending, BigDecimal baseline) {
        store.lockConfig("KR", current -> store.updateConfig(current.withState(RealTradeStore.STATE_LIVE).withSource(BOOK, GENERATION)
                .withSyncPending(syncPending).withBaselineEquity(baseline), 1L));
        return store.config("KR").orElseThrow();
    }

    /** 시험이 움직이는 시계. */
    static final class MutableClock extends Clock {
        Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void set(Instant at) {
            now = at;
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }

    /** 선점 흉내 — 받은 일을 바로 부름(장부 잠금·대기 확인은 PaperMirrorServiceTest가 봄). */
    @SuppressWarnings("unchecked")
    static void claimRunsInsert(PaperMirrorService paper) {
        when(paper.claim(anyString(), anyLong(), any(), any())).thenAnswer(inv -> Optional.ofNullable(((Supplier<Object>) inv.getArgument(3)).get()));
    }

    static CollectorTradeClient.Limits limits() {
        return new CollectorTradeClient.Limits(99_999_999L, 200, 999_999_999L, 999_999_999L);
    }

    /** 수집기 한도 네 값을 정해서 — 1건 상한, 하루 건수, 하루 매수 금액, 안전 상한. */
    static CollectorTradeClient.Limits limits(long maxOrderKrw, int maxOrdersPerDay, long maxBuyKrwPerDay, long maxEquityKrw) {
        return new CollectorTradeClient.Limits(maxOrderKrw, maxOrdersPerDay, maxBuyKrwPerDay, maxEquityKrw);
    }

    static Reply<CollectorTradeClient.Status> enabledStatus() {
        return enabledStatus(limits());
    }

    static Reply<CollectorTradeClient.Status> enabledStatus(CollectorTradeClient.Limits limits) {
        return Reply.of(new CollectorTradeClient.Status(true, null, limits, false, Instant.EPOCH));
    }

    static BrokerOrder broker(String orderId, String symbol, String side, String tif, String status, String qty, String filled,
                              Instant orderedAt, Instant filledAt) {
        return new BrokerOrder(orderId, symbol, side, "MARKET", tif, status, qty == null ? null : d(qty), filled == null ? null : d(filled),
                filled == null ? null : d("70000"), null, null, null, orderedAt, null, filledAt, "KRW");
    }

    /** 미종료 행 하나 — 정해 둔 칸 밖은 기본값. */
    static OrderRow row(long id, String purpose, String symbol, int attempt, String sendOutcome, String code, String tossOrderId,
                        boolean terminal, String filled, int quantity) {
        Instant at = kst("2026-11-06T09:00");
        return new OrderRow(id, "KR", SESSION, purpose, 1L, BOOK, GENERATION, null, null, symbol, "BUY", quantity, "DAY", d("70000"),
                attempt, "k" + id, "{}", sendOutcome, code, tossOrderId, terminal ? "FILLED" : null, terminal,
                filled == null ? null : d(filled), null, null, null, null, null, at, at, 1, null, null, 0, null, null, at, at);
    }

    static List<OrderRow> rows(OrderRow... rows) {
        return List.of(rows);
    }
}
