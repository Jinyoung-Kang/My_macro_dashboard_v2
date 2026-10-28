package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarConsensus;
import com.macrodash.analytics.CalendarWindow;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;

/**
 * 🧪 Claude 패킷의 일정 섹션 {@code 1b_calendar}(2단계 명세 A4) — 저장본({@code calendar.us_events}) payload를
 * {@link CalendarWindow} 입력으로 옮기고, 창 안의 거시 일정({@code macro})과 대상 종목 실적일({@code earnings})을 {@code 8_prices}와
 * 같은 열 배열로 펼칩니다. 두 표 모두 날짜 순(같은 날이면 FOMC → 발표일, 이름·티커 순 — {@link CalendarWindow}의 순서)입니다.
 *
 * <p>읽기는 {@link PacketBuilder}가 {@code StoreReader.quietly} 안에서 하고, 대상 종목 고르기(보유·섹션 7 후보 — 8b와 같은 대상,
 * ETF 제외)도 장부·신호를 아는 PacketBuilder 몫입니다. 이 클래스는 같은 저장본·같은 기준일·같은 대상이면 같은 섹션(결정적)만
 * 보장합니다 — 시계를 읽지 않고, 갱신 시각은 저장본의 수집 시각입니다.
 *
 * <p><b>크기</b>: 패킷은 이미 목표(30,000토큰) 가까이 찹니다(상한을 꽉 채운 시험 패킷이 이 섹션 없이 약 29,100). 한 표에 모두 넣으면
 * 거시 줄의 장 구분·추정 칸이 늘 비고 줄마다 종류 글자가 붙어, 실적 25종목 + 거시 6건에서 섹션이 약 840토큰이었습니다. 그래서
 * 거시·실적을 두 표로 나눠 빈 칸을 없애고, 출처는 줄마다 남기되 글자는 범례({@code sources})에 한 번만 두며(25종목이 모두 같은
 * yfinance 출처라 줄마다 쓰면 약 300토큰이 같은 글자의 반복), 거의 늘 비는 isStale은 열 대신 해당 줄 이름만 {@code stale}에
 * 적습니다. 출처 코드는 날짜 순으로 처음 나온 순서(s1, s2 …)라 같은 입력이면 같은 코드입니다.
 *
 * <p>초기 결정(기준일 2026-10-23)에도 앞날 일정은 지금 수집본뿐이라 매크로 카드처럼 {@code asOfMismatch:true}를 붙입니다.
 *
 * <p><b>컨센서스 층</b>(2단계 명세 §4-12·K22, E1b — 설정 {@code calendar.consensus}가 켜졌을 때만, {@link Consensus}): 거시 줄에
 * {@code forecast}·{@code previous}·{@code unit}·{@code consensusSource} 열을 더하고({@link CalendarConsensus}가 같은 날 Nasdaq 줄 하나를 붙임 —
 * 못 붙인 줄은 값 null + {@code consensus.notes}의 사유), 결정 순간 전에 받은 발표치가 한 줄이라도 있으면 {@code actual} 열도 둡니다(늘 비는
 * 열을 싣지 않음 — 창이 기준일 다음 세션부터라 정기 결정에서는 없음). 꺼져 있으면 섹션은 한 글자도 다르지 않습니다(미국 판 5 고정본).
 */
final class CalendarSection {

    private CalendarSection() {
    }

    /** 명세 A4의 문구 그대로 — 이 섹션은 판단 자료이고 주문을 막지 않습니다(D35, 검증기 불변). */
    static final String NOTE = "일정이 매매를 막지 않는다. 판단에 쓸 뿐";
    /** 거시 일정 한 줄의 열(1b_calendar.macro.columns) — 장 구분·추정 여부는 실적에만 있어 뺍니다. */
    static final List<String> MACRO_COLUMNS = List.of("date", "kind", "name", "source");
    /**
     * 실적 일정 한 줄의 열(1b_calendar.earnings.columns). 실적은 출처가 하나(yfinance 한 경로 — 명세 §1)라 줄의 출처가 모두 같으면
     * 출처 열을 빼고 표에 {@code source} 하나만 둡니다({@link #EARNINGS_COLUMNS_ONE_SOURCE}) — 25줄에 같은 코드 약 50토큰.
     */
    static final List<String> EARNINGS_COLUMNS = List.of("date", "ticker", "session", "isEstimated", "source");
    static final List<String> EARNINGS_COLUMNS_ONE_SOURCE = EARNINGS_COLUMNS.subList(0, EARNINGS_COLUMNS.size() - 1);
    static final String FOMC_NEEDS_UPDATE = "갱신 필요";
    /** 수집기 us_calendar의 FRED 부분 상태 — 키가 없을 때(collector/app/tasks/us_calendar.py). */
    static final String FRED_KEY_MISSING = "키 미설정";
    static final String FOMC_OK = "ok";
    /** 명세 A1 "일정 미공개(~날짜까지만 확인)". */
    static final String UNPUBLISHED_NOTE = "이 날짜 뒤 발표일은 일정 미공개(이 날짜까지만 확인)";
    static final String AS_OF_NOTE = "앞날 일정 — 현재 수집본, 참고만";
    /** 창이 저장본의 거시 수집 범위({@code horizon}) 밖일 때 — 그 밖 날짜의 거시 일정이 빈 것은 '없음'이 아님. */
    static final String HORIZON_NOTE = "거시 일정은 이 기간에 수집한 것뿐 — 창 중 이 밖의 날짜는 확인하지 못함(일정 없음이 아님)";
    /** 열·목록 설명 — 창(from·to)과 열 이름이 말하는 것은 빼고 헷갈릴 것만. */
    static final String UNITS = "미국 동부 날짜, FOMC는 성명일. nextDateUnknown = 지난 실적일만 있음";
    /** 컨센서스 층을 켰을 때 거시 줄 끝에 더하는 열(E1b) — {@code actual}은 결정 순간 전에 받은 발표치가 있을 때만 {@code previous} 뒤에. */
    static final List<String> CONSENSUS_COLUMNS = List.of("forecast", "previous", "unit", "consensusSource");
    static final String ACTUAL_COLUMN = "actual";
    /** 컨센서스 출처 — 수집기 us_calendar_consensus(B9)가 받는 곳. */
    static final String CONSENSUS_PROVIDER = "Nasdaq 경제 캘린더(비공식 참고)";
    static final String CONSENSUS_NOTE = "날짜는 공식 일정(FRED·FOMC)이 정하고 값은 같은 날 Nasdaq 줄 하나를 대응표로 붙임"
            + "(consensusSource = 그 줄 이름). forecast = 예상치(null이면 아직 없음), previous = 직전 발표치. 못 붙인 줄은 notes";
    static final String CONSENSUS_MISSING = "자료 없음 — 컨센서스 저장본이 없습니다";

    /**
     * 컨센서스 층 입력 — 설정 {@code calendar.consensus}가 켜졌을 때만 넘깁니다(꺼짐 = null — 섹션 그대로).
     *
     * @param dataset  저장본 이름(출처 문구 — {@code Datasets})
     * @param snapshot 읽은 저장본(없으면 빈 Optional — "자료 없음", 거시 줄의 컨센서스 칸은 null)
     * @param knownBy  결정 순간 — 받은 시각이 이 이하인 날의 발표치만 실음({@link CalendarConsensus#match})
     */
    record Consensus(String dataset, Optional<Snapshot> snapshot, Instant knownBy) {
    }

    /** 섹션 본문과 결정 기록의 측정 태그. */
    record Built(Map<String, Object> section, DecisionMeasure measure, CalendarWindow.Result result) {
    }

    /**
     * 저장본 payload → 계산 입력. 칸이 빠지거나 형이 틀리면 null로 둡니다(0·false로 채우지 않음). 객체가 아니면 null — 저장본이
     * 없는 것과 같게 "자료 없음"으로 적습니다.
     */
    static CalendarWindow.Stored stored(JsonNode payload) {
        if (payload == null || !payload.isObject()) {
            return null;
        }
        JsonNode macro = Json.child(payload, "macro");
        List<CalendarWindow.MacroEvent> events = new ArrayList<>();
        for (JsonNode e : Json.array(macro, "events")) {
            if (e == null || !e.isObject()) {
                continue;
            }
            events.add(new CalendarWindow.MacroEvent(string(e, "name"), Json.parseDate(string(e, "date")),
                    string(e, "kind"), integer(e, "releaseId"), string(e, "source"), bool(e, "sep"),
                    bool(e, "isStale")));
        }
        JsonNode fred = Json.child(macro, "fred");
        Map<String, LocalDate> lastKnown = new TreeMap<>();
        JsonNode known = Json.child(fred, "lastKnownDate");
        if (known != null && known.isObject()) {
            for (Map.Entry<String, JsonNode> entry : known.properties()) {
                JsonNode value = entry.getValue();
                // 받은 날짜가 없는 릴리스(null)도 남깁니다 — 창이 어디든 '일정 미공개'로 적어야 하는 릴리스입니다.
                lastKnown.put(entry.getKey(), value == null || !value.isString() ? null
                        : Json.parseDate(value.asString("")));
            }
        }
        JsonNode fomc = Json.child(macro, "fomc");
        // 수집 범위 — 한쪽이라도 읽을 수 없으면 null(범위를 모르면 '범위 밖'을 지어내지 않음).
        JsonNode horizonNode = Json.child(macro, "horizon");
        LocalDate horizonFrom = Json.parseDate(string(horizonNode, "from"));
        LocalDate horizonTo = Json.parseDate(string(horizonNode, "to"));
        CalendarWindow.Window horizon = horizonFrom == null || horizonTo == null ? null
                : new CalendarWindow.Window(horizonFrom, horizonTo);
        JsonNode earnings = Json.child(payload, "earnings");
        Map<String, CalendarWindow.Earnings> items = new TreeMap<>();
        JsonNode raw = Json.child(earnings, "items");
        if (raw != null && raw.isObject()) {
            for (Map.Entry<String, JsonNode> entry : raw.properties()) {
                String ticker = entry.getKey().strip().toUpperCase(Locale.ROOT);
                JsonNode v = entry.getValue();
                if (ticker.isEmpty() || v == null || !v.isObject()) {
                    continue;
                }
                items.put(ticker, new CalendarWindow.Earnings(ticker, Json.parseDate(string(v, "date")),
                        Json.parseDate(string(v, "lastDate")), string(v, "session"), bool(v, "isEstimated"),
                        string(v, "source"), bool(v, "isStale")));
            }
        }
        return new CalendarWindow.Stored(events, string(fred, "status"), lastKnown, bool(fred, "isStale"),
                string(fomc, "source"), string(fomc, "checkedAt"), Json.parseDate(string(fomc, "through")),
                items, integer(earnings, "covered"), integer(earnings, "universe"), horizon);
    }

    /**
     * 섹션 본문.
     *
     * @param dataset  저장본 이름(출처 문구 — {@code Datasets})
     * @param snapshot 읽은 저장본(없으면 빈 Optional — "자료 없음")
     * @param asOf     기준 거래일
     * @param targets  실적일 대상 종목(보유·후보, ETF 제외)
     * @param initial  초기 결정 패킷(asOfMismatch)
     */
    static Built build(String dataset, Optional<Snapshot> snapshot, LocalDate asOf, Collection<String> targets,
                       boolean initial) {
        return build(dataset, snapshot, asOf, targets, initial, null);
    }

    /**
     * 섹션 본문 — 컨센서스 층을 켰으면({@code consensus} ≠ null) 거시 줄에 컨센서스 열을 더합니다(클래스 설명).
     *
     * @param consensus 컨센서스 층 입력. null이면 층 없음(설정 {@code calendar.consensus} 꺼짐 — 섹션은 판 5 그대로)
     */
    static Built build(String dataset, Optional<Snapshot> snapshot, LocalDate asOf, Collection<String> targets,
                       boolean initial, Consensus consensus) {
        Snapshot snap = snapshot == null ? null : snapshot.orElse(null);
        CalendarWindow.Stored stored = stored(snap == null ? null : snap.payload());
        CalendarWindow.Result r = CalendarWindow.compute(stored, asOf, targets);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("source", "snapshot " + dataset);
        out.put("generatedAtKst", stored == null || snap.collectedAt() == null ? null : snap.collectedAtKst());
        Map<String, Object> window = new LinkedHashMap<>();
        window.put("from", r.window().from().toString());
        window.put("to", r.window().to().toString());
        out.put("window", window);
        out.put("note", NOTE);
        out.put("asOfMismatch", initial);
        if (initial) {
            out.put("asOfNote", AS_OF_NOTE);
        }
        if (!r.available()) {
            // 빈 표를 두지 않습니다 — 빈 표는 "창 안에 일정 0건"으로 읽힙니다.
            out.put("missing", r.missingReason() + "(" + dataset + ")");
            return new Built(out, DecisionMeasure.ofCalendar(r), r);
        }

        out.put("fredStatus", stored.fredStatus());
        if (Boolean.TRUE.equals(stored.fredStale())) {
            out.put("fredIsStale", true);
        }
        out.put("lastKnownDate", dates(stored.lastKnownDate()));
        // 키가 없으면 수집기가 릴리스마다 lastKnownDate를 null로 둬 모든 릴리스가 '미공개'로 잡힙니다 — 일정이 아직 안 나온 것이
        // 아니라 설정 문제이고 fredStatus가 이미 말하므로 겹쳐 적지 않습니다(명세 §2-3 "키 미설정으로 비고").
        if (!r.unpublishedAfter().isEmpty() && !FRED_KEY_MISSING.equals(stored.fredStatus())) {
            out.put("unpublishedAfter", dates(r.unpublishedAfter()));
            out.put("unpublishedNote", UNPUBLISHED_NOTE);
        }
        if (Boolean.TRUE.equals(r.outsideHorizon())) {
            // 저장본이 굳어 창이 수집 범위 밖으로 나감 — 표가 비면 'FOMC·발표 없음'으로 읽히므로 확인한 범위를 적습니다. 범위 안이면
            // 늘 같은 말이라 적지 않습니다(크기).
            Map<String, Object> horizon = new LinkedHashMap<>();
            horizon.put("from", stored.horizon().from().toString());
            horizon.put("to", stored.horizon().to().toString());
            out.put("horizon", horizon);
            out.put("horizonNote", HORIZON_NOTE);
        }
        // FOMC 일정표 주소는 FOMC 줄이 있으면 sources 범례에 있어 머리말에는 확인일·끝만(같은 주소 두 번 = 약 20토큰). 상태는
        // 저장본의 fomc.status(수집 창 45일 기준 — 화면 몫)가 아니라 이 패킷의 창이 상수 끝을 넘는지로 정합니다.
        Map<String, Object> fomc = new LinkedHashMap<>();
        fomc.put("checkedAt", stored.fomcCheckedAt());
        fomc.put("through", stored.fomcThrough() == null ? null : stored.fomcThrough().toString());
        fomc.put("status", r.fomcPastConstant() == null ? null
                : r.fomcPastConstant() ? FOMC_NEEDS_UPDATE : FOMC_OK);
        out.put("fomc", fomc);
        out.put("units", UNITS);
        Snapshot consensusSnap = consensus == null || consensus.snapshot() == null ? null
                : consensus.snapshot().orElse(null);
        CalendarConsensus.Stored consensusStored = consensus == null ? null
                : consensusStored(consensusSnap == null ? null : consensusSnap.payload());
        Map<String, Object> consensusOut = null;
        if (consensus != null) {
            consensusOut = new LinkedHashMap<>();
            consensusOut.put("source", "snapshot " + consensus.dataset() + " — " + CONSENSUS_PROVIDER);
            if (consensusStored == null) {
                consensusOut.put("missing", CONSENSUS_MISSING + "(" + consensus.dataset() + ")");
            } else {
                consensusOut.put("generatedAtKst", consensusSnap.collectedAt() == null ? null
                        : consensusSnap.collectedAtKst());
                consensusOut.put("note", CONSENSUS_NOTE);
            }
            out.put("consensus", consensusOut);
        }

        Map<String, String> codes = new LinkedHashMap<>();
        List<List<Object>> macroRows = new ArrayList<>();
        List<CalendarConsensus.Match> matches = new ArrayList<>();
        List<List<Object>> earningsRows = new ArrayList<>();
        List<String> stale = new ArrayList<>();
        for (CalendarWindow.Row row : r.rows()) {
            String code = row.source() == null ? null
                    : codes.computeIfAbsent(row.source(), source -> "s" + (codes.size() + 1));
            List<Object> values = new ArrayList<>();
            values.add(row.date().toString());
            if (CalendarWindow.EARNINGS.equals(row.kind())) {
                values.add(row.name());
                values.add(row.session());
                values.add(row.isEstimated());
                values.add(code);
                earningsRows.add(values);
            } else {
                values.add(row.kind());
                values.add(row.name());
                values.add(code);
                macroRows.add(values);
                if (consensus != null) {
                    matches.add(CalendarConsensus.match(consensusStored, row, consensus.knownBy()));
                }
            }
            if (Boolean.TRUE.equals(row.isStale())) {
                stale.add(row.name());
            }
        }
        Map<String, Object> macro = new LinkedHashMap<>();
        macro.put("columns", consensus == null ? MACRO_COLUMNS : withConsensus(macroRows, matches, consensusOut));
        macro.put("rows", macroRows);
        out.put("macro", macro);
        Map<String, Object> earnings = new LinkedHashMap<>();
        Set<Object> earningsSources = new HashSet<>();
        earningsRows.forEach(values -> earningsSources.add(values.get(values.size() - 1)));
        if (earningsSources.size() == 1) {
            earnings.put("source", earningsSources.iterator().next());
            earnings.put("columns", EARNINGS_COLUMNS_ONE_SOURCE);
            earningsRows.forEach(values -> values.remove(values.size() - 1));
        } else {
            earnings.put("columns", EARNINGS_COLUMNS);
        }
        earnings.put("rows", earningsRows);
        // 대상 중 창 안 실적일이 없는 이유 둘 — '창 뒤'(싣지 않음)와 섞이지 않게 따로 적습니다.
        earnings.put("nextDateUnknown", r.earningsUndetermined());
        earnings.put("noData", r.earningsMissing());
        out.put("earnings", earnings);
        if (!stale.isEmpty()) {
            // 이번 수집이 실패해 직전 저장본에서 이어받은 줄 — 그사이 날짜가 바뀌었을 수 있음.
            out.put("stale", stale);
        }
        Map<String, String> sources = new LinkedHashMap<>();
        codes.forEach((source, code) -> sources.put(code, source));
        out.put("sources", sources);
        return new Built(out, DecisionMeasure.ofCalendar(r), r);
    }

    /**
     * 거시 줄 끝에 컨센서스 칸을 붙이고 열 이름을 돌려줍니다 — {@code actual}은 실을 값이 한 줄이라도 있을 때만 열로 둡니다. 못 붙인 줄·주의가
     * 있는 줄은 {@code consensus.notes}에 [날짜, 이름, 사유]로 적습니다(값 칸에 사유 글을 섞지 않음).
     */
    private static List<String> withConsensus(List<List<Object>> macroRows, List<CalendarConsensus.Match> matches,
                                              Map<String, Object> consensusOut) {
        boolean anyActual = matches.stream().anyMatch(m -> m.actual() != null);
        List<String> columns = new ArrayList<>(MACRO_COLUMNS);
        columns.add(CONSENSUS_COLUMNS.get(0));
        columns.add(CONSENSUS_COLUMNS.get(1));
        if (anyActual) {
            columns.add(ACTUAL_COLUMN);
        }
        columns.addAll(CONSENSUS_COLUMNS.subList(2, CONSENSUS_COLUMNS.size()));
        List<List<Object>> notes = new ArrayList<>();
        for (int i = 0; i < macroRows.size(); i++) {
            List<Object> values = macroRows.get(i);
            CalendarConsensus.Match m = matches.get(i);
            values.add(PacketBuilder.decimal(m.forecast(), CONSENSUS_SCALE));
            values.add(PacketBuilder.decimal(m.previous(), CONSENSUS_SCALE));
            if (anyActual) {
                values.add(PacketBuilder.decimal(m.actual(), CONSENSUS_SCALE));
            }
            values.add(m.unit());
            values.add(m.name());
            if (m.note() != null) {
                List<Object> note = new ArrayList<>(3);   // 이름이 null일 수 있어 List.of를 쓰지 않음
                note.add(values.get(0));
                note.add(values.get(2));
                note.add(m.note());
                notes.add(note);
            }
        }
        if (!notes.isEmpty()) {
            consensusOut.put("notes", notes);
        }
        return List.copyOf(columns);
    }

    /** 컨센서스 값의 자릿수 — Nasdaq 글자는 소수 셋째 자리까지(4.000%·0.034M·43.281K, 2026-10-28 저장본). */
    static final int CONSENSUS_SCALE = 4;

    /**
     * 컨센서스 저장본 payload → 계산 입력. {@code days}가 객체가 아니면 null("자료 없음"). 날마다 {@code status} "ok"인 것만,
     * 줄의 숫자·단위는 형이 맞을 때만(틀리면 null — 0으로 채우지 않음), 받은 시각은 ISO 시각일 때만.
     */
    static CalendarConsensus.Stored consensusStored(JsonNode payload) {
        if (payload == null || !payload.isObject()) {
            return null;
        }
        JsonNode days = Json.child(payload, "days");
        if (days == null || !days.isObject()) {
            return null;
        }
        Map<LocalDate, CalendarConsensus.Day> out = new TreeMap<>();
        for (Map.Entry<String, JsonNode> entry : days.properties()) {
            LocalDate date = Json.parseDate(entry.getKey());
            JsonNode day = entry.getValue();
            if (date == null || day == null || !day.isObject() || !"ok".equals(string(day, "status"))) {
                continue;
            }
            List<CalendarConsensus.Line> lines = new ArrayList<>();
            for (JsonNode row : Json.array(day, "rows")) {
                if (row == null || !row.isObject()) {
                    continue;
                }
                lines.add(new CalendarConsensus.Line(string(row, "name"), Json.asDouble(row, "forecast"),
                        Json.asDouble(row, "previous"), Json.asDouble(row, "actual"), string(row, "unit"),
                        Boolean.TRUE.equals(bool(row, "unitMismatch"))));
            }
            out.put(date, new CalendarConsensus.Day(lines, instant(string(day, "fetchedAt")),
                    Boolean.TRUE.equals(bool(day, "isStale"))));
        }
        JsonNode horizonNode = Json.child(payload, "horizon");
        LocalDate from = Json.parseDate(string(horizonNode, "from"));
        LocalDate to = Json.parseDate(string(horizonNode, "to"));
        return new CalendarConsensus.Stored(out, from == null || to == null ? null : new CalendarWindow.Window(from, to));
    }

    /** ISO 시각(오프셋 포함, 수집기의 {@code datetime.isoformat()}). 없거나 읽을 수 없으면 null. */
    private static Instant instant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return OffsetDateTime.parse(text.strip()).toInstant();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** 날짜 지도 → 글자 지도(이름 순, null 값 유지). */
    private static Map<String, String> dates(Map<String, LocalDate> in) {
        Map<String, String> out = new LinkedHashMap<>();
        new TreeMap<>(in).forEach((k, v) -> out.put(k, v == null ? null : v.toString()));
        return out;
    }

    /** 글자 칸만 — 수·불·객체가 오면 null(형이 틀린 값을 글자로 바꿔 옮기지 않음). */
    private static String string(JsonNode node, String field) {
        JsonNode v = Json.child(node, field);
        return v != null && v.isString() ? v.asString() : null;
    }

    private static Boolean bool(JsonNode node, String field) {
        JsonNode v = Json.child(node, field);
        return v != null && v.isBoolean() ? v.booleanValue() : null;
    }

    private static Integer integer(JsonNode node, String field) {
        JsonNode v = Json.child(node, field);
        return v != null && v.isIntegralNumber() && v.canConvertToInt() ? v.intValue() : null;
    }
}
