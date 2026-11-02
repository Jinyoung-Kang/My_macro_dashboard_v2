package com.macrodash.feature.paper;

import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.net.URI;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 모의 매매 텔레그램 알림(사용자 요청 2026-11-02 — {@link PaperNotifyJob}·{@link PaperNotifications}·{@link PaperTelegram}).
 *  - 처음 켜면 지금 자리에서 시작(지난 일은 보내지 않음), 그 뒤 결정(요약·새 주문)·결정 없는 주문·체결을 일어난 순서로 한 통씩, 일어난 지 60초 지난 것만
 *  - 한 통이 실패하면 그 주기를 멈추고 거기까지만 자리를 옮김 → 다음 주기에 그 통부터
 *  - 설정 notify.telegram을 끄면 보내지 않고 자리만 옮김
 *  - 글: 미국 달러·한국 원, 한국 종목 이름(코드), 시점 이름, 링크(공개 주소가 있을 때만), 토큰은 실패 사유에 나오지 않음
 */
class PaperNotifyJobTest {

    static final class MovableClock extends Clock {
        Instant now;

        MovableClock(Instant now) {
            this.now = now;
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

    private static final Instant T0 = Instant.parse("2026-11-03T14:00:00Z");
    private static final String TOKEN = "123456:SECRET-token";

    private FakePaperStore store;
    private MovableClock clock;
    private final List<String> sent = new ArrayList<>();
    private int failNext;
    private PaperNotifyJob job;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        clock = new MovableClock(T0);
        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 계좌1", 100_000,
                LocalDate.of(2026, 10, 23), PaperBooks.ACTIVE, T0, Book.MARKET_US, "USD"));
        store.books.put(PaperBooks.KR_CLAUDE2, new Book(PaperBooks.KR_CLAUDE2, PaperBooks.KIND_CLAUDE, "한국 Claude 계좌2",
                100_000_000, LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE, T0, Book.MARKET_KR, "KRW"));
        PaperTelegram telegram = new PaperTelegram(TOKEN, "42", MAPPER, (URI uri, String json) -> {
            assertThat(uri.toString()).isEqualTo("https://api.telegram.org/bot" + TOKEN + "/sendMessage");
            if (failNext > 0) {
                failNext--;
                return new PaperTelegram.Reply(429, "{\"ok\":false,\"description\":\"Too Many Requests: retry after 3\"}");
            }
            assertThat(MAPPER.readTree(json).path("chat_id").asString()).isEqualTo("42");
            sent.add(MAPPER.readTree(json).path("text").asString());
            return new PaperTelegram.Reply(200, "{\"ok\":true}");
        });
        PaperMarketData marketData = mock(PaperMarketData.class);
        org.mockito.Mockito.when(marketData.krNames()).thenReturn(Map.of("005930", "삼성전자"));
        job = new PaperNotifyJob(store, PaperFixtures.quietReader(), marketData, telegram, PaperFixtures.config(), MAPPER, clock,
                millis -> { }, "https://example.invalid/");
    }

    private long decision(String book, Instant at, String status, String responseJson) {
        return store.insertDecisionIfAbsent(new Decision(0, book, LocalDate.of(2026, 11, 2), RuleBookService.SCHEDULED, at, status,
                "claude-sonnet-5-5", 1, 13, null, 60.0, null, null, null, MAPPER.readTree(responseJson), null, null, List.of(), true,
                1L, 0, null)).orElseThrow();
    }

    private long order(String book, Long decisionId, String ticker, String side, String timing, String source, Instant at) {
        return store.insertOrder(new Order(0, book, decisionId, ticker, side, null, "BUY".equals(side) ? 8.0 : null, null, timing,
                source, PaperBooks.ORDER_PENDING, null, null, LocalDate.of(2026, 11, 2), at, LocalDate.of(2026, 11, 5), null));
    }

    private long fill(String book, long orderId, String ticker, int qty, double price, Instant at) {
        boolean korea = book.startsWith("kr_");
        String side = store.orders.get(orderId).side();
        return store.insertFill(new Fill(0, orderId, book, ticker, side, qty, price, price, korea ? 0 : 5, qty * price, at,
                LocalDate.of(2026, 11, 3), korea ? KrTimedLadder.SOURCE_AT : "paper.quotes", false, at,
                korea ? BigDecimal.valueOf(106) : BigDecimal.ZERO, BigDecimal.ZERO, korea ? BigDecimal.valueOf(355) : BigDecimal.ZERO));
    }

    @Test
    @DisplayName("처음 켜면 지금 자리에서 시작 — 그 전 체결·결정은 보내지 않고, 그 뒤 것은 60초가 지난 뒤 일어난 순서(결정 → 체결)로 한 통씩")
    void startsAtNowThenSendsInOrder() {
        long old = order(PaperBooks.CLAUDE, null, "AAPL", "SELL", "NEXT_OPEN", PaperBooks.SOURCE_STOP, T0.minusSeconds(3_600));
        fill(PaperBooks.CLAUDE, old, "AAPL", 10, 230.0, T0.minusSeconds(3_000));
        assertThat(job.run().sent()).isZero();
        assertThat(sent).isEmpty();
        assertThat(store.jobRuns).singleElement().satisfies(r -> assertThat(r.detail().path("note").asString()).contains("처음 켬"));

        Instant at = T0.plusSeconds(120);
        long d = decision(PaperBooks.KR_CLAUDE2, at, ClaudeBookService.STATUS_OK,
                "{\"summary\":\"반도체 비중 확대\",\"targetEquityExposurePct\":70,\"orders\":[],\"noTradeReason\":null}");
        long o = order(PaperBooks.KR_CLAUDE2, d, "005930", "BUY", PaperBooks.AT_1000, "CLAUDE", at);
        fill(PaperBooks.KR_CLAUDE2, o, "005930", 10, 71_000, at.plusSeconds(5));
        clock.now = at.plusSeconds(30);
        assertThat(job.run().sent()).as("60초가 지나지 않음").isZero();

        clock.now = at.plusSeconds(120);
        PaperNotifyJob.Outcome outcome = job.run();
        assertThat(outcome.sent()).isEqualTo(2);
        assertThat(sent.get(0)).startsWith("[모의매매 결정] 한국 Claude 계좌2 (한국) · 기준일 2026-11-02 정기 결정 · 주문 있음(OK)")
                .contains("요약: 반도체 비중 확대").contains("목표 주식 노출 70%").contains("새 주문 1건")
                .contains("- 매수 삼성전자(005930) 목표 8% · 다음 거래일 10:00 KST")
                .endsWith("https://example.invalid/paper/kr/decisions");
        assertThat(sent.get(1)).startsWith("[모의매매 체결] 한국 Claude 계좌2 (한국)")
                .contains("매수 삼성전자(005930) 10주 @ 71,000원 = 710,000원").contains("비용 수수료 106원 · 슬리피지 355원")
                .contains("시점 다음 거래일 10:00 KST · 가격 출처 TOSS_1M_AT").contains("체결일 2026-11-03")
                .doesNotContain("KST KST")
                .endsWith("https://example.invalid/paper/kr/holdings");
        clock.now = at.plusSeconds(300);
        assertThat(job.run().sent()).as("다시 보내지 않음").isZero();
        assertThat(sent).hasSize(2);
    }

    @Test
    @DisplayName("한 통이 실패하면 그 주기를 멈추고 다음 주기에 그 통부터 — 실패 사유는 Bot API 설명, 토큰은 나오지 않음; 결정 없는 스탑 주문도 한 통")
    void failureRetriesFromThatMessage() {
        job.run();
        Instant at = T0.plusSeconds(60);
        long stop = order(PaperBooks.CLAUDE, null, "AAPL", "SELL", "NEXT_OPEN", PaperBooks.SOURCE_STOP, at);
        fill(PaperBooks.CLAUDE, stop, "AAPL", 10, 229.85, at.plusSeconds(10));
        clock.now = at.plusSeconds(200);
        failNext = 1;
        PaperNotifyJob.Outcome failed = job.run();
        assertThat(failed.sent()).isZero();
        assertThat(failed.error()).isEqualTo("HTTP 429 — Too Many Requests: retry after 3").doesNotContain(TOKEN);

        PaperNotifyJob.Outcome retried = job.run();
        assertThat(retried.sent()).isEqualTo(2);
        assertThat(sent.get(0)).startsWith("[모의매매 주문] Claude 계좌1 (미국) · 스탑").contains("매도 AAPL 전량 · 다음 세션 시가");
        assertThat(sent.get(1)).contains("매도 AAPL 10주 @ $229.85 = $2,298.50").contains("슬리피지 5bp(가격에 포함)")
                .contains("시점 다음 세션 시가");
    }

    @Test
    @DisplayName("설정 notify.telegram을 끄면 보내지 않고 자리만 옮김 — 다시 켜도 꺼져 있던 동안의 일은 오지 않음")
    void mutedAdvancesCursor() {
        job.run();
        ((ObjectNode) store.settings.body()).putObject("notify").put("telegram", false);
        long o = order(PaperBooks.CLAUDE, null, "MSFT", "SELL", "NEXT_OPEN", PaperBooks.SOURCE_STOP, T0.plusSeconds(10));
        fill(PaperBooks.CLAUDE, o, "MSFT", 3, 400.0, T0.plusSeconds(20));
        clock.now = T0.plusSeconds(200);
        PaperNotifyJob.Outcome muted = job.run();
        assertThat(muted.sent()).isZero();
        assertThat(muted.muted()).isEqualTo(2);
        ((ObjectNode) store.settings.body()).putObject("notify").put("telegram", true);
        clock.now = T0.plusSeconds(400);
        assertThat(job.run().sent()).isZero();
        assertThat(sent).isEmpty();
    }

    @Test
    @DisplayName("전송기 — 값이 하나라도 없으면 꺼짐, 연결 오류 글의 토큰은 가림, 4,000자를 넘으면 자름")
    void telegramTransport() {
        assertThat(new PaperTelegram("", "42", MAPPER, (u, j) -> null).configured()).isFalse();
        assertThat(new PaperTelegram(TOKEN, " ", MAPPER, (u, j) -> null).configured()).isFalse();
        PaperTelegram broken = new PaperTelegram(TOKEN, "42", MAPPER, (u, j) -> {
            throw new java.io.IOException("connect failed: " + u);
        });
        assertThat(broken.send("hello")).startsWith("IOException: connect failed").doesNotContain(TOKEN).contains("***");
        List<String> bodies = new ArrayList<>();
        PaperTelegram ok = new PaperTelegram(TOKEN, "42", MAPPER, (u, j) -> {
            bodies.add(MAPPER.readTree(j).path("text").asString());
            assertThat(MAPPER.readTree(j).path("disable_web_page_preview").asBoolean()).isTrue();
            return new PaperTelegram.Reply(200, "{\"ok\":true}");
        });
        assertThat(ok.send("가".repeat(5_000))).isNull();
        assertThat(bodies.get(0)).hasSize(PaperTelegram.MAX_CHARS).endsWith("…");
    }

    @Test
    @DisplayName("글 — 장중 확인 결정은 KEEP/REPLACE와 대신한 주문 수, 실패 결정은 오류, 출발 체결은 '사후 체결', 미국 매시 시점은 ET")
    void messageShapes() {
        Book us = store.books.get(PaperBooks.CLAUDE);
        Decision replace = new Decision(5, PaperBooks.CLAUDE, LocalDate.of(2026, 11, 2), RuleBookService.CHECKPOINT, T0, "OK", null, 1,
                13, null, null, null, null, null, MAPPER.readTree("{\"action\":\"REPLACE\",\"summary\":\"갭 실패\",\"supersededOrders\":[3,4]}"),
                null, null, List.of(), false, 1L, 0, null);
        assertThat(PaperNotifications.decision(replace, us, List.of(), Map.of(), null))
                .contains("장중 확인 · 주문 있음(OK)").contains("장중 확인 대신함(REPLACE) · 대신한 대기 주문 2건").contains("새 주문 없음")
                .doesNotContain("http");
        Decision failed = new Decision(6, PaperBooks.CLAUDE, LocalDate.of(2026, 11, 2), RuleBookService.SCHEDULED, T0, "API_ERROR", null,
                1, 13, null, null, null, null, null, MAPPER.createObjectNode(), null, "HTTP 529 overloaded", List.of(), false, 1L, 1, null);
        assertThat(PaperNotifications.decision(failed, us, List.of(), Map.of(), null)).contains("API 오류(API_ERROR)(재시도 1회)")
                .contains("오류: HTTP 529 overloaded");
        assertThat(PaperNotifications.timingName(PaperBooks.AT_1400, false)).isEqualTo("다음 세션 14:00 ET");
        assertThat(PaperNotifications.timingName(PaperBooks.MARKET, true)).isEqualTo("장중 시장가");
        Fill backfill = new Fill(1, 1, PaperBooks.CLAUDE, "SPY", "BUY", 3, 580.12, 580.0, 5, 1_740.36, T0, LocalDate.of(2026, 10, 23),
                "equity_close", true, T0, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO);
        assertThat(PaperNotifications.fill(backfill, us, null, Map.of(), "")).contains("시점 — · 가격 출처 equity_close · 사후 체결")
                .contains("3주 @ $580.12 = $1,740.36");
    }
}
