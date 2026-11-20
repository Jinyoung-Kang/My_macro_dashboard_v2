package com.macrodash.feature.security;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.store.AlertStore;
import com.macrodash.store.SecurityAlertStore;
import com.macrodash.store.SecurityStore;
import com.macrodash.store.UserStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 보안 공지 알림(ADR 0046 결정 7·9의 2) — 해당 공지는 한 번만(알림함 + 텔레그램), 텔레그램 실패는 다음 주기에 다시, 버전 목록이 없으면 0건, 한 주기에
 * 여럿이면 텔레그램 한 통에 묶음, 글·로그에 버전 문자열 없음. 저장소·알림함·텔레그램은 메모리 대역이고 버전·공지는 모두 가짜입니다.
 */
class SecurityAlertJobTest {

    private static final Instant NOW = SecurityServiceTest.NOW;
    /** 글·로그에 나오면 안 되는 문자열 — 가짜 설치 버전과 공지 표의 버전 칸. */
    private static final List<String> VERSION_STRINGS = List.of("16.42", "22.20", "16.50", "22.30", "16 이상", "미만");

    private SecurityStore store;
    private SecurityAlertStore records;
    private AlertStore alerts;
    private UserStore users;
    private PaperTelegram telegram;
    private final List<SecurityStore.Notice> notices = new ArrayList<>();
    private final List<SecurityStore.NoticeRow> rows = new ArrayList<>();
    private final Map<Long, SecurityAlertStore.Alert> table = new LinkedHashMap<>();
    /** 알림함 사건: 키 → [제목, 본문, href]. */
    private final Map<String, List<String>> events = new LinkedHashMap<>();
    private final List<long[]> deliveries = new ArrayList<>();
    private final List<String> sent = new ArrayList<>();
    private String failure;
    private boolean configured;

    private final Logger logger = (Logger) LoggerFactory.getLogger(SecurityAlertJob.class);
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    @BeforeEach
    @SuppressWarnings("unchecked")
    void setUp() {
        store = mock(SecurityStore.class);
        when(store.ready()).thenReturn(true);
        when(store.notices()).thenAnswer(call -> List.copyOf(notices));
        when(store.rows()).thenAnswer(call -> List.copyOf(rows));
        when(store.sourceState(anyString())).thenReturn(Optional.empty());
        SecurityServiceTest.fakeInventory(store, Instant.parse("2026-11-20T22:20:00Z"));

        records = mock(SecurityAlertStore.class);
        when(records.ready()).thenReturn(true);
        when(records.all()).thenAnswer(call -> List.copyOf(table.values()));
        when(records.atomically(any())).thenAnswer(call -> ((Supplier<Object>) call.getArgument(0)).get());
        when(records.insert(anyLong(), any(), any())).thenAnswer(call -> {
            long id = call.getArgument(0);
            return table.putIfAbsent(id, new SecurityAlertStore.Alert(id, call.getArgument(1), call.getArgument(2), null)) == null;
        });
        when(records.telegramSent(any(), any())).thenAnswer(call -> {
            Collection<Long> ids = call.getArgument(0);
            ids.forEach(id -> table.computeIfPresent(id, (k, a) -> new SecurityAlertStore.Alert(a.nttId(), a.alertedAt(), a.alertEventId(),
                    call.getArgument(1))));
            return ids.size();
        });

        alerts = mock(AlertStore.class);
        when(alerts.ready()).thenReturn(true);
        when(alerts.insertEvent(eq(SecurityAlertJob.KIND), anyString(), any(), anyString(), anyString(), any())).thenAnswer(call -> {
            String key = call.getArgument(1);
            if (events.containsKey(key)) {
                return Optional.empty();
            }
            assertThat((LocalDate) call.getArgument(2)).as("KST 날짜").isEqualTo(LocalDate.parse("2026-11-21"));
            events.put(key, List.of(call.getArgument(3), call.getArgument(4), ((JsonNode) call.getArgument(5)).path("href").asString()));
            return Optional.of((long) events.size());
        });
        doAnswer(call -> deliveries.add(new long[]{call.getArgument(0), call.getArgument(1)})).when(alerts).deliverInbox(anyLong(), anyLong());

        users = mock(UserStore.class);
        when(users.ready()).thenReturn(true);
        when(users.all()).thenReturn(List.of(user(1, "OWNER"), user(2, "MEMBER"), user(3, "OWNER")));

        telegram = mock(PaperTelegram.class);
        configured = true;
        failure = null;
        when(telegram.configured()).thenAnswer(call -> configured);
        when(telegram.send(eq(PaperTelegram.Channel.OPS), anyString())).thenAnswer(call -> {
            if (failure == null) {
                sent.add(call.getArgument(1));
            }
            return failure;
        });

        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void tearDown() {
        logger.detachAppender(appender);
    }

    private static UserStore.User user(long id, String role) {
        return new UserStore.User(id, "u" + id + "@test.local", "x", role, "PRO", NOW, NOW);
    }

    private SecurityAlertJob job() {
        SecurityService service = new SecurityService(store, ProductAliases.defaults(), Clock.fixed(NOW, ZoneOffset.UTC));
        return new SecurityAlertJob(service, records, alerts, users, telegram, Clock.fixed(NOW, ZoneOffset.UTC));
    }

    /** 해당 — 가짜 PostgreSQL 16.42가 16.x 행의 영향 구간 안(그 행의 CVE 하나 — 15.x 행의 둘은 다른 계열이라 세지 않음). */
    private void postgresAffected() {
        notices.add(SecurityServiceTest.notice(9001, "가짜 PostgreSQL 보안 업데이트 권고", "2026-11-20", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(SecurityServiceTest.row(9001, 0, "CVE-2099-1001", "PostgreSQL", "16 이상 16.50 미만", "16.50 이상"));
        rows.add(SecurityServiceTest.row(9001, 1, "CVE-2099-1002, CVE-2099-1003", "PostgreSQL", "15 이상 15.70 미만", "15.70 이상"));
    }

    /** 해당 — 가짜 Node.js 22.20.0이 영향 구간 안(CVE 번호 없음). */
    private void nodeAffected() {
        notices.add(SecurityServiceTest.notice(9002, "가짜 Node.js 보안 업데이트 권고", "2026-11-19", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(SecurityServiceTest.row(9002, 0, "-", "Node.js", "22 이상 22.30 미만", "22.30 이상"));
    }

    /** 패치됨 — 알리지 않음. */
    private void nodePatched() {
        notices.add(SecurityServiceTest.notice(9003, "가짜 Node.js 보안 업데이트 권고 2", "2026-11-18", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(SecurityServiceTest.row(9003, 0, "CVE-2099-3001", "Node.js", "22 이상 22.10 미만", "22.10 이상"));
    }

    @Test
    @DisplayName("해당 공지는 한 번만 — 알림함 사건 하나(운영자 둘에게 배달)와 텔레그램 한 통, 다시 돌아도(새 작업이어도) 되풀이하지 않는다")
    void onceOnly() {
        postgresAffected();
        nodePatched();

        assertThat(job().run()).isEqualTo(new SecurityAlertJob.Outcome(1, 1));
        assertThat(job().run()).isEqualTo(SecurityAlertJob.Outcome.NONE);

        assertThat(events).containsOnlyKeys("security_notice:9001");
        List<String> event = events.get("security_notice:9001");
        assertThat(event.get(0)).isEqualTo("보안 공지 해당 — PostgreSQL");
        assertThat(event.get(1)).isEqualTo("CVE 1건 · 화면: 더보기 > 보안 공지(/security)");
        assertThat(event.get(2)).isEqualTo("/security?ntt=9001");
        assertThat(deliveries).extracting(d -> d[1]).containsExactly(1L, 3L);
        assertThat(sent).singleElement().satisfies(text -> assertThat(text)
                .contains("*보안 공지 해당*", "*제품* PostgreSQL", "*CVE* 1건", "/security", "*실행*"));
        assertThat(table.get(9001L).telegramSentAt()).isEqualTo(NOW);
        assertThat(table.get(9001L).alertEventId()).isEqualTo(1L);
    }

    @Test
    @DisplayName("텔레그램이 실패하면 알림함만 남기고 다음 주기에 텔레그램을 다시 보낸다(사건은 다시 만들지 않음)")
    void retryAfterTelegramFailure() {
        postgresAffected();

        failure = "HTTP 502";
        assertThat(job().run()).isEqualTo(new SecurityAlertJob.Outcome(1, 0));
        assertThat(table.get(9001L).telegramSentAt()).isNull();

        failure = null;
        assertThat(job().run()).isEqualTo(new SecurityAlertJob.Outcome(0, 1));
        assertThat(job().run()).isEqualTo(SecurityAlertJob.Outcome.NONE);

        assertThat(events).hasSize(1);
        assertThat(deliveries).hasSize(2);
        assertThat(sent).hasSize(1);
    }

    @Test
    @DisplayName("텔레그램 값이 없으면(로컬·QA) 알림함만 넣고, 값이 생기면 그때 보낸다")
    void inboxWithoutTelegram() {
        postgresAffected();
        configured = false;

        assertThat(job().run()).isEqualTo(new SecurityAlertJob.Outcome(1, 0));
        verify(telegram, never()).send(any(PaperTelegram.Channel.class), anyString());

        configured = true;
        assertThat(job().run()).isEqualTo(new SecurityAlertJob.Outcome(0, 1));
    }

    @Test
    @DisplayName("버전 목록이 없으면 0건 — 기록을 읽지도 않고 알림함·텔레그램 없음")
    void noInventoryNoAlerts() {
        postgresAffected();
        when(store.inventory()).thenReturn(Optional.empty());

        assertThat(job().run()).isEqualTo(SecurityAlertJob.Outcome.NONE);
        when(store.inventoryReady()).thenReturn(false);
        assertThat(job().run()).isEqualTo(SecurityAlertJob.Outcome.NONE);

        verify(records, never()).all();
        assertThat(events).isEmpty();
        assertThat(sent).isEmpty();
    }

    @Test
    @DisplayName("한 주기에 새로 해당이 된 공지가 여럿이면 텔레그램 한 통에 묶는다(알림함은 공지마다)")
    void bundle() {
        postgresAffected();
        nodeAffected();
        nodePatched();

        assertThat(job().run()).isEqualTo(new SecurityAlertJob.Outcome(2, 2));

        assertThat(events).containsOnlyKeys("security_notice:9001", "security_notice:9002");
        assertThat(events.get("security_notice:9002").get(1)).as("CVE 번호가 없으면 0건이라 하지 않음").startsWith("CVE 번호 표기 없음");
        assertThat(sent).singleElement().satisfies(text -> assertThat(text)
                .contains("*보안 공지 해당 2건*", "PostgreSQL — CVE 1건", "Node\\.js — CVE 번호 표기 없음", "/security"));
        assertThat(table.values()).allSatisfy(a -> assertThat(a.telegramSentAt()).isEqualTo(NOW));
    }

    @Test
    @DisplayName("텔레그램·알림함 글·로그에 설치 버전과 버전 칸 문자열이 없다(실패 경로 포함)")
    void noVersionStrings() {
        postgresAffected();
        nodeAffected();

        failure = "HTTP 502";
        job().scheduledRun();
        failure = null;
        job().scheduledRun();
        when(records.all()).thenThrow(new IllegalStateException("가짜 실패"));
        job().scheduledRun();

        List<String> texts = new ArrayList<>(sent);
        events.values().forEach(texts::addAll);
        appender.list.forEach(e -> texts.add(e.getFormattedMessage()));
        assertThat(sent).hasSize(1);
        assertThat(appender.list).extracting(ILoggingEvent::getFormattedMessage)
                .anySatisfy(m -> assertThat(m).contains("텔레그램을 보내지 못함(2건)"))
                .anySatisfy(m -> assertThat(m).contains("알림함 2건"))
                .anySatisfy(m -> assertThat(m).contains("작업 실패", "IllegalStateException"));
        for (String text : texts) {
            for (String version : VERSION_STRINGS) {
                assertThat(text).as("글: " + text).doesNotContain(version);
            }
        }
    }
}
