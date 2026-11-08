package com.macrodash.feature.status;

import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.store.FetchStateStore;
import com.macrodash.store.FetchStateStore.Closure;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** 차단 통과 수집 계층의 닫힘 알림(ADR 0026 결정 4·5) — 사람 확인·포기만, 닫힘 하나에 한 통, 다시 떠도 되풀이하지 않는다. */
class FetchClosureNotifyJobTest {

    private static final Instant NOW = Instant.parse("2026-11-05T03:00:00Z");
    private static final Closure HUMAN = new Closure("www.calendar.example", "사람 확인 요구(계층 browser)", NOW.plusSeconds(50_000), false);
    private static final Closure GIVEN_UP = new Closure("data.flows.example", "HTTP 403(계층 impersonate)", null, true);
    private static final Closure BACKOFF = new Closure("api.other.example", "HTTP 403(계층 impersonate)", NOW.plusSeconds(1800), false);

    private FetchStateStore store;
    private PaperTelegram telegram;
    private List<String> sent;
    private List<Closure> closed;
    /** 보내기가 돌려줄 실패 사유 — null이면 성공(보낸 글을 sent에 기록). */
    private String failure;
    private FetchClosureNotifyJob job;

    @BeforeEach
    void setUp() {
        store = mock(FetchStateStore.class);
        telegram = mock(PaperTelegram.class);
        sent = new ArrayList<>();
        closed = new ArrayList<>();
        when(store.ready()).thenReturn(true);
        when(store.closed(any())).thenAnswer(call -> List.copyOf(closed));
        when(telegram.configured()).thenReturn(true);
        failure = null;
        when(telegram.send(anyString())).thenAnswer(call -> {
            if (failure == null) {
                sent.add(call.getArgument(0));
            }
            return failure;
        });
        job = new FetchClosureNotifyJob(store, telegram, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @Test
    @DisplayName("처음 뜰 때 닫혀 있던 것은 알리지 않고, 그 뒤에 새로 닫힌 사람 확인만 한 통")
    void notifiesOnlyClosuresSeenAfterStart() {
        closed.add(GIVEN_UP);
        assertThat(job.run()).as("다시 뜰 때마다 같은 알림을 되풀이하지 않는다").isZero();

        closed.add(HUMAN);
        assertThat(job.run()).isEqualTo(1);
        assertThat(job.run()).as("닫힘 하나에 한 통").isZero();

        assertThat(sent).hasSize(1);
        assertThat(PaperTelegram.plain(sent.get(0))).contains("수집 출처 닫힘", "www.calendar.example", "사람 확인 요구(계층 browser)",
                "2026-11-06 01:53 KST", "직전 저장본은 그대로");
    }

    @Test
    @DisplayName("보통의 거부 뒤 물러남은 알리지 않는다")
    void ordinaryBackoffIsQuiet() {
        job.run();
        closed.add(BACKOFF);

        assertThat(job.run()).isZero();
        verify(telegram, never()).send(anyString());
    }

    @Test
    @DisplayName("포기로 넘어가면 한 통 — 풀리는 시각 대신 '운영자가 풀 때까지'")
    void givingUpIsNotified() {
        job.run();
        closed.add(GIVEN_UP);

        assertThat(job.run()).isEqualTo(1);
        assertThat(PaperTelegram.plain(sent.get(0))).contains("data.flows.example", "포기 — 운영자가 풀 때까지 다시 시도하지 않습니다");
        assertThat(PaperTelegram.plain(sent.get(0))).doesNotContain("다시 시도 ");
    }

    @Test
    @DisplayName("보내지 못하면 다음 주기에 그 통을 다시 보낸다")
    void failedSendIsRetried() {
        job.run();
        closed.add(HUMAN);
        failure = "HTTP 502";

        assertThat(job.run()).isZero();
        assertThat(sent).isEmpty();

        failure = null;
        assertThat(job.run()).isEqualTo(1);
        assertThat(sent).hasSize(1);
    }

    @Test
    @DisplayName("풀렸다가 다시 닫히면 새 닫힘으로 알린다")
    void reclosingIsANewClosure() {
        job.run();
        closed.add(HUMAN);
        job.run();
        closed.clear();
        job.run();

        closed.add(new Closure(HUMAN.host(), HUMAN.reason(), NOW.plusSeconds(90_000), false));
        assertThat(job.run()).isEqualTo(1);
        assertThat(sent).hasSize(2);
    }

    @Test
    @DisplayName("표가 아직 없으면(수집기가 V21을 적용하기 전) 읽지 않는다")
    void waitsForTheSchema() {
        when(store.ready()).thenReturn(false);

        assertThat(job.run()).isZero();
        verify(store, never()).closed(any());
    }

    @Test
    @DisplayName("텔레그램 값이 없으면 정기 실행이 아무것도 하지 않는다")
    void scheduledRunNeedsTelegram() {
        when(telegram.configured()).thenReturn(false);

        job.scheduledRun();

        verify(store, never()).ready();
    }

    @Test
    @DisplayName("알림 글은 서식 글자를 이스케이프해 글자 그대로 보이게 한다")
    void textEscapesMarkup() {
        String text = FetchClosureNotifyJob.text(new Closure("a<b>.example", "차단 & <script>", NOW, false));

        assertThat(text).contains("a<b\\>\\.example", "차단 & <script\\>");
        assertThat(PaperTelegram.plain(text)).contains("a<b>.example", "차단 & <script>");
    }

    @Test
    @DisplayName("사람 확인 표지는 수집기가 닫을 때 적는 글과 같다")
    void humanCheckMarkMatchesTheCollector() throws IOException {
        Path ladder = Path.of("../collector/app/fetch/ladder.py");
        assumeTrue(Files.exists(ladder), "collector/app/fetch/ladder.py를 찾을 수 없습니다");

        assertThat(Files.readString(ladder)).contains("\"" + FetchClosureNotifyJob.HUMAN_CHECK_MARK + "\"");
    }
}
