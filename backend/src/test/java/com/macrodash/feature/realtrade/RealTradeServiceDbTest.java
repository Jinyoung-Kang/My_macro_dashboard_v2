package com.macrodash.feature.realtrade;

import com.macrodash.collector.CollectorTradeClient;
import com.macrodash.collector.CollectorTradeClient.CancelResult;
import com.macrodash.collector.CollectorTradeClient.Holding;
import com.macrodash.collector.CollectorTradeClient.OrderResult;
import com.macrodash.collector.CollectorTradeClient.Outcome;
import com.macrodash.collector.CollectorTradeClient.Preflight;
import com.macrodash.collector.CollectorTradeClient.Quote;
import com.macrodash.collector.CollectorTradeClient.Reply;
import com.macrodash.feature.auth.AuthService;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.OpenTargets;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.realtrade.RealTradeFixtures.MutableClock;
import com.macrodash.store.RealTradeStore;
import com.macrodash.store.RealTradeStore.Config;
import com.macrodash.store.RealTradeStore.Event;
import com.macrodash.store.UserStore;
import com.macrodash.support.CurrentUser;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.jdbc.core.JdbcTemplate;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.realtrade.RealTradeFixtures.BOOK;
import static com.macrodash.feature.realtrade.RealTradeFixtures.GENERATION;
import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 실제 매매 API({@link RealTradeService}, ADR 0028 — 명세 2026-11-06 §7.2) — 실제 테스트 DB와 가짜 수집기·모의 공개 창·인증으로: 켜기(확인 글자·비밀번호·서버
 * 스위치·버전), 비밀번호 틀림·잠금(연속 5번 → 30분), 끄기는 비밀번호 없이(서버 스위치가 꺼져도), 미국 400, 설정 바꾸기, 멈춤 해제, 상태·예상 목록 응답 모양
 * (토스 주문 번호·클라이언트 키 없음). 이벤트 시각은 DB 시각이라 시계는 지금 시각에서 시작합니다.
 */
class RealTradeServiceDbTest {

    private static final String OWNER_EMAIL = "owner@test.local";
    private static final String RIGHT = "right-password";
    private static final CurrentUser OWNER = new CurrentUser(7L, OWNER_EMAIL, "OWNER", "PRO", null);
    private static final String A = "005930";
    private static final String C = "035420";

    private JdbcTemplate jdbc;
    private RealTradeStore store;
    private CollectorTradeClient client;
    private PaperMirrorService paper;
    private AuthService auth;
    private MutableClock clock;
    private RealTradeExecutor executor;
    private RealTradeJob job;

    @BeforeEach
    void setUp() {
        jdbc = RealTradeFixtures.jdbc();
        store = RealTradeFixtures.store(jdbc);
        RealTradeFixtures.clean(jdbc);
        client = mock(CollectorTradeClient.class);
        paper = mock(PaperMirrorService.class);
        auth = mock(AuthService.class);
        clock = new MutableClock(Instant.now());
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        when(client.openOrders()).thenReturn(Reply.of(List.of()));
        when(client.todayOrders()).thenReturn(Reply.of(List.of()));
        when(client.preflight(any(), any())).thenReturn(Reply.of(new Preflight(clock.now, d("9000000"),
                List.of(new Holding(A, "합성", d("10"), d("100000"))), Map.of(A, new Quote(d("100000"), d("130000"), null)),
                Map.of())));
        when(paper.book(anyString())).thenAnswer(inv -> Optional.of(new BookInfo(inv.getArgument(0), "합성 책", "CLAUDE", "KR", "ACTIVE",
                LocalDate.of(2026, 10, 30), Instant.parse("2026-10-29T13:00:00Z"), GENERATION)));
        when(paper.cashLikeTickers()).thenReturn(List.of("153130"));
        when(auth.verify(eq(OWNER_EMAIL), eq(RIGHT))).thenReturn(Optional.of(new UserStore.User(7L, OWNER_EMAIL, "hash", "OWNER", "PRO",
                Instant.EPOCH, Instant.EPOCH)));
        executor = new RealTradeExecutor(store, client, paper, RealTradeFixtures.MAPPER, clock);
        job = new RealTradeJob(store, executor, client, paper, mock(PaperTelegram.class), RealTradeFixtures.MAPPER, clock, true, false,
                10_000);
    }

    @AfterEach
    void tearDown() {
        RealTradeFixtures.clean(jdbc);
    }

    private RealTradeService service(boolean enabled) {
        return new RealTradeService(store, client, paper, auth, job, executor, clock, enabled);
    }

    private static RealTradeService.EnableRequest enable(String confirm, String password, int version) {
        return new RealTradeService.EnableRequest("KR", BOOK, new BigDecimal("20"), confirm, password, version);
    }

    private static void rejects(Runnable call, int status, String code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(RealTradeException.class, e -> {
            assertThat(e.status()).isEqualTo(status);
            assertThat(e.code()).isEqualTo(code);
        });
    }

    private List<Event> events(String kind) {
        return store.recentEvents("KR", 50).stream().filter(e -> e.kind().equals(kind)).toList();
    }

    // ------------------------------------------------------------------ 켜기
    @Test
    @DisplayName("켜기 — 확인 글자·비밀번호·서버 두 스위치·버전이 맞으면 LIVE, sync_pending, 기준 평가액(지금 E), 따라 하는 책과 세대")
    void enables() {
        Map<String, Object> out = service(true).enable(OWNER, enable("실제 매매 켜기", RIGHT, 0));

        assertThat(out).containsEntry("ok", true).containsEntry("state", "LIVE").containsEntry("version", 1);
        Config cfg = store.config("KR").orElseThrow();
        assertThat(cfg.state()).isEqualTo("LIVE");
        assertThat(cfg.syncPending()).isTrue();
        assertThat(cfg.buysPaused()).isFalse();
        assertThat(cfg.sourceBook()).isEqualTo(BOOK);
        assertThat(cfg.bookGeneration()).isEqualTo(GENERATION);
        assertThat(cfg.lossLimitPct()).isEqualByComparingTo("20");
        assertThat(cfg.baselineEquity()).isEqualByComparingTo("10000000");
        assertThat(cfg.baselineTotal()).as("총액이 상한보다 작으면 기준 총액 = 기준 평가액").isEqualByComparingTo("10000000");
        assertThat(cfg.updatedBy()).isEqualTo(7L);
        assertThat(events("ENABLE")).singleElement().satisfies(e -> {
            assertThat(e.userId()).isEqualTo(7L);
            assertThat(e.notifies()).isTrue();
        });
    }

    @Test
    @DisplayName("켜기·기준 다시 잡기 — 총액이 안전 상한보다 크면 기준 평가액은 상한, 기준 총액은 상한 없는 총액(손실 판정의 기준)")
    void baselineKeepsUncappedTotal() {
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 200, 999_999_999L,
                4_000_000L)));
        service(true).enable(OWNER, enable("실제 매매 켜기", RIGHT, 0));
        Config cfg = store.config("KR").orElseThrow();
        assertThat(cfg.baselineEquity()).isEqualByComparingTo("4000000");
        assertThat(cfg.baselineTotal()).isEqualByComparingTo("10000000");

        when(client.preflight(any(), any())).thenReturn(Reply.of(new Preflight(clock.now, d("12000000"),
                List.of(new Holding(A, "합성", d("10"), d("100000"))), Map.of(A, new Quote(d("100000"), d("130000"), null)), Map.of())));
        service(true).update(OWNER, new RealTradeService.UpdateRequest("KR", null, null, true, "설정 바꾸기", RIGHT, cfg.version()));
        Config rebased = store.config("KR").orElseThrow();
        assertThat(rebased.baselineEquity()).isEqualByComparingTo("4000000");
        assertThat(rebased.baselineTotal()).isEqualByComparingTo("13000000");
        assertThat(service(true).status("KR").get("baselineTotal")).isEqualTo(rebased.baselineTotal());
    }

    @Test
    @DisplayName("켜기 거절 — 확인 글자 다름 400(비밀번호를 보지 않음), 미국 400 not-supported, 버전 다름 409, 서버 스위치 꺼짐 409, 운영자 아님 403")
    void enableRejections() {
        RealTradeService svc = service(true);
        rejects(() -> svc.enable(OWNER, enable("실제 매매 켜기 ", RIGHT, 0)), 400, "confirm-mismatch");
        verify(auth, never()).verify(anyString(), anyString());
        rejects(() -> svc.enable(OWNER, new RealTradeService.EnableRequest("US", BOOK, null, "실제 매매 켜기", RIGHT, 0)), 400,
                "not-supported");
        rejects(() -> svc.enable(OWNER, new RealTradeService.EnableRequest("kr", BOOK, null, "실제 매매 켜기", RIGHT, 0)), 400,
                "invalid-market");
        rejects(() -> svc.enable(OWNER, enable("실제 매매 켜기", RIGHT, 3)), 409, "version-conflict");
        rejects(() -> svc.enable(OWNER, new RealTradeService.EnableRequest("KR", "rules", null, "실제 매매 켜기", RIGHT, 0)), 400,
                "invalid-source-book");
        rejects(() -> svc.enable(OWNER, new RealTradeService.EnableRequest("KR", BOOK, new BigDecimal("60"), "실제 매매 켜기", RIGHT, 0)),
                400, "invalid-loss-limit");
        rejects(() -> service(false).enable(OWNER, enable("실제 매매 켜기", RIGHT, 0)), 409, "server-disabled");
        rejects(() -> svc.enable(new CurrentUser(8L, "member@test.local", "MEMBER", "PRO", null), enable("실제 매매 켜기", RIGHT, 0)),
                403, "forbidden");
        assertThat(store.configOrOff("KR").state()).isEqualTo("OFF");
        assertThat(events("PASSWORD_FAILED")).isEmpty();
    }

    @Test
    @DisplayName("비밀번호 틀림 403(이벤트·알림), 연속 5번이면 맞는 비밀번호도 30분 동안 password-locked, 30분 뒤 맞으면 켜지고 횟수가 비워짐")
    void passwordLock() {
        RealTradeService svc = service(true);
        for (int i = 1; i <= 5; i++) {
            rejects(() -> svc.enable(OWNER, enable("실제 매매 켜기", "wrong", 0)), 403, "password-invalid");
        }
        List<Event> failures = events("PASSWORD_FAILED");
        assertThat(failures).hasSize(5);
        assertThat(failures.getFirst().detail().path("consecutive").asInt()).isEqualTo(5);
        assertThat(failures.getFirst().detail().path("locked").asBoolean()).isTrue();
        assertThat(failures).allMatch(Event::notifies);

        rejects(() -> svc.enable(OWNER, enable("실제 매매 켜기", RIGHT, 0)), 403, "password-locked");
        rejects(() -> svc.resume(OWNER, new RealTradeService.ResumeRequest("KR", "멈춤 해제", RIGHT, 0)), 403, "password-locked");
        assertThat(store.configOrOff("KR").state()).isEqualTo("OFF");

        clock.set(clock.now.plus(Duration.ofMinutes(31)));
        assertThat(svc.enable(OWNER, enable("실제 매매 켜기", RIGHT, 0))).containsEntry("state", "LIVE");
        assertThat(store.passwordFailuresSinceLastSuccess(Instant.EPOCH)).as("성공 뒤에는 연속 실패가 비워짐").isEmpty();
    }

    // ------------------------------------------------------------------ 끄기
    @Test
    @DisplayName("끄기는 비밀번호·확인 글자 없이 늘(서버 스위치가 꺼져 있어도) — 미종료 주문이 없으면 OFF, 있으면 STOPPING")
    void disableAlwaysAccepted() {
        RealTradeFixtures.live(store, false, d("10000000"));
        Map<String, Object> off = service(false).disable(OWNER, new RealTradeService.DisableRequest("KR"));
        assertThat(off).containsEntry("ok", true).containsEntry("state", "OFF");
        assertThat(events("DISABLE")).singleElement().satisfies(e -> assertThat(e.notifies()).isTrue());
        verify(auth, never()).verify(anyString(), anyString());

        Config live = RealTradeFixtures.live(store, false, d("10000000"));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-1", null, 200));
        RealTradeFixtures.claimRunsInsert(paper);
        executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 101L, 100L, A, "BUY", 1,
                "DAY", d("70000"), 1), live);
        assertThat(service(true).disable(OWNER, new RealTradeService.DisableRequest("KR"))).containsEntry("state", "STOPPING");
        assertThat(service(true).disable(OWNER, new RealTradeService.DisableRequest("KR"))).as("끄는 중에 다시 눌러도 그대로")
                .containsEntry("state", "STOPPING");
        assertThat(service(true).disable(OWNER, new RealTradeService.DisableRequest("US"))).containsEntry("state", "OFF");
        rejects(() -> service(true).disable(OWNER, new RealTradeService.DisableRequest(null)), 400, "invalid-market");
    }

    // ------------------------------------------------------------------ 설정 바꾸기·멈춤 해제
    @Test
    @DisplayName("설정 바꾸기 — 방식이 바뀌면 sync_pending, 손실 한도·기준 다시 잡기, 켜짐에서만")
    void updates() {
        Config live = RealTradeFixtures.live(store, false, d("20000000"));
        RealTradeService svc = service(true);
        rejects(() -> svc.update(OWNER, new RealTradeService.UpdateRequest("KR", null, null, null, "설정 바꾸기", RIGHT, live.version())),
                400, "nothing-to-update");
        Map<String, Object> out = svc.update(OWNER, new RealTradeService.UpdateRequest("KR", "kr_rules", new BigDecimal("10.5"), true,
                "설정 바꾸기", RIGHT, live.version()));
        assertThat(out).containsEntry("state", "LIVE");
        Config cfg = store.config("KR").orElseThrow();
        assertThat(cfg.sourceBook()).isEqualTo("kr_rules");
        assertThat(cfg.syncPending()).isTrue();
        assertThat(cfg.lossLimitPct()).isEqualByComparingTo("10.5");
        assertThat(cfg.baselineEquity()).isEqualByComparingTo("10000000");
        assertThat(events("UPDATE")).singleElement();
        rejects(() -> svc.update(OWNER, new RealTradeService.UpdateRequest("US", null, BigDecimal.TEN, null, "설정 바꾸기", RIGHT, 0)),
                400, "not-supported");
    }

    @Test
    @DisplayName("RT2-3: 기준 다시 잡기 — 이 기능의 미체결 매수(토스 주문 번호 있음)가 있으면 409 invalid-state(사전 조회 전과 잠금 안), 손실 한도만 바꾸기와 매도 미체결은 막지 않음")
    void rebaselineRefusedWhilePendingBuy() {
        Config live = RealTradeFixtures.live(store, false, d("10000000"));
        RealTradeFixtures.claimRunsInsert(paper);
        RealTradeService svc = service(true);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-1", null, 200));
        Preflight fresh = new Preflight(clock.now, d("9000000"), List.of(new Holding(A, "합성", d("10"), d("100000"))),
                Map.of(A, new Quote(d("100000"), d("130000"), null)), Map.of());
        when(client.preflight(any(), any())).thenAnswer(inv -> {
            if (store.unfinishedOrders("KR").isEmpty()) {   // 사전 조회 도중(잠금 밖) 이 기능의 매수가 접수됨
                executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 101L, 100L, C, "BUY",
                        1, "DAY", d("70000"), 1), store.config("KR").orElseThrow());
            }
            return Reply.of(fresh);
        });

        rejects(() -> svc.update(OWNER, new RealTradeService.UpdateRequest("KR", null, null, true, "설정 바꾸기", RIGHT, live.version())),
                409, "invalid-state");
        Config after = store.config("KR").orElseThrow();
        assertThat(after.version()).as("잠금 안에서 다시 확인해 거절 — 기준을 쓰지 않음").isEqualTo(live.version());
        assertThat(after.baselineTotal()).isNull();
        verify(client, times(1)).preflight(any(), any());

        rejects(() -> svc.update(OWNER, new RealTradeService.UpdateRequest("KR", null, null, true, "설정 바꾸기", RIGHT, live.version())),
                409, "invalid-state");
        verify(client, times(1)).preflight(any(), any());   // 이미 있으면 사전 조회 전에 거절

        assertThat(svc.update(OWNER, new RealTradeService.UpdateRequest("KR", null, new BigDecimal("12"), null, "설정 바꾸기", RIGHT,
                live.version()))).as("손실 한도만 바꾸기는 받음").containsEntry("state", "LIVE");

        long buyRow = store.unfinishedOrders("KR").getFirst().id();
        store.recordTracking(buyRow, new RealTradeStore.Tracking("FILLED", true, d("1"), d("70000"), d("70000"), null, null, clock.now));
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-2", null, 200));
        executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 111L, 110L, A, "SELL", 1,
                "DAY", d("100000"), 1), store.config("KR").orElseThrow());
        Config before = store.config("KR").orElseThrow();
        assertThat(svc.update(OWNER, new RealTradeService.UpdateRequest("KR", null, null, true, "설정 바꾸기", RIGHT, before.version())))
                .as("매수가 끝나면(매도 미체결만 남음) 다시 잡음").containsEntry("state", "LIVE");
        assertThat(store.config("KR").orElseThrow().baselineTotal()).isEqualByComparingTo("10000000");
    }

    @Test
    @DisplayName("멈춤 해제 — HALTED → LIVE(sync_pending), 재전송 창이 끝난 결과 모름 행은 사람 확인으로 종료, 켜짐의 매수 멈춤도 이 경로로 해제")
    void resumes() {
        Config live = RealTradeFixtures.live(store, false, d("10000000"));
        RealTradeFixtures.claimRunsInsert(paper);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 101L, 100L, A, "BUY", 1,
                "DAY", d("70000"), 1), live);
        executor.halt("unknown-order", Map.of());
        Config halted = store.config("KR").orElseThrow();
        clock.set(clock.now.plus(Duration.ofMinutes(8)));

        Map<String, Object> out = service(true).resume(OWNER, new RealTradeService.ResumeRequest("KR", "멈춤 해제", RIGHT, halted.version()));
        assertThat(out).containsEntry("state", "LIVE");
        Config cfg = store.config("KR").orElseThrow();
        assertThat(cfg.syncPending()).isTrue();
        assertThat(cfg.haltReason()).isNull();
        assertThat(store.unfinishedOrders("KR")).isEmpty();
        assertThat(store.recentOrders("KR", 1).getFirst().outcomeCode()).isEqualTo("operator-resolved");

        store.lockConfig("KR", current -> store.updateConfig(current.withBuysPaused(true), null));
        Config paused = store.config("KR").orElseThrow();
        service(true).resume(OWNER, new RealTradeService.ResumeRequest("KR", "멈춤 해제", RIGHT, paused.version()));
        assertThat(store.config("KR").orElseThrow().buysPaused()).isFalse();

        Config plain = store.config("KR").orElseThrow();
        rejects(() -> service(true).resume(OWNER, new RealTradeService.ResumeRequest("KR", "멈춤 해제", RIGHT, plain.version())), 409,
                "invalid-state");
    }

    // ------------------------------------------------------------------ 응답 모양
    @Test
    @DisplayName("상태 — 명세 §7.2 칸, 최근 실제 주문에 토스 주문 번호·클라이언트 키·요청 본문이 없음, 미국은 supported=false")
    void statusShape() throws Exception {
        Config live = RealTradeFixtures.live(store, false, d("10000000"));
        RealTradeFixtures.claimRunsInsert(paper);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "TOSSSECRET1", null, 200));
        executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 101L, 100L, A, "BUY", 1,
                "DAY", d("70000"), 1), live);
        String clientKey = store.recentOrders("KR", 1).getFirst().clientOrderId();

        Map<String, Object> kr = service(true).status("KR");
        assertThat(kr.keySet()).containsExactly("available", "market", "supported", "serverTime", "serverEnabled", "state", "sourceBook",
                "sourceLabel", "lossLimitPct", "baselineEquity", "baselineTotal", "buysPaused", "haltReason", "unfinishedOrders",
                "cancelGaveUpOrders", "unresolvedOrders", "version", "limits", "today", "jobLastCycleAt", "jobStartedAt", "lastPreflight",
                "orders", "events", "books");
        assertThat(kr).containsEntry("unfinishedOrders", 1).containsEntry("jobLastCycleAt", null).containsEntry("jobStartedAt", null)
                .containsEntry("cancelGaveUpOrders", 0).containsEntry("unresolvedOrders", 0).containsEntry("serverTime", clock.now.toString());
        assertThat(kr).containsEntry("available", true).containsEntry("supported", true).containsEntry("state", "LIVE");
        @SuppressWarnings("unchecked")
        Map<String, Object> server = (Map<String, Object>) kr.get("serverEnabled");
        assertThat(server).containsEntry("collector", true).containsEntry("backend", true);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> orders = (List<Map<String, Object>>) kr.get("orders");
        assertThat(orders).singleElement().satisfies(o -> {
            assertThat(o).containsEntry("symbol", A).containsEntry("purpose", "MIRROR").containsEntry("sendOutcome", "ACCEPTED");
            assertThat(o).doesNotContainKeys("clientOrderId", "tossOrderId", "requestBody", "orderId");
        });
        String json = RealTradeFixtures.MAPPER.writeValueAsString(kr);
        assertThat(json).doesNotContain("TOSSSECRET1", clientKey);

        Map<String, Object> us = service(true).status("US");
        assertThat(us).containsEntry("supported", false).containsEntry("state", "OFF").containsEntry("cancelGaveUpOrders", 0)
                .containsEntry("unresolvedOrders", 0);
        rejects(() -> service(true).status("JP"), 400, "invalid-market");
    }

    @Test
    @DisplayName("상태 — 토스 주문 번호가 있는 미종료 행 수(건수만), 정기 작업의 마지막 주기 시각(ISO — 정기 작업이 꺼져 있으면 null), 마지막 사전 조회의 총액")
    void statusJobAndOpenOrders() {
        RealTradeJob scheduled = new RealTradeJob(store, executor, client, paper, mock(PaperTelegram.class), RealTradeFixtures.MAPPER, clock,
                true, true, 10_000);
        RealTradeService svc = new RealTradeService(store, client, paper, auth, scheduled, executor, clock, true);
        assertThat(svc.status("KR")).containsEntry("jobLastCycleAt", null).containsEntry("unfinishedOrders", 0);
        scheduled.tick();
        assertThat(svc.status("KR")).containsEntry("jobLastCycleAt", clock.now.toString());

        Config live = RealTradeFixtures.live(store, false, d("10000000"));
        RealTradeFixtures.claimRunsInsert(paper);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-1", null, 200));
        executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 101L, 100L, A, "BUY", 1,
                "DAY", d("70000"), 1), live);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 111L, 110L, C, "BUY", 1,
                "DAY", d("70000"), 1), live);
        assertThat(svc.status("KR")).as("결과 모름(토스 주문 번호 없음)은 세지 않음").containsEntry("unfinishedOrders", 1)
                .containsEntry("unresolvedOrders", 1).containsEntry("jobStartedAt", null);
    }

    @Test
    @DisplayName("RT2-FE-2: 상태 — 응답을 만든 서버 시각(serverTime)과 정기 작업이 시작된 시각(jobStartedAt) — 시작 뒤 주기가 매번 예외로 끝나도 null이 아님")
    void statusServerTimeAndJobStartedAt() {
        RealTradeFixtures.live(store, false, d("10000000"));
        PaperMirrorService broken = mock(PaperMirrorService.class);
        when(broken.book(anyString())).thenThrow(new IllegalStateException("synthetic"));
        RealTradeJob scheduled = new RealTradeJob(store, executor, client, broken, mock(PaperTelegram.class), RealTradeFixtures.MAPPER, clock,
                true, true, 10_000);
        RealTradeService svc = new RealTradeService(store, client, paper, auth, scheduled, executor, clock, true);
        assertThat(svc.status("KR")).as("시작 전").containsEntry("jobStartedAt", null);
        Instant started = clock.now;
        scheduled.start();
        try {
            for (int i = 1; i <= 3; i++) {
                clock.set(started.plusSeconds(10L * i));
                scheduled.tick();
            }
        } finally {
            scheduled.stop();
        }
        verify(broken, times(3)).book(anyString());
        clock.set(started.plusSeconds(200));
        Map<String, Object> out = svc.status("KR");
        assertThat(out).as("주기는 한 번도 끝나지 않음").containsEntry("jobLastCycleAt", null);
        assertThat(out).containsEntry("jobStartedAt", started.toString()).containsEntry("serverTime", started.plusSeconds(200).toString());

        RealTradeJob off = new RealTradeJob(store, executor, client, broken, mock(PaperTelegram.class), RealTradeFixtures.MAPPER, clock, true,
                false, 10_000);
        off.start();
        assertThat(new RealTradeService(store, client, paper, auth, off, executor, clock, true).status("KR"))
                .as("스케줄러가 꺼진 정기 작업은 null").containsEntry("jobStartedAt", null);
    }

    @Test
    @DisplayName("RT2-FE-3: 상태 — 취소를 5번 보내고 포기한 미종료 행 수(cancelGaveUpOrders)와 결과 모름으로 남은 행 수(unresolvedOrders), 건수만")
    void statusCountsGaveUpAndUnresolved() {
        Config live = RealTradeFixtures.live(store, false, d("10000000"));
        RealTradeFixtures.claimRunsInsert(paper);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.ACCEPTED, "T-1", null, 200));
        executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 101L, 100L, A, "BUY", 1,
                "DAY", d("70000"), 1), live);
        when(client.placeOrder(anyString())).thenReturn(new OrderResult(Outcome.UNKNOWN, null, "read-timeout", null));
        executor.send(new RealTradeExecutor.Send(RealTradeFixtures.SESSION, RealTradeStore.PURPOSE_MIRROR, null, 111L, 110L, C, "BUY", 1,
                "DAY", d("70000"), 1), live);
        RealTradeService svc = service(true);
        assertThat(svc.status("KR")).containsEntry("cancelGaveUpOrders", 0).containsEntry("unresolvedOrders", 1);

        when(client.cancelOrder("T-1")).thenReturn(new CancelResult(Outcome.UNKNOWN, null, "collector-timeout"));
        Instant t0 = clock.now;
        for (int i = 0; i <= RealTradeExecutor.MAX_CANCEL_TRIES; i++) {
            clock.set(t0.plusSeconds(31L * i));
            executor.cancelOpen(clock.now, r -> true);
        }
        verify(client, times(RealTradeExecutor.MAX_CANCEL_TRIES)).cancelOrder("T-1");

        Map<String, Object> out = svc.status("KR");
        assertThat(out).containsEntry("cancelGaveUpOrders", 1).containsEntry("unresolvedOrders", 1).containsEntry("unfinishedOrders", 1);
        assertThat(out.toString()).doesNotContain("T-1");
    }

    @Test
    @DisplayName("켜기 창 예상 목록 — 다음 시가 목표로 계산(책에 없는 보유 매도·살 종목), 회전율·경고, 미국 400")
    void preview() {
        Instant now = clock.now;
        LocalDate today = LocalDate.ofInstant(now, RealTradeFixtures.SEOUL);
        when(paper.sessionHours(any())).thenAnswer(inv -> {
            LocalDate date = inv.getArgument(0);
            return Optional.of(new SessionHours(date, true, date.atTime(9, 0).atZone(RealTradeFixtures.SEOUL).toInstant(),
                    date.atTime(15, 30).atZone(RealTradeFixtures.SEOUL).toInstant()));
        });
        when(paper.openTargets(eq(BOOK), any())).thenReturn(Optional.of(new OpenTargets(BOOK, today, Map.of(C, 50.0), Map.of(), 1e7, 0,
                List.of(), List.of())));
        sellableOnlyWhenAsked(now, "9000000");

        Map<String, Object> out = service(true).preview("KR", BOOK);
        assertThat(out).containsEntry("ok", true);
        assertThat((BigDecimal) out.get("equity")).isEqualByComparingTo("10000000");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> orders = (List<Map<String, Object>>) out.get("orders");
        assertThat(orders).extracting(o -> o.get("side") + " " + o.get("symbol") + " " + o.get("quantity"))
                .containsExactly("SELL " + A + " 10", "BUY " + C + " 100");
        assertThat((BigDecimal) out.get("turnoverPct")).isEqualByComparingTo("60.00");
        rejects(() -> service(true).preview("US", BOOK), 400, "not-supported");
        assertThat(job.lastPreflight()).as("예상 목록은 상태의 마지막 사전 조회를 쓰지 않음(RT3-UI-2 — 정기 작업·기준 잡기만)").isNull();
        @SuppressWarnings("unchecked")
        ArgumentCaptor<java.util.Collection<String>> sells = ArgumentCaptor.forClass(java.util.Collection.class);
        verify(client, times(2)).preflight(any(), sells.capture());
        assertThat(sells.getAllValues().get(0)).as("첫 조회 — 매도 가능 수량 없이").isEmpty();
        assertThat(sells.getAllValues().get(1)).as("매도 후보만 다시(정기 작업과 같은 두 단계)").containsExactly(A);
    }

    @Test
    @DisplayName("켜기 창 예상 목록 — 따라 하는 책이 개장 10분 뒤 시각 맞추기면 그 시각까지의 목표(targetsAt)로, 응답에 맞추기 시각(ADR 0033)")
    void previewUsesTimedSync() {
        Instant now = clock.now;
        when(paper.sessionHours(any())).thenAnswer(inv -> {
            LocalDate date = inv.getArgument(0);
            return Optional.of(new SessionHours(date, true, date.atTime(9, 0).atZone(RealTradeFixtures.SEOUL).toInstant(),
                    date.atTime(15, 30).atZone(RealTradeFixtures.SEOUL).toInstant()));
        });
        when(paper.dailySyncAt(eq(BOOK), any())).thenAnswer(inv -> Optional.of(((LocalDate) inv.getArgument(1)).atTime(9, 10)
                .atZone(RealTradeFixtures.SEOUL).toInstant()));
        when(paper.targetsAt(eq(BOOK), any(), any())).thenAnswer(inv -> Optional.of(new OpenTargets(BOOK, inv.getArgument(1),
                Map.of(C, 50.0), Map.of(), 1e7, 0, List.of(), List.of())));
        sellableOnlyWhenAsked(now, "9000000");

        Map<String, Object> out = service(true).preview("KR", BOOK);
        assertThat(out).containsEntry("ok", true);
        assertThat((String) out.get("syncAt")).isNotNull().endsWith("Z");
        verify(paper, never()).openTargets(anyString(), any());
    }

    /** 모든 날이 거래일(09:00~15:30)이고 책의 일일 맞추기 시각이 09:10인 모의 달력 — 예상 목록의 세션 고르기 시험용. */
    private void timedSyncEveryDay() {
        when(paper.sessionHours(any())).thenAnswer(inv -> {
            LocalDate date = inv.getArgument(0);
            return Optional.of(new SessionHours(date, true, date.atTime(9, 0).atZone(RealTradeFixtures.SEOUL).toInstant(),
                    date.atTime(15, 30).atZone(RealTradeFixtures.SEOUL).toInstant()));
        });
        when(paper.dailySyncAt(eq(BOOK), any())).thenAnswer(inv -> Optional.of(((LocalDate) inv.getArgument(1)).atTime(9, 10)
                .atZone(RealTradeFixtures.SEOUL).toInstant()));
        when(paper.targetsAt(eq(BOOK), any(), any())).thenAnswer(inv -> Optional.of(new OpenTargets(BOOK, inv.getArgument(1),
                Map.of(C, 50.0), Map.of(), 1e7, 0, List.of(), List.of())));
        sellableOnlyWhenAsked(RealTradeFixtures.kst("2026-11-06T09:00"), "9000000");
    }

    private Map<String, Object> previewAt(String kstTime) {
        clock.set(RealTradeFixtures.kst("2026-11-06T" + kstTime));
        return service(true).preview("KR", BOOK);
    }

    @Test
    @DisplayName("QA-344: 예상 목록의 세션은 정기 작업과 같은 기준 — 맞추기 창이 열려 있는 동안(09:10~09:13)은 오늘이고 immediate(켜면 바로 주문), 창 전은 오늘, 창 뒤는 다음 거래일")
    void previewSessionMatchesJobDuringTimedSyncWindow() {
        timedSyncEveryDay();

        // 수정 전: 09:11이면 다음 거래일(2026-11-07)의 목록이고 immediate 칸이 없었습니다 — 그 목록을 보고 켜면 정기 작업은 오늘 묶음이 없으므로
        // 오늘 목표로 바로 주문합니다(RealTradeJobDbTest.enabledInsideTimedSyncWindowSendsTodaysBatch).
        Map<String, Object> inside = previewAt("09:11");
        assertThat(inside).containsEntry("ok", true).containsEntry("session", "2026-11-06").containsEntry("immediate", true);
        assertThat(previewAt("09:13")).as("창 끝(양끝 포함)").containsEntry("session", "2026-11-06").containsEntry("immediate", true);

        assertThat(previewAt("09:05")).as("창 전 — 오늘 맞추기를 기다림")
                .containsEntry("session", "2026-11-06").containsEntry("immediate", false);
        assertThat(previewAt("09:13:01")).as("창 뒤 — 오늘 묶음은 만들지 않음")
                .containsEntry("session", "2026-11-07").containsEntry("immediate", false);
    }

    @Test
    @DisplayName("QA-344: 오늘 묶음이 이미 있으면(껐다 다시 켜는 날) 정기 작업은 오늘 묶음을 다시 만들지 않으므로 예상 목록도 다음 거래일")
    void previewSkipsTodayWhenBatchExists() {
        timedSyncEveryDay();
        store.upsertBatch("KR", LocalDate.of(2026, 11, 6), RealTradeStore.BATCH_SYNC, BOOK, null, List.of(), d("10000000"));

        assertThat(previewAt("09:05")).containsEntry("ok", true).containsEntry("session", "2026-11-07").containsEntry("immediate", false);
        assertThat(previewAt("09:11")).containsEntry("session", "2026-11-07").containsEntry("immediate", false);
    }

    @Test
    @DisplayName("RT3-UI-2: 켜짐에 예상 목록(설정 바꾸기·멈춤 해제 창)을 열어도 정기 작업이 남긴 마지막 사전 조회(미체결 매수 되돌림 포함 총액)를 덮지 않음")
    void previewKeepsJobPreflight() {
        RealTradeFixtures.live(store, false, d("10000000"));
        when(paper.sessionHours(any())).thenAnswer(inv -> {
            LocalDate date = inv.getArgument(0);
            return Optional.of(new SessionHours(date, true, date.atTime(9, 0).atZone(RealTradeFixtures.SEOUL).toInstant(),
                    date.atTime(15, 30).atZone(RealTradeFixtures.SEOUL).toInstant()));
        });
        when(paper.openTargets(eq(BOOK), any())).thenAnswer(inv -> Optional.of(new OpenTargets(BOOK, inv.getArgument(1), Map.of(C, 50.0),
                Map.of(), 1e7, 0, List.of(), List.of())));
        sellableOnlyWhenAsked(clock.now, "9000000");
        Preflight fromJob = new Preflight(clock.now.minusSeconds(30), d("8350000"), List.of(new Holding(A, "합성", d("10"), d("100000"))),
                Map.of(A, new Quote(d("100000"), d("130000"), null)), Map.of());
        job.notePreflight(fromJob, RealTradePlanner.account(fromJob, List.of()), d("9350000"), d("10000000"), clock.now.minusSeconds(30));
        RealTradeJob.PreflightView before = job.lastPreflight();

        assertThat(service(true).preview("KR", BOOK)).containsEntry("ok", true);

        assertThat(job.lastPreflight()).isSameAs(before);
        @SuppressWarnings("unchecked")
        Map<String, Object> last = (Map<String, Object>) service(true).status("KR").get("lastPreflight");
        assertThat((BigDecimal) last.get("total")).isEqualByComparingTo("10000000");
    }

    // ------------------------------------------------------------------ 수집기 상태를 읽지 못함(RT3-UI-1)
    @SuppressWarnings("unchecked")
    private static Map<String, Object> serverEnabled(Map<String, Object> status) {
        return (Map<String, Object>) status.get("serverEnabled");
    }

    @Test
    @DisplayName("RT3-UI-1: 상태 — 수집기 상태를 읽지 못하면 serverEnabled.collector는 null(모름)·사유 status-unreadable, 꺼졌다고 답하면 false와 그 사유")
    void statusSeparatesUnreadableFromDisabled() {
        RealTradeFixtures.live(store, false, d("10000000"));
        RealTradeService svc = service(true);

        when(client.status()).thenReturn(Reply.failed("collector-timeout"));
        Map<String, Object> unreadable = svc.status("KR");
        assertThat(serverEnabled(unreadable)).containsEntry("collector", null).containsEntry("backend", true)
                .containsEntry("reason", "status-unreadable");
        assertThat(unreadable).containsEntry("state", "LIVE");

        when(client.status()).thenReturn(Reply.of(new CollectorTradeClient.Status(false, "disabled", null, false, Instant.EPOCH)));
        assertThat(serverEnabled(svc.status("KR"))).containsEntry("collector", false).containsEntry("reason", "disabled");

        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus());
        assertThat(serverEnabled(svc.status("KR"))).containsEntry("collector", true).containsEntry("reason", null);
    }

    @Test
    @DisplayName("RT3-UI-1: 상태 — 수집기가 답했지만 스위치 상태를 모르는 본문(ok:false — 수집기 안의 예외)도 null(모름)·status-unreadable")
    void statusUnknownCollectorBodyIsUnreadable() {
        when(client.status()).thenReturn(Reply.of(new CollectorTradeClient.Status(false, "internal", null, false, null, false)));
        assertThat(serverEnabled(service(true).status("KR"))).containsEntry("collector", null).containsEntry("reason", "status-unreadable");
    }

    // ------------------------------------------------------------------ 기준 총액과 미체결 매수(RT3-BE-4)
    /** 사전 조회 — 보유 A 10주(현재가 100,000)·현금 9,000,000, 시세에 C(상한가 65,000)는 C를 물을 때만. */
    private void preflightWithC(String cash) {
        when(client.preflight(any(), any())).thenAnswer(inv -> {
            java.util.Collection<?> symbols = inv.getArgument(0);
            Map<String, Quote> quotes = symbols.contains(C)
                    ? Map.of(A, new Quote(d("100000"), d("130000"), null), C, new Quote(d("50000"), d("65000"), null))
                    : Map.of(A, new Quote(d("100000"), d("130000"), null));
            return Reply.of(new Preflight(clock.now, d(cash), List.of(new Holding(A, "합성", d("10"), d("100000"))), quotes, Map.of()));
        });
    }

    @Test
    @DisplayName("RT3-BE-4: 켜기 — 그때 토스 미체결 목록의 매수(앱 주문 포함)가 잡은 금액(남은 수량 × 상한가)을 기준 총액·기준 평가액에 되돌림(매도 미체결은 아님)")
    void enableAddsBackOpenBuysToBaseline() {
        when(client.openOrders()).thenReturn(Reply.of(List.of(
                RealTradeFixtures.broker("X-9", C, "BUY", "DAY", "PENDING", "10", "4", clock.now, null),     // 남은 6주 × 65,000 = 390,000
                RealTradeFixtures.broker("X-8", A, "SELL", "DAY", "PENDING", "3", "0", clock.now, null))));  // 매도 — 매수 가능 금액을 잡지 않음
        preflightWithC("9000000");

        service(true).enable(OWNER, enable("실제 매매 켜기", RIGHT, 0));

        Config cfg = store.config("KR").orElseThrow();
        assertThat(cfg.baselineTotal()).as("9,000,000 + 1,000,000 + 390,000").isEqualByComparingTo("10390000");
        assertThat(cfg.baselineEquity()).isEqualByComparingTo("10390000");
        verify(client).preflight(eq(new java.util.TreeSet<>(List.of(C))), any());
        assertThat(job.lastPreflight().total()).as("화면의 지금 총액도 같은 정의").isEqualByComparingTo("10390000");
    }

    @Test
    @DisplayName("RT3-BE-4: 기준 다시 잡기도 앱 미체결 매수를 되돌림, 미체결 목록을 못 읽거나 상한가를 모르면 502 preflight-failed(기준을 쓰지 않음)")
    void rebaselineAddsBackOpenBuysOrRefuses() {
        Config live = RealTradeFixtures.live(store, false, d("10000000"));
        RealTradeService svc = service(true);
        preflightWithC("9000000");

        when(client.openOrders()).thenReturn(Reply.failed("collector-timeout"));
        rejects(() -> svc.update(OWNER, new RealTradeService.UpdateRequest("KR", null, null, true, "설정 바꾸기", RIGHT, live.version())),
                502, "preflight-failed");

        when(client.openOrders()).thenReturn(Reply.of(List.of(RealTradeFixtures.broker("X-9", "051910", "BUY", "DAY", "PENDING", "2", "0",
                clock.now, null))));
        rejects(() -> svc.update(OWNER, new RealTradeService.UpdateRequest("KR", null, null, true, "설정 바꾸기", RIGHT, live.version())),
                502, "preflight-failed");
        assertThat(store.config("KR").orElseThrow().baselineTotal()).isNull();

        when(client.openOrders()).thenReturn(Reply.of(List.of(RealTradeFixtures.broker("X-9", C, "BUY", "DAY", "PENDING", "10", "0",
                clock.now, null))));
        svc.update(OWNER, new RealTradeService.UpdateRequest("KR", null, null, true, "설정 바꾸기", RIGHT, live.version()));
        assertThat(store.config("KR").orElseThrow().baselineTotal()).as("10,000,000 + 10 × 65,000").isEqualByComparingTo("10650000");
    }

    /** 사전 조회 — 보유 A 10주(책에 없음)·현금, 매도 가능 수량은 sell 목록에 A가 있을 때만 돌려줌(수집기와 같음). */
    private void sellableOnlyWhenAsked(Instant now, String cash) {
        when(client.preflight(any(), any())).thenAnswer(inv -> {
            java.util.Collection<?> sell = inv.getArgument(1);
            return Reply.of(new Preflight(now, d(cash), List.of(new Holding(A, "합성", d("10"), d("100000"))),
                    Map.of(A, new Quote(d("100000"), d("130000"), null), C, new Quote(d("50000"), d("65000"), null)),
                    sell.contains(A) ? Map.of(A, d("10")) : Map.of()));
        });
    }

    @Test
    @DisplayName("켜기 창 예상 목록 — 다음 시가가 오늘이면 수집기 하루 한도의 오늘 남은 몫을 적용(넘는 주문은 deferred-daily-cap), 다른 날이면 한도 전부")
    void previewAppliesDailyRoomForToday() {
        when(paper.sessionHours(any())).thenAnswer(inv -> {
            LocalDate date = inv.getArgument(0);
            return Optional.of(new SessionHours(date, true, date.atTime(9, 0).atZone(RealTradeFixtures.SEOUL).toInstant(),
                    date.atTime(15, 30).atZone(RealTradeFixtures.SEOUL).toInstant()));
        });
        when(paper.openTargets(eq(BOOK), any())).thenAnswer(inv -> Optional.of(new OpenTargets(BOOK, inv.getArgument(1), Map.of(C, 50.0),
                Map.of(), 1e7, 0, List.of(), List.of())));
        when(client.status()).thenReturn(RealTradeFixtures.enabledStatus(RealTradeFixtures.limits(99_999_999L, 3, 999_999_999L,
                999_999_999L)));
        when(client.todayOrders()).thenReturn(Reply.of(List.of(
                RealTradeFixtures.broker("X-1", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now),
                RealTradeFixtures.broker("X-2", "000270", "SELL", "DAY", "FILLED", "1", "1", clock.now, clock.now))));

        clock.set(RealTradeFixtures.kst("2026-11-06T08:00"));   // 다음 시가 = 오늘 — 오늘 2건을 써서 1건 남음
        sellableOnlyWhenAsked(clock.now, "9000000");
        Map<String, Object> today = service(true).preview("KR", BOOK);
        assertThat(today).containsEntry("ok", true).containsEntry("session", "2026-11-06");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> orders = (List<Map<String, Object>>) today.get("orders");
        assertThat(orders).extracting(o -> o.get("side") + " " + o.get("symbol")).containsExactly("SELL " + A);
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> skipped = (List<Map<String, Object>>) today.get("skipped");
        assertThat(skipped).extracting(o -> o.get("symbol") + " " + o.get("reason")).containsExactly(C + " deferred-daily-cap");

        clock.set(RealTradeFixtures.kst("2026-11-06T16:00"));   // 다음 시가 = 내일 — 오늘 쓴 몫과 상관없음
        Map<String, Object> tomorrow = service(true).preview("KR", BOOK);
        assertThat(tomorrow).containsEntry("session", "2026-11-07");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> next = (List<Map<String, Object>>) tomorrow.get("orders");
        assertThat(next).hasSize(2);
        verify(client, times(1)).todayOrders();
    }

    @Test
    @DisplayName("상태 — 마지막 사전 조회에 '그날 마감 뒤 값' 표시(afterClose — 모의 한국 달력: 마감 뒤·휴장일은 참, 장중은 거짓, 달력이 모르면 null)")
    void statusMarksAfterClose() {
        service(true).enable(OWNER, enable("실제 매매 켜기", RIGHT, 0));
        LocalDate day = LocalDate.ofInstant(clock.now, com.macrodash.Kst.ZONE);

        when(paper.sessionHours(day)).thenReturn(Optional.of(new PaperMirrorService.SessionHours(day, true, clock.now.minusSeconds(7200),
                clock.now.minusSeconds(60))));
        assertThat(lastPreflight()).containsEntry("afterClose", true);
        when(paper.sessionHours(day)).thenReturn(Optional.of(new PaperMirrorService.SessionHours(day, true, clock.now.minusSeconds(7200),
                clock.now.plusSeconds(60))));
        assertThat(lastPreflight()).containsEntry("afterClose", false);
        when(paper.sessionHours(day)).thenReturn(Optional.of(new PaperMirrorService.SessionHours(day, false, null, null)));
        assertThat(lastPreflight()).containsEntry("afterClose", true);
        when(paper.sessionHours(day)).thenReturn(Optional.empty());
        assertThat(lastPreflight()).containsEntry("afterClose", null);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> lastPreflight() {
        return (Map<String, Object>) service(true).status("KR").get("lastPreflight");
    }
}
