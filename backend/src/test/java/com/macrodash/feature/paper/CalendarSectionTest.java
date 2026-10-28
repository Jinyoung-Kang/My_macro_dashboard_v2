package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarWindow;
import com.macrodash.store.Snapshot;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * 패킷 일정 섹션 1b_calendar의 모양 — 저장본 payload 읽기(빠지거나 틀린 칸은 null), 머리말(출처·갱신 시각·창·FRED 상태·미공개
 * 구간·FOMC 상수), 열 배열과 출처 범례, 측정 태그, 결정성, 크기. 창·줄 고르기 자체는 {@code CalendarWindowTest}가 고정합니다.
 */
class CalendarSectionTest {

    private static final String DATASET = "calendar.us_events";
    private static final String FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm";
    private static final String YF = "yfinance quoteSummary calendarEvents";
    private static final String BEA = "FRED release/dates (api.stlouisfed.org) — BEA 일정";
    private static final String BLS = "FRED release/dates (api.stlouisfed.org) — BLS 일정";
    private static final String GDP = "GDP (Gross Domestic Product)";
    private static final String PCE = "PCE (Personal Income and Outlays)";
    private static final String JOBS = "Employment Situation (고용보고서)";
    private static final LocalDate AS_OF = LocalDate.of(2026, 10, 23);
    /** 2026-10-25 15:40 KST. */
    private static final Instant COLLECTED = Instant.parse("2026-10-25T06:40:00Z");

    private static ObjectNode event(ArrayNode events, String name, String date, String kind, Integer releaseId,
                                    String source) {
        ObjectNode e = events.addObject();
        e.put("name", name);
        e.put("date", date);
        e.put("kind", kind);
        if (releaseId == null) {
            e.putNull("releaseId");
        } else {
            e.put("releaseId", releaseId);
        }
        e.put("source", source);
        return e;
    }

    private static void item(ObjectNode items, String ticker, String date, String session, boolean estimated) {
        ObjectNode i = items.putObject(ticker);
        i.put("date", date);
        if (session == null) {
            i.putNull("session");
        } else {
            i.put("session", session);
        }
        i.put("isEstimated", estimated);
        i.put("epoch", 1_761_768_000L);
        i.put("source", YF);
        i.put("fetchedAt", "2026-10-25 15:39 KST");
    }

    /**
     * 수집기 us_calendar의 저장본 모양(collector/app/tasks/us_calendar.py 설명 — 단계 0 일정). 거시 일정은 수집 창(오늘부터 45일)
     * 안의 것만 있고, GOOGL은 수집기의 '다음 일정 미정'(date 없음 + 지난 발표일 lastDate)입니다.
     */
    private static ObjectNode payload(String fredStatus, boolean withReleases) {
        ObjectNode p = MAPPER.createObjectNode();
        p.put("generatedAt", "2026-10-25 15:40 KST");
        ObjectNode macro = p.putObject("macro");
        ArrayNode events = macro.putArray("events");
        event(events, "FOMC 성명", "2026-10-28", "FOMC", null, FOMC_URL).put("sep", false)
                .put("meetingStart", "2026-10-27");
        event(events, "FOMC 성명 (경제전망 SEP 포함)", "2026-12-09", "FOMC", null, FOMC_URL).put("sep", true)
                .put("meetingStart", "2026-12-08");
        if (withReleases) {
            event(events, GDP, "2026-10-29", "RELEASE", 53, BEA).put("key", "GDP").put("agency", "BEA");
            event(events, PCE, "2026-10-29", "RELEASE", 54, BEA).put("key", "PCE").put("agency", "BEA");
            event(events, JOBS, "2026-11-06", "RELEASE", 50, BLS).put("key", "EMPLOYMENT").put("agency", "BLS");
            event(events, "CPI (Consumer Price Index)", "2026-11-10", "RELEASE", 10, BLS).put("key", "CPI")
                    .put("agency", "BLS");
        }
        ObjectNode horizon = macro.putObject("horizon");
        horizon.put("from", "2026-10-25");
        horizon.put("to", "2026-12-09");
        ObjectNode fred = macro.putObject("fred");
        fred.put("status", fredStatus);
        fred.put("source", "FRED release/dates (api.stlouisfed.org)");
        ObjectNode known = fred.putObject("lastKnownDate");
        if (withReleases) {
            known.put("CPI", "2026-11-10");
            known.put("PCE", "2026-11-25");
            known.put("EMPLOYMENT", "2026-12-04");
            known.put("GDP", "2026-11-25");
        }
        ObjectNode fomc = macro.putObject("fomc");
        fomc.put("source", FOMC_URL);
        fomc.put("checkedAt", "2026-10-25");
        fomc.put("pageUpdated", "2026-10-07");
        fomc.put("through", "2027-12-08");
        fomc.put("status", "ok");
        ObjectNode earnings = p.putObject("earnings");
        earnings.put("source", "Yahoo Finance quoteSummary calendarEvents (yfinance 1.7.0 내부 호출 Ticker._quote._fetch)");
        ObjectNode items = earnings.putObject("items");
        item(items, "AMZN", "2026-10-29", "AMC", false);
        item(items, "AMD", "2026-11-03", null, false);
        ObjectNode googl = items.putObject("GOOGL");
        googl.putNull("date");
        googl.putNull("session");
        googl.put("isEstimated", false);
        googl.putNull("epoch");
        googl.put("source", YF);
        googl.put("fetchedAt", "2026-10-25T06:39:00+00:00");
        googl.put("note", "다음 일정 미정");
        googl.put("lastDate", "2026-10-20");
        earnings.put("covered", 3);
        earnings.put("universe", 380);
        earnings.put("budget", 120);
        return p;
    }

    private static Optional<Snapshot> snapshot(JsonNode payload) {
        return Optional.of(new Snapshot(DATASET, payload, "json", "ok", null, COLLECTED));
    }

    private static CalendarSection.Built build(Optional<Snapshot> snapshot, List<String> targets, boolean initial) {
        return CalendarSection.build(DATASET, snapshot, AS_OF, targets, initial);
    }

    /** 거시(macro)·실적(earnings) 표의 줄. */
    @SuppressWarnings("unchecked")
    private static List<List<Object>> rows(Map<String, Object> section, String table) {
        return (List<List<Object>>) ((Map<String, Object>) section.get(table)).get("rows");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> table(Map<String, Object> section, String table) {
        return (Map<String, Object>) section.get(table);
    }

    private static String json(Map<String, Object> section) {
        return MAPPER.writeValueAsString(PacketBuilder.toNode(section));
    }

    @Test
    @DisplayName("단계 0 저장본 → 머리말·거시/실적 두 표·출처 범례, 대상 밖 종목은 빠지고 자료 없음·다음 일정 미정은 따로")
    void fullSection() {
        CalendarSection.Built built = build(snapshot(payload("ok", true)),
                List.of("AMZN", "AMD", "GOOGL", "MSFT"), false);
        Map<String, Object> s = built.section();

        assertThat(s.keySet()).containsExactly("source", "generatedAtKst", "window", "note", "asOfMismatch",
                "fredStatus", "lastKnownDate", "fomc", "units", "macro", "earnings", "sources");
        assertThat(s.get("source")).isEqualTo("snapshot calendar.us_events");
        assertThat(s.get("generatedAtKst")).isEqualTo("2026-10-25 15:40 KST");
        assertThat(s.get("window")).isEqualTo(Map.of("from", "2026-10-26", "to", "2026-11-06"));
        assertThat(s.get("note")).isEqualTo("일정이 매매를 막지 않는다. 판단에 쓸 뿐");
        assertThat(s.get("asOfMismatch")).isEqualTo(false);
        assertThat(s.get("fredStatus")).isEqualTo("ok");
        // 이름 순(입력 순서와 무관).
        assertThat(List.copyOf(((Map<?, ?>) s.get("lastKnownDate")).keySet()))
                .isEqualTo(List.of("CPI", "EMPLOYMENT", "GDP", "PCE"));
        assertThat(s.get("fomc")).isEqualTo(Map.of("checkedAt", "2026-10-25", "through", "2027-12-08", "status", "ok"));
        assertThat(table(s, "macro").keySet()).containsExactly("columns", "rows");
        assertThat(table(s, "macro").get("columns")).isEqualTo(CalendarSection.MACRO_COLUMNS);
        assertThat(rows(s, "macro")).containsExactly(
                List.of("2026-10-28", "FOMC", "FOMC 성명", "s1"),
                List.of("2026-10-29", "RELEASE", GDP, "s2"),
                List.of("2026-10-29", "RELEASE", PCE, "s2"),
                List.of("2026-11-06", "RELEASE", JOBS, "s4"));
        Map<String, Object> earnings = table(s, "earnings");
        // 실적 줄의 출처가 모두 같으면 출처 열 대신 표에 하나.
        assertThat(earnings.keySet()).containsExactly("source", "columns", "rows", "nextDateUnknown", "noData");
        assertThat(earnings.get("source")).isEqualTo("s3");
        assertThat(earnings.get("columns")).isEqualTo(List.of("date", "ticker", "session", "isEstimated"));
        assertThat(rows(s, "earnings")).containsExactly(
                Arrays.asList("2026-10-29", "AMZN", "AMC", false),
                Arrays.asList("2026-11-03", "AMD", null, false));
        assertThat(earnings.get("nextDateUnknown")).isEqualTo(List.of("GOOGL"));
        assertThat(earnings.get("noData")).isEqualTo(List.of("MSFT"));
        // 이어받은 줄이 없으면 stale 키도 없음.
        assertThat(s).doesNotContainKey("stale");
        Map<String, String> sources = new LinkedHashMap<>();
        sources.put("s1", FOMC_URL);
        sources.put("s2", BEA);
        sources.put("s3", YF);
        sources.put("s4", BLS);
        assertThat(s.get("sources")).isEqualTo(sources);

        assertThat(built.measure()).isEqualTo(new DecisionMeasure(true, 6, null, null, null, null));
        assertThat(built.result().macroCount()).isEqualTo(4);
        assertThat(built.result().earningsCount()).isEqualTo(2);
    }

    @Test
    @DisplayName("저장본 없음·객체가 아닌 payload — '자료 없음' 사유만(빈 표 없음), 측정 태그 hasCalendar=false·calendarItems=null")
    void missingSnapshot() {
        for (Optional<Snapshot> missing : List.of(Optional.<Snapshot>empty(), snapshot(MAPPER.createArrayNode()),
                snapshot(null))) {
            CalendarSection.Built built = build(missing, List.of("AMZN"), false);
            Map<String, Object> s = built.section();
            // 빈 표를 두면 "창 안 0건"으로 읽혀 '자료 없음'과 섞입니다.
            assertThat(s.keySet()).containsExactly("source", "generatedAtKst", "window", "note", "asOfMismatch",
                    "missing");
            assertThat(s.get("missing")).isEqualTo("자료 없음 — 일정 저장본이 없습니다(calendar.us_events)");
            assertThat(s.get("generatedAtKst")).isNull();
            assertThat(built.measure()).isEqualTo(new DecisionMeasure(false, null, null, null, null, null));
        }
        // Optional 자체가 null이어도(호출부 실수) 같은 '자료 없음'.
        assertThat(CalendarSection.build(DATASET, null, AS_OF, List.of(), false).measure().hasCalendar()).isFalse();
    }

    @Test
    @DisplayName("초기 결정 — 앞날 일정은 현재 수집본이라 asOfMismatch:true와 참고 문구")
    void initialMarksAsOfMismatch() {
        Map<String, Object> s = build(snapshot(payload("ok", true)), List.of("AMZN"), true).section();
        assertThat(s.get("asOfMismatch")).isEqualTo(true);
        assertThat(s.get("asOfNote")).isEqualTo(CalendarSection.AS_OF_NOTE);
        Map<String, Object> missing = build(Optional.empty(), List.of(), true).section();
        assertThat(missing.get("asOfMismatch")).isEqualTo(true);
    }

    @Test
    @DisplayName("FRED 키 미설정 — fredStatus에 적고 FOMC 상수·실적일은 그대로, 미공개 구간은 만들지 않음")
    void fredKeyMissing() {
        CalendarSection.Built built = build(snapshot(payload("키 미설정", false)), List.of("AMZN"), false);
        Map<String, Object> s = built.section();
        assertThat(s.get("fredStatus")).isEqualTo("키 미설정");
        assertThat(s.get("lastKnownDate")).isEqualTo(Map.of());
        assertThat(s).doesNotContainKey("unpublishedAfter");
        assertThat(rows(s, "macro")).containsExactly(List.of("2026-10-28", "FOMC", "FOMC 성명", "s1"));
        assertThat(rows(s, "earnings")).containsExactly(Arrays.asList("2026-10-29", "AMZN", "AMC", false));
        assertThat(table(s, "earnings").get("source")).isEqualTo("s2");
        assertThat(built.measure().calendarItems()).isEqualTo(2);

        // 수집기의 실제 모양 — 키가 없으면 릴리스마다 lastKnownDate가 null. 그래도 '일정 미공개'로 겹쳐 적지 않습니다.
        ObjectNode real = payload("키 미설정", false);
        ObjectNode known = (ObjectNode) real.get("macro").get("fred").get("lastKnownDate");
        List.of("CPI", "PCE", "EMPLOYMENT", "GDP").forEach(known::putNull);
        Map<String, Object> keyless = build(snapshot(real), List.of("AMZN"), false).section();
        assertThat(keyless).doesNotContainKey("unpublishedAfter").doesNotContainKey("unpublishedNote");
        assertThat(((Map<?, ?>) keyless.get("lastKnownDate")).values()).containsOnlyNulls().hasSize(4);
    }

    @Test
    @DisplayName("창 끝이 lastKnownDate 뒤 — unpublishedAfter와 문구, 이어받은 값은 fredIsStale·stale, FOMC 상수 끝을 넘으면 '갱신 필요'")
    void unpublishedAndStale() {
        ObjectNode p = payload("ok", true);
        ObjectNode fred = (ObjectNode) p.get("macro").get("fred");
        fred.put("isStale", true);
        ObjectNode known = (ObjectNode) fred.get("lastKnownDate");
        known.put("CPI", "2026-12-10");
        known.put("PCE", "2026-12-23");
        known.put("GDP", "2026-12-23");
        known.putNull("EMPLOYMENT");   // 받은 날짜 없음(None = 모름)
        ObjectNode items = (ObjectNode) p.get("earnings").get("items");
        item(items, "ORCL", "2026-12-08", "AMC", false);
        ((ObjectNode) items.get("ORCL")).put("isStale", true);     // 이번 수집 실패 → 직전 값 이어받음
        item(items, "ADBE", "2026-12-10", "AMC", false);
        ((ObjectNode) items.get("ADBE")).put("isStale", false);
        Map<String, Object> s = CalendarSection.build(DATASET, snapshot(p), LocalDate.of(2026, 12, 4),
                List.of("ORCL", "ADBE"), false).section();
        assertThat(s.get("fredIsStale")).isEqualTo(true);
        assertThat(s.get("stale")).isEqualTo(List.of("ORCL"));
        Map<String, String> unpublished = new LinkedHashMap<>();
        unpublished.put("CPI", "2026-12-10");
        unpublished.put("EMPLOYMENT", null);
        assertThat(s.get("unpublishedAfter")).isEqualTo(unpublished);
        assertThat(s.get("unpublishedNote")).isEqualTo(CalendarSection.UNPUBLISHED_NOTE);

        Map<String, Object> late = CalendarSection.build(DATASET, snapshot(payload("ok", true)),
                LocalDate.of(2027, 12, 3), List.of(), false).section();
        assertThat(((Map<?, ?>) late.get("fomc")).get("status")).isEqualTo("갱신 필요");
    }

    @Test
    @DisplayName("창이 저장본의 수집 범위(macro.horizon) 밖 — horizon·horizonNote로 '확인 못 함'(굳은 저장본의 FOMC가 말없이 빠지지 않게)")
    void outsideHorizon() {
        // 10-25에 수집하고 굳은 저장본(10-25~12-09)을 2027-01-15 기준으로 읽음 — 창 안의 01-27 FOMC는 저장본에 없습니다. 예전에는
        // 거시 표가 비고 fomc.status "ok"라 'FOMC 없음'으로 읽혔습니다.
        CalendarSection.Built built = CalendarSection.build(DATASET, snapshot(payload("ok", true)),
                LocalDate.of(2027, 1, 15), List.of(), false);
        Map<String, Object> s = built.section();
        assertThat(rows(s, "macro")).isEmpty();
        assertThat(s.get("horizon")).isEqualTo(Map.of("from", "2026-10-25", "to", "2026-12-09"));
        assertThat(s.get("horizonNote")).isEqualTo(CalendarSection.HORIZON_NOTE);
        assertThat(built.result().outsideHorizon()).isTrue();
        assertThat(CalendarSection.stored(payload("ok", true)).horizon())
                .isEqualTo(new CalendarWindow.Window(LocalDate.of(2026, 10, 25), LocalDate.of(2026, 12, 9)));

        // 범위 안이면 머리말에 없음(fullSection의 키 목록), 범위 칸이 없거나 깨졌으면 판단하지 않음(지어낸 경고 없음).
        assertThat(build(snapshot(payload("ok", true)), List.of(), false).section()).doesNotContainKey("horizon");
        ObjectNode broken = payload("ok", true);
        ((ObjectNode) broken.get("macro").get("horizon")).put("to", "곧");
        assertThat(CalendarSection.stored(broken).horizon()).isNull();
        assertThat(CalendarSection.build(DATASET, snapshot(broken), LocalDate.of(2027, 1, 15), List.of(), false)
                .section()).doesNotContainKey("horizon").doesNotContainKey("horizonNote");
    }

    @Test
    @DisplayName("틀린 형의 칸은 null — 날짜가 깨진 실적은 '자료 없음', 문자열 불·숫자 장 구분은 옮기지 않음")
    void malformedValuesBecomeNull() {
        ObjectNode p = payload("ok", false);
        ObjectNode items = (ObjectNode) p.get("earnings").get("items");
        ObjectNode bad = items.putObject("bad ");
        bad.put("date", "다음 주");
        ObjectNode odd = items.putObject("odd");
        odd.put("date", "2026-10-27");
        odd.put("session", 1230);
        odd.put("isEstimated", "yes");
        odd.put("isStale", "no");
        CalendarWindow.Stored stored = CalendarSection.stored(p);
        assertThat(stored.earnings()).containsKeys("BAD", "ODD");
        assertThat(stored.earnings().get("BAD").date()).isNull();
        CalendarWindow.Earnings parsed = stored.earnings().get("ODD");
        assertThat(parsed.session()).isNull();   // 장 구분은 BMO·AMC 글자만 — 수를 글자로 바꿔 옮기지 않음
        assertThat(parsed.isEstimated()).isNull();
        assertThat(parsed.isStale()).isNull();
        assertThat(stored.covered()).isEqualTo(3);
        assertThat(stored.universe()).isEqualTo(380);

        // 출처 칸이 없는 실적 → 출처 코드도 null(범례에 없는 코드를 만들지 않음). 출처가 섞이면(AMD는 yfinance) 줄마다 출처 열.
        Map<String, Object> s = build(snapshot(p), List.of("bad", "odd", "AMD"), false).section();
        assertThat(table(s, "earnings").get("noData")).isEqualTo(List.of("BAD"));
        assertThat(table(s, "earnings")).doesNotContainKey("source");
        assertThat(table(s, "earnings").get("columns")).isEqualTo(CalendarSection.EARNINGS_COLUMNS);
        assertThat(rows(s, "earnings")).containsExactly(
                Arrays.asList("2026-10-27", "ODD", null, null, null),
                Arrays.asList("2026-11-03", "AMD", null, false, "s2"));
        assertThat(s.get("sources")).isEqualTo(Map.of("s1", FOMC_URL, "s2", YF));
        assertThat(s).as("isStale이 불이 아니면 이어받은 줄로 세지 않음").doesNotContainKey("stale");
    }

    @Test
    @DisplayName("결정적 — 같은 저장본이면 같은 글자, 실적 종목·거시 일정·대상의 순서가 달라도 같음")
    void deterministic() {
        ObjectNode a = payload("ok", true);
        ObjectNode b = payload("ok", true);
        // b는 거시 일정을 거꾸로, 실적 종목을 다른 순서로 넣습니다.
        ArrayNode reversed = MAPPER.createArrayNode();
        List<JsonNode> events = new ArrayList<>();
        b.get("macro").get("events").forEach(events::add);
        for (int i = events.size() - 1; i >= 0; i--) {
            reversed.add(events.get(i));
        }
        ((ObjectNode) b.get("macro")).set("events", reversed);
        ObjectNode items = MAPPER.createObjectNode();
        items.set("GOOGL", b.get("earnings").get("items").get("GOOGL"));
        items.set("AMD", b.get("earnings").get("items").get("AMD"));
        items.set("AMZN", b.get("earnings").get("items").get("AMZN"));
        ((ObjectNode) b.get("earnings")).set("items", items);

        String first = json(build(snapshot(a), List.of("AMZN", "AMD", "GOOGL"), false).section());
        String again = json(build(snapshot(a), List.of("AMZN", "AMD", "GOOGL"), false).section());
        String shuffled = json(build(snapshot(b), List.of("GOOGL", "AMZN", "AMD"), false).section());
        assertThat(again).isEqualTo(first);
        assertThat(shuffled).isEqualTo(first);
    }

    @Test
    @DisplayName("크기 — 거시 6건 + 대상 25종목이 모두 창 안인 초기 결정 패킷에서도 섹션은 750토큰(어림) 이하")
    void sizeAtCap() {
        ObjectNode p = payload("ok", true);
        ArrayNode events = (ArrayNode) p.get("macro").get("events");
        // 창(10-26 … 11-06) 안의 거시 일정을 단계 0의 4건에서 6건으로 — 2주에 FOMC 1번 + 네 릴리스가 한 번씩이면 5건(GDP·PCE가
        // 같은 날)이라 넉넉한 상한입니다. 출처도 릴리스마다 달라 범례가 가장 긴 경우.
        event(events, "FOMC 성명 (경제전망 SEP 포함)", "2026-11-04", "FOMC", null, FOMC_URL).put("sep", true);
        event(events, "CPI (Consumer Price Index)", "2026-11-05", "RELEASE", 10, BLS);
        ObjectNode items = (ObjectNode) p.get("earnings").get("items");
        List<String> targets = new ArrayList<>();
        for (int i = 0; i < FundamentalsSection.MAX_ROWS; i++) {
            String ticker = "T" + (char) ('A' + i) + "XQ";
            item(items, ticker, "2026-10-" + (26 + i % 5), i % 3 == 0 ? null : (i % 2 == 0 ? "BMO" : "AMC"), i % 3 == 0);
            targets.add(ticker);
        }
        CalendarSection.Built built = build(snapshot(p), targets, true);
        assertThat(built.measure().calendarItems()).isEqualTo(6 + FundamentalsSection.MAX_ROWS);
        int tokens = PacketBuilder.estimateTokens(json(built.section()));
        // 상한을 꽉 채운 시험 패킷(PacketBuilderTest.fitsTokenBudget)이 이 섹션 없이 약 29,100토큰이라 목표(30,000)까지 약 900 —
        // 그 안에 들어야 합니다(지금 약 730). 실적 대상은 8b와 같은 상한 25종목(호출부가 자름)이라 실적 줄은 이것이 최악입니다.
        assertThat(rows(built.section(), "macro")).hasSize(6);
        assertThat(rows(built.section(), "earnings")).hasSize(FundamentalsSection.MAX_ROWS);
        assertThat(tokens).as("1b_calendar 어림 토큰").isLessThanOrEqualTo(750);
    }

    // ------------------------------------------------------------------ 컨센서스 층(E1b — calendar.consensus 켜짐)
    private static final String CONSENSUS = "calendar.us_consensus";
    /** 동부 10-26 08:57에 받은 저장본(KST 21:57). */
    private static final String CONSENSUS_FETCHED = "2026-10-26T12:57:00+00:00";
    /** 기준일 10-23의 미국 결정 순간(10-24 07:30 KST) — NewsEvents.window(10-23, 07:30)의 끝. */
    private static final Instant KNOWN_BY = Instant.parse("2026-10-23T22:30:00Z");

    private static ObjectNode nasdaq(ArrayNode rows, String name, String timeEt, Double forecast, Double previous,
                                     Double actual, String unit) {
        ObjectNode r = rows.addObject();
        r.put("name", name);
        r.put("timeEt", timeEt);
        r.put("timeText", timeEt);
        if (forecast == null) {
            r.putNull("forecast");
        } else {
            r.put("forecast", forecast);
        }
        if (previous == null) {
            r.putNull("previous");
        } else {
            r.put("previous", previous);
        }
        if (actual == null) {
            r.putNull("actual");
        } else {
            r.put("actual", actual);
        }
        if (unit == null) {
            r.putNull("unit");
        } else {
            r.put("unit", unit);
        }
        r.putNull("importance");
        return r;
    }

    private static ArrayNode day(ObjectNode days, String date, String fetchedAt) {
        ObjectNode d = days.putObject(date);
        d.put("date", date);
        d.put("queryDate", LocalDate.parse(date).plusDays(1).toString());
        d.put("status", "ok");
        d.put("fetchedAt", fetchedAt);
        return d.putArray("rows");
    }

    /**
     * 수집기 us_calendar_consensus의 저장본 모양(collector/app/tasks/us_consensus.py 설명) — 동부 10-26부터 18일. 줄 이름·값은 2026-10-28
     * 로컬 저장본의 Nasdaq 미국 행(FOMC 10-28·GDP와 PCE 10-29·고용 11-06), 10-27은 그 날 받지 못함(직전 값도 없어 빠짐).
     */
    private static ObjectNode consensusPayload() {
        ObjectNode p = MAPPER.createObjectNode();
        p.put("generatedAt", CONSENSUS_FETCHED);
        p.put("forDate", "2026-10-26");
        p.put("source", "Nasdaq api/calendar/economicevents");
        p.put("queryOffsetDays", 1);
        ObjectNode horizon = p.putObject("horizon");
        horizon.put("from", "2026-10-26");
        horizon.put("to", "2026-11-13");
        p.putNull("importance");
        ObjectNode days = p.putObject("days");
        day(days, "2026-10-26", CONSENSUS_FETCHED);
        ArrayNode fomc = day(days, "2026-10-28", CONSENSUS_FETCHED);
        nasdaq(fomc, "FOMC Statement", "14:00", null, null, null, null);
        nasdaq(fomc, "Fed Interest Rate Decision", "14:00", 4.0, 4.0, null, "%");
        nasdaq(fomc, "FOMC Press Conference", "14:30", null, null, null, null);
        ArrayNode gdp = day(days, "2026-10-29", CONSENSUS_FETCHED);
        nasdaq(gdp, "Core PCE Price Index", "08:30", 0.3, 0.2, null, "%");
        nasdaq(gdp, "Core PCE Price Index", "08:30", 3.1, 3.0, null, "%");
        nasdaq(gdp, "GDP", "08:30", 3.2, 2.2, null, "%");
        ArrayNode jobs = day(days, "2026-11-06", CONSENSUS_FETCHED);
        nasdaq(jobs, "Nonfarm Payrolls", "09:30", null, 29.0, null, "K");
        p.putObject("failed").put("2026-10-27", "HTTP 503");
        return p;
    }

    private static CalendarSection.Built withConsensus(JsonNode consensus, Instant knownBy) {
        Optional<Snapshot> snap = consensus == null ? Optional.empty()
                : Optional.of(new Snapshot(CONSENSUS, consensus, "json", "ok", null, Instant.parse("2026-10-26T12:57:30Z")));
        return CalendarSection.build(DATASET, snapshot(payload("ok", true)), AS_OF, List.of("AMZN"), false,
                new CalendarSection.Consensus(CONSENSUS, snap, knownBy));
    }

    @Test
    @DisplayName("컨센서스 층 — 머리말 consensus(출처·수집 시각·설명), 거시 줄 끝에 forecast·previous·unit·consensusSource, 못 붙인 줄은 notes")
    void consensusLayer() {
        Map<String, Object> s = withConsensus(consensusPayload(), KNOWN_BY).section();
        assertThat(s.keySet()).containsExactly("source", "generatedAtKst", "window", "note", "asOfMismatch",
                "fredStatus", "lastKnownDate", "fomc", "units", "consensus", "macro", "earnings", "sources");
        Map<String, Object> header = table(s, "consensus");
        assertThat(header.keySet()).containsExactly("source", "generatedAtKst", "note", "notes");
        assertThat(header.get("source")).isEqualTo("snapshot calendar.us_consensus — Nasdaq 경제 캘린더(비공식 참고)");
        assertThat(header.get("generatedAtKst")).isEqualTo("2026-10-26 21:57 KST");
        assertThat(header.get("note")).isEqualTo(CalendarSection.CONSENSUS_NOTE);
        assertThat(table(s, "macro").get("columns")).isEqualTo(List.of("date", "kind", "name", "source", "forecast",
                "previous", "unit", "consensusSource"));
        assertThat(json(Map.of("rows", rows(s, "macro")))).isEqualTo("{\"rows\":["
                + "[\"2026-10-28\",\"FOMC\",\"FOMC 성명\",\"s1\",4,4,\"%\",\"Fed Interest Rate Decision\"],"
                + "[\"2026-10-29\",\"RELEASE\",\"" + GDP + "\",\"s2\",3.2,2.2,\"%\",\"GDP\"],"
                + "[\"2026-10-29\",\"RELEASE\",\"" + PCE + "\",\"s2\",null,null,null,null],"
                + "[\"2026-11-06\",\"RELEASE\",\"" + JOBS + "\",\"s4\",null,29,\"K\",\"Nonfarm Payrolls\"]]}");
        assertThat(header.get("notes")).isEqualTo(List.of(List.of("2026-10-29", PCE,
                "Nasdaq 'Core PCE Price Index' 2줄(전월비·전년비 라벨 없음) — 가를 수 없음")));
        // 실적 표·출처 범례·측정 태그는 층과 상관없이 그대로입니다.
        Map<String, Object> off = build(snapshot(payload("ok", true)), List.of("AMZN"), false).section();
        assertThat(s.get("earnings")).isEqualTo(off.get("earnings"));
        assertThat(s.get("sources")).isEqualTo(off.get("sources"));
        assertThat(withConsensus(consensusPayload(), KNOWN_BY).measure())
                .isEqualTo(build(snapshot(payload("ok", true)), List.of("AMZN"), false).measure());
    }

    @Test
    @DisplayName("층을 끄면(null) 섹션은 한 글자도 다르지 않다 — 다섯 인자 build와 같은 글자, consensus 키·열 없음")
    void consensusOffIsUnchanged() {
        String five = json(build(snapshot(payload("ok", true)), List.of("AMZN"), false).section());
        String off = json(CalendarSection.build(DATASET, snapshot(payload("ok", true)), AS_OF, List.of("AMZN"), false,
                null).section());
        assertThat(off).isEqualTo(five).doesNotContain("consensus").doesNotContain("forecast");
    }

    @Test
    @DisplayName("발표치 열 — 결정 순간 전에 받은 발표치가 한 줄이라도 있을 때만 previous 뒤에 actual, 결정 뒤에 받은 발표치는 싣지 않음")
    void actualColumnOnlyWhenKnownByTheDecision() {
        ObjectNode early = consensusPayload();
        ObjectNode gdp = (ObjectNode) early.get("days").get("2026-10-29");
        gdp.put("fetchedAt", "2026-10-23T21:00:00+00:00");
        ((ObjectNode) gdp.get("rows").get(2)).put("actual", 3.0);
        Map<String, Object> s = withConsensus(early, KNOWN_BY).section();
        assertThat(table(s, "macro").get("columns")).isEqualTo(List.of("date", "kind", "name", "source", "forecast",
                "previous", "actual", "unit", "consensusSource"));
        assertThat(rows(s, "macro").get(1).subList(4, 9)).containsExactly(new java.math.BigDecimal("3.2"),
                new java.math.BigDecimal("2.2"), new java.math.BigDecimal("3"), "%", "GDP");
        assertThat(rows(s, "macro").get(0).get(6)).as("발표치가 없는 줄은 null").isNull();

        // 같은 발표치를 결정 순간 뒤에 받았으면 그 결정은 볼 수 없었으므로 열째 싣지 않습니다(늘 비는 열을 두지 않음).
        gdp.put("fetchedAt", "2026-10-23T22:30:01+00:00");
        Map<String, Object> late = withConsensus(early, KNOWN_BY).section();
        assertThat(table(late, "macro").get("columns")).isEqualTo(List.of("date", "kind", "name", "source", "forecast",
                "previous", "unit", "consensusSource"));
        assertThat(json(late)).doesNotContain("actual");
    }

    @Test
    @DisplayName("컨센서스 저장본 없음 — 머리말에 '자료 없음'(설명·notes 없음), 열은 그대로 두고 칸은 null(0으로 채우지 않음)")
    void consensusMissing() {
        for (JsonNode payload : java.util.Arrays.<JsonNode>asList(null, MAPPER.createArrayNode(),
                MAPPER.createObjectNode().put("days", "x"))) {
            Map<String, Object> s = withConsensus(payload, KNOWN_BY).section();
            assertThat(table(s, "consensus")).isEqualTo(Map.of("source",
                    "snapshot calendar.us_consensus — Nasdaq 경제 캘린더(비공식 참고)",
                    "missing", "자료 없음 — 컨센서스 저장본이 없습니다(calendar.us_consensus)"));
            assertThat(table(s, "macro").get("columns")).isEqualTo(List.of("date", "kind", "name", "source", "forecast",
                    "previous", "unit", "consensusSource"));
            rows(s, "macro").forEach(r -> assertThat(r.subList(4, 8)).containsOnlyNulls());
        }
        // 일정 저장본이 없으면 거시 표가 없어 컨센서스 머리말도 두지 않습니다('자료 없음' 사유만).
        Map<String, Object> noCalendar = CalendarSection.build(DATASET, Optional.empty(), AS_OF, List.of(), false,
                new CalendarSection.Consensus(CONSENSUS, Optional.empty(), KNOWN_BY)).section();
        assertThat(noCalendar).doesNotContainKey("consensus").containsKey("missing");
    }

    @Test
    @DisplayName("저장본 읽기 — status가 ok가 아닌 날·틀린 형의 값은 쓰지 않고(null), 범위를 못 읽으면 범위 밖을 지어내지 않음")
    void consensusStoredParsing() {
        ObjectNode p = consensusPayload();
        ((ObjectNode) p.get("days").get("2026-10-28")).put("status", "failed");
        ObjectNode gdp = (ObjectNode) ((ObjectNode) p.get("days").get("2026-10-29")).get("rows").get(2);
        gdp.put("forecast", "3.2%");
        gdp.put("unit", 7);
        ((ObjectNode) p.get("horizon")).put("to", "모름");
        com.macrodash.analytics.CalendarConsensus.Stored stored = CalendarSection.consensusStored(p);
        assertThat(stored.horizon()).isNull();
        assertThat(stored.days()).containsOnlyKeys(LocalDate.parse("2026-10-26"), LocalDate.parse("2026-10-29"),
                LocalDate.parse("2026-11-06"));
        com.macrodash.analytics.CalendarConsensus.Line line = stored.days().get(LocalDate.parse("2026-10-29")).lines().get(2);
        assertThat(line).isEqualTo(new com.macrodash.analytics.CalendarConsensus.Line("GDP", null, 2.2, null, null, false));
        assertThat(stored.days().get(LocalDate.parse("2026-10-29")).fetchedAt())
                .isEqualTo(Instant.parse("2026-10-26T12:57:00Z"));
        Map<String, Object> s = withConsensus(p, KNOWN_BY).section();
        assertThat(rows(s, "macro").get(0).subList(4, 8)).as("받지 못한 날(10-28 실패)").containsOnlyNulls();
        assertThat(table(s, "consensus").get("notes").toString()).contains("[2026-10-28, FOMC 성명, 그 날 받지 못함]");
    }

    @Test
    @DisplayName("결정적 + 크기 — 같은 저장본이면 같은 글자, 거시 6건 모두 컨센서스를 붙인 섹션은 1,000토큰(어림) 이하(층 없이 약 730)")
    void consensusDeterministicAndSize() {
        assertThat(json(withConsensus(consensusPayload(), KNOWN_BY).section()))
                .isEqualTo(json(withConsensus(consensusPayload(), KNOWN_BY).section()));
        ObjectNode p = payload("ok", true);
        ArrayNode events = (ArrayNode) p.get("macro").get("events");
        event(events, "FOMC 성명 (경제전망 SEP 포함)", "2026-11-04", "FOMC", null, FOMC_URL).put("sep", true);
        event(events, "CPI (Consumer Price Index)", "2026-11-05", "RELEASE", 10, BLS);
        ObjectNode items = (ObjectNode) p.get("earnings").get("items");
        List<String> targets = new ArrayList<>();
        for (int i = 0; i < FundamentalsSection.MAX_ROWS; i++) {
            String ticker = "T" + (char) ('A' + i) + "XQ";
            item(items, ticker, "2026-10-" + (26 + i % 5), i % 3 == 0 ? null : (i % 2 == 0 ? "BMO" : "AMC"), i % 3 == 0);
            targets.add(ticker);
        }
        // 가장 큰 칸: 줄마다 붙였고(사유 없음) 결정 전 발표치까지 — 값은 Nasdaq에서 본 가장 긴 모양(-130.8B·-132.07B 등).
        ObjectNode c = MAPPER.createObjectNode();
        ObjectNode h = c.putObject("horizon");
        h.put("from", "2026-10-26");
        h.put("to", "2026-11-13");
        ObjectNode days = c.putObject("days");
        String early = "2026-10-23T21:00:00+00:00";
        nasdaq(day(days, "2026-10-28", early), "Fed Interest Rate Decision", "14:00", -130.875, -132.0725, -130.4375, "B");
        ArrayNode gdpDay = day(days, "2026-10-29", early);
        nasdaq(gdpDay, "GDP", "08:30", -130.875, -132.0725, -130.4375, "B");
        nasdaq(gdpDay, "Core PCE Price Index", "08:30", -130.875, -132.0725, -130.4375, "B");
        nasdaq(day(days, "2026-11-04", early), "Fed Interest Rate Decision", "14:00", -130.875, -132.0725, -130.4375, "B");
        nasdaq(day(days, "2026-11-05", early), "CPI", "08:30", -130.875, -132.0725, -130.4375, "B");
        nasdaq(day(days, "2026-11-06", early), "Nonfarm Payrolls", "08:30", -130.875, -132.0725, -130.4375, "B");
        Optional<Snapshot> snap = Optional.of(new Snapshot(CONSENSUS, c, "json", "ok", null, Instant.parse("2026-10-23T21:00:30Z")));
        CalendarSection.Built built = CalendarSection.build(DATASET, snapshot(p), AS_OF, targets, true,
                new CalendarSection.Consensus(CONSENSUS, snap, KNOWN_BY));
        assertThat(rows(built.section(), "macro")).hasSize(6).allSatisfy(r -> assertThat(r).hasSize(9));
        int tokens = PacketBuilder.estimateTokens(json(built.section()));
        int off = PacketBuilder.estimateTokens(json(CalendarSection.build(DATASET, snapshot(p), AS_OF, targets, true)
                .section()));
        // 2026-10-28 잰 값: 층 없이 730 → 층을 켜면 984(+254 — 머리말 설명 약 70·줄마다 약 16·열 이름 약 14). 패킷 목표는
        // 패킷 목표 크기는 층을 켠 가장 큰 패킷으로 다시 잽니다(PacketBuilder 쪽).
        assertThat(tokens).as("1b_calendar 어림 토큰 — 층 없이 %d", off).isLessThanOrEqualTo(1_000);
    }
}
