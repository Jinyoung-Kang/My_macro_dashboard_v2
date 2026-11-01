package com.macrodash.store;

import com.macrodash.Kst;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.time.Instant;
import java.util.Map;

/**
 * 저장된 스냅샷 1건과 그 신선도.
 *
 * @param name        데이터셋 이름 ({@link Datasets})
 * @param payload     수집기가 적재한 JSON
 * @param kind        json | frame | object (구버전 호환 표시)
 * @param status      ok | estimated | error
 * @param error       실패 사유 (있으면)
 * @param collectedAt 수집 시각
 */
public record Snapshot(
        String name,
        JsonNode payload,
        String kind,
        String status,
        String error,
        Instant collectedAt
) {


    public long ageSeconds() {
        if (collectedAt == null) {
            return Long.MAX_VALUE;
        }
        return Math.max(0, Duration.between(collectedAt, Instant.now()).getSeconds());
    }

    public boolean isFresh(long maxAgeSeconds) {
        return ageSeconds() <= maxAgeSeconds;
    }

    /**
     * 추정치 여부.
     *
     * <p>추정치를 확정치처럼 보여 주면 교차 검증도 무의미해집니다. 화면은 이
     * 값을 보고 반드시 경고를 띄워야 합니다.
     */
    public boolean isEstimated() {
        return "estimated".equals(status);
    }

    public String collectedAtKst() {
        return collectedAt == null ? "알 수 없음" : Kst.stamp(collectedAt);
    }

    /**
     * 응답에 신선도 두 값을 함께 넣습니다.
     *
     * <p>둘을 따로 넣게 두면 한쪽을 빠뜨립니다. 실제로 12군데 중 1곳만
     * ageSeconds를 넣어, 화면의 "수집" 배지가 대부분의 메뉴에서 "—"로
     * 떴습니다. "언제 수집한 값인지 항상 보여 준다"는 이 프로젝트의 약속이
     * 조용히 깨져 있던 것입니다. 한 번의 호출로 묶어 둡니다.
     *
     * <p>collectedAtKst는 사람이 읽는 문구("2026-09-17 04:08 KST")라
     * 화면이 되파싱하기 어렵습니다. 경과 초는 서버가 정확히 아는 값이므로
     * 서버가 계산해 내려보냅니다.
     */
    public void putFreshness(Map<String, Object> out) {
        out.put("collectedAtKst", collectedAtKst());
        out.put("ageSeconds", collectedAt == null ? null : ageSeconds());
    }
}
