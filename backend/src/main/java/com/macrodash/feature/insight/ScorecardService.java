package com.macrodash.feature.insight;

import com.macrodash.Kst;
import com.macrodash.analytics.Benchmarks;
import com.macrodash.analytics.Scorecard;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Optional;

/**
 * 종목 스코어카드 — 가격으로 잴 수 있는 것만.
 *
 * <p><b>이 카드에 없는 것을 응답이 먼저 말합니다.</b> 재무 안정성(부채비율·
 * 이자보상배율)과 성장성(매출·이익 증가율)은 여기 없습니다. 이 프로젝트가
 * 재무 데이터를 수집하지 않기 때문입니다.
 *
 * <p>그래서 이것은 <b>종합 점수가 아닙니다</b>. 부실기업도 주가만 오르면 높은
 * 점수를 받습니다. "이 회사가 좋은가"가 아니라 "이 주식이 최근 어떻게
 * 움직였나"를 재는 카드입니다. 화면은 이 문장을 그대로 띄워야 합니다.
 */
@Service
public class ScorecardService {

    /** 백분위를 재는 기준. 13F 매핑 대형주 전체입니다. */
    private static final String UNIVERSE_LABEL = "13F 매핑 대형주";

    private final StoreReader store;

    public ScorecardService(StoreReader store) {
        this.store = store;
    }

    /** 유니버스에 있는 종목 목록 (화면의 선택지). */
    public Map<String, Object> universe() {
        Optional<Snapshot> snapshot = read();
        Map<String, Object> out = new LinkedHashMap<>();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("rows", List.of());
            out.put("message", "종목 가격 저장본이 없습니다. "
                    + "데이터 저장소 상태에서 'equity_history' 수집을 먼저 실행하세요.");
            return out;
        }

        JsonNode nameMap = Json.child(snapshot.get().payload(), "nameMap");
        JsonNode tickers = Json.child(snapshot.get().payload(), "tickers");
        Map<String, Map<String, Object>> byTicker = new LinkedHashMap<>();
        if (nameMap != null) {
            nameMap.properties().forEach(entry -> {
                String ticker = Json.asText(entry.getValue(), "ticker");
                if (ticker == null || tickers == null || tickers.get(ticker) == null) {
                    return;
                }
                // 같은 티커에 이름이 여러 개면 먼저 나온 것을 씁니다.
                byTicker.computeIfAbsent(ticker, key -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("ticker", key);
                    row.put("name", entry.getKey());
                    row.put("sector", Json.asText(entry.getValue(), "sector"));
                    return row;
                });
            });
        }

        List<Map<String, Object>> rows = new ArrayList<>(byTicker.values());
        rows.sort(Comparator.comparing(row -> String.valueOf(row.get("ticker"))));
        out.put("available", !rows.isEmpty());
        out.put("rows", rows);
        out.put("universeLabel", UNIVERSE_LABEL);
        snapshot.get().putFreshness(out);
        return out;
    }

    /**
     * 종목 한 개의 스코어카드.
     *
     * @param symbol    야후 티커 (예: AAPL)
     * @param benchmark 베타 기준 (기본 SPY)
     * @param years     측정 구간
     */
    public Map<String, Object> scorecard(String symbol, String benchmark, int years) {
        Map<String, Object> out = new LinkedHashMap<>();
        String benchmarkTicker = Benchmarks.resolve(benchmark);
        int window = Math.max(1, Math.min(5, years));
        out.put("symbol", symbol);
        out.put("benchmark", benchmarkTicker);
        out.put("years", window);
        out.put("universeLabel", UNIVERSE_LABEL);
        // 빠진 것을 응답이 먼저 말합니다. 화면이 잊어도 API 사용자는 봅니다.
        out.put("missing", List.of(
                "재무 안정성 (부채비율·이자보상배율)",
                "성장성 (매출·이익 증가율)",
                "밸류에이션 (PER·PBR·배당수익률)"));
        out.put("caveat", "가격으로 잴 수 있는 것만 담은 카드입니다. 종합 점수가 "
                + "아니며, 재무가 부실한 회사도 주가가 오르면 높은 점수를 받습니다.");

        Optional<Snapshot> snapshot = read();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("message", "종목 가격 저장본이 없습니다. "
                    + "데이터 저장소 상태에서 'equity_history' 수집을 먼저 실행하세요.");
            return out;
        }
        snapshot.get().putFreshness(out);

        JsonNode payload = snapshot.get().payload();
        JsonNode tickers = Json.child(payload, "tickers");
        JsonNode nameMap = Json.child(payload, "nameMap");
        if (tickers == null || tickers.get(symbol) == null) {
            out.put("available", false);
            out.put("message", "유니버스에 없는 종목입니다: " + symbol
                    + ". 매핑표(collector/app/equities.py)에 추가하면 분석할 수 있습니다.");
            return out;
        }

        // 측정 구간(변동성·낙폭·베타)은 cutoff부터, '최근 n거래일' 지표(모멘텀·추세)는 잘리지 않은 저장본 전체로 잽니다.
        // 1년 구간으로 먼저 자르면 252거래일 전 값이 남지 않아 12개월 모멘텀이 늘 비었습니다(QA-088).
        LocalDate cutoff = Kst.today().minusYears(window);
        NavigableMap<LocalDate, Double> history = Json.dateValueSeries(tickers.get(symbol), "dates", "close", null);
        NavigableMap<LocalDate, Double> series = history.tailMap(cutoff, true);
        NavigableMap<LocalDate, Double> benchmarkSeries =
                Json.dateValueSeries(tickers.get(benchmarkTicker), "dates", "close", cutoff);

        Scorecard.Raw raw = Scorecard.measure(history, series, benchmarkSeries);
        if (raw.samples() == null || raw.samples() < 30) {
            out.put("available", false);
            out.put("message", "가격 표본이 부족합니다(30 거래일 미만).");
            return out;
        }

        // ── 유니버스 전체를 같은 방식으로 재서 백분위 기준을 만듭니다 ──
        //
        // 절대 기준("변동성 30% 이하면 80점")을 쓰지 않는 이유는 그 기준선이
        // 어디서 왔는지 설명할 수 없기 때문입니다. 비교 대상을 화면에 적으면
        // 점수의 뜻이 분명해집니다.
        List<Double> uMomentum12m = new ArrayList<>();
        List<Double> uMomentum3m = new ArrayList<>();
        List<Double> uVolatility = new ArrayList<>();
        List<Double> uDrawdown = new ArrayList<>();
        List<Double> uTrend = new ArrayList<>();
        tickers.propertyNames().forEach(ticker -> {
            NavigableMap<LocalDate, Double> other = Json.dateValueSeries(tickers.get(ticker), "dates", "close", null);
            Scorecard.Raw one = Scorecard.measure(other, other.tailMap(cutoff, true), null);
            if (one.momentum12m() != null) {
                uMomentum12m.add(one.momentum12m());
            }
            if (one.momentum3m() != null) {
                uMomentum3m.add(one.momentum3m());
            }
            if (one.volatility() != null) {
                uVolatility.add(one.volatility());
            }
            if (one.maxDrawdown() != null) {
                uDrawdown.add(one.maxDrawdown());
            }
            if (one.trendPosition() != null) {
                uTrend.add(one.trendPosition());
            }
        });

        List<Map<String, Object>> metrics = new ArrayList<>();
        metrics.add(metric("12개월 모멘텀", "최근 252 거래일 수익률", raw.momentum12m(), "%",
                Scorecard.percentileScore(raw.momentum12m(), uMomentum12m, true),
                "높을수록 상위"));
        metrics.add(metric("3개월 모멘텀", "최근 63 거래일 수익률", raw.momentum3m(), "%",
                Scorecard.percentileScore(raw.momentum3m(), uMomentum3m, true),
                "높을수록 상위"));
        metrics.add(metric("변동성 (연율)", "일별 수익률 표준편차 × √252", raw.volatility(), "%",
                Scorecard.percentileScore(raw.volatility(), uVolatility, false),
                "낮을수록 상위"));
        metrics.add(metric("최대낙폭", "구간 내 고점 대비 최대 하락", raw.maxDrawdown(), "%",
                Scorecard.percentileScore(raw.maxDrawdown(), uDrawdown, false),
                "낮을수록 상위"));
        metrics.add(metric("추세 위치", "200일 이동평균 대비 종가 위치", raw.trendPosition(), "%",
                Scorecard.percentileScore(raw.trendPosition(), uTrend, true),
                "높을수록 상위"));
        out.put("metrics", metrics);

        // 평균 점수. 재는 항목이 5개뿐이므로 "종합"이라 부르지 않습니다.
        List<Double> scores = metrics.stream()
                .map(row -> (Double) row.get("score"))
                .filter(java.util.Objects::nonNull)
                .toList();
        out.put("priceScore", scores.isEmpty() ? null
                : scores.stream().mapToDouble(Double::doubleValue).average().orElse(0.0));
        out.put("scoredCount", scores.size());

        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("momentum1m", raw.momentum1m());
        extra.put("momentum6m", raw.momentum6m());
        extra.put("beta", raw.beta());
        extra.put("samples", raw.samples());
        out.put("raw", extra);

        String name = null;
        String sector = null;
        if (nameMap != null) {
            for (var entry : nameMap.properties()) {
                if (symbol.equals(Json.asText(entry.getValue(), "ticker"))) {
                    name = entry.getKey();
                    sector = Json.asText(entry.getValue(), "sector");
                    break;
                }
            }
        }
        out.put("name", name);
        out.put("sector", sector);
        out.put("universeSize", uVolatility.size());
        out.put("available", true);
        return out;
    }

    private Map<String, Object> metric(String label, String how, Double value, String unit,
                                       Double score, String direction) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("label", label);
        row.put("how", how);
        row.put("value", value);
        row.put("unit", unit);
        // 점수는 원자료와 **함께** 냅니다. 점수만 보여 주면 검증할 수 없습니다.
        row.put("score", score);
        row.put("direction", direction);
        return row;
    }

    private Optional<Snapshot> read() {
        return store.read(Datasets.SNAP_EQUITY_HISTORY, Datasets.MAX_AGE_DAILY, "equity_history");
    }
}
