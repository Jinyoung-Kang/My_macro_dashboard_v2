package com.macrodash.feature.paper;

import com.macrodash.feature.paper.PaperCheckpointJobTest.MovableClock;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

/**
 * 장중 판단 수동 경로({@link IntradayManualService}·{@link PaperIntradayController} — ADR 0027 결정 3) — 예약만 하고 호출은 작업이 합니다.
 * FakePaperStore·움직이는 시계(네트워크·Claude 없음).
 *
 * <p>시각: 결정 d = 2026-10-30(금), 오늘 세션 E = 11-02(월, EST), 지금 = 10:12:40 ET(15:12:40Z) → 당긴 시각 10:13 ET.
 */
class IntradayManualServiceTest {

    private static final LocalDate D = LocalDate.of(2026, 10, 30);
    private static final LocalDate E = LocalDate.of(2026, 11, 2);
    private static final Instant NOW = Instant.parse("2026-11-02T15:12:40Z");
    private static final LocalTime PULLED = LocalTime.of(10, 13);

    private FakePaperStore store;
    private MovableClock clock;
    private PaperLedgerService ledger;
    private StoreReader reader;
    private long morning;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        clock = new MovableClock(NOW);
        store.dbNow = NOW;
        reader = PaperFixtures.quietReader();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", true);
        ((ObjectNode) store.settings.body().get("claude2")).put("enabled", true).put("freeTiming", true);
        ledger = new PaperLedgerService(store, mock(PaperMarketData.class), MAPPER);
        for (String code : List.of(PaperBooks.CLAUDE, PaperBooks.CLAUDE2)) {
            store.books.put(code, new Book(code, PaperBooks.KIND_CLAUDE, code, 100_000, D, PaperBooks.ACTIVE, NOW.minusSeconds(864_000)));
            store.states.put(code, new BookState(code, 100_000, 100_000, 0, 0, null, null, D, null));
        }
        morning = decision(PaperBooks.CLAUDE, RuleBookService.SCHEDULED, "OK", PacketBuilder.VARIANT_FREE, NOW.minusSeconds(60_000));
    }

    private long decision(String code, String kind, String status, String variant, Instant decidedAt) {
        String packet = "{\"1_basis\":{\"book\":\"" + code + "\"" + (variant == null ? "" : ",\"variant\":\"" + variant + "\"") + "}}";
        store.dbNow = decidedAt;
        long id = store.insertDecisionIfAbsent(new Decision(0, code, D, kind, null, status, "claude-sonnet-5-5", 0, 1, null, 20.0, null,
                null, null, null, null, null, List.of(), true, 1L, 0, packet)).orElseThrow();
        store.dbNow = clock.now;
        return id;
    }

    private IntradayManualService service(boolean enabled) {
        return new IntradayManualService(store, new PaperMarkets(store, reader), ledger,
                new PaperConfig(enabled, PaperFixtures.FRI, 100_000), MAPPER, clock);
    }

    private void plan(String code, int slot, LocalTime at, String status) {
        store.upsertPlannedIntradayPlan(IntradayPlan.planned(code, E, slot, at, "MINUTE", List.of("AAA"), "예약한 질문", "ft-1", false,
                morning, null));
        if (!PaperBooks.CHECKPOINT_PLANNED.equals(status)) {
            store.markIntradayPlan(code, E, slot, PaperBooks.CHECKPOINT_PLANNED, status, null, null, null, null);
        }
    }

    @Test
    @DisplayName("당김: 가장 이른 남은 예약(13:30·순번 1)의 시각을 지금 + 1분(10:13 ET)으로 바꾸고 수동 표시를 켬 — 피드·감시 목록·질문·그 세션의 결정은 그대로, "
            + "뒤 순번 예약은 그대로")
    void pullsTheEarliestPlannedRow() {
        plan(PaperBooks.CLAUDE, 1, LocalTime.of(13, 30), PaperBooks.CHECKPOINT_PLANNED);
        plan(PaperBooks.CLAUDE, 2, LocalTime.of(14, 30), PaperBooks.CHECKPOINT_PLANNED);

        IntradayManualService.Pulled pulled = service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE);

        assertThat(pulled).isEqualTo(new IntradayManualService.Pulled(PaperBooks.CLAUDE, E, 1, PULLED, "MINUTE", false, false));
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, E)).extracting(p -> p.slot() + " " + p.atLocal() + " " + p.manual() + " "
                + p.feed() + " " + p.watch() + " " + p.question() + " " + p.status() + " " + p.sourceDecisionId())
                .containsExactly("1 10:13 true MINUTE [AAA] 예약한 질문 PLANNED " + morning,
                        "2 14:30 false MINUTE [AAA] 예약한 질문 PLANNED " + morning);

        // 이미 부를 차례인 예약(10:13)은 다시 당길 것이 없음.
        assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("이미 부를 차례");
    }

    @Test
    @DisplayName("새 행: 남은 예약이 없고 순번이 남았으면 다음 순번의 수동 행(미국 HOURLY·감시 목록 없음·오늘 세션의 자유 시점 판 결정)을 넣음 — 닫힌 순번"
            + "(SUPERSEDED)은 다시 씀. 순번을 다 썼으면 409")
    void createsARowWhenNothingIsPlanned() {
        IntradayManualService.Pulled first = service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE);
        assertThat(first).isEqualTo(new IntradayManualService.Pulled(PaperBooks.CLAUDE, E, 1, PULLED, "HOURLY", true, false));
        IntradayPlan row = store.intradayPlans(PaperBooks.CLAUDE, E).get(0);
        assertThat(row.manual()).isTrue();
        assertThat(row.watch()).isEmpty();
        assertThat(row.question()).isEqualTo(IntradayManualService.MANUAL_QUESTION);
        assertThat(row.variant()).isEqualTo(PacketBuilder.FREE_FIXED_RULES_VERSION);
        assertThat(row.sourceDecisionId()).isEqualTo(morning);

        // 첫 판단이 끝남 → 둘째 순번. 닫힌 순번 2가 있어도 다시 씀.
        store.markIntradayPlan(PaperBooks.CLAUDE, E, 1, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_DONE, null, null, null, NOW);
        plan(PaperBooks.CLAUDE, 2, LocalTime.of(14, 30), PaperBooks.INTRADAY_SUPERSEDED);
        clock.now = NOW.plusSeconds(3_600);
        IntradayManualService.Pulled second = service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE);
        assertThat(second.slot()).isEqualTo(2);
        assertThat(second.at()).isEqualTo(LocalTime.of(11, 13));
        assertThat(store.intradayPlans(PaperBooks.CLAUDE, E).get(1).status()).isEqualTo(PaperBooks.CHECKPOINT_PLANNED);

        store.markIntradayPlan(PaperBooks.CLAUDE, E, 2, PaperBooks.CHECKPOINT_PLANNED, PaperBooks.CHECKPOINT_EXPIRED, "WINDOW_MISSED", null,
                null, null);
        assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE))
                .isInstanceOfSatisfying(ResponseStatusException.class, e -> {
                    assertThat(e.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(e.getReason()).contains("다 썼습니다").contains("2번");
                });

        // 세션당 횟수 1이면 첫 순번이 끝난 뒤 바로 409.
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 1);
        store.intradayPlans.clear();
        plan(PaperBooks.CLAUDE, 1, LocalTime.of(10, 0), PaperBooks.CHECKPOINT_DONE);
        assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE))
                .isInstanceOf(ResponseStatusException.class);
    }

    @Test
    @DisplayName("거절(400): 그 시장의 Claude 계좌가 아님·정기 작업이 꺼진 서버·횟수 0·계좌2 꺼짐·받는 범위 밖·거래일 아님·운용 중이 아님·오늘 세션의 자유 시점 "
            + "판 결정이 없음(끈 판 결정·실패한 결정은 아님) — 계획 행을 쓰지 않음")
    void rejections() {
        for (String bad : new String[]{null, "rules", PaperBooks.KR_CLAUDE}) {
            assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, bad)).as("book=" + bad)
                    .isInstanceOf(InvalidRequestException.class).hasMessageContaining("book");
        }
        assertThatThrownBy(() -> service(false).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("PAPER_ENABLED=false");

        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 0);
        assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("횟수 설정이 0");
        ((ObjectNode) store.settings.body()).put(FreeTimingSettings.US_INTRADAY_MAX, 2);
        ((ObjectNode) store.settings.body().get("claude2")).put("enabled", false);
        assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE2))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("claude2.enabled");
        ((ObjectNode) store.settings.body().get("claude2")).put("enabled", true);

        // 받는 범위(09:40~15:30 ET — 개장 10분 뒤부터) 밖 — 09:33·09:38(당긴 시각 09:39)과 15:30(당긴 시각 15:31).
        for (String at : new String[]{"2026-11-02T14:33:00Z", "2026-11-02T14:38:10Z", "2026-11-02T20:30:10Z"}) {
            clock.now = Instant.parse(at);
            assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE)).as(at)
                    .isInstanceOf(InvalidRequestException.class).hasMessageContaining("09:40~15:30 ET");
        }
        clock.now = Instant.parse("2026-11-01T15:12:40Z");   // 일요일
        assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("거래일이 아닙니다");
        clock.now = NOW;

        // 계좌2 — 오늘 세션의 결정이 끈 판(판 표시 없음)·실패(API_ERROR)면 새 행을 넣지 않음.
        decision(PaperBooks.CLAUDE2, RuleBookService.SCHEDULED, "OK", PacketBuilder.VARIANT_CLAUDE2, NOW.minusSeconds(60_000));
        decision(PaperBooks.CLAUDE2, RuleBookService.MANUAL, "API_ERROR", PacketBuilder.VARIANT_FREE, NOW.minusSeconds(30_000));
        assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE2))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("자유 시점 판 결정이 없습니다");

        store.books.put(PaperBooks.CLAUDE, new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "claude", 100_000, D, PaperBooks.PAUSED, NOW));
        assertThatThrownBy(() -> service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("운용 중이 아닙니다");
        assertThat(store.intradayPlans).as("거절한 요청은 아무것도 쓰지 않음").isEmpty();
    }

    @Test
    @DisplayName("가장 늦게 낸 자유 시점 판 결정이 그 세션의 결정 — 정기 결정 뒤의 수동 결정(켠 판)이면 그 결정에 붙음")
    void usesTheLatestFreeTimingDecisionOfTheSession() {
        long manual = decision(PaperBooks.CLAUDE, RuleBookService.MANUAL, "NO_TRADE", PacketBuilder.VARIANT_FREE, NOW.minusSeconds(10_000));

        service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE);

        assertThat(store.intradayPlans(PaperBooks.CLAUDE, E).get(0).sourceDecisionId()).isEqualTo(manual);
    }

    @Test
    @DisplayName("경로 응답: 예약만 했음을 돌려줌 — {ok, planned:{book, session, slot, atEt, feed, manual, created, status}, note}. 테이블이 없으면 "
            + "available:false·ok:false")
    void controllerResponse() {
        PaperQueryService query = new PaperQueryService(store, mock(PaperMarketData.class), reader, PaperFixtures.settings(store),
                new PaperConfig(true, PaperFixtures.FRI, 100_000), clock);
        PaperIntradayController controller = new PaperIntradayController(query, service(true), new PaperMarkets(store, reader));

        Map<String, Object> out = controller.runIntraday(null, new PaperIntradayController.IntradayRunRequest(PaperBooks.CLAUDE));

        assertThat(out.get("ok")).isEqualTo(true);
        assertThat(out).doesNotContainKey("market");
        assertThat(out.get("planned")).isEqualTo(Map.of("book", "claude", "session", "2026-11-02", "slot", 1, "atEt", "10:13", "feed",
                "HOURLY", "manual", true, "created", true, "status", "PLANNED"));
        assertThat((String) out.get("note")).contains("예약됨").contains("+ 2분").contains("+ 20분");
        assertThatThrownBy(() -> controller.runIntraday("JP", new PaperIntradayController.IntradayRunRequest(PaperBooks.CLAUDE)))
                .isInstanceOf(InvalidRequestException.class);

        store.ready = false;
        Map<String, Object> missing = controller.runIntraday(null, new PaperIntradayController.IntradayRunRequest(PaperBooks.CLAUDE));
        assertThat(missing.get("ok")).isEqualTo(false);
        assertThat(missing.get("available")).isEqualTo(false);
    }

    @Test
    @DisplayName("상태 응답의 장중 판단 묶음(intraday): 스위치가 켜진 계좌와 그 세션의 계획 행(순번·시각·피드·상태·수동 여부) — 스위치가 모두 꺼져 있고 계획 "
            + "행도 없으면 칸이 없음(응답이 그대로). 주문 행은 분 단위 지정 시각이면 targetLocal을 더함")
    @SuppressWarnings("unchecked")
    void statusShowsTheIntradayPlans() {
        PaperQueryService query = new PaperQueryService(store, mock(PaperMarketData.class), reader, PaperFixtures.settings(store),
                new PaperConfig(true, PaperFixtures.FRI, 100_000), clock);
        plan(PaperBooks.CLAUDE, 1, LocalTime.of(13, 30), PaperBooks.CHECKPOINT_PLANNED);
        service(true).pull(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE);

        Map<String, Object> intraday = (Map<String, Object>) query.status().get("intraday");

        assertThat(intraday.get("session")).isEqualTo("2026-11-02");
        assertThat(intraday.get("maxPerSession")).isEqualTo(2);
        List<Map<String, Object>> books = (List<Map<String, Object>>) intraday.get("books");
        assertThat(books).extracting(b -> b.get("book") + " " + b.get("freeTiming")).containsExactly("claude true", "claude2 true");
        List<Map<String, Object>> plans = (List<Map<String, Object>>) books.get(0).get("plans");
        assertThat(plans).singleElement().satisfies(p -> {
            assertThat(p.get("slot")).isEqualTo(1);
            assertThat(p.get("at")).isEqualTo("10:13");
            assertThat(p.get("feed")).isEqualTo("MINUTE");
            assertThat(p.get("manual")).isEqualTo(true);
            assertThat(p.get("status")).isEqualTo("PLANNED");
            assertThat(p.get("decisionId")).isNull();
        });
        assertThat((List<?>) books.get(1).get("plans")).as("계좌2는 스위치만 켜져 있고 예약 없음").isEmpty();

        // 스위치를 모두 끄고 계획 행도 없으면 칸이 없음 — 스위치를 꺼도 남은 계획 행이 있는 계좌는 보임.
        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", false);
        ((ObjectNode) store.settings.body().get("claude2")).put("freeTiming", false);
        Map<String, Object> remaining = (Map<String, Object>) query.status().get("intraday");
        assertThat((List<Map<String, Object>>) remaining.get("books")).extracting(b -> b.get("book") + " " + b.get("freeTiming"))
                .containsExactly("claude false");
        store.intradayPlans.clear();
        assertThat(query.status()).doesNotContainKey("intraday");

        // 주문 행 — 분 단위 지정 시각이면 그 시각, 그 밖의 시점은 칸이 없음.
        store.insertOrder(new com.macrodash.store.PaperStore.Order(0, PaperBooks.CLAUDE, morning, "AAA", PaperBooks.BUY, null, 5.0, null,
                PaperBooks.AT_MINUTE, "CLAUDE", PaperBooks.ORDER_PENDING, null, null, D, NOW, E, null, LocalTime.of(10, 47)));
        store.insertOrder(new com.macrodash.store.PaperStore.Order(0, PaperBooks.CLAUDE, morning, "BBB", PaperBooks.BUY, null, 5.0, null,
                PaperBooks.NEXT_CLOSE, "CLAUDE", PaperBooks.ORDER_PENDING, null, null, D, NOW, E, null));
        List<Map<String, Object>> orders = (List<Map<String, Object>>) query.orders(PaperBooks.CLAUDE, 10).get("orders");
        assertThat(orders).extracting(o -> o.get("ticker") + " " + o.get("timing") + " " + o.get("targetLocal"))
                .containsExactlyInAnyOrder("AAA AT_MINUTE 10:47", "BBB NEXT_CLOSE null");
        assertThat(orders.stream().filter(o -> "BBB".equals(o.get("ticker"))).findFirst().orElseThrow()).doesNotContainKey("targetLocal");
    }
}
