package com.macrodash.analytics;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.NavigableMap;

/**
 * 국면 판정 성과 — 판정을 과거에 그대로 적용했을 때, 그 뒤 수익률이 어땠나.
 *
 * <p>규칙
 * <ul>
 *   <li>매주 목요일(WALCL 발표일)에, 그날까지 <b>발표된</b> 값만으로 판정합니다({@link PointInTime}).</li>
 *   <li>진입은 판정한 날의 <b>다음 거래일 종가</b>입니다 — 판정에 쓴 값 일부는 그날 장 마감 뒤에 나옵니다.</li>
 *   <li>두 관점을 나눕니다. ① 국면이 <b>시작된</b> 주(직전 유효 판정과 다를 때 — 알림을 받고 따랐다면),
 *       ② 그 국면에 <b>머문 모든 주</b>.</li>
 *   <li>비교 기준은 같은 기간 판정이 난 모든 주("아무 때나")이고, 초과분을 함께 냅니다.</li>
 *   <li>표본이 {@value #MIN_SAMPLES}개 미만이거나 기간이 겹치지 않는 표본이 {@value #MIN_INDEPENDENT}개 미만이면
 *       "표본 부족"입니다. 숫자는 계산하되 화면은 내지 않습니다 — 몇 개 안 되는 수익률의 평균은 우연입니다.</li>
 * </ul>
 */
public final class RegimeBacktest {

    private RegimeBacktest() {
    }

    public static final int MIN_SAMPLES = 20;
    public static final int MIN_INDEPENDENT = 3;
    public static final DayOfWeek EVALUATION_DAY = DayOfWeek.THURSDAY;

    /** 한 주의 판정. */
    public record Point(LocalDate date, String code, String label) {
        boolean known() {
            return !"UNKNOWN".equals(code);
        }
    }

    /** 한 기간(N주)의 성적. */
    public record Cell(int horizonWeeks, ForwardReturns.Summary summary, int independent, boolean sufficient,
                       Double excessMean, Double excessMedian) {
    }

    /** 한 국면의 성적. {@code episodes}는 그 국면이 이어진 구간 수. */
    public record RegimeStats(String code, String label, int weeks, int episodes, List<Cell> cells) {
    }

    /** 두 관점의 국면별 성적과 비교 기준. */
    public record Result(List<RegimeStats> start, List<RegimeStats> all, List<Cell> baseline,
                         int evaluatedWeeks, int knownWeeks) {
    }

    /**
     * 매주 목요일의 판정. 입력은 모두 "알게 된 날" 기준({@link PointInTime#asKnownOn}).
     *
     * @param liquidityKnown 순유동성(조 달러) — 4주 변화를 그 자리에서 계산합니다
     */
    public static List<Point> timeline(NavigableMap<LocalDate, Double> curveKnown,
                                       NavigableMap<LocalDate, Double> nfciKnown,
                                       NavigableMap<LocalDate, Double> hyKnown,
                                       NavigableMap<LocalDate, Double> liquidityKnown,
                                       LocalDate from, LocalDate to) {
        List<Point> out = new ArrayList<>();
        if (from == null || to == null) {
            return out;
        }
        for (LocalDate date = from.with(TemporalAdjusters.nextOrSame(EVALUATION_DAY));
             !date.isAfter(to); date = date.plusWeeks(1)) {
            Regime.Verdict verdict = Regime.classify(
                    SeriesMath.valueAsOf(curveKnown, date), SeriesMath.valueAsOf(nfciKnown, date),
                    SeriesMath.valueAsOf(hyKnown, date), SeriesMath.changeOverWeeks(liquidityKnown, date, 4));
            out.add(new Point(date, verdict.code(), verdict.label()));
        }
        return out;
    }

    /** 판정한 날 → 진입일(이 날 이후 첫 거래일 종가). */
    static LocalDate entryDate(LocalDate evaluated) {
        return evaluated.plusDays(1);
    }

    public static Result trackRecord(List<Point> timeline, NavigableMap<LocalDate, Double> prices,
                                     int... horizons) {
        List<Point> known = timeline.stream().filter(Point::known).toList();

        // 비교 기준: 판정이 난 모든 주.
        List<Cell> baseline = new ArrayList<>();
        for (int weeks : horizons) {
            List<Double> returns = returnsFor(known, prices, weeks);
            baseline.add(new Cell(weeks, ForwardReturns.summarize(returns),
                    independent(known, returns, weeks), true, null, null));
        }

        Map<String, String> labels = new LinkedHashMap<>();
        for (String code : List.of("EXPANSION", "LATE", "RECOVERY", "CONTRACTION")) {
            labels.put(code, null);
        }
        known.forEach(point -> labels.put(point.code(), point.label()));

        List<RegimeStats> all = new ArrayList<>();
        List<RegimeStats> start = new ArrayList<>();
        for (Map.Entry<String, String> regime : labels.entrySet()) {
            String code = regime.getKey();
            List<Point> inRegime = known.stream().filter(point -> point.code().equals(code)).toList();
            List<Point> starts = starts(timeline, code);
            int episodes = episodes(timeline, code);
            all.add(stats(code, regime.getValue(), inRegime, episodes, prices, baseline, horizons));
            start.add(stats(code, regime.getValue(), starts, starts.size(), prices, baseline, horizons));
        }
        return new Result(start, all, baseline, timeline.size(), known.size());
    }

    private static RegimeStats stats(String code, String label, List<Point> points, int episodes,
                                     NavigableMap<LocalDate, Double> prices, List<Cell> baseline,
                                     int[] horizons) {
        List<Cell> cells = new ArrayList<>();
        for (int i = 0; i < horizons.length; i++) {
            int weeks = horizons[i];
            List<Double> returns = returnsFor(points, prices, weeks);
            ForwardReturns.Summary summary = ForwardReturns.summarize(returns);
            int independent = independent(points, returns, weeks);
            boolean sufficient = summary.count() >= MIN_SAMPLES && independent >= MIN_INDEPENDENT;
            ForwardReturns.Summary base = baseline.get(i).summary();
            cells.add(new Cell(weeks, summary, independent, sufficient,
                    SeriesMath.difference(summary.mean(), base.mean()),
                    SeriesMath.difference(summary.median(), base.median())));
        }
        return new RegimeStats(code, label, points.size(), episodes, cells);
    }

    private static List<Double> returnsFor(List<Point> points, NavigableMap<LocalDate, Double> prices, int weeks) {
        List<Double> returns = new ArrayList<>();
        for (Point point : points) {
            returns.add(ForwardReturns.forwardReturn(prices, entryDate(point.date()), weeks));
        }
        return returns;
    }

    /** 수익률 기간이 서로 겹치지 않게 앞에서부터 골라 센 표본 수. 같은 국면이 이어지면 기간이 겹칩니다. */
    static int independent(List<Point> points, List<Double> returns, int weeks) {
        int count = 0;
        LocalDate nextFree = null;
        for (int i = 0; i < points.size(); i++) {
            if (returns.get(i) == null) {
                continue;
            }
            LocalDate date = points.get(i).date();
            if (nextFree == null || !date.isBefore(nextFree)) {
                count++;
                nextFree = date.plusWeeks(weeks);
            }
        }
        return count;
    }

    /** 국면이 시작된 주 — 직전 주가 유효한 판정이고 그와 다를 때. 직전이 판정 불가면 시작 여부를 모릅니다. */
    static List<Point> starts(List<Point> timeline, String code) {
        List<Point> out = new ArrayList<>();
        for (int i = 1; i < timeline.size(); i++) {
            Point previous = timeline.get(i - 1);
            Point current = timeline.get(i);
            if (current.code().equals(code) && previous.known() && !previous.code().equals(code)) {
                out.add(current);
            }
        }
        return out;
    }

    /** 그 국면이 이어진 구간 수. */
    static int episodes(List<Point> timeline, String code) {
        int count = 0;
        String previous = null;
        for (Point point : timeline) {
            if (point.code().equals(code) && !code.equals(previous)) {
                count++;
            }
            previous = point.code();
        }
        return count;
    }
}
