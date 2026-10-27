package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
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
 *   <li>③ U 90% 이상에 D 수급(15:35 뒤 판·세부 칸) — <b>STUB(D1)</b>: 유니버스·수급 읽기는 규칙 계좌의 입력 동결(K26)과 같은 한 번의
 *       읽기여야 하므로 그 읽기를 만드는 D1이 판정을 채웁니다(벤치마크만 출발하는 이 묶음은 수급을 쓰지 않음)</li>
 *   <li>④ 금융위 기준일 = 직전 거래일 — {@code kr.fsc_prices_meta.latestBasDt} = D의 직전 KR 거래일</li>
 *   <li>⑤ 069500 D 봉 — 늦게 지정된 휴장일 대비(§4-4)</li>
 *   <li>⑥ D가 거래일 — 그 실행의 달력</li>
 * </ul>
 */
final class KrDecisionGates {

    /** 게이트 ②·③의 문턱(§4-9 — 90% 이상). */
    static final double COVERAGE_MIN = 0.9;

    /** 게이트 하나의 판정. {@code status}는 PASS·FAIL·STUB(아직 판정하지 않음 — 맡은 묶음). */
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

    private final StoreReader reader;

    KrDecisionGates(StoreReader reader) {
        this.reader = reader;
    }

    /** 출발 결정의 자료 게이트(클래스 설명 ②~⑥ — ①은 앞 주문이 없어 보지 않음, §4-8). */
    List<Gate> start(MarketRun run, LocalDate d) {
        TradingCalendar calendar = run.calendar();
        JsonNode quotes = read(Datasets.SNAP_KR_PAPER_QUOTES, KrPaperMarket.QUOTES_TASK);
        List<Gate> out = new ArrayList<>();
        out.add(coverage(quotes, d));
        out.add(new Gate("③", "STUB", "U 90% 이상의 D 수급(15:35 뒤 판·세부 칸) — 2단계 D1이 규칙 계좌 입력 동결(K26)과 같은 읽기로 판정"));
        out.add(fsc(read(Datasets.SNAP_FSC_PRICES_META, "fsc_prices"), calendar.previousTradingDay(d)));
        out.add(anchor(quotes, d));
        out.add(tradingDay(calendar, d));
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

    private JsonNode read(String dataset, String task) {
        Optional<Snapshot> found = reader.quietly(() -> reader.read(dataset, Datasets.MAX_AGE_DAILY, task));
        return found == null ? null : found.map(Snapshot::payload).orElse(null);
    }

    private static String text(JsonNode node) {
        return node == null || !node.isString() ? null : node.asString("");
    }
}
