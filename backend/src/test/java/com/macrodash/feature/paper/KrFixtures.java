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

    /**
     * {@code paper.kr.quotes} 저장본 본문 — 계약 1(명세 §9) 중 출발 게이트가 보는 칸: 머리 {@code contract}·{@code session}·{@code scope}(받은
     * 순서), 종목마다 {@code status OK}·{@code fetchedAt}·최근 두 봉(전날·마지막 봉 날짜). 마지막 봉 날짜가 null인 종목은 범위에만 있고 항목이
     * 없습니다('호출 실패, 이을 값도 없음').
     */
    static ObjectNode quotesPayload(java.time.LocalDate session, java.util.Map<String, java.time.LocalDate> lastBars) {
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("contract", 1);
        payload.put("session", session.toString());
        payload.put("universeDate", session.minusDays(1).toString());
        ArrayNode scope = payload.putArray("scope");
        ObjectNode codes = payload.putObject("codes");
        lastBars.forEach((code, last) -> {
            scope.add(code);
            if (last == null) {
                return;
            }
            ObjectNode entry = codes.putObject(code);
            entry.put("status", "OK");
            entry.put("fetchedAt", session + "T12:57:00Z");
            ArrayNode bars = entry.putArray("bars");
            bars.addObject().put("date", last.minusDays(1).toString()).put("close", 10_000).put("volume", 1_000);
            bars.addObject().put("date", last.toString()).put("open", 10_100).put("close", 10_200).put("volume", 1_200);
        });
        return payload;
    }

    /**
     * {@code paper.kr.quotes} 계약 1 저장본 본문을 만드는 도우미(장부 시험용 — 수집기 {@code kr_paper_quotes}가 쓰는 칸 그대로). 종목은
     * {@link #code}로 더하고, 봉·1분봉 개장 봉은 {@link Entry}로 붙입니다.
     */
    static final class Payload {

        final ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        private final ArrayNode scope;
        private final ObjectNode codes;

        Payload(java.time.LocalDate session) {
            payload.put("contract", 1);
            payload.put("source", "시험용");
            payload.put("session", session.toString());
            payload.put("universeDate", session.minusDays(1).toString());
            scope = payload.putArray("scope");
            codes = payload.putObject("codes");
        }

        /** NXT 거래 주식(일봉 출처 {@code TOSS_INTEGRATED}) 한 종목 — 그 종목을 받은 시각 {@code fetchedAt}. */
        Entry code(String code, Instant fetchedAt) {
            return entry(code, fetchedAt, true, "STOCK");
        }

        /** KRX 단독 ETF(일봉 출처 {@code TOSS_DAILY}) 한 종목. */
        Entry etf(String code, Instant fetchedAt) {
            return entry(code, fetchedAt, false, "ETF");
        }

        private Entry entry(String code, Instant fetchedAt, boolean nxt, String type) {
            scope.add(code);
            ObjectNode node = codes.putObject(code);
            node.put("code", code);
            node.put("status", "OK");
            node.put("fetchedAt", fetchedAt.toString());
            node.put("securityType", type);
            node.put("nxtSupported", nxt);
            node.put("krxTradingSuspended", false);
            return new Entry(node, nxt ? "TOSS_INTEGRATED" : "TOSS_DAILY");
        }

        Snapshot snapshot(Instant collectedAt) {
            return KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES, payload, collectedAt);
        }
    }

    /** 계약 1 종목 항목 하나 — 봉은 오래된 날부터 더합니다. */
    static final class Entry {

        final ObjectNode node;
        private final ArrayNode bars;
        private final String source;

        Entry(ObjectNode node, String source) {
            this.node = node;
            this.source = source;
            this.bars = node.putArray("bars");
        }

        /** 일봉 하나(시가·종가·거래량 — null이면 칸에 null). */
        Entry bar(java.time.LocalDate date, Number open, Number close, Number volume) {
            ObjectNode bar = bars.addObject();
            bar.put("date", date.toString());
            putNumber(bar, "open", open);
            putNumber(bar, "high", open);
            putNumber(bar, "low", close);
            putNumber(bar, "close", close);
            putNumber(bar, "volume", volume);
            bar.put("priceSource", source);
            putNumber(bar, "adjClose", close);
            if (close != null) {
                bar.put("adjRatio", 1.0);
            } else {
                bar.putNull("adjRatio");
            }
            return this;
        }

        /** 마지막 봉의 수정 비율(adjusted=true 종가 ÷ 원시 종가 — B7)과 그 수정 종가를 바꿉니다(기본 1.0). */
        Entry ratio(double adjRatio) {
            ObjectNode bar = (ObjectNode) bars.get(bars.size() - 1);
            bar.put("adjRatio", adjRatio);
            if (bar.path("close").isNumber()) {
                bar.put("adjClose", bar.path("close").asDouble() * adjRatio);
            }
            return this;
        }

        /** 마지막 봉의 1분봉 개장 봉 — 라벨·시가·거래량을 셋씩(라벨 없이 상태만이면 빈 opens). */
        Entry minute(String status, Object... labelOpenVolume) {
            ObjectNode minute = ((ObjectNode) bars.get(bars.size() - 1)).putObject("minute");
            minute.put("status", status);
            minute.put("priceSource", "TOSS_1M_OPEN");
            if ("FAILED".equals(status)) {
                minute.put("reason", "아직 묻지 못함 — 호출 예산·시간 상한");
                return this;
            }
            ObjectNode opens = minute.putObject("opens");
            for (int i = 0; i + 2 < labelOpenVolume.length; i += 3) {
                ObjectNode open = opens.putObject((String) labelOpenVolume[i]);
                putNumber(open, "open", (Number) labelOpenVolume[i + 1]);
                putNumber(open, "volume", (Number) labelOpenVolume[i + 2]);
            }
            return this;
        }

        /** 이번에 받지 못해 직전 값을 이은 항목(QA-032 — 관측이 아님). */
        Entry stale() {
            node.put("isStale", true);
            node.put("staleReason", "시험용 호출 실패");
            node.put("staleSince", "2026-11-03T13:00:00+00:00");
            return this;
        }

        private static void putNumber(ObjectNode node, String field, Number value) {
            if (value == null) {
                node.putNull(field);
            } else if (value instanceof Double || value instanceof Float) {
                node.put(field, value.doubleValue());
            } else {
                node.put(field, value.longValue());
            }
        }
    }

    /** 금융위 메타 저장본 본문({@code kr.fsc_prices_meta} — 최신 기준일 {@code latestBasDt}). */
    static ObjectNode fscMeta(java.time.LocalDate latest) {
        ObjectNode payload = PaperFixtures.MAPPER.createObjectNode();
        payload.put("latestBasDt", latest.toString());
        payload.put("rows", 2_778);
        return payload;
    }

    /** 시각을 움직이는 시계(같은 작업 인스턴스로 여러 주기를 돌리는 시험). */
    static final class MovableClock extends java.time.Clock {

        private Instant now;

        MovableClock(Instant now) {
            this.now = now;
        }

        void set(Instant next) {
            now = next;
        }

        @Override
        public java.time.ZoneId getZone() {
            return java.time.ZoneOffset.UTC;
        }

        @Override
        public java.time.Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
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
