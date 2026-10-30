package com.macrodash.feature.paper;

import com.macrodash.analytics.DailySeries;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * 🧪 한국 관측치 저장본 {@code paper.kr.quotes} <b>계약 1</b>(2단계 명세 §9 묶음 A 리뷰 메모 'B4·C2' — 쓰는 곳은 수집기 {@code kr_paper_quotes}
 * 하나)을 한국 봉으로 읽습니다(결정 d10 — 시장이 파싱을 가짐, C2b). 미국 {@code paper.quotes}·{@link PaperMarketData#parse}는 건드리지 않습니다.
 *
 * <p><b>읽는 모양</b>: 머리 {@code contract}(1이 아니면 모르는 모양 — 짐작하지 않고 empty)·{@code session}(그 실행의 대상 KR 세션 D)·
 * {@code codes.{코드}} = {@code status}(OK·NO_BARS)·{@code fetchedAt}(그 종목을 받은 시각 — 체결 조건 ①의 '관측 수집 시각')·
 * {@code securityType}·{@code nxtSupported}·{@code krxTradingSuspended}·{@code bars[]}(오래된 날 → 최근, 최근 5봉)·이어받았으면
 * {@code isStale}. 봉 = {@code date}·{@code open}·{@code close}·{@code volume}(토스 {@code adjusted=false} 원시)·{@code priceSource}
 * ({@code TOSS_DAILY} 토스가 NXT 미지원으로 표시한 봉 — 시가는 KRX 시가 단일가, 종가에는 20:00까지의 장 마감 뒤 체결이 섞일 수 있음(QA-146)·
 * {@code TOSS_INTEGRATED} KRX+NXT 통합가)·{@code adjRatio}·{@code minute}(1분봉 개장 봉 — 받았을 때만:
 * {@code status} OK·NO_BAR·FAILED, {@code opens} = 라벨(봉 <b>끝</b> 시각 KST) → 시가·거래량). 고가·저가·수정 종가는 체결·평가에 쓰지 않아
 * 읽지 않습니다(§4-1).
 *
 * <p><b>장부 관측치</b>({@link Bar}): 종목마다 마지막 봉의 날짜·종가(평가·순자산 줄 — 토스 잠정 종가), 이어받은 항목이면 {@code stale}
 * (관측이 아님 — 체결하지 않고 '가격 없음'으로 평가), 최근 봉 종가 이력({@code recent}), 그리고 한국 칸 전부({@link Quote} — 체결 봉
 * 고르기가 기준일 뒤 첫 관측 봉을 이 창에서 찾음). <b>빼는 종목</b>(관측치에 없음 = 보유는 마지막 가격 + '가격 없음'): 상태가 OK가 아님
 * ({@code NO_BARS} '응답에 없음'·모르는 상태), 봉이 없음, 날짜를 모르는 봉이 있거나 날짜가 오름차순이 아님(어느 값이 어느 날인지 믿을 수
 * 없음), 마지막 봉 종가가 없음(지금 값이 없음 — 직전 봉으로 대신하지 않음), 코드가 6자리 대문자·숫자가 아님. 이번에 받은 {@code NO_BARS}
 * 종목은 관측치의 '응답에 없음' 목록({@link Quotes#absent})에 따로 둡니다(기업행위 판정의 토스 상장 상태 — C2c). 가격은 양수만(아니면
 * null — 0원은 '체결 없음'), 거래량은 0 이상 정수만(모르면 null — 0으로 채우지 않음, 0은 정지일)입니다. 수집 시각을 모르거나 쓸 수 있는
 * 종목이 하나도 없으면 empty입니다.
 */
final class KrQuotes {

    private KrQuotes() {
    }

    /** 읽는 계약 판 — 수집기 {@code kr_paper.KR_QUOTES_CONTRACT}. 판이 오르면(G2 통과 뒤 종가 1분봉) 이 파서를 함께 고칩니다. */
    static final int CONTRACT = 1;

    /** 종목 상태 — 토스가 봉을 줌. */
    static final String STATUS_OK = "OK";
    /** 종목 상태 — 토스가 답했는데 봉 0개('응답에 없음'). */
    static final String STATUS_NO_BARS = "NO_BARS";

    /** 1분봉 개장 봉 상태 — 받음(라벨 봉이 있거나 없거나는 {@code opens}로). */
    static final String MINUTE_OK = "OK";
    /** 1분봉 개장 봉 상태 — 답했는데 그날 그 라벨 봉이 없음. */
    static final String MINUTE_NO_BAR = "NO_BAR";
    /** 1분봉 개장 봉 상태 — 호출 실패·'아직 묻지 못함'(수집기가 같은 밤 다음 slow 주기에 그 봉만 다시 물음). */
    static final String MINUTE_FAILED = "FAILED";

    /** 한국 체결가 출처(§4-14 {@code paper_fills.price_source}) — 1분봉 '개장 + 1분' 봉 시가(KRX 시가 단일가, G1). */
    static final String SOURCE_1M_OPEN = "TOSS_1M_OPEN";
    /** 한국 가격 출처 — 토스 일봉, KRX+NXT 통합가(NXT 종목·NXT 여부를 모르는 종목). */
    static final String SOURCE_INTEGRATED = "TOSS_INTEGRATED";
    /**
     * 한국 가격 출처 — 토스 일봉, 토스가 NXT 미지원으로 표시한 봉({@code nxtSupported = false} — ETF와 그렇게 표시된 주식). 시가는 KRX 시가
     * 단일가지만, 종가는 그런 주식도 20:00 봉 종가라 장 마감 뒤 체결이 섞여 KRX 정규장 종가와 다를 수 있습니다(QA-146 — ETF 종가는 금융위와 같았음).
     */
    static final String SOURCE_DAILY = "TOSS_DAILY";

    private static final Pattern CODE = Pattern.compile("^[0-9A-Z]{6}$");

    /**
     * 종목 하나({@code codes.{코드}}) — 장부가 읽는 칸.
     *
     * @param fetchedAt 그 종목을 받은 시각(수집기 실행 시작 — 실제로 받은 순간보다 늘 이름, B4). 모르면 null(체결 조건 ①을 판정할 수 없어 체결하지 않음)
     * @param days      최근 봉, 날짜 오름차순(비지 않음)
     * @param fscMarket 금융위 시장 구분({@code fsc_price.market} — 비용 종목 구분, §4-3). 저장본에는 없고 장부가 체결 전에 덧붙입니다(모르면 null)
     * @param choice    체결 봉 고르기가 고른 체결(그 봉 날짜·체결가·출처) — 장부 관측치에는 없고, 고른 날의 봉에만 붙습니다
     */
    record Quote(String code, Instant fetchedAt, String securityType, Boolean nxtSupported, Boolean krxTradingSuspended,
                 List<Day> days, String fscMarket, Choice choice) {

        Quote {
            days = List.copyOf(days);
            if (days.isEmpty()) {
                throw new IllegalArgumentException("한국 관측치 종목에 봉이 없습니다: " + code);
            }
        }

        /** 마지막(최근) 봉. */
        Day last() {
            return days.get(days.size() - 1);
        }

        /** 그 날짜의 봉. */
        Optional<Day> day(LocalDate date) {
            return days.stream().filter(d -> d.date().equals(date)).findFirst();
        }

        Quote withFscMarket(String market) {
            return new Quote(code, fetchedAt, securityType, nxtSupported, krxTradingSuspended, days, market, choice);
        }

        Quote withChoice(Choice chosen) {
            return new Quote(code, fetchedAt, securityType, nxtSupported, krxTradingSuspended, days, fscMarket, chosen);
        }
    }

    /**
     * 일봉 하나({@code bars[]}, 토스 {@code adjusted=false} 원시 — 금융위와 같은 판).
     *
     * @param open        시가(양수, 아니면 null). NXT 종목은 08:00 프리마켓 첫 체결일 수 있음(KRX 시가 단일가가 아님 — §4-1)
     * @param close       종가(양수, 아니면 null) — 토스 잠정 종가(NXT 종목은 20:00까지의 통합가, {@link #SOURCE_DAILY} 주식도 20:00까지의
     *                    장 마감 뒤 체결이 섞일 수 있음 — QA-146)
     * @param volume      거래량(0 이상 정수, 모르면 null). 0 = 정지일(관측 아님)
     * @param priceSource 봉 출처({@link #SOURCE_DAILY}·{@link #SOURCE_INTEGRATED}, 모르면 null)
     * @param adjRatio    수정 비율(같은 날 수정 종가 ÷ 원시 종가 — B7, 모르면 null)
     * @param minute      1분봉 개장 봉(받았을 때만 — 없으면 null)
     */
    record Day(LocalDate date, BigDecimal open, BigDecimal close, Long volume, String priceSource, Double adjRatio,
               Minute minute) {

        /** 관측 봉인가 — 거래량이 0보다 큼(0 = 정지일, 모름 = 체결이 있었는지 모름). 체결 조건 ④. */
        boolean observed() {
            return volume != null && volume > 0;
        }
    }

    /**
     * 1분봉 개장 봉({@code minute}).
     *
     * @param status {@link #MINUTE_OK}·{@link #MINUTE_NO_BAR}·{@link #MINUTE_FAILED}(모르는 글자도 그대로 — 고르는 쪽이 판정)
     * @param opens  라벨(봉 끝 시각 KST {@code "HH:mm"} — {@code "09:01"}·{@code "10:01"}) → 그 봉의 시가·거래량
     * @param reason 실패 사유(FAILED일 때, 없으면 null)
     */
    record Minute(String status, Map<String, Open> opens, String reason) {

        Minute {
            opens = Collections.unmodifiableMap(new TreeMap<>(opens));
        }
    }

    /** 1분봉 한 개의 시가(양수, 아니면 null)·거래량(0 이상 정수, 모르면 null). */
    record Open(BigDecimal open, Long volume) {
    }

    /**
     * 체결 봉 고르기의 결과 — 체결 봉 날짜·체결가(= 관측가, K31)·가격 출처, 사다리를 내려갔으면 그 사유.
     *
     * @param note 사다리를 내려간 사유(1분봉 개장 봉이 없거나·거래량 0·FAILED가 기한 뒤에도 남음 — §4-1·결정 d11), 1분봉 시가면 null
     */
    record Choice(LocalDate date, BigDecimal price, String source, String note) {
    }

    /** 저장본 하나 → 한국 관측치(클래스 설명). */
    static Optional<Quotes> parse(Snapshot snapshot) {
        if (snapshot.collectedAt() == null) {
            return Optional.empty();   // 수집 시각을 모르면 처리 순서(멱등 키)를 정할 수 없습니다
        }
        JsonNode payload = snapshot.payload();
        JsonNode contract = payload == null ? null : payload.get("contract");
        if (contract == null || !contract.isIntegralNumber() || contract.asInt() != CONTRACT) {
            return Optional.empty();   // 모르는 계약 판 — 칸의 뜻을 짐작하지 않습니다
        }
        JsonNode codes = Json.child(payload, "codes");
        if (codes == null || !codes.isObject()) {
            return Optional.empty();
        }
        Map<String, Bar> bars = new LinkedHashMap<>();
        java.util.Set<String> absent = new java.util.TreeSet<>();
        for (Map.Entry<String, JsonNode> entry : codes.properties()) {
            if (!CODE.matcher(entry.getKey()).matches()) {
                continue;
            }
            Bar bar = bar(entry.getKey(), entry.getValue());
            if (bar != null) {
                bars.put(bar.ticker(), bar);
            } else if (answeredWithoutBars(entry.getValue())) {
                absent.add(entry.getKey());
            }
        }
        return bars.isEmpty() ? Optional.empty()
                : Optional.of(new Quotes(snapshot.collectedAt(), bars, isoDate(Json.asText(payload, "session")), absent));
    }

    /**
     * 토스가 이번에 답했는데 봉이 0개인 항목({@code NO_BARS}, 이어받은 항목 아님) — 기업행위 판정의 토스 상장 상태 '없음'(사라진 종목은 금융위도
     * 없을 때만 — §4-2 'B7 구현에서 정한 것'). 이어받은 {@code NO_BARS}는 이번 응답이 아니라 모름입니다.
     */
    private static boolean answeredWithoutBars(JsonNode entry) {
        return entry != null && entry.isObject() && STATUS_NO_BARS.equals(Json.asText(entry, "status"))
                && !Json.asBoolean(entry, "isStale");
    }

    /** 종목 하나 → 장부 관측치의 봉. 쓸 수 없으면 null(클래스 설명의 '빼는 종목'). */
    private static Bar bar(String code, JsonNode entry) {
        if (entry == null || !entry.isObject() || !STATUS_OK.equals(Json.asText(entry, "status"))) {
            return null;
        }
        JsonNode list = Json.child(entry, "bars");
        if (list == null || !list.isArray() || list.isEmpty()) {
            return null;
        }
        List<Day> days = new ArrayList<>();
        for (JsonNode item : list) {
            Day day = day(item);
            if (day == null || (!days.isEmpty() && !day.date().isAfter(days.get(days.size() - 1).date()))) {
                return null;
            }
            days.add(day);
        }
        Day last = days.get(days.size() - 1);
        if (last.close() == null) {
            return null;
        }
        List<Day> priced = days.stream().filter(d -> d.close() != null).toList();
        int[] epochDays = new int[priced.size()];
        double[] closes = new double[priced.size()];
        for (int i = 0; i < priced.size(); i++) {
            epochDays[i] = Math.toIntExact(priced.get(i).date().toEpochDay());
            closes[i] = priced.get(i).close().doubleValue();
        }
        Quote quote = new Quote(code, instant(Json.asText(entry, "fetchedAt")), Json.asText(entry, "securityType"),
                bool(entry.get("nxtSupported")), bool(entry.get("krxTradingSuspended")), days, null, null);
        return new Bar(code, last.date(), last.close().doubleValue(), Json.asBoolean(entry, "isStale"),
                new DailySeries(epochDays, closes), quote);
    }

    private static Day day(JsonNode item) {
        if (item == null || !item.isObject()) {
            return null;
        }
        LocalDate date = isoDate(Json.asText(item, "date"));
        if (date == null) {
            return null;
        }
        return new Day(date, price(item.get("open")), price(item.get("close")), volume(item.get("volume")),
                Json.asText(item, "priceSource"), positiveDouble(item.get("adjRatio")), minute(item.get("minute")));
    }

    private static Minute minute(JsonNode node) {
        if (node == null || !node.isObject()) {
            return null;
        }
        Map<String, Open> opens = new LinkedHashMap<>();
        JsonNode labels = node.get("opens");
        if (labels != null && labels.isObject()) {
            for (Map.Entry<String, JsonNode> label : labels.properties()) {
                JsonNode bar = label.getValue();
                if (bar != null && bar.isObject()) {
                    opens.put(label.getKey(), new Open(price(bar.get("open")), volume(bar.get("volume"))));
                }
            }
        }
        return new Minute(Json.asText(node, "status"), opens, Json.asText(node, "reason"));
    }

    /** 양수 가격(십진수 그대로 — 원 단위 관측가), 아니면 null. */
    private static BigDecimal price(JsonNode node) {
        if (node == null || !node.isNumber() || !Double.isFinite(node.asDouble())) {
            return null;
        }
        BigDecimal value = node.decimalValue();
        return value.signum() > 0 ? value : null;
    }

    /** 0 이상 정수 거래량, 아니면 null(모름 — 0으로 채우지 않음). */
    private static Long volume(JsonNode node) {
        if (node == null || !node.isNumber() || !Double.isFinite(node.asDouble())) {
            return null;
        }
        BigDecimal value = node.decimalValue();
        if (value.signum() < 0 || value.stripTrailingZeros().scale() > 0) {
            return null;
        }
        try {
            return value.longValueExact();
        } catch (ArithmeticException e) {
            return null;
        }
    }

    private static Double positiveDouble(JsonNode node) {
        return node != null && node.isNumber() && Double.isFinite(node.asDouble()) && node.asDouble() > 0
                ? node.asDouble() : null;
    }

    private static Boolean bool(JsonNode node) {
        return node != null && node.isBoolean() ? node.asBoolean() : null;
    }

    private static LocalDate isoDate(String text) {
        if (text == null || text.length() != 10) {
            return null;
        }
        try {
            return LocalDate.parse(text);
        } catch (DateTimeParseException e) {
            return null;
        }
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
}
