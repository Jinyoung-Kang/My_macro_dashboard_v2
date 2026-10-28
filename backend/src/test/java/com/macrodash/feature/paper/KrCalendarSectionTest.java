package com.macrodash.feature.paper;

import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 한국 일정 섹션 1b_calendar(2단계 명세 §4-11·K20, E1a) — 다음 KR 세션부터 10거래일 창, 일정 미확인 발표는 따로, 금통위 상수 끝을 넘으면 '갱신 필요 —
 * 미게시', 수집 범위 밖 창, 저장본 없음·읽은 순간 뒤 수집은 '자료 없음', 실적·컨센서스는 늘 null + 사유.
 */
class KrCalendarSectionTest {

    private static Instant kst(String local) {
        return java.time.ZonedDateTime.of(java.time.LocalDateTime.parse(local), com.macrodash.analytics.KrxCalendar.SEOUL)
                .toInstant();
    }

    private static final LocalDate D = LocalDate.of(2026, 11, 3);
    private static final Instant READ = kst("2026-11-03T22:31");

    private static Snapshot snapshot(String through, String horizonTo, Instant collectedAt) {
        ObjectNode payload = MAPPER.createObjectNode();
        ObjectNode macro = payload.putObject("macro");
        macro.putObject("bok").put("through", through).put("checkedAt", "2026-10-26").put("note", "2027 일정 미게시");
        ArrayNode events = macro.putArray("events");
        events.addObject().put("date", "2026-11-17").put("kind", "RELEASE").put("name", "가 발표").put("source", "A");
        events.addObject().put("date", "2026-11-17").put("kind", "MPB").put("name", "금통위").put("source", "B");
        events.addObject().put("date", "2026-11-03").put("kind", "RELEASE").put("name", "그날 발표(창 앞)").put("source", "A");
        events.addObject().put("date", "2026-11-18").put("kind", "RELEASE").put("name", "창 뒤").put("source", "A");
        macro.putObject("horizon").put("from", "2026-11-03").put("to", horizonTo);
        ObjectNode releases = macro.putObject("releases");
        releases.putObject("CPI").put("name", "소비자물가동향").put("agency", "국가데이터처").put("status", "일정 미확인")
                .putNull("through");
        releases.putObject("GDP").put("name", "GDP 속보").put("agency", "한국은행").put("status", "확인")
                .put("through", "2026-11-10");
        macro.putArray("unconfirmed").add("CPI");
        payload.putNull("earnings");
        payload.put("earningsNote", "한국 실적 발표 일정 출처 없음");
        payload.putNull("consensus");
        payload.put("consensusNote", "한국 컨센서스 출처 없음");
        return KrFixtures.snapshot(Datasets.SNAP_KR_CALENDAR, payload, collectedAt);
    }

    private static JsonNode build(Optional<Snapshot> snapshot) {
        return MAPPER.valueToTree(KrCalendarSection.build(snapshot, KrRulesFixtures.CALENDAR, D, READ).section());
    }

    @Test
    @DisplayName("창 안 줄만(같은 날은 MPB 먼저) — 일정 미확인은 따로, 옮긴 발표의 끝을 넘으면 갱신 필요, 금통위 상수 안이면 ok")
    void windowRowsAndUnconfirmed() {
        KrCalendarSection.Built built = KrCalendarSection.build(Optional.of(snapshot("2026-11-26", "2026-12-18",
                kst("2026-11-03T22:01"))), KrRulesFixtures.CALENDAR, D, READ);
        JsonNode out = MAPPER.valueToTree(built.section());
        assertThat(out.path("window").path("from").asString()).isEqualTo("2026-11-04");
        assertThat(out.path("window").path("to").asString()).isEqualTo("2026-11-17");
        assertThat(out.path("macro").path("rows").toString())
                .isEqualTo("[[\"2026-11-17\",\"MPB\",\"금통위\",\"s1\"],[\"2026-11-17\",\"RELEASE\",\"가 발표\",\"s2\"]]");
        assertThat(out.path("sources").path("s1").asString()).isEqualTo("B");
        assertThat(out.path("unconfirmed").get(0).path("key").asString()).isEqualTo("CPI");
        assertThat(out.path("releasesPastConstant").get(0).path("key").asString()).isEqualTo("GDP");
        assertThat(out.path("releasesPastConstant").get(0).path("status").asString()).isEqualTo("갱신 필요 — 미게시");
        assertThat(out.path("bok").path("status").asString()).isEqualTo("ok");
        assertThat(out.has("horizon")).isFalse();
        assertThat(out.path("earnings").isNull()).isTrue();
        assertThat(out.path("consensusNote").asString()).isEqualTo("한국 컨센서스 출처 없음");
        assertThat(built.available()).isTrue();
        assertThat(built.rows()).isEqualTo(2);
    }

    @Test
    @DisplayName("금통위 상수 끝·수집 범위를 창 끝이 넘으면 '갱신 필요 — 미게시'와 확인한 범위 — 지어내지 않음")
    void pastConstantAndHorizon() {
        JsonNode out = build(Optional.of(snapshot("2026-11-12", "2026-11-14", kst("2026-11-03T22:01"))));
        assertThat(out.path("bok").path("status").asString()).isEqualTo("갱신 필요 — 미게시");
        assertThat(out.path("bok").path("note").asString()).isEqualTo("2027 일정 미게시");
        assertThat(out.path("horizon").path("to").asString()).isEqualTo("2026-11-14");
        assertThat(out.path("horizonNote").asString()).isEqualTo(CalendarSection.HORIZON_NOTE);
    }

    @Test
    @DisplayName("저장본 없음·읽은 순간 뒤 수집 — '자료 없음'과 사유, 빈 표 없음, 실적·컨센서스 null + 사유")
    void missing() {
        JsonNode none = build(Optional.empty());
        assertThat(none.path("missing").asString()).startsWith("자료 없음 — 한국 일정 저장본");
        assertThat(none.has("macro")).isFalse();
        assertThat(none.path("earnings").isNull()).isTrue();
        JsonNode late = build(Optional.of(snapshot("2026-11-26", "2026-12-18", kst("2026-11-03T22:40"))));
        assertThat(late.path("missing").asString()).contains("읽은 순간 뒤에 수집됨");
        assertThat(KrCalendarSection.build(Optional.empty(), KrRulesFixtures.CALENDAR, D, READ).available()).isFalse();
    }
}
