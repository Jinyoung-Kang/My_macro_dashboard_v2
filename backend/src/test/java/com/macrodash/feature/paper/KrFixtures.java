package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.time.Instant;
import java.util.Optional;

import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.nullable;
import static org.mockito.Mockito.when;

/**
 * 한국 시장 묶음 시험의 공통 재료 — 공휴일 저장본({@code calendar.kr_holidays})은 analytics 시험이 쓰는 천문연 실제 응답
 * ({@code paper/kr-calendar/kasi-holidays-2026-2027.json})을 수집기 저장 모양({@code {years: {"2026": {holidays, announced,
 * fetchedAt}}}} — {@code task_kr_holidays})으로 옮긴 것입니다.
 */
final class KrFixtures {

    private KrFixtures() {
    }

    /** 공휴일 저장본의 수집 시각(시험용). */
    static final Instant HOLIDAYS_COLLECTED = Instant.parse("2026-10-26T13:00:00Z");

    /** 천문연 실제 응답의 그해 목록으로 만든 공휴일 저장본 본문(받은 해만 — 2026·2027 중에서). */
    static ObjectNode holidaysPayload(int... years) {
        JsonNode source = read("paper/kr-calendar/kasi-holidays-2026-2027.json");
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("source", "한국천문연구원 특일정보 (getRestDeInfo, isHoliday=Y)");
        ObjectNode stored = payload.putObject("years");
        for (int year : years) {
            JsonNode days = source.path("years").path(String.valueOf(year));
            if (!days.isArray() || days.isEmpty()) {
                throw new IllegalArgumentException(year + "년 천문연 시험 자료가 없습니다");
            }
            ObjectNode entry = stored.putObject(String.valueOf(year));
            ArrayNode holidays = entry.putArray("holidays");
            days.forEach(day -> holidays.addObject().put("date", day.path("date").asString())
                    .put("name", day.path("name").asString()));
            entry.put("announced", true);
            entry.put("fetchedAt", "2026-10-26T22:00:00+09:00");
        }
        return payload;
    }

    /** 공휴일 저장본(스냅샷) — {@link #holidaysPayload}. */
    static Snapshot holidays(int... years) {
        return snapshot(Datasets.SNAP_KR_HOLIDAYS, holidaysPayload(years), HOLIDAYS_COLLECTED);
    }

    static Snapshot snapshot(String name, JsonNode payload, Instant collectedAt) {
        return new Snapshot(name, payload, "json", "ok", null, collectedAt);
    }

    /** 가짜 저장본 읽기에 공휴일 저장본을 넣습니다(조용히 읽는 {@link PaperFixtures#quietReader}에). */
    static void stubHolidays(StoreReader reader, Snapshot holidays) {
        stub(reader, Datasets.SNAP_KR_HOLIDAYS, holidays);
    }

    /** 가짜 저장본 읽기에 그 데이터셋의 저장본을 넣습니다(null이면 없음). */
    static void stub(StoreReader reader, String dataset, Snapshot snapshot) {
        when(reader.read(eq(dataset), anyLong(), nullable(String.class))).thenReturn(Optional.ofNullable(snapshot));
    }

    /** 실행을 열 때 시장 묶음이 받는 재료 — 그 설정 본문과 공휴일 저장본 하나(다른 데이터셋은 없음). */
    static MarketRun.Inputs inputs(JsonNode settingsBody, Snapshot holidays) {
        return new MarketRun.Inputs(settingsBody, (dataset, maxAgeSeconds, task) ->
                Datasets.SNAP_KR_HOLIDAYS.equals(dataset) ? Optional.ofNullable(holidays) : Optional.empty());
    }

    static JsonNode read(String resource) {
        try (InputStream in = KrFixtures.class.getClassLoader().getResourceAsStream(resource)) {
            if (in == null) {
                throw new IllegalStateException("시험 자료가 없습니다: " + resource);
            }
            return PaperFixtures.MAPPER.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
