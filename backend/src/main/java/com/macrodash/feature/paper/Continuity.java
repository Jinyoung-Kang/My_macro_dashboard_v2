package com.macrodash.feature.paper;

import com.macrodash.analytics.CarriedConditions;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.DecisionSummary;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 판단 이어받기(ADR 0038) — Claude 결정이 스스로 적은 것(보유 종목의 진입 논거·무효화 조건, 다음에 확인할 조건, 관심 목록의 조건, 바라는 노출과
 * 그 계획)을 다음 결정과 그 세션의 장중 판단 패킷에 <b>코드가 그대로 돌려주는</b> 판입니다. 그 전에는 결정마다 처음부터 다시 판단했습니다 — 최근
 * 결정 요약은 300자에서 잘려 반증 조건이 사라졌고, 보유 행에는 가격만 있었고, 미국 장중 판단은 그 세션 결정의 논거를 보지 못했습니다.
 *
 * <p><b>스위치</b>: 미국 {@value #US_KEY}, 한국 {@value #KR_KEY} — 기본 꺼짐. 자유 시점 판({@link ClaudeBookProfile#freeTiming})을 켠 계좌에만
 * 듭니다({@link #on(ClaudeBookProfile, JsonNode)}). 꺼져 있거나 자유 시점 판이 아니면 시스템 프롬프트·응답 스키마·패킷이 이 키가 생기기 전과
 * 바이트까지 같습니다(고정본 시험). 켜면 그 계좌의 다음 결정부터:
 * <ul>
 *   <li>고정 문단에 이어받기 절({@link ClaudePrompts#CONTINUITY_SECTION})이 붙고, 응답 스키마가 세 칸
 *       ({@code desiredEquityExposurePct}·{@code exposurePlan}·{@code conditions})을 더 받습니다.</li>
 *   <li>결정 패킷: 보유 행마다 {@code entry}(그 종목을 산 결정의 논거·무효화 조건 — {@link #entries}), 섹션 {@value #SECTION}(직전 결정의
 *       바라는 노출·계획·조건과 지금 값으로 매긴 상태·관심 목록 — {@link #carried}), {@code 1_basis.continuity}.</li>
 *   <li>장중 판단 패킷: 그 세션 결정의 요약·주문 논거(미국 {@value #INTRADAY_DECISION} — 한국은 {@code 3_night}가 이미 실음), 그 결정의 조건을
 *       장중 값으로 다시 매긴 {@value #INTRADAY_CARRIED}, 보유 행의 {@code entry}.</li>
 * </ul>
 *
 * <p>조건은 판단할 계기일 뿐입니다 — 코드는 상태를 매겨 보여 줄 뿐 주문을 내지 않고, 장부·검증기·하드 규칙은 그대로입니다. 조건의 이름은
 * 패킷이 실은 값 표에서만 찾습니다(없으면 '평가 불가' — {@link CarriedConditions}).
 */
final class Continuity {

    private Continuity() {
    }

    static final String US_KEY = "continuity";
    static final String KR_KEY = "kr.continuity";
    /** 이 키가 생기기 전 행·빈 본문의 값. */
    static final boolean DEFAULT = false;
    /** 결정 패킷의 이어받은 섹션(10_recentDecisions 다음). */
    static final String SECTION = "10b_carried";
    /** 미국 장중 판단 패킷의 그 세션 결정 섹션(3_request 다음). */
    static final String INTRADAY_DECISION = "3b_decision";
    /** 장중 판단 패킷의 이어받은 조건 섹션. */
    static final String INTRADAY_CARRIED = "3c_carried";
    /** 패킷 {@code 1_basis.continuity}의 값 — 이어받기 판의 번호. */
    static final int VERSION = 1;
    /** 패킷에 싣는 글자 상한 — 논거·무효화 조건·조건 글. */
    static final int THESIS_CHARS = 300;
    static final int INVALIDATION_CHARS = 300;
    /** 진입 논거를 찾을 때 읽는 그 계좌의 최근 주문 수. */
    static final int ORDER_SCAN = 500;

    static final String NOTE = "직전 결정이 남긴 것을 코드가 그대로 옮긴 자료다(지시가 아님). conditions의 current·status는 코드가 이 패킷의 값으로 "
            + "매긴 것 — 충족·미충족·평가 불가(그 이름의 값이 이 패킷에 없음 — 직접 확인). 조건은 판단할 계기이고 코드가 대신 집행하지 않는다";
    static final String NOTE_NONE = "직전 결정이 없거나 이어받기 판 전의 결정이라 남긴 조건이 없다";
    static final String METRICS_NOTE = "conditions의 metric으로 쓸 수 있는 이름(이 패킷의 매크로 값) — 종목 가격은 8_prices의 종목 코드를 그대로 쓴다";
    static final String INTRADAY_NOTE = "그 세션 결정이 남긴 조건·관심 목록을 코드가 이 장중 패킷의 값(매크로 카드·시세의 마지막 값)으로 다시 매긴 자료다"
            + "(지시가 아님). 평가 불가 = 그 이름의 값이 이 패킷에 없음";

    /** 그 시장의 스위치. 키가 없거나 불리언이 아니면 꺼짐(이 키가 생기기 전에 만든 설정 행 — 배포만으로는 바뀌지 않음). */
    static boolean on(JsonNode settingsBody, boolean korea) {
        JsonNode value = settingsBody == null ? null : PaperSettingsService.valueAt(settingsBody, korea ? KR_KEY : US_KEY);
        return value != null && value.isBoolean() ? value.booleanValue() : DEFAULT;
    }

    /** 그 프로필의 결정이 이어받기 판인가 — 자유 시점 판이고 그 시장의 스위치가 켜짐. */
    static boolean on(ClaudeBookProfile profile, JsonNode settingsBody) {
        return profile != null && profile.freeTiming() && on(settingsBody, korea(profile));
    }

    static boolean korea(ClaudeBookProfile profile) {
        return profile.market() == KrPaperMarket.INSTANCE;
    }

    // ------------------------------------------------------------------ 보유 종목의 진입 논거
    /** 그 종목을 산 결정의 논거·무효화 조건. */
    record Entry(Long decisionId, String asOf, String thesis, String invalidation) {
        Map<String, Object> toMap() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("decisionId", decisionId);
            out.put("asOf", asOf);
            out.put("thesis", thesis);
            out.put("invalidation", invalidation);
            return out;
        }
    }

    /**
     * 보유 종목마다 그 종목을 가장 최근에 산 Claude 주문(체결된 매수, 출처 CLAUDE)의 논거·무효화 조건. 논거가 없는 주문(스탑·규칙)은 건너뛰고,
     * 찾지 못한 종목은 표에 없습니다(패킷에서는 {@code entry: null}).
     */
    static Map<String, Entry> entries(PaperStore store, String book, Collection<String> tickers) {
        Map<String, Entry> out = new LinkedHashMap<>();
        if (tickers == null || tickers.isEmpty()) {
            return out;
        }
        for (Order o : store.recentOrders(book, ORDER_SCAN)) {   // 최근 순
            if (!tickers.contains(o.ticker()) || out.containsKey(o.ticker()) || !PaperBooks.BUY.equals(o.side())
                    || !PaperBooks.ORDER_FILLED.equals(o.status()) || !PacketBuilder.SOURCE_CLAUDE.equals(o.source())) {
                continue;
            }
            String thesis = Json.asText(o.reason(), "thesis");
            String invalidation = Json.asText(o.reason(), "invalidation");
            if (thesis == null && invalidation == null) {
                continue;
            }
            out.put(o.ticker(), new Entry(o.decisionId(), o.asOfTradingDate() == null ? null : o.asOfTradingDate().toString(),
                    clip(thesis, THESIS_CHARS), clip(invalidation, INVALIDATION_CHARS)));
        }
        return out;
    }

    /** 보유 행마다 {@code entry}를 붙입니다(찾지 못한 종목은 null). {@code positions}는 {@code ticker} 칸이 있는 행 목록입니다. */
    @SuppressWarnings("unchecked")
    static void attachEntries(Object positions, Map<String, Entry> entries) {
        if (!(positions instanceof List<?> rows)) {
            return;
        }
        for (Object row : rows) {
            if (row instanceof Map<?, ?> map) {
                Entry entry = entries.get(String.valueOf(map.get("ticker")));
                ((Map<String, Object>) map).put("entry", entry == null ? null : entry.toMap());
            }
        }
    }

    /**
     * 장중 판단 패킷에 더할 것 — 보유 종목의 진입 논거({@link #entries})와 그 세션 결정 뒤의 사건 뉴스 섹션(뉴스 설정이 꺼졌거나 읽지 못했으면
     * null). 이 값이 있으면(null이 아니면) 그 장중 판단은 이어받기 판입니다.
     */
    record Intraday(Map<String, Entry> entries, Map<String, Object> events) {
    }

    /** 장중 판단 패킷의 사건 뉴스 섹션(그 세션 결정 뒤부터 조립 시각까지 — 결정 패킷의 11b_events와 같은 모양). */
    static final String INTRADAY_EVENTS = "3d_events";
    static final String PREV_CLOSE_NOTE = "그 세션 결정 패킷의 8_prices 종가(전 거래일 종가) — 장중 값의 전일 대비를 셀 때 쓴다. 그 패킷에 없던 종목은 없음";

    /**
     * 장중 패킷의 그 종목들의 전 거래일 종가 — 그 세션 결정이 본 패킷의 {@code 8_prices}에서(없는 종목은 뺌).
     *
     * @param tickerColumn 그 시장 가격 섹션의 종목 열(미국 {@code ticker}·한국 {@code code})
     */
    static Map<String, Object> prevCloses(JsonNode decisionPacket, String tickerColumn, Collection<String> tickers) {
        Map<String, Double> closes = table(Json.child(decisionPacket, PacketBuilder.PRICES), tickerColumn, "close");
        Map<String, Object> values = new LinkedHashMap<>();
        for (String ticker : tickers) {
            if (closes.containsKey(ticker)) {
                values.putIfAbsent(ticker, closes.get(ticker));
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("note", PREV_CLOSE_NOTE);
        out.put("values", values);
        return out;
    }

    /**
     * 한국 종목 코드 → 이름(뉴스 제목 대조용) — 밤 결정 패킷의 {@code 8_prices}에서(이름이 없는 줄 — ETF 등 — 은 뺌).
     */
    static Map<String, List<String>> krNames(JsonNode nightPacket, Collection<String> codes) {
        Map<String, List<String>> out = new LinkedHashMap<>();
        JsonNode section = Json.child(nightPacket, PacketBuilder.PRICES);
        List<JsonNode> columns = Json.array(section, "columns");
        int codeAt = -1;
        int nameAt = -1;
        for (int i = 0; i < columns.size(); i++) {
            String name = columns.get(i).isString() ? columns.get(i).asString() : null;
            if ("code".equals(name)) {
                codeAt = i;
            } else if ("name".equals(name)) {
                nameAt = i;
            }
        }
        if (codeAt < 0 || nameAt < 0) {
            return out;
        }
        for (JsonNode row : Json.array(section, "rows")) {
            JsonNode code = row.isArray() ? row.get(codeAt) : null;
            JsonNode name = row.isArray() ? row.get(nameAt) : null;
            if (code != null && code.isString() && name != null && name.isString() && !name.asString().isBlank()
                    && codes.contains(code.asString())) {
                out.putIfAbsent(code.asString(), List.of(name.asString()));
            }
        }
        return out;
    }

    /** 보유 행 목록의 종목 코드({@code ticker} 칸). */
    static List<String> tickers(Object positions) {
        List<String> out = new ArrayList<>();
        if (positions instanceof List<?> rows) {
            for (Object row : rows) {
                if (row instanceof Map<?, ?> map && map.get("ticker") != null) {
                    out.add(String.valueOf(map.get("ticker")));
                }
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ 직전 결정이 남긴 것
    /**
     * 모델 판단이 남은 가장 최근 결정 — 검증된 응답에만 있는 {@code schemaVersion}으로 가립니다({@link PacketBuilder}의 직전 watchlist와 같은 규칙:
     * 형식 오류·호출 실패·건너뜀은 건너뜀).
     *
     * @param prior 앞선 결정(최근 순)
     */
    static Decision latestJudged(PaperStore store, List<DecisionSummary> prior) {
        for (DecisionSummary summary : prior) {
            Decision d = store.decision(summary.id()).orElse(null);
            JsonNode response = d == null ? null : d.response();
            if (response != null && response.isObject() && response.has("schemaVersion")) {
                return d;
            }
        }
        return null;
    }

    /** 결정 응답의 조건 목록(적힌 순서). 모양이 다른 항목은 평가에서 '평가 불가'가 됩니다. */
    static List<CarriedConditions.Condition> conditions(JsonNode response) {
        List<CarriedConditions.Condition> out = new ArrayList<>();
        for (JsonNode item : Json.array(response, "conditions")) {
            out.add(new CarriedConditions.Condition(Json.asText(item, "metric"), Json.asText(item, "op"),
                    Json.asDouble(item, "level"), Json.asText(item, "then")));
        }
        return out;
    }

    /**
     * 결정 패킷의 {@value #SECTION} — 직전 결정의 바라는 노출·계획·조건(지금 값으로 매긴 상태)·관심 목록과, 조건에 쓸 수 있는 이름.
     *
     * @param prior   모델 판단이 남은 가장 최근 결정({@link #latestJudged}) — 없으면 null
     * @param metrics 이 패킷의 값 표(이름 → 값 — 매크로 값과 종목 가격)
     * @param names   그 가운데 조건의 이름으로 보일 매크로 이름(종목 코드는 빼고)
     */
    static Map<String, Object> carried(Decision prior, Map<String, Double> metrics, List<String> names) {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode response = prior == null ? null : prior.response();
        boolean left = response != null && (response.has("conditions") || response.has("desiredEquityExposurePct"));
        out.put("note", left ? NOTE : NOTE_NONE);
        if (prior == null) {
            out.put("fromDecision", null);
        } else {
            Map<String, Object> from = new LinkedHashMap<>();
            from.put("id", prior.id());
            from.put("tradingDate", prior.asOfTradingDate() == null ? null : prior.asOfTradingDate().toString());
            from.put("kind", prior.kind());
            out.put("fromDecision", from);
        }
        out.put("desiredEquityExposurePct", Json.asDouble(response, "desiredEquityExposurePct"));
        out.put("targetEquityExposurePct", Json.asDouble(response, "targetEquityExposurePct"));
        out.put("exposurePlan", Json.asText(response, "exposurePlan"));
        out.put("conditions", evaluated(conditions(response), metrics));
        out.put("watchlist", watchlist(response));
        Map<String, Object> vocabulary = new LinkedHashMap<>();
        vocabulary.put("names", names);
        vocabulary.put("note", METRICS_NOTE);
        out.put("metrics", vocabulary);
        return out;
    }

    /** 장중 판단 패킷의 {@value #INTRADAY_CARRIED} — 그 세션 결정의 조건을 장중 값으로 다시 매긴 것과 관심 목록. */
    static Map<String, Object> intradayCarried(Decision source, Map<String, Double> metrics) {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode response = source == null ? null : source.response();
        out.put("note", INTRADAY_NOTE);
        out.put("desiredEquityExposurePct", Json.asDouble(response, "desiredEquityExposurePct"));
        out.put("exposurePlan", Json.asText(response, "exposurePlan"));
        out.put("conditions", evaluated(conditions(response), metrics));
        out.put("watchlist", watchlist(response));
        return out;
    }

    /** 미국 장중 판단 패킷의 {@value #INTRADAY_DECISION} — 그 세션 결정의 요약·자세·노출·주문 논거(한국 {@code 3_night}와 같은 모양). */
    static Map<String, Object> intradayDecision(Decision source) {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode response = source == null ? null : source.response();
        out.put("decisionId", source == null ? null : source.id());
        out.put("summary", Json.asText(response, "summary"));
        out.put("stance", Json.asText(response, "stance"));
        out.put("targetEquityExposurePct", Json.asDouble(response, "targetEquityExposurePct"));
        out.put("noTradeReason", Json.asText(response, "noTradeReason"));
        List<Map<String, Object>> orders = new ArrayList<>();
        for (JsonNode o : Json.array(response, "orders")) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", Json.asText(o, "ticker"));
            row.put("side", Json.asText(o, "side"));
            row.put("timing", Json.asText(o, "timing"));
            row.put("targetWeightPct", Json.asDouble(o, "targetWeightPct"));
            row.put("sellFraction", Json.asDouble(o, "sellFraction"));
            row.put("executionNote", Json.asText(o, "executionNote"));
            row.put("thesis", Json.asText(o, "thesis"));
            row.put("invalidation", Json.asText(o, "invalidation"));
            orders.add(row);
        }
        out.put("orders", orders);
        return out;
    }

    private static List<Map<String, Object>> evaluated(List<CarriedConditions.Condition> conditions, Map<String, Double> metrics) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (CarriedConditions.Evaluated e : CarriedConditions.evaluate(conditions, CarriedConditions.index(metrics))) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("metric", e.condition().metric());
            row.put("op", e.condition().op());
            row.put("level", e.condition().level());
            row.put("then", e.condition().then());
            row.put("current", e.current());
            row.put("status", e.status());
            if (e.reason() != null) {
                row.put("reason", e.reason());
            }
            out.add(row);
        }
        return out;
    }

    private static List<Map<String, Object>> watchlist(JsonNode response) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (JsonNode item : Json.array(response, "watchlist")) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", Json.asText(item, "ticker"));
            row.put("condition", Json.asText(item, "condition"));
            out.add(row);
        }
        return out;
    }

    // ------------------------------------------------------------------ 값 표(조건의 이름 → 지금 값)
    /**
     * 미국 패킷의 매크로 값 — 매크로 카드({@code 2_macroCards.cards.items}의 {@code key} → {@code price})와 국면의 하이일드 스프레드
     * ({@code 4_regime.inputs.hyOas.value} → {@code hyOas}, 장중 패킷에는 없음). 넣은 순서가 {@code metrics.names}의 순서입니다.
     */
    static Map<String, Double> usMacro(JsonNode macroCards, JsonNode regime) {
        Map<String, Double> out = new LinkedHashMap<>();
        JsonNode cards = Json.child(macroCards, "cards");
        // 결정·장중 패킷의 카드는 {items:[{key, price}]} 꼴입니다. 목록 꼴({key, value})도 읽습니다(옛 장중 확인 고정본의 모양).
        List<JsonNode> items = cards != null && cards.isArray() ? Json.array(macroCards, "cards") : Json.array(cards, "items");
        for (JsonNode card : items) {
            String key = Json.asText(card, "key");
            Double value = Json.asDouble(card, "price");
            if (value == null) {
                value = Json.asDouble(card, "value");
            }
            if (key != null && value != null) {
                out.putIfAbsent(key, value);
            }
        }
        Double hyOas = Json.asDouble(Json.child(Json.child(regime, "inputs"), "hyOas"), "value");
        if (hyOas != null) {
            out.putIfAbsent("hyOas", hyOas);
        }
        return out;
    }

    /**
     * 한국 패킷의 매크로 값 — 환율({@code 3_kr_macro.fx.items}의 {@code key} → {@code close})과 시장별 외국인 순매수
     * ({@code investorFlows.rows} — {@code kospiForeignNet}·{@code kospiForeignNet5}·{@code kospiForeignNet20}, 코스닥도 같은 꼴, 억 원).
     */
    static Map<String, Double> krMacro(JsonNode krMacro) {
        Map<String, Double> out = new LinkedHashMap<>();
        for (JsonNode fx : Json.array(Json.child(krMacro, "fx"), "items")) {
            String key = Json.asText(fx, "key");
            Double close = Json.asDouble(fx, "close");
            if (key != null && close != null) {
                out.putIfAbsent(key, close);
            }
        }
        for (JsonNode row : Json.array(Json.child(krMacro, "investorFlows"), "rows")) {
            String market = Json.asText(row, "market");
            if (market == null) {
                continue;
            }
            String prefix = market.toLowerCase(java.util.Locale.ROOT) + "ForeignNet";
            JsonNode foreigner = Json.child(row, "foreigner");
            put(out, prefix, Json.asDouble(foreigner, "sessionNet"));
            put(out, prefix + "5", Json.asDouble(foreigner, "net5"));
            put(out, prefix + "20", Json.asDouble(foreigner, "net20"));
        }
        return out;
    }

    /**
     * 가격 섹션(열 이름 + 행 목록 — {@code 8_prices}·미국 장중 시간별 피드)의 종목 → 값.
     *
     * @param tickerColumn 종목 열 이름(미국 {@code ticker}·한국 {@code code})
     * @param valueColumn  값 열 이름({@code close})
     */
    static Map<String, Double> table(JsonNode section, String tickerColumn, String valueColumn) {
        Map<String, Double> out = new LinkedHashMap<>();
        List<JsonNode> columns = Json.array(section, "columns");
        int tickerAt = -1;
        int valueAt = -1;
        for (int i = 0; i < columns.size(); i++) {
            String name = columns.get(i).isString() ? columns.get(i).asString() : null;
            if (tickerColumn.equals(name)) {
                tickerAt = i;
            } else if (valueColumn.equals(name)) {
                valueAt = i;
            }
        }
        if (tickerAt < 0 || valueAt < 0) {
            return out;
        }
        for (JsonNode row : Json.array(section, "rows")) {
            JsonNode ticker = row.isArray() ? row.get(tickerAt) : null;
            JsonNode value = row.isArray() ? row.get(valueAt) : null;
            if (ticker != null && ticker.isString() && value != null && value.isNumber()) {
                out.putIfAbsent(ticker.asString(), value.asDouble());
            }
        }
        return out;
    }

    /**
     * 장중 감시 피드({@code 5_feed.tickers})의 종목 → 마지막 값 — 미국 1분봉 피드는 {@code last}, 한국은 {@code lastBar.c}.
     */
    static Map<String, Double> feedLast(JsonNode feed) {
        Map<String, Double> out = new LinkedHashMap<>();
        JsonNode tickers = Json.child(feed, "tickers");
        if (tickers == null || !tickers.isObject()) {
            return out;
        }
        for (Map.Entry<String, JsonNode> entry : tickers.properties()) {
            Double last = Json.asDouble(entry.getValue(), "last");
            if (last == null) {
                last = Json.asDouble(Json.child(entry.getValue(), "lastBar"), "c");
            }
            put(out, entry.getKey(), last);
        }
        return out;
    }

    private static void put(Map<String, Double> out, String name, Double value) {
        if (value != null) {
            out.putIfAbsent(name, value);
        }
    }

    /** 글자 상한으로 자름(끝 '…' 포함, 서로게이트 쌍을 가르지 않음 — 복기 입력과 같은 규칙). */
    static String clip(String text, int max) {
        return com.macrodash.analytics.ReviewFacts.clip(text, max);
    }
}
