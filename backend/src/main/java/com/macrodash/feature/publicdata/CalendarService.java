package com.macrodash.feature.publicdata;

import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 한국 공휴일 (천문연 특일정보) — 화면 시계의 KRX 휴장 판정용.
 *
 * <p>휴장 판정 자체는 화면({@code marketCalendar.ts})이 합니다. 인터넷이 끊겨도
 * 시계가 동작해야 하므로 계산 규칙은 브라우저에 있고, 여기서는 규칙으로 알 수
 * 없는 날(대체공휴일·선거일·임시공휴일)을 <b>공식 목록</b>으로 보태 줍니다.
 */
@Service
public class CalendarService {

    private static final Pattern ISO_DATE = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");

    private final StoreReader store;

    public CalendarService(StoreReader store) {
        this.store = store;
    }

    /**
     * 저장된 연도별 공휴일.
     *
     * @return {@code available}, {@code years: {"2026": {announced, holidays:[{date,name}]}}},
     *         신선도 필드. 저장본이 없으면 {@code available=false}와 빈 {@code years}
     *         — 화면은 내장 규칙만으로 계속 동작합니다.
     *         <p>주의사항 — 형식이 YYYY-MM-DD가 아닌 날짜는 버립니다. 화면은 이 값을
     *         문자열 그대로 비교하므로 형식이 다르면 조용히 "거래일"로 보입니다.
     */
    /** 저장된 공휴일 날짜(YYYY-MM-DD) 전체. 저장본이 없으면 빈 집합. */
    @SuppressWarnings("unchecked")
    public Set<String> holidayDates() {
        Set<String> out = new LinkedHashSet<>();
        Object years = krHolidays().get("years");
        if (years instanceof Map<?, ?> byYear) {
            for (Object year : byYear.values()) {
                if (year instanceof Map<?, ?> info && info.get("holidays") instanceof List<?> days) {
                    for (Object day : days) {
                        if (day instanceof Map<?, ?> entry && entry.get("date") instanceof String date) {
                            out.add(date);
                        }
                    }
                }
            }
        }
        return out;
    }

    public Map<String, Object> krHolidays() {
        Map<String, Object> out = new LinkedHashMap<>();
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_KR_HOLIDAYS, Datasets.MAX_AGE_WEEKLY, "kr_holidays");

        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("years", Map.of());
            out.put("message", "공휴일 저장본이 없습니다. DATA_GO_KR_SERVICE_KEY를 설정하면 "
                    + "천문연 특일정보로 대체공휴일·선거일까지 반영됩니다.");
            return out;
        }

        JsonNode payload = snapshot.get().payload();
        snapshot.get().putFreshness(out);
        out.put("available", true);
        out.put("source", Json.asText(payload, "source"));

        Map<String, Object> years = new LinkedHashMap<>();
        JsonNode stored = Json.child(payload, "years");
        if (stored != null) {
            for (Map.Entry<String, JsonNode> entry : stored.properties()) {
                List<Map<String, String>> holidays = new ArrayList<>();
                for (JsonNode day : Json.array(entry.getValue(), "holidays")) {
                    String date = Json.asText(day, "date");
                    if (date != null && ISO_DATE.matcher(date).matches()) {
                        holidays.add(Map.of("date", date, "name", String.valueOf(Json.asText(day, "name"))));
                    }
                }
                Map<String, Object> year = new LinkedHashMap<>();
                year.put("announced", Json.asBoolean(entry.getValue(), "announced"));
                year.put("fetchedAt", Json.asText(entry.getValue(), "fetchedAt"));
                year.put("holidays", holidays);
                years.put(entry.getKey(), year);
            }
        }
        out.put("years", years);
        return out;
    }
}
