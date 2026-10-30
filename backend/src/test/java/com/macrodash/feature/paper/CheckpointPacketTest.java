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
        assertThat(body.get("4_portfolio").get("expected").isNull()).isTrue();
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
}
