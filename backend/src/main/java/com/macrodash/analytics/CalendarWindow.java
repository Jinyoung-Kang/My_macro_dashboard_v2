package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.TreeSet;

/**
 * 🧪 Claude 패킷의 일정 섹션 {@code 1b_calendar}(2단계 명세 A1·A2·A4)에 실을 줄 — 저장본(수집기 {@code us_calendar} 태스크의
 * {@code calendar.us_events})에서 기준 거래일 뒤 10거래일 창 안의 거시 일정(FOMC·FRED 발표일)과 대상 종목 실적일만 고릅니다.
 *
 * <p><b>창</b>: 기준일 <b>다음</b> 세션부터 기준일 + 10거래일까지(양 끝 포함, {@link UsMarketCalendar}) — 주문이 체결될 수 있는 첫
 * 세션부터입니다. 기준일 당일 일정은 넣지 않습니다. 그래서 기준일 장 마감 뒤(AMC) 실적은 기준일 종가에 없는데도 빠집니다(결정은
 * 다음 날 07:30 KST라 발표는 이미 나왔음 — 그 결과(EPS·서프라이즈)는 결정 시각 전에 나와 수집됐으면 재무 섹션
 * {@code 8b_fundamentals}의 {@code eps}({@link EarningsHistory})에 듦). 창 안의 휴장일·주말 날짜에 일정이
 * 있으면(드묾) 날짜로는 창 안이라 넣습니다. 창은 시계가 아니라 기준일로만 정합니다 — 같은 저장본이면 언제 만들어도 같은 줄(패킷
 * 해시가 결정적, {@code PacketBuilder} 설명).
 *
 * <p><b>없는 일정을 만들지 않습니다</b>: 저장본이 없으면 줄 없이 사유만({@link Result#missingReason}), 지난 실적일만 보이면(수집기의
 * '다음 일정 미정' — {@code lastDate}만 있음, 또는 받은 날짜가 그새 창 앞으로 지남 — 24시간 캐시) '다음 일정 미정'
 * ({@link Result#earningsUndetermined}), 그 밖에 실적일이 없으면 '자료 없음'({@link Result#earningsMissing})으로 구분해 적습니다 —
 * 셋 다 "창 안에 일정 없음"과 다른 말입니다(명세 §1 "0건과 실패를 구분"). 창 뒤의 실적일은 알려진 일정이라 어느 목록에도 넣지
 * 않습니다. FRED는 그해 12-31까지만 날짜를 주므로 릴리스마다 받은 가장 늦은 날짜({@code lastKnownDate})보다 창 끝이 뒤면 그
 * 릴리스는 '일정 미공개'로 따로 적습니다({@link Result#unpublishedAfter}). FOMC 상수의 끝보다 창 끝이 뒤면
 * {@link Result#fomcPastConstant}. 저장본의 거시 일정은 수집 범위({@code macro.horizon} — 수집한 날부터 45일) 안뿐이라, 창이 그
 * 밖으로 나가면(수집기가 오래 멈춰 저장본이 묵음) {@link Result#outsideHorizon} — 그 밖 날짜의 FOMC·발표일은 '없음'이 아니라 확인하지
 * 못한 것입니다.
 *
 * <p>값은 손대지 않고 옮깁니다(장 구분·추정 여부·출처·isStale) — 장 구분을 어떻게 읽었는지(UTC 12:30 → 장전 등)는 수집기가 정하고
 * 여기서 다시 판단하면 두 곳의 규칙이 갈라집니다. 이 섹션은 정보일 뿐 주문을 막거나 강제하지 않습니다(D35 — 검증기 불변).
 */
public final class CalendarWindow {

    private CalendarWindow() {
    }

    /** 창 길이(거래일) — 명세 A4. */
    public static final int TRADING_DAYS = 10;

    /** 줄 종류. 같은 날짜면 이 순서(거시 → 실적)로 읽힙니다. */
    public static final String FOMC = "FOMC";
    public static final String RELEASE = "RELEASE";
    public static final String EARNINGS = "EARNINGS";
    private static final List<String> KIND_ORDER = List.of(FOMC, RELEASE, EARNINGS);

    /** FOMC 경제전망(SEP) 회의를 이름에 붙이는 꼬리 — 점도표가 나오는 회의라 같은 FOMC라도 무게가 다릅니다. */
    static final String SEP_SUFFIX = " (SEP)";

    /**
     * 저장본의 거시 일정 한 건({@code macro.events[]}).
     *
     * @param kind    {@link #FOMC}·{@link #RELEASE}
     * @param sep     FOMC 경제전망 회의인지(FOMC만, 모르면 null)
     * @param isStale 이번 수집이 실패해 직전 저장본에서 이어받은 일정인지(모르면 null)
     */
    public record MacroEvent(String name, LocalDate date, String kind, Integer releaseId, String source, Boolean sep,
                             Boolean isStale) {
    }

    /**
     * 저장본의 실적 일정 한 종목({@code earnings.items.TICKER}).
     *
     * @param date        다음 실적 발표일(미국 동부 날짜) — 모르면 null. 받은 뒤 날짜가 지나 창 앞일 수도 있음(24시간 캐시)
     * @param lastDate    앞날 일정이 없을 때 마지막으로 보인(지난) 발표일 — 수집기의 '다음 일정 미정'. 그 밖이면 null.
     *                    date가 없으면 이 날짜로 창에 대 봅니다(창 안이면 그 날짜로 한 줄)
     * @param session     BMO(장전)·AMC(장후)·null(그 밖·추정치)
     * @param isEstimated 회사 확정 전 추정 날짜인지({@code isEarningsDateEstimate}, 모르면 null)
     */
    public record Earnings(String ticker, LocalDate date, LocalDate lastDate, String session, Boolean isEstimated,
                           String source, Boolean isStale) {
    }

    /**
     * 저장본 하나({@code calendar.us_events}의 payload를 옮긴 것).
     *
     * @param fredStatus    FRED 부분 상태(ok·키 미설정·실패, 모르면 null) — 키가 없어도 FOMC 상수는 {@code macroEvents}에 있습니다
     * @param lastKnownDate 릴리스 이름 → 받은 가장 늦은 발표일(받은 날짜가 없으면 null 값)
     * @param fredStale     FRED 일부가 직전 저장본에서 이어받은 값인지(모르면 null)
     * @param fomcSource    FOMC 상수의 출처(연준 일정표 주소)
     * @param fomcCheckedAt FOMC 상수를 확인한 날(글자 그대로)
     * @param fomcThrough   FOMC 상수의 마지막 날짜(없으면 null)
     * @param earnings      종목(대문자) → 실적 일정
     * @param covered       실적 일정을 받아 둔 종목 수(모르면 null)
     * @param universe      실적 일정 대상(유니버스 주식) 수(모르면 null)
     * @param horizon       거시 일정을 수집한 범위({@code macro.horizon}, 양 끝 포함 — 모르면 null). {@code macroEvents}는 이 안뿐
     */
    public record Stored(List<MacroEvent> macroEvents, String fredStatus, Map<String, LocalDate> lastKnownDate,
                         Boolean fredStale, String fomcSource, String fomcCheckedAt, LocalDate fomcThrough,
                         Map<String, Earnings> earnings, Integer covered, Integer universe, Window horizon) {
        public Stored {
            macroEvents = macroEvents == null ? List.of() : List.copyOf(macroEvents);
            // 값에 null(받은 날짜 없음)이 있어 Map.copyOf를 쓸 수 없고, 순서가 결과에 새지 않게 이름 순으로 둡니다.
            lastKnownDate = lastKnownDate == null ? Map.of() : Collections.unmodifiableMap(new TreeMap<>(lastKnownDate));
            earnings = earnings == null ? Map.of() : Collections.unmodifiableMap(new TreeMap<>(earnings));
        }
    }

    /** 창 — 양 끝 포함. */
    public record Window(LocalDate from, LocalDate to) {
        public boolean contains(LocalDate date) {
            return date != null && !date.isBefore(from) && !date.isAfter(to);
        }
    }

    /**
     * 섹션 한 줄.
     *
     * @param name        거시 일정 이름 또는 티커(실적)
     * @param session     실적만(BMO·AMC·null). 거시 일정은 null
     * @param isEstimated 실적만. 거시 일정은 null(공식 일정표)
     * @param releaseId   FRED 릴리스 번호(발표일 줄만 — 저장본 {@code releaseId}). FOMC·실적·모르면 null. 패킷 열이 아니라 컨센서스 층이
     *                    그 줄의 발표를 가리는 열쇠입니다(2단계 명세 K22·E1b — 표시 이름보다 바뀌지 않는 값)
     */
    public record Row(LocalDate date, String kind, String name, String session, Boolean isEstimated, String source,
                      Boolean isStale, Integer releaseId) {

        /** 릴리스 번호 없는 줄(실적·시험). */
        public Row(LocalDate date, String kind, String name, String session, Boolean isEstimated, String source,
                   Boolean isStale) {
            this(date, kind, name, session, isEstimated, source, isStale, null);
        }
    }

    /**
     * 계산 결과.
     *
     * @param available            저장본이 있었는지 — false면 줄이 없고 {@code missingReason}이 사유
     * @param rows                 창 안의 일정(날짜 → 종류 → 이름 순)
     * @param unpublishedAfter     창 끝이 lastKnownDate보다 뒤인 릴리스 → 그 날짜(받은 날짜가 없으면 null 값). 이름 순
     * @param fomcPastConstant     창 끝이 FOMC 상수의 끝보다 뒤인지(상수 끝을 모르면 null)
     * @param outsideHorizon       창이 저장본의 거시 수집 범위를 벗어나는지 — 앞이 범위 앞보다 이르거나 끝이 범위 끝보다 뒤(범위를
     *                             모르거나 저장본이 없으면 null)
     * @param earningsUndetermined 대상 중 알려진 실적일(앞날 일정, 없으면 지난 발표일)이 창 앞인 종목(다음 일정 미정), 티커 순
     * @param earningsMissing      대상 중 저장본에 실적일이 하나도 없는 종목, 티커 순
     */
    public record Result(Window window, boolean available, String missingReason, List<Row> rows,
                         Map<String, LocalDate> unpublishedAfter, Boolean fomcPastConstant, Boolean outsideHorizon,
                         List<String> earningsUndetermined, List<String> earningsMissing) {

        /** 창 안의 거시 일정 수(FOMC + 발표일). */
        public int macroCount() {
            return (int) rows.stream().filter(r -> !EARNINGS.equals(r.kind())).count();
        }

        /** 창 안의 실적 일정 수. */
        public int earningsCount() {
            return (int) rows.stream().filter(r -> EARNINGS.equals(r.kind())).count();
        }
    }

    /** 저장본이 없을 때의 사유(패킷에 그대로). */
    public static final String NO_SNAPSHOT = "자료 없음 — 일정 저장본이 없습니다";

    /** 기준일 다음 세션 … 기준일 + {@value #TRADING_DAYS}거래일(미국 달력 — {@link #window(TradingCalendar, LocalDate)}). */
    public static Window window(LocalDate asOf) {
        return window(UsMarketCalendar.CALENDAR, asOf);
    }

    /**
     * 기준일 다음 세션 … 기준일 + {@value #TRADING_DAYS}거래일, 그 시장 달력으로.
     *
     * @param calendar 기준일이 속한 시장의 거래일 달력
     */
    public static Window window(TradingCalendar calendar, LocalDate asOf) {
        Objects.requireNonNull(calendar, "거래일 달력이 없습니다");
        Objects.requireNonNull(asOf, "기준 거래일이 없습니다");
        return new Window(calendar.nextTradingDay(asOf), calendar.addTradingDays(asOf, TRADING_DAYS));
    }

    /**
     * 창 안의 줄(클래스 설명). 창은 미국 달력으로 셉니다 — {@link #compute(TradingCalendar, Stored, LocalDate, Collection)}.
     *
     * @param stored  저장본. 없으면 null — 줄 없이 {@link #NO_SNAPSHOT}
     * @param asOf    기준 거래일(미국 동부 세션 날짜)
     * @param targets 실적일을 실을 종목(보유·후보 — ETF는 호출부가 뺌, 대소문자·앞뒤 공백 무관). null이면 없음
     */
    public static Result compute(Stored stored, LocalDate asOf, Collection<String> targets) {
        return compute(UsMarketCalendar.CALENDAR, stored, asOf, targets);
    }

    /**
     * 창 안의 줄(클래스 설명), 창은 그 시장 달력으로({@link #window(TradingCalendar, LocalDate)}).
     *
     * @param calendar 기준일이 속한 시장의 거래일 달력
     * @param stored   저장본. 없으면 null — 줄 없이 {@link #NO_SNAPSHOT}
     * @param asOf     기준 거래일(그 시장의 세션 날짜)
     * @param targets  실적일을 실을 종목(대소문자·앞뒤 공백 무관). null이면 없음
     */
    public static Result compute(TradingCalendar calendar, Stored stored, LocalDate asOf, Collection<String> targets) {
        Window window = window(calendar, asOf);
        if (stored == null) {
            return new Result(window, false, NO_SNAPSHOT, List.of(), Map.of(), null, null, List.of(), List.of());
        }

        List<Row> rows = new ArrayList<>();
        for (MacroEvent e : stored.macroEvents()) {
            if (!window.contains(e.date())) {
                continue;
            }
            String name = e.name();
            if (Boolean.TRUE.equals(e.sep()) && name != null && !name.contains("SEP")) {
                name = name + SEP_SUFFIX;
            }
            rows.add(new Row(e.date(), e.kind(), name, null, null, e.source(), e.isStale(), e.releaseId()));
        }

        // 같은 종목이 대소문자만 달리 두 번 들어와도 한 줄 — 티커 순으로 돌아 목록 순서도 입력 순서와 무관합니다.
        TreeSet<String> wanted = new TreeSet<>();
        if (targets != null) {
            for (String t : targets) {
                if (t != null && !t.isBlank()) {
                    wanted.add(t.strip().toUpperCase(Locale.ROOT));
                }
            }
        }
        List<String> undetermined = new ArrayList<>();
        List<String> missing = new ArrayList<>();
        for (String ticker : wanted) {
            Earnings e = stored.earnings().get(ticker);
            // 앞날 일정이 없으면 지난 발표일로 창에 대 봅니다 — 기준일이 수집보다 앞인 초기 결정 패킷(2026-10-23)을 나중에 다시
            // 만들면 그 '지난' 발표가 기준일에서는 창 안의 앞날 일정입니다. 정기 결정은 수집이 기준일 저녁이라 늘 창 앞입니다.
            LocalDate known = e == null ? null : e.date() != null ? e.date() : e.lastDate();
            if (known == null) {
                missing.add(ticker);
            } else if (known.isBefore(window.from())) {
                undetermined.add(ticker);
            } else if (!known.isAfter(window.to())) {
                rows.add(new Row(known, EARNINGS, ticker, e.session(), e.isEstimated(), e.source(), e.isStale()));
            }
            // 창 뒤의 실적일은 싣지 않습니다 — 알려진 일정이고 창 밖일 뿐(자료 없음과 다름).
        }

        List<Row> ordered = rows.stream().distinct().sorted(ORDER).toList();

        Map<String, LocalDate> unpublished = new TreeMap<>();
        stored.lastKnownDate().forEach((release, last) -> {
            if (last == null || window.to().isAfter(last)) {
                unpublished.put(release, last);
            }
        });
        Boolean pastConstant = stored.fomcThrough() == null ? null : window.to().isAfter(stored.fomcThrough());
        // 저장본이 굳으면(수집기가 계속 실패) 창이 수집 범위 밖으로 나가는데, 상수 끝·lastKnownDate만으로는 드러나지 않습니다 —
        // FOMC는 상수 끝까지 'ok', 릴리스는 FRED가 아는 날짜가 범위보다 뒤일 수 있음. 범위 밖 날짜는 0건이 아니라 확인 못 함입니다.
        Window horizon = stored.horizon();
        Boolean outsideHorizon = horizon == null || horizon.from() == null || horizon.to() == null ? null
                : window.from().isBefore(horizon.from()) || window.to().isAfter(horizon.to());

        return new Result(window, true, null, ordered, Collections.unmodifiableMap(unpublished), pastConstant,
                outsideHorizon, List.copyOf(undetermined), List.copyOf(missing));
    }

    /** 날짜 → 종류(FOMC·RELEASE·EARNINGS, 모르는 종류는 뒤에 이름 순) → 이름 → 출처. null은 앞. */
    static final Comparator<Row> ORDER = Comparator.comparing(Row::date)
            .thenComparingInt(r -> kindRank(r.kind()))
            .thenComparing(Row::kind, Comparator.nullsFirst(Comparator.naturalOrder()))
            .thenComparing(Row::name, Comparator.nullsFirst(Comparator.naturalOrder()))
            .thenComparing(Row::source, Comparator.nullsFirst(Comparator.naturalOrder()));

    private static int kindRank(String kind) {
        int index = kind == null ? -1 : KIND_ORDER.indexOf(kind);
        return index < 0 ? KIND_ORDER.size() : index;
    }
}
