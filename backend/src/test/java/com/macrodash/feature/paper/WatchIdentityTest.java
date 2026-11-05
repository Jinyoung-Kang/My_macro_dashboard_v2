package com.macrodash.feature.paper;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 감시 저장본이 어느 계획의 것인가({@link WatchIdentity} — ADR 0027 결정 3): 저장본 한 장이 창 안 계획 여럿의 신원을 실으므로, 읽는 쪽은 자기 행의
 * 신원(계좌·세션·확인 시각·순번)이 목록에 있을 때만 씁니다. 목록이 생기기 전 저장본은 신원 하나를 순번 없는 계획(끈 판 장중 확인)으로만 봅니다.
 */
class WatchIdentityTest {

    private static final LocalDate SESSION = LocalDate.of(2026, 11, 2);

    @Test
    @DisplayName("목록이 있으면 목록에서 찾음 — 계좌·세션·시각·순번이 모두 같아야 하고, 끈 판 행(순번 없음)과 켠 판 행(순번 1·2)은 서로 맞지 않음")
    void listedIdentities() {
        JsonNode payload = MAPPER.readTree("{\"checkpoint\":{\"book\":\"claude\",\"sessionDate\":\"2026-11-02\",\"atEt\":\"09:55\"},"
                + "\"checkpoints\":[{\"book\":\"claude\",\"sessionDate\":\"2026-11-02\",\"atEt\":\"09:55\",\"slot\":1},"
                + "{\"book\":\"claude2\",\"sessionDate\":\"2026-11-02\",\"atEt\":\"10:00\",\"slot\":null},"
                + "{\"book\":\"claude2\",\"sessionDate\":\"2026-11-02\",\"atEt\":\"10:10\",\"slot\":2}]}");

        assertThat(WatchIdentity.carries(payload, WatchIdentity.US_AT, "claude", SESSION, "09:55", 1)).isTrue();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.US_AT, "claude2", SESSION, "10:00", null)).as("끈 판 장중 확인 행").isTrue();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.US_AT, "claude2", SESSION, "10:10", 2)).isTrue();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.US_AT, "claude", SESSION, "09:55", null))
                .as("예전 모양의 checkpoint가 있어도 목록이 있으면 목록만 — 순번이 다르면 다른 계획").isFalse();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.US_AT, "claude", SESSION, "09:55", 2)).isFalse();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.US_AT, "claude2", SESSION, "10:00", 1)).isFalse();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.US_AT, "claude2", SESSION.plusDays(1), "10:10", 2)).as("다른 세션").isFalse();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.US_AT, "claude2", SESSION, "10:11", 2)).as("다른 시각").isFalse();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.KR_AT, "claude2", SESSION, "10:10", 2)).as("다른 시장의 시각 칸").isFalse();
    }

    @Test
    @DisplayName("목록이 없는 예전 저장본은 checkpoint 하나를 순번 없는 계획으로만 — 켠 판 행은 맞지 않음. 본문·신원이 없으면 거짓")
    void legacySingleIdentity() {
        JsonNode payload = MAPPER.readTree("{\"checkpoint\":{\"book\":\"kr_claude2\",\"sessionDate\":\"2026-11-02\",\"atKst\":\"11:00\"}}");

        assertThat(WatchIdentity.carries(payload, WatchIdentity.KR_AT, "kr_claude2", SESSION, "11:00", null)).isTrue();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.KR_AT, "kr_claude2", SESSION, "11:00", 1)).isFalse();
        assertThat(WatchIdentity.carries(payload, WatchIdentity.KR_AT, "kr_claude", SESSION, "11:00", null)).isFalse();
        assertThat(WatchIdentity.carries(null, WatchIdentity.KR_AT, "kr_claude2", SESSION, "11:00", null)).isFalse();
        assertThat(WatchIdentity.carries(MAPPER.readTree("{}"), WatchIdentity.KR_AT, "kr_claude2", SESSION, "11:00", null)).isFalse();
        assertThat(WatchIdentity.carries(MAPPER.readTree("{\"checkpoints\":[]}"), WatchIdentity.KR_AT, "kr_claude2", SESSION, "11:00", null))
                .as("빈 목록 — 창 안 계획이 없던 저장본").isFalse();
    }
}
