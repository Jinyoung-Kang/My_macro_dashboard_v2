package com.macrodash.feature.paper;

import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.SettingsRow;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static com.macrodash.feature.paper.PaperFixtures.bar;
import static com.macrodash.feature.paper.PaperFixtures.quotes;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 계좌1 장중 확인 작업({@link PaperClaude1CheckpointJob} — 사용자 결정 2026-11-02): 켰을 때만, 정한 시각(기본 12:00 ET) 뒤 그날 시간별 관측치가 오면
 * 기준 거래일 d(아침 결정과 같은 d)로 한 번만 부르고, 시각 전·마감 30분 전 뒤·아침 결정 없음·이미 확인함·관측치가 그 시각 전이면 부르지 않음.
 */
class PaperClaude1CheckpointJobTest {

    /** 화요일 세션 E = 2026-11-03, 기준 거래일 d = 11-02(월). 12:00 ET = 17:00Z(서머타임 끝 뒤). */
    private static final LocalDate D = LocalDate.of(2026, 11, 2);
    private static final LocalDate E = LocalDate.of(2026, 11, 3);
    private static final Instant NOON = Instant.parse("2026-11-03T17:00:00Z");

    private FakePaperStore store;
    private PaperMarketData marketData;
    private ClaudeBookService claude;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        marketData = mock(PaperMarketData.class);
        claude = mock(ClaudeBookService.class);
        store.insertBookIfAbsent(new Book(PaperBooks.CLAUDE, PaperBooks.KIND_CLAUDE, "Claude 계좌1", 100_000,
                LocalDate.of(2026, 10, 23), PaperBooks.ACTIVE, null));
        store.insertDecisionIfAbsent(decision(D, RuleBookService.SCHEDULED));
        when(claude.decideCheckpoint(any(), any())).thenAnswer(invocation -> decision(D, RuleBookService.CHECKPOINT));
        settings(true, "12:00");
    }

    private static Decision decision(LocalDate asOf, String kind) {
        return new Decision(0, PaperBooks.CLAUDE, asOf, kind, null, "NO_TRADE", "claude-test", 6, 12, null, 60.0, null, null,
                null, MAPPER.createObjectNode(), null, null, null, false, null, 0);
    }

    private void settings(boolean on, String at) {
        ObjectNode body = MAPPER.createObjectNode();
        body.putObject("claude").put("checkpoint", on).put("checkpointAtEt", at);
        store.settings = new SettingsRow(12, body, NOON);
    }

    private void observed(Instant collectedAt, LocalDate barDate) {
        when(marketData.quotes()).thenReturn(Optional.of(quotes(collectedAt, bar("SPY", barDate, 600.0))));
    }

    private PaperClaude1CheckpointJob job(Instant now) {
        return new PaperClaude1CheckpointJob(store, PaperFixtures.quietReader(), marketData, claude, PaperFixtures.config(),
                MAPPER, Clock.fixed(now, ZoneOffset.UTC));
    }

    @Test
    @DisplayName("정한 시각 뒤 그날 관측치가 오면 d로 한 번 부르고 작업 기록, 이미 확인했으면 다시 부르지 않음")
    void callsOncePerSession() {
        observed(NOON.plusSeconds(35 * 60), E);

        PaperClaude1CheckpointJob.Outcome first = job(NOON.plusSeconds(40 * 60)).run();

        assertThat(first.reason()).isNull();
        verify(claude, times(1)).decideCheckpoint(UsPaperMarket.INSTANCE, D);
        assertThat(store.jobRuns).anySatisfy(r -> assertThat(r.job()).isEqualTo(PaperClaude1CheckpointJob.JOB));

        store.insertDecisionIfAbsent(decision(D, RuleBookService.CHECKPOINT));
        assertThat(job(NOON.plusSeconds(45 * 60)).run().reason()).isEqualTo("이미 확인함");
        verify(claude, times(1)).decideCheckpoint(any(), any());
    }

    @Test
    @DisplayName("꺼짐·시각 전·마감 30분 전 뒤·관측치가 그 시각 전이거나 전날 판·아침 결정 없음이면 부르지 않음")
    void waitsOrSkips() {
        observed(NOON.minusSeconds(25 * 60), E);
        assertThat(job(NOON.plusSeconds(60)).run().reason()).contains("기다림");
        observed(NOON.plusSeconds(35 * 60), D);
        assertThat(job(NOON.plusSeconds(40 * 60)).run().reason()).contains("기다림");
        observed(NOON.plusSeconds(35 * 60), E);
        assertThat(job(NOON.minusSeconds(60)).run().reason()).startsWith("창 밖");
        assertThat(job(Instant.parse("2026-11-03T20:31:00Z")).run().reason()).as("마감(21:00Z) 30분 전 뒤").startsWith("창 밖");
        assertThat(job(Instant.parse("2026-11-01T17:30:00Z")).run().reason()).isEqualTo("거래일 아님");

        settings(false, "12:00");
        assertThat(job(NOON.plusSeconds(40 * 60)).run().reason()).startsWith("꺼짐");

        settings(true, "13:30");
        assertThat(job(NOON.plusSeconds(40 * 60)).run().reason()).as("13:30 ET 전").startsWith("창 밖");

        settings(true, "12:00");
        store.decisions.clear();
        assertThat(job(NOON.plusSeconds(40 * 60)).run().reason()).contains("아침 결정 없음");
        verify(claude, never()).decideCheckpoint(any(), any());
    }

    @Test
    @DisplayName("자유 시점 판(ADR 0027 결정 3)이 켜져 있으면 부르지 않음 — 이 장중 확인은 끈 판의 전체 결정이라 켠 판의 시각 지정 대기 주문을 모두 대신함. "
            + "스위치를 끄면 다시 부름")
    void doesNotCallWhileFreeTimingIsOn() {
        observed(NOON.plusSeconds(35 * 60), E);
        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", true);

        PaperClaude1CheckpointJob.Outcome skipped = job(NOON.plusSeconds(40 * 60)).run();

        assertThat(skipped.reason()).startsWith("자유 시점 판이 켜져 있어 부르지 않음").contains("claude.freeTiming");
        verify(claude, never()).decideCheckpoint(any(), any());
        assertThat(store.jobRuns).as("부르지 않은 주기는 기록하지 않음").isEmpty();

        ((ObjectNode) store.settings.body().get("claude")).put("freeTiming", false);
        assertThat(job(NOON.plusSeconds(41 * 60)).run().reason()).isNull();
        verify(claude, times(1)).decideCheckpoint(UsPaperMarket.INSTANCE, D);
    }

    @Test
    @DisplayName("QA-191: 부른 뒤 기록 실패(CalledNotRecorded)면 ERROR 작업 기록을 남기고 그 세션에 다시 부르지 않음 — 다음 세션은 다시 봄")
    void calledNotRecordedIsNotCalledAgain() {
        observed(NOON.plusSeconds(35 * 60), E);
        when(claude.decideCheckpoint(any(), any())).thenThrow(new ClaudeBookService.CalledNotRecorded(
                new IllegalStateException("DB 연결 끊김")));
        PaperClaude1CheckpointJob job = job(NOON.plusSeconds(40 * 60));   // 작업 메모리는 같은 작업 객체

        assertThatThrownBy(job::run).isInstanceOf(ClaudeBookService.CalledNotRecorded.class);
        assertThat(store.jobRuns).singleElement().satisfies(r -> {
            assertThat(r.job()).isEqualTo(PaperClaude1CheckpointJob.JOB);
            assertThat(r.outcome()).isEqualTo(PaperDecisionJob.ERROR);
            assertThat(r.detail().path("calledNotRecorded").asBoolean()).isTrue();
            assertThat(r.detail().path("asOfTradingDate").asString()).isEqualTo(D.toString());
        });

        assertThat(job.run().reason()).isEqualTo(PaperClaude1CheckpointJob.CALLED_NOT_RECORDED);
        verify(claude, times(1)).decideCheckpoint(any(), any());
    }

    @Test
    @DisplayName("QA-191: 부르기 전 오류는 다음 주기에 다시 보되 같은 세션에 3번이면 더 시도하지 않음(결정 작업과 같은 수), 주기마다 ERROR 기록")
    void errorsBeforeTheCallStopAfterThree() {
        observed(NOON.plusSeconds(35 * 60), E);
        when(claude.decideCheckpoint(any(), any())).thenThrow(new IllegalStateException("패킷 조립 실패"));
        PaperClaude1CheckpointJob job = job(NOON.plusSeconds(40 * 60));

        for (int i = 0; i < PaperDecisionJob.MAX_ATTEMPTS; i++) {
            assertThatThrownBy(job::run).isInstanceOf(IllegalStateException.class);
        }
        assertThat(job.run().reason()).startsWith("오류 3번");

        verify(claude, times(PaperDecisionJob.MAX_ATTEMPTS)).decideCheckpoint(any(), any());
        assertThat(store.jobRuns).hasSize(PaperDecisionJob.MAX_ATTEMPTS).allSatisfy(r -> {
            assertThat(r.outcome()).isEqualTo(PaperDecisionJob.ERROR);
            assertThat(r.detail().path("calledNotRecorded").asBoolean()).isFalse();
        });
        assertThat(store.jobRuns).extracting(r -> r.detail().path("attempt").asInt()).containsExactlyInAnyOrder(1, 2, 3);
    }

    @Test
    @DisplayName("시각 설정이 형·범위 밖이면 기본 12:00(기본값으로 읽은 키에 남김), 키가 없으면 꺼짐")
    void settingsFallbacks() {
        ObjectNode body = MAPPER.createObjectNode();
        body.putObject("claude").put("checkpoint", true).put("checkpointAtEt", "16:30");
        Claude1Checkpoint read = Claude1Checkpoint.from(body);
        assertThat(read.enabled()).isTrue();
        assertThat(read.atEt()).isEqualTo(Claude1Checkpoint.DEFAULT_AT);
        assertThat(read.fallbacks()).containsExactly(Claude1Checkpoint.AT_ET);
        assertThat(Claude1Checkpoint.from(MAPPER.createObjectNode()).enabled()).isFalse();
        assertThat(Claude1Checkpoint.from(null)).isEqualTo(Claude1Checkpoint.DEFAULTS);
    }
}
