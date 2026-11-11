package com.macrodash.feature.info;

import com.macrodash.store.InfoStore.SourceState;
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
}
