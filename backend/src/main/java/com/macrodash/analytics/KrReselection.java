package com.macrodash.analytics;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.temporal.TemporalAdjusters;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/**
 * 🧪 한국 규칙 계좌({@code kr_rules})의 재선정일과 재선정 따라잡기 — 2단계 명세 2026-10-26-v2-kr-paper-spec.md §4-6·K10·K33.
 *
 * <pre>
 *  예정 재선정일(설정 kr.rules.reselection)
 *    MONTHLY_FIRST  그 달 첫 KR 거래일
 *    TWICE_MONTHLY  그 달 첫째 월요일의 다음 거래일 · 셋째 월요일의 다음 거래일 (월요일이 거래일이어도 그 다음 거래일 — 보통 화요일)
 *  주기 r(d)   = d 이하에서 가장 늦은 예정 재선정일
 *  d의 선정    = r(d) ≤ x ≤ d인 매수 결정 x가 없으면 선정(cycleDate = r, selectionAsOf = d), 있으면 선정하지 않음(그날은 매도 신호·남는 현금만)
 * </pre>
 *
 * <p><b>따라잡기</b>(K33): 예정일 r의 결정이 게이트·기한·오류로 매수 결정이 되지 못했으면 다음 KR 결정일 r′마다 다시 선정합니다 — 입력은
 * r′의 자료(U(r′)·r′까지 20거래일 수급)이고 결정 행에 {@code cycleDate = r}·{@code selectionAsOf = r′}를 남깁니다. 그 주기에 매수 결정이
 * 생기면 더 하지 않고, 다음 예정일이 오면 그 주기로 넘어갑니다(놓친 주기는 버림 — 다음 주기의 선정이 그 자리를 대신함). r 기준으로 다시
 * 계산하지 않습니다: 수급 저장본이 D+1 06:50판으로 덮여 r 밤의 판을 다시 만들 수 없습니다(미국은 r 기준으로 따라잡음 — 13F는 시점 고정).
 *
 * <p><b>매수 결정</b>은 상태가 OK인 {@code REBALANCE}·{@code INITIAL} 결정입니다 — 부르는 쪽이 그 결정들의 기준 거래일만 넘깁니다.
 * 게이트·기한으로 쓴 {@code NO_TRADE} 행과 오류 행은 넣지 않습니다(넣으면 그 주기를 따라잡지 않음). 주기 판정을 결정 행의 저장된
 * {@code cycleDate}가 아니라 날짜 범위(r ≤ x ≤ d)로 하는 것은, 출발(INITIAL)이 그 주기 안에 있으면 따로 표시 없이 그 주기의 매수가 되고
 * (S ≥ r이면 S가 r ≤ x에 듦), 설정의 주기 방식이 바뀐 뒤에도 같은 규칙으로 읽히게 하려는 것입니다. d 당일의 매수 결정도 셉니다 —
 * 그날 결정을 이미 냈으면 선정하지 않는다고 답하므로, 그날 결정이 이미 있는지는 부르는 쪽이 먼저 봅니다(결정은 거래일·종류마다 한 건).
 *
 * <p>순수 클래스입니다(이 패키지는 {@code java.*}만). 거래일은 받은 달력({@link KrxCalendar} — 그 실행의 달력 한 벌)으로 셉니다. 달력이
 * 모르는 해에 닿으면 {@link CalendarUnavailableException}이 그대로 나갑니다(K35 fail-closed — 짐작한 재선정일을 쓰지 않음).
 */
public final class KrReselection {

    /** 재선정 주기(설정 {@code kr.rules.reselection}의 값 이름 그대로). */
    public enum Mode {
        /** 그 달 첫 KR 거래일(기본). */
        MONTHLY_FIRST,
        /** 그 달 첫째·셋째 월요일의 다음 거래일. */
        TWICE_MONTHLY
    }

    /**
     * 한 주기의 선정 — 결정 행에 남기는 두 날짜(K26·K33).
     *
     * @param cycleDate     그 주기의 예정 재선정일 r
     * @param selectionAsOf 입력(U·수급·재무 기준일)을 읽은 KR 세션 — 예정일 당일이면 r, 따라잡기면 그 뒤의 결정일 r′
     */
    public record Cycle(LocalDate cycleDate, LocalDate selectionAsOf) {

        public Cycle {
            Objects.requireNonNull(cycleDate, "cycleDate");
            Objects.requireNonNull(selectionAsOf, "selectionAsOf");
            if (selectionAsOf.isBefore(cycleDate)) {
                throw new IllegalArgumentException("선정 기준일(" + selectionAsOf + ")이 주기 예정일(" + cycleDate + ")보다 이릅니다");
            }
        }

        /** 예정일 r을 놓친 뒤의 선정인가(r′ > r). */
        public boolean catchUp() {
            return !cycleDate.equals(selectionAsOf);
        }
    }

    private KrReselection() {
    }

    /**
     * 그 달의 예정 재선정일(오름차순) — {@link Mode#MONTHLY_FIRST}는 한 날, {@link Mode#TWICE_MONTHLY}는 두 날.
     * {@link Mode#TWICE_MONTHLY}의 날은 월요일 다음 거래일이라, 월요일 뒤 연휴가 길면 다음 주로 밀릴 수 있습니다(2026-02-16 설날 → 02-19).
     *
     * @throws CalendarUnavailableException 달력이 그 달의 평일을 모름
     */
    public static List<LocalDate> scheduled(TradingCalendar calendar, Mode mode, YearMonth month) {
        Objects.requireNonNull(calendar, "calendar");
        Objects.requireNonNull(mode, "mode");
        Objects.requireNonNull(month, "month");
        if (mode == Mode.MONTHLY_FIRST) {
            return List.of(firstTradingDay(calendar, month));
        }
        LocalDate firstMonday = month.atDay(1).with(TemporalAdjusters.firstInMonth(DayOfWeek.MONDAY));
        LocalDate thirdMonday = firstMonday.plusWeeks(2);
        return List.of(calendar.nextTradingDay(firstMonday), calendar.nextTradingDay(thirdMonday));
    }

    /** d가 예정 재선정일인가. */
    public static boolean isScheduled(TradingCalendar calendar, Mode mode, LocalDate d) {
        return scheduled(calendar, mode, YearMonth.from(d)).contains(d);
    }

    /**
     * d가 속한 주기 r — d 이하에서 가장 늦은 예정 재선정일(그 달 또는 앞 달).
     *
     * @throws CalendarUnavailableException 달력이 그 두 달의 평일을 모름
     */
    public static LocalDate cycleOf(TradingCalendar calendar, Mode mode, LocalDate d) {
        Objects.requireNonNull(d, "d");
        YearMonth month = YearMonth.from(d);
        LocalDate best = null;
        // 이 달에 d 이하의 예정일이 있으면 그것이 답입니다(앞 달의 예정일은 앞 달 안에 있어 더 이름 — 셋째 월요일 뒤 2주 넘게 쉬어야
        // 이 달로 넘어옴). 없을 때만 앞 달을 봅니다 — 1월 첫 거래일 이후의 MONTHLY_FIRST가 전년 달력을 묻지 않게.
        for (LocalDate day : scheduled(calendar, mode, month)) {
            if (!day.isAfter(d) && (best == null || day.isAfter(best))) {
                best = day;
            }
        }
        if (best != null) {
            return best;
        }
        for (LocalDate day : scheduled(calendar, mode, month.minusMonths(1))) {
            if (!day.isAfter(d) && (best == null || day.isAfter(best))) {
                best = day;
            }
        }
        if (best == null) {
            throw new IllegalStateException(d + " 이하의 예정 재선정일을 두 달 안에서 찾지 못했습니다(" + mode + ")");
        }
        return best;
    }

    /**
     * 결정일(KR 세션) d에 선정하는가 — 클래스 설명의 규칙. 선정하면 그 주기와 기준일 d, 아니면 빈 값(그날은 매도 신호·남는 현금만).
     *
     * @param buyDecisionDates 이 계좌의 매수 결정(상태 OK인 REBALANCE·INITIAL)의 기준 거래일 — d 뒤의 날은 보지 않습니다. null이면 없음
     * @throws IllegalArgumentException     d가 KR 거래일이 아님(결정은 거래일에만 — 게이트 ⑥)
     * @throws CalendarUnavailableException 달력이 d나 그 앞 달을 모름
     */
    public static Optional<Cycle> selectionOn(TradingCalendar calendar, Mode mode, LocalDate session,
                                              Collection<LocalDate> buyDecisionDates) {
        requireTradingDay(calendar, session);
        LocalDate cycle = cycleOf(calendar, mode, session);
        if (buyDecisionDates != null) {
            for (LocalDate decided : buyDecisionDates) {
                if (decided != null && !decided.isBefore(cycle) && !decided.isAfter(session)) {
                    return Optional.empty();
                }
            }
        }
        return Optional.of(new Cycle(cycle, session));
    }

    /**
     * 출발(INITIAL, K28)의 선정 — 출발일 S가 속한 주기와 기준일 S. 재선정과 같은 계산이고(§4-6 '출발 배분'), 이 결정이 그 주기의 매수
     * 결정이 되어 S 뒤 같은 주기 안에서는 다시 선정하지 않습니다({@link #selectionOn}).
     *
     * @throws IllegalArgumentException S가 KR 거래일이 아님
     */
    public static Cycle initial(TradingCalendar calendar, Mode mode, LocalDate start) {
        requireTradingDay(calendar, start);
        return new Cycle(cycleOf(calendar, mode, start), start);
    }

    /** 그 달 첫 KR 거래일. */
    static LocalDate firstTradingDay(TradingCalendar calendar, YearMonth month) {
        for (LocalDate day = month.atDay(1); !day.isAfter(month.atEndOfMonth()); day = day.plusDays(1)) {
            if (calendar.isTradingDay(day)) {
                return day;
            }
        }
        throw new IllegalStateException(month + "에 거래일이 없습니다 — 달력(" + calendar + ")을 확인하세요");
    }

    private static void requireTradingDay(TradingCalendar calendar, LocalDate day) {
        Objects.requireNonNull(calendar, "calendar");
        Objects.requireNonNull(day, "day");
        if (!calendar.isTradingDay(day)) {
            throw new IllegalArgumentException(day + "는 KR 거래일이 아닙니다 — 규칙 계좌 결정은 거래일에만 냅니다");
        }
    }

    /**
     * from ≤ day ≤ to의 예정 재선정일(오름차순) — 한 해의 일정을 한 번에 보이는 자리(시험·기록).
     *
     * @throws CalendarUnavailableException 달력이 구간의 평일을 모름
     */
    public static List<LocalDate> scheduledBetween(TradingCalendar calendar, Mode mode, LocalDate from, LocalDate to) {
        List<LocalDate> out = new ArrayList<>();
        for (YearMonth month = YearMonth.from(from); !month.isAfter(YearMonth.from(to)); month = month.plusMonths(1)) {
            for (LocalDate day : scheduled(calendar, mode, month)) {
                if (!day.isBefore(from) && !day.isAfter(to) && !out.contains(day)) {
                    out.add(day);
                }
            }
        }
        out.sort(null);
        return out;
    }
}
