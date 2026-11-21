package com.macrodash.feature.paper;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 장중 스탑 체결 기록 스위치({@link KrStopFill} — ADR 0045)의 읽기와 유효 값: 유효 값 = 감시({@code kr.stopWatch.mode})가 ON이고 이 키가 SHADOW·ON일
 * 때만 그 값(관문 G1과 ON 판 글 스위치가 쓰는 한 술어), 키가 없거나 틀린 값·형이면 OFF.
 */
class KrStopFillTest {

    private static ObjectNode body(String mode, Object fill) {
        ObjectNode body = MAPPER.createObjectNode();
        ObjectNode stopWatch = body.putObject("kr").putObject("stopWatch");
        if (mode != null) {
            stopWatch.put("mode", mode);
        }
        if (fill instanceof String text) {
            stopWatch.put("fill", text);
        } else if (fill instanceof Boolean flag) {
            stopWatch.put("fill", flag);
        }
        return body;
    }

    @Test
    @DisplayName("유효 값 표 — 감시 OFF·SHADOW·없음 × 기록 세 값은 모두 OFF, 감시 ON × 기록 OFF·SHADOW·ON은 그 값")
    void effectiveTable() {
        Object[][] table = {
                {null, null, KrStopFill.OFF, KrStopFill.OFF},
                {"OFF", "ON", KrStopFill.ON, KrStopFill.OFF},
                {"OFF", "SHADOW", KrStopFill.SHADOW, KrStopFill.OFF},
                {"SHADOW", "ON", KrStopFill.ON, KrStopFill.OFF},
                {"SHADOW", "SHADOW", KrStopFill.SHADOW, KrStopFill.OFF},
                {null, "ON", KrStopFill.ON, KrStopFill.OFF},
                {"ON", null, KrStopFill.OFF, KrStopFill.OFF},
                {"ON", "OFF", KrStopFill.OFF, KrStopFill.OFF},
                {"ON", "SHADOW", KrStopFill.SHADOW, KrStopFill.SHADOW},
                {"ON", "ON", KrStopFill.ON, KrStopFill.ON},
                {"ON", "on", KrStopFill.OFF, KrStopFill.OFF},
                {"ON", Boolean.TRUE, KrStopFill.OFF, KrStopFill.OFF},
                {"on", "ON", KrStopFill.ON, KrStopFill.OFF},
        };
        for (Object[] row : table) {
            ObjectNode body = body((String) row[0], row[1]);
            assertThat(KrStopFill.of(body)).as("적힌 값 " + row[0] + "/" + row[1]).isEqualTo(row[2]);
            assertThat(KrStopFill.effective(body)).as("유효 값 " + row[0] + "/" + row[1]).isEqualTo(row[3]);
        }
        assertThat(KrStopFill.of(null)).isEqualTo(KrStopFill.OFF);
        assertThat(KrStopFill.effective(null)).isEqualTo(KrStopFill.OFF);
        assertThat(KrStopFill.effective(MAPPER.createObjectNode())).isEqualTo(KrStopFill.OFF);
        assertThat(KrStopFill.OFF.evaluates()).isFalse();
        assertThat(KrStopFill.SHADOW.evaluates()).isTrue();
        assertThat(KrStopFill.SHADOW.records()).isFalse();
        assertThat(KrStopFill.ON.evaluates()).isTrue();
        assertThat(KrStopFill.ON.records()).isTrue();
        assertThat(KrStopFill.KEY).isEqualTo("kr.stopWatch.fill");
        assertThat(KrStopFill.OPTIONS).containsExactly("OFF", "SHADOW", "ON");
    }
}
