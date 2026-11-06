package com.macrodash.feature.brokerage;

import com.macrodash.Kst;
import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.feature.brokerage.BrokerageAccountView.HoldingRow;
import com.macrodash.feature.brokerage.BrokerageAccountView.OrderRow;
import com.macrodash.feature.brokerage.BrokerageAccountView.State;
import com.macrodash.feature.brokerage.BrokerageAccountView.Summary;
import com.macrodash.support.Params;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Duration;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * 토스증권 실제 계좌 읽기 전용 조회 — {@code GET /api/brokerage/account?market=KR|US}(운영자, ADR 0025).
 *
 * <p>수집기 {@code /toss/account}가 계좌 전체를 원화 쪽({@code KR})·달러 쪽({@code US})으로 나눠 주면, 여기서 요청한 쪽만 칸을 하나씩
 * {@link BrokerageAccountView}로 옮깁니다(통째 복사 금지 — 모르는 칸·계좌번호가 화면까지 가지 않게). 그 쪽의 통화·시장이 맞지 않는 항목은
 * 다시 걸러 {@code unclassifiedCount}에 더합니다. 저장하지 않고, 다른 기능(모의 장부·패킷·알림)과 주고받지 않습니다.
 *
 * <p>잘못된 market만 400이고 그 밖에는 늘 200입니다 — 꺼짐·실패는 {@code available:false}와 state·고정 문구. 읽기 모드 store_only(공개
 * 데모)면 수집기를 부르지 않고 {@code DISABLED}입니다. 숫자 변환은 예외 없이 null로 끝나고, 응답을 만드는 중 예상 못 한 예외는 클래스 이름만
 * 로그에 남기고 {@code UPSTREAM_ERROR}로 답합니다(예외 문구에 금액이 실려 로그로 새지 않게).
 */
@Service
public class BrokerageService {

    private static final Logger log = LoggerFactory.getLogger(BrokerageService.class);

    static final List<String> MARKETS = List.of("KR", "US");

    /** 토스 오류 코드로 옮겨도 되는 모양(수집기와 같은 정규식). */
    private static final Pattern UPSTREAM_CODE = Pattern.compile("^[a-z0-9-]{1,40}$");
    /** 받는 숫자 모양 — 토스 decimal 문자열. 지수 표기·NaN은 null(지수 표기는 큰 수를 만들 수 있음), 소수 자릿수는 제한하지 않음(스펙에 상한 없음). */
    private static final Pattern DECIMAL = Pattern.compile("^[+-]?\\d+(\\.\\d+)?$");
    /** 토스 스펙의 decimal 칸 최대 길이(maxLength 30) — 넘으면 null. */
    private static final int DECIMAL_MAX_LENGTH = 30;
    private static final Pattern DATE = Pattern.compile("^\\d{4}-\\d{2}-\\d{2}$");
    private static final BigDecimal HUNDRED = BigDecimal.valueOf(100);

    /** 한 쪽 — 시장 값과 그 쪽 항목이 가져야 하는 통화. */
    private record Side(String market, String currency) {
    }

    private static final Side KR = new Side("KR", "KRW");
    private static final Side US = new Side("US", "USD");

    private final CollectorClient collector;
    private final AppProperties properties;
    private final Clock clock;

    @Autowired
    BrokerageService(CollectorClient collector, AppProperties properties) {
        this(collector, properties, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    BrokerageService(CollectorClient collector, AppProperties properties, Clock clock) {
        this.collector = collector;
        this.properties = properties;
        this.clock = clock;
    }

    /** GET /api/brokerage/account — 클래스 설명. {@code market}이 없거나 KR·US가 아니면 400. */
    public BrokerageAccountView account(String market) {
        Side side = "KR".equals(Params.oneOf("market", market, MARKETS)) ? KR : US;
        // 공개 데모(store_only)에서는 운영자 키로 외부를 부르지 않습니다(TossService와 같은 규칙, QA-022).
        if (properties.resolvedReadMode() == AppProperties.ReadMode.STORE_ONLY) {
            return failure(side, State.DISABLED, null);
        }
        try {
            Optional<JsonNode> payload = collector.tossAccount();
            if (payload.isEmpty()) {
                return failure(side, State.COLLECTOR_UNREACHABLE, null);
            }
            return view(side, payload.get());
        } catch (RuntimeException e) {
            log.warn("실제 계좌 응답을 만들지 못했습니다: {}", e.getClass().getSimpleName());
            return failure(side, State.UPSTREAM_ERROR, null);
        }
    }

    private BrokerageAccountView view(Side side, JsonNode payload) {
        if (!payload.isObject()) {
            return failure(side, State.UPSTREAM_ERROR, null);
        }
        if (!bool(payload.path("enabled"))) {
            return failure(side, State.DISABLED, payload);
        }
        State reason = stateFor(text(payload.path("reason")));
        if (!bool(payload.path("ok"))) {
            return failure(side, reason, payload);
        }
        JsonNode data = payload.path("sides").path(side.market());
        if (!data.isObject()) {
            return failure(side, State.UPSTREAM_ERROR, payload);
        }

        int unclassified = Math.max(0, intOrZero(payload.path("unclassifiedCount")));
        List<HoldingRow> holdings = new ArrayList<>();
        for (JsonNode item : elements(data.path("holdings"))) {
            if (!item.isObject() || text(item.path("symbol")) == null
                    || !side.market().equals(text(item.path("marketCountry")))
                    || !side.currency().equals(text(item.path("currency")))) {
                unclassified++;
                continue;
            }
            holdings.add(holding(item));
        }
        List<OrderRow> openOrders = new ArrayList<>();
        List<OrderRow> closedOrders = new ArrayList<>();
        unclassified += orders(side, data.path("openOrders"), openOrders);
        unclassified += orders(side, data.path("closedOrders"), closedOrders);

        boolean stale = bool(payload.path("isStale"));
        OffsetDateTime fetchedAt = time(payload.path("fetchedAt"));
        Long ageSeconds = fetchedAt == null ? null
                : Math.max(0L, Duration.between(fetchedAt.toInstant(), clock.instant()).getSeconds());
        String closedFrom = text(payload.path("closedFrom"));
        return new BrokerageAccountView(true, State.OK, stale ? STALE_MESSAGE : null, side.market(), side.currency(),
                label(payload), count(payload.path("accountCount")), displaySeconds(fetchedAt),
                displaySeconds(time(payload.path("staleSince"))), ageSeconds, stale, stale ? reason : null,
                upstreamCode(payload), decimal(data.path("buyingPower")), summary(data.path("summary")),
                List.copyOf(holdings), List.copyOf(openOrders), List.copyOf(closedOrders),
                closedFrom != null && DATE.matcher(closedFrom).matches() ? closedFrom : null,
                bool(payload.path("closedTruncated")), unclassified);
    }

    /** 주문 목록을 {@code out}에 옮기고, 이 쪽 통화가 아니거나 객체가 아니어서 뺀 개수를 돌려줍니다. */
    private static int orders(Side side, JsonNode list, List<OrderRow> out) {
        int skipped = 0;
        for (JsonNode item : elements(list)) {
            if (!item.isObject() || !side.currency().equals(text(item.path("currency")))) {
                skipped++;
                continue;
            }
            out.add(order(item));
        }
        return skipped;
    }

    private static HoldingRow holding(JsonNode item) {
        return new HoldingRow(text(item.path("symbol")), text(item.path("name")), text(item.path("marketCountry")),
                text(item.path("currency")), decimal(item.path("quantity")), decimal(item.path("lastPrice")),
                decimal(item.path("averagePurchasePrice")), decimal(item.path("purchaseAmount")),
                decimal(item.path("marketValue")), decimal(item.path("marketValueAfterCost")),
                decimal(item.path("profitLoss")), decimal(item.path("profitLossAfterCost")),
                ratePct(decimal(item.path("profitLossRate"))), ratePct(decimal(item.path("profitLossRateAfterCost"))),
                decimal(item.path("dailyProfitLoss")), ratePct(decimal(item.path("dailyProfitLossRate"))));
    }

    private static OrderRow order(JsonNode item) {
        return new OrderRow(text(item.path("symbol")), text(item.path("name")), text(item.path("side")),
                text(item.path("orderType")), text(item.path("timeInForce")), text(item.path("status")),
                text(item.path("currency")), decimal(item.path("price")), decimal(item.path("quantity")),
                decimal(item.path("orderAmount")), display(time(item.path("orderedAt"))),
                display(time(item.path("canceledAt"))), decimal(item.path("filledQuantity")),
                decimal(item.path("averageFilledPrice")), decimal(item.path("filledAmount")),
                decimal(item.path("commission")), decimal(item.path("tax")), display(time(item.path("filledAt"))),
                text(item.path("settlementDate")));
    }

    private static Summary summary(JsonNode node) {
        if (!node.isObject()) {
            return null;
        }
        BigDecimal purchase = decimal(node.path("purchaseAmount"));
        BigDecimal profitLoss = decimal(node.path("profitLoss"));
        BigDecimal profitLossAfterCost = decimal(node.path("profitLossAfterCost"));
        return new Summary(purchase, decimal(node.path("marketValue")), decimal(node.path("marketValueAfterCost")),
                profitLoss, profitLossAfterCost, decimal(node.path("dailyProfitLoss")),
                pct(profitLoss, purchase), pct(profitLossAfterCost, purchase));
    }

    private BrokerageAccountView failure(Side side, State state, JsonNode payload) {
        return new BrokerageAccountView(false, state, message(state), side.market(), side.currency(),
                payload == null ? null : label(payload), payload == null ? null : count(payload.path("accountCount")),
                null, null, null, false, null, payload == null ? null : upstreamCode(payload),
                null, null, List.of(), List.of(), List.of(), null, false, 0);
    }

    // ------------------------------------------------------------------ 대응 표·문구

    /** 수집기 reason → state(명세 §4). timeout·upstream-error·internal·모르는 값·없음은 UPSTREAM_ERROR. */
    static State stateFor(String reason) {
        if (reason == null) {
            return State.UPSTREAM_ERROR;
        }
        return switch (reason) {
            case "disabled", "no-service-token" -> State.DISABLED;
            case "not-configured" -> State.NOT_CONFIGURED;
            case "ip-not-allowed" -> State.IP_NOT_ALLOWED;
            case "auth-failed" -> State.AUTH_FAILED;
            case "rate-limited" -> State.RATE_LIMITED;
            case "no-account" -> State.NO_ACCOUNT;
            case "refreshing" -> State.REFRESHING;
            default -> State.UPSTREAM_ERROR;
        };
    }

    static final String STALE_MESSAGE = "지금 조회에 실패해 이전에 받은 값을 보여 줍니다.";

    /** 실패 state의 고정 문구 — 수집기·토스 문구를 옮기지 않습니다. */
    static String message(State state) {
        return switch (state) {
            case OK -> null;
            case DISABLED -> "실제 계좌 조회가 꺼져 있습니다. 운영 서버에서만 켭니다.";
            case NOT_CONFIGURED -> "토스증권 API 키가 설정되지 않았습니다.";
            case COLLECTOR_UNREACHABLE -> "수집기에 연결하지 못했습니다.";
            case IP_NOT_ALLOWED -> "토스증권이 이 서버의 IP를 허용하지 않았습니다.";
            case AUTH_FAILED -> "토스증권 인증에 실패했습니다.";
            case RATE_LIMITED -> "토스증권 호출 한도에 걸렸습니다. 잠시 뒤 다시 시도하세요.";
            case NO_ACCOUNT -> "조회할 종합매매 계좌를 하나로 정하지 못했습니다(없거나 둘 이상).";
            case REFRESHING -> "계좌를 읽는 중입니다. 잠시 뒤 다시 시도하세요.";
            case UPSTREAM_ERROR -> "토스증권 응답을 읽지 못했습니다.";
        };
    }

    // ------------------------------------------------------------------ 값 변환(예외 없이 null)

    /** decimal 문자열(또는 JSON 숫자) → BigDecimal. 비었거나 모양이 틀리면 null — 0으로 채우지 않고, 값을 예외 문구에 싣지 않습니다. */
    static BigDecimal decimal(JsonNode node) {
        String raw = node == null ? null : node.isString() ? node.stringValue() : node.isNumber() ? node.asString() : null;
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        return trimmed.length() <= DECIMAL_MAX_LENGTH && DECIMAL.matcher(trimmed).matches() ? new BigDecimal(trimmed) : null;
    }

    /** 손익 × 100 / 매입금액(같은 통화), 소수 4자리. 어느 쪽이 null이거나 매입금액이 0이면 null. */
    static BigDecimal pct(BigDecimal amount, BigDecimal base) {
        if (amount == null || base == null || base.signum() == 0) {
            return null;
        }
        return amount.multiply(HUNDRED).divide(base, MathContext.DECIMAL64).setScale(4, RoundingMode.HALF_UP);
    }

    /** 토스 비율(소수 0.1077) → 퍼센트(10.77). */
    private static BigDecimal ratePct(BigDecimal rate) {
        return rate == null ? null : rate.movePointRight(2);
    }

    private static OffsetDateTime time(JsonNode node) {
        String raw = text(node);
        if (raw == null) {
            return null;
        }
        try {
            return OffsetDateTime.parse(raw.trim());
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** 받은 시각·이전 값 시각만 초까지(새로고침 주기 기능의 '기준 시각', ADR 0030). 주문 시각과 공용 {@code Kst.DISPLAY}(분까지)는 그대로. */
    private static final java.time.format.DateTimeFormatter DISPLAY_SECONDS =
            java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss").withZone(Kst.ZONE);

    private static String display(OffsetDateTime at) {
        return at == null ? null : Kst.DISPLAY.format(at);
    }

    private static String displaySeconds(OffsetDateTime at) {
        return at == null ? null : DISPLAY_SECONDS.format(at);
    }

    private static String text(JsonNode node) {
        return node != null && node.isString() ? node.stringValue() : null;
    }

    private static boolean bool(JsonNode node) {
        return node.isBoolean() && node.booleanValue();
    }

    private static Integer count(JsonNode node) {
        return node.isIntegralNumber() && node.canConvertToInt() && node.intValue() >= 0 ? node.intValue() : null;
    }

    private static int intOrZero(JsonNode node) {
        Integer value = count(node);
        return value == null ? 0 : value;
    }

    private static List<JsonNode> elements(JsonNode node) {
        if (!node.isArray()) {
            return List.of();
        }
        List<JsonNode> out = new ArrayList<>();
        node.forEach(out::add);
        return out;
    }

    private static String label(JsonNode payload) {
        return text(payload.path("account").path("label"));
    }

    private static String upstreamCode(JsonNode payload) {
        String code = text(payload.path("errorCode"));
        return code != null && UPSTREAM_CODE.matcher(code).matches() ? code : null;
    }
}
