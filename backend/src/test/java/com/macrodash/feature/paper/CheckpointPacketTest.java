package com.macrodash.feature.paper;

import com.macrodash.Golden;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Checkpoint;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Random;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 장중 확인 패킷({@link CheckpointPacket}, 계좌2 명세 §5-2·§7-3·§8 ⑨·§9-5) — 고정 시계·고정 재료로 조립만 봅니다(저장소·네트워크 없음).
 *
 * <p>시각: 아침 결정 d = 2026-10-30(금), 목표 세션 E = 11-02(월, 서머타임이 끝난 첫 거래일 — EST), 확인 10:30 ET = 15:30Z = 11-03 00:30 KST,
 * 조립 10:33:10 ET.
 */
class CheckpointPacketTest {

    private static final LocalDate D = LocalDate.of(2026, 10, 30);
    private static final LocalDate E = LocalDate.of(2026, 11, 2);
    private static final Instant ASSEMBLED = Instant.parse("2026-11-02T15:33:10Z");
    private static final Instant FETCHED = Instant.parse("2026-11-02T15:33:00Z");
    private static final Instant MORNING_CREATED = Instant.parse("2026-10-30T22:31:00Z");

    private static final String MORNING_PACKET = "{\"1_basis\":{\"selectionAsOf\":\"2026-10-23\",\"book\":\"claude2\"},"
            + "\"8_prices\":{\"columns\":[\"ticker\",\"role\"],\"rows\":[[\"AAPL\",\"HOLDING\"],[\"MSFT\",\"CANDIDATE\"],"
            + "[\"XLK\",\"ETF\"]]},\"12_hardRules\":{\"lines\":[\"…\"],\"maxWeightStockPct\":10,\"maxWeightEtfPct\":20,"
            + "\"maxPositions\":20,\"minOrderNotional\":500,\"maxDiscretionaryOrdersPerMonth\":20,\"minHoldTradingDaysForSell\":5,"
            + "\"trailingStopPct\":8,\"lockoutTradingDays\":20,\"cashLikeTickers\":[\"SHY\"],\"etfTickers\":[\"QQQ\",\"SHY\",\"SPY\",\"XLK\"],"
            + "\"lockedOut\":[],\"universeSize\":7,\"universe\":\"AAPL,MSFT,NVDA,QQQ,SHY,SPY,XLK\"}}";

    private static Checkpoint checkpoint(String feed, List<String> watch) {
        return new Checkpoint(PaperBooks.CLAUDE2, E, LocalTime.of(10, 30), feed, watch, "갭 뒤 거래량이 이어지나", 41L, null,
                PaperBooks.CHECKPOINT_PLANNED, null, null, null, null, null);
    }

    private static Decision morning() {
        return new Decision(41, PaperBooks.CLAUDE2, D, RuleBookService.SCHEDULED, MORNING_CREATED, "OK", "claude-sonnet-5-5",
                5, 12, LocalDate.of(2026, 10, 23), 40.0, null, null, null, null, null, null, List.of(), true, 900L, 0,
                MORNING_PACKET);
    }

    private static Order order(long id, String ticker, String side, String timing) {
        return new Order(id, PaperBooks.CLAUDE2, 41L, ticker, side, null, "BUY".equals(side) ? 5.0 : null,
                "SELL".equals(side) ? 0.5 : null, timing, "CLAUDE", PaperBooks.ORDER_PENDING, null, null, D, MORNING_CREATED,
                E, null);
    }

    private static List<Order> pending() {
        return List.of(order(101, "AAPL", "SELL", "NEXT_OPEN"), order(102, "NVDA", "BUY", "AT_1000"),
                order(103, "MSFT", "BUY", "AT_1100"), order(104, "XLK", "BUY", "NEXT_CLOSE"));
    }

    private static List<Fill> fills() {
        return List.of(new Fill(9, 102, PaperBooks.CLAUDE2, "NVDA", "BUY", 25, 180.09, 180.0, 5, 4_502.25,
                        Instant.parse("2026-11-02T15:20:00Z"), E, Datasets.SNAP_PAPER_BARS_US, false, null),
                new Fill(10, 101, PaperBooks.CLAUDE2, "AAPL", "SELL", 50, 229.9, 230.0, 5, 11_495.0,
                        Instant.parse("2026-11-02T15:40:00Z"), E, Datasets.SNAP_PAPER_BARS_US, false, null));
    }

    /** 수집기 모양(contract 1) 한 종목 — {@code from}부터 1분봉 {@code count}개(시작 시각, 오래된 것부터). */
    private static ObjectNode ticker(Instant fetchedAt, LocalDate session, Instant from, int count, double price, long volume) {
        ObjectNode entry = MAPPER.createObjectNode();
        entry.put("fetchedAt", fetchedAt.toString().replace("Z", "+00:00"));
        entry.put("session", session.toString());
        ArrayNode bars = entry.putArray("bars");
        for (int i = 0; i < count; i++) {
            double p = price + i * 0.1;
            bars.addObject().put("t", from.plusSeconds(60L * i).toString().replace("Z", "+00:00")).put("o", p)
                    .put("h", p + 0.2).put("l", p - 0.1).put("c", p + 0.05).put("v", i == count - 1 ? 0 : volume);
        }
        entry.putObject("day").put("open", price - 1).put("high", price + 5).put("low", price - 2);
        Instant last = from.plusSeconds(60L * (count - 1));
        entry.putObject("lastBar").put("t", last.toString().replace("Z", "+00:00")).put("c", price + (count - 1) * 0.1 + 0.05)
                .put("v", 0);
        return entry;
    }

    private static Snapshot watch(Instant collectedAt, ObjectNode tickers) {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("contract", 1).put("source", "Yahoo(yfinance) 1분봉").put("barLabel", "START").put("reference", "SPY");
        payload.putObject("checkpoint").put("book", PaperBooks.CLAUDE2).put("sessionDate", E.toString()).put("atEt", "10:30");
        payload.put("fetchedAt", collectedAt.toString()).put("lagSeconds", 75).putNull("declaredDelayMin");
        payload.set("tickers", tickers);
        payload.putArray("missing");
        return new Snapshot(Datasets.SNAP_PAPER_WATCH_US, payload, "snapshot", "OK", null, collectedAt);
    }

    private static ObjectNode watchTickers() {
        ObjectNode tickers = MAPPER.createObjectNode();
        Instant from = Instant.parse("2026-11-02T15:02:00Z");
        tickers.set("SPY", ticker(FETCHED, E, from, 30, 580.0, 120_000));
        tickers.set("NVDA", ticker(FETCHED, E, from, 30, 180.0, 50_000));
        tickers.set("AAPL", ticker(FETCHED, E, from, 30, 230.0, 30_000).put("isStale", true));
        // 지난 세션 봉(임시 휴장·이어받기) — E가 아니라 싣지 않음.
        tickers.set("MSFT", ticker(FETCHED, D, Instant.parse("2026-10-30T19:30:00Z"), 5, 520.0, 10_000));
        // 조립 뒤에 받은 종목(⑨) — 싣지 않음.
        tickers.set("QQQ", ticker(ASSEMBLED.plusSeconds(20), E, from, 31, 500.0, 90_000));
        return tickers;
    }

    private static CheckpointPacket.Inputs inputs(String feed, Optional<Snapshot> watch, List<Integer> lags) {
        return new CheckpointPacket.Inputs(checkpoint(feed, List.of("NVDA", "AAPL")), D, morning(),
                new BookState(PaperBooks.CLAUDE2, 60_000, 100_000, 40_000, 40, null, null, D, null),
                List.of(new Position(PaperBooks.CLAUDE2, "AAPL", 100, 225.5, D, MORNING_CREATED, 232, MORNING_CREATED, 230.0,
                        Instant.parse("2026-11-02T15:20:00Z"), false, null, 0, null)),
                pending(), fills(), watch,
                Optional.of(quotes(Instant.parse("2026-11-02T15:20:00Z"), bar("AAPL", E, 230.4), bar("MSFT", E, 521.0),
                        bar("NVDA", E, 181.2), bar("XLK", D, 280.0))),
                MAPPER.readTree("{\"source\":\"macro.collected\",\"cards\":[{\"key\":\"vix\",\"value\":17.2,\"delay\":\"15분 지연\"}]}"),
                5, 12, lags, UsMarketCalendar.CALENDAR, ASSEMBLED);
    }

    @Test
    @DisplayName("고정본(MINUTE): 섹션 일곱·판·지금 시각·남은 시점·대기 주문 상태(기준 시각 지남/대기)·조립 뒤 체결 빠짐·감시 자료(지난 세션·조립 뒤 받은 종목 빠짐, 최근 30봉), 잰 지연 등급 — 5세션 전이라 '지연 모름'")
    void goldenMinute() {
        PacketBuilder.Packet packet = CheckpointPacket.build(inputs("MINUTE",
                Optional.of(watch(FETCHED, watchTickers())), List.of(60, 70)), MAPPER);
        Golden.assertMatches("packet-us-claude2-checkpoint-minute.json", packet.text());
        JsonNode body = packet.body();
        List<String> keys = new ArrayList<>();
        body.propertyNames().forEach(keys::add);
        assertThat(keys).containsExactly("0_instructions", "1_basis", "2_macroCards", "3_request", "4_portfolio", "5_feed",
                "6_hardRules");
        JsonNode basis = body.get("1_basis");
        assertThat(basis.get("checkpointVersion").asInt()).isEqualTo(1);
        assertThat(basis.get("decisionKind").asString()).isEqualTo("CHECKPOINT");
        assertThat(basis.get("fixedRules").asString()).isEqualTo("c2-2");
        assertThat(basis.get("nowEt").asString()).isEqualTo("10:33");
        assertThat(basis.get("nowKst").asString()).isEqualTo("2026-11-03 00:33 KST");
        assertThat(basis.get("selectionAsOf").asString()).isEqualTo("2026-10-23");
        assertThat(basis.get("remainingTimings").toString()).isEqualTo("[\"MARKET\",\"AT_1100\",\"AT_1200\",\"AT_1300\","
                + "\"AT_1400\",\"AT_1500\",\"NEXT_CLOSE\"]");
        JsonNode pending = body.get("4_portfolio").get("pending");
        assertThat(pending).extracting(p -> p.get("state").asString()).containsExactly(CheckpointPacket.PENDING_DUE,
                CheckpointPacket.PENDING_DUE, CheckpointPacket.PENDING_AHEAD, CheckpointPacket.PENDING_AHEAD);
        assertThat(body.get("4_portfolio").get("todayFills")).as("조립 뒤 체결(15:40Z)은 빠짐").hasSize(1);
        JsonNode expected = body.get("4_portfolio").get("expected");
        assertThat(expected.get("assumedFills")).as("기준 시각이 지난 대기 주문 둘(§10-6) — 매도 먼저")
                .extracting(f -> f.get("orderId").asLong() + " " + f.get("priceSource").asString())
                .containsExactly("101 LAST", "102 WATCH");
        assertThat(expected.get("note").asString()).startsWith("추정");
        JsonNode feed = body.get("5_feed");
        assertThat(feed.get("status").asString()).isEqualTo("OK");
        assertThat(feed.get("tickers").propertyNames()).containsExactly("SPY", "NVDA", "AAPL");
        assertThat(feed.get("dropped").toString())
                .isEqualTo("{\"tickersAfterAssembly\":1,\"barsAfterAssembly\":0,\"otherSession\":1}");
        assertThat(feed.get("tickers").get("SPY").get("bars")).hasSize(30);
        assertThat(feed.get("tickers").get("SPY").get("secondsSinceLastTrade").asLong())
                .as("마지막 봉은 거래량 0 — 그 앞 봉 끝(15:31Z)부터").isEqualTo(130);
        assertThat(feed.get("tickers").get("AAPL").get("isStale").asBoolean()).isTrue();
        assertThat(feed.get("lagSeconds").asInt()).isEqualTo(75);
        assertThat(feed.get("grade").asString()).isEqualTo("지연 모름");
        assertThat(feed.get("recentLag").isNull()).isTrue();
        assertThat(body.get("6_hardRules").get("maxPositions").asInt()).isEqualTo(20);
        assertThat(packet.text()).doesNotContain("실시간");
        assertThat(PacketBuilder.estimateTokens(packet.text())).isLessThanOrEqualTo(CheckpointPacket.CHECKPOINT_TARGET_TOKENS);
    }

    @Test
    @DisplayName("고정본(HOURLY): 감시 ∪ 보유 ∪ 대기 ∪ 아침 8_prices 대상의 시간별 관측치(값 없는 종목은 null), 수집 시각·나이")
    void goldenHourly() {
        PacketBuilder.Packet packet = CheckpointPacket.build(inputs("HOURLY", Optional.empty(), List.of()), MAPPER);
        Golden.assertMatches("packet-us-claude2-checkpoint-hourly.json", packet.text());
        JsonNode feed = packet.body().get("5_feed");
        assertThat(feed.get("source").asString()).isEqualTo(Datasets.SNAP_PAPER_QUOTES);
        assertThat(feed.get("rows")).extracting(r -> r.get(0).asString()).containsExactly("NVDA", "AAPL", "MSFT", "XLK");
        assertThat(feed.get("ageSeconds").asLong()).isEqualTo(790);
        assertThat(feed.get("omitted").asInt()).isZero();
    }

    @Test
    @DisplayName("HOURLY 대상은 60종목까지 — 넘치면 omitted에 셈(감시·보유·대기가 먼저)")
    void hourlyCapsAtSixty() {
        StringBuilder rows = new StringBuilder();
        for (int i = 0; i < 70; i++) {
            rows.append(i == 0 ? "" : ",").append("[\"T").append(i).append("\",\"CANDIDATE\"]");
        }
        Decision morning = new Decision(41, PaperBooks.CLAUDE2, D, RuleBookService.SCHEDULED, MORNING_CREATED, "OK", null,
                5, 12, null, null, null, null, null, null, null, null, List.of(), true, 1L, 0,
                "{\"8_prices\":{\"rows\":[" + rows + "]}}");
        CheckpointPacket.Inputs base = inputs("HOURLY", Optional.empty(), List.of());
        CheckpointPacket.Inputs in = new CheckpointPacket.Inputs(base.checkpoint(), D, morning, base.state(), base.positions(),
                base.pending(), base.todayFills(), Optional.empty(), base.quotes(), base.macroCards(), 5, 12, List.of(),
                base.calendar(), ASSEMBLED);
        JsonNode feed = CheckpointPacket.build(in, MAPPER).body().get("5_feed");
        assertThat(feed.get("rows")).hasSize(CheckpointPacket.HOURLY_MAX);
        assertThat(feed.get("rows").get(0).get(0).asString()).isEqualTo("NVDA");
        assertThat(feed.get("omitted").asInt()).isEqualTo(4 + 70 - CheckpointPacket.HOURLY_MAX);
    }

    @Test
    @DisplayName("⑨ 성질: 무작위 조립 시각·봉 시작·받은 시각 — 실린 봉은 모두 끝(시작 + 60초) ≤ 조립 시각, 실린 종목·저장본은 받은 시각 ≤ 조립 시각, 빠진 수 = 버린 수")
    void onlyDataBeforeAssembly() {
        Random random = new Random(20261102);
        Instant open = Instant.parse("2026-11-02T14:30:00Z");
        for (int round = 0; round < 300; round++) {
            Instant assembled = open.plusSeconds(3_600 + random.nextInt(3_600));
            Instant snapshotAt = assembled.minusSeconds(random.nextInt(600) - 120);
            ObjectNode tickers = MAPPER.createObjectNode();
            int expectBars = 0;
            int expectDropBars = 0;
            int expectDropTickers = 0;
            for (int i = 0; i < 4; i++) {
                Instant fetched = assembled.plusSeconds(random.nextInt(400) - 300);
                Instant from = assembled.minusSeconds(60L * (1 + random.nextInt(40)));
                int count = 1 + random.nextInt(35);
                tickers.set("T" + i, ticker(fetched, E, from, count, 50, 100));
                if (fetched.isAfter(assembled)) {
                    expectDropTickers++;
                    continue;
                }
                int kept = 0;
                for (int b = 0; b < count; b++) {
                    if (from.plusSeconds(60L * b + 60).isAfter(assembled)) {
                        expectDropBars++;
                    } else {
                        kept++;
                    }
                }
                expectBars += Math.min(kept, CheckpointPacket.BARS_SHOWN);
            }
            CheckpointPacket.Inputs base = inputs("MINUTE", Optional.of(watch(snapshotAt, tickers)), List.of());
            CheckpointPacket.Inputs in = new CheckpointPacket.Inputs(base.checkpoint(), D, base.morning(), base.state(),
                    base.positions(), base.pending(), base.todayFills(), base.watch(), base.quotes(), base.macroCards(), 5,
                    12, List.of(), base.calendar(), assembled);
            JsonNode feed = CheckpointPacket.build(in, MAPPER).body().get("5_feed");
            if (snapshotAt.isAfter(assembled)) {
                assertThat(feed.get("status").asString()).isEqualTo("AFTER_ASSEMBLY");
                assertThat(feed.get("tickers")).isEmpty();
                continue;
            }
            int bars = 0;
            for (JsonNode t : feed.get("tickers")) {
                for (JsonNode row : t.get("bars")) {
                    bars++;
                    LocalTime start = LocalTime.parse(row.get(0).asString());
                    Instant end = java.time.ZonedDateTime.of(E, start, UsMarketCalendar.CALENDAR.zone()).toInstant()
                            .plus(Duration.ofSeconds(60));
                    assertThat(end).as("봉 끝 ≤ 조립 시각").isBeforeOrEqualTo(assembled);
                }
            }
            assertThat(bars).isEqualTo(expectBars);
            assertThat(feed.get("dropped").get("tickersAfterAssembly").asInt()).isEqualTo(expectDropTickers);
            assertThat(feed.get("dropped").get("barsAfterAssembly").asInt()).isEqualTo(expectDropBars);
        }
    }

    @Test
    @DisplayName("남은 시점: 지금 + 60초 이하인 기준 시각은 빠짐(10:59:00 → AT_1100 빠짐, 10:58:59 → 남음), 조기 폐장일(11-27 마감 13:00)에는 AT_1300~ 없이 NEXT_CLOSE까지, MARKET은 기준 시각이 마감 5분 전 앞일 때만(맨 앞)")
    void remainingTimingsDropPassedAndEarlyClose() {
        assertThat(CheckpointPacket.remainingTimings(E, UsMarketCalendar.CALENDAR, Instant.parse("2026-11-02T15:59:00Z")))
                .doesNotContain("AT_1100").containsSequence("MARKET", "AT_1200");
        assertThat(CheckpointPacket.remainingTimings(E, UsMarketCalendar.CALENDAR, Instant.parse("2026-11-02T15:58:59Z")))
                .containsSequence("MARKET", "AT_1100");
        LocalDate early = LocalDate.of(2026, 11, 27);
        assertThat(UsMarketCalendar.CALENDAR.isEarlyClose(early)).isTrue();
        assertThat(CheckpointPacket.remainingTimings(early, UsMarketCalendar.CALENDAR, Instant.parse("2026-11-27T16:30:00Z")))
                .containsExactly("MARKET", "AT_1200", "NEXT_CLOSE");
        assertThat(CheckpointPacket.remainingTimings(early, UsMarketCalendar.CALENDAR, Instant.parse("2026-11-27T17:53:00Z")))
                .as("12:53 ET — MARKET의 T 12:55 = 마감 5분 전").containsExactly("NEXT_CLOSE");
        assertThat(CheckpointPacket.remainingTimings(E, UsMarketCalendar.CALENDAR, Instant.parse("2026-11-02T21:30:00Z")))
                .as("마감 뒤").isEmpty();
    }

    @Test
    @DisplayName("등급(§7-3): 지연 모름(값 없음·5세션 전) · 지연 n분(측정)(120초 초과) · 준실시간(측정)(5세션 p95 ≤ 90초·이번 ≤ 120초) · 멈춤")
    void gradeUnknownUnderFiveSessions() {
        assertThat(CheckpointPacket.grade(null, List.of(10, 10, 10, 10, 10), false)).isEqualTo("지연 모름");
        assertThat(CheckpointPacket.grade(60, List.of(50, 60, 70, 80), false)).as("4세션").isEqualTo("지연 모름");
        assertThat(CheckpointPacket.grade(60, List.of(50, 60, 70, 80, 90), false)).isEqualTo("준실시간(측정)");
        assertThat(CheckpointPacket.grade(60, List.of(50, 60, 70, 80, 91), false)).as("p95 91").isEqualTo("지연 모름");
        assertThat(CheckpointPacket.grade(121, List.of(50, 60, 70, 80, 90), false)).isEqualTo("지연 2분(측정)");
        assertThat(CheckpointPacket.grade(900, List.of(), false)).isEqualTo("지연 15분(측정)");
        assertThat(CheckpointPacket.grade(60, List.of(50, 60, 70, 80, 90), true)).isEqualTo("멈춤");
    }

    @Test
    @DisplayName("감시 저장본이 다른 확인의 것(세션·시각이 다름)이면 싣지 않음(OTHER_CHECKPOINT), 저장본 없으면 NO_SNAPSHOT — 등급 '지연 모름'")
    void minuteFeedNeedsTheSameCheckpoint() {
        Snapshot other = watch(FETCHED, watchTickers());
        ((ObjectNode) other.payload().get("checkpoint")).put("atEt", "11:00");
        JsonNode feed = CheckpointPacket.build(inputs("MINUTE", Optional.of(other), List.of()), MAPPER).body().get("5_feed");
        assertThat(feed.get("status").asString()).isEqualTo("OTHER_CHECKPOINT");
        assertThat(feed.get("tickers")).isEmpty();
        assertThat(feed.get("lagSeconds").isNull()).isTrue();
        JsonNode none = CheckpointPacket.build(inputs("MINUTE", Optional.empty(), List.of()), MAPPER).body().get("5_feed");
        assertThat(none.get("status").asString()).isEqualTo("NO_SNAPSHOT");
        assertThat(none.get("grade").asString()).isEqualTo("지연 모름");
    }

    // ------------------------------------------------------------------ 자유 시점 판의 장중 판단(ADR 0027 결정 3)
    /** 켠 판 계좌1의 둘째 판단(10:30 ET, 순번 2 — 세션당 2) — 대기 주문에 분 단위 지정 시각이 섞여 있고, 감시 저장본은 두 계획의 것. */
    private static CheckpointPacket.Inputs freeInputs(int slot, int max, boolean manual) {
        return freeInputs(new CheckpointPacket.Free(PaperBooks.CLAUDE, slot, max, manual));
    }

    /** {@link #freeInputs(int, int, boolean)}를 주어진 자유 시점 판 칸(출처·사건·남은 예약 포함)으로. */
    private static CheckpointPacket.Inputs freeInputs(CheckpointPacket.Free free) {
        int slot = free.slot();
        Checkpoint plan = new Checkpoint(PaperBooks.CLAUDE, E, LocalTime.of(10, 30), "MINUTE", List.of("NVDA"), "반등이 이어지나", 41L,
                null, PaperBooks.CHECKPOINT_PLANNED, null, null, null, null, null);
        List<Order> pending = List.of(
                new Order(201, PaperBooks.CLAUDE, 41L, "AAPL", "SELL", null, null, 0.5, PaperBooks.NEXT_OPEN, "CLAUDE",
                        PaperBooks.ORDER_PENDING, null, null, D, MORNING_CREATED, E, null, null),
                new Order(202, PaperBooks.CLAUDE, 41L, "NVDA", "BUY", null, 5.0, null, PaperBooks.AT_MINUTE, "CLAUDE",
                        PaperBooks.ORDER_PENDING, null, null, D, MORNING_CREATED, E, null, LocalTime.of(10, 5)),
                new Order(203, PaperBooks.CLAUDE, 41L, "MSFT", "BUY", null, 5.0, null, PaperBooks.AT_MINUTE, "CLAUDE",
                        PaperBooks.ORDER_PENDING, null, null, D, MORNING_CREATED, E, null, LocalTime.of(13, 47)),
                new Order(204, PaperBooks.CLAUDE, 41L, "XLK", "BUY", null, 5.0, null, PaperBooks.NEXT_CLOSE, "CLAUDE",
                        PaperBooks.ORDER_PENDING, null, null, D, MORNING_CREATED, E, null, null));
        Snapshot watch = watch(FETCHED, watchTickers());
        ObjectNode payload = (ObjectNode) watch.payload();
        ArrayNode identities = payload.putArray("checkpoints");
        identities.addObject().put("book", PaperBooks.CLAUDE2).put("sessionDate", E.toString()).put("atEt", "10:30").putNull("slot");
        identities.addObject().put("book", PaperBooks.CLAUDE).put("sessionDate", E.toString()).put("atEt", "10:30").put("slot", slot);
        // 다른 계좌(계좌2) 계획의 감시 종목 — 이 계획의 패킷에는 싣지 않음.
        ((ObjectNode) payload.get("tickers")).set("AMD", ticker(FETCHED, E, Instant.parse("2026-11-02T15:02:00Z"), 30, 150.0, 40_000));
        return new CheckpointPacket.Inputs(plan, D, morning(),
                new BookState(PaperBooks.CLAUDE, 60_000, 100_000, 40_000, 40, null, null, D, null),
                List.of(new Position(PaperBooks.CLAUDE, "AAPL", 100, 225.5, D, MORNING_CREATED, 232, MORNING_CREATED, 230.0,
                        Instant.parse("2026-11-02T15:20:00Z"), false, null, 0, null)),
                pending, List.of(), Optional.of(watch),
                Optional.of(quotes(Instant.parse("2026-11-02T15:20:00Z"), bar("AAPL", E, 230.4), bar("MSFT", E, 521.0),
                        bar("NVDA", E, 181.2), bar("XLK", D, 280.0))),
                MAPPER.readTree("{\"source\":\"macro.collected\",\"cards\":[{\"key\":\"vix\",\"value\":17.2,\"delay\":\"15분 지연\"}]}"),
                5, 12, List.of(60, 70), UsMarketCalendar.CALENDAR, ASSEMBLED, Optional.empty(), free);
    }

    /** 사건 규칙이 당긴 판단의 계획 행 사건(V27 trigger — 원래 시각·사건 목록). */
    private static ObjectNode trigger() {
        ObjectNode trigger = MAPPER.createObjectNode();
        trigger.put("originalAt", "13:30");
        ArrayNode events = trigger.putArray("events");
        events.addObject().put("type", "HELD_MOVE").put("ticker", "AAPL").put("direction", "DOWN").put("prevClose", 240.0)
                .put("last", 230.1).put("changePct", -4.13).put("barEt", "10:24");
        events.addObject().put("type", "INDEX_MOVE").put("ticker", "SPY").put("direction", "DOWN").put("prevClose", 590.0)
                .put("last", 580.5).put("changePct", -1.61).put("barEt", "10:24");
        return trigger;
    }

    @Test
    @DisplayName("고정본(자유 시점 판 장중 판단 — MINUTE): 계좌·순번·종류 INTRADAY_n·판 ft-2, 남은 시점은 장중 시장가·남은 지정 시각(10:35~15:54)·그날 종가, "
            + "대기 주문의 지정 시각은 그 분으로 지남/대기를 가르고, MINUTE 피드는 이 계획의 종목만(다른 계좌 계획의 AMD는 빠짐), 순번을 다 쓴 판단은 다음 "
            + "예약을 받지 않음. 끈 판 장중 확인 고정본은 그대로")
    void goldenFreeMinute() {
        PacketBuilder.Packet packet = CheckpointPacket.build(freeInputs(2, 2, false), MAPPER);
        Golden.assertMatches("packet-us-ft-intraday-minute.json", packet.text());
        JsonNode body = packet.body();
        List<String> keys = new ArrayList<>();
        body.propertyNames().forEach(keys::add);
        assertThat(keys).as("섹션은 끈 판과 같은 일곱").containsExactly("0_instructions", "1_basis", "2_macroCards", "3_request",
                "4_portfolio", "5_feed", "6_hardRules");
        JsonNode basis = body.get("1_basis");
        assertThat(basis.get("book").asString()).isEqualTo(PaperBooks.CLAUDE);
        assertThat(basis.get("variant").asString()).isEqualTo("freeTiming");
        assertThat(basis.get("fixedRules").asString()).isEqualTo("ft-2");
        assertThat(basis.get("decisionKind").asString()).isEqualTo("INTRADAY_2");
        assertThat(basis.get("slot").asInt()).isEqualTo(2);
        assertThat(basis.get("remainingTimings").toString()).isEqualTo("[\"MARKET\",\"AT_MINUTE\",\"NEXT_CLOSE\"]");
        assertThat(basis.get("atMinute").get("firstEt").asString()).as("10:33:10 + 60초 = 10:34:10 → 다음 분").isEqualTo("10:35");
        assertThat(basis.get("atMinute").get("lastEt").asString()).isEqualTo("15:54");
        assertThat(basis.get("nextCheckpoint").get("available").asBoolean()).as("순번 2 = 세션당 2 — 다 씀").isFalse();
        assertThat(basis.get("nextCheckpoint").get("firstEt").isNull()).isTrue();
        assertThat(basis.get("origin").asString()).as("결정의 예약").isEqualTo("RESERVED");
        assertThat(basis.get("remainingJudgments").asInt()).as("세션당 2 − 순번 2").isZero();
        assertThat(basis.get("nextCheckpoint").get("replaces").isNull()).as("남은 예약 없음").isTrue();
        assertThat(body.get("3_request").get("trigger").isNull()).as("사건 없음").isTrue();
        assertThat(body.get("3_request").has("note")).as("예약한 판단 — 설명 줄 없음").isFalse();
        assertThat(body.get("0_instructions").get("lines").toString()).contains("1_basis.origin").contains("3_request.trigger")
                .contains("remainingJudgments");
        JsonNode pending = body.get("4_portfolio").get("pending");
        assertThat(pending).extracting(p -> p.get("timing").asString() + " " + p.get("targetAtEt").asString() + " " + p.get("state").asString())
                .containsExactly("NEXT_OPEN 09:30 " + CheckpointPacket.PENDING_DUE, "AT_MINUTE 10:05 " + CheckpointPacket.PENDING_DUE,
                        "AT_MINUTE 13:47 " + CheckpointPacket.PENDING_AHEAD, "NEXT_CLOSE 16:00 " + CheckpointPacket.PENDING_AHEAD);
        assertThat(body.get("4_portfolio").get("book").asString()).isEqualTo(PaperBooks.CLAUDE);
        JsonNode feed = body.get("5_feed");
        assertThat(feed.get("status").asString()).as("신원 목록의 둘째가 이 계획").isEqualTo("OK");
        assertThat(feed.get("tickers").propertyNames()).as("감시·보유·대기·기준 종목만 — AMD는 다른 계좌 계획의 것").containsExactly("SPY", "NVDA",
                "AAPL");
        assertThat(body.get("0_instructions").get("lines").get(0).asString()).startsWith("장중 판단이다");
        assertThat(body.get("6_hardRules").get("lines").toString()).contains("MARKET·AT_MINUTE·NEXT_CLOSE").contains("기준 시각 순")
                .doesNotContain("AT_1000");
        assertThat(body.get("6_hardRules").get("maxPositions").asInt()).isEqualTo(20);
        assertThat(packet.text()).doesNotContain("실시간").doesNotContain("AT_1100").doesNotContain("claude2");
        assertThat(PacketBuilder.estimateTokens(packet.text())).isLessThanOrEqualTo(CheckpointPacket.CHECKPOINT_TARGET_TOKENS);

        // 저장본에 이 계획의 신원(순번)이 없으면 다른 확인의 저장본.
        JsonNode other = CheckpointPacket.build(freeInputs(1, 2, false), MAPPER).body();
        assertThat(other.get("5_feed").get("status").asString()).isEqualTo("OK");
        CheckpointPacket.Inputs mismatched = freeInputs(1, 2, false);
        ((ArrayNode) mismatched.watch().orElseThrow().payload().get("checkpoints")).remove(1);
        assertThat(CheckpointPacket.build(mismatched, MAPPER).body().get("5_feed").get("status").asString()).isEqualTo("OTHER_CHECKPOINT");
    }

    @Test
    @DisplayName("자유 시점 판 장중 판단의 남은 것: 첫 판단(순번 1 < 세션당 2)은 다음 예약 가능(이 판단 시각 + 20분 ~ 15:30), 운영자가 당긴 판단은 그 표시, 마감 "
            + "5분 전부터는 장중 시장가·지정 시각이 닫히고 종가만, 마감 뒤에는 남은 시점 없음")
    void freeRemainingOptions() {
        JsonNode first = CheckpointPacket.build(freeInputs(1, 2, true), MAPPER).body();
        JsonNode next = first.get("1_basis").get("nextCheckpoint");
        assertThat(next.get("available").asBoolean()).isTrue();
        assertThat(next.get("firstEt").asString()).as("10:30 + 20분").isEqualTo("10:50");
        assertThat(next.get("lastEt").asString()).isEqualTo("15:30");
        assertThat(next.get("minGapMinutes").asInt()).isEqualTo(20);
        assertThat(CheckpointPacket.build(freeInputs(2, 3, false), MAPPER).body().get("1_basis").get("nextCheckpoint").get("available")
                .asBoolean()).as("세션당 3번 — 둘째 판단도 셋째를 예약할 수 있음").isTrue();
        assertThat(CheckpointPacket.build(freeInputs(3, 3, false), MAPPER).body().get("1_basis").get("decisionKind").asString())
                .isEqualTo(RuleBookService.INTRADAY_3);
        assertThat(first.get("1_basis").get("manual").asBoolean()).isTrue();
        assertThat(first.get("3_request").get("note").asString()).contains("운영자가 당긴 판단");
        assertThat(CheckpointPacket.build(freeInputs(1, 1, false), MAPPER).body().get("1_basis").get("nextCheckpoint").get("available")
                .asBoolean()).as("세션당 1번 — 다 씀").isFalse();

        var calendar = UsMarketCalendar.CALENDAR;
        assertThat(CheckpointPacket.freeRemainingTimings(E, calendar, Instant.parse("2026-11-02T20:52:30Z")))
                .as("15:52:30 — 시장가 기준 분 15:54는 마감 5분 전(15:55) 앞").containsExactly("MARKET", "AT_MINUTE", "NEXT_CLOSE");
        assertThat(CheckpointPacket.freeMinutes(E, calendar, Instant.parse("2026-11-02T20:52:30Z")))
                .containsExactly(Instant.parse("2026-11-02T20:54:00Z"), Instant.parse("2026-11-02T20:54:00Z"));
        assertThat(CheckpointPacket.freeRemainingTimings(E, calendar, Instant.parse("2026-11-02T20:54:00Z")))
                .as("15:54:00 — 기준 분 15:56은 닫힘").containsExactly("NEXT_CLOSE");
        assertThat(CheckpointPacket.freeMinutes(E, calendar, Instant.parse("2026-11-02T20:54:00Z"))).isNull();
        assertThat(CheckpointPacket.freeRemainingTimings(E, calendar, Instant.parse("2026-11-02T21:00:00Z"))).as("마감 뒤").isEmpty();
        assertThat(CheckpointPacket.freeRemainingTimings(E, calendar, Instant.parse("2026-11-02T14:35:20Z")))
                .as("09:35:20 — 시장가 기준 분 09:37은 개장 10분 뒤(09:40) 앞이라 없음").containsExactly("AT_MINUTE", "NEXT_CLOSE");
        assertThat(CheckpointPacket.freeRemainingTimings(E, calendar, Instant.parse("2026-11-02T14:38:30Z")))
                .as("09:38:30 — 기준 분 09:40부터 시장가").containsExactly("MARKET", "AT_MINUTE", "NEXT_CLOSE");
        assertThat(CheckpointPacket.freeMinutes(E, calendar, Instant.parse("2026-11-02T14:00:00Z")))
                .as("개장 전 — 받는 범위의 첫 분 09:40부터(개장 10분 뒤)").containsExactly(Instant.parse("2026-11-02T14:40:00Z"),
                        Instant.parse("2026-11-02T20:54:00Z"));
    }

    @Test
    @DisplayName("고정본(자유 시점 판 장중 판단 — 사건이 당긴 판단, ADR 0031): 1_basis.origin EVENT·남은 횟수(세션당 3 − 순번 1 = 2), 3_request.trigger"
            + "(원래 시각 originalAtEt·사건 목록 그대로·규칙 한 줄)와 사건 설명 줄, nextCheckpoint.replaces(다음 순번의 남은 예약 — 시각·출처). 보장 판단은 "
            + "그 설명 줄, 운영자 판단은 예전 설명 줄 그대로")
    void goldenFreeEventMinute() {
        CheckpointPacket.Free free = new CheckpointPacket.Free(PaperBooks.CLAUDE, 1, 3, false, "EVENT", trigger(),
                new CheckpointPacket.Reserved(LocalTime.of(14, 0), "RESERVED"));
        PacketBuilder.Packet packet = CheckpointPacket.build(freeInputs(free), MAPPER);
        Golden.assertMatches("packet-us-ft-intraday-minute-event.json", packet.text());
        JsonNode basis = packet.body().get("1_basis");
        assertThat(basis.get("origin").asString()).isEqualTo("EVENT");
        assertThat(basis.get("remainingJudgments").asInt()).isEqualTo(2);
        assertThat(basis.get("nextCheckpoint").get("replaces").toString()).isEqualTo("{\"atEt\":\"14:00\",\"origin\":\"RESERVED\"}");
        JsonNode request = packet.body().get("3_request");
        assertThat(request.get("note").asString()).startsWith("코드 사건 규칙이 앞당기거나 더한 판단이다");
        JsonNode trigger = request.get("trigger");
        assertThat(trigger.get("originalAtEt").asString()).isEqualTo("13:30");
        assertThat(trigger.get("events")).isEqualTo(trigger().get("events"));
        assertThat(trigger.get("rule").asString()).isEqualTo(IntradayScheduler.eventRule(false)).contains("±4%").contains("SPY")
                .contains("±1.5%").contains("2% 안");
        assertThat(packet.text()).doesNotContain("실시간");
        assertThat(PacketBuilder.estimateTokens(packet.text())).isLessThanOrEqualTo(CheckpointPacket.CHECKPOINT_TARGET_TOKENS);

        JsonNode guarantee = CheckpointPacket.build(freeInputs(new CheckpointPacket.Free(PaperBooks.CLAUDE, 1, 3, false, "GUARANTEE",
                null, null)), MAPPER).body();
        assertThat(guarantee.get("1_basis").get("origin").asString()).isEqualTo("GUARANTEE");
        assertThat(guarantee.get("3_request").get("note").asString()).startsWith("코드가 넣은 보장 판단이다");
        assertThat(guarantee.get("3_request").get("trigger").isNull()).isTrue();
        JsonNode manual = CheckpointPacket.build(freeInputs(1, 2, true), MAPPER).body();
        assertThat(manual.get("1_basis").get("origin").asString()).as("운영자 행 — 출처 MANUAL").isEqualTo("MANUAL");
        assertThat(manual.get("3_request").get("note").asString()).isEqualTo("운영자가 당긴 판단이다 — 예약한 시각이 아니라 지금 부른다");
        assertThat(CheckpointPacket.Reserved.after(List.of(
                com.macrodash.store.PaperStore.IntradayPlan.planned(PaperBooks.CLAUDE, E, 2, LocalTime.of(11, 0), "HOURLY", List.of(), "q",
                        "ft-2", false, 41L, 7L)), 1)).as("다음 순번의 PLANNED 행").isEqualTo(new CheckpointPacket.Reserved(LocalTime.of(11, 0),
                "NEXT"));
        assertThat(CheckpointPacket.Reserved.after(List.of(), 1)).isNull();
    }

    @Test
    @DisplayName("QA-309: 그대로 남는 뒤 예약(laterReserved — 다음 순번 뒤의 PLANNED 행)이 있으면 nextCheckpoint의 끝은 그 시각 − 20분이고 그 예약을 실음. "
            + "그 끝이 가장 이른 시각보다 앞이면 예약할 수 없음(사유 문구). 뒤 예약이 없으면 범위 끝 그대로")
    void nextCheckpointStopsBeforeTheLaterReservation() {
        CheckpointPacket.Reserved second = new CheckpointPacket.Reserved(LocalTime.of(12, 0), "RESERVED");
        JsonNode bounded = CheckpointPacket.build(freeInputs(new CheckpointPacket.Free(PaperBooks.CLAUDE, 1, 3, false, null, null, second,
                new CheckpointPacket.Reserved(LocalTime.of(13, 0), "GUARANTEE"), false)), MAPPER).body().get("1_basis").get("nextCheckpoint");
        assertThat(bounded.get("available").asBoolean()).isTrue();
        assertThat(bounded.get("firstEt").asString()).as("10:30 + 20분").isEqualTo("10:50");
        assertThat(bounded.get("lastEt").asString()).as("뒤 예약 13:00 − 20분").isEqualTo("12:40");
        assertThat(bounded.get("replaces").toString()).isEqualTo("{\"atEt\":\"12:00\",\"origin\":\"RESERVED\"}");
        assertThat(bounded.get("laterReserved").toString()).isEqualTo("{\"atEt\":\"13:00\",\"origin\":\"GUARANTEE\"}");
        assertThat(bounded.get("note").asString()).contains("laterReserved").contains("20분 전");

        JsonNode closed = CheckpointPacket.build(freeInputs(new CheckpointPacket.Free(PaperBooks.CLAUDE, 1, 3, false, null, null, second,
                new CheckpointPacket.Reserved(LocalTime.of(11, 5), "EVENT"), false)), MAPPER).body().get("1_basis").get("nextCheckpoint");
        assertThat(closed.get("available").asBoolean()).as("끝 10:45 < 가장 이른 10:50").isFalse();
        assertThat(closed.get("firstEt").isNull()).isTrue();
        assertThat(closed.get("lastEt").isNull()).isTrue();
        assertThat(closed.get("laterReserved").toString()).isEqualTo("{\"atEt\":\"11:05\",\"origin\":\"EVENT\"}");
        assertThat(closed.get("note").asString()).startsWith("그대로 남는 뒤 예약(laterReserved)보다 20분 앞에 남은 시각이 없다");

        JsonNode open = CheckpointPacket.build(freeInputs(new CheckpointPacket.Free(PaperBooks.CLAUDE, 1, 3, false, null, null, second)),
                MAPPER).body().get("1_basis").get("nextCheckpoint");
        assertThat(open.get("lastEt").asString()).isEqualTo("15:30");
        assertThat(open.get("laterReserved").isNull()).isTrue();

        List<com.macrodash.store.PaperStore.IntradayPlan> rows = List.of(
                com.macrodash.store.PaperStore.IntradayPlan.planned(PaperBooks.CLAUDE, E, 2, LocalTime.of(12, 0), "HOURLY", List.of(), "q",
                        "ft-2", false, 41L, null),
                com.macrodash.store.PaperStore.IntradayPlan.planned(PaperBooks.CLAUDE, E, 3, LocalTime.of(13, 0), "HOURLY", List.of(), "q",
                        "ft-2", false, 41L, null));
        assertThat(CheckpointPacket.Reserved.later(rows, 1)).as("순번 2 뒤의 PLANNED 행")
                .isEqualTo(new CheckpointPacket.Reserved(LocalTime.of(13, 0), "RESERVED"));
        assertThat(CheckpointPacket.Reserved.later(rows, 2)).as("순번 3이 다음 순번 — 그 뒤는 없음").isNull();
    }

    @Test
    @DisplayName("장중 스탑 감시 ON(ADR 0032): 켠 판 장중 판단 패킷에 1_basis.stopWatch와 6_hardRules 끝의 스탑 줄 — 그 밖은 바이트 그대로. 꺼진 판(OFF·SHADOW)은 "
            + "고정본 그대로")
    void stopWatchOnIntradayPacket() {
        PacketBuilder.Packet off = CheckpointPacket.build(freeInputs(new CheckpointPacket.Free(PaperBooks.CLAUDE, 2, 2, false, null, null,
                null, false)), MAPPER);
        assertThat(off.text()).isEqualTo(CheckpointPacket.build(freeInputs(2, 2, false), MAPPER).text());
        PacketBuilder.Packet on = CheckpointPacket.build(freeInputs(new CheckpointPacket.Free(PaperBooks.CLAUDE, 2, 2, false, null, null,
                null, true)), MAPPER);
        JsonNode stopWatch = on.body().get("1_basis").get("stopWatch");
        assertThat(stopWatch.get("mode").asString()).isEqualTo("ON");
        assertThat(stopWatch.get("rule").asString()).isEqualTo(StopWatch.rule(false));
        JsonNode lines = on.body().get("6_hardRules").get("lines");
        assertThat(lines.get(lines.size() - 1).asString()).isEqualTo(CheckpointPacket.STOP_WATCH_LINE);
        ObjectNode a = (ObjectNode) off.body().deepCopy();
        ObjectNode b = (ObjectNode) on.body().deepCopy();
        ((ObjectNode) b.get("1_basis")).remove("stopWatch");
        ((ArrayNode) b.get("6_hardRules").get("lines")).remove(lines.size() - 1);
        assertThat(b).isEqualTo(a);
        JsonNode checkpoint = CheckpointPacket.build(inputs("MINUTE", Optional.of(watch(FETCHED, watchTickers())), List.of(60, 70)), MAPPER)
                .body();
        assertThat(checkpoint.get("1_basis").has("stopWatch")).as("끈 판 장중 확인 패킷에는 없음").isFalse();
    }

    @Test
    @DisplayName("ADR 0030: 장중 확인·판단 패킷(MINUTE·HOURLY·자유 시점 MINUTE)에서 바뀐 것은 4_portfolio.expected.note의 어림 설명 문구뿐('슬리피지·수수료·매도 제비용 빼고 어림') — 되돌리면 ADR 0030 전 고정본과 바이트까지 같다")
    void onlyTheEstimateNoteChangedForCosts() {
        String now = "(슬리피지·수수료·매도 제비용 빼고 어림)";
        String before = "(슬리피지 빼고 어림)";
        String minute = CheckpointPacket.build(inputs("MINUTE", Optional.of(watch(FETCHED, watchTickers())),
                List.of(60, 70)), MAPPER).text();
        String hourly = CheckpointPacket.build(inputs("HOURLY", Optional.empty(), List.of()), MAPPER).text();
        String free = CheckpointPacket.build(freeInputs(2, 2, false), MAPPER).text();
        for (String text : List.of(minute, hourly, free)) {
            assertThat(text.split(java.util.regex.Pattern.quote(now), -1)).as("어림 문구 한 번").hasSize(2);
        }
        assertThat(Golden.sha256(minute.replace(now, before)))
                .isEqualTo("abfbeafb164199cb8480708ba235908016081edd5ca6b9e543127419cc765adc");
        assertThat(Golden.sha256(hourly.replace(now, before)))
                .isEqualTo("724b321e601b68ac3d0a7cc9c278cbea35e4074fc7d90ec6dc731c482b001232");
        assertThat(Golden.sha256(free.replace(now, before)))
                .isEqualTo("975c2a754f253b55f417eedbb5efb23f83d803d9ac9ce744c3c0d85a60a7e29a");
    }
}
