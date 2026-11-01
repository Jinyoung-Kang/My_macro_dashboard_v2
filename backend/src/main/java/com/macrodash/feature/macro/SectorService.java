package com.macrodash.feature.macro;

import com.macrodash.Kst;
import com.macrodash.analytics.SeriesMath;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 섹터 & 자산군 로테이션.
 *
 * <p>수집기가 적재한 ETF 종가에서 기간별 수익률 매트릭스와 모멘텀 순위를
 * 계산합니다.
 *
 * <p><b>표본이 부족하면 0.0이 아니라 null입니다.</b> 화면에서 "0.00%"는
 * '데이터 없음'이 아니라 '보합'으로 읽힙니다. 구버전은 신규 상장 ETF의 1년
 * 수익률을 0.00%로 채워 순위 계산에까지 섞어 넣었습니다.
 */
@Service
public class SectorService {

    /** 거래일 기준 기간 정의. */
    private static final Map<String, Integer> WINDOWS = Map.of(
            "1W", 5, "1M", 21, "3M", 63, "6M", 126, "1Y", 252);

    private static final List<String> PERIOD_ORDER =
            List.of("1W", "1M", "3M", "6M", "YTD", "1Y");

    public static final Map<String, Map<String, String>> SECTOR_ETFS = sectorEtfs();
    public static final Map<String, Map<String, String>> ASSET_CLASS_ETFS = assetClassEtfs();

    private static final String BENCHMARK = "SPY";

    private final StoreReader store;

    public SectorService(StoreReader store) {
        this.store = store;
    }

    public Map<String, Object> rotation(String period) {
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_SECTOR_HISTORY, Datasets.MAX_AGE_DAILY, "sector_history");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("periods", PERIOD_ORDER);
        out.put("period", PERIOD_ORDER.contains(period) ? period : "1M");

        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("sectors", List.of());
            out.put("assetClasses", List.of());
            out.put("message", "섹터 종가 저장본이 없습니다. 수집기를 실행하세요.");
            return out;
        }

        JsonNode tickers = Json.child(snapshot.get().payload(), "tickers");
        out.put("available", tickers != null && tickers.size() > 0);
        snapshot.get().putFreshness(out);
        out.put("stale", !snapshot.get().isFresh(Datasets.MAX_AGE_DAILY));

        List<Map<String, Object>> sectors = buildRows(tickers, SECTOR_ETFS, "type");
        List<Map<String, Object>> assets = buildRows(tickers, ASSET_CLASS_ETFS, "category");

        // 벤치마크 대비 초과성과(alpha)는 섹터에만 의미가 있습니다.
        Map<String, Double> benchmark = returnsFor(tickers, BENCHMARK);
        for (Map<String, Object> row : sectors) {
            Map<String, Double> alpha = new LinkedHashMap<>();
            for (String window : PERIOD_ORDER) {
                Double own = (Double) ((Map<?, ?>) row.get("returns")).get(window);
                Double base = benchmark.get(window);
                alpha.put(window, SeriesMath.difference(own, base));
            }
            row.put("alpha", alpha);
        }

        rank(sectors, (String) out.get("period"));
        rank(assets, (String) out.get("period"));

        out.put("benchmark", BENCHMARK);
        out.put("benchmarkReturns", benchmark);
        out.put("sectors", sectors);
        out.put("assetClasses", assets);
        return out;
    }

    /** 모멘텀 순위 (1주/1개월/3개월) — 섹터와 자산군을 각각 독립적으로 매깁니다. */
    public Map<String, Object> momentum() {
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_SECTOR_HISTORY, Datasets.MAX_AGE_DAILY, "sector_history");

        Map<String, Object> out = new LinkedHashMap<>();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("sectors", List.of());
            out.put("assetClasses", List.of());
            return out;
        }

        JsonNode tickers = Json.child(snapshot.get().payload(), "tickers");
        List<Map<String, Object>> sectors = buildRows(tickers, SECTOR_ETFS, "type");
        List<Map<String, Object>> assets = buildRows(tickers, ASSET_CLASS_ETFS, "category");

        for (String window : List.of("1W", "1M", "3M")) {
            rank(sectors, window);
            rank(assets, window);
        }

        out.put("available", true);
        out.put("sectors", sectors);
        out.put("assetClasses", assets);
        return out;
    }

    private List<Map<String, Object>> buildRows(JsonNode tickers,
                                                Map<String, Map<String, String>> universe,
                                                String kindField) {
        List<Map<String, Object>> rows = new ArrayList<>();
        if (tickers == null) {
            return rows;
        }

        for (Map.Entry<String, Map<String, String>> entry : universe.entrySet()) {
            String symbol = entry.getKey();
            JsonNode series = tickers.get(symbol);
            if (series == null) {
                continue;
            }

            List<Double> closes = alignedSeries(series, "close").closes();
            if (closes.size() < 20) {
                // 표본이 20일도 안 되면 어떤 기간 수익률도 신뢰할 수 없습니다.
                continue;
            }

            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", symbol);
            row.put("name", entry.getValue().get("name"));
            row.put("kind", entry.getValue().get(kindField));
            row.put("price", SeriesMath.last(closes));
            row.put("returns", returnsFrom(series));
            // 수집 실패로 직전 저장본에서 이어받은 계열(최대 3일, QA-056)은 수익률이 그만큼 멈춰 있습니다 — 순위표에
            // 표시 없이 섞지 않게 알립니다(QA-065).
            row.put("isStale", Json.asBoolean(series, "isStale"));
            row.put("staleReason", Json.asText(series, "staleReason"));
            rows.add(row);
        }
        return rows;
    }

    private Map<String, Double> returnsFor(JsonNode tickers, String symbol) {
        if (tickers == null || tickers.get(symbol) == null) {
            return new LinkedHashMap<>();
        }
        return returnsFrom(tickers.get(symbol));
    }

    private Map<String, Double> returnsFrom(JsonNode series) {
        Series aligned = alignedSeries(series, "close");
        List<Double> closes = aligned.closes();
        List<LocalDate> dates = aligned.dates();

        Map<String, Double> returns = new LinkedHashMap<>();
        for (String window : List.of("1W", "1M", "3M", "6M", "1Y")) {
            returns.put(window, SeriesMath.periodReturn(closes, WINDOWS.get(window)));
        }
        returns.put("YTD", SeriesMath.yearToDateReturn(dates, closes, Kst.today().getYear()));
        return returns;
    }

    /** 해당 기간 수익률 기준 내림차순 순위. 값이 없는 종목은 순위에서 제외합니다. */
    private void rank(List<Map<String, Object>> rows, String window) {
        List<Map<String, Object>> sortable = rows.stream()
                .filter(row -> value(row, window) != null)
                .sorted(Comparator.comparingDouble((Map<String, Object> row) -> value(row, window))
                        .reversed())
                .toList();

        for (int i = 0; i < sortable.size(); i++) {
            @SuppressWarnings("unchecked")
            Map<String, Object> ranks = (Map<String, Object>) sortable.get(i)
                    .computeIfAbsent("ranks", key -> new LinkedHashMap<String, Object>());
            ranks.put(window, i + 1);
        }
    }

    private Double value(Map<String, Object> row, String window) {
        Object returns = row.get("returns");
        if (!(returns instanceof Map<?, ?> map)) {
            return null;
        }
        Object value = map.get(window);
        return value instanceof Double d ? d : null;
    }

    /**
     * 날짜와 종가를 <b>짝지어</b> 읽습니다.
     *
     * <p>둘을 따로 걸러 내면 안 됩니다. 종가 한 칸이 null이라 그 칸만 빠지면
     * 이후의 모든 날짜가 한 칸씩 밀려, "21 거래일 전"이 실제로는 22일 전이
     * 됩니다. 값도 예외도 없이 조용히 틀린 수익률이 나옵니다.
     *
     * @param series {"dates": [...], "close": [...]} 형태의 저장본 조각
     * @param field  값 배열의 이름 (보통 "close")
     * @return 같은 길이의 (날짜, 값) 목록. 한쪽이라도 비면 그 칸은 통째로 버립니다.
     */
    private Series alignedSeries(JsonNode series, String field) {
        var aligned = Json.dateValueSeries(series, "dates", field, null);
        return new Series(new ArrayList<>(aligned.keySet()), new ArrayList<>(aligned.values()));
    }

    /** 길이가 같음이 보장된 (날짜, 종가) 한 쌍. */
    private record Series(List<LocalDate> dates, List<Double> closes) {
    }

    private static Map<String, Map<String, String>> sectorEtfs() {
        Map<String, Map<String, String>> map = new LinkedHashMap<>();
        map.put("XLK", Map.of("name", "정보기술 (Technology)", "type", "공격 / 성장"));
        map.put("XLC", Map.of("name", "통신서비스 (Communication)", "type", "공격 / 성장"));
        map.put("XLY", Map.of("name", "임의소비재 (Consumer Discretionary)", "type", "경기민감 / 성장"));
        map.put("XLI", Map.of("name", "산업재 (Industrials)", "type", "경기민감 / 가치"));
        map.put("XLF", Map.of("name", "금융 (Financials)", "type", "경기민감 / 가치"));
        map.put("XLB", Map.of("name", "소재 (Materials)", "type", "경기민감 / 원자재"));
        map.put("XLE", Map.of("name", "에너지 (Energy)", "type", "경기민감 / 원자재"));
        map.put("XLV", Map.of("name", "헬스케어 (Health Care)", "type", "방어주"));
        map.put("XLP", Map.of("name", "필수소비재 (Consumer Staples)", "type", "방어주"));
        map.put("XLU", Map.of("name", "유틸리티 (Utilities)", "type", "방어주 / 배당"));
        map.put("XLRE", Map.of("name", "부동산 (Real Estate)", "type", "방어주 / 금리민감"));
        // Map.copyOf는 JVM마다 반복 순서가 달라집니다. 정해 둔 순서를 지키려고 LinkedHashMap을 그대로 감쌉니다.
        return Collections.unmodifiableMap(map);
    }

    private static Map<String, Map<String, String>> assetClassEtfs() {
        Map<String, Map<String, String>> map = new LinkedHashMap<>();
        map.put("SPY", Map.of("name", "미국 대형주 (S&P 500)", "category", "주식"));
        map.put("QQQ", Map.of("name", "미국 기술주 (Nasdaq 100)", "category", "주식"));
        map.put("IWM", Map.of("name", "미국 중소형주 (Russell 2000)", "category", "주식"));
        map.put("EEM", Map.of("name", "신흥국 주식 (Emerging Markets)", "category", "주식"));
        map.put("TLT", Map.of("name", "미국 20년+ 장기국채", "category", "채권"));
        map.put("IEF", Map.of("name", "미국 7-10년 중기국채", "category", "채권"));
        map.put("SHY", Map.of("name", "미국 1-3년 단기국채", "category", "채권"));
        map.put("GLD", Map.of("name", "금 (Gold)", "category", "원자재"));
        map.put("USO", Map.of("name", "원유 (WTI Crude Oil)", "category", "원자재"));
        map.put("DBA", Map.of("name", "농산물 (Agriculture)", "category", "원자재"));
        map.put("UUP", Map.of("name", "미국 달러 인덱스 ETF", "category", "통화"));
        // Map.copyOf는 JVM마다 반복 순서가 달라집니다. 정해 둔 순서를 지키려고 LinkedHashMap을 그대로 감쌉니다.
        return Collections.unmodifiableMap(map);
    }
}
