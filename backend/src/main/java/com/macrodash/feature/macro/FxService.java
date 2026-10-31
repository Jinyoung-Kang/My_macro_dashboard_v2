package com.macrodash.feature.macro;

import com.macrodash.Kst;
import com.macrodash.analytics.FxIndex;
import com.macrodash.analytics.SeriesMath;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Optional;
import java.util.TreeMap;

/**
 * 💱 환율·달러인덱스 비교 차트.
 *
 * <p>화면에서 <b>고른 계열만</b> 겹쳐 그립니다. 티커는 매크로 카드와 같은
 * 것을 쓰므로(수집기 {@code fx_history} 태스크), 카드의 최근값과 차트의 끝값이
 * 어긋나지 않습니다.
 *
 * <p>단위가 서로 다른 계열을 한 축에 겹치는 문제는 {@link FxIndex}의 설명을
 * 보세요 — 기본은 <b>기준일 = 100</b>이고, 원래 단위도 고를 수 있되 화면이
 * 자릿수 경고를 함께 띄웁니다.
 */
@Service
public class FxService {

    /** 고를 수 있는 기간. 일봉 저장본을 잘라 쓰므로 분봉 기간(1d·5d)은 없습니다. */
    public static final List<String> PERIODS = List.of("1mo", "3mo", "6mo", "1y", "2y", "5y");

    /** 기본 선택. 넷을 다 켜 두면 처음 보는 사람에게 선이 너무 많습니다. */
    public static final List<String> DEFAULT_IDS = List.of("usdkrw", "dxy");

    private static final Map<String, Integer> PERIOD_MONTHS = Map.of(
            "1mo", 1, "3mo", 3, "6mo", 6, "1y", 12, "2y", 24, "5y", 60);

    private final StoreReader store;

    public FxService(StoreReader store) {
        this.store = store;
    }

    /**
     * 고른 계열의 시계열.
     *
     * @param ids    쉼표로 구분한 계열 키 (usdkrw·usdjpy·jpykrw·dxy). 비면 기본 선택.
     * @param period {@link #PERIODS} 중 하나
     * @param mode   "index"(기준일=100, 기본) 또는 "raw"(원래 단위)
     */
    public Map<String, Object> series(String ids, String period, String mode) {
        String resolvedPeriod = PERIODS.contains(period) ? period : "1y";
        boolean indexed = !"raw".equals(mode);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("period", resolvedPeriod);
        out.put("mode", indexed ? "index" : "raw");

        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_FX_HISTORY, Datasets.MAX_AGE_DAILY, "fx_history");

        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("catalog", List.of());
            out.put("series", List.of());
            out.put("message", "환율 저장본이 없습니다. 데이터 저장소 상태에서 "
                    + "'fx_history' 수집을 먼저 실행하세요.");
            return out;
        }

        snapshot.get().putFreshness(out);
        JsonNode stored = Json.child(snapshot.get().payload(), "series");

        // 목록은 저장본이 실제로 가진 계열만 내려 줍니다. 수집에 실패한 계열을
        // 고를 수 있게 두면, 골라 놓고 빈 차트만 보게 됩니다.
        //
        // 순서는 수집기가 적어 둔 order를 따릅니다. JSONB는 키 순서를 보존하지
        // 않아, 그냥 읽으면 화면 버튼이 매번 가나다순으로 뒤집힙니다.
        List<Map<String, Object>> catalog = new ArrayList<>();
        if (stored != null) {
            stored.propertyNames().forEach(key -> {
                JsonNode entry = stored.get(key);
                Map<String, Object> meta = new LinkedHashMap<>();
                meta.put("id", key);
                meta.put("label", Json.asText(entry, "name"));
                meta.put("unit", Json.asText(entry, "unit"));
                meta.put("ticker", Json.asText(entry, "ticker"));
                meta.put("order", Json.asDouble(entry, "order"));
                catalog.add(meta);
            });
        }
        catalog.sort(Comparator.comparingDouble(
                meta -> meta.get("order") instanceof Number n ? n.doubleValue() : Double.MAX_VALUE));
        out.put("catalog", catalog);

        List<String> selected = parseIds(ids, catalog);
        out.put("selected", selected);

        LocalDate cutoff = Kst.today().minusMonths(PERIOD_MONTHS.getOrDefault(resolvedPeriod, 12));

        List<Map<String, Object>> series = new ArrayList<>();
        for (String id : selected) {
            JsonNode entry = stored == null ? null : stored.get(id);
            if (entry == null) {
                continue;
            }
            NavigableMap<LocalDate, Double> values = Json.dateValueSeries(entry, "dates", "close", cutoff);
            FxIndex.Rebased rebased = FxIndex.rebase(values);

            Map<String, Object> one = new LinkedHashMap<>();
            one.put("id", id);
            one.put("label", Json.asText(entry, "name"));
            one.put("unit", Json.asText(entry, "unit"));
            one.put("ticker", Json.asText(entry, "ticker"));
            one.put("available", !values.isEmpty());
            one.put("latest", values.isEmpty() ? null : values.lastEntry().getValue());
            one.put("latestDate", values.isEmpty() ? null : values.lastKey().toString());
            one.put("baseDate", rebased.baseDate() == null ? null : rebased.baseDate().toString());
            one.put("baseValue", rebased.baseValue());
            one.put("changePct", FxIndex.changePct(values));
            // 최신값·변화율은 전체 계열로 계산했고, 차트용 점만 1년보다 오래된 구간을 주 단위로 솎습니다.
            one.put("points", SeriesMath.thinOlderThan(pointsOf(indexed ? rebased.values() : values),
                    point -> Json.parseDate(String.valueOf(point.get("date"))), Kst.today().minusYears(1)));
            series.add(one);
        }
        out.put("series", series);

        // 단위가 여러 가지인데 원래 단위로 겹쳐 그리면 작은 쪽이 바닥에 눌립니다.
        // 막지는 않되(사용자가 고른 것입니다) 무엇이 일어나는지는 말해 줍니다.
        long unitCount = series.stream()
                .map(one -> String.valueOf(one.get("unit")))
                .distinct()
                .count();
        out.put("mixedUnits", unitCount > 1);
        out.put("available", series.stream().anyMatch(one -> Boolean.TRUE.equals(one.get("available"))));
        return out;
    }

    /** 요청한 계열 키. 알 수 없는 키는 조용히 버리고, 남는 게 없으면 기본 선택. */
    private List<String> parseIds(String ids, List<Map<String, Object>> catalog) {
        List<String> known = catalog.stream().map(meta -> String.valueOf(meta.get("id"))).toList();
        List<String> out = new ArrayList<>();
        if (ids != null && !ids.isBlank()) {
            for (String raw : Arrays.stream(ids.split(",")).map(String::trim).toList()) {
                if (known.contains(raw) && !out.contains(raw)) {
                    out.add(raw);
                }
            }
        }
        if (out.isEmpty()) {
            for (String id : DEFAULT_IDS) {
                if (known.contains(id)) {
                    out.add(id);
                }
            }
        }
        return out;
    }

    private NavigableMap<LocalDate, Double> sliceFrom(NavigableMap<LocalDate, Double> series,
                                                      LocalDate cutoff) {
        return new TreeMap<>(series.tailMap(cutoff, true));
    }

    private List<Map<String, Object>> pointsOf(NavigableMap<LocalDate, Double> series) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Map.Entry<LocalDate, Double> entry : series.entrySet()) {
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("date", entry.getKey().toString());
            point.put("value", entry.getValue());
            out.add(point);
        }
        return out;
    }
}
