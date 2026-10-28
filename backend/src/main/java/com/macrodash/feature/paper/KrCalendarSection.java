package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarWindow;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 🧪 한국 Claude 패킷의 일정 섹션 {@code 1b_calendar}(2단계 명세 §4-11·K20, E1a) — 저장본 {@code calendar.kr_events}(수집기 {@code kr_calendar}, B9 —
 * 금통위 상수·주요 발표 상수, 앞으로 45일)를 기준 세션 다음 KR 거래일부터 10거래일 창({@link CalendarWindow#window(TradingCalendar, LocalDate)} —
 * 미국과 같은 길이, 그 실행의 {@code KrxCalendar})으로 자릅니다.
 *
 * <ul>
 *   <li>거시 줄({@code macro.rows}) = 창 안의 {@code macro.events}(금통위 {@code MPB}·발표 {@code RELEASE}) — 날짜 → 종류(MPB 먼저) → 이름 순. 출처
 *       글은 범례({@code sources})에 한 번(미국 1b와 같은 방식).</li>
 *   <li><b>날짜를 옮기지 않은 발표는 따로 적습니다</b>({@code unconfirmed} — G8 전에는 소비자물가·고용·GDP 속보·경상수지·수출입 다섯 모두 '일정 미확인').
 *       빈 표가 '창 안에 발표 없음'으로 읽히지 않게 — 날짜를 지어내지 않습니다.</li>
 *   <li>금통위 상수({@code bok})·날짜를 옮긴 발표의 확인 끝({@code through})을 창 끝이 넘으면 '갱신 필요 — 미게시'(지어내지 않음). 창이 저장본의 수집
 *       범위({@code macro.horizon}) 밖으로 나가면 확인한 범위를 적습니다.</li>
 *   <li>실적·컨센서스는 출처가 없어 {@code earnings: null}·{@code consensus: null}과 사유(빈 목록은 0건으로 읽힘 — K20).</li>
 * </ul>
 *
 * <p><b>시점</b>: 저장본의 수집 시각이 읽은 순간 뒤면 쓰지 않습니다(그 순간에는 없던 판 — '자료 없음'과 사유). 앞날 일정이라 초기(출발) 결정도
 * 같은 저장본이고, 한국 출발은 그 밤 수집본으로 내므로 {@code asOfMismatch}는 늘 false입니다(명세 §5 '출발 결정의 입력은 결정 시각 전에 수집된 S 밤 판').
 * 시계를 읽지 않아 같은 저장본·같은 기준일·같은 읽은 순간이면 같은 섹션입니다.
 */
final class KrCalendarSection {

    private KrCalendarSection() {
    }

    static final String SOURCE = "snapshot " + Datasets.SNAP_KR_CALENDAR + " — 금통위 상수·주요 발표 상수(수집기 kr_calendar)";
    static final List<String> MACRO_COLUMNS = CalendarSection.MACRO_COLUMNS;
    static final String NEEDS_UPDATE = "갱신 필요 — 미게시";
    static final String OK = "ok";
    static final String UNITS = "KST 날짜, 금통위(MPB)는 통화정책방향 결정일";
    static final String UNCONFIRMED_NOTE = "공식 공표일정에서 날짜를 옮기기 전 — 이 발표들의 날짜는 패킷에 없음(일정 없음이 아님, 지어내지 않음)";
    static final String NO_EARNINGS = "한국 실적 발표 일정 출처 없음";
    static final String NO_CONSENSUS = "한국 컨센서스 출처 없음";
    private static final List<String> KIND_ORDER = List.of("MPB", "RELEASE");

    /** 섹션 본문과 측정 태그 재료(저장본이 있었나·줄 수). */
    record Built(Map<String, Object> section, boolean available, int rows) {
    }

    /**
     * @param snapshot 읽은 저장본(없으면 빈 Optional — "자료 없음")
     * @param calendar 그 실행의 한국 달력
     * @param asOf     기준 KR 세션 D
     * @param readAt   읽은 순간 — 저장본 수집 시각이 이 뒤면 쓰지 않음
     */
    static Built build(Optional<Snapshot> snapshot, TradingCalendar calendar, LocalDate asOf, Instant readAt) {
        CalendarWindow.Window window = CalendarWindow.window(calendar, asOf);
        Snapshot snap = snapshot == null ? null : snapshot.orElse(null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", SOURCE);
        out.put("generatedAtKst", snap == null || snap.collectedAt() == null ? null : snap.collectedAtKst());
        Map<String, Object> w = new LinkedHashMap<>();
        w.put("from", window.from().toString());
        w.put("to", window.to().toString());
        out.put("window", w);
        out.put("note", CalendarSection.NOTE);
        out.put("asOfMismatch", false);
        JsonNode payload = snap == null ? null : snap.payload();
        String missing = snap == null || payload == null || !payload.isObject() ? "자료 없음 — 한국 일정 저장본(" + Datasets.SNAP_KR_CALENDAR + ")이 없습니다"
                : snap.collectedAt() == null ? "자료 없음 — 저장본 수집 시각을 모름(결정 전 판인지 확인할 수 없음)"
                : snap.collectedAt().isAfter(readAt) ? "자료 없음 — 저장본이 읽은 순간 뒤에 수집됨(" + snap.collectedAtKst() + ")"
                : null;
        if (missing != null) {
            out.put("missing", missing);
            out.put("earnings", null);
            out.put("earningsNote", NO_EARNINGS);
            out.put("consensus", null);
            out.put("consensusNote", NO_CONSENSUS);
            return new Built(out, false, 0);
        }
        JsonNode macro = Json.child(payload, "macro");

        // 창 안 거시 줄 — 날짜 → 종류 → 이름.
        record Event(LocalDate date, String kind, String name, String source) {
        }
        List<Event> events = new ArrayList<>();
        for (JsonNode e : Json.array(macro, "events")) {
            LocalDate date = Json.parseDate(text(e, "date"));
            if (date == null || date.isBefore(window.from()) || date.isAfter(window.to())) {
                continue;
            }
            events.add(new Event(date, text(e, "kind"), text(e, "name"), text(e, "source")));
        }
        events.sort(Comparator.comparing(Event::date)
                .thenComparingInt(e -> e.kind() == null || !KIND_ORDER.contains(e.kind()) ? KIND_ORDER.size()
                        : KIND_ORDER.indexOf(e.kind()))
                .thenComparing(Event::name, Comparator.nullsLast(Comparator.naturalOrder())));
        Map<String, String> codes = new LinkedHashMap<>();
        List<List<Object>> rows = new ArrayList<>();
        for (Event e : events) {
            String code = e.source() == null ? null : codes.computeIfAbsent(e.source(), s -> "s" + (codes.size() + 1));
            List<Object> row = new ArrayList<>(MACRO_COLUMNS.size());
            row.add(e.date().toString());
            row.add(e.kind());
            row.add(e.name());
            row.add(code);
            rows.add(row);
        }

        // 금통위 상수 — 상태는 저장본의 것(수집 창 45일 기준)이 아니라 이 패킷의 창이 상수 끝을 넘는지로.
        JsonNode bok = Json.child(macro, "bok");
        LocalDate bokThrough = Json.parseDate(text(bok, "through"));
        Map<String, Object> bokOut = new LinkedHashMap<>();
        bokOut.put("checkedAt", text(bok, "checkedAt"));
        bokOut.put("through", bokThrough == null ? null : bokThrough.toString());
        boolean bokPast = bokThrough == null || window.to().isAfter(bokThrough);
        bokOut.put("status", bok == null ? null : bokPast ? NEEDS_UPDATE : OK);
        if (bok != null && bokPast && text(bok, "note") != null) {
            bokOut.put("note", text(bok, "note"));
        }
        out.put("bok", bokOut);

        // 날짜를 옮긴 발표의 확인 끝·날짜를 옮기지 않은 발표.
        JsonNode releases = Json.child(macro, "releases");
        List<String> unconfirmedKeys = new ArrayList<>();
        for (JsonNode key : Json.array(macro, "unconfirmed")) {
            if (key != null && key.isString()) {
                unconfirmedKeys.add(key.asString());
            }
        }
        List<Map<String, Object>> unconfirmed = new ArrayList<>();
        List<Map<String, Object>> pastConstant = new ArrayList<>();
        if (releases != null && releases.isObject()) {
            for (Map.Entry<String, JsonNode> entry : releases.properties()) {
                JsonNode r = entry.getValue();
                LocalDate through = Json.parseDate(text(r, "through"));
                if (unconfirmedKeys.contains(entry.getKey()) || through == null) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("key", entry.getKey());
                    row.put("name", text(r, "name"));
                    row.put("agency", text(r, "agency"));
                    row.put("status", text(r, "status"));
                    unconfirmed.add(row);
                } else if (window.to().isAfter(through)) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("key", entry.getKey());
                    row.put("name", text(r, "name"));
                    row.put("through", through.toString());
                    row.put("status", NEEDS_UPDATE);
                    pastConstant.add(row);
                }
            }
        }
        out.put("units", UNITS);
        Map<String, Object> table = new LinkedHashMap<>();
        table.put("columns", MACRO_COLUMNS);
        table.put("rows", rows);
        out.put("macro", table);
        if (!unconfirmed.isEmpty()) {
            out.put("unconfirmed", unconfirmed);
            out.put("unconfirmedNote", UNCONFIRMED_NOTE);
        }
        if (!pastConstant.isEmpty()) {
            out.put("releasesPastConstant", pastConstant);
        }
        JsonNode horizon = Json.child(macro, "horizon");
        LocalDate horizonTo = Json.parseDate(text(horizon, "to"));
        if (horizonTo != null && window.to().isAfter(horizonTo)) {
            Map<String, Object> h = new LinkedHashMap<>();
            h.put("from", text(horizon, "from"));
            h.put("to", horizonTo.toString());
            out.put("horizon", h);
            out.put("horizonNote", CalendarSection.HORIZON_NOTE);
        }
        Map<String, String> sources = new LinkedHashMap<>();
        codes.forEach((source, code) -> sources.put(code, source));
        out.put("sources", sources);
        out.put("earnings", null);
        String earningsNote = text(payload, "earningsNote");
        out.put("earningsNote", earningsNote == null ? NO_EARNINGS : earningsNote);
        out.put("consensus", null);
        String consensusNote = text(payload, "consensusNote");
        out.put("consensusNote", consensusNote == null ? NO_CONSENSUS : consensusNote);
        return new Built(out, true, rows.size());
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = Json.child(node, field);
        return v != null && v.isString() ? v.asString() : null;
    }
}
