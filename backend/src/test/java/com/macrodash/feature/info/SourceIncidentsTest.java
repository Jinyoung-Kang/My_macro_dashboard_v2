package com.macrodash.feature.info;

import com.macrodash.store.InfoStore.SourceState;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** 끊김 판정(ADR 0035 결정 6) — 차단은 바로, 형식 바뀜 2회, 받지 못함 3회, 오래 못 받음은 간격 상한의 세 배. 출처 하나에 사건 하나. */
class SourceIncidentsTest {

    private static final Instant NOW = Instant.parse("2026-11-11T09:00:00Z");

    private static SourceState state(String task, String status, int streak, Instant lastOk) {
        return new SourceState(task, status, streak, status.equals("ok") ? null : "사유 " + status, lastOk,
                NOW.minus(Duration.ofMinutes(10)), 1440, NOW.minus(Duration.ofDays(3)));
    }

    @Test
    @DisplayName("차단은 한 번이면 사건, 형식 바뀜은 두 번, 받지 못함은 세 번부터")
    void thresholds() {
        List<SourceIncidents.Incident> incidents = SourceIncidents.build(List.of(
                state("info_blog_wolfstreet", "blocked", 1, NOW.minus(Duration.ofHours(1))),
                state("info_blog_ritholtz", "format", 1, NOW.minus(Duration.ofHours(1))),
                state("info_blog_klement", "format", 2, NOW.minus(Duration.ofHours(1))),
                state("info_naver_flows", "failed", 2, NOW.minus(Duration.ofHours(1))),
                state("info_waedge_brief", "failed", 3, NOW.minus(Duration.ofHours(1))),
                state("info_waedge_people", "ok", 1, NOW.minus(Duration.ofHours(1)))), NOW);

        assertThat(incidents).extracting(SourceIncidents.Incident::key)
                .containsExactly("info_blog_wolfstreet|blocked", "info_blog_klement|format", "info_waedge_brief|failed");
        assertThat(incidents.get(0).label()).isEqualTo("Wolf Street");
        assertThat(incidents.get(0).kindLabel()).contains("잠시 멈춤");
    }

    @Test
    @DisplayName("마지막 성공이 간격 상한의 세 배를 넘으면 오래 못 받음, 한 번도 못 받았으면 처음 기록부터 잰다")
    void stale() {
        List<SourceIncidents.Incident> incidents = SourceIncidents.build(List.of(
                state("info_blog_humbledollar", "ok", 1, NOW.minus(Duration.ofMinutes(1441))),
                state("info_blog_econbrowser", "ok", 1, NOW.minus(Duration.ofMinutes(1439))),
                state("info_blog_damodaran", "format", 1, null),
                state("unknown_task", "failed", 1, null)), NOW);

        assertThat(incidents).extracting(SourceIncidents.Incident::key)
                .containsExactly("info_blog_humbledollar|stale", "info_blog_damodaran|stale", "unknown_task|stale");
        assertThat(incidents.get(1).reason()).isEqualTo("아직 한 번도 받지 못함");
        assertThat(incidents.get(2).label()).as("표에 없는 태스크는 이름 그대로").isEqualTo("unknown_task");
    }

    // ------------------------------------------------------------------ QA-408
    // 화면의 안내 띠는 닫은 사건을 키로 기억합니다. 키가 '태스크|종류'뿐이면 회복했다가 같은 종류로 다시 끊겨도 같은 키라 띠가 뜨지 않습니다.
    // 사건마다 회차(episode)를 함께 내립니다 — 그 출처의 마지막 성공 시각이라 끊긴 동안은 그대로이고 회복하면 바뀝니다.

    private static Object episodeOf(SourceState state) {
        return InfoService.incidentJson(SourceIncidents.build(List.of(state), NOW).get(0)).get("episode");
    }

    @Test
    @Disabled("QA-408: 사건 응답에 회차(episode)가 없습니다 — 수정 커밋에서 풉니다")
    @DisplayName("QA-408: 사건의 회차는 마지막 성공 시각을 따른다 — 끊긴 동안 그대로, 회복 뒤 다시 끊기면 바뀜")
    void episodeFollowsLastSuccess() {
        Instant firstOk = NOW.minus(Duration.ofHours(30));
        Object blocked = episodeOf(state("info_blog_wolfstreet", "blocked", 1, firstOk));
        Object stillBlocked = episodeOf(state("info_blog_wolfstreet", "blocked", 4, firstOk));
        Object blockedAgain = episodeOf(state("info_blog_wolfstreet", "blocked", 1, NOW.minus(Duration.ofHours(2))));

        assertThat(blocked).isNotNull().isEqualTo(stillBlocked);
        assertThat(blockedAgain).isNotNull().isNotEqualTo(blocked);
    }

    @Test
    @Disabled("QA-408: 사건 응답에 회차(episode)가 없습니다 — 수정 커밋에서 풉니다")
    @DisplayName("QA-408: 한 번도 받지 못한 출처의 회차는 고정 글자다(null이 아님)")
    void episodeOfNeverSucceededSource() {
        assertThat(episodeOf(state("info_blog_damodaran", "blocked", 1, null))).isEqualTo("never");
    }

    @Test
    @DisplayName("회차는 알림 기록의 키(태스크|종류)를 바꾸지 않는다")
    void keyStaysTaskAndKind() {
        assertThat(SourceIncidents.build(List.of(state("info_blog_wolfstreet", "blocked", 1, NOW.minus(Duration.ofHours(2)))), NOW))
                .extracting(SourceIncidents.Incident::key).containsExactly("info_blog_wolfstreet|blocked");
    }
}
