package com.macrodash.store;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * "언제 수집한 값인지 항상 함께 보여 준다"는 약속을 응답 수준에서 고정합니다.
 *
 * <p>실제로 깨져 있던 부분입니다. 12곳 중 1곳만 ageSeconds를 담아서, 화면의
 * "수집" 배지가 매크로 메뉴를 뺀 모든 메뉴에서 "—"로 떴습니다. 수집 시각을
 * 안 보여 주는 대시보드는 지금 보고 있는 숫자가 1분 전 것인지 3일 전 것인지
 * 알려 주지 않는다는 뜻이라, 이 프로젝트에서는 기능 하나가 빠진 것과 같습니다.
 */
class SnapshotFreshnessTest {

    private Snapshot snapshotCollectedAt(Instant collectedAt) {
        return new Snapshot("test.dataset", null, "json", "ok", null, collectedAt);
    }

    @Test
    @DisplayName("신선도는 표시 문구와 경과 초를 항상 함께 담는다")
    void putsBothKeys() {
        Map<String, Object> out = new LinkedHashMap<>();
        snapshotCollectedAt(Instant.now().minus(Duration.ofMinutes(3))).putFreshness(out);

        assertThat(out).containsKeys("collectedAtKst", "ageSeconds");
        assertThat(String.valueOf(out.get("collectedAtKst"))).endsWith("KST");
        assertThat((Long) out.get("ageSeconds")).isBetween(170L, 190L);
    }

    @Test
    @DisplayName("수집 시각을 모르면 경과 초를 지어내지 않는다")
    void unknownCollectedAtDoesNotFabricateAge() {
        Map<String, Object> out = new LinkedHashMap<>();
        snapshotCollectedAt(null).putFreshness(out);

        // 0초(=방금 수집)로 내려보내면 '데이터 없음'이 '최신'으로 보입니다.
        assertThat(out.get("ageSeconds")).isNull();
        assertThat(out.get("collectedAtKst")).isEqualTo("알 수 없음");
    }
}
