package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;

import java.time.Instant;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 🧪 정기 작업의 '달력 없음'(2단계 명세 §4-4·K35, §9 묶음 A 리뷰 메모 'B5 — 달력이 모르는 날') — 시장 달력이 앞으로 쓸 창의 해를
 * 모를 때({@link PaperMarket#requireCalendarWindow}) 결정·리스크 점검·복기 작업이 그 시장 실행을 멈추고 작업 기록
 * ({@code paper_job_runs})에 {@value #NO_CALENDAR}로 남기는 내용과, 같은 사유를 되풀이해 남기지 않는 장부입니다.
 *
 * <p>정기 실행은 5~30분마다 돌므로 빠진 해가 채워질 때까지 매번 남기면 작업 기록(작업마다 최근 200건)이 이 한 줄로 밀립니다. 그래서
 * 시장마다 (KST 날짜, 빠진 해)가 바뀔 때만 남깁니다 — 하루 한 번, 빠진 해가 달라지면 다시. 창을 다시 알게 되면 잊어서({@link #clear})
 * 다음에 또 빠지면 그날 다시 남깁니다. 재기동하면 처음부터 셉니다(결정 작업의 오류 횟수와 같음). 수동 실행은 이 장부를 보지 않습니다.
 */
final class CalendarGaps {

    /** 작업 기록의 결과(outcome) — 그 시장 달력이 앞 창의 해를 모름. */
    static final String NO_CALENDAR = "NO_CALENDAR";

    /** 시장 코드 → 마지막으로 남긴 (KST 날짜/빠진 해). */
    private final Map<String, String> noted = new ConcurrentHashMap<>();

    /** 이번에 남길 차례인가 — 그 시장의 같은 KST 날짜·같은 빠진 해로는 처음일 때만 참(그리고 남긴 것으로 적어 둠). */
    boolean firstToday(PaperMarket market, Instant now, CalendarUnavailableException e) {
        LocalDate today = now.atZone(Kst.ZONE).toLocalDate();
        String key = today + "/" + e.year();
        return !key.equals(noted.put(market.code(), key));
    }

    /** 그 시장 달력이 창을 다시 앎 — 남긴 기억을 지웁니다. */
    void clear(PaperMarket market) {
        noted.remove(market.code());
    }

    /** 작업 기록 detail — {@code reason}('달력 없음')·{@code year}(빠진 해)·{@code message}(달력이 준 설명). */
    static Map<String, Object> detail(CalendarUnavailableException e) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("reason", CalendarUnavailableException.REASON);
        out.put("year", e.year());
        out.put("message", e.getMessage());
        return out;
    }
}
