package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarWindow;
import com.macrodash.analytics.EarningsHistory;
import com.macrodash.analytics.NewsEvents;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 결정 기록의 측정 태그(2단계 명세 §6) — 그 결정의 패킷에 일정·사건·서프라이즈가 들어 있었는지. 8주 뒤 결정 로그에서 "일정이
 * 논거에 인용됐나·재량 주문이 늘었나"를 볼 때, 패킷 원문을 다시 열지 않고 이 태그로 결정을 가릅니다.
 *
 * <p>패킷을 만들 때 정하고(같은 패킷이면 같은 태그) 결정 기록의 응답 JSON에 {@code measure}로 옮깁니다. 아직 만들지 않은 항목은
 * {@code null}입니다 — {@code false}·0이면 "그 섹션이 있었고 비었다"로 읽혀, 섹션이 생기기 전 결정과 섞입니다.
 *
 * @param hasCalendar   {@code 1b_calendar}에 일정 저장본이 있었는지(창 안 0건이어도 true — 저장본이 없으면 false)
 * @param calendarItems 그 섹션의 줄 수(거시 + 실적). 저장본이 없으면 null(0건과 구분)
 * @param hasEvents     {@code 11b_events}에 실은 사건 헤드라인 건수(기능 B — {@link NewsEvents.Result#eventCount}). 섹션이 사건을
 *                      고르지 않았으면(설정으로 끔·저장본 없음·피드 선택 없음) null — 0은 '골랐는데 걸린 것이 없었다'
 * @param eventIds      그 헤드라인의 entity(제목 해시, 섹션 순서 — B6). hasEvents가 null이면 null
 * @param hasEarnings   {@code 8b_fundamentals}의 줄 가운데 하나라도 어닝 서프라이즈 분기({@code eps})가 1개 이상 있었는지(기능 C —
 *                      {@link EarningsHistory#measure}). 저장본이 있는데 기준일까지 알려진 발표가 없으면 false, 데이터셋이 없으면 null
 * @param earningsRows  분기가 1개 이상 있는 8b 줄 수(종목 수 — 분기 칸의 합이 아님). 데이터셋이 없으면 null(0건과 구분)
 */
record DecisionMeasure(boolean hasCalendar, Integer calendarItems, Integer hasEvents, List<String> eventIds,
                       Boolean hasEarnings, Integer earningsRows) {

    /** 결정 기록 응답 JSON의 키. */
    static final String KEY = "measure";

    DecisionMeasure {
        eventIds = eventIds == null ? null : List.copyOf(eventIds);
    }

    /** 일정 섹션만 정한 태그 — 사건·서프라이즈는 null({@link #withEvents}·{@link #withEarnings}로 더함). */
    static DecisionMeasure ofCalendar(CalendarWindow.Result calendar) {
        boolean has = calendar != null && calendar.available();
        return new DecisionMeasure(has, has ? calendar.rows().size() : null, null, null, null, null);
    }

    /**
     * 사건 섹션의 결과를 더한 태그. 결과가 없거나 섹션이 사건을 고르지 않았으면 두 칸 모두 null — 건수만 있고 목록이 비는(또는
     * 그 반대) 기록이 생기지 않게 둘을 함께 정합니다.
     */
    DecisionMeasure withEvents(NewsEvents.Result events) {
        Integer count = events == null ? null : events.eventCount();
        return new DecisionMeasure(hasCalendar, calendarItems, count, count == null ? null : events.eventIds(),
                hasEarnings, earningsRows);
    }

    /**
     * 재무 섹션 8b의 어닝 서프라이즈 결과를 더한 태그({@link FundamentalsSection.Built#earnings}). 결과가 없으면 두 칸 모두 null —
     * 사건과 같이 둘을 함께 정해 한쪽만 null인 기록이 생기지 않게.
     */
    DecisionMeasure withEarnings(EarningsHistory.Measure earnings) {
        boolean known = earnings != null && earnings.hasEarnings() != null && earnings.earningsRows() != null;
        return new DecisionMeasure(hasCalendar, calendarItems, hasEvents, eventIds,
                known ? earnings.hasEarnings() : null, known ? earnings.earningsRows() : null);
    }

    /**
     * 기록용 맵 — 키 순서를 고정하고 null 값도 남깁니다(패킷의 {@code toNode}가 넣은 순서 그대로 직렬화). 키가 빠지면 "태그가
     * 없던 판"과 "항목이 아직 없음"을 구분하지 못합니다.
     */
    Map<String, Object> toMap() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("hasCalendar", hasCalendar);
        out.put("calendarItems", calendarItems);
        out.put("hasEvents", hasEvents);
        out.put("eventIds", eventIds);
        out.put("hasEarnings", hasEarnings);
        out.put("earningsRows", earningsRows);
        return out;
    }
}
