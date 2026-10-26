package com.macrodash.analytics;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SortedSet;
import java.util.TreeSet;

/**
 * 한국 거래일 달력 시험 자료 — {@code src/test/resources/paper/kr-calendar/}의 실제 응답(출처는 각 파일의 {@code _source}).
 *
 * <ul>
 *   <li>{@code krx-holidays-YYYY.json} — KRX 공식 휴장일 목록(평일만, 연말휴장일 포함) 2022·2023·2026·2027</li>
 *   <li>{@code kasi-holidays-2026-2027.json} — 천문연 특일정보 공휴일(isHoliday=Y, 주말 포함) 2026·2027</li>
 * </ul>
 */
final class KrxFixtures {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String DIR = "paper/kr-calendar/";

    private KrxFixtures() {
    }

    /** KRX 공식 휴장일 목록의 날짜 → 이름(날짜 순). */
    static Map<LocalDate, String> krxClosures(int year) {
        Map<LocalDate, String> out = new LinkedHashMap<>();
        for (JsonNode row : read("krx-holidays-" + year + ".json").path("block1")) {
            out.put(LocalDate.parse(row.path("calnd_dd").asString()), row.path("holdy_nm").asString());
        }
        return out;
    }

    /** 천문연 공휴일(그해, 주말에 걸린 날 포함). */
    static List<LocalDate> kasiHolidays(int year) {
        List<LocalDate> out = new ArrayList<>();
        for (JsonNode row : read("kasi-holidays-2026-2027.json").path("years").path(String.valueOf(year))) {
            out.add(LocalDate.parse(row.path("date").asString()));
        }
        if (out.isEmpty()) {
            throw new IllegalArgumentException(year + "년 천문연 자료가 없습니다");
        }
        return out;
    }

    /** 달력이 본 그해 평일 휴장일(오름차순) — KRX 목록(평일만)과 견주려고. */
    static SortedSet<LocalDate> weekdayClosures(TradingCalendar calendar, int year) {
        SortedSet<LocalDate> out = new TreeSet<>();
        for (LocalDate d = LocalDate.of(year, 1, 1); d.getYear() == year; d = d.plusDays(1)) {
            if (d.getDayOfWeek() != DayOfWeek.SATURDAY && d.getDayOfWeek() != DayOfWeek.SUNDAY
                    && !calendar.isTradingDay(d)) {
                out.add(d);
            }
        }
        return out;
    }

    private static JsonNode read(String name) {
        try (InputStream in = KrxFixtures.class.getClassLoader().getResourceAsStream(DIR + name)) {
            if (in == null) {
                throw new IllegalStateException("시험 자료가 없습니다: " + DIR + name);
            }
            return MAPPER.readTree(in);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }
}
