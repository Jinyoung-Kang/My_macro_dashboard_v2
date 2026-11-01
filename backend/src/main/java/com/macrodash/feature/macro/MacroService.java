package com.macrodash.feature.macro;

import com.macrodash.Kst;
import com.macrodash.analytics.AdvancedIndicators;
import com.macrodash.analytics.SeriesMath;
import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import com.macrodash.support.SecretRedactor;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.NavigableMap;
import java.util.Map;
import java.util.Optional;

/**
 * 거시경제 매크로 지표 메뉴.
 *
 * <p>담당: 지표 카드, 10Y−2Y / 30Y−2Y 장단기 금리차, 신용·변동성 리스크 지표,
 * 심화 매크로 지표 6종, 개별 지표 차트.
 *
 * <p>계산은 전부 여기서 합니다. 구버전은 화면 코드(views/macro_view.py)가 직접
 * 계산해서, 같은 수치를 AI 리포트가 다르게 말하는 일이 있었습니다.
 */
@Service
public class MacroService {

    private final StoreReader store;
    private final CollectorClient collector;

    public MacroService(StoreReader store, CollectorClient collector) {
        this.store = store;
        this.collector = collector;
    }

    /** 매크로 카드 + 스프레드 + 신선도. */
    public Map<String, Object> overview() {
        return overview(false);
    }

    /**
     * 매크로 카드 + 스프레드 + 신선도.
     *
     * @param live 화면이 자동 갱신을 켠 상태면 true. 저장본을 "오래됐다"고 볼
     *             기준이 15분에서 60초로 내려가, 백엔드가 그만큼 자주 수집을
     *             요청합니다. 60초보다 더 줄이지 않는 이유는
     *             {@link Datasets#MAX_AGE_LIVE}에 적어 두었습니다.
     *             <p>이때도 <b>화면은 수집을 기다리지 않습니다</b>(규칙 4-6).
     *             저장본을 곧바로 돌려주고 수집은 뒤에서 돕니다.
     */
    public Map<String, Object> overview(boolean live) {
        long maxAge = live ? Datasets.MAX_AGE_LIVE : Datasets.MAX_AGE_REALTIME;
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_MACRO_COLLECTED, maxAge, "macro_collected");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("readMode", store.readMode().name().toLowerCase());

        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("message", "매크로 데이터 저장본이 없습니다. 수집기를 실행하세요.");
            out.put("categories", List.of());
            return out;
        }

        Snapshot snap = snapshot.get();
        JsonNode payload = snap.payload();

        out.put("available", true);
        out.put("collectedAt", snap.collectedAt());
        snap.putFreshness(out);
        // stale 배지는 자동 갱신 간격과 무관하게 **15분** 기준을 그대로 씁니다.
        // 사용자가 10초를 골랐다고 50초 된 저장본이 "오래된 저장본"이 되면,
        // 배지가 데이터 품질이 아니라 화면 설정을 말하게 됩니다.
        out.put("stale", !snap.isFresh(Datasets.MAX_AGE_REALTIME));
        out.put("categories", payload.get("categories"));
        out.put("rates", payload.get("rates"));
        out.put("spreads", spreads(payload));
        return out;
    }

    /**
     * 장단기 금리차.
     *
     * <p>두 종류를 함께 보여 줍니다.
     * <ul>
     *   <li><b>실시간</b> — 카드에 쓰인 TradingView 참고 수익률의 차이</li>
     *   <li><b>공식 일별</b> — FRED DGS2/DGS10/DGS30 확정치의 차이 (추이 차트용)</li>
     * </ul>
     * 어느 한쪽이 없으면 0으로 메우지 않고 null로 둡니다.
     */
    private Map<String, Object> spreads(JsonNode payload) {
        JsonNode rates = Json.child(payload, "rates");
        Map<String, Object> out = new LinkedHashMap<>();

        Double us02 = rates == null ? null : Json.asDouble(Json.child(rates, "us02y"), "current");
        Double us10 = rates == null ? null : Json.asDouble(Json.child(rates, "us10y"), "current");
        Double us02Prev = rates == null ? null : Json.asDouble(Json.child(rates, "us02y"), "previous");
        Double us10Prev = rates == null ? null : Json.asDouble(Json.child(rates, "us10y"), "previous");

        Double us30 = rates == null ? null : Json.asDouble(Json.child(rates, "us30y"), "current");
        Double us30Prev = rates == null ? null : Json.asDouble(Json.child(rates, "us30y"), "previous");

        // 수집 실패로 이어받은 금리(isStale)로 계산한 스프레드는 '지금 시장'이 아닙니다 — 표시를 함께 내립니다(QA-060).
        boolean us02Stale = rates != null && Json.asBoolean(Json.child(rates, "us02y"), "isStale");
        boolean us10Stale = rates != null && Json.asBoolean(Json.child(rates, "us10y"), "isStale");
        boolean us30Stale = rates != null && Json.asBoolean(Json.child(rates, "us30y"), "isStale");

        // 스크래핑 시세로 계산한 "지금" 스프레드.
        //
        // 공식(FRED) 확정치는 하루 이상 늦게 나옵니다. 두 값은 서로를 대체하는
        // 것이 아니라 **서로 다른 질문에 답합니다** — 공식은 "확정된 어제까지",
        // 스크래핑은 "지금 시장". 그래서 한쪽만 보여 주지 않고 둘 다 내려보내고,
        // 화면이 출처와 성격을 함께 적습니다.
        //
        // 예전에는 10Y−2Y에만 스크래핑 값이 있었습니다. 30Y−2Y 카드는 공식
        // 확정치만 보여 줘서, 같은 화면의 두 카드가 서로 다른 것을 재고 있는데도
        // 그 차이가 드러나지 않았습니다.
        out.put("realtime", scrapedSpread(us10, us02, us10Prev, us02Prev, "us10y", "us02y", us10Stale || us02Stale));

        Map<String, Object> official10y2y = officialSpread("DGS10", "DGS2");
        official10y2y.put("scraped",
                scrapedSpread(us10, us02, us10Prev, us02Prev, "us10y", "us02y", us10Stale || us02Stale));
        out.put("official10y2y", official10y2y);

        Map<String, Object> official30y2y = officialSpread("DGS30", "DGS2");
        official30y2y.put("scraped",
                scrapedSpread(us30, us02, us30Prev, us02Prev, "us30y", "us02y", us30Stale || us02Stale));
        out.put("official30y2y", official30y2y);
        return out;
    }

    /**
     * 스크래핑 수익률로 계산한 스프레드 한 건.
     *
     * <p>어느 한쪽이 없으면 0으로 메우지 않고 null로 둡니다. 0은 "차이가 없다"로
     * 읽히는데, 사실은 "모른다"이기 때문입니다.
     */
    private Map<String, Object> scrapedSpread(Double longValue, Double shortValue,
                                              Double longPrev, Double shortPrev,
                                              String longKey, String shortKey, boolean stale) {
        Double spread = SeriesMath.difference(longValue, shortValue);
        Double previousSpread = SeriesMath.difference(longPrev, shortPrev);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("longKey", longKey);
        out.put("shortKey", shortKey);
        out.put("longValue", longValue);
        out.put("shortValue", shortValue);
        // 만기를 키 이름에 박아 두지 않습니다(예: us10y).
        //
        // 이 메서드는 10Y−2Y와 30Y−2Y 양쪽에 쓰입니다. 편의를 위해 us10y를
        // 함께 내려보내면 30Y−2Y 블록에서는 그 칸에 **30년물** 값이 들어가고,
        // 받는 쪽(화면·AI 요약)은 이름만 보고 10년물이라고 읽습니다.
        // 만기는 longKey/shortKey로만 알립니다.
        out.put("spread", spread);
        out.put("previousSpread", previousSpread);
        out.put("delta", SeriesMath.difference(spread, previousSpread));
        out.put("isStale", stale);
        return out;
    }

    /** FRED 공식 일별 확정치로 계산한 스프레드 시계열. */
    public Map<String, Object> officialSpread(String longId, String shortId) {
        requireKnownFredSeries(longId, false);
        requireKnownFredSeries(shortId, false);
        List<Map<String, Object>> points = new ArrayList<>();
        for (Map.Entry<LocalDate, Double> entry
                : SeriesMath.subtractAligned(seriesMap(longId), seriesMap(shortId)).entrySet()) {
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("date", entry.getKey().toString());
            point.put("value", entry.getValue());
            points.add(point);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("longId", longId);
        out.put("shortId", shortId);
        // 최신·직전은 전체 계열에서 읽고, 차트용 점은 1년보다 오래된 구간을 주 단위(그 주의 마지막 관측)로 솎습니다.
        // 10년치 일별 2,560점 × 2계열이 매 분 250KB로 내려가던 것을 1/3로 줄입니다(docs/API.md).
        out.put("latest", points.isEmpty() ? null : points.get(points.size() - 1).get("value"));
        out.put("previous", points.size() < 2
                ? null : points.get(points.size() - 2).get("value"));
        out.put("points", SeriesMath.thinOlderThan(points,
                point -> Json.parseDate(String.valueOf(point.get("date"))), Kst.today().minusYears(1)));
        return out;
    }

    /**
     * 우리가 계산해서 만드는 파생 시리즈: id → {빼일 시리즈, 뺄 시리즈}.
     *
     * <p>FRED는 10Y-3M(T10Y3M)은 시리즈로 주지만 30Y-3M은 주지 않습니다.
     * 두 원본(DGS30·DGS3MO)이 이미 수집되고 있으므로 <b>같은 날짜끼리</b> 빼서
     * 만듭니다. 한쪽 날짜만 있는 날은 버립니다 — 앞뒤 값으로 메우면 실제로는
     * 발표되지 않은 날의 스프레드를 만들어내게 됩니다.
     */
    public static final Map<String, String[]> DERIVED_SPREADS = Map.of(
            "T30Y3M", new String[]{"DGS30", "DGS3MO"});

    /**
     * 수집하는 FRED 시계열인지 확인합니다.
     *
     * <p>모르는 ID는 저장본이 생길 수 없는데, 예전에는 그대로 찾다가 FRED 전체 수집을
     * 동기로 기다렸습니다(재현: 없는 ID 한 번에 수집기 지연만큼 대기, 반복 요청마다 다시).
     *
     * @param allowDerived 우리가 계산하는 파생 시리즈(T30Y3M 등)도 허용할지
     * @throws InvalidRequestException 목록에 없는 ID
     */
    private static void requireKnownFredSeries(String seriesId, boolean allowDerived) {
        if (Datasets.FRED_SERIES.contains(seriesId)
                || (allowDerived && DERIVED_SPREADS.containsKey(seriesId))) {
            return;
        }
        throw new InvalidRequestException("알 수 없는 FRED 시계열입니다: " + Params.echo(seriesId));
    }

    /** 날짜별 값 (파생 시리즈 포함). 날짜 오름차순입니다. */
    private Map<LocalDate, Double> resolvedSeries(String seriesId) {
        String[] parts = DERIVED_SPREADS.get(seriesId);
        if (parts == null) {
            return seriesMap(seriesId);
        }
        return SeriesMath.subtractAligned(seriesMap(parts[0]), seriesMap(parts[1]));
    }

    private Map<LocalDate, Double> seriesMap(String seriesId) {
        Optional<Snapshot> snapshot = store.read(
                Datasets.fredSeries(seriesId), Datasets.MAX_AGE_DAILY, "fred_series");
        return snapshot.filter(s -> s.payload() != null)
                .<Map<LocalDate, Double>>map(s -> Json.pointSeries(s.payload()))
                .orElseGet(LinkedHashMap::new);
    }

    /**
     * 원/달러 환율 (달러 금액을 원화로 함께 보여 줄 때 씁니다).
     *
     * <p>매크로 카드가 이미 수집하는 <b>같은 값</b>을 그대로 씁니다. 여기서
     * 따로 받아 오면 화면마다 환율이 달라져, 같은 포트폴리오가 메뉴에 따라
     * 다른 원화 금액으로 보이게 됩니다.
     *
     * <p>값이 없으면 available=false입니다. 임의의 기본 환율(예: 1,300원)을
     * 쓰지 않습니다 — 그러면 틀린 원화 금액을 사실처럼 보여 주게 됩니다.
     */
    public Map<String, Object> usdKrw() {
        Map<String, Object> out = new LinkedHashMap<>();
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_MACRO_COLLECTED, Datasets.MAX_AGE_REALTIME, "macro_collected");

        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("message", "매크로 저장본이 없어 환율을 알 수 없습니다.");
            return out;
        }

        for (JsonNode category : Json.array(snapshot.get().payload(), "categories")) {
            for (JsonNode item : Json.array(category, "items")) {
                if (!"usdkrw".equals(Json.asText(item, "key"))) {
                    continue;
                }
                Double price = Json.asDouble(item, "price");
                if (price == null || price <= 0) {
                    break;
                }
                out.put("available", true);
                out.put("rate", price);
                out.put("name", Json.asText(item, "name"));
                out.put("lastTs", Json.asText(item, "lastTs"));
                out.put("source", Json.asText(item, "source"));
                snapshot.get().putFreshness(out);
                return out;
            }
        }

        out.put("available", false);
        out.put("message", "매크로 저장본에 원/달러 값이 없습니다(수집 실패).");
        return out;
    }

    /** FRED 시리즈 원본 (차트용). */
    public Map<String, Object> fredSeries(String seriesId, Integer years) {
        requireKnownFredSeries(seriesId, true);
        // 파생 시리즈(30Y-3M 등)는 저장본이 없습니다 — 원본 둘을 빼서 만듭니다.
        if (DERIVED_SPREADS.containsKey(seriesId)) {
            return derivedSeriesResponse(seriesId, years);
        }

        Optional<Snapshot> snapshot = store.read(
                Datasets.fredSeries(seriesId), Datasets.MAX_AGE_DAILY, "fred_series");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("seriesId", seriesId);
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("points", List.of());
            return out;
        }

        List<JsonNode> points = Json.array(snapshot.get().payload(), "points");
        if (years != null && years > 0) {
            LocalDate cutoff = Kst.yearsAgo(years);
            points = points.stream()
                    .filter(p -> {
                        LocalDate date = Json.parseDate(Json.asText(p, "date"));
                        return date != null && !date.isBefore(cutoff);
                    })
                    .toList();
        }

        out.put("available", !points.isEmpty());
        snapshot.get().putFreshness(out);
        out.put("points", points);
        return out;
    }

    /** 파생 시리즈의 차트 응답. 신선도는 원본 중 <b>더 오래된 쪽</b>을 따릅니다. */
    private Map<String, Object> derivedSeriesResponse(String seriesId, Integer years) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("seriesId", seriesId);
        out.put("derivedFrom", DERIVED_SPREADS.get(seriesId));

        Map<LocalDate, Double> series = resolvedSeries(seriesId);
        LocalDate cutoff = (years != null && years > 0)
                ? Kst.yearsAgo(years) : null;

        List<Map<String, Object>> points = new ArrayList<>();
        for (Map.Entry<LocalDate, Double> entry : series.entrySet()) {
            if (cutoff != null && entry.getKey().isBefore(cutoff)) {
                continue;
            }
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("date", entry.getKey().toString());
            point.put("value", entry.getValue());
            points.add(point);
        }

        // 원본 저장본의 신선도를 그대로 전달합니다(둘 중 오래된 쪽 기준).
        String[] parts = DERIVED_SPREADS.get(seriesId);
        Optional<Snapshot> left = store.read(
                Datasets.fredSeries(parts[0]), Datasets.MAX_AGE_DAILY, "fred_series");
        Optional<Snapshot> right = store.read(
                Datasets.fredSeries(parts[1]), Datasets.MAX_AGE_DAILY, "fred_series");
        left.flatMap(a -> right.map(b -> a.ageSeconds() >= b.ageSeconds() ? a : b))
                .ifPresent(older -> older.putFreshness(out));

        out.put("available", !points.isEmpty());
        out.put("points", points);
        return out;
    }

    /**
     * 신용 리스크·은행권·변동성 지표.
     *
     * <p>주의: MOVE는 실제 ICE BofA MOVE가 아니라 ^TNX 변동성 기반 추정치입니다.
     * isProxy 표시를 그대로 전달해 화면이 경고를 띄웁니다. 실제 MOVE 기준의
     * 임계치(80/120/140)를 이 값에 그대로 적용하면 안 됩니다.
     */
    public Map<String, Object> riskIndicators() {
        Map<String, Object> out = new LinkedHashMap<>();

        out.put("vix", volatilityEntry("^VIX"));
        out.put("move", volatilityEntry("^MOVE"));
        out.put("hyOas", fredEntry("BAMLH0A0HYM2", "하이일드 스프레드 (HY OAS)", "%p"));
        out.put("cpSpread", cpSpreadEntry());
        out.put("stlfsi", fredEntry("STLFSI4", "세인트루이스 연준 금융스트레스", "pt"));
        return out;
    }

    private Map<String, Object> volatilityEntry(String symbol) {
        Optional<Snapshot> snapshot = store.read(
                Datasets.tickerHistory(symbol, Datasets.VOLATILITY_STORE_PERIOD),
                Datasets.MAX_AGE_DAILY, "volatility_history");

        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("symbol", symbol);

        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            entry.put("available", false);
            return entry;
        }

        JsonNode payload = snapshot.get().payload();
        List<Double> closes = Json.pointValues(payload);
        Double latest = SeriesMath.last(closes);
        Double previous = SeriesMath.previous(closes);

        entry.put("available", latest != null);
        entry.put("value", latest);
        entry.put("previous", previous);
        entry.put("delta", SeriesMath.difference(latest, previous));
        entry.put("pct", SeriesMath.percentChange(latest, previous));
        entry.put("isProxy", Json.asBoolean(payload, "isProxy"));
        entry.put("sourceLabel", Json.asText(payload, "sourceLabel"));
        snapshot.get().putFreshness(entry);
        return entry;
    }

    private Map<String, Object> fredEntry(String seriesId, String label, String unit) {
        Optional<Snapshot> snapshot = store.read(
                Datasets.fredSeries(seriesId), Datasets.MAX_AGE_DAILY, "fred_series");

        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("seriesId", seriesId);
        entry.put("label", label);
        entry.put("unit", unit);

        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            entry.put("available", false);
            return entry;
        }

        JsonNode payload = snapshot.get().payload();
        // 점 단위로 읽습니다 — 날짜·값 목록을 따로 뽑으면 날짜가 깨진 점 하나에 asOf와 value가
        // 서로 다른 점을 가리킵니다.
        NavigableMap<LocalDate, Double> series = Json.pointSeries(payload);
        List<Double> values = new ArrayList<>(series.values());
        Double latest = SeriesMath.last(values);
        Double previous = SeriesMath.previous(values);

        entry.put("available", latest != null);
        entry.put("value", latest);
        entry.put("previous", previous);
        entry.put("delta", SeriesMath.difference(latest, previous));
        entry.put("asOf", series.isEmpty() ? null : series.lastKey().toString());
        putPercentile(entry, new ArrayList<>(series.keySet()), values);
        return entry;
    }

    /**
     * 백분위와 그 표본 — 시작일·개수·기간(년).
     *
     * <p>시리즈마다 표본 길이가 다릅니다. ICE BofA 시리즈(BAMLC0A0CM·BAMLH0A0HYM2)는 FRED가 최근
     * 3년만 제공하고, 나머지는 약 10년입니다. 백분위만 내려보내면 받는 쪽(화면·AI 입력)이 모두 같은
     * 기준으로 읽어, IG 스프레드의 "3년 안의 중간"이 "역사적 중간"처럼 보였습니다.
     */
    private static void putPercentile(Map<String, Object> entry, List<LocalDate> dates, List<Double> values) {
        entry.put("percentile", SeriesMath.percentile(values));
        if (dates.isEmpty()) {
            return;
        }
        LocalDate from = dates.get(0);
        LocalDate to = dates.get(dates.size() - 1);
        entry.put("percentileFrom", from.toString());
        entry.put("percentileCount", values.size());
        entry.put("percentileYears", Math.round(ChronoUnit.DAYS.between(from, to) / 365.25 * 10) / 10.0);
    }

    /**
     * 3M 금융 CP 스프레드 = CPF3M − 3M 국채.
     *
     * <p>3M 국채(DGS3MO)가 없으면 계산하지 않습니다. 한쪽만으로 스프레드를
     * 흉내 내면 숫자가 그럴듯해 보여도 의미가 없습니다.
     */
    private Map<String, Object> cpSpreadEntry() {
        Map<LocalDate, Double> aligned = SeriesMath.subtractAligned(seriesMap("CPF3M"), seriesMap("DGS3MO"));
        List<LocalDate> dates = new ArrayList<>(aligned.keySet());
        List<Double> spread = new ArrayList<>(aligned.values());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("seriesId", "CPF3M-DGS3MO");
        out.put("label", "3M 금융 CP 스프레드");
        out.put("unit", "%p");

        Double latest = SeriesMath.last(spread);
        out.put("available", latest != null);
        out.put("value", latest);
        out.put("previous", SeriesMath.previous(spread));
        out.put("delta", SeriesMath.difference(latest, SeriesMath.previous(spread)));
        out.put("asOf", dates.isEmpty() ? null : dates.get(dates.size() - 1).toString());

        List<Map<String, Object>> points = new ArrayList<>();
        for (int i = 0; i < dates.size(); i++) {
            Map<String, Object> point = new LinkedHashMap<>();
            point.put("date", dates.get(i).toString());
            point.put("value", spread.get(i));
            points.add(point);
        }
        out.put("points", points);
        return out;
    }

    /** 심화 매크로 지표 6종 (최신값·변화·백분위·해석). */
    public Map<String, Object> advancedIndicators() {
        Map<String, Object> latest = new LinkedHashMap<>();

        for (String seriesId : AdvancedIndicators.DISPLAY_ORDER) {
            AdvancedIndicators.Meta meta = AdvancedIndicators.SERIES.get(seriesId);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", seriesId);
            entry.put("label", meta.label());
            entry.put("unit", meta.unit());
            entry.put("digits", meta.digits());
            entry.put("group", meta.group());
            entry.put("why", meta.why());
            entry.put("source", meta.source());

            // 파생 시리즈(30Y-3M)는 저장본이 없고 원본 둘을 빼서 만듭니다.
            Map<LocalDate, Double> series = resolvedSeries(seriesId);
            if (series.isEmpty()) {
                entry.put("available", false);
                latest.put(seriesId, entry);
                continue;
            }

            List<LocalDate> dates = new ArrayList<>(series.keySet());
            List<Double> values = new ArrayList<>(series.values());
            Double value = SeriesMath.last(values);

            if (value == null) {
                entry.put("available", false);
                latest.put(seriesId, entry);
                continue;
            }

            Double previous = SeriesMath.previous(values);
            entry.put("available", true);
            entry.put("value", value);
            entry.put("prev", previous);
            entry.put("delta", SeriesMath.difference(value, previous));
            entry.put("asOf", dates.isEmpty() ? null : dates.get(dates.size() - 1).toString());
            putPercentile(entry, dates, values);

            AdvancedIndicators.Interpretation interpretation =
                    AdvancedIndicators.interpret(seriesId, value);
            if (interpretation != null) {
                entry.put("status", interpretation.status());
                entry.put("color", interpretation.color());
                entry.put("note", interpretation.note());
            }
            latest.put(seriesId, entry);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("order", AdvancedIndicators.DISPLAY_ORDER);
        out.put("latest", latest);
        out.put("derived", derived(latest));
        return out;
    }

    /**
     * 개별 지표만으로는 안 보이는 관계.
     *
     * <p>명목 10년 ≈ 실질 + 기대인플레. 세 값의 기준 시점이 다르면 오차가
     * 생기므로 참고용입니다.
     */
    private Map<String, Object> derived(Map<String, Object> latest) {
        Map<String, Object> out = new LinkedHashMap<>();

        Object realEntry = latest.get("DFII10");
        Object beiEntry = latest.get("T10YIE");
        if (!(realEntry instanceof Map<?, ?> real) || !(beiEntry instanceof Map<?, ?> bei)) {
            return out;
        }
        Object realValue = real.get("value");
        Object beiValue = bei.get("value");
        if (!(realValue instanceof Double r) || !(beiValue instanceof Double b)) {
            return out;
        }

        out.put("impliedNominal10y", r + b);
        out.put("decomposition",
                "명목 10년 ≈ 실질 %.2f%% + 기대인플레 %.2f%% = %.2f%%".formatted(r, b, r + b));
        return out;
    }

    /** 참고 스크래핑 시세 (비공식). */
    public Map<String, Object> scrapedMarkets() {
        Optional<Snapshot> snapshot = store.read(
                Datasets.SNAP_SCRAPER_MARKETS, Datasets.MAX_AGE_REALTIME, "scraper_markets");

        Map<String, Object> out = new LinkedHashMap<>();
        if (snapshot.isEmpty() || snapshot.get().payload() == null) {
            out.put("available", false);
            out.put("items", List.of());
            return out;
        }
        out.put("available", true);
        snapshot.get().putFreshness(out);
        out.put("updatedAt", Json.asText(snapshot.get().payload(), "updatedAt"));
        out.put("items", snapshot.get().payload().get("items"));
        return out;
    }

    /**
     * 개별 지표 차트.
     *
     * <p>변동성 지수는 저장본(5y)을 잘라 쓰고, 그 밖의 티커는 수집기에 직접
     * 조회를 요청합니다(티커가 많아 전부 저장할 이유가 없습니다).
     */
    public Map<String, Object> tickerSeries(String symbol, String period) {
        boolean storeBacked = symbol.equals("^VIX") || symbol.equals("^MOVE");

        if (storeBacked) {
            Optional<Snapshot> snapshot = store.read(
                    Datasets.tickerHistory(symbol, Datasets.VOLATILITY_STORE_PERIOD),
                    Datasets.MAX_AGE_DAILY, "volatility_history");
            if (snapshot.isPresent() && snapshot.get().payload() != null) {
                return sliceTicker(snapshot.get().payload(), period);
            }
        }

        Map<String, Object> out = new LinkedHashMap<>();
        if (store.readMode() == AppProperties.ReadMode.STORE_ONLY) {
            // 화면 조회가 외부 호출(yfinance)을 일으키지 않는다는 약속이 우선입니다 — 공개 데모(ADR 0012, QA-022).
            out.put("available", false);
            out.put("symbol", symbol);
            out.put("points", List.of());
            out.put("message", "store_only 모드에서는 저장하지 않는 지표의 차트를 조회하지 않습니다.");
            return out;
        }
        Optional<JsonNode> live = collector.liveTicker(symbol, period);
        if (live.isEmpty()) {
            out.put("available", false);
            out.put("symbol", symbol);
            out.put("points", List.of());
            out.put("message", "수집기에서 시계열을 받지 못했습니다.");
            return out;
        }
        JsonNode payload = live.get();
        boolean available = !Json.array(payload, "points").isEmpty();
        out.put("available", available);
        out.put("symbol", symbol);
        out.put("period", period);
        out.put("isProxy", Json.asBoolean(payload, "isProxy"));
        out.put("sourceLabel", Json.asText(payload, "sourceLabel"));
        out.put("points", payload.get("points"));
        if (!available) {
            // 수집기는 받았지만 외부 소스가 실패한 경우 — 수집기가 적은 사유를 화면에 넘깁니다(QA-124). 사유가 없으면 화면이 기본 문구를 씁니다.
            String reason = Json.asText(payload, "error");
            if (reason != null && !reason.isBlank()) {
                out.put("message", "외부 소스에서 시계열을 받지 못했습니다: " + SecretRedactor.redact(reason));
            }
        }
        return out;
    }

    private Map<String, Object> sliceTicker(JsonNode payload, String period) {
        List<JsonNode> points = Json.array(payload, "points");
        Integer days = SeriesMath.periodDays(period);

        List<JsonNode> sliced = points;
        if (days != null && !points.isEmpty()) {
            LocalDate lastDate = Json.parseDate(Json.asText(points.get(points.size() - 1), "date"));
            if (lastDate != null) {
                LocalDate cutoff = lastDate.minusDays(days);
                List<JsonNode> filtered = points.stream()
                        .filter(p -> {
                            LocalDate date = Json.parseDate(Json.asText(p, "date"));
                            return date != null && !date.isBefore(cutoff);
                        })
                        .toList();
                if (filtered.size() >= 2) {
                    sliced = filtered;
                }
            }
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", !sliced.isEmpty());
        out.put("symbol", Json.asText(payload, "symbol"));
        out.put("period", period);
        // 잘라 내도 "이 값은 실제 지표가 아니다"라는 표시가 사라지면 안 됩니다.
        out.put("isProxy", Json.asBoolean(payload, "isProxy"));
        out.put("sourceLabel", Json.asText(payload, "sourceLabel"));
        out.put("points", sliced);
        return out;
    }
}
