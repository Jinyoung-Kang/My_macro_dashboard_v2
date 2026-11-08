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
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 모의 매매 텔레그램 알림(사용자 요청 2026-11-02 — {@link PaperNotifyJob}·{@link PaperNotifications}·{@link PaperTelegram}).
 *  - 처음 켜면 지금 자리에서 시작(지난 일은 보내지 않음), 그 뒤 결정(요약·새 주문)·결정 없는 주문·체결을 일어난 순서로, 일어난 지 60초 지난 것만
 *  - 체결과 결정 없는 주문은 계좌·트랜잭션(만든 시각) 묶음마다 한 통(사용자 요청 2026-11-07), 결정은 결정마다 한 통 — 자리는 묶음 단위로만 옮김
 *  - 한 통이 실패하면 그 주기를 멈추고 거기까지만 자리를 옮김 → 다음 주기에 그 통부터
 *  - 설정 notify.telegram을 끄면 보내지 않고 자리만 옮김
 *  - 글: 미국 달러·한국 원, 한국 종목 이름(코드), 시점 이름, 링크(공개 주소가 있을 때만), 토큰은 실패 사유에 나오지 않음
 *  - 서식(사용자 요청 2026-11-03): HTML 서식으로 제목·항목 이름만 굵게, 항목 사이 빈 줄, 모델 글은 문장마다 한 줄(글자는 그대로), 값은 모두 엔티티로,
 *    텔레그램이 서식을 거절하면(400) 같은 글을 평문으로 한 번 더
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
        assertThat(sent.get(0)).isEqualTo(String.join("\n",
                "<b>[모의매매 결정] 한국 Claude 계좌2 (한국)</b>",
                "기준일 2026-11-02 · 정기 결정 · 주문 있음(OK)",
                "",
                "<b>요약</b>",
                "반도체 비중 확대",
                "",
                "<b>목표 주식 노출</b> 70%",
                "",
                "<b>새 주문 1건</b>",
                "- 매수 삼성전자(005930) 목표 8% · 다음 거래일 10:00 KST",
                "",
                "https://example.invalid/paper/kr/decisions"));
        assertThat(sent.get(1)).isEqualTo(String.join("\n",
                "<b>[모의매매 체결] 한국 Claude 계좌2 (한국) · 1건(매수 1)</b>",
                "- 매수 삼성전자(005930) 10주 @ 71,000원 = 710,000원 · 다음 거래일 10:00 KST",
                "",
                "매수 합 710,000원 · 비용 합 461원(수수료 106원 · 슬리피지 355원)",
                "체결일 2026-11-03 · 가격 출처 TOSS_1M_AT · 기록 2026-11-03 23:02 KST",
                "",
                "https://example.invalid/paper/kr/holdings"));
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
        assertThat(failed.error()).isEqualTo("US: HTTP 429 — Too Many Requests: retry after 3").doesNotContain(TOKEN);

        PaperNotifyJob.Outcome retried = job.run();
        assertThat(retried.sent()).isEqualTo(2);
        assertThat(sent.get(0)).startsWith("<b>[모의매매 주문] Claude 계좌1 (미국) · 스탑</b>\n매도 AAPL 전량 · 다음 세션 시가");
        assertThat(sent.get(1)).contains("- 매도 AAPL 10주 @ $229.85 = $2,298.50 · 다음 세션 시가 · 스탑")
                .contains("매도 합 $2,298.50 · 슬리피지 5bp(가격에 포함)");
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
    @DisplayName("전송기 — 값이 하나라도 없으면 꺼짐, 연결 오류 글의 토큰은 가림, 4,000자를 넘는 한 줄은 상한마다 끊어 여러 통(QA-168), 뒤 통 실패는 몇 번째인지")
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
            assertThat(MAPPER.readTree(j).path("parse_mode").asString()).isEqualTo("HTML");
            assertThat(MAPPER.readTree(j).path("link_preview_options").path("is_disabled").asBoolean()).isTrue();
            return new PaperTelegram.Reply(200, "{\"ok\":true}");
        });
        assertThat(ok.send("가".repeat(5_000))).isNull();
        assertThat(bodies).hasSize(2);
        assertThat(bodies.get(0)).hasSize(PaperTelegram.MAX_CHARS);
        assertThat(String.join("", bodies)).isEqualTo("가".repeat(5_000));
        int[] calls = {0};
        PaperTelegram secondFails = new PaperTelegram(TOKEN, "42", MAPPER, (u, j) -> ++calls[0] == 1
                ? new PaperTelegram.Reply(200, "{\"ok\":true}") : new PaperTelegram.Reply(429, "{\"ok\":false,\"description\":\"Too Many Requests\"}"));
        assertThat(secondFails.send("나".repeat(4_001))).isEqualTo("2/2통째 — HTTP 429 — Too Many Requests");
        assertThat(PaperTelegram.parts("짧은 글")).containsExactly("짧은 글");
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
                .contains("\n\n<b>오류</b>\nHTTP 529 overloaded");
        assertThat(PaperNotifications.timingName(PaperBooks.AT_1400, false)).isEqualTo("다음 세션 14:00 ET");
        assertThat(PaperNotifications.timingName(PaperBooks.MARKET, true)).isEqualTo("장중 시장가");
        // 분 단위 지정 시각(ADR 0027) — 이름만으로는 시각을 모르므로 주문의 target_local까지 적음. 'AT_ + 네 글자'로 읽지 않음.
        com.macrodash.store.PaperStore.Order minute = new com.macrodash.store.PaperStore.Order(9, PaperBooks.CLAUDE, 5L, "SPY", "BUY",
                null, 5.0, null, PaperBooks.AT_MINUTE, "CLAUDE", "PENDING", null, null, LocalDate.of(2026, 11, 2), T0, null, null,
                java.time.LocalTime.of(10, 47));
        assertThat(PaperNotifications.timingName(minute, false)).isEqualTo("지정 시각 10:47 ET");
        assertThat(PaperNotifications.timingName(minute, true)).isEqualTo("지정 시각 10:47 KST");
        assertThat(PaperNotifications.timingName(PaperBooks.AT_MINUTE, false)).as("시각 없이 이름만 — 글자 그대로").isEqualTo("AT_MINUTE");
        assertThat(PaperNotifications.timingName((com.macrodash.store.PaperStore.Order) null, false)).isNull();
        Fill backfill = new Fill(1, 1, PaperBooks.CLAUDE, "SPY", "BUY", 3, 580.12, 580.0, 5, 1_740.36, T0, LocalDate.of(2026, 10, 23),
                "equity_close", true, T0, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO);
        assertThat(PaperNotifications.fills(List.of(backfill), us, Map.of(), Map.of(), "")).contains("- 매수 SPY 3주 @ $580.12 = $1,740.36 · —\n")
                .contains("체결일 2026-10-23 · 가격 출처 equity_close · 사후 체결 · 기록 ");
        // 미국 매도 비용(ADR 0030) — SEC fee·FINRA TAF는 '세금'이 아니라 '제비용'
        Fill usSell = new Fill(2, 2, PaperBooks.CLAUDE, "BBB", "SELL", 100, 91.85405, 92.0, 5, 9_185.405, T0, LocalDate.of(2026, 11, 2),
                "paper.quotes", false, T0, new BigDecimal("9.19"), new BigDecimal("0.21"), BigDecimal.ZERO);
        assertThat(PaperNotifications.fills(List.of(usSell), us, Map.of(), Map.of(), "")).contains("비용 합 $9.40(수수료 $9.19 · 제비용 $0.21)")
                .doesNotContain("세금");
    }

    // QA-168: 사용자 보고(2026-11-03) — 결정 알림의 요약·주문 없음 사유가 '…'로 잘려 옴(요약 400자·사유 200자 상한, 응답 스키마는 1,200·600자).
    @Test
    @DisplayName("QA-168 결정 글은 요약·주문 없음 사유를 자르지 않고, 4,000자를 넘는 글은 줄 경계에서 나눠 모두 보낸다")
    void qa168FullTextIsSplitNotCut() {
        Book us = store.books.get(PaperBooks.CLAUDE);
        String summary = "요약".repeat(550);
        String reason = "사유".repeat(275);
        Decision noTrade = new Decision(7, PaperBooks.CLAUDE, LocalDate.of(2026, 11, 2), RuleBookService.SCHEDULED, T0, "NO_TRADE", null, 1,
                13, null, null, null, null, null, MAPPER.createObjectNode().put("summary", summary).put("noTradeReason", reason)
                .put("targetEquityExposurePct", 62), null, null, List.of(), false, 1L, 0, null);
        assertThat(PaperNotifications.decision(noTrade, us, List.of(), Map.of(), null)).contains("<b>요약</b>\n" + summary)
                .contains("<b>새 주문 없음</b>\n" + reason).doesNotContain("…");
        List<String> bodies = new ArrayList<>();
        PaperTelegram ok = new PaperTelegram(TOKEN, "42", MAPPER, (u, j) -> {
            bodies.add(MAPPER.readTree(j).path("text").asString());
            return new PaperTelegram.Reply(200, "{\"ok\":true}");
        });
        String lines = String.join("\n", Collections.nCopies(30, "가".repeat(199)));
        assertThat(ok.send(lines)).isNull();
        assertThat(bodies).hasSize(2).allSatisfy(body -> assertThat(body.length()).isLessThanOrEqualTo(PaperTelegram.MAX_CHARS));
        assertThat(String.join("\n", bodies)).isEqualTo(lines);
    }

    @Test
    @DisplayName("서식 — 모델 글은 문장 끝·원 숫자 목록 앞에서만 줄을 바꾸고(글자·소수점·약어 그대로), 장중 확인 요청·주문 근거도 항목으로, 값의 <·>·&는 엔티티")
    void readableParagraphs() {
        Book us = store.books.get(PaperBooks.CLAUDE);
        String summary = "직전 결정(10/30 RISK_OFF, 노출 20%) 대비 노출을 약 44%로 올린다. 바뀐 점: ① 브렌트 −11.6%로 유가 압력이 완화됐다 [사실]. "
                + "② 나스닥 −1.37%인데 XLP는 고점 부근이다 [사실]. 공급 충격인지는 가를 수 없다 [확인 필요]. 앞의 ①과 ②를 합치면 U.S. 소비주가 낫다.";
        assertThat(PaperNotifications.paragraphs(summary)).isEqualTo(String.join("\n",
                "직전 결정(10/30 RISK_OFF, 노출 20%) 대비 노출을 약 44%로 올린다.",
                "바뀐 점:",
                "① 브렌트 −11.6%로 유가 압력이 완화됐다 [사실].",
                "② 나스닥 −1.37%인데 XLP는 고점 부근이다 [사실].",
                "공급 충격인지는 가를 수 없다 [확인 필요].",
                "앞의 ①과 ②를 합치면 U.S. 소비주가 낫다."));
        assertThat(PaperNotifications.paragraphs("  첫 줄.\n\n\n\n둘째 줄  ")).isEqualTo("첫 줄.\n\n둘째 줄");

        ObjectNode response = MAPPER.createObjectNode().put("summary", "VIX < 20 & HY 3%p. 노출을 유지한다.").put("noTradeReason", "조건 미충족이다.");
        response.putObject("checkpointPlan").put("session", "2026-11-04").put("atEt", "12:00").put("status", "PLANNED")
                .put("reason", "갭이 크면 다시 본다. 아니면 그대로 둔다.");
        Decision d = new Decision(8, PaperBooks.CLAUDE, LocalDate.of(2026, 11, 3), RuleBookService.SCHEDULED, T0, "NO_TRADE", null, 1, 13,
                null, null, null, null, null, response, null, null, List.of(), false, 1L, 0, null);
        assertThat(PaperNotifications.decision(d, us, List.of(), Map.of(), null)).isEqualTo(String.join("\n",
                "<b>[모의매매 결정] Claude 계좌1 (미국)</b>",
                "기준일 2026-11-03 · 정기 결정 · 주문 없음(NO_TRADE)",
                "",
                "<b>요약</b>",
                "VIX &lt; 20 &amp; HY 3%p.",
                "노출을 유지한다.",
                "",
                "<b>새 주문 없음</b>",
                "조건 미충족이다.",
                "",
                "<b>장중 확인 요청</b>",
                "세션 2026-11-04 12:00 ET · PLANNED",
                "갭이 크면 다시 본다.",
                "아니면 그대로 둔다."));

        Order stop = new Order(9, PaperBooks.CLAUDE, null, "AAPL", "SELL", null, null, 1.0, "NEXT_OPEN", PaperBooks.SOURCE_STOP,
                PaperBooks.ORDER_PENDING, null, MAPPER.createObjectNode().put("note", "고점 대비 −12% <스탑> 발동이다. 다음 시가에 판다."),
                LocalDate.of(2026, 11, 3), T0, LocalDate.of(2026, 11, 4), null);
        assertThat(PaperNotifications.order(stop, us, Map.of(), "https://example.invalid/?a=1&b=2")).isEqualTo(String.join("\n",
                "<b>[모의매매 주문] Claude 계좌1 (미국) · 스탑</b>",
                "매도 AAPL 전량 · 다음 세션 시가",
                "",
                "<b>근거</b>",
                "고점 대비 −12% &lt;스탑&gt; 발동이다.",
                "다음 시가에 판다.",
                "",
                "https://example.invalid/?a=1&amp;b=2/paper/us/holdings"));
    }

    @Test
    @DisplayName("서식 — 텔레그램이 HTML을 거절하면(400) 태그를 떼고 엔티티를 되돌린 평문으로 한 번 더, 평문도 실패하면 그 사유, 400이 아니면 다시 보내지 않음")
    void htmlRejectedFallsBackToPlain() {
        assertThat(PaperTelegram.plain("<b>제목</b>\nVIX &lt; 20 &amp; 원문 &amp;lt;")).isEqualTo("제목\nVIX < 20 & 원문 &lt;");
        List<String> modes = new ArrayList<>();
        List<String> bodies = new ArrayList<>();
        PaperTelegram fallback = new PaperTelegram(TOKEN, "42", MAPPER, (u, j) -> {
            String mode = MAPPER.readTree(j).path("parse_mode").asString("");
            modes.add(mode);
            bodies.add(MAPPER.readTree(j).path("text").asString());
            return mode.equals("HTML") ? new PaperTelegram.Reply(400, "{\"ok\":false,\"description\":\"Bad Request: can't parse entities\"}")
                    : new PaperTelegram.Reply(200, "{\"ok\":true}");
        });
        assertThat(fallback.send("<b>제목</b>\nA &amp; B")).isNull();
        assertThat(modes).containsExactly("HTML", "");
        assertThat(bodies).containsExactly("<b>제목</b>\nA &amp; B", "제목\nA & B");

        PaperTelegram bothFail = new PaperTelegram(TOKEN, "42", MAPPER,
                (u, j) -> new PaperTelegram.Reply(400, "{\"ok\":false,\"description\":\"Bad Request: chat not found\"}"));
        assertThat(bothFail.send("글")).isEqualTo("HTTP 400 — Bad Request: chat not found");
        int[] calls = {0};
        PaperTelegram busy = new PaperTelegram(TOKEN, "42", MAPPER, (u, j) -> {
            calls[0]++;
            return new PaperTelegram.Reply(429, "{\"ok\":false,\"description\":\"Too Many Requests\"}");
        });
        assertThat(busy.send("글")).isEqualTo("HTTP 429 — Too Many Requests");
        assertThat(calls[0]).isEqualTo(1);
    }

    // QA-312: 리뷰 XC-2 — 장중 감시(ADR 0032)가 마감 10분 전 뒤에 낸 종가 STOP(NEXT_CLOSE, 만료 = 감지한 그 세션)을 주문·체결 알림이 '다음 거래일 종가'
    // (미국 '다음 세션 종가')로 적음. 실제로는 그날 종가에 팔리고 같은 알림의 근거 메모는 '그날 종가 매도'라 한 통 안에서 말이 엇갈림.
    @Test
    @DisplayName("QA-312 장중 감시 STOP의 시점 이름 — 종가 STOP은 '그날 종가', 시장가 STOP은 기준 시각(생성 + 60초 뒤 첫 분, 그 시장 시각)까지. "
            + "결정의 종가·밤 대체 지정 시각·감시 밖 STOP은 그대로")
    void qa312WatchStopTimingIsSameSession() {
        Book kr = store.books.get(PaperBooks.KR_CLAUDE2);
        Book us = store.books.get(PaperBooks.CLAUDE);
        Map<String, String> names = Map.of("005930", "삼성전자");
        LocalDate session = LocalDate.of(2026, 11, 3);
        ObjectNode watch = MAPPER.createObjectNode().put("trigger", "TRAILING_STOP").put("stopMode", PaperStopWatchJob.STOP_MODE)
                .put("note", "장중 감시 트레일링 스탑 −10%: 15:15 61000 · 15:20 60900 KST 두 번 모두 스탑가 61200(최고가 68000) 이하 → 그날 종가 매도");
        // 한국 15:21:30 KST 감지(마감 10분 전 뒤) → NEXT_CLOSE, 만료 = 그 세션
        Order krClose = new Order(11, PaperBooks.KR_CLAUDE2, null, "005930", "SELL", null, null, null, PaperBooks.NEXT_CLOSE,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, watch, session, Instant.parse("2026-11-03T06:21:30Z"), session, null);
        assertThat(PaperNotifications.order(krClose, kr, names, null)).contains("매도 삼성전자(005930) 전량 · 그날 종가")
                .contains("그날 종가 매도").doesNotContain("다음 거래일");
        Fill krFill = new Fill(21, 11, PaperBooks.KR_CLAUDE2, "005930", "SELL", 10, 60_800, 60_800, 0, 608_000, T0, session,
                KrTimedLadder.SOURCE_AT, false, T0, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO);
        assertThat(PaperNotifications.fills(List.of(krFill), kr, Map.of(11L, krClose), names, null)).contains(" · 그날 종가 · 스탑\n")
                .doesNotContain("다음 거래일");
        // 미국 15:56:10 ET 감지 → NEXT_CLOSE
        Order usClose = new Order(12, PaperBooks.CLAUDE, null, "AAPL", "SELL", null, null, null, PaperBooks.NEXT_CLOSE,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, watch, session, Instant.parse("2026-11-03T20:56:10Z"), session, null);
        assertThat(PaperNotifications.orderLine(usClose, Map.of(), false)).isEqualTo("매도 AAPL 전량 · 그날 종가");
        // 장중 시장가 STOP — 기준 시각 T = (생성 + 60초)를 분으로 내린 뒤 + 1분(ExecutionAudit.marketTarget), 그 시장 시각으로
        Order krMarket = new Order(13, PaperBooks.KR_CLAUDE2, null, "005930", "SELL", null, null, null, PaperBooks.MARKET,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, watch, session, Instant.parse("2026-11-03T01:05:10Z"), session, null);
        assertThat(PaperNotifications.timingName(krMarket, true)).isEqualTo("장중 시장가 10:07 KST");
        Order usMarket = new Order(14, PaperBooks.CLAUDE, null, "AAPL", "SELL", null, null, null, PaperBooks.MARKET,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, watch, session, Instant.parse("2026-11-03T15:22:30Z"), session, null);
        assertThat(PaperNotifications.timingName(usMarket, false)).isEqualTo("장중 시장가 10:24 ET");

        // 그대로인 것 — 결정이 낸 다음 거래일 종가, 밤 대체 STOP(다음 거래일 첫 분 지정 시각), 감시 근거가 없는 종가 STOP, 장중 확인의 시장가
        Order decided = new Order(15, PaperBooks.KR_CLAUDE2, 5L, "005930", "SELL", null, null, null, PaperBooks.NEXT_CLOSE,
                PaperBooks.KIND_CLAUDE, PaperBooks.ORDER_PENDING, null, null, session, Instant.parse("2026-11-03T13:40:00Z"),
                LocalDate.of(2026, 11, 4), null);
        assertThat(PaperNotifications.timingName(decided, true)).isEqualTo("다음 거래일 종가");
        Order night = new Order(16, PaperBooks.KR_CLAUDE2, null, "005930", "SELL", null, null, null, PaperBooks.AT_MINUTE,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null,
                MAPPER.createObjectNode().put("stopMode", PaperLedgerService.STOP_MODE_NIGHT_FALLBACK), session,
                Instant.parse("2026-11-03T13:30:00Z"), LocalDate.of(2026, 11, 6), null, java.time.LocalTime.of(9, 10));
        assertThat(PaperNotifications.timingName(night, true)).isEqualTo("지정 시각 09:10 KST");
        Order plainStop = new Order(17, PaperBooks.CLAUDE, null, "AAPL", "SELL", null, null, null, PaperBooks.NEXT_CLOSE,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, MAPPER.createObjectNode().put("trigger", "TRAILING_STOP"), session,
                T0, LocalDate.of(2026, 11, 4), null);
        assertThat(PaperNotifications.timingName(plainStop, false)).isEqualTo("다음 세션 종가");
        Order checkpoint = new Order(18, PaperBooks.CLAUDE, 6L, "AAPL", "SELL", null, null, null, PaperBooks.MARKET,
                PaperBooks.KIND_CLAUDE, PaperBooks.ORDER_PENDING, null, null, session, Instant.parse("2026-11-03T15:22:30Z"), session, null);
        assertThat(PaperNotifications.timingName(checkpoint, false)).isEqualTo("장중 시장가");
    }

    // ------------------------------------------------------------------ 묶음(사용자 요청 2026-11-07 — 체결·결정 없는 주문은 계좌·트랜잭션마다 한 통)

    /** 비용 칸을 정해 넣는 체결 — 만든 시각 {@code at}이 같으면 한 트랜잭션(DB now())으로 봄. */
    private long fill(String book, long orderId, String ticker, int qty, double price, double bp, String source, Instant at, String fee,
                      String tax, String slip) {
        String side = store.orders.get(orderId).side();
        return store.insertFill(new Fill(0, orderId, book, ticker, side, qty, price, price, bp, qty * price, at, LocalDate.of(2026, 11, 3),
                source, false, at, new BigDecimal(fee), new BigDecimal(tax), new BigDecimal(slip)));
    }

    /** 두 시장 가운데 가장 앞선 자리 — 한 시장만 쓰는 시험에서는 그 시장의 자리. */
    private long lastCursor(String field) {
        var cursors = store.jobRuns.get(store.jobRuns.size() - 1).detail().path("cursors");
        return Math.max(cursors.path(Book.MARKET_US).path(field).asLong(), cursors.path(Book.MARKET_KR).path(field).asLong());
    }

    @Test
    @DisplayName("묶음 — 한 트랜잭션의 두 계좌는 두 통, 한 계좌의 두 트랜잭션도 두 통, 자리는 마지막 묶음의 가장 큰 체결 번호")
    void fillsGroupedPerBookAndTransaction() {
        job.run();
        Instant t1 = T0.plusSeconds(60);
        long a1 = order(PaperBooks.CLAUDE, 999L, "SPY", "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t1);
        long a2 = order(PaperBooks.CLAUDE, 999L, "QQQ", "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t1);
        long b1 = order(PaperBooks.KR_CLAUDE2, 999L, "005930", "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t1);
        long c1 = order(PaperBooks.CLAUDE, 999L, "IWM", "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t1);
        long c2 = order(PaperBooks.CLAUDE, 999L, "DIA", "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t1);
        fill(PaperBooks.CLAUDE, a1, "SPY", 1, 580.0, t1);
        fill(PaperBooks.CLAUDE, a2, "QQQ", 1, 500.0, t1);
        fill(PaperBooks.KR_CLAUDE2, b1, "005930", 10, 71_000, t1);
        fill(PaperBooks.CLAUDE, c1, "IWM", 1, 220.0, t1.plusSeconds(300));
        long last = fill(PaperBooks.CLAUDE, c2, "DIA", 1, 430.0, t1.plusSeconds(310));
        clock.now = t1.plusSeconds(600);
        PaperNotifyJob.Outcome outcome = job.run();
        assertThat(outcome.sent()).isEqualTo(4);
        assertThat(sent.get(0)).startsWith("<b>[모의매매 체결] Claude 계좌1 (미국) · 2건(매수 2)</b>\n- 매수 SPY 1주 @ $580.00 = $580.00 · 다음 세션 시가\n"
                + "- 매수 QQQ 1주 @ $500.00 = $500.00 · 다음 세션 시가\n\n매수 합 $1,080.00 · 슬리피지 5bp(가격에 포함)\n");
        assertThat(sent.get(1)).startsWith("<b>[모의매매 체결] 한국 Claude 계좌2 (한국) · 1건(매수 1)</b>\n- 매수 삼성전자(005930) 10주");
        assertThat(sent.get(2)).startsWith("<b>[모의매매 체결] Claude 계좌1 (미국) · 1건(매수 1)</b>\n- 매수 IWM ");
        assertThat(sent.get(3)).startsWith("<b>[모의매매 체결] Claude 계좌1 (미국) · 1건(매수 1)</b>\n- 매수 DIA ");
        assertThat(lastCursor("fillId")).isEqualTo(last);
        clock.now = t1.plusSeconds(900);
        assertThat(job.run().sent()).as("다시 보내지 않음").isZero();
    }

    @Test
    @DisplayName("묶음 — 한국 밤 한 계좌의 매도·매수(스탑 포함)는 한 통: 매도 먼저, 합계 줄(매도 합·매수 합·비용 합과 칸), 체결일·출처·기록 한 번, 링크 한 번")
    void krNightBatchIsOneMessage() {
        job.run();
        Instant detected = T0.plusSeconds(30);
        Instant ledger = T0.plusSeconds(60);
        long stop = store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE2, null, "000660", "SELL", null, null, null, PaperBooks.AT_MINUTE,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null,
                MAPPER.createObjectNode().put("stopMode", PaperLedgerService.STOP_MODE_NIGHT_FALLBACK).put("note", "밤 잠정 종가 스탑"),
                LocalDate.of(2026, 11, 2), detected, LocalDate.of(2026, 11, 5), null, java.time.LocalTime.of(9, 10)));
        long buy = order(PaperBooks.KR_CLAUDE2, 999L, "005930", "BUY", PaperBooks.AT_1000, "CLAUDE", detected);
        long sell = order(PaperBooks.KR_CLAUDE2, 999L, "035420", "SELL", PaperBooks.NEXT_OPEN, "CLAUDE", detected);
        String at = KrTimedLadder.SOURCE_AT;
        fill(PaperBooks.KR_CLAUDE2, buy, "005930", 10, 71_000, 0, at, ledger, "106", "0", "355");
        fill(PaperBooks.KR_CLAUDE2, stop, "000660", 5, 200_000, 0, at, ledger, "150", "2000", "500");
        long last = fill(PaperBooks.KR_CLAUDE2, sell, "035420", 2, 150_000, 0, at, ledger, "45", "600", "150");
        clock.now = T0.plusSeconds(300);
        assertThat(job.run().sent()).isEqualTo(2);
        assertThat(sent.get(0)).as("결정 없는 스탑 주문 — 한 건짜리 묶음은 예전 한 통 그대로")
                .startsWith("<b>[모의매매 주문] 한국 Claude 계좌2 (한국) · 스탑</b>\n매도 000660 전량 · 지정 시각 09:10 KST\n\n<b>근거</b>\n밤 잠정 종가 스탑");
        assertThat(sent.get(1)).isEqualTo(String.join("\n",
                "<b>[모의매매 체결] 한국 Claude 계좌2 (한국) · 3건(매도 2·매수 1)</b>",
                "- 매도 000660 5주 @ 200,000원 = 1,000,000원 · 지정 시각 09:10 KST · 스탑",
                "- 매도 035420 2주 @ 150,000원 = 300,000원 · 다음 거래일 시가",
                "- 매수 삼성전자(005930) 10주 @ 71,000원 = 710,000원 · 다음 거래일 10:00 KST",
                "",
                "매도 합 1,300,000원 · 매수 합 710,000원 · 비용 합 3,906원(수수료 301원 · 세금 2,600원 · 슬리피지 1,005원)",
                "체결일 2026-11-03 · 가격 출처 TOSS_1M_AT · 기록 2026-11-03 23:01 KST",
                "",
                "https://example.invalid/paper/kr/holdings"));
        assertThat(lastCursor("fillId")).isEqualTo(last);
        assertThat(lastCursor("orderId")).isEqualTo(stop);
    }

    @Test
    @DisplayName("묶음 — 미국 비용 합(수수료·제비용, 슬리피지는 체결가에 든 bp 범위), 가격 출처가 갈리면 체결 줄마다")
    void usBatchCosts() {
        job.run();
        Instant t = T0.plusSeconds(60);
        long sell = order(PaperBooks.CLAUDE, 999L, "BBB", "SELL", PaperBooks.NEXT_OPEN, "CLAUDE", t);
        long buy = order(PaperBooks.CLAUDE, 999L, "SPY", "BUY", PaperBooks.AT_1400, "CLAUDE", t);
        fill(PaperBooks.CLAUDE, buy, "SPY", 3, 580.12, 10, "paper.bars.us", t, "0", "0", "0");
        fill(PaperBooks.CLAUDE, sell, "BBB", 100, 91.8541, 5, "paper.quotes", t, "9.19", "0.21", "0");
        clock.now = T0.plusSeconds(300);
        assertThat(job.run().sent()).isOne();
        assertThat(sent.get(0)).isEqualTo(String.join("\n",
                "<b>[모의매매 체결] Claude 계좌1 (미국) · 2건(매도 1·매수 1)</b>",
                "- 매도 BBB 100주 @ $91.8541 = $9,185.41 · 다음 세션 시가 · 출처 paper.quotes",
                "- 매수 SPY 3주 @ $580.12 = $1,740.36 · 다음 세션 14:00 ET · 출처 paper.bars.us",
                "",
                "매도 합 $9,185.41 · 매수 합 $1,740.36 · 비용 합 $9.40(수수료 $9.19 · 제비용 $0.21) · 슬리피지 5~10bp(가격에 포함)",
                "체결일 2026-11-03 · 기록 2026-11-03 23:01 KST",
                "",
                "https://example.invalid/paper/us/holdings"));
    }

    @Test
    @DisplayName("묶음 — 결정 없는 주문도 계좌·트랜잭션마다 한 통(건수·주문 줄·종목별 근거), 다른 계좌는 따로")
    void ordersWithoutDecisionBatch() {
        job.run();
        Instant detected = Instant.parse("2026-11-03T06:21:30Z");
        LocalDate session = LocalDate.of(2026, 11, 3);
        List<Long> ids = new ArrayList<>();
        for (String ticker : List.of("005930", "000660")) {
            ids.add(store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE2, null, ticker, "SELL", null, null, null, PaperBooks.NEXT_CLOSE,
                    PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE)
                    .put("note", ticker + " 두 격자 모두 스탑가 아래 → 그날 종가 매도"), session, detected, session, null)));
        }
        long us = store.insertOrder(new Order(0, PaperBooks.CLAUDE, null, "AAPL", "SELL", null, null, null, PaperBooks.NEXT_OPEN,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, null, session, detected, session, null));
        clock.now = T0.plusSeconds(300);
        assertThat(job.run().sent()).isEqualTo(2);
        assertThat(sent.get(0)).isEqualTo(String.join("\n",
                "<b>[모의매매 주문] 한국 Claude 계좌2 (한국) · 스탑 · 2건</b>",
                "- 매도 삼성전자(005930) 전량 · 그날 종가",
                "- 매도 000660 전량 · 그날 종가",
                "",
                "<b>근거</b>",
                "- 삼성전자(005930): 005930 두 격자 모두 스탑가 아래 → 그날 종가 매도",
                "- 000660: 000660 두 격자 모두 스탑가 아래 → 그날 종가 매도",
                "",
                "https://example.invalid/paper/kr/holdings"));
        assertThat(sent.get(1)).isEqualTo(String.join("\n",
                "<b>[모의매매 주문] Claude 계좌1 (미국) · 스탑</b>",
                "매도 AAPL 전량 · 다음 세션 시가",
                "",
                "https://example.invalid/paper/us/holdings"));
        assertThat(lastCursor("orderId")).isEqualTo(us);
    }

    @Test
    @DisplayName("묶음 — 읽기 상한(500행)에 걸린 끝 묶음과 아직 안 지난 행이 이어지는 묶음은 다음 주기로(일부만 보내지 않음), 긴 묶음은 줄을 잃지 않고 여러 조각")
    void partialFetchNeverSplitsBatch() {
        job.run();
        Instant t1 = T0.plusSeconds(60);
        Instant t2 = T0.plusSeconds(120);
        long firstBatchLast = 0;
        for (int i = 0; i < 3; i++) {
            long o = order(PaperBooks.CLAUDE, 999L, "A" + i, "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t1);
            firstBatchLast = fill(PaperBooks.CLAUDE, o, "A" + i, 1, 10.0, t1);
        }
        long secondBatchLast = 0;
        int big = PaperNotifyJob.FETCH_LIMIT - 2;
        for (int i = 0; i < big; i++) {
            long o = order(PaperBooks.CLAUDE, 999L, "B" + i, "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t2);
            secondBatchLast = fill(PaperBooks.CLAUDE, o, "B" + i, 1, 10.0, t2);
        }
        clock.now = T0.plusSeconds(600);
        assertThat(job.run().sent()).as("둘째 묶음은 읽기 상한 너머로 이어짐 — 첫 묶음만").isOne();
        assertThat(sent).singleElement().satisfies(m -> assertThat(m).contains("· 3건(매수 3)"));
        assertThat(lastCursor("fillId")).isEqualTo(firstBatchLast);

        sent.clear();
        PaperNotifyJob.Outcome second = job.run();
        assertThat(second.sent()).as("한 통(보내는 쪽이 조각으로 나눔)").isOne();
        assertThat(sent.size()).isGreaterThan(1).isEqualTo(PaperTelegram.parts(String.join("\n", sent)).size());
        assertThat(sent).allSatisfy(part -> assertThat(part.length()).isLessThanOrEqualTo(PaperTelegram.MAX_CHARS));
        String joined = String.join("\n", sent);
        assertThat(joined).startsWith("<b>[모의매매 체결] Claude 계좌1 (미국) · " + big + "건(매수 " + big + ")</b>\n");
        assertThat(joined.lines().filter(line -> line.startsWith("- 매수 B")).count()).isEqualTo(big);
        assertThat(lastCursor("fillId")).isEqualTo(secondBatchLast);

        // 아직 안 지난 행이 이어지는 묶음(시각을 넣는 길의 작은 어긋남 — 2초 안) — 앞 행만 지났어도 묶음째 기다림
        sent.clear();
        Instant t3 = T0.plusSeconds(1_000);
        long x = order(PaperBooks.CLAUDE, 999L, "X", "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t3);
        long y = order(PaperBooks.CLAUDE, 999L, "Y", "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t3);
        fill(PaperBooks.CLAUDE, x, "X", 1, 10.0, t3);
        long yFill = fill(PaperBooks.CLAUDE, y, "Y", 1, 10.0, t3.plusMillis(1_500));
        clock.now = t3.plusSeconds(PaperNotifyJob.SETTLE_SECONDS).plusMillis(500);
        assertThat(job.run().sent()).isZero();
        assertThat(lastCursor("fillId")).isEqualTo(secondBatchLast);
        clock.now = t3.plusSeconds(PaperNotifyJob.SETTLE_SECONDS + 2);
        assertThat(job.run().sent()).isOne();
        assertThat(sent).singleElement().satisfies(m -> assertThat(m).contains("· 2건(매수 2)").contains("- 매수 X ").contains("- 매수 Y "));
        assertThat(lastCursor("fillId")).isEqualTo(yFill);
    }

    @Test
    @DisplayName("묶음 — 실패하면 자리를 그 묶음 앞에 두고 다음 주기에 묶음째 다시, 설정을 끄면 묶음마다 하나로 세고 자리만 옮김")
    void batchFailureAndMute() {
        job.run();
        Instant t = T0.plusSeconds(60);
        long cursorBefore = lastCursor("fillId");
        long o1 = order(PaperBooks.CLAUDE, 999L, "SPY", "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", t);
        long o2 = order(PaperBooks.CLAUDE, 999L, "QQQ", "SELL", PaperBooks.NEXT_OPEN, "CLAUDE", t);
        fill(PaperBooks.CLAUDE, o1, "SPY", 1, 580.0, t);
        long last = fill(PaperBooks.CLAUDE, o2, "QQQ", 1, 500.0, t);
        clock.now = T0.plusSeconds(300);
        failNext = 1;
        PaperNotifyJob.Outcome failed = job.run();
        assertThat(failed.sent()).isZero();
        assertThat(failed.error()).startsWith("US: HTTP 429");
        assertThat(lastCursor("fillId")).isEqualTo(cursorBefore);
        assertThat(job.run().sent()).isOne();
        assertThat(sent).singleElement().satisfies(m -> assertThat(m).contains("· 2건(매도 1·매수 1)").contains("- 매도 QQQ").contains("- 매수 SPY"));
        assertThat(lastCursor("fillId")).isEqualTo(last);

        ((ObjectNode) store.settings.body()).putObject("notify").put("telegram", false);
        Instant later = T0.plusSeconds(400);
        for (String ticker : List.of("IWM", "DIA", "TLT")) {
            long o = order(PaperBooks.CLAUDE, 999L, ticker, "BUY", PaperBooks.NEXT_OPEN, "CLAUDE", later);
            last = fill(PaperBooks.CLAUDE, o, ticker, 1, 100.0, later);
        }
        long stop = order(PaperBooks.CLAUDE, null, "GLD", "SELL", PaperBooks.NEXT_OPEN, PaperBooks.SOURCE_STOP, later);
        clock.now = T0.plusSeconds(700);
        PaperNotifyJob.Outcome muted = job.run();
        assertThat(muted.sent()).isZero();
        assertThat(muted.muted()).as("체결 묶음 하나 + 주문 묶음 하나").isEqualTo(2);
        assertThat(lastCursor("fillId")).isEqualTo(last);
        assertThat(lastCursor("orderId")).isEqualTo(stop);
        assertThat(sent).hasSize(1);
    }

    @Test
    @DisplayName("묶기 규칙 — 같은 책·만든 시각 2초 안·번호가 이어진 행만 한 묶음, 만든 시각이 없는 행은 혼자")
    void batchingRule() {
        Instant t = Instant.parse("2026-11-03T13:00:00Z");
        record Row(long id, String book, Instant at) {
        }
        List<Row> rows = List.of(new Row(1, "a", t), new Row(2, "a", t.plusSeconds(2)), new Row(3, "a", t.plusSeconds(3)),
                new Row(4, "b", t.plusSeconds(3)), new Row(5, "a", t.plusSeconds(3)), new Row(6, "a", null), new Row(7, "a", null));
        List<PaperNotifyJob.Batch<Row>> batches = PaperNotifyJob.batches(rows, 500, t.plusSeconds(3_600), Row::book, Row::at, Row::id);
        assertThat(batches).extracting(PaperNotifyJob.Batch::lastId).containsExactly(2L, 3L, 4L, 5L, 6L, 7L);
        assertThat(batches.get(0).rows()).hasSize(2);
        assertThat(PaperNotifyJob.batches(rows.subList(0, 3), 3, t.plusSeconds(3_600), Row::book, Row::at, Row::id))
                .as("읽은 행이 상한으로 꽉 차면 끝 묶음은 미룸").extracting(PaperNotifyJob.Batch::lastId).containsExactly(2L);
        assertThat(PaperNotifyJob.batches(rows.subList(0, 2), 2, t.plusSeconds(3_600), Row::book, Row::at, Row::id))
                .as("꽉 찬 읽기가 묶음 하나뿐이면 그대로(멈춰 서지 않게)").extracting(PaperNotifyJob.Batch::lastId).containsExactly(2L);
        assertThat(PaperNotifyJob.batches(rows, 500, t.plusSeconds(1), Row::book, Row::at, Row::id))
                .as("지나지 않은 행(2번)이 이어지는 묶음은 미룸").isEmpty();
    }

    // ------------------------------------------------------------------ 봇 네 개(사용자 요청 2026-11-08)
    private static final String US_TOKEN = "111:us-token";
    private static final String KR_TOKEN = "222:kr-token";

    /** 봇별 토큰을 둔 작업 — {@code delivered}에 (토큰, 글), {@code failing} 토큰은 429. */
    private PaperNotifyJob splitJob(Map<PaperTelegram.Channel, String> tokens, List<String[]> delivered, List<String> failing) {
        PaperTelegram telegram = new PaperTelegram(TOKEN, "42", tokens, MAPPER, (URI uri, String json) -> {
            String token = uri.toString().replace("https://api.telegram.org/bot", "").replace("/sendMessage", "");
            if (failing.contains(token)) {
                return new PaperTelegram.Reply(429, "{\"ok\":false,\"description\":\"Too Many Requests\"}");
            }
            assertThat(MAPPER.readTree(json).path("chat_id").asString()).as("대화방은 네 봇이 같음").isEqualTo("42");
            delivered.add(new String[] {token, MAPPER.readTree(json).path("text").asString()});
            return new PaperTelegram.Reply(200, "{\"ok\":true}");
        });
        return new PaperNotifyJob(store, PaperFixtures.quietReader(), mock(PaperMarketData.class), telegram, PaperFixtures.config(), MAPPER,
                clock, millis -> { }, "https://example.invalid/");
    }

    private void stopFill(String book, String ticker, Instant at) {
        long stop = order(book, null, ticker, "SELL", "NEXT_OPEN", PaperBooks.SOURCE_STOP, at);
        fill(book, stop, ticker, 10, 100.0, at);
    }

    @Test
    @DisplayName("시장별 봇 — 미국 계좌는 미국 봇, 한국 계좌는 한국 봇으로, 토큰이 없는 시장은 운영 봇으로")
    void routesEachMarketToItsBot() {
        List<String[]> delivered = new ArrayList<>();
        PaperNotifyJob split = splitJob(Map.of(PaperTelegram.Channel.US, US_TOKEN, PaperTelegram.Channel.KR, KR_TOKEN), delivered, List.of());
        split.run();
        Instant t = T0.plusSeconds(60);
        stopFill(PaperBooks.CLAUDE, "AAPL", t);
        stopFill(PaperBooks.KR_CLAUDE2, "005930", t.plusSeconds(10));
        clock.now = T0.plusSeconds(300);
        assertThat(split.run().error()).isNull();
        assertThat(delivered).isNotEmpty().allSatisfy(d -> assertThat(d[0]).isEqualTo(d[1].contains("(미국)") ? US_TOKEN : KR_TOKEN));
        assertThat(delivered).anySatisfy(d -> assertThat(d[0]).isEqualTo(US_TOKEN)).anySatisfy(d -> assertThat(d[0]).isEqualTo(KR_TOKEN));

        List<String[]> fallback = new ArrayList<>();
        PaperNotifyJob onlyUs = splitJob(Map.of(PaperTelegram.Channel.US, US_TOKEN, PaperTelegram.Channel.KR, " "), fallback, List.of());
        stopFill(PaperBooks.KR_CLAUDE2, "000660", T0.plusSeconds(400));
        clock.now = T0.plusSeconds(600);
        assertThat(onlyUs.run().error()).isNull();
        assertThat(fallback).isNotEmpty().allSatisfy(d -> assertThat(d[0]).as("토큰이 빈 한국 알림은 운영 봇").isEqualTo(TOKEN));
    }

    @Test
    @DisplayName("한 봇이 실패해도 다른 시장 알림은 나가고, 실패한 시장만 다음 주기에 그 통부터 다시 — 나간 시장은 두 번 가지 않음")
    void oneBotFailureDoesNotBlockTheOtherMarket() {
        List<String[]> delivered = new ArrayList<>();
        List<String> failing = new ArrayList<>(List.of(US_TOKEN));
        PaperNotifyJob split = splitJob(Map.of(PaperTelegram.Channel.US, US_TOKEN, PaperTelegram.Channel.KR, KR_TOKEN), delivered, failing);
        split.run();
        Instant t = T0.plusSeconds(60);
        stopFill(PaperBooks.CLAUDE, "AAPL", t);
        stopFill(PaperBooks.KR_CLAUDE2, "005930", t.plusSeconds(10));
        clock.now = T0.plusSeconds(300);

        PaperNotifyJob.Outcome failed = split.run();
        assertThat(failed.error()).startsWith("US: HTTP 429").doesNotContain(US_TOKEN);
        int korean = delivered.size();
        assertThat(korean).isPositive();
        assertThat(delivered).allSatisfy(d -> assertThat(d[0]).isEqualTo(KR_TOKEN));

        failing.clear();
        PaperNotifyJob.Outcome retried = split.run();
        assertThat(retried.error()).isNull();
        assertThat(delivered).hasSize(korean + retried.sent());
        assertThat(delivered.subList(korean, delivered.size())).isNotEmpty().allSatisfy(d -> assertThat(d[0]).isEqualTo(US_TOKEN));
        assertThat(split.run().sent()).isZero();
    }

    @Test
    @DisplayName("시장을 나누기 전 기록의 자리(cursor 하나)는 두 시장이 함께 이어받음 — 배포 사이의 일이 빠지지도 두 번 가지도 않음")
    void inheritsSharedCursorRecord() {
        Instant t = T0.plusSeconds(60);
        long oldStop = order(PaperBooks.CLAUDE, null, "MSFT", "SELL", "NEXT_OPEN", PaperBooks.SOURCE_STOP, t);
        long oldFill = fill(PaperBooks.CLAUDE, oldStop, "MSFT", 1, 400.0, t);
        ObjectNode detail = MAPPER.createObjectNode();
        detail.putObject("cursor").put("fillId", oldFill).put("orderId", oldStop).put("decidedAt", T0.toString()).put("decisionId", 0L);
        store.recordJobRun(PaperNotifyJob.JOB, T0, T0, "OK", detail);
        Instant later = T0.plusSeconds(120);
        stopFill(PaperBooks.CLAUDE, "AAPL", later);
        stopFill(PaperBooks.KR_CLAUDE2, "005930", later.plusSeconds(5));
        clock.now = T0.plusSeconds(400);

        assertThat(job.run().error()).isNull();
        assertThat(sent).noneSatisfy(m -> assertThat(m).contains("MSFT"));
        assertThat(sent).anySatisfy(m -> assertThat(m).contains("AAPL")).anySatisfy(m -> assertThat(m).contains("005930"));
        assertThat(store.jobRuns.get(store.jobRuns.size() - 1).detail().path("cursors").has(Book.MARKET_KR)).isTrue();
        assertThat(job.run().sent()).isZero();
    }
}
