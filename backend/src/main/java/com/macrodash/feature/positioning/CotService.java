package com.macrodash.feature.positioning;

import com.macrodash.Kst;
import com.macrodash.analytics.CotExtremes;
import com.macrodash.analytics.ForwardReturns;
import com.macrodash.analytics.SeriesMath;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Optional;

/**
 * 글로벌 투기세력 (CFTC COT).
 *
 * <p>비상업(투기·스마트머니) / 상업(헤저) / 비보고(소액) 순포지션을 자산별로
 * 보여 줍니다. CFTC는 <b>주 1회(화요일 기준, 금요일 발표)</b>라 항상 며칠 지난
 * 데이터입니다. 그 지연 일수를 함께 표시해야 오해가 없습니다.
 */
@Service
public class CotService {

    /** 자산별 계약 코드 (수집기 indicators.COT_ASSETS와 같아야 합니다). */
    public static final Map<String, Map<String, String>> ASSETS = assets();
    private static final int WEEKS = 3 * 52 + 10;

    /**
     * 백분위를 계산할 과거 구간(주). 기본 1년.
     *
     * <p><b>왜 3년이 아닌가</b> — 화면의 "3년 표본 백분위"와 같은 156주를 쓰면,
     * 저장본이 166주뿐이라 판정할 수 있는 시점이 10주밖에 남지 않습니다. 표본
     * 10개짜리 백테스트는 아무것도 말해 주지 못합니다. 52주로 잡으면 약 110개
     * 시점을 평가할 수 있습니다. 화면은 이 기준을 반드시 함께 표시합니다.
     */
    private static final int DEFAULT_LOOKBACK_WEEKS = 52;

    /**
     * 자산별 가격 대용 ETF.
     *
     * <p>COT 공시에는 <b>가격이 없습니다</b>. 극단 포지션 이후 수익률을 세려면
     * 가격 시계열이 필요한데, 이미 매일 수집하는 섹터 ETF 종가를 대용으로 씁니다.
     *
     * <p>주의: 대용입니다. USO는 WTI 선물 그 자체가 아니라 롤오버 비용이 반영된
     * ETF이고, UUP도 달러 인덱스와 추적 오차가 있습니다. 화면은 이 사실을 반드시
     * 함께 표시해야 합니다.
     */
    private static final Map<String, String> PRICE_PROXY = Map.of(
            "S&P 500 E-Mini", "SPY",
            "NASDAQ 100 E-Mini", "QQQ",
            "미국 국채 10년물", "IEF",
            "달러 인덱스", "UUP",
            "WTI 원유", "USO",
            "금", "GLD");

    private static final Map<String, String> PROXY_LABEL = Map.of(
            "SPY", "SPDR S&P 500 ETF",
            "QQQ", "Invesco QQQ (나스닥 100)",
            "IEF", "iShares 7-10년 미 국채 ETF",
            "UUP", "Invesco 달러 인덱스 ETF",
            "USO", "United States Oil Fund (WTI)",
            "GLD", "SPDR Gold Shares");

    private final StoreReader store;

    public CotService(StoreReader store) {
        this.store = store;
    }

    public Map<String, Object> assetList() {
        List<Map<String, String>> list = new ArrayList<>();
        ASSETS.forEach((name, info) -> {
            Map<String, String> entry = new LinkedHashMap<>(info);
            entry.put("name", name);
            list.add(entry);
        });
        return Map.of("assets", list);
    }

    /** 자산 1종의 시계열 + 요약. */
    public Map<String, Object> asset(String assetName) {
        Map<String, String> info = ASSETS.get(assetName);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("asset", assetName);

        if (info == null) {
            out.put("available", false);
            out.put("message", "알 수 없는 자산입니다: " + assetName);
            return out;
        }
        out.put("code", info.get("code"));
        out.put("category", info.get("category"));

        Optional<Snapshot> snapshot = store.read(
                Datasets.cotContract(info.get("code"), WEEKS),
                Datasets.MAX_AGE_SLOW, "cot_history");

        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("rows", List.of());
            out.put("message", "COT 저장본이 없습니다. 수집기를 실행하세요.");
            return out;
        }

        List<JsonNode> rows = Json.array(snapshot.get().payload(), "rows");
        out.put("available", !rows.isEmpty());
        snapshot.get().putFreshness(out);
        out.put("rows", rows);
        out.put("summary", summarize(assetName, rows));
        return out;
    }

    /**
     * 극단 포지션 이후 무슨 일이 있었나 (백테스트).
     *
     * <p>"3년 백분위 96%"가 역사적 극단이라는 것은 알려 주지만, <b>그래서 어땠는지</b>는
     * 말해 주지 않았습니다. 과거에 같은 극단이 나왔던 주를 모두 찾아 이후 4주·13주
     * 수익률을 세고, <b>아무 때나 들어갔을 때</b>와 나란히 놓습니다.
     *
     * @param assetName 자산 이름 ({@link #ASSETS}의 키)
     * @param percentile 극단으로 볼 백분위 (예: 95 → 상위 95% 이상, 하위 5% 이하)
     */
    /** 백분위 구간 상한(주). 10년이면 충분하고, 더 크면 lookback + 8이 int를 넘쳐 표본 검사가 무력화됩니다. */
    static final int MAX_LOOKBACK_WEEKS = 520;

    /** URL 파라미터를 8~{@value #MAX_LOOKBACK_WEEKS}주로 접습니다. 0 이하는 기본값. */
    static int effectiveLookback(int lookbackWeeks) {
        int wanted = lookbackWeeks > 0 ? lookbackWeeks : DEFAULT_LOOKBACK_WEEKS;
        return Params.clamp(wanted, 8, MAX_LOOKBACK_WEEKS);
    }

    public Map<String, Object> extremes(String assetName, double percentile, int lookbackWeeks) {
        if (Double.isNaN(percentile) || Double.isInfinite(percentile)) {
            throw new InvalidRequestException("percentile은 숫자여야 합니다: " + Params.echo(percentile));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, String> info = ASSETS.get(assetName);
        int lookback = effectiveLookback(lookbackWeeks);
        out.put("asset", assetName);
        out.put("percentile", percentile);
        out.put("horizons", List.of(4, 13));

        if (info == null) {
            out.put("available", false);
            out.put("message", "알 수 없는 자산입니다: " + assetName);
            return out;
        }

        String proxy = PRICE_PROXY.get(assetName);
        out.put("priceProxy", proxy);
        out.put("priceProxyLabel", proxy == null ? null : PROXY_LABEL.get(proxy));
        out.put("proxyNotice", "COT 공시에는 가격이 없어 ETF 종가를 대용으로 씁니다. "
                + "선물 실물과는 롤오버·추적 오차만큼 다릅니다 — 방향과 분포를 보는 용도입니다. "
                + "수익률은 공시(금요일) 다음 거래일 종가에서 출발합니다 — 기준일(화요일)에는 아직 알 수 없던 신호입니다.");

        Optional<Snapshot> snapshot = store.read(
                Datasets.cotContract(info.get("code"), WEEKS),
                Datasets.MAX_AGE_SLOW, "cot_history");
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("message", "이 자산의 COT 주간 저장본이 없습니다. "
                    + "데이터 저장소 상태에서 cot_history를 실행하세요.");
            return out;
        }

        List<LocalDate> dates = new ArrayList<>();
        List<Double> net = new ArrayList<>();
        for (JsonNode row : Json.array(snapshot.get().payload(), "rows")) {
            LocalDate date = Json.parseDate(Json.asText(row, "date"));
            Double value = Json.asDouble(row, "ncNet");
            if (date != null && value != null) {
                dates.add(date);
                net.add(value);
            }
        }

        var prices = proxy == null ? new java.util.TreeMap<LocalDate, Double>() : proxyCloses(proxy);

        if (prices.isEmpty()) {
            out.put("available", false);
            out.put("message", "가격 대용 ETF(%s) 종가 저장본이 없습니다. "
                    .formatted(proxy == null ? "미지정" : proxy)
                    + "데이터 저장소 상태에서 sector_history를 실행하세요.");
            return out;
        }
        if (dates.size() < lookback + 8) {
            out.put("available", false);
            out.put("message", ("주간 표본이 %d건뿐입니다. 백분위를 %d주 과거 구간으로 계산하므로 "
                    + "판정할 수 있는 시점이 거의 없습니다 — 더 짧은 구간을 고르거나 "
                    + "cot_history를 더 모은 뒤 다시 보세요.").formatted(dates.size(), lookback));
            return out;
        }

        double upper = Math.min(99.9, Math.max(50.1, percentile));
        double lower = 100.0 - upper;
        List<CotExtremes.Event> events =
                CotExtremes.findEvents(dates, net, prices, lookback, upper, lower, 4, 13);

        out.put("available", true);
        snapshot.get().putFreshness(out);
        out.put("lookbackWeeks", lookback);
        out.put("priceFrom", prices.firstKey().toString());
        out.put("priceTo", prices.lastKey().toString());
        out.put("sides", List.of(
                sideSummary("극단 롱", "비상업 순포지션이 과거 %d주 중 상위 %.0f%% 이상"
                        .formatted(lookback, upper), events, dates, prices),
                sideSummary("극단 숏", "비상업 순포지션이 과거 %d주 중 하위 %.0f%% 이하"
                        .formatted(lookback, lower), events, dates, prices)));

        // 최근 신호 12건만 목록으로 (전체를 내려보내면 화면이 읽히지 않습니다).
        List<Map<String, Object>> recent = new ArrayList<>();
        for (int i = events.size() - 1; i >= 0 && recent.size() < 12; i--) {
            CotExtremes.Event event = events.get(i);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("date", event.date().toString());
            entry.put("side", event.side());
            entry.put("net", event.net());
            entry.put("percentile", event.percentile());
            entry.put("return4w", event.forwardReturns().get("4w"));
            entry.put("return13w", event.forwardReturns().get("13w"));
            recent.add(entry);
        }
        out.put("recentEvents", recent);
        return out;
    }

    /** 한쪽(극단 롱/숏)의 성적과 비교 기준. */
    private Map<String, Object> sideSummary(String side, String rule,
                                            List<CotExtremes.Event> events,
                                            List<LocalDate> allDates,
                                            java.util.NavigableMap<LocalDate, Double> prices) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("side", side);
        out.put("rule", rule);

        for (int weeks : new int[]{4, 13}) {
            List<Double> returns = events.stream()
                    .filter(event -> side.equals(event.side()))
                    .map(event -> event.forwardReturns().get(weeks + "w"))
                    .toList();
            out.put("h" + weeks, summaryMap(ForwardReturns.summarize(returns)));
            out.put("baseline" + weeks, summaryMap(CotExtremes.baseline(allDates, prices, weeks)));
        }
        return out;
    }

    private Map<String, Object> summaryMap(ForwardReturns.Summary summary) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("count", summary.count());
        out.put("mean", summary.mean());
        out.put("median", summary.median());
        out.put("winRate", summary.winRate());
        out.put("best", summary.best());
        out.put("worst", summary.worst());
        return out;
    }

    /** 전체 자산 요약 (AI 리포트·개요용). */
    public Map<String, Object> overview() {
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_COT_HISTORY, Datasets.MAX_AGE_SLOW, "cot_history");

        Map<String, Object> out = new LinkedHashMap<>();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("assets", List.of());
            return out;
        }

        JsonNode assets = Json.child(snapshot.get().payload(), "assets");
        List<Map<String, Object>> summaries = new ArrayList<>();

        if (assets != null) {
            assets.properties().forEach(entry -> {
                List<JsonNode> rows = Json.array(entry.getValue(), "rows");
                Map<String, Object> summary = summarize(entry.getKey(), rows);
                summary.put("error", Json.asText(entry.getValue(), "error"));
                summary.put("category", Json.asText(entry.getValue(), "category"));
                summaries.add(summary);
            });
        }

        out.put("available", !summaries.isEmpty());
        snapshot.get().putFreshness(out);
        out.put("assets", summaries);
        return out;
    }

    /**
     * 자산 1종 요약: 최신 순포지션, 1/4/13주 변화, 3년 표본 내 백분위, 공시 지연 일수.
     */
    Map<String, Object> summarize(String assetName, List<JsonNode> rows) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("asset", assetName);

        if (rows == null || rows.isEmpty()) {
            out.put("available", false);
            return out;
        }

        JsonNode latest = rows.get(rows.size() - 1);
        List<Double> ncNet = new ArrayList<>();
        for (JsonNode row : rows) {
            Double value = Json.asDouble(row, "ncNet");
            if (value != null) {
                ncNet.add(value);
            }
        }

        out.put("available", true);
        out.put("date", Json.asText(latest, "date"));
        out.put("ncNet", Json.asDouble(latest, "ncNet"));
        out.put("commNet", Json.asDouble(latest, "commNet"));
        out.put("nrNet", Json.asDouble(latest, "nrNet"));
        out.put("change1w", changeOver(rows, 1));
        out.put("change4w", changeOver(rows, 4));
        out.put("change13w", changeOver(rows, 13));
        // 백분위는 마지막 원소를 '현재'로 봅니다. 최신 주를 모르면(null — 건너뛰고 모은 목록의 끝은 직전 주) 백분위도 모름입니다(QA-061).
        out.put("percentile", Json.asDouble(latest, "ncNet") == null ? null : SeriesMath.percentile(ncNet));

        LocalDate reportDate = Json.parseDate(Json.asText(latest, "date"));
        out.put("ageDays", reportDate == null
                ? null : ChronoUnit.DAYS.between(reportDate, Kst.today()));
        return out;
    }

    private Double changeOver(List<JsonNode> rows, int weeks) {
        if (rows.size() <= weeks) {
            return null;
        }
        Double current = Json.asDouble(rows.get(rows.size() - 1), "ncNet");
        Double past = Json.asDouble(rows.get(rows.size() - 1 - weeks), "ncNet");
        return SeriesMath.difference(current, past);
    }

    private static Map<String, Map<String, String>> assets() {
        Map<String, Map<String, String>> map = new LinkedHashMap<>();
        map.put("S&P 500 E-Mini", Map.of("code", "13874A", "category", "주식"));
        map.put("NASDAQ 100 E-Mini", Map.of("code", "209742", "category", "주식"));
        map.put("미국 국채 10년물", Map.of("code", "043602", "category", "채권"));
        map.put("달러 인덱스", Map.of("code", "098662", "category", "통화"));
        map.put("WTI 원유", Map.of("code", "067651", "category", "원자재"));
        map.put("금", Map.of("code", "088691", "category", "원자재"));
        // Map.copyOf는 JVM마다 반복 순서가 달라집니다. 정해 둔 순서를 지키려고 LinkedHashMap을 그대로 감쌉니다.
        return Collections.unmodifiableMap(map);
    }

    /** 가격 대용 ETF 종가 — 섹터 화면이 쓰는 저장본에서 한 종목만. */
    private NavigableMap<LocalDate, Double> proxyCloses(String symbol) {
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_SECTOR_HISTORY, Datasets.MAX_AGE_DAILY, "sector_history");
        JsonNode tickers = snapshot.filter(s -> s.payload() != null)
                .map(s -> Json.child(s.payload(), "tickers")).orElse(null);
        return Json.dateValueSeries(tickers == null ? null : tickers.get(symbol), "dates", "close", null);
    }
}
