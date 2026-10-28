package com.macrodash.analytics;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * 🧪 미국 Claude 패킷 {@code 1b_calendar} 거시 줄에 붙이는 컨센서스 층(v2 2단계 명세 §4-12·K22, E1b) — 미국 컨센서스 저장본
 * (수집기 {@code us_calendar_consensus}, Nasdaq 경제 캘린더 — ADR 0017과 같은 '비공식 참고'. 저장본 이름은 읽는 쪽인 패킷 조립에만 적음 —
 * 수집기 시험 {@code test_us_consensus}가 그 이름이 나오는 백엔드 파일을 대조)에서 그 줄의
 * 날짜(미국 동부)에 받은 줄 가운데 <b>대응표 이름의 줄 하나</b>를 공식 일정 줄(FRED 릴리스·FOMC 상수)에 붙입니다.
 *
 * <p><b>날짜는 공식 출처만 정합니다</b>: 이 층은 이미 창에 든 공식 줄({@link CalendarWindow.Row})에 값만 붙이고, Nasdaq에만 있는 발표를 줄로
 * 더하지 않습니다. 못 맞추면 값은 null이고 사유를 적습니다(지어내지 않음).
 *
 * <p><b>대응표</b>({@link #FOMC_NAME}·{@link #RELEASE_NAMES}) — 공식 줄의 열쇠는 표시 이름이 아니라 종류(FOMC)와 FRED 릴리스 번호이고, 값은
 * 그 발표의 머리 지표 하나의 Nasdaq 이름입니다. [확인] 2026-10-28 로컬 저장본(읽기 전용, 동부 10-28~11-13의 미국 행):
 * FOMC 10-28 {@code Fed Interest Rate Decision}(예상 4.00%) · GDP 10-29 {@code GDP} · PCE 10-29 {@code Core PCE Price Index} ·
 * 고용 11-06 {@code Nonfarm Payrolls} · CPI 11-10 {@code CPI}.
 *
 * <p><b>맞추기</b>: 이름이 대소문자·공백만 빼고 같고 <b>그 날 그 이름이 한 줄일 때만</b> 붙입니다. [확인] 같은 저장본에서 Nasdaq은 전월비·전년비를
 * 라벨 없이 같은 이름 두 줄로 줍니다({@code CPI}·{@code Core CPI}·{@code Core PCE Price Index}·{@code PPI}, {@code PCE price index}·
 * {@code PCE Price index}는 대소문자만 다름) — 응답 순서도 이름마다 달라(CPI는 전월비 먼저, Core CPI는 전년비 먼저) 순서나 값의 크기로 가르면
 * 지어낸 라벨이 됩니다. 그래서 두 줄 이상이면 '가를 수 없음'으로 두고 붙이지 않습니다(지금 저장본이면 CPI·PCE 줄은 늘 이 사유).
 *
 * <p><b>발표치</b>({@code actual})는 그 날을 받은 시각({@code fetchedAt})이 결정 순간 이하일 때만 싣습니다 — 결정 때 알 수 있던 값만.
 * 창이 기준일 다음 세션부터라 정기 결정에서는 늘 비고(명세 §4-12), 결정 순간 뒤에 다시 받은 저장본으로 만든 패킷(수동 실행 등)에
 * 그 뒤 발표치가 섞이지 않게 하는 거름입니다. 시계를 읽지 않아 같은 저장본·같은 줄·같은 결정 순간이면 같은 답입니다.
 */
public final class CalendarConsensus {

    private CalendarConsensus() {
    }

    /** FOMC 줄에 붙이는 Nasdaq 이름 — 금리 결정(예상치가 있는 줄. {@code FOMC Statement}·{@code FOMC Press Conference}는 값이 없음). */
    public static final String FOMC_NAME = "Fed Interest Rate Decision";

    /** FRED 릴리스 번호(수집기 {@code services.us_calendar.RELEASES}) → 그 발표의 머리 지표 Nasdaq 이름. 번호 순. */
    public static final Map<Integer, String> RELEASE_NAMES;

    static {
        Map<Integer, String> names = new TreeMap<>();
        names.put(10, "CPI");                    // CPI (Consumer Price Index) — BLS
        names.put(50, "Nonfarm Payrolls");       // Employment Situation — BLS
        names.put(53, "GDP");                    // GDP (Gross Domestic Product) — BEA
        names.put(54, "Core PCE Price Index");   // PCE (Personal Income and Outlays) — BEA
        RELEASE_NAMES = Collections.unmodifiableMap(names);
    }

    // ------------------------------------------------------------------ 사유(패킷에 그대로)
    static final String NO_MAPPING = "대응표에 없는 발표 — 컨센서스를 붙이지 않음";
    static final String OUTSIDE = "컨센서스 수집 범위 밖";
    static final String NO_DAY = "그 날 컨센서스를 받지 못함";
    static final String UNIT_MISMATCH = "Nasdaq 값의 단위가 서로 달라 숫자를 싣지 않음";
    static final String STALE = "그 날 이번 수집이 실패해 직전 수집본의 값";

    /**
     * Nasdaq 줄 하나(저장본 {@code days[날짜].rows[]}).
     *
     * @param forecast     예상치(Nasdaq {@code consensus}) — 없으면 null
     * @param unit         세 값이 함께 쓰는 단위(%·K·M·B·T·$…, 없거나 모르면 null)
     * @param unitMismatch 세 값의 단위가 서로 달라 수집기가 숫자를 모두 비운 줄
     */
    public record Line(String name, Double forecast, Double previous, Double actual, String unit, boolean unitMismatch) {
    }

    /**
     * 동부 날짜 하루(저장본 {@code days[날짜]}).
     *
     * @param fetchedAt 그 날을 받은 시각(모르면 null — 발표치를 싣지 않음)
     * @param isStale   이번 수집이 실패해 직전 저장본에서 이어받은 날
     */
    public record Day(List<Line> lines, Instant fetchedAt, boolean isStale) {
        public Day {
            lines = lines == null ? List.of() : List.copyOf(lines);
        }
    }

    /**
     * 저장본 하나.
     *
     * @param days    동부 날짜 → 그 날(받은 날만)
     * @param horizon 수집기가 물은 범위(저장본 {@code horizon}, 양 끝 포함 — 모르면 null). 그 밖 날짜는 '받지 못함'이 아니라 묻지 않은 날
     */
    public record Stored(Map<LocalDate, Day> days, CalendarWindow.Window horizon) {
        public Stored {
            days = days == null ? Map.of() : Collections.unmodifiableMap(new TreeMap<>(days));
        }
    }

    /**
     * 한 줄에 붙인 값.
     *
     * @param name 붙인 Nasdaq 줄 이름(저장본 글자 그대로). 못 붙였으면 null — 값도 모두 null
     * @param note 못 붙인 사유·붙인 값의 주의(이어받은 날·단위 어긋남). 없으면 null
     */
    public record Match(String name, Double forecast, Double previous, Double actual, String unit, String note) {

        static Match none(String note) {
            return new Match(null, null, null, null, null, note);
        }
    }

    /** 그 공식 줄에 붙일 Nasdaq 이름 — FOMC는 {@link #FOMC_NAME}, 발표일은 릴리스 번호로, 그 밖(실적·모르는 릴리스)은 null. */
    public static String target(CalendarWindow.Row row) {
        if (row == null) {
            return null;
        }
        if (CalendarWindow.FOMC.equals(row.kind())) {
            return FOMC_NAME;
        }
        if (CalendarWindow.RELEASE.equals(row.kind()) && row.releaseId() != null) {
            return RELEASE_NAMES.get(row.releaseId());
        }
        return null;
    }

    /**
     * 공식 줄 하나에 붙일 값(클래스 설명).
     *
     * @param stored  저장본(null이면 붙이지 않음 — 호출부가 '자료 없음'을 섹션에 한 번 적음, 여기서는 사유 없이 비움)
     * @param row     창 안의 거시 줄(FOMC·발표일)
     * @param knownBy 결정 순간 — 받은 시각이 이 이하인 날의 발표치만 실음(null이면 발표치를 싣지 않음)
     */
    public static Match match(Stored stored, CalendarWindow.Row row, Instant knownBy) {
        if (stored == null || row == null) {
            return Match.none(null);
        }
        String target = target(row);
        if (target == null) {
            return Match.none(NO_MAPPING);
        }
        CalendarWindow.Window horizon = stored.horizon();
        if (horizon != null && !horizon.contains(row.date())) {
            return Match.none(OUTSIDE + "(" + horizon.from() + "~" + horizon.to() + ")");
        }
        Day day = row.date() == null ? null : stored.days().get(row.date());
        if (day == null) {
            return Match.none(NO_DAY);
        }
        String wanted = normalize(target);
        List<Line> found = new ArrayList<>();
        for (Line line : day.lines()) {
            if (line != null && wanted.equals(normalize(line.name()))) {
                found.add(line);
            }
        }
        if (found.isEmpty()) {
            return Match.none("그 날 Nasdaq에 '" + target + "' 줄 없음");
        }
        if (found.size() > 1) {
            return Match.none("그 날 Nasdaq '" + target + "' 줄 " + found.size()
                    + "개(전월비·전년비 같은 라벨 없음) — 어느 값인지 가를 수 없어 붙이지 않음");
        }
        Line line = found.get(0);
        boolean known = day.fetchedAt() != null && knownBy != null && !day.fetchedAt().isAfter(knownBy);
        List<String> notes = new ArrayList<>();
        if (day.isStale()) {
            notes.add(STALE);
        }
        if (line.unitMismatch()) {
            notes.add(UNIT_MISMATCH);
        }
        boolean numbers = !line.unitMismatch();
        return new Match(line.name(), numbers ? line.forecast() : null, numbers ? line.previous() : null,
                numbers && known ? line.actual() : null, numbers ? line.unit() : null,
                notes.isEmpty() ? null : String.join(" · ", notes));
    }

    /** 이름 비교 — 앞뒤·겹친 공백을 줄이고 소문자로(Nasdaq이 대소문자·공백만 바꿔도 같은 줄). */
    static String normalize(String name) {
        if (name == null) {
            return "";
        }
        return String.join(" ", name.strip().split("\\s+")).toLowerCase(Locale.ROOT);
    }
}
