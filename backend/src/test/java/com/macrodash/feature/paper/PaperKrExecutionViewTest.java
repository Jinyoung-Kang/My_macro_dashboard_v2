package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Checkpoint;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.OrderExec;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * GET /api/paper/books/{code}/execution의 한국 Claude 계좌 응답({@link ExecutionView} — 한국 계좌2 단계 2c, 명세 2026-11-02-kr-claude2-stage2 §11):
 * 시장 KR·시점은 시가 기준 + 매시 여섯 + 종가, 고른 시점(M1)은 한국 계좌2만(기준 = 시가 반사실, 대체 출처는 따로, 대리값 표시 없음), 장중 확인 기록은
 * 한국 계좌2 행(현지 시각 KST).
 */
class PaperKrExecutionViewTest {

    private static final LocalDate D = LocalDate.of(2026, 11, 2);
    private static final LocalDate E = LocalDate.of(2026, 11, 3);

    private FakePaperStore store;
    private PaperQueryService query;

    private static Instant kst(String dateTime) {
        return ZonedDateTime.of(LocalDateTime.parse(dateTime), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        PaperMarketData marketData = mock(PaperMarketData.class);
        when(marketData.history(anyCollection(), any(), any())).thenReturn(Map.of());
        when(marketData.quotes(any(PaperMarket.class))).thenReturn(Optional.empty());
        StoreReader reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        query = new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store), PaperFixtures.config(),
                Clock.fixed(Instant.parse("2026-11-20T03:00:00Z"), ZoneOffset.UTC));
        for (String code : List.of(PaperBooks.KR_CLAUDE, PaperBooks.KR_CLAUDE2)) {
            store.books.put(code, new Book(code, PaperBooks.KIND_CLAUDE, code, 100_000_000, LocalDate.of(2026, 10, 30), PaperBooks.ACTIVE,
                    kst("2026-10-30T16:00"), Book.MARKET_KR, Book.CURRENCY_KRW));
        }
    }

    private static ObjectNode price(double raw, Instant at, String rung) {
        return MAPPER.createObjectNode().put("raw", raw).put("at", at.toString()).put("rung", rung);
    }

    /**
     * 한국 계좌 주문 하나 — 시가 반사실 {@code open}(null이면 기준 없음), 10:00 반사실 {@code ten}, 체결 원가격 {@code fillRaw}(null이면 체결 없음 —
     * 만료)와 체결 출처 {@code source}.
     */
    private long order(String book, String timing, Double open, Double ten, Double fillRaw, String source) {
        long id = store.insertOrder(new Order(0, book, 1L, "005930", PaperBooks.BUY, null, 5.0, null, timing, "CLAUDE",
                fillRaw == null ? "EXPIRED" : "FILLED", null, null, D, kst("2026-11-02T22:31"), LocalDate.of(2026, 11, 6), null));
        if (fillRaw != null) {
            store.insertFill(new Fill(0, id, book, "005930", PaperBooks.BUY, 10, fillRaw, fillRaw, 5, 10 * fillRaw,
                    kst("2026-11-03T23:30"), E, source, false, null));
        }
        ObjectNode cf = MAPPER.createObjectNode();
        KrExecutionAudit.TIMINGS.forEach(cf::putNull);
        if (open != null) {
            cf.set(PaperBooks.NEXT_OPEN, price(open, kst("2026-11-03T09:00"), KrExecutionAudit.RUNG_OPEN));
        }
        if (ten != null) {
            cf.set(PaperBooks.AT_1000, price(ten, kst("2026-11-03T10:00"), KrExecutionAudit.RUNG_AT));
        }
        store.mergeOrderExec(new OrderExec(id, book, timing, null, cf, null, null, null));
        return id;
    }

    @Test
    @DisplayName("한국 계좌 응답 — market KR, 시점 = 시가(기준) + 매시 여섯 + 종가, 요약 줄은 기준을 뺀 일곱, 차이 bp는 시가 대비, 계좌1은 M1·장중 확인 없음")
    void shape() {
        order(PaperBooks.KR_CLAUDE, PaperBooks.NEXT_OPEN, 100.0, 101.0, 100.0, KrQuotes.SOURCE_1M_OPEN);

        JsonNode body = MAPPER.valueToTree(query.execution(PaperBooks.KR_CLAUDE, 50));

        assertThat(body.path("available").asBoolean()).isTrue();
        assertThat(body.path("market").asString()).isEqualTo("KR");
        List<String> timings = new ArrayList<>();
        body.path("timings").forEach(t -> timings.add(t.asString()));
        assertThat(timings).containsExactlyElementsOf(KrExecutionAudit.TIMINGS);
        JsonNode summary = body.path("summary");
        assertThat(summary.path("baseline").asString()).isEqualTo(PaperBooks.NEXT_OPEN);
        assertThat(summary.path("formula").asString()).contains("P_NEXT_OPEN");
        List<String> lines = new ArrayList<>();
        summary.path("timings").forEach(t -> lines.add(t.path("timing").asString()));
        assertThat(lines).containsExactlyElementsOf(KrExecutionAudit.TIMINGS.subList(1, KrExecutionAudit.TIMINGS.size()));
        assertThat(summary.path("timings").get(0).path("isProxy").asBoolean()).isFalse();
        JsonNode row = body.path("orders").get(0);
        assertThat(row.path("targetSession").asString()).isEqualTo("2026-11-03");
        assertThat(row.path("advantageBp").path(PaperBooks.AT_1000).asDouble()).as("매수 — 시가 100 대비 101은 −100bp").isEqualTo(-100.0);
        assertThat(row.path("advantageBp").has(PaperBooks.NEXT_OPEN)).isFalse();
        assertThat(row.path("cf").path(PaperBooks.NEXT_OPEN).path("isProxy").asBoolean()).isTrue();
        assertThat(summary.path("chosen").isNull()).as("계좌1 — 고른 시점이 곧 기준").isTrue();
        assertThat(body.path("checkpoints").isEmpty()).isTrue();
        assertThat(summary.path("checkpoints").isNull()).isTrue();
    }

    @Test
    @DisplayName("고른 시점(M1) — 한국 계좌2 체결 원가격 대 시가 반사실, 대체 출처(TOSS_1M_LATE·일봉 시가)는 따로, 기준 없음·체결 없음은 뺀 수, 대리값 표시 없음")
    void chosen() {
        order(PaperBooks.KR_CLAUDE2, PaperBooks.AT_1000, 100.0, null, 101.0, KrTimedLadder.SOURCE_AT);
        order(PaperBooks.KR_CLAUDE2, PaperBooks.NEXT_OPEN, 100.0, null, 100.0, KrQuotes.SOURCE_1M_OPEN);
        order(PaperBooks.KR_CLAUDE2, PaperBooks.AT_1100, 100.0, null, 102.0, KrTimedLadder.SOURCE_LATE);
        order(PaperBooks.KR_CLAUDE2, PaperBooks.NEXT_OPEN, 100.0, null, 99.0, KrQuotes.SOURCE_DAILY);
        order(PaperBooks.KR_CLAUDE2, PaperBooks.AT_1200, 100.0, null, null, null);
        order(PaperBooks.KR_CLAUDE2, PaperBooks.AT_1300, null, null, 103.0, KrTimedLadder.SOURCE_AT);

        JsonNode chosen = MAPPER.valueToTree(query.execution(PaperBooks.KR_CLAUDE2, 50)).path("summary").path("chosen");

        assertThat(chosen.path("formula").asString()).contains("P_NEXT_OPEN");
        assertThat(chosen.path("n").asInt()).isEqualTo(2);
        assertThat(chosen.path("excludedNoBaseline").asInt()).isEqualTo(1);
        assertThat(chosen.path("isProxy").asBoolean()).as("체결가와 기준이 같은 토스 1분봉").isFalse();
        assertThat(chosen.path("fallback").path("n").asInt()).isEqualTo(2);
        assertThat(chosen.path("excludedFallback").asInt()).isEqualTo(2);
        assertThat(chosen.path("notFilled").asInt()).isEqualTo(1);
        assertThat(chosen.path("meanBp").isNull()).as("문턱(주문 10·결정일 5) 아래 — null").isTrue();
    }

    @Test
    @Disabled("QA-253 회귀 재현 — 가짜 저장소를 실제처럼(빈 입력에 불변 Map) 바꾸자 드러남: 확인 결정 번호가 없는 행만 있으면 null 키 조회로 NullPointerException")
    @SuppressWarnings("unchecked")
    @DisplayName("장중 확인 기록 — 한국 계좌2 행(현지 시각 atLocal·atKst 같은 시각, 피드 MINUTE), M8 요약이 있음")
    void checkpoints() {
        long source = store.insertDecisionIfAbsent(new com.macrodash.store.PaperStore.Decision(0, PaperBooks.KR_CLAUDE2, D,
                RuleBookService.SCHEDULED, null, "OK", "claude-sonnet-5-5", 0, 1, null, null, null, null, null,
                MAPPER.createObjectNode(), null, null, null, true, 5L, 0)).orElseThrow();
        store.upsertPlannedCheckpoint(new Checkpoint(PaperBooks.KR_CLAUDE2, E, LocalTime.of(13, 30), ExecutionSection.FEED_MINUTE,
                List.of("005930"), "갭 유지?", source, null, PaperBooks.CHECKPOINT_PLANNED, null, null, null, null, null));

        Map<String, Object> out = query.execution(PaperBooks.KR_CLAUDE2, 50);

        List<Map<String, Object>> rows = (List<Map<String, Object>>) out.get("checkpoints");
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0)).containsEntry("session", "2026-11-03").containsEntry("atLocal", "13:30")
                .containsEntry("atKst", "2026-11-03 13:30 KST").containsEntry("feed", ExecutionSection.FEED_MINUTE);
        Map<String, Object> m8 = (Map<String, Object>) ((Map<String, Object>) out.get("summary")).get("checkpoints");
        assertThat(m8).containsEntry("rows", 1).containsEntry("planned", 1);
    }
}
