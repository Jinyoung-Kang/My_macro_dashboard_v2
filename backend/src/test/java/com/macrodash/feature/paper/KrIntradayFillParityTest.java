package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.KrQuotes.Timed;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 두 길 대조(ADR 0045) — 같은 입력 표({@code paper/kr-intraday-fill/cases.json}, 수집기 시험 {@code test_kr_intraday_fill_parity.py}가 조각을 다시 만들어
 * 대조)의 밤 조각을 {@link KrQuotes#parseTimed} → {@link KrTimedLadder#price}(길 A — 밤 장부)로, 감시 조각을 {@link KrIntradayFill#r1}
 * ({@link KrIntradayFill#timed} → 같은 사다리, 길 B — 장중 단계)로 셉니다. <b>길 B가 R1({@value KrTimedLadder#SOURCE_AT})이면 길 A도 같은 가격·출처</b>이고,
 * 길 B가 못 고르는 사례는 밤에 맡깁니다. 사후 정정 가상 사례만 두 값이 달라 대조 칸({@link KrIntradayFill#check})이 불일치로 잡는지 봅니다.
 */
class KrIntradayFillParityTest {

    private static JsonNode table() throws IOException {
        try (InputStream in = KrIntradayFillParityTest.class.getResourceAsStream("/paper/kr-intraday-fill/cases.json")) {
            assertThat(in).as("대조 표").isNotNull();
            return MAPPER.readTree(in);
        }
    }

    private static TradingCalendar calendar(JsonNode c) {
        Map<LocalDate, KrxCalendar.Hours> hours = Map.of();
        JsonNode override = c.get("openOverride");
        if (override != null && override.isObject()) {
            hours = Map.of(LocalDate.parse(c.get("session").asString()), new KrxCalendar.Hours(LocalTime.parse(override.get("open").asString()),
                    LocalTime.parse(override.get("close").asString())));
        }
        return new KrxCalendar(KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), hours);
    }

    private static Order stop(JsonNode c) {
        LocalDate session = LocalDate.parse(c.get("session").asString());
        ObjectNode reason = MAPPER.createObjectNode().put("stopMode", PaperStopWatchJob.STOP_MODE);
        return new Order(1, PaperBooks.KR_RULES, null, c.get("code").asString(), PaperBooks.SELL, null, null, null, PaperBooks.MARKET,
                PaperBooks.SOURCE_STOP, PaperBooks.ORDER_PENDING, null, reason, session.minusDays(1),
                OffsetDateTime.parse(c.get("createdAt").asString()).toInstant(), session, null);
    }

    /** 길 A — 밤 조각(그 세션 마감 뒤 받은 저장본으로 둠)을 장부와 같이 읽어 사다리. */
    private static KrTimedLadder.Result night(JsonNode c, Order order, TradingCalendar calendar) {
        LocalDate session = LocalDate.parse(c.get("session").asString());
        Instant fetched = calendar.closeInstant(session).plusSeconds(600 + 3_600);
        ObjectNode entry = ((ObjectNode) c.get("night").deepCopy()).put("status", "OK").put("fetchedAt", fetched.toString());
        entry.putNull("reason");
        ObjectNode payload = MAPPER.createObjectNode().put("contract", 1);
        payload.putObject("sessions").putObject(session.toString()).set(c.get("code").asString(), entry);
        Map<LocalDate, Timed> timed = KrQuotes.parseTimed(new Snapshot(Datasets.SNAP_KR_PAPER_TIMED, payload, "json", "ok", null, fetched))
                .get(c.get("code").asString());
        return KrTimedLadder.price(PaperBooks.MARKET, order.createdAt(), null, timed.get(session), null, session, fetched, calendar,
                calendar.closeInstant(session).plusSeconds(3 * 3_600));
    }

    @Test
    @DisplayName("길 B(감시 저장본 → R1)가 체결을 고르면 길 A(밤 1분봉 저장본 → 사다리)도 같은 가격·출처 — 표의 기대값 그대로, 길 B는 R1만 받음")
    void bothPathsAgree() throws IOException {
        int agreed = 0;
        int deferred = 0;
        List<String> names = new ArrayList<>();
        for (JsonNode c : table().get("cases")) {
            String name = c.get("name").asString();
            names.add(name);
            TradingCalendar calendar = calendar(c);
            LocalDate session = LocalDate.parse(c.get("session").asString());
            Order order = stop(c);
            KrTimedLadder.Result a = night(c, order, calendar);
            JsonNode watch = c.get("watch");
            KrIntradayFill.R1 b = KrIntradayFill.r1(order, watch == null || watch.isNull() ? null : watch, session, calendar);

            JsonNode expectNight = c.get("expect").get("night");
            assertThat(a.choice()).as(name + " 길 A").isNotNull();
            assertThat(a.choice().price()).as(name + " 길 A 가격").isEqualByComparingTo(expectNight.get("price").asString());
            assertThat(a.choice().source()).as(name + " 길 A 출처").isEqualTo(expectNight.get("source").asString());
            JsonNode expectWatch = c.get("expect").get("watch");
            if (expectWatch == null || expectWatch.isNull()) {
                assertThat(b.found()).as(name + " 길 B — R1 없음(밤에 맡김): " + b.reason()).isFalse();
                deferred++;
                continue;
            }
            assertThat(b.found()).as(name + " 길 B: " + b.reason()).isTrue();
            assertThat(b.choice().source()).isEqualTo(KrTimedLadder.SOURCE_AT);
            assertThat(b.choice().price()).as(name + " 길 B 가격").isEqualByComparingTo(expectWatch.get("price").asString());
            assertThat(b.choice().date()).isEqualTo(session);
            assertThat(b.barLabel()).as("R1 = 라벨 T+1").isEqualTo(KrTimedLadder.label(LocalTime.parse(c.get("marketKey").asString()).plusMinutes(1)));
            if (c.get("corrected").asBoolean()) {
                assertThat(b.choice().price()).as(name + " 사후 정정 — 두 길이 다름").isNotEqualByComparingTo(a.choice().price());
                continue;
            }
            assertThat(b.choice().price()).as(name + " 두 길 같은 가격").isEqualByComparingTo(a.choice().price());
            assertThat(b.choice().source()).as(name + " 두 길 같은 출처").isEqualTo(a.choice().source());
            // 감시 조각으로 만든 칸을 같은 사다리에 바로 넣어도 같은 값(같은 함수, 두 길).
            Instant target = KrTimedLadder.targetOn(order, session, calendar);
            Timed timed = KrIntradayFill.timed(watch, target.atZone(KrxCalendar.SEOUL).toLocalTime());
            KrTimedLadder.Result direct = KrTimedLadder.price(PaperBooks.MARKET, order.createdAt(), null, timed, null, session,
                    timed.fetchedAt(), calendar, calendar.closeInstant(session));
            assertThat(direct.choice()).isEqualTo(b.choice());
            agreed++;
        }
        assertThat(names).containsExactly("r1", "t1-no-volume", "not-settled", "before-t1", "label-t-traded", "t1-no-open", "out-of-40",
                "exam-day", "stale", "other-session", "corrected", "t1-no-close");
        assertThat(agreed).as("두 길이 같은 값을 고른 사례(보통·라벨 T 거래·수능일)").isEqualTo(3);
        assertThat(deferred).isEqualTo(8);
    }

    @Test
    @DisplayName("사후 정정 가상 사례 — 장중 기록(감시가 본 값)과 밤 체결(정정된 값)이 다르면 대조 칸이 PRICE_MISMATCH·match=false")
    void correctedCaseIsCaughtByTheCheck() throws IOException {
        JsonNode c = null;
        for (JsonNode item : table().get("cases")) {
            if ("corrected".equals(item.get("name").asString())) {
                c = item;
            }
        }
        assertThat(c).isNotNull();
        TradingCalendar calendar = calendar(c);
        LocalDate session = LocalDate.parse(c.get("session").asString());
        Order order = stop(c);
        KrIntradayFill.R1 b = KrIntradayFill.r1(order, c.get("watch"), session, calendar);
        KrTimedLadder.Result a = night(c, order, calendar);
        ObjectNode record = MAPPER.createObjectNode().put(KrIntradayFill.MODE, "SHADOW").put(KrIntradayFill.OUTCOME, KrIntradayFill.RECORD)
                .put(KrIntradayFill.RAW_PRICE, b.choice().price()).put(KrIntradayFill.PRICE_SOURCE, b.choice().source())
                .put(KrIntradayFill.QTY, 10).put(KrIntradayFill.TARGET_AT, KrTimedLadder.targetOn(order, session, calendar).toString())
                .put(KrIntradayFill.SETTINGS_VERSION, 29);
        Order filled = new Order(order.id(), order.bookCode(), null, order.ticker(), order.side(), null, null, null, order.timing(), order.source(),
                PaperBooks.ORDER_FILLED, null, order.reason(), order.asOfTradingDate(), order.createdAt(), order.expiresOn(), Instant.now());
        Fill nightFill = new Fill(9, 1, order.bookCode(), order.ticker(), PaperBooks.SELL, 10, a.choice().price().doubleValue(),
                a.choice().price().doubleValue(), 5, a.choice().price().doubleValue() * 10, Instant.now(), session, a.choice().source(), false,
                null, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO);
        Map<String, Object> check = KrIntradayFill.check(record, filled, nightFill, 29, Instant.parse("2026-11-17T12:00:00Z"));
        assertThat(check.get("match")).isEqualTo(false);
        assertThat(check.get(KrIntradayFill.REASONS)).asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.LIST)
                .containsExactly(KrIntradayFill.PRICE_MISMATCH);
    }
}
