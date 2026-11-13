package com.macrodash.feature.info;

import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.store.InfoStore;
import com.macrodash.store.InfoStore.SourceState;
import com.macrodash.store.SourceAlertStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 수집 출처 끊김 알림(ADR 0035 결정 7) — 사건 하나에 한 통, 풀리면 한 통, 보내지 못한 것은 다음 주기에 다시, 배포로 다시 떠도(기록은 표) 되풀이하지
 * 않는다. 기록 표는 메모리 대역으로 흉내 냅니다.
 */
class SourceAlertJobTest {

    private static final Instant NOW = Instant.parse("2026-11-11T09:00:00Z");

    private InfoStore info;
    private SourceAlertStore alerts;
    private PaperTelegram telegram;
    private final List<SourceState> states = new ArrayList<>();
    private final Map<String, SourceAlertStore.Open> table = new LinkedHashMap<>();
    private final List<String> sent = new ArrayList<>();
    private String failure;

    @BeforeEach
    void setUp() {
        info = mock(InfoStore.class);
        alerts = mock(SourceAlertStore.class);
        telegram = mock(PaperTelegram.class);
        when(info.ready()).thenReturn(true);
        when(alerts.ready()).thenReturn(true);
        when(info.states()).thenAnswer(call -> List.copyOf(states));
        when(alerts.open()).thenAnswer(call -> List.copyOf(table.values()));
        doAnswer(call -> {
            String key = call.getArgument(0);
            table.putIfAbsent(key, new SourceAlertStore.Open(key, call.getArgument(1), call.getArgument(2), call.getArgument(3),
                    call.getArgument(4), null));
            return null;
        }).when(alerts).open(anyString(), anyString(), anyString(), any(), any());
        doAnswer(call -> {
            SourceAlertStore.Open old = table.get((String) call.getArgument(0));
            table.put(old.key(), new SourceAlertStore.Open(old.key(), old.task(), old.kind(), old.reason(), old.openedAt(),
                    call.getArgument(1)));
            return null;
        }).when(alerts).notified(anyString(), any());
        doAnswer(call -> table.remove((String) call.getArgument(0))).when(alerts).recovered(anyString(), any());
        when(telegram.configured()).thenReturn(true);
        failure = null;
        when(telegram.send(anyString())).thenAnswer(call -> {
            if (failure == null) {
                sent.add(call.getArgument(0));
            }
            return failure;
        });
    }

    private SourceAlertJob job() {
        return new SourceAlertJob(info, alerts, telegram, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private void state(String task, String status, int streak, String reason) {
        states.removeIf(s -> s.task().equals(task));
        states.add(new SourceState(task, status, streak, reason, NOW.minus(Duration.ofHours(1)), NOW.minus(Duration.ofMinutes(5)),
                1440, NOW.minus(Duration.ofDays(2))));
    }

    @Test
    @DisplayName("끊기면 한 통, 같은 사건은 다시 보내지 않고, 다시 떠도(새 작업) 표의 기록으로 되풀이하지 않는다")
    void onceAcrossRestarts() {
        state("info_blog_wolfstreet", "blocked", 1, "wolfstreet.com HTTP 403(계층 impersonate) · 2026-11-11 19:40:00 KST까지 이 출처 호출을 멈춤");

        assertThat(job().run()).isEqualTo(1);
        assertThat(job().run()).isZero();
        assertThat(sent).hasSize(1);
        assertThat(sent.get(0)).contains("수집 끊김", "Wolf Street", "잠시 멈춤", "개인 IP로 돌리지 않음").doesNotContain("https://");
        // 2026-11-13 사용자 요청: 운영 알림에 할 일 — 잠시 멈춤은 스스로 풀리므로 '할 일 없음'과 언제 맡길지.
        assertThat(sent.get(0)).contains("*실행*", "할 일 없음", "Wolf Street 수집 차단 확인해 줘");
    }

    @Test
    @DisplayName("풀리면 회복 한 통, 다시 끊기면 새 사건으로 한 통")
    void recoveryAndReopen() {
        state("info_naver_flows", "format", 2, "trend.KOSPI: 네이버 매매동향 응답 모양이 다름(content 없음)");
        job().run();
        state("info_naver_flows", "ok", 1, null);

        assertThat(job().run()).isEqualTo(1);
        assertThat(sent.get(1)).contains("수집 회복", "네이버", "형식 바뀜", "*실행*", "할 일 없음");

        state("info_naver_flows", "format", 2, "다시 다름");
        assertThat(job().run()).isEqualTo(1);
        assertThat(sent).hasSize(3);
    }

    @Test
    @DisplayName("보내지 못하면 다음 주기에 다시 보내고, 알리지 못한 채 풀린 사건은 회복도 알리지 않는다")
    void retryAndQuietRecovery() {
        state("info_waedge_brief", "failed", 3, "news.waedge.ai HTTP 503");
        failure = "HTTP 502";
        assertThat(job().run()).isZero();
        failure = null;
        assertThat(job().run()).isEqualTo(1);

        state("info_blog_klement", "blocked", 1, "사람 확인 요구(계층 browser)");
        failure = "HTTP 502";
        job().run();
        state("info_blog_klement", "ok", 1, null);
        failure = null;
        job().run();
        assertThat(sent).hasSize(1).allSatisfy(text -> assertThat(text).doesNotContain("Klement"));
    }

    @Test
    @DisplayName("포기로 닫힌 출처는 다시 시도하지 않는다고 적는다")
    void givenUpText() {
        state("econ_calendar_tradingview", "blocked", 1,
                "economic-calendar.tradingview.com HTTP 403(계층 browser) · 연속 5회 거부로 포기(운영자가 풀 때까지 다시 시도하지 않음)");

        job().run();

        assertThat(sent.get(0)).contains("TradingView 경제 캘린더", "포기했습니다", "*실행*", "TradingView 경제 캘린더 수집 포기 풀어 줘")
                .doesNotContain("할 일 없음");
    }

    // ------------------------------------------------------------------ QA-404
    // 열린 기록의 키는 '태스크|종류'입니다. 종류만 바뀌어도 옛 키가 사라졌다고 '수집 회복'이 갔고(마지막 글이 회복), 사건 문턱 아래의
    // 실패(1~2회)로 내려가도 회복이 갔으며, 회복 글은 기록한 뒤에 보내 한 번 실패하면 다시 보내지 않았습니다.

    @Test
    @DisplayName("QA-404: 끊김의 종류만 바뀌면(받지 못함 → 차단됨) 새 끊김만 알리고 '수집 회복'은 보내지 않는다")
    void kindChangeIsNotRecovery() {
        state("info_waedge_brief", "failed", 3, "news.waedge.ai HTTP 503");
        assertThat(job().run()).isEqualTo(1);

        state("info_waedge_brief", "blocked", 1, "news.waedge.ai HTTP 403(계층 impersonate)");
        assertThat(job().run()).isEqualTo(1);

        assertThat(sent).hasSize(2).noneSatisfy(text -> assertThat(text).contains("수집 회복"));
        assertThat(sent.get(1)).contains("수집 끊김", "차단됨");
        assertThat(table.keySet()).containsExactly("info_waedge_brief|blocked");
    }

    @Test
    @DisplayName("QA-404: 차단이 풀렸어도 아직 실패 중이면(사건 문턱 아래) 회복을 알리지 않고, 정상이 되면 그때 한 통")
    void noRecoveryWhileStillFailing() {
        state("info_blog_wolfstreet", "blocked", 1, "wolfstreet.com HTTP 403");
        assertThat(job().run()).isEqualTo(1);

        state("info_blog_wolfstreet", "failed", 1, "wolfstreet.com HTTP 502");
        assertThat(job().run()).isZero();
        assertThat(sent).hasSize(1);

        state("info_blog_wolfstreet", "ok", 1, null);
        assertThat(job().run()).isEqualTo(1);
        assertThat(sent.get(1)).contains("수집 회복", "Wolf Street", "차단됨");
        assertThat(table).isEmpty();
    }

    @Test
    @DisplayName("QA-404: 회복 알림을 보내지 못하면 다음 주기에 다시 보낸다(보낸 뒤에 기록)")
    void recoveryIsRetriedAfterSendFailure() {
        state("info_naver_flows", "format", 2, "응답 모양이 다름");
        job().run();
        state("info_naver_flows", "ok", 1, null);

        failure = "HTTP 502";
        assertThat(job().run()).isZero();
        failure = null;
        assertThat(job().run()).isEqualTo(1);
        assertThat(job().run()).isZero();

        assertThat(sent).hasSize(2);
        assertThat(sent.get(1)).contains("수집 회복", "네이버");
    }

    @Test
    @DisplayName("운영 알림의 실행 줄은 끊김 종류마다 할 일을 적는다(2026-11-13 사용자 요청)")
    void actionPerKind() {
        assertThat(SourceAlertJob.action(incident("format", "응답 모양이 다름")))
                .contains("Claude Code에", "네이버 수집 형식 바뀜 고쳐 줘").doesNotContain("할 일 없음");
        assertThat(SourceAlertJob.action(incident("failed", "HTTP 503")))
                .startsWith("할 일 없음").contains("네이버 수집 실패 확인해 줘");
        assertThat(SourceAlertJob.action(incident("blocked", "HTTP 403 · 연속 5회 거부로 포기")))
                .contains("네이버 수집 포기 풀어 줘", "닫힘·포기를 푸는 방법").doesNotContain("할 일 없음");
        assertThat(SourceAlertJob.action(incident("blocked", "HTTP 403")))
                .startsWith("할 일 없음").contains("네이버 수집 차단 확인해 줘");
        assertThat(SourceAlertJob.action(incident("stale", "마지막 성공 뒤 30시간")))
                .contains("출처 상태", "네이버 수집 확인해 줘");
    }

    private static SourceIncidents.Incident incident(String kind, String reason) {
        return new SourceIncidents.Incident("info_naver_flows|" + kind, "info_naver_flows", "네이버", kind,
                SourceIncidents.kindLabel(kind), reason, Instant.parse("2026-11-13T07:00:00Z"), "e");
    }

    @Test
    @DisplayName("QA-404: 끊김 글은 지금 메뉴 자리(정보 수집 > 출처 상태)를 알린다")
    void downTextPointsToTheCurrentMenu() {
        state("info_blog_wolfstreet", "blocked", 1, "wolfstreet.com HTTP 403");
        job().run();

        // 텔레그램 MarkdownV2 서식이라 '>'는 앞에 역슬래시가 붙어 나갑니다.
        assertThat(sent.get(0)).contains("화면: 정보 수집 \\> 출처 상태").doesNotContain("모의매매");
    }

    @Test
    @DisplayName("텔레그램 값이 없으면(로컬) 표를 읽지도 않는다")
    void notConfigured() {
        when(telegram.configured()).thenReturn(false);
        state("info_blog_wolfstreet", "blocked", 1, "x");

        job().scheduledRun();

        assertThat(sent).isEmpty();
        assertThat(table).isEmpty();
    }

    @Test
    @DisplayName("포기 표지는 수집기 글과 같다")
    void giveUpMarkMatchesCollector() throws IOException {
        Path state = Path.of("../collector/app/fetch/state.py");
        assumeTrue(Files.exists(state), "collector/app/fetch/state.py를 찾을 수 없습니다");
        assertThat(Files.readString(state)).contains("회 거부로 " + SourceAlertJob.GIVE_UP_MARK);
    }
}
