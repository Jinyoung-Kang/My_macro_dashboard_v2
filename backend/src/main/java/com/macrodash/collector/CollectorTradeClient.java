package com.macrodash.collector;

import com.macrodash.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.math.BigDecimal;
import java.net.ConnectException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpTimeoutException;
import java.nio.channels.UnresolvedAddressException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * 수집기의 실제 매매 경로({@code /toss/trading/*}, ADR 0028 — 명세 docs/specs/2026-11-06-real-trade-mirror.md §5.2) 호출 클라이언트. 실제 계좌 읽기
 * (CollectorClient의 계좌 조회 — feature.brokerage 전용)와 따로 둡니다: 이 클래스는 {@code feature.realtrade}만 씁니다(ArchitectureRulesTest).
 *
 * <p><b>예외 종류를 보존합니다</b>(명세 §4 결과 분류의 백엔드 쪽). 주문·취소 POST의 결과는
 * <ul>
 *   <li>수집기에 닿지 못함(연결 거부·연결 시간 초과·주소를 못 찾음)·서비스 토큰 없음·보내기 전 형식 거부 → {@link Outcome#NOT_SENT}(수집기가 토스로 보내지 않았음이 확실)</li>
 *   <li>읽기 시간 초과(주문 {@value #ORDER_READ_SECONDS}초)·연결 뒤 끊김·수집기 2xx 밖 응답(5xx·3xx·4xx)·응답 해석 실패·모르는 outcome·주문 번호 없는 ACCEPTED
 *       → {@link Outcome#UNKNOWN}(수집기가 토스로 보냈는지 모름 — 같은 키·같은 바이트 재전송과 대조는 백엔드 실행기 몫)</li>
 *   <li>수집기가 돌려준 outcome(ACCEPTED·REJECTED·UNKNOWN·NOT_SENT)은 그대로</li>
 * </ul>
 * 수집기 안의 재시도는 401 뒤 같은 키 한 번뿐이고, 이 클래스는 다시 보내지 않습니다(재전송은 실행기 한 곳 — 명세 §4).
 *
 * <p><b>로그·값</b>: 로그에는 경로 이름(주문 번호 자리는 {@code {orderId}}로)·상태 코드·예외 클래스 이름만 남깁니다 — 오류 응답 본문·요청 본문·주문 번호·
 * 계좌 값은 남기지 않습니다(Spring은 4xx·5xx 본문을 예외 메시지에 넣으므로 이 클래스는 JDK {@link HttpClient}로 직접 부르고 본문을 로그에 쓰지
 * 않음 — CollectorClient 계좌 조회의 조용한 경로와 같은 뜻). 사유 코드는 {@code ^[a-z0-9-]{1,40}$}일 때만 받습니다(아니면 버림). 토스 주문
 * 번호를 담는 레코드는 {@code toString}에 그 번호를 싣지 않습니다.
 *
 * <p>프록시를 쓰지 않고(수집기는 같은 compose 망) 리다이렉트를 따라가지 않습니다(3xx는 UNKNOWN).
 */
@Component
public class CollectorTradeClient {

    private static final Logger log = LoggerFactory.getLogger(CollectorTradeClient.class);

    static final long ORDER_READ_SECONDS = 25;
    /** 연결 시간 초과 — 넘으면 수집기에 닿지 못한 것(NOT_SENT). */
    static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(5);
    /** 주문·취소 POST의 읽기 시간 초과(명세 §7.1) — 수집기의 토큰 발급·속도 조절 기다림·토스 응답을 덮고, 넘으면 UNKNOWN. */
    static final Duration ORDER_READ_TIMEOUT = Duration.ofSeconds(ORDER_READ_SECONDS);
    /** 달력·토큰 예열·주문 조회의 읽기 시간 초과. */
    static final Duration READ_TIMEOUT = Duration.ofSeconds(20);
    /**
     * 매매 스위치 상태의 읽기 시간 초과 — 수집기 안에서만 답하는 가벼운 조회라 짧게 둡니다. 상태 API({@code GET /api/realtrade/status})가 수집기가 멈췄을
     * 때 오래 묶이지 않고 DB의 상태를 '수집기 모름'과 함께 돌려주게(RT2-FE-1 — 화면의 상태 읽기 시간 초과보다 짧게).
     */
    static final Duration STATUS_READ_TIMEOUT = Duration.ofSeconds(5);
    /** 사전 조회(보유·매수 가능·매도 가능·현재가·상한가 — 캐시 없이 여러 호출)의 읽기 시간 초과. */
    static final Duration PREFLIGHT_READ_TIMEOUT = Duration.ofSeconds(40);

    /** 사유 코드 — 수집기 계약(명세 §5.2)과 같은 모양만 받습니다. */
    private static final Pattern CODE = Pattern.compile("^[a-z0-9-]{1,40}$");
    /** 국내 종목 코드(수집기 검사와 같음). */
    private static final Pattern SYMBOL = Pattern.compile("^[0-9][0-9A-Z]{5}$");
    /** 토스 주문 번호(수집기 취소 경로 검사와 같음). */
    private static final Pattern ORDER_ID = Pattern.compile("^[A-Za-z0-9_-]{1,128}$");
    /** 클라이언트 주문 키(토스 패턴, 36자 이하). */
    private static final Pattern CLIENT_ORDER_ID = Pattern.compile("^[A-Za-z0-9_-]{1,36}$");
    /** 한 주문의 수량 상한(수집기 검사 {@code ^[1-9][0-9]{0,8}$}). */
    static final int MAX_QUANTITY = 999_999_999;

    // ------------------------------------------------------------------ 결과 레코드
    /** 주문·취소의 결과 분류(명세 §4). */
    public enum Outcome { ACCEPTED, REJECTED, UNKNOWN, NOT_SENT }

    /**
     * 주문 POST 결과. {@code orderId}는 ACCEPTED일 때만(DB에만 두는 값 — {@code toString}에 없음), {@code code}는 사유 코드(없으면 null),
     * {@code httpStatus}는 수집기가 알려 준 토스 응답 상태(없으면 null).
     */
    public record OrderResult(Outcome outcome, String orderId, String code, Integer httpStatus) {

        public OrderResult {
            Objects.requireNonNull(outcome, "outcome");
        }

        @Override
        public String toString() {
            return "OrderResult[outcome=" + outcome + ", code=" + code + ", httpStatus=" + httpStatus + "]";
        }
    }

    /** 취소 POST 결과. {@code cancelOrderId}는 토스가 만든 취소 주문 번호(DB에만 — {@code toString}에 없음). */
    public record CancelResult(Outcome outcome, String cancelOrderId, String code) {

        public CancelResult {
            Objects.requireNonNull(outcome, "outcome");
        }

        @Override
        public String toString() {
            return "CancelResult[outcome=" + outcome + ", code=" + code + "]";
        }
    }

    /**
     * 읽기 결과 — 값 또는 실패 사유 코드. 사유는 수집기가 준 사유(코드 모양일 때) 또는 이 클래스의 사유: {@code no-service-token}·
     * {@code collector-unreachable}·{@code collector-timeout}·{@code collector-io}·{@code collector-http-<상태>}·{@code collector-bad-response}·
     * {@code collector-not-ok}·{@code collector-interrupted}·{@code invalid-symbol}·{@code invalid-order-id}.
     */
    public record Reply<T>(T value, String reason) {

        public boolean ok() {
            return value != null;
        }

        public static <T> Reply<T> of(T value) {
            return new Reply<>(Objects.requireNonNull(value), null);
        }

        public static <T> Reply<T> failed(String reason) {
            return new Reply<>(null, reason);
        }
    }

    /** 수집기 한도 네 값(명세 §1 — 서버 .env, 수집기만 앎). */
    public record Limits(long maxOrderKrw, int maxOrdersPerDay, long maxBuyKrwPerDay, long maxEquityKrw) {
    }

    /** 켜졌다고 답했는데 한도 네 값을 읽지 못함(이 클래스가 붙이는 사유 — 수집기 스위치는 켜져 있음). */
    public static final String REASON_LIMITS_UNREADABLE = "limits-unreadable";
    /**
     * 수집기가 매매 스위치가 꺼졌다고 분명히 알리는 사유({@code settings.toss_trading_disabled_reason}·서비스 토큰 없이 뜬 수집기) — 본문이
     * {@code ok:false}여도 {@code enabled:false}와 이 사유면 스위치 상태를 안 것으로 봅니다(그 밖의 {@code ok:false} — 수집기 안의 예외
     * {@code internal} 등 — 는 모름).
     */
    static final Set<String> SWITCH_OFF_REASONS = Set.of("disabled", "account-disabled", "no-service-token", "limits-invalid");

    /**
     * 수집기 매매 스위치 상태. 꺼져 있으면 {@code enabled=false}와 사유({@code disabled}·{@code account-disabled}·{@code no-service-token}·
     * {@code limits-invalid}, 켜졌는데 한도를 읽지 못하면 {@code limits-unreadable}). {@code limits}는 켜졌을 때만.
     * {@code known}은 수집기가 스위치 상태를 답했는가 — 본문 {@code ok:false}(수집기 안의 예외 등)이거나 {@code enabled}가 참거짓이 아니면 false
     * (모름 — RT3-UI-1, 화면은 '꺼짐'이 아니라 '확인 안 됨'). 읽기 자체가 실패하면 {@link Reply#failed}입니다.
     */
    public record Status(boolean enabled, String reason, Limits limits, boolean tokenContention, Instant serverTime, boolean known) {

        /** 스위치 상태를 안 응답(시험·기존 호출). */
        public Status(boolean enabled, String reason, Limits limits, boolean tokenContention, Instant serverTime) {
            this(enabled, reason, limits, tokenContention, serverTime, true);
        }

        /**
         * 수집기가 매매 스위치가 꺼졌다고 분명히 답함 — 모름({@code known=false})도, 한도 해석 실패({@code limits-unreadable} — 수집기는
         * 켜졌다고 답함)도 아님(OPS-3 — 정기 작업이 켜짐에서 이것을 보면 이상 멈춤).
         */
        public boolean switchedOff() {
            return known && !enabled && !REASON_LIMITS_UNREADABLE.equals(reason);
        }
    }

    /** 그날 토스 장 운영 정보(통합 모드). 휴장이면 {@code today}가 null, 세션 안의 단일가 시각은 결손이면 null. */
    public record Calendar(LocalDate date, Double skewSeconds, Session today, LocalDate previousBusinessDay,
                           LocalDate nextBusinessDay) {
    }

    /** 그날 세션들 — 없는 세션은 null. */
    public record Session(PreMarket preMarket, Regular regular) {
    }

    /** 프리마켓(시가 단일가 시작 {@code auctionStart} — 결손이면 null). */
    public record PreMarket(Instant start, Instant auctionStart, Instant end) {
    }

    /** 정규장(종가 단일가 시작 {@code closingAuctionStart} — 결손이면 null). */
    public record Regular(Instant start, Instant closingAuctionStart, Instant end) {
    }

    /** 토큰 예열 결과. */
    public record Warmup(boolean tokenRefreshed) {
    }

    /** 사전 조회(캐시 없이 새로 — 명세 §5.2). 국내(KR·KRW) 보유 전부, {@code quotes}는 물은 종목 ∪ 보유 종목, {@code sellable}은 매도 목록만. */
    public record Preflight(Instant fetchedAt, BigDecimal cashBuyingPowerKrw, List<Holding> holdings, Map<String, Quote> quotes,
                            Map<String, BigDecimal> sellable) {

        public Preflight {
            holdings = List.copyOf(holdings);
            quotes = Map.copyOf(quotes);
            sellable = Map.copyOf(sellable);
        }
    }

    /** 국내 보유 하나(소수점 보유는 수량이 소수). 현재가를 모르면 null. */
    /** 매매 제한 조회 — VI가 진행 중인 종목과 지수의 전 거래일 대비 등락률(%, 못 읽은 지수는 없음). */
    public record Restrictions(Set<String> viActive, Map<String, BigDecimal> indexChangePct) {
    }

    public record Holding(String symbol, String name, BigDecimal quantity, BigDecimal lastPrice) {
    }

    /** 현재가·상한가·하한가(모르면 null). */
    public record Quote(BigDecimal lastPrice, BigDecimal upperLimitPrice, BigDecimal lowerLimitPrice) {
    }

    /** 수집기가 정리한 토스 주문 하나(모르는 값은 null). {@code orderId}는 DB에만 두는 값이라 {@code toString}에 없습니다. */
    public record BrokerOrder(String orderId, String symbol, String side, String orderType, String timeInForce, String status,
                              BigDecimal quantity, BigDecimal filledQuantity, BigDecimal averageFilledPrice, BigDecimal filledAmount,
                              BigDecimal commission, BigDecimal tax, Instant orderedAt, Instant canceledAt, Instant filledAt,
                              String currency) {

        @Override
        public String toString() {
            return "BrokerOrder[symbol=" + symbol + ", side=" + side + ", orderType=" + orderType + ", timeInForce=" + timeInForce
                    + ", status=" + status + ", quantity=" + quantity + ", filledQuantity=" + filledQuantity + "]";
        }
    }

    // ------------------------------------------------------------------ 본체
    private final String baseUrl;
    private final String token;
    private final ObjectMapper mapper;
    private final HttpClient http;
    private final Duration orderReadTimeout;
    private final Duration readTimeout;
    private final Duration preflightReadTimeout;
    private final Duration statusReadTimeout;

    @Autowired
    public CollectorTradeClient(AppProperties properties, ObjectMapper mapper) {
        this(properties, mapper, CONNECT_TIMEOUT, ORDER_READ_TIMEOUT, READ_TIMEOUT, PREFLIGHT_READ_TIMEOUT, STATUS_READ_TIMEOUT);
    }

    /** 시험용 — 시간 초과를 짧게(상태 읽기도 {@code readTimeout}). */
    CollectorTradeClient(AppProperties properties, ObjectMapper mapper, Duration connectTimeout, Duration orderReadTimeout,
                         Duration readTimeout, Duration preflightReadTimeout) {
        this(properties, mapper, connectTimeout, orderReadTimeout, readTimeout, preflightReadTimeout, readTimeout);
    }

    /** 시험용 — 상태 읽기 시간 초과까지 따로. */
    CollectorTradeClient(AppProperties properties, ObjectMapper mapper, Duration connectTimeout, Duration orderReadTimeout,
                         Duration readTimeout, Duration preflightReadTimeout, Duration statusReadTimeout) {
        String url = properties.getCollectorUrl();
        this.baseUrl = url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
        this.token = properties.getCollectorToken() == null ? "" : properties.getCollectorToken().strip();
        this.mapper = mapper;
        this.orderReadTimeout = orderReadTimeout;
        this.readTimeout = readTimeout;
        this.preflightReadTimeout = preflightReadTimeout;
        this.statusReadTimeout = statusReadTimeout;
        this.http = HttpClient.newBuilder()
                .connectTimeout(connectTimeout)
                .followRedirects(HttpClient.Redirect.NEVER)
                .proxy(HttpClient.Builder.NO_PROXY)
                .version(HttpClient.Version.HTTP_1_1)
                .build();
    }

    /** 수집기 매매 스위치·한도·토큰 경합({@code GET /toss/trading/status} — 읽기 시간 초과는 {@link #STATUS_READ_TIMEOUT}). */
    public Reply<Status> status() {
        Reply<JsonNode> reply = get("GET /toss/trading/status", "/toss/trading/status", statusReadTimeout, false);
        if (!reply.ok()) {
            return Reply.failed(reply.reason());
        }
        JsonNode body = reply.value();
        try {
            boolean ok = body.path("ok").asBoolean(false);
            boolean answered = body.path("enabled").isBoolean();
            boolean enabled = ok && answered && body.path("enabled").asBoolean();
            String reason = code(body.get("reason"));
            boolean known = answered && (ok || (!body.path("enabled").asBoolean() && reason != null && SWITCH_OFF_REASONS.contains(reason)));
            boolean contention = body.path("tokenContention").isBoolean() && body.path("tokenContention").asBoolean();
            Instant serverTime = instant(body.get("serverTime"));
            Limits limits = null;
            if (enabled) {
                limits = limits(body.get("limits"));
                if (limits == null) {
                    enabled = false;
                    reason = REASON_LIMITS_UNREADABLE;
                }
            } else if (reason == null) {
                reason = ok ? "disabled" : "collector-not-ok";
            }
            return Reply.of(new Status(enabled, reason, limits, contention, serverTime, known));
        } catch (RuntimeException e) {
            return badResponse("GET /toss/trading/status", e);
        }
    }

    /** 그날 토스 장 운영 정보({@code GET /toss/trading/calendar}). 시각 하나라도 읽지 못하면 실패(그날은 쉼 — 부분 값으로 창을 정하지 않음). */
    public Reply<Calendar> calendar() {
        Reply<JsonNode> reply = get("GET /toss/trading/calendar", "/toss/trading/calendar", readTimeout, true);
        if (!reply.ok()) {
            return Reply.failed(reply.reason());
        }
        JsonNode body = reply.value();
        try {
            LocalDate date = LocalDate.parse(requiredText(body, "date"));
            JsonNode skew = body.get("skewSeconds");
            Double skewSeconds = skew == null || skew.isNull() ? null : requireNumber(skew).asDouble();
            Session today = null;
            JsonNode todayNode = body.get("today");
            if (todayNode != null && !todayNode.isNull()) {
                JsonNode pre = todayNode.get("preMarket");
                JsonNode regular = todayNode.get("regular");
                today = new Session(
                        pre == null || pre.isNull() ? null
                                : new PreMarket(requiredInstant(pre, "start"), instant(pre.get("auctionStart")), requiredInstant(pre, "end")),
                        regular == null || regular.isNull() ? null
                                : new Regular(requiredInstant(regular, "start"), instant(regular.get("closingAuctionStart")),
                                requiredInstant(regular, "end")));
            }
            return Reply.of(new Calendar(date, skewSeconds, today, date(body.get("previousBusinessDay")),
                    date(body.get("nextBusinessDay"))));
        } catch (RuntimeException e) {
            return badResponse("GET /toss/trading/calendar", e);
        }
    }

    /** 토큰 예열({@code POST /toss/trading/warmup} — 남은 시간이 30분 미만이면 수집기가 미리 재발급). */
    public Reply<Warmup> warmup() {
        Reply<JsonNode> reply = send("POST /toss/trading/warmup", HttpRequest.newBuilder(uri("/toss/trading/warmup"))
                .POST(HttpRequest.BodyPublishers.noBody()), readTimeout, true);
        if (!reply.ok()) {
            return Reply.failed(reply.reason());
        }
        JsonNode refreshed = reply.value().get("tokenRefreshed");
        return Reply.of(new Warmup(refreshed != null && refreshed.isBoolean() && refreshed.asBoolean()));
    }

    /**
     * 사전 조회({@code GET /toss/trading/preflight?symbols=…&sell=…}) — 캐시 없이 새로. 종목 코드가 하나라도 국내 코드 모양이 아니면 보내지 않고 실패
     * ({@code invalid-symbol}). 수집기가 하나라도 못 읽으면 실패(부분 값 없음 — 명세 §5.2).
     *
     * @param symbols 시세(현재가·상한가)를 물을 종목(보유 종목은 수집기가 더함)
     * @param sell    매도 가능 수량을 물을 종목
     */
    public Reply<Preflight> preflight(Collection<String> symbols, Collection<String> sell) {
        Set<String> asked = new TreeSet<>(symbols == null ? List.of() : symbols);
        Set<String> selling = new TreeSet<>(sell == null ? List.of() : sell);
        for (String symbol : asked) {
            if (symbol == null || !SYMBOL.matcher(symbol).matches()) {
                return Reply.failed("invalid-symbol");
            }
        }
        for (String symbol : selling) {
            if (symbol == null || !SYMBOL.matcher(symbol).matches()) {
                return Reply.failed("invalid-symbol");
            }
        }
        StringBuilder path = new StringBuilder("/toss/trading/preflight");
        List<String> params = new ArrayList<>();
        if (!asked.isEmpty()) {
            params.add("symbols=" + String.join(",", asked));
        }
        if (!selling.isEmpty()) {
            params.add("sell=" + String.join(",", selling));
        }
        if (!params.isEmpty()) {
            path.append('?').append(String.join("&", params));
        }
        Reply<JsonNode> reply = get("GET /toss/trading/preflight", path.toString(), preflightReadTimeout, true);
        if (!reply.ok()) {
            return Reply.failed(reply.reason());
        }
        JsonNode body = reply.value();
        try {
            BigDecimal cash = decimal(body.get("cashBuyingPowerKrw"));
            if (cash == null) {
                throw new IllegalArgumentException("cashBuyingPowerKrw 없음");
            }
            List<Holding> holdings = new ArrayList<>();
            for (JsonNode h : array(body, "holdings")) {
                String symbol = requiredText(h, "symbol");
                BigDecimal quantity = decimal(h.get("quantity"));
                if (quantity == null) {
                    throw new IllegalArgumentException("보유 수량 없음");
                }
                JsonNode name = h.get("name");
                holdings.add(new Holding(symbol, name == null || name.isNull() ? null : name.asString(), quantity,
                        decimal(h.get("lastPrice"))));
            }
            Map<String, Quote> quotes = new LinkedHashMap<>();
            JsonNode quoteNode = body.get("quotes");
            if (quoteNode != null && !quoteNode.isNull()) {
                if (!quoteNode.isObject()) {
                    throw new IllegalArgumentException("quotes가 객체가 아님");
                }
                for (Map.Entry<String, JsonNode> e : quoteNode.properties()) {
                    JsonNode q = e.getValue();
                    quotes.put(e.getKey(), new Quote(decimal(q.get("lastPrice")), decimal(q.get("upperLimitPrice")),
                            decimal(q.get("lowerLimitPrice"))));
                }
            }
            Map<String, BigDecimal> sellable = new LinkedHashMap<>();
            JsonNode sellNode = body.get("sellable");
            if (sellNode != null && !sellNode.isNull()) {
                if (!sellNode.isObject()) {
                    throw new IllegalArgumentException("sellable이 객체가 아님");
                }
                for (Map.Entry<String, JsonNode> e : sellNode.properties()) {
                    BigDecimal value = decimal(e.getValue());
                    if (value == null) {
                        throw new IllegalArgumentException("매도 가능 수량 없음");
                    }
                    sellable.put(e.getKey(), value);
                }
            }
            return Reply.of(new Preflight(instant(body.get("fetchedAt")), cash, holdings, quotes, sellable));
        } catch (RuntimeException e) {
            return badResponse("GET /toss/trading/preflight", e);
        }
    }

    /** 매매 제한 조회({@code GET /toss/trading/restrictions}) — 읽기만. 종목 코드 모양이 아니면 보내지 않습니다. */
    public Reply<Restrictions> restrictions(Collection<String> symbols) {
        Set<String> asked = new TreeSet<>(symbols == null ? List.of() : symbols);
        for (String symbol : asked) {
            if (symbol == null || !SYMBOL.matcher(symbol).matches()) {
                return Reply.failed("invalid-symbol");
            }
        }
        String label = "GET /toss/trading/restrictions";
        Reply<JsonNode> reply = get(label, "/toss/trading/restrictions?symbols=" + String.join(",", asked), preflightReadTimeout, true);
        if (!reply.ok()) {
            return Reply.failed(reply.reason());
        }
        try {
            Set<String> active = new TreeSet<>();
            for (JsonNode node : array(reply.value(), "viActive")) {
                active.add(node.asString());
            }
            Map<String, BigDecimal> changes = new LinkedHashMap<>();
            JsonNode indices = reply.value().get("indexChangePct");
            if (indices != null && indices.isObject()) {
                for (Map.Entry<String, JsonNode> e : indices.properties()) {
                    if (e.getValue().isNumber()) {
                        changes.put(e.getKey(), e.getValue().decimalValue());
                    }
                }
            }
            return Reply.of(new Restrictions(active, changes));
        } catch (RuntimeException e) {
            return badResponse(label, e);
        }
    }

    /**
     * 실제 주문({@code POST /toss/trading/orders}) — 받은 본문을 <b>바이트 그대로</b> 보냅니다(같은 키 재전송은 저장한 본문 그대로 — 명세 §4). 본문은
     * {@link #orderBody}로 만들어 행에 저장한 문자열입니다. 결과 분류는 클래스 설명.
     */
    public OrderResult placeOrder(String requestBody) {
        if (token.isEmpty()) {
            return new OrderResult(Outcome.NOT_SENT, null, "no-service-token", null);
        }
        if (requestBody == null || requestBody.isBlank()) {
            return new OrderResult(Outcome.NOT_SENT, null, "invalid-request-body", null);
        }
        String label = "POST /toss/trading/orders";
        HttpResponse<String> response;
        try {
            response = http.send(authorized(HttpRequest.newBuilder(uri("/toss/trading/orders")))
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(requestBody, StandardCharsets.UTF_8))
                    .timeout(orderReadTimeout).build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("수집기 호출 중단 ({}): {}", label, e.getClass().getSimpleName());
            return new OrderResult(Outcome.UNKNOWN, null, "collector-interrupted", null);
        } catch (IOException | RuntimeException e) {
            Outcome outcome = classify(e);
            log.warn("수집기 호출 실패 ({}): {} — {}", label, e.getClass().getSimpleName(), outcome);
            return new OrderResult(outcome, null, transportCode(e), null);
        }
        if (response.statusCode() < 200 || response.statusCode() > 299) {
            log.warn("수집기 호출 실패 ({}): HTTP {} — UNKNOWN", label, response.statusCode());
            return new OrderResult(Outcome.UNKNOWN, null, "collector-http-" + response.statusCode(), null);
        }
        JsonNode body;
        try {
            body = mapper.readTree(response.body());
        } catch (RuntimeException e) {
            log.warn("수집기 응답 해석 실패 ({}): {} — UNKNOWN", label, e.getClass().getSimpleName());
            return new OrderResult(Outcome.UNKNOWN, null, "collector-bad-response", null);
        }
        String code = code(body == null ? null : body.get("code"));
        JsonNode statusNode = body == null ? null : body.get("httpStatus");
        Integer httpStatus = statusNode != null && statusNode.isIntegralNumber() ? statusNode.asInt() : null;
        Outcome outcome = outcome(body == null ? null : body.get("outcome"));
        if (outcome == null) {
            log.warn("수집기 응답 해석 실패 ({}): outcome 없음·모름 — UNKNOWN", label);
            return new OrderResult(Outcome.UNKNOWN, null, "collector-bad-response", httpStatus);
        }
        if (outcome == Outcome.ACCEPTED) {
            String orderId = orderId(body.get("orderId"));
            if (orderId == null) {
                log.warn("수집기 응답 해석 실패 ({}): 주문 번호 없는 ACCEPTED — UNKNOWN", label);
                return new OrderResult(Outcome.UNKNOWN, null, "accepted-without-order-id", httpStatus);
            }
            return new OrderResult(Outcome.ACCEPTED, orderId, code, httpStatus);
        }
        return new OrderResult(outcome, null, code, httpStatus);
    }

    /**
     * 주문 본문(수집기 계약 — 명세 §5.2) — 키 순서가 정해진 JSON 한 줄. 행에 저장하고 재전송에 그대로 쓰는 바이트입니다. 수량은 토스와 같이 문자열,
     * {@code firstSentAt}은 밀리초로 자른 UTC ISO 시각(행의 {@code first_sent_at}에도 같은 값을 쓰세요).
     *
     * @throws IllegalArgumentException 키·종목·방향·TIF·수량이 계약 모양이 아님(보내지 않을 주문)
     */
    public static String orderBody(String clientOrderId, String symbol, String side, String timeInForce, int quantity,
                                   Instant firstSentAt) {
        if (clientOrderId == null || !CLIENT_ORDER_ID.matcher(clientOrderId).matches()) {
            throw new IllegalArgumentException("clientOrderId 모양이 아닙니다");
        }
        if (symbol == null || !SYMBOL.matcher(symbol).matches()) {
            throw new IllegalArgumentException("국내 종목 코드 모양이 아닙니다");
        }
        if (!"BUY".equals(side) && !"SELL".equals(side)) {
            throw new IllegalArgumentException("방향은 BUY·SELL입니다: " + side);
        }
        if (!"DAY".equals(timeInForce) && !"OPG".equals(timeInForce)) {
            throw new IllegalArgumentException("TIF는 DAY·OPG입니다: " + timeInForce);
        }
        if (quantity < 1 || quantity > MAX_QUANTITY) {
            throw new IllegalArgumentException("수량은 1 이상 " + MAX_QUANTITY + " 이하입니다: " + quantity);
        }
        Objects.requireNonNull(firstSentAt, "firstSentAt");
        return "{\"clientOrderId\":\"" + clientOrderId + "\",\"symbol\":\"" + symbol + "\",\"side\":\"" + side
                + "\",\"timeInForce\":\"" + timeInForce + "\",\"quantity\":\"" + quantity + "\",\"firstSentAt\":\""
                + firstSentAt.truncatedTo(ChronoUnit.MILLIS) + "\"}";
    }

    /**
     * 주문 취소({@code POST /toss/trading/orders/{orderId}/cancel}). 주문 번호가 경로 모양이 아니면 보내지 않고 NOT_SENT({@code invalid-order-id}).
     * 결과 분류는 주문과 같습니다(ACCEPTED에는 취소 주문 번호가 없어도 됨 — 원 주문 상태로 따라감).
     */
    public CancelResult cancelOrder(String orderId) {
        if (token.isEmpty()) {
            return new CancelResult(Outcome.NOT_SENT, null, "no-service-token");
        }
        if (orderId == null || !ORDER_ID.matcher(orderId).matches()) {
            return new CancelResult(Outcome.NOT_SENT, null, "invalid-order-id");
        }
        String label = "POST /toss/trading/orders/{orderId}/cancel";
        HttpResponse<String> response;
        try {
            response = http.send(authorized(HttpRequest.newBuilder(uri("/toss/trading/orders/" + orderId + "/cancel")))
                    .POST(HttpRequest.BodyPublishers.noBody())
                    .timeout(orderReadTimeout).build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("수집기 호출 중단 ({}): {}", label, e.getClass().getSimpleName());
            return new CancelResult(Outcome.UNKNOWN, null, "collector-interrupted");
        } catch (IOException | RuntimeException e) {
            Outcome outcome = classify(e);
            log.warn("수집기 호출 실패 ({}): {} — {}", label, e.getClass().getSimpleName(), outcome);
            return new CancelResult(outcome, null, transportCode(e));
        }
        if (response.statusCode() < 200 || response.statusCode() > 299) {
            log.warn("수집기 호출 실패 ({}): HTTP {} — UNKNOWN", label, response.statusCode());
            return new CancelResult(Outcome.UNKNOWN, null, "collector-http-" + response.statusCode());
        }
        try {
            JsonNode body = mapper.readTree(response.body());
            Outcome outcome = outcome(body == null ? null : body.get("outcome"));
            if (outcome == null) {
                log.warn("수집기 응답 해석 실패 ({}): outcome 없음·모름 — UNKNOWN", label);
                return new CancelResult(Outcome.UNKNOWN, null, "collector-bad-response");
            }
            return new CancelResult(outcome, outcome == Outcome.ACCEPTED ? orderId(body.get("cancelOrderId")) : null,
                    code(body.get("code")));
        } catch (RuntimeException e) {
            log.warn("수집기 응답 해석 실패 ({}): {} — UNKNOWN", label, e.getClass().getSimpleName());
            return new CancelResult(Outcome.UNKNOWN, null, "collector-bad-response");
        }
    }

    /** 토스 미체결 주문 전부({@code GET /toss/trading/orders/open} — 앱 주문 포함). */
    public Reply<List<BrokerOrder>> openOrders() {
        return orders("GET /toss/trading/orders/open", "/toss/trading/orders/open");
    }

    /** 오늘 국내 주문(OPEN + CLOSED, {@code GET /toss/trading/orders/today}). */
    public Reply<List<BrokerOrder>> todayOrders() {
        return orders("GET /toss/trading/orders/today", "/toss/trading/orders/today");
    }

    /** 주문 하나({@code GET /toss/trading/orders/{orderId}}). 번호가 경로 모양이 아니면 보내지 않고 실패({@code invalid-order-id}). */
    public Reply<BrokerOrder> order(String orderId) {
        if (orderId == null || !ORDER_ID.matcher(orderId).matches()) {
            return Reply.failed("invalid-order-id");
        }
        String label = "GET /toss/trading/orders/{orderId}";
        Reply<JsonNode> reply = get(label, "/toss/trading/orders/" + orderId, readTimeout, true);
        if (!reply.ok()) {
            return Reply.failed(reply.reason());
        }
        try {
            return Reply.of(brokerOrder(reply.value().get("order")));
        } catch (RuntimeException e) {
            return badResponse(label, e);
        }
    }

    // ------------------------------------------------------------------ 분류(시험이 직접 봄)
    /**
     * 전송 예외의 분류 — 수집기에 닿지 못했음이 확실한 것(연결 거부·연결 시간 초과·주소를 못 찾음)만 NOT_SENT, 나머지(읽기 시간 초과·연결 뒤 끊김·그 밖의
     * 예외)는 UNKNOWN.
     */
    static Outcome classify(Throwable error) {
        if (error instanceof HttpConnectTimeoutException || error instanceof ConnectException
                || error instanceof UnresolvedAddressException) {
            return Outcome.NOT_SENT;
        }
        // 연결을 맺지 못한 예외를 감싼 IOException(읽기 시간 초과는 제외 — 그것은 연결 뒤의 일).
        Throwable cause = error.getCause();
        if (error instanceof IOException && !(error instanceof HttpTimeoutException)
                && (cause instanceof ConnectException || cause instanceof UnresolvedAddressException)) {
            return Outcome.NOT_SENT;
        }
        return Outcome.UNKNOWN;
    }

    /** 전송 예외의 사유 코드. */
    static String transportCode(Throwable error) {
        if (classify(error) == Outcome.NOT_SENT) {
            return "collector-unreachable";
        }
        return error instanceof HttpTimeoutException ? "collector-timeout" : "collector-io";
    }

    // ------------------------------------------------------------------ 공통
    private Reply<List<BrokerOrder>> orders(String label, String path) {
        Reply<JsonNode> reply = get(label, path, readTimeout, true);
        if (!reply.ok()) {
            return Reply.failed(reply.reason());
        }
        try {
            List<BrokerOrder> out = new ArrayList<>();
            for (JsonNode node : array(reply.value(), "orders")) {
                out.add(brokerOrder(node));
            }
            return Reply.of(List.copyOf(out));
        } catch (RuntimeException e) {
            return badResponse(label, e);
        }
    }

    private BrokerOrder brokerOrder(JsonNode node) {
        if (node == null || !node.isObject()) {
            throw new IllegalArgumentException("주문이 객체가 아님");
        }
        String orderId = orderId(node.get("orderId"));
        if (orderId == null) {
            throw new IllegalArgumentException("주문 번호 없음");
        }
        return new BrokerOrder(orderId, text(node.get("symbol")), text(node.get("side")), text(node.get("orderType")),
                text(node.get("timeInForce")), requiredText(node, "status"), decimal(node.get("quantity")),
                decimal(node.get("filledQuantity")), decimal(node.get("averageFilledPrice")), decimal(node.get("filledAmount")),
                decimal(node.get("commission")), decimal(node.get("tax")), instant(node.get("orderedAt")),
                instant(node.get("canceledAt")), instant(node.get("filledAt")), text(node.get("currency")));
    }

    /**
     * GET 하나 — 2xx JSON 본문을 돌려줍니다. {@code requireOk}면 {@code ok}가 참이 아닌 본문을 실패로(사유는 수집기 사유가 코드 모양일 때 그것).
     */
    private Reply<JsonNode> get(String label, String path, Duration timeout, boolean requireOk) {
        return send(label, HttpRequest.newBuilder(uri(path)).GET(), timeout, requireOk);
    }

    private Reply<JsonNode> send(String label, HttpRequest.Builder builder, Duration timeout, boolean requireOk) {
        if (token.isEmpty()) {
            return Reply.failed("no-service-token");
        }
        HttpResponse<String> response;
        try {
            response = http.send(authorized(builder).timeout(timeout).build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("수집기 호출 중단 ({}): {}", label, e.getClass().getSimpleName());
            return Reply.failed("collector-interrupted");
        } catch (IOException | RuntimeException e) {
            log.warn("수집기 호출 실패 ({}): {}", label, e.getClass().getSimpleName());
            return Reply.failed(transportCode(e));
        }
        if (response.statusCode() < 200 || response.statusCode() > 299) {
            log.warn("수집기 호출 실패 ({}): HTTP {}", label, response.statusCode());
            return Reply.failed("collector-http-" + response.statusCode());
        }
        JsonNode body;
        try {
            body = mapper.readTree(response.body());
        } catch (RuntimeException e) {
            return badResponse(label, e);
        }
        if (body == null || !body.isObject()) {
            log.warn("수집기 응답 해석 실패 ({}): 객체가 아님", label);
            return Reply.failed("collector-bad-response");
        }
        if (requireOk && !body.path("ok").asBoolean(false)) {
            String reason = code(body.get("reason"));
            return Reply.failed(reason == null ? "collector-not-ok" : reason);
        }
        return Reply.of(body);
    }

    private HttpRequest.Builder authorized(HttpRequest.Builder builder) {
        return builder.header("X-Service-Token", token).header("Accept", "application/json");
    }

    private URI uri(String path) {
        return URI.create(baseUrl + path);
    }

    private static <T> Reply<T> badResponse(String label, RuntimeException e) {
        log.warn("수집기 응답 해석 실패 ({}): {}", label, e.getClass().getSimpleName());
        return Reply.failed("collector-bad-response");
    }

    private static Outcome outcome(JsonNode node) {
        if (node == null || !node.isString()) {
            return null;
        }
        return switch (node.asString()) {
            case "ACCEPTED" -> Outcome.ACCEPTED;
            case "REJECTED" -> Outcome.REJECTED;
            case "UNKNOWN" -> Outcome.UNKNOWN;
            case "NOT_SENT" -> Outcome.NOT_SENT;
            default -> null;
        };
    }

    /** 사유 코드 — 모양이 맞을 때만(아니면 null — 토스 오류 문구가 섞이지 않게). */
    private static String code(JsonNode node) {
        if (node == null || !node.isString()) {
            return null;
        }
        String value = node.asString();
        return CODE.matcher(value).matches() ? value : null;
    }

    private static String orderId(JsonNode node) {
        if (node == null || !node.isString()) {
            return null;
        }
        String value = node.asString();
        return ORDER_ID.matcher(value).matches() ? value : null;
    }

    private static Limits limits(JsonNode node) {
        if (node == null || !node.isObject()) {
            return null;
        }
        Long order = positiveLong(node.get("maxOrderKrw"));
        Long perDay = positiveLong(node.get("maxOrdersPerDay"));
        Long buy = positiveLong(node.get("maxBuyKrwPerDay"));
        Long equity = positiveLong(node.get("maxEquityKrw"));
        if (order == null || perDay == null || buy == null || equity == null || perDay > Integer.MAX_VALUE) {
            return null;
        }
        return new Limits(order, perDay.intValue(), buy, equity);
    }

    private static Long positiveLong(JsonNode node) {
        if (node == null) {
            return null;
        }
        long value;
        if (node.isIntegralNumber() && node.canConvertToLong()) {
            value = node.asLong();
        } else if (node.isString() && node.asString().matches("^[1-9][0-9]{0,17}$")) {
            value = Long.parseLong(node.asString());
        } else {
            return null;
        }
        return value > 0 ? value : null;
    }

    /** 십진수 — 문자열(토스·수집기 계약) 또는 숫자, 없거나 null이면 null, 읽지 못하면 예외. */
    private static BigDecimal decimal(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (node.isString()) {
            return new BigDecimal(node.asString().strip());
        }
        if (node.isNumber()) {
            return node.decimalValue();
        }
        throw new IllegalArgumentException("십진수가 아님");
    }

    private static JsonNode requireNumber(JsonNode node) {
        if (!node.isNumber()) {
            throw new IllegalArgumentException("숫자가 아님");
        }
        return node;
    }

    private static Instant instant(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (!node.isString()) {
            throw new IllegalArgumentException("시각이 문자열이 아님");
        }
        return OffsetDateTime.parse(node.asString().strip()).toInstant();
    }

    private static Instant requiredInstant(JsonNode parent, String field) {
        Instant value = instant(parent.get(field));
        if (value == null) {
            throw new IllegalArgumentException(field + " 없음");
        }
        return value;
    }

    private static LocalDate date(JsonNode node) {
        if (node == null || node.isNull()) {
            return null;
        }
        if (!node.isString()) {
            throw new IllegalArgumentException("날짜가 문자열이 아님");
        }
        return LocalDate.parse(node.asString().strip());
    }

    private static String text(JsonNode node) {
        return node == null || node.isNull() ? null : node.asString();
    }

    private static String requiredText(JsonNode parent, String field) {
        JsonNode node = parent.get(field);
        if (node == null || !node.isString() || node.asString().isBlank()) {
            throw new IllegalArgumentException(field + " 없음");
        }
        return node.asString();
    }

    private static Iterable<JsonNode> array(JsonNode parent, String field) {
        JsonNode node = parent.get(field);
        if (node == null || !node.isArray()) {
            throw new IllegalArgumentException(field + "가 배열이 아님");
        }
        return node;
    }
}
