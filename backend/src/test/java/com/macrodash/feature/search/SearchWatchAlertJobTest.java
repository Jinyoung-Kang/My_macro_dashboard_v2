package com.macrodash.feature.search;

import com.macrodash.store.AlertStore;
import com.macrodash.store.SearchWatchStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.dao.DataIntegrityViolationException;
import tools.jackson.databind.JsonNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 관심 대상 새 글 알림(계약 §9-5) — 정해 둔 시계로 사건 키·제목·본문·주소·알림함 배달·알린 시각을 확인합니다. 저장소는 흉내(후보는 {@code SearchWatchStore}가
 * 새 글 규칙으로 고름 — 그 규칙은 {@code SearchWatchStoreDbTest}·{@code SearchWatchAlertJobDbTest}가 실제 DB로 봄). 대상 이름·제목은 합성입니다.
 */
class SearchWatchAlertJobTest {

    /** KST로는 다음 날(11-16 01:00) — 사건 날짜가 KST인지 봅니다. */
    private static final Instant NOW = Instant.parse("2026-11-15T16:00:00Z");

    private SearchWatchStore watches;
    private AlertStore alerts;
    private SearchWatchAlertJob job;

    @BeforeEach
    void setUp() {
        watches = mock(SearchWatchStore.class);
        alerts = mock(AlertStore.class);
        when(watches.notifyReady()).thenReturn(true);
        when(alerts.ready()).thenReturn(true);
        when(watches.atomically(any())).thenAnswer(call -> ((Supplier<?>) call.getArgument(0)).get());
        job = new SearchWatchAlertJob(watches, alerts, Clock.fixed(NOW.plusMillis(250), ZoneOffset.UTC));
    }

    /** 후보를 읽을 때의 알린 시각(켠 시각) — 알린 시각은 이 값과 같을 때만 고칩니다. */
    private static final Instant READ_AT = NOW.minus(Duration.ofHours(2));

    private static SearchWatchStore.NotifyCandidate candidate(long id, long userId, String key, String name, int fresh, String... titles) {
        return new SearchWatchStore.NotifyCandidate(id, userId, key, name, fresh, List.of(titles), READ_AT);
    }

    @Test
    @DisplayName("새 글이 있는 줄마다 사건 하나(SEARCH_WATCH, 키 = 줄 번호 + 실행 시각, KST 날짜) + 그 사용자 알림함 하나(규칙 없음), 알린 시각을 먼저 고침")
    void createsOneEventAndOneInboxRow() {
        when(watches.notifyCandidates(any(), any(), any())).thenReturn(List.of(
                candidate(12, 7, "us:NVDA", "합성 대상", 4, "합성 제목 C", "합성 제목 A", "합성 제목 B")));
        when(watches.markNotified(12, READ_AT, NOW)).thenReturn(true);
        when(alerts.insertEvent(anyString(), anyString(), any(), anyString(), anyString(), any())).thenReturn(Optional.of(501L));
        when(alerts.deliverInbox(501L, 7L)).thenReturn(true);

        assertThat(job.run()).isEqualTo(1);

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<String>> hidden = ArgumentCaptor.forClass(List.class);
        verify(watches).notifyCandidates(hidden.capture(), eq(NOW.minus(Duration.ofHours(6))), eq(NOW));
        assertThat(hidden.getValue()).as("회원에게서 뺄 운영자 전용 출처").containsExactlyInAnyOrderElementsOf(SearchService.OWNER_ONLY_SOURCES);
        ArgumentCaptor<JsonNode> payload = ArgumentCaptor.forClass(JsonNode.class);
        verify(alerts).insertEvent(eq("SEARCH_WATCH"), eq("search_watch:12:2026-11-15T16:00:00Z"), eq(LocalDate.parse("2026-11-16")),
                eq("관심 대상 '합성 대상' 새 글 4건"), eq("합성 제목 C\n합성 제목 A\n합성 제목 B"), payload.capture());
        assertThat(payload.getValue().path("href").asString()).isEqualTo("/search?e=us:NVDA&tab=timeline");
        assertThat(payload.getValue().size()).as("payload는 href 하나").isEqualTo(1);
        verify(alerts).deliverInbox(501L, 7L);
        verify(watches).markNotified(12, READ_AT, NOW);
        verify(alerts).purgeUndeliveredEvents("SEARCH_WATCH");
    }

    @Test
    @DisplayName("주제 키의 주소는 한글·공백을 인코딩(콜론은 그대로), 긴 제목은 200자로 자름")
    void hrefAndBody() {
        assertThat(SearchWatchAlertJob.href("topic:AI 반도체")).isEqualTo("/search?e=topic:AI%20%EB%B0%98%EB%8F%84%EC%B2%B4&tab=timeline");
        assertThat(SearchWatchAlertJob.href("topic:a%3Ab&c")).isEqualTo("/search?e=topic:a%253Ab%26c&tab=timeline");
        assertThat(SearchWatchAlertJob.href("cik:0001067983")).isEqualTo("/search?e=cik:0001067983&tab=timeline");
        String longTitle = "가".repeat(250);
        assertThat(SearchWatchAlertJob.body(List.of(" " + longTitle + " ", "둘", "셋", "넷"))).isEqualTo("가".repeat(200) + "\n둘\n셋");
        assertThat(SearchWatchAlertJob.body(List.of())).isEmpty();
    }

    @Test
    @DisplayName("그 사이 알림을 끄거나 지운 줄(알린 시각을 고치지 못함)은 사건을 만들지 않음")
    void skipsRowTurnedOffMeanwhile() {
        when(watches.notifyCandidates(any(), any(), any())).thenReturn(List.of(candidate(12, 7, "us:NVDA", "합성 대상", 1, "합성 제목")));
        when(watches.markNotified(12, READ_AT, NOW)).thenReturn(false);

        assertThat(job.run()).isZero();
        verify(alerts, never()).insertEvent(anyString(), anyString(), any(), anyString(), anyString(), any());
        verify(alerts, never()).deliverInbox(anyLong(), anyLong());
    }

    @Test
    @DisplayName("한 줄의 실패는 그 줄만 — 다른 줄은 계속, DB에 닿지 못하면 그 주기를 멈춤(정기 실행은 예외를 삼킴)")
    void failuresAreIsolated() {
        when(watches.notifyCandidates(any(), any(), any())).thenReturn(List.of(
                candidate(12, 7, "us:NVDA", "하나", 1, "제목 하나"), candidate(13, 8, "us:AAPL", "둘", 2, "제목 둘")));
        when(watches.markNotified(anyLong(), eq(READ_AT), eq(NOW))).thenReturn(true);
        when(alerts.insertEvent(anyString(), eq("search_watch:12:2026-11-15T16:00:00Z"), any(), anyString(), anyString(), any()))
                .thenThrow(new DataIntegrityViolationException("합성 실패"));
        when(alerts.insertEvent(anyString(), eq("search_watch:13:2026-11-15T16:00:00Z"), any(), anyString(), anyString(), any()))
                .thenReturn(Optional.of(77L));
        when(alerts.deliverInbox(77L, 8L)).thenReturn(true);

        assertThat(job.run()).isEqualTo(1);
        verify(alerts).deliverInbox(77L, 8L);

        when(watches.notifyCandidates(any(), any(), any())).thenThrow(new DataAccessResourceFailureException("합성 연결 실패"));
        assertThatThrownBy(() -> job.run()).isInstanceOf(DataAccessResourceFailureException.class);
        job.scheduledRun();
    }

    @Test
    @DisplayName("같은 사건 키가 이미 있으면(같은 줄·같은 시각) 배달하지 않고 되돌림")
    void duplicateKeyRollsBack() {
        when(watches.notifyCandidates(any(), any(), any())).thenReturn(List.of(candidate(12, 7, "us:NVDA", "합성 대상", 1, "합성 제목")));
        when(watches.markNotified(12, READ_AT, NOW)).thenReturn(true);
        when(alerts.insertEvent(anyString(), anyString(), any(), anyString(), anyString(), any())).thenReturn(Optional.empty());

        assertThat(job.run()).isZero();
        verify(alerts, never()).deliverInbox(anyLong(), anyLong());
    }

    @Test
    @DisplayName("알림 칸(V38)이나 알림함 표가 없으면 일하지 않음")
    void notReady() {
        when(watches.notifyReady()).thenReturn(false);
        assertThat(job.run()).isZero();
        verify(watches, never()).notifyCandidates(any(), any(), any());

        when(watches.notifyReady()).thenReturn(true);
        when(alerts.ready()).thenReturn(false);
        assertThat(job.run()).isZero();
        verify(watches, never()).notifyCandidates(any(), any(), any());
        verify(alerts, never()).purgeUndeliveredEvents(anyString());
    }

    @Test
    @DisplayName("실행마다 배달이 남지 않은 SEARCH_WATCH 사건(알림함 90일 정리·탈퇴 뒤)을 지움 — 새 글이 없어도, 정리 실패는 알림을 막지 않음")
    void purgesUndeliveredEventsEveryRun() {
        when(watches.notifyCandidates(any(), any(), any())).thenReturn(List.of());
        assertThat(job.run()).isZero();
        verify(alerts).purgeUndeliveredEvents("SEARCH_WATCH");

        when(watches.notifyCandidates(any(), any(), any())).thenReturn(List.of(candidate(12, 7, "us:NVDA", "합성 대상", 1, "합성 제목")));
        when(watches.markNotified(12, READ_AT, NOW)).thenReturn(true);
        when(alerts.insertEvent(anyString(), anyString(), any(), anyString(), anyString(), any())).thenReturn(Optional.of(9L));
        when(alerts.deliverInbox(9L, 7L)).thenReturn(true);
        when(alerts.purgeUndeliveredEvents(anyString())).thenThrow(new DataIntegrityViolationException("합성 실패"));
        assertThat(job.run()).isEqualTo(1);
    }
}
