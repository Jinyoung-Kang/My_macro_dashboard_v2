package com.macrodash.analytics;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;

/**
 * 어닝 서프라이즈 — 저장본(수집기 {@code earnings_surprise} 태스크의 {@code observations us.earnings_surprise}, entity = 티커,
 * obs_date = 발표 시각의 미국 동부 날짜)에서 기준일에 <b>알 수 있었던</b> 최근 {@value #LAST}분기 EPS 실제치·컨센서스·서프라이즈율을
 * 고릅니다(2단계 명세 C1·C3). Claude 패킷 재무 섹션 {@code 8b_fundamentals}의 종목 행 {@code eps} 칸이 이 결과입니다. 저장소 없이
 * 테스트하는 순수 계산입니다.
 *
 * <p><b>시점(PIT)</b>: 발표일(미국 동부 날짜) ≤ 기준일인 행만 씁니다. 기준일 <b>장 마감 뒤</b>(AMC, 16:00 ET 안팎) 발표도 넣습니다 —
 * 결정은 다음 날 07:30 KST(= 기준일 18:30 EDT·17:30 EST)라 그때는 이미 공개된 숫자이기 때문입니다({@link CalendarWindow}는 같은 발표를
 * '다음 일정'에서 빼므로 둘이 빈틈없이 이어짐). 날짜만으로 자르면 기준일 저녁 늦게, 결정 시각 <b>뒤에</b> 나온 발표(단계 0: PBR
 * 19:55 ET 등 해외 상장사)가 나중에 다시 만든 패킷(초기 결정 10-23 등)에 섞입니다. 그래서 호출부가 결정 시각({@code knownBy} —
 * {@link NewsEvents#window}의 끝과 같은 시각)을 주면 발표 시각({@link Report#reportedAt})이 그보다 뒤인 행도 뺍니다. 발표 시각이
 * 없는 행은 날짜 규칙만 따릅니다. 시계를 읽지 않으므로 같은 행·같은 기준일이면 언제 만들어도 같은 결과입니다.
 *
 * <p><b>같은 분기가 두 번</b>: 출처가 한 분기의 발표일을 바꿔 보이면 다른 obs_date로 한 행이 더 쌓입니다(저장본은 지우지 않음 — 이력이
 * 4분기에서 8분기로 쌓이는 곳). 그대로 두면 4칸 중 두 칸이 같은 분기라, 같은 {@code periodEnd}는 기준일까지 보인 것 중 가장 늦은
 * 발표 한 행만 둡니다. {@code periodEnd}를 모르는 행은 어느 분기인지 알 수 없어 묶지 않습니다.
 *
 * <p><b>없는 숫자를 만들지 않습니다</b>: 추정치가 없거나 0이면 {@code surprisePct}는 null입니다(나눌 기준이 없음 — 저장값이 있어도
 * 버림, 명세 §5-3 수용 기준). 실제치가 없어도 null. 빈 칸을 다시 계산하지는 않습니다 — 서프라이즈 공식은 수집기 한 곳에만 둡니다.
 * {@code smallBase}는 |추정치| &lt; {@value #SMALL_BASE}(명세 C1)일 때입니다 — 추정치 0.01달러에 실제 0.23달러면 +2,200%처럼 비율이
 * 부풀어 '대형 서프라이즈'로 읽히므로 표시를 붙입니다. 저장된 표시가 빠졌어도 같은 기준으로 붙이고, 추정치가 없으면 붙이지
 * 않습니다(기준 자체가 없음).
 *
 * <p><b>통화</b>: EPS는 보고 통화 그대로입니다(BIDU는 CNY — 달러로 바꾸지 않음). 종목의 통화({@link Result#currency})는 고른 행들의
 * 통화이고, USD가 아니면 패킷이 따로 적도록 {@link Result#nonUsdCurrency}로 냅니다. 서프라이즈율은 같은 통화끼리의 비율이라
 * 통화와 상관없이 비교할 수 있습니다.
 *
 * <p><b>없음과 0건을 구분합니다</b>(명세 §1): 데이터셋 자체가 없으면({@code rows == null}) {@link Result#available} false →
 * 패킷 칸 null, 데이터셋은 있는데 이 종목 행이 없거나 기준일 전 발표가 없으면 빈 목록입니다.
 *
 * <p>이 클래스는 정보를 고를 뿐 규칙 계좌·검증기·벤치마크를 바꾸지 않습니다(D35).
 */
public final class EarningsHistory {

    private EarningsHistory() {
    }

    /** 패킷에 싣는 분기 수(명세 C3 — 출처가 한 번에 4분기만 주고, 쌓이면 저장본은 8분기 이상이어도 패킷은 4분기). */
    public static final int LAST = 4;

    /** {@code smallBase} 기준 — |추정치|가 이보다 작으면(명세 C1). 수집기의 같은 기준과 같은 값이어야 합니다. */
    public static final double SMALL_BASE = 0.05;

    /**
     * EPS(실제치·추정치)를 패킷에 실을 때의 소수 자릿수 상한(끝의 0은 지움). 2자리로 자르면 0.004달러 같은 작은 추정치가 0이 되어
     * '추정치 0'(= 서프라이즈율을 낼 수 없음)과 구분되지 않습니다 — smallBase가 붙는 바로 그 값들이라 4자리.
     */
    static final int EPS_SCALE = 4;

    /** 서프라이즈율(%)의 소수 자릿수. */
    static final int PCT_SCALE = 1;

    /** 패킷 머리말 {@code epsColumns} — {@link Result#compact()}의 한 칸 순서. */
    public static final List<String> COLUMNS = List.of("reported", "periodEnd", "actual", "estimate", "surprisePct");

    /** 미국 달러 — 이 통화면 패킷에 통화를 따로 적지 않습니다. */
    public static final String USD = "USD";

    /**
     * 저장본 한 행({@code observations} 한 행 — 날짜는 obs_date, 나머지는 payload).
     *
     * @param reported    발표일(발표 시각의 미국 동부 날짜 = obs_date). null이면 시점을 알 수 없어 행을 쓰지 않습니다
     * @param periodEnd   분기 말(모르면 null — 같은 분기 묶기에서 빠짐)
     * @param actual      EPS 실제치(보고 통화). 없으면 null
     * @param estimate    EPS 컨센서스(보고 통화). 없으면 null
     * @param surprisePct 서프라이즈율(%) — 수집기가 (실제 − 추정) / |추정| × 100으로 계산. 없으면 null
     * @param currency    보고 통화(모르면 null)
     * @param smallBase   수집기가 붙인 작은 추정치 표시(모르면 null)
     * @param reportedAt  발표 시각(모르면 null) — 기준일 당일 행을 결정 시각으로 한 번 더 자를 때만 씀
     */
    public record Report(LocalDate reported, LocalDate periodEnd, Double actual, Double estimate, Double surprisePct,
                         String currency, Boolean smallBase, Instant reportedAt) {
    }

    /**
     * 패킷에 실을 한 분기(값은 정리를 마친 것 — 비유한 수는 null, 기준 없는 서프라이즈율은 null).
     *
     * @param smallBase |추정치| &lt; {@value #SMALL_BASE}. 추정치가 없으면 false
     */
    public record Entry(LocalDate reported, LocalDate periodEnd, Double actual, Double estimate, Double surprisePct,
                        String currency, boolean smallBase) {
    }

    /**
     * 한 종목의 결과.
     *
     * @param available 데이터셋이 있었는지 — false면 {@code entries}가 비고 {@link #compact()}는 null(자료 없음)
     * @param entries   기준일까지 발표된 최근 {@value #LAST}분기, 발표일 최신순
     */
    public record Result(boolean available, List<Entry> entries) {
        public Result {
            entries = entries == null ? List.of() : List.copyOf(entries);
        }

        /**
         * 패킷의 {@code eps} 칸 — {@link #COLUMNS} 순서의 배열 목록(발표일 최신순). 열 이름을 행마다 되풀이하면 25종목 × 4분기에
         * 수백 토큰이 더 들어 머리말에 한 번만 둡니다. 데이터셋이 없으면 null, 기준일 전 발표가 없으면 빈 목록.
         * 날짜는 ISO 글자, 수는 {@link BigDecimal}(지수 표기 없이 직렬화되도록 — 0.0004가 {@code 4.0E-4}로 나가지 않게).
         */
        public List<List<Object>> compact() {
            if (!available) {
                return null;
            }
            List<List<Object>> out = new ArrayList<>(entries.size());
            for (Entry e : entries) {
                // 칸에 null이 들어가므로 List.of를 쓰지 못합니다.
                List<Object> row = new ArrayList<>(COLUMNS.size());
                row.add(e.reported().toString());
                row.add(e.periodEnd() == null ? null : e.periodEnd().toString());
                row.add(number(e.actual(), EPS_SCALE));
                row.add(number(e.estimate(), EPS_SCALE));
                row.add(number(e.surprisePct(), PCT_SCALE));
                out.add(Collections.unmodifiableList(row));
            }
            return Collections.unmodifiableList(out);
        }

        /**
         * 고른 행들의 보고 통화 — 하나면 그것, 섞였으면 이름 순으로 쉼표로 이은 글자(드묾. 어느 분기가 어느 통화인지는 패킷에 없음),
         * 아무 행도 통화를 모르면 null.
         */
        public String currency() {
            TreeSet<String> seen = new TreeSet<>();
            entries.forEach(e -> {
                if (e.currency() != null) {
                    seen.add(e.currency());
                }
            });
            return seen.isEmpty() ? null : String.join(",", seen);
        }

        /** {@link #currency()}가 알려져 있고 USD 하나가 아니면 그 글자, 아니면 null(USD이거나 모름). */
        public String nonUsdCurrency() {
            String currency = currency();
            return currency == null || USD.equals(currency) ? null : currency;
        }

        /**
         * 작은 추정치 표시가 붙은 분기의 키 목록 — {@code 티커/분기 말}(분기 말을 모르면 {@code 티커/발표일}), 발표일 최신순. 패킷 머리말
         * {@code epsSmallBase}에 모아 싣습니다(행마다 칸을 하나 더 두는 것보다 짧음 — 해당 분기는 드묾).
         */
        public List<String> smallBaseKeys(String ticker) {
            List<String> out = new ArrayList<>();
            for (Entry e : entries) {
                if (e.smallBase()) {
                    out.add(ticker + "/" + (e.periodEnd() != null ? e.periodEnd() : e.reported()));
                }
            }
            return List.copyOf(out);
        }
    }

    /**
     * 측정 태그(명세 §6) — {@code measure.hasEarnings}·{@code measure.earningsRows}.
     *
     * @param hasEarnings  재무 섹션 줄 가운데 하나라도 분기가 1개 이상 있으면 true, 없으면 false, 데이터셋이 없으면 null
     * @param earningsRows 분기가 1개 이상 있는 재무 섹션 줄 수. 데이터셋이 없으면 null(0건과 구분)
     */
    public record Measure(Boolean hasEarnings, Integer earningsRows) {
    }

    /** 섹션의 줄별 결과 → 측정 태그. {@code available}이 false면 둘 다 null. */
    public static Measure measure(boolean available, Collection<Result> rows) {
        if (!available) {
            return new Measure(null, null);
        }
        int withEntries = 0;
        if (rows != null) {
            for (Result r : rows) {
                if (r != null && !r.entries().isEmpty()) {
                    withEntries++;
                }
            }
        }
        return new Measure(withEntries > 0, withEntries);
    }

    /** {@link #compute(Collection, LocalDate, Instant)}의 날짜 규칙만 쓰는 판(결정 시각으로 더 자르지 않음). */
    public static Result compute(Collection<Report> rows, LocalDate asOf) {
        return compute(rows, asOf, null);
    }

    /**
     * 한 종목의 최근 {@value #LAST}분기(클래스 설명).
     *
     * @param rows    그 종목의 저장본 행들(순서 무관, 기준일 뒤 행이 섞여 있어도 여기서 거름). 데이터셋이 없으면 null —
     *                {@link Result#available} false. 데이터셋은 있는데 이 종목 행이 없으면 빈 목록을 넘깁니다
     * @param asOf    기준 거래일(미국 동부 세션 날짜)
     * @param knownBy 결정 시각(모르면 null) — 발표 시각이 이보다 뒤인 행을 뺍니다
     */
    public static Result compute(Collection<Report> rows, LocalDate asOf, Instant knownBy) {
        Objects.requireNonNull(asOf, "기준 거래일이 없습니다");
        if (rows == null) {
            return new Result(false, List.of());
        }
        List<Report> visible = new ArrayList<>();
        for (Report r : rows) {
            if (r == null || r.reported() == null || r.reported().isAfter(asOf)) {
                continue;
            }
            if (knownBy != null && r.reportedAt() != null && r.reportedAt().isAfter(knownBy)) {
                continue;
            }
            visible.add(r);
        }
        // 전체 순서로 먼저 줄 세워 같은 분기는 '처음 만난 것 = 가장 늦은 발표'를 둡니다 — 입력 순서가 결과에 새지 않게.
        visible.sort(NEWEST_FIRST);
        Set<LocalDate> seenPeriods = new HashSet<>();
        List<Entry> out = new ArrayList<>(LAST);
        for (Report r : visible) {
            if (out.size() == LAST) {
                break;
            }
            if (r.periodEnd() != null && !seenPeriods.add(r.periodEnd())) {
                continue;
            }
            Entry entry = entry(r);
            if (!out.contains(entry)) {
                out.add(entry);
            }
        }
        return new Result(true, out);
    }

    /** 저장 행 → 패킷 분기(정리 규칙은 클래스 설명). */
    static Entry entry(Report r) {
        Double actual = finite(r.actual());
        Double estimate = finite(r.estimate());
        Double surprise = actual == null || estimate == null || estimate == 0.0 ? null : finite(r.surprisePct());
        boolean smallBase = estimate != null
                && (Boolean.TRUE.equals(r.smallBase()) || Math.abs(estimate) < SMALL_BASE);
        String currency = r.currency() == null || r.currency().isBlank() ? null : r.currency().strip();
        return new Entry(r.reported(), r.periodEnd(), actual, estimate, surprise, currency, smallBase);
    }

    /**
     * 발표일 최신순 — 같으면 발표 시각(늦은 것 먼저, 모르면 뒤) → 분기 말(늦은 것 먼저, 모르면 뒤) → 값. 같은 입력이면 늘 같은
     * 순서가 되도록 모든 칸을 봅니다.
     */
    static final Comparator<Report> NEWEST_FIRST = Comparator
            .comparing(Report::reported, Comparator.reverseOrder())
            .thenComparing(Report::reportedAt, Comparator.nullsLast(Comparator.reverseOrder()))
            .thenComparing(Report::periodEnd, Comparator.nullsLast(Comparator.reverseOrder()))
            .thenComparing(Report::actual, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(Report::estimate, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(Report::surprisePct, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(Report::currency, Comparator.nullsLast(Comparator.naturalOrder()))
            .thenComparing(Report::smallBase, Comparator.nullsLast(Comparator.naturalOrder()));

    private static Double finite(Double value) {
        return value == null || !Double.isFinite(value) ? null : value;
    }

    /**
     * 패킷 숫자 — 반올림(HALF_UP) 뒤 끝의 0을 지운 값({@code PacketBuilder.decimal}과 같은 규칙. 이 패키지는 java.*만 써서 그
     * 메서드를 부르지 못함). 0은 {@code 0}, 정수는 지수 없이({@code 1E+1}이 아니라 {@code 10}).
     */
    static BigDecimal number(Double value, int scale) {
        if (value == null || !Double.isFinite(value)) {
            return null;
        }
        BigDecimal out = BigDecimal.valueOf(value).setScale(scale, RoundingMode.HALF_UP).stripTrailingZeros();
        if (out.signum() == 0) {
            return BigDecimal.ZERO;
        }
        return out.scale() < 0 ? out.setScale(0) : out;
    }
}
