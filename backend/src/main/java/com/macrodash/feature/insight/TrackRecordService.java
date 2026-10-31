package com.macrodash.feature.insight;

import com.macrodash.analytics.ForwardReturns;
import com.macrodash.analytics.PointInTime;
import com.macrodash.analytics.RegimeBacktest;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;
import java.util.Optional;
import java.util.TreeMap;

/**
 * 📈 국면 판정 성과 — 판정을 과거에 그대로 적용했을 때 그 뒤 수익률(명세 A2~A9).
 *
 * <p>입력 이력은 스냅샷이 아니라 <b>누적 시계열(timeseries)</b>에서 읽습니다. 하이일드 스프레드는 FRED가 최근 3년만
 * 주므로 스냅샷은 3년에서 잘리지만, 누적 시계열은 수집을 시작한 뒤로 계속 쌓입니다. 값은 발표 지연을 반영해
 * "그날 알 수 있었던 값"으로 바꿔 씁니다({@link PointInTime}).
 */
@Service
public class TrackRecordService {

    /** 성과를 내는 기간(주). */
    static final int[] HORIZONS = {4, 13, 26};

    /** 자산 → (가격 저장본, 이름). 가격은 배당을 반영한 ETF 수정 종가입니다. */
    record Asset(String ticker, String label, String snapshot, String task) {
    }

    static final List<Asset> ASSETS = List.of(
            new Asset("SPY", "S&P 500 (SPY)", Datasets.SNAP_EQUITY_HISTORY, "equity_history"),
            new Asset("QQQ", "나스닥 100 (QQQ)", Datasets.SNAP_EQUITY_HISTORY, "equity_history"),
            new Asset("069500.KS", "KOSPI 200 (KODEX 200)", Datasets.SNAP_EQUITY_HISTORY, "equity_history"),
            new Asset("IEF", "미국채 7-10년 (IEF)", Datasets.SNAP_SECTOR_HISTORY, "sector_history"),
            new Asset("GLD", "금 (GLD)", Datasets.SNAP_SECTOR_HISTORY, "sector_history"));

    /** 고정 한계. 재현 기간 줄은 입력·가격의 실제 시작일에서 만들어 맨 앞에 붙입니다({@link #periodLimit}, QA-063). */
    static final List<String> LIMITS = List.of(
            "NFCI는 매주 과거 값이 개정됩니다. 재현에 쓴 값은 당시 발표값이 아니라, 오래된 구간은 처음 수집한 날의 개정본, "
                    + "최근 구간은 관측 1~2주 뒤의 값입니다. 라이브 판정 기록에는 이 문제가 없습니다.",
            "가격은 ETF 종가(배당 반영 수정주가)입니다. 지수 자체의 수익률이 아닙니다.",
            "과거 성과는 미래 수익을 보장하지 않습니다. 이 표는 판정의 설명력을 보여 줄 뿐 매매 권유가 아닙니다.",
            "같은 국면이 몇 주 이어지면 수익률 기간이 겹칩니다. 그래서 표본 수와 겹치지 않는 표본 수를 따로 적습니다.");

    /**
     * 재현 기간 한 줄 — 가장 늦게 시작하는 이력(입력 넷 또는 가격)과 실제 기간. 예전에는 하이일드 기준 '약 3년'을 고정으로
     * 적어, 가격 이력이 2년뿐인 IEF·GLD에서 덧붙인 줄과 어긋났습니다(QA-042·QA-063).
     */
    static String periodLimit(Asset asset, LocalDate priceFrom, LocalDate inputsFrom, LocalDate from, LocalDate to,
                              List<Map.Entry<String, LocalDate>> inputStarts) {
        String latestStart = priceFrom.isAfter(inputsFrom)
                ? asset.label() + " 가격 이력"
                : inputStarts.stream().filter(entry -> entry.getValue().equals(inputsFrom)).map(Map.Entry::getKey)
                        .findFirst().orElse("국면 입력") + " 이력";
        double years = java.time.temporal.ChronoUnit.DAYS.between(from, to) / 365.25;
        return "%s이 %s부터라 재현 기간은 약 %.1f년입니다. 그 안에서 국면이 바뀐 횟수가 적어 표본이 작습니다."
                .formatted(latestStart, from, years);
    }

    private final StoreRepository repository;
    private final StoreReader store;

    public TrackRecordService(StoreRepository repository, StoreReader store) {
        this.repository = repository;
        this.store = store;
    }

    /** 무료 회원이 볼 수 있는 자산(D5 등급표). 유료·운영자는 전체. */
    static final String FREE_ASSET = "SPY";

    public Map<String, Object> trackRecord(String ticker, boolean pro) {
        Asset asset = ASSETS.stream().filter(a -> a.ticker().equals(ticker)).findFirst()
                .orElseThrow(() -> new InvalidRequestException(
                        "알 수 없는 자산입니다: " + Params.echo(ticker) + " (가능: SPY·QQQ·069500.KS·IEF·GLD)"));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("asset", asset.ticker());
        out.put("assetLabel", asset.label());
        out.put("assets", ASSETS.stream().map(a -> Map.of("ticker", a.ticker(), "label", a.label())).toList());
        out.put("horizons", HORIZONS);
        out.put("limits", LIMITS);
        if (!pro && !FREE_ASSET.equals(asset.ticker())) {
            out.put("available", false);
            out.put("locked", true);
            out.put("message", "무료 등급은 S&P 500(SPY) 성과만 볼 수 있습니다. 다른 자산은 유료 등급에서 볼 수 있습니다.");
            return out;
        }

        NavigableMap<LocalDate, Double> curve = known("T10Y3M", PointInTime.Release.NEXT_BUSINESS_DAY);
        NavigableMap<LocalDate, Double> nfci = known("NFCI", PointInTime.Release.NEXT_WEDNESDAY);
        NavigableMap<LocalDate, Double> hy = known("BAMLH0A0HYM2", PointInTime.Release.NEXT_BUSINESS_DAY);
        NavigableMap<LocalDate, Double> liquidity = PointInTime.asKnownOn(netLiquidityTrillions(),
                PointInTime.Release.NEXT_BUSINESS_DAY);
        NavigableMap<LocalDate, Double> prices = prices(asset);

        if (curve.isEmpty() || nfci.isEmpty() || hy.isEmpty() || liquidity.isEmpty()) {
            out.put("available", false);
            out.put("message", "국면 입력의 누적 이력이 없습니다. 데이터 저장소 상태에서 fred_series·fed_liquidity를 실행하세요.");
            return out;
        }
        if (prices.isEmpty()) {
            out.put("available", false);
            out.put("message", "%s 가격 저장본이 없습니다. 데이터 저장소 상태에서 %s를 실행하세요."
                    .formatted(asset.label(), asset.task()));
            return out;
        }

        // 하이일드가 생긴 뒤부터만 판정할 수 있습니다. 가격도 있어야 수익률을 잽니다.
        LocalDate inputsFrom = latest(curve.firstKey(), nfci.firstKey(), hy.firstKey(), liquidity.firstKey());
        LocalDate from = latest(inputsFrom, prices.firstKey());
        LocalDate to = earliest(curve.lastKey(), nfci.lastKey(), hy.lastKey(), liquidity.lastKey());
        List<String> limits = new ArrayList<>();
        limits.add(periodLimit(asset, prices.firstKey(), inputsFrom, from, to,
                List.of(Map.entry("하이일드 스프레드", hy.firstKey()), Map.entry("NFCI", nfci.firstKey()),
                        Map.entry("장단기 금리차(T10Y3M)", curve.firstKey()), Map.entry("순유동성", liquidity.firstKey()))));
        limits.addAll(LIMITS);
        out.put("limits", limits);
        List<RegimeBacktest.Point> timeline = RegimeBacktest.timeline(curve, nfci, hy, liquidity, from, to);
        RegimeBacktest.Result result = RegimeBacktest.trackRecord(timeline, prices, HORIZONS);

        out.put("available", true);
        out.put("evaluatedFrom", timeline.isEmpty() ? null : timeline.get(0).date().toString());
        out.put("evaluatedTo", timeline.isEmpty() ? null : timeline.get(timeline.size() - 1).date().toString());
        out.put("evaluatedWeeks", result.evaluatedWeeks());
        out.put("knownWeeks", result.knownWeeks());
        out.put("priceFrom", prices.firstKey().toString());
        out.put("priceTo", prices.lastKey().toString());
        out.put("minSamples", RegimeBacktest.MIN_SAMPLES);
        out.put("minIndependent", RegimeBacktest.MIN_INDEPENDENT);
        out.put("start", regimes(result.start()));
        out.put("all", regimes(result.all()));
        out.put("baseline", result.baseline().stream().map(cell -> cellMap(cell, true)).toList());
        out.put("rule", "매주 목요일에 그날까지 발표된 값만으로 판정하고(NFCI는 다음 주 수요일, 일별 값은 다음 영업일 발표로 봄), "
                + "다음 거래일 종가에서 출발해 4·13·26주 뒤 종가까지 잽니다.");
        return out;
    }

    private List<Map<String, Object>> regimes(List<RegimeBacktest.RegimeStats> stats) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (RegimeBacktest.RegimeStats regime : stats) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("code", regime.code());
            entry.put("label", regime.label() == null ? LABELS.get(regime.code()) : regime.label());
            entry.put("weeks", regime.weeks());
            entry.put("episodes", regime.episodes());
            entry.put("cells", regime.cells().stream().map(cell -> cellMap(cell, false)).toList());
            out.add(entry);
        }
        return out;
    }

    private static final Map<String, String> LABELS = Map.of(
            "EXPANSION", "확장 (Expansion)", "LATE", "후퇴 경계 (Late cycle)",
            "RECOVERY", "회복 (Recovery)", "CONTRACTION", "침체 경계 (Contraction)");

    /** 표본이 부족하면 수익률 숫자를 내지 않습니다(표본 수는 냄). */
    private static Map<String, Object> cellMap(RegimeBacktest.Cell cell, boolean baseline) {
        ForwardReturns.Summary summary = cell.summary();
        boolean show = baseline || cell.sufficient();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("horizonWeeks", cell.horizonWeeks());
        out.put("count", summary.count());
        out.put("independent", cell.independent());
        out.put("sufficient", baseline ? summary.count() > 0 : cell.sufficient());
        out.put("mean", show ? summary.mean() : null);
        out.put("median", show ? summary.median() : null);
        out.put("winRate", show ? summary.winRate() : null);
        out.put("best", show ? summary.best() : null);
        out.put("worst", show ? summary.worst() : null);
        if (!baseline) {
            out.put("excessMean", show ? cell.excessMean() : null);
            out.put("excessMedian", show ? cell.excessMedian() : null);
        }
        return out;
    }

    private NavigableMap<LocalDate, Double> known(String seriesId, PointInTime.Release release) {
        return PointInTime.asKnownOn(timeseries(Datasets.TS_FRED, seriesId), release);
    }

    private NavigableMap<LocalDate, Double> timeseries(String dataset, String seriesId) {
        NavigableMap<LocalDate, Double> out = new TreeMap<>();
        for (StoreRepository.TimeseriesPoint point : repository.readTimeseries(dataset, seriesId, null)) {
            if (point.value() != null) {
                out.put(point.date(), point.value());
            }
        }
        return out;
    }

    /** 순유동성은 백만 달러로 쌓여 있습니다. 판정 규칙(4주 변화의 부호)과 단위를 맞춰 조 달러로. */
    private NavigableMap<LocalDate, Double> netLiquidityTrillions() {
        NavigableMap<LocalDate, Double> out = new TreeMap<>();
        timeseries(Datasets.TS_LIQUIDITY, "netLiquidityM").forEach((date, value) -> out.put(date, value / 1_000_000.0));
        return out;
    }

    private NavigableMap<LocalDate, Double> prices(Asset asset) {
        Optional<Snapshot> snapshot = store.read(asset.snapshot(), Datasets.MAX_AGE_DAILY, asset.task());
        JsonNode tickers = snapshot.filter(s -> s.payload() != null)
                .map(s -> Json.child(s.payload(), "tickers")).orElse(null);
        return Json.dateValueSeries(tickers == null ? null : tickers.get(asset.ticker()), "dates", "close", null);
    }

    private static LocalDate latest(LocalDate... dates) {
        LocalDate out = dates[0];
        for (LocalDate date : dates) {
            if (date.isAfter(out)) {
                out = date;
            }
        }
        return out;
    }

    private static LocalDate earliest(LocalDate... dates) {
        LocalDate out = dates[0];
        for (LocalDate date : dates) {
            if (date.isBefore(out)) {
                out = date;
            }
        }
        return out;
    }
}
