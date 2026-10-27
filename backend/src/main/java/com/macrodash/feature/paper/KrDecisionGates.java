package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 🧪 한국 결정 자료 게이트(2단계 명세 §4-9 — 모두 충족해야 결정을 부름). 한국 출발({@link KrStartPipeline} — S 22:30, ①은 앞 주문이 없어 보지
 * 않음 §4-8)의 판정입니다.
 *
 * <ul>
 *   <li>② 수집 범위 90% 이상에 D 봉 — {@code paper.kr.quotes} 머리 {@code session} = D이고, {@code scope}의 종목 중 이어받지 않은 항목의
 *       마지막 봉 날짜가 D인 비율(수집기 {@code _has_session_bar}와 같은 규칙)</li>
 *   <li>③ U 90% 이상에 D 수급 — U 구성원 중 D 기록의 토스 판({@code updatedAt})이 D 15:35 KST 이후이고 기관 세부 칸이 채워진
 *       비율. <b>규칙 계좌의 입력 동결(K26)과 같은 읽기</b>({@link KrRuleBookService#readInputs} — 결정 시각 뒤에 받은 기록·받은 시각을 모르는
 *       기록은 빠진 채)로 셉니다: 게이트가 본 U·수급이 곧 그 결정이 쓰고 결정 행에 남기는 값입니다(D1c, 결정 e5). U를 읽지 못함(D보다 이른 기준일의
 *       U가 없음 — {@link KrRuleBookService.InputUnavailable})도 이 게이트의 미달입니다</li>
 *   <li>④ 금융위 기준일 = 직전 거래일 — {@code kr.fsc_prices_meta.latestBasDt} = D의 직전 KR 거래일</li>
 *   <li>⑤ 069500 D 봉 — 늦게 지정된 휴장일 대비(§4-4)</li>
 *   <li>⑥ D가 거래일 — 그 실행의 달력</li>
 * </ul>
 *
 * <p><b>읽기 한 번</b>({@link Inputs}): 관측치 저장본·금융위 메타·규칙 계좌 입력을 그 실행에서 한 번 읽고, 게이트와 그 결정(출발의 규칙 계좌 몫)이
 * 같은 값을 씁니다 — 저장본은 {@link StoreReader#quietly}로만(정기 작업이 수집을 깨우지 않게).
 */
final class KrDecisionGates {

    /** 게이트 ②·③의 문턱(§4-9 — 90% 이상). */
    static final double COVERAGE_MIN = 0.9;
    /** 게이트 ③ — D 수급 기록의 토스 판이 이 시각(KST) 이후여야 장 마감 뒤 판(개인·기관 세부 칸이 차는 판, §4-9 · 조사 2026-10-26). */
    static final LocalTime FLOWS_FROM = LocalTime.of(15, 35);
    private static final String FLOWS_FROM_TEXT = "15:35";

    /** 게이트 하나의 판정. {@code status}는 PASS·FAIL. */
    record Gate(String id, String status, String note) {

        boolean blocks() {
            return "FAIL".equals(status);
        }

        Map<String, Object> view() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("gate", id);
            out.put("status", status);
            out.put("note", note);
            return out;
        }
    }

    /**
     * 한 세션의 입력 — 그 실행에서 한 번 읽은 것(클래스 설명 '읽기 한 번').
     *
     * @param quotesSnapshot   관측치 저장본({@code paper.kr.quotes}, 없으면 null)
     * @param quotes           그 저장본의 한국 관측치(시장 파서 — 장부·거래정지·체결할 수 있는 종목 판정)
     * @param fscMeta          금융위 메타 저장본 본문(없으면 null)
     * @param rules            규칙 계좌 입력(K26 동결과 같은 읽기). 읽지 못했으면 null
     * @param rulesUnavailable 규칙 계좌 입력을 읽지 못한 사유(읽었으면 null)
     */
    record Inputs(LocalDate session, Snapshot quotesSnapshot, Optional<Quotes> quotes, JsonNode fscMeta,
                  KrRuleBookService.Read rules, String rulesUnavailable) {

        JsonNode quotesPayload() {
            return quotesSnapshot == null ? null : quotesSnapshot.payload();
        }
    }

    /** 판정과 그 재료 — 계좌 몫(출발)이 게이트를 결정 행에 남기고 같은 입력으로 계획합니다. */
    record Checked(List<Gate> gates, Inputs inputs) {

        Checked {
            gates = List.copyOf(gates);
        }

        List<Map<String, Object>> views() {
            return gates.stream().map(Gate::view).toList();
        }
    }

    private final StoreReader reader;
    private final KrRuleBookService rules;

    KrDecisionGates(StoreReader reader, KrRuleBookService rules) {
        this.reader = reader;
        this.rules = rules;
    }

    // ------------------------------------------------------------------ 읽기
    /** 관측치 저장본과 금융위 메타(게이트 ②④⑤⑥의 재료) — 규칙 계좌 입력은 아직 없음({@link #withRules}). */
    Inputs readSession(MarketRun run, LocalDate d) {
        Snapshot quotes = snapshot(Datasets.SNAP_KR_PAPER_QUOTES, KrPaperMarket.QUOTES_TASK);
        Snapshot meta = snapshot(Datasets.SNAP_FSC_PRICES_META, "fsc_prices");
        Optional<Quotes> parsed = quotes == null ? Optional.empty() : run.parse(quotes);
        return new Inputs(d, quotes, parsed, meta == null ? null : meta.payload(), null, null);
    }

    /**
     * 규칙 계좌 입력을 더한 입력(게이트 ③의 재료 — {@link KrRuleBookService#readInputs}, 읽은 순간 {@code readAt}). 보유·재진입 금지를 읽으므로
     * 정기 결정에서는 장부를 처리한 뒤에 부릅니다. U를 읽지 못하면 사유만 남깁니다(그 밖의 예외는 그대로 — 부르는 쪽의 오류).
     */
    Inputs withRules(MarketRun run, Inputs session, Instant readAt) {
        try {
            KrRuleBookService.Read read = rules.readInputs(run, session.session(), readAt, session.quotes());
            return new Inputs(session.session(), session.quotesSnapshot(), session.quotes(), session.fscMeta(), read, null);
        } catch (KrRuleBookService.InputUnavailable e) {
            return new Inputs(session.session(), session.quotesSnapshot(), session.quotes(), session.fscMeta(), null,
                    e.getMessage());
        }
    }

    // ------------------------------------------------------------------ 판정
    /** 출발 결정의 자료 게이트(클래스 설명 ②~⑥ — ①은 앞 주문이 없어 보지 않음, §4-8). */
    List<Gate> start(MarketRun run, Inputs in) {
        TradingCalendar calendar = run.calendar();
        List<Gate> out = new ArrayList<>();
        out.add(coverage(in.quotesPayload(), in.session()));
        out.add(flows(in));
        out.add(fsc(in.fscMeta(), calendar.previousTradingDay(in.session())));
        out.add(anchor(in.quotesPayload(), in.session()));
        out.add(tradingDay(calendar, in.session()));
        return out;
    }

    /** ② 수집 범위 90% 이상에 D 봉(클래스 설명). */
    static Gate coverage(JsonNode quotes, LocalDate d) {
        if (quotes == null) {
            return new Gate("②", "FAIL", "관측치 저장본(paper.kr.quotes)이 없음");
        }
        String session = text(quotes.get("session"));
        if (!d.toString().equals(session)) {
            return new Gate("②", "FAIL", "관측치 세션 " + session + " ≠ " + d + "(그날 20:30 뒤 수집 전)");
        }
        JsonNode scope = quotes.get("scope");
        int total = scope == null || !scope.isArray() ? 0 : scope.size();
        if (total == 0) {
            return new Gate("②", "FAIL", "수집 범위(scope)가 비었음");
        }
        int covered = 0;
        for (JsonNode code : scope) {
            if (hasSessionBar(quotes, text(code), d)) {
                covered++;
            }
        }
        String note = "수집 범위 " + covered + "/" + total + "에 " + d + " 봉";
        return covered >= COVERAGE_MIN * total ? new Gate("②", "PASS", note) : new Gate("②", "FAIL", note + "(90% 미만)");
    }

    /**
     * ③ U 90% 이상에 D 수급(클래스 설명) — U 구성원마다 그 입력의 D 기록 판({@link KrRuleBookService.Stamp})을 봅니다: 기록 없음(빠진 기록 포함)·판
     * 모름(토스 {@code updatedAt}을 읽지 못함)·15:35 전 판·세부 칸 없음은 세지 않습니다.
     */
    static Gate flows(Inputs in) {
        if (in.rules() == null) {
            return new Gate("③", "FAIL", "U·수급을 읽지 못함 — " + in.rulesUnavailable());
        }
        LocalDate d = in.session();
        Instant from = ZonedDateTime.of(d, FLOWS_FROM, KrxCalendar.SEOUL).toInstant();
        List<String> missing = new ArrayList<>();
        List<String> unknown = new ArrayList<>();
        List<String> early = new ArrayList<>();
        List<String> noDetail = new ArrayList<>();
        int total = 0;
        int covered = 0;
        for (com.macrodash.analytics.KrRules.Member member : in.rules().input().universe()) {
            total++;
            KrRuleBookService.Stamp stamp = in.rules().stamps().get(member.code());
            Instant updated = stamp == null ? null : instant(stamp.updatedAt());
            if (stamp == null) {
                missing.add(member.code());
            } else if (updated == null) {
                unknown.add(member.code());
            } else if (updated.isBefore(from)) {
                early.add(member.code());
            } else if (!stamp.detail()) {
                noDetail.add(member.code());
            } else {
                covered++;
            }
        }
        StringBuilder note = new StringBuilder("U " + covered + "/" + total + "에 " + d + " 수급(" + FLOWS_FROM_TEXT
                + " 뒤 판·세부 칸, U 기준일 " + in.rules().input().universeDate() + ")");
        miss(note, "D 기록 없음", missing);
        miss(note, "판 모름", unknown);
        miss(note, FLOWS_FROM_TEXT + " 전 판", early);
        miss(note, "세부 칸 없음", noDetail);
        return total > 0 && covered >= COVERAGE_MIN * total ? new Gate("③", "PASS", note.toString())
                : new Gate("③", "FAIL", note + "(90% 미만)");
    }

    /** ④ 금융위 기준일 = 직전 거래일(클래스 설명). */
    static Gate fsc(JsonNode meta, LocalDate previous) {
        String latest = meta == null ? null : text(meta.get("latestBasDt"));
        String note = "금융위 기준일 " + latest + " · 직전 거래일 " + previous;
        return previous.toString().equals(latest) ? new Gate("④", "PASS", note) : new Gate("④", "FAIL", note);
    }

    /** ⑤ 069500 D 봉(클래스 설명). */
    static Gate anchor(JsonNode quotes, LocalDate d) {
        boolean has = quotes != null && hasSessionBar(quotes, PaperBooks.KODEX_200, d);
        return has ? new Gate("⑤", "PASS", PaperBooks.KODEX_200 + " " + d + " 봉 있음")
                : new Gate("⑤", "FAIL", PaperBooks.KODEX_200 + " " + d + " 봉 없음(휴장 또는 지연)");
    }

    /** ⑥ D가 거래일(그 실행의 달력). */
    static Gate tradingDay(TradingCalendar calendar, LocalDate d) {
        return calendar.isTradingDay(d) ? new Gate("⑥", "PASS", d + " KRX 거래일")
                : new Gate("⑥", "FAIL", d + "는 KRX 거래일이 아님");
    }

    /** 그 종목 항목이 이번에 받은 것(이어받기 아님)이고 마지막 봉 날짜가 D인가 — 수집기 {@code _has_session_bar}. */
    static boolean hasSessionBar(JsonNode quotes, String code, LocalDate d) {
        JsonNode codes = quotes.get("codes");
        JsonNode entry = codes == null || code == null ? null : codes.get(code);
        if (entry == null || !entry.isObject() || entry.path("isStale").asBoolean(false)) {
            return false;
        }
        String last = null;
        JsonNode bars = entry.get("bars");
        if (bars != null && bars.isArray()) {
            for (JsonNode bar : bars) {
                String date = text(bar.get("date"));
                if (date != null && (last == null || date.compareTo(last) > 0)) {
                    last = date;
                }
            }
        }
        return d.toString().equals(last);
    }

    /** 막는 게이트의 '번호 사유' 목록(없으면 빈 목록). */
    static List<String> blocking(List<Gate> gates) {
        return gates.stream().filter(Gate::blocks).map(g -> g.id() + " " + g.note()).toList();
    }

    // ------------------------------------------------------------------ 조각
    private static void miss(StringBuilder note, String label, List<String> codes) {
        if (codes.isEmpty()) {
            return;
        }
        note.append(" · ").append(label).append(' ').append(codes.size()).append('(')
                .append(String.join(",", codes.subList(0, Math.min(5, codes.size()))))
                .append(codes.size() > 5 ? ",…" : "").append(')');
    }

    private Snapshot snapshot(String dataset, String task) {
        Optional<Snapshot> found = reader.quietly(() -> reader.read(dataset, Datasets.MAX_AGE_DAILY, task));
        return found == null ? null : found.orElse(null);
    }

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

    private static String text(JsonNode node) {
        return node == null || !node.isString() ? null : node.asString("");
    }
}
