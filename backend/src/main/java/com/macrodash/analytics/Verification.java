package com.macrodash.analytics;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.Month;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

/**
 * 교차 검증 판정 규칙.
 *
 * <p>이 프로젝트는 공식 API와 비공식 스크래핑을 섞어 씁니다. 비공식 소스는 대상
 * 페이지 구조가 바뀌면 <b>예외를 던지지 않고 조용히 틀린 값</b>을 주기 시작하고,
 * 화면만 봐서는 알아챌 방법이 없습니다. 그래서 "같은 것을 재는 독립된 두 출처"를
 * 붙여 놓고 값이 갈라지는 순간을 잡습니다.
 *
 * <p><b>핵심 원칙 — "확인 못 함"과 "일치"를 절대 섞지 않습니다.</b> 키가 없거나
 * 한쪽 수집이 실패해 비교 자체를 못 한 경우를 "일치"로 표시하면 검증이
 * 거짓말이 됩니다. 판정은 네 가지로 구분됩니다.
 */
public final class Verification {

    private Verification() {
    }

    public static final String MATCH = "match";        // 허용 오차 안에서 일치
    public static final String MISMATCH = "mismatch";  // 갈라짐 → 조사 필요
    public static final String SKIPPED = "skipped";    // 비교 불가 (키 없음/장 시간)
    public static final String ERROR = "error";        // 한쪽 이상 수집 실패

    /** 확정 종가끼리라면 사실상 같아야 합니다. */
    public static final double TOLERANCE_PRICE_PCT = 0.5;
    /** KRX 확정 집계와 KIS HTS 표시 기준이 미세하게 달라 여유를 둡니다. */
    public static final double TOLERANCE_OI_PCT = 2.0;
    /** 등락률은 비율값이라 상대 오차가 아니라 절대 %p 차이로 봅니다. */
    public static final double TOLERANCE_CHANGE_PP = 0.05;

    /**
     * 한 출처가 말한 값 한 건.
     *
     * @param asOf 이 값의 <b>기준 거래일</b>(yyyy-MM-dd). 모르면 null.
     *             기준일이 다른 값을 비교하면 "불일치"가 아니라 그냥 다른 날을
     *             본 것이므로, 판정 전에 이 값으로 걸러 냅니다.
     */
    public record Reading(String source, boolean ok, Double value, String detail, String asOf) {
        public Reading(String source, boolean ok, Double value, String detail) {
            this(source, ok, value, detail, null);
        }

        public static Reading failed(String source, String detail) {
            return new Reading(source, false, null, detail, null);
        }

        /** 기준일을 아는 읽기값. */
        public static Reading dated(String source, Double value, String detail, String asOf) {
            return new Reading(source, true, value, detail, asOf);
        }
    }

    public record Result(String name, String verdict, List<Reading> readings,
                         Double tolerancePct, Double diffPct, String note) {
        public String label() {
            return switch (verdict) {
                case MATCH -> "일치";
                case MISMATCH -> "불일치";
                case SKIPPED -> "확인 못 함";
                case ERROR -> "수집 실패";
                default -> verdict;
            };
        }
    }

    /**
     * 두 개 이상의 읽기값을 비교합니다.
     *
     * <p>비교 가능한 값이 2개 미만이면 {@link #SKIPPED}(실패가 있으면 {@link #ERROR})
     * 입니다. 이때를 "일치"로 처리하면 검증이 거짓말을 하게 됩니다.
     */
    public static Result compare(String name, List<Reading> readings,
                                 double tolerancePct, String skipNote) {
        return compare(name, readings, tolerancePct, skipNote, null);
    }

    /**
     * 두 개 이상의 읽기값을 비교합니다.
     *
     * @param referenceDate 이번 검증이 기준으로 삼는 최신 거래일(yyyy-MM-dd, 모르면 null).
     *                      기준일을 아는 읽기값이 이 날짜보다 오래됐으면 비교하지
     *                      않고 {@link #SKIPPED}입니다.
     */
    public static Result compare(String name, List<Reading> readings,
                                 double tolerancePct, String skipNote,
                                 String referenceDate) {
        List<Reading> usable = readings.stream()
                .filter(r -> r.ok() && r.value() != null)
                .toList();

        if (usable.size() < 2) {
            boolean anyFailed = readings.stream().anyMatch(r -> !r.ok());
            String note = skipNote;
            if (anyFailed && (note == null || note.isBlank())) {
                note = "비교하려면 최소 두 출처가 필요합니다.";
            }
            return new Result(name, anyFailed ? ERROR : SKIPPED, readings,
                    tolerancePct, null, note);
        }

        // ── 기준일 게이트 ───────────────────────────────────────────────
        // 다른 날의 값을 비교하면 "불일치"가 아니라 그냥 다른 날을 본 것입니다.
        // KRX 확정치는 하루 이상 지연되는 반면 KIS는 최신값을 주므로, 이 검사가
        // 없으면 KRX가 밀린 날마다 매번 거짓 경보가 울립니다.
        String staleNote = staleNote(usable, referenceDate);
        if (staleNote != null) {
            return new Result(name, SKIPPED, readings, tolerancePct, null, staleNote);
        }

        double low = usable.stream().mapToDouble(Reading::value).min().orElseThrow();
        double high = usable.stream().mapToDouble(Reading::value).max().orElseThrow();
        double base = low == 0 ? 1.0 : Math.abs(low);
        double diffPct = (high - low) / base * 100.0;

        boolean match = diffPct <= tolerancePct;
        String note = match ? "" :
                "출처가 서로 다른 값을 말하고 있습니다. 비공식 소스의 페이지 구조 변경이나 "
                        + "단위 오해를 의심하세요.";

        return new Result(name, match ? MATCH : MISMATCH, readings, tolerancePct, diffPct, note);
    }

    /**
     * 비교해도 되는 기준일인지 확인하고, 아니면 그 이유를 돌려줍니다.
     *
     * <p>두 가지를 봅니다.
     * <ol>
     *   <li>기준일을 아는 읽기값끼리 날짜가 다르면 → 비교 불가</li>
     *   <li>기준일을 아는 읽기값이 이번 검증의 최신 거래일보다 오래됐으면 → 비교 불가
     *       (기준일을 모르는 출처는 보통 '현재가'라 최신입니다)</li>
     * </ol>
     *
     * @return 비교해도 되면 null, 아니면 화면에 띄울 사유
     */
    private static String staleNote(List<Reading> usable, String referenceDate) {
        List<Reading> dated = usable.stream()
                .filter(r -> r.asOf() != null && !r.asOf().isBlank())
                .toList();
        if (dated.isEmpty()) {
            return null;
        }

        String newest = dated.stream().map(Reading::asOf).max(String::compareTo).orElseThrow();
        String oldest = dated.stream().map(Reading::asOf).min(String::compareTo).orElseThrow();

        if (!newest.equals(oldest)) {
            return "기준일이 서로 다릅니다 (%s). 다른 날의 값을 비교한 것이므로 "
                    .formatted(describeDates(dated))
                    + "불일치로 판정하지 않습니다.";
        }

        // 날짜를 아는 값끼리는 같은 날. 이번 검증의 최신 거래일보다 오래됐는지 봅니다.
        if (referenceDate != null && !referenceDate.isBlank()
                && newest.compareTo(referenceDate) < 0) {
            return ("이 값들의 기준일은 %s인데 이번 검증의 최신 거래일은 %s입니다. "
                    + "KRX 확정치는 하루 이상 늦게 올라오는 반면 KIS는 최신값을 주므로, "
                    + "지금 비교하면 날짜가 다른 값을 대조하게 됩니다. "
                    + "KRX 확정치가 올라온 뒤 'make collect'로 다시 수집하세요.")
                    .formatted(newest, referenceDate);
        }
        return null;
    }

    private static String describeDates(List<Reading> dated) {
        return dated.stream()
                .map(r -> "%s=%s".formatted(r.source(), r.asOf()))
                .reduce((a, b) -> a + ", " + b)
                .orElse("");
    }

    public static Result skipped(String name, String reason) {
        return new Result(name, SKIPPED, List.of(), null, null, reason);
    }

    /**
     * 지금이 '확정 종가끼리 비교해도 되는 시간'인지.
     *
     * <p>KRX는 <b>일별 확정 종가</b>를, KIS는 <b>현재가</b>를 줍니다. 장중에 이 둘을
     * 비교하면 항상 다르게 나오므로 매일 거짓 경보가 울립니다. 장이 닫힌 뒤에만
     * 비교합니다.
     */
    public static Gate settledGate(ZonedDateTime nowKst) {
        return settledGate(nowKst, false);
    }

    /**
     * @param holiday 오늘이 한국 공휴일인가. 평일 공휴일 09:00~16:29를 장중으로 보면 KRX 확정치가
     *                있는데도 하루 종일 대조를 건너뜁니다. 연말 휴장일은 주말 대체만 봅니다 — 공휴일 대체까지 보려면
     *                {@link #settledGate(ZonedDateTime, Set)}
     */
    public static Gate settledGate(ZonedDateTime nowKst, boolean holiday) {
        return settledGate(nowKst, holiday, isKrxYearEndClosure(nowKst.toLocalDate()));
    }

    /**
     * 공휴일 목록(천문연)을 받은 판 — 오늘이 공휴일인지와 KRX 연말 휴장일(12-31이 주말·공휴일이면 직전 매매거래일, QA-143)을
     * 그 목록으로 봅니다. 운영자 수집 검증({@code VerificationService})이 씁니다.
     *
     * @param holidays 저장된 한국 공휴일(없으면 빈 집합 — 연말 휴장일은 주말 대체만)
     */
    public static Gate settledGate(ZonedDateTime nowKst, Set<LocalDate> holidays) {
        LocalDate today = nowKst.toLocalDate();
        return settledGate(nowKst, holidays.contains(today), isKrxYearEndClosure(today, holidays));
    }

    private static Gate settledGate(ZonedDateTime nowKst, boolean holiday, boolean yearEndClosure) {
        if (nowKst.getDayOfWeek() == DayOfWeek.SATURDAY
                || nowKst.getDayOfWeek() == DayOfWeek.SUNDAY) {
            return new Gate(true, "주말 (확정 데이터)");
        }
        if (holiday) {
            return new Gate(true, "공휴일 (확정 데이터)");
        }
        if (yearEndClosure) {
            return new Gate(true, "KRX 연말 휴장일 (확정 데이터)");
        }
        LocalTime time = nowKst.toLocalTime();
        if (time.isAfter(LocalTime.of(16, 29))) {
            return new Gate(true, "장 마감 후 (확정 데이터)");
        }
        if (time.isBefore(LocalTime.of(9, 0))) {
            return new Gate(true, "장 시작 전 (전 거래일 확정 데이터)");
        }
        return new Gate(false,
                "장중입니다. KRX는 전 거래일 확정 종가, KIS는 현재가를 주므로 지금 비교하면 "
                        + "항상 다르게 나옵니다. 장 마감 후 다시 확인하세요.");
    }

    /**
     * 지금이 '장중 가집계끼리 비교해도 되는 시간'인지.
     *
     * <p>가격·지수와 <b>시간 조건이 정반대</b>입니다. KIS 가집계 TR은 장중 전용이라
     * 마감 후에는 빈 데이터를 정상적으로 돌려줍니다.
     */
    public static Gate intradayGate(ZonedDateTime nowKst) {
        return intradayGate(nowKst, false);
    }

    /**
     * @param holiday 오늘이 한국 공휴일인가. 휴장일에는 가집계 TR이 빈 값을 주므로, 장 시간에 대조하면
     *                운영자 진단에 거짓 오류가 납니다(QA-111). 연말 휴장일은 주말 대체만 봅니다 — 공휴일 대체까지 보려면
     *                {@link #intradayGate(ZonedDateTime, Set)}
     */
    public static Gate intradayGate(ZonedDateTime nowKst, boolean holiday) {
        return intradayGate(nowKst, holiday, isKrxYearEndClosure(nowKst.toLocalDate()));
    }

    /**
     * 공휴일 목록(천문연)을 받은 판 — {@link #settledGate(ZonedDateTime, Set)}와 같은 휴장 판정.
     *
     * @param holidays 저장된 한국 공휴일(없으면 빈 집합 — 연말 휴장일은 주말 대체만)
     */
    public static Gate intradayGate(ZonedDateTime nowKst, Set<LocalDate> holidays) {
        LocalDate today = nowKst.toLocalDate();
        return intradayGate(nowKst, holidays.contains(today), isKrxYearEndClosure(today, holidays));
    }

    private static Gate intradayGate(ZonedDateTime nowKst, boolean holiday, boolean yearEndClosure) {
        if (nowKst.getDayOfWeek() == DayOfWeek.SATURDAY
                || nowKst.getDayOfWeek() == DayOfWeek.SUNDAY) {
            return new Gate(false, "주말입니다. 장중 가집계 비교는 정규장에만 가능합니다.");
        }
        if (holiday || yearEndClosure) {
            return new Gate(false, "휴장일입니다. 장중 가집계 비교는 정규장에만 가능합니다.");
        }
        LocalTime time = nowKst.toLocalTime();
        boolean open = !time.isBefore(LocalTime.of(9, 0)) && time.isBefore(LocalTime.of(15, 30));
        return open
                ? new Gate(true, "정규장")
                : new Gate(false,
                "정규장(09:00~15:30)이 아닙니다. KIS 가집계 TR은 장중 전용이라 지금은 "
                        + "빈 데이터를 돌려줍니다.");
    }

    /**
     * KRX 연말 휴장일인가(공휴일 목록 없이 — 주말 대체만). {@link #isKrxYearEndClosure(LocalDate, Set)}의 빈 목록 판.
     */
    public static boolean isKrxYearEndClosure(LocalDate date) {
        return isKrxYearEndClosure(date, Set.of());
    }

    /**
     * KRX 연말 휴장일인가 — 12-31, 그날이 주말·공휴일이면 거슬러 올라가 처음 만나는 평일 비공휴일(직전 매매거래일). 공휴일이 아니라
     * 거래소 규정이라 천문연 공휴일 목록에 없습니다. KRX 휴장일 목록의 실례가 2022-12-30(12-31 토)·2023-12-29(12-31 일)이고
     * 다음은 2028-12-29입니다 — 평일인 12-31만 보던 예전 판은 그날을 장중으로 봤습니다(QA-143).
     *
     * <p>모의 매매 한국 달력과 같은 식입니다({@link KrxCalendar#yearEndClosure(int, Set)}). 화면({@code lib/marketCalendar.ts}
     * {@code krYearEndClosure})·수집기({@code krcalendar.year_end_closure})도 같습니다(QA-142).
     *
     * @param holidays 그해 한국 공휴일(빈 집합이면 주말 대체만)
     */
    public static boolean isKrxYearEndClosure(LocalDate date, Set<LocalDate> holidays) {
        return date.getMonth() == Month.DECEMBER && date.equals(KrxCalendar.yearEndClosure(date.getYear(), holidays));
    }

    public record Gate(boolean allowed, String reason) {
    }

    /** 검증 1회분 요약. */
    public record Report(String checkedAt, List<Result> results,
                         int matchCount, int mismatchCount,
                         int errorCount, int skippedCount) {

        public static Report of(String checkedAt, List<Result> results) {
            List<Result> safe = new ArrayList<>(results);
            return new Report(
                    checkedAt, safe,
                    count(safe, MATCH), count(safe, MISMATCH),
                    count(safe, ERROR), count(safe, SKIPPED));
        }

        private static int count(List<Result> results, String verdict) {
            return (int) results.stream().filter(r -> verdict.equals(r.verdict())).count();
        }

        public String headline() {
            return "일치 %d · 불일치 %d · 수집 실패 %d · 확인 못 함 %d"
                    .formatted(matchCount, mismatchCount, errorCount, skippedCount);
        }
    }
}
