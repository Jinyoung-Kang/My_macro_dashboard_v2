package com.macrodash.feature.brokerage;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.feature.brokerage.BrokerageAccountView.HoldingRow;
import com.macrodash.feature.brokerage.BrokerageAccountView.OrderRow;
import com.macrodash.feature.brokerage.BrokerageAccountView.State;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 실제 계좌 응답 계약(명세 docs/specs/2026-11-05-toss-account-readonly.md §4·§6) — 수집기 JSON을 칸마다 옮기고, 요청한 쪽(원화·달러)만 보이며,
 * 모르는 칸·계좌 식별 값·수집기 문구를 싣지 않고, 못 읽은 숫자는 0이 아니라 null, reason → state 대응 표, 이전 값 전달.
 *
 * <p>픽스처는 토스 공식 스펙(1.2.28)의 예시 값으로 만든 합성본이고, {@code CANARY}가 든 값은 응답·로그에 나오면 안 되는 표식입니다.
 * 직렬화는 앱과 같은 기본값(null 칸 포함)의 Jackson으로 봅니다.
 */
class BrokerageServiceTest {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();
    /** 수집기 fetchedAt(2026-11-05 14:03:12 KST)에서 60초 뒤. */
    private static final Clock CLOCK = Clock.fixed(Instant.parse("2026-11-05T05:04:12Z"), ZoneOffset.UTC);

    /** 수집기 {@code /toss/account}가 내는 모양(명세 §3) — 토스 예시 값, 일부러 넣은 계좌 식별 값·모르는 칸(카나리) 포함. */
    private static final String PAYLOAD = """
            {
              "ok": true, "enabled": true, "reason": null, "errorCode": null,
              "fetchedAt": "2026-11-05T14:03:12+09:00", "isStale": false, "staleSince": null,
              "account": {"label": "토스증권 종합매매", "type": "BROKERAGE",
                          "accountNo": "CANARY-ACCT-0000", "accountSeq": "CANARY-SEQ-1"},
              "accountCount": 1,
              "accountNo": "CANARY-ACCT-0000", "accountSeq": "CANARY-SEQ-1", "extraTop": "CANARY-UNKNOWN-1",
              "sides": {
                "KR": {
                  "currency": "KRW", "buyingPower": "5000000", "extraSide": "CANARY-UNKNOWN-2",
                  "summary": {"purchaseAmount": "6500000", "marketValue": "7200000", "marketValueAfterCost": "7050000",
                              "profitLoss": "700000", "profitLossAfterCost": "550000", "dailyProfitLoss": "100000",
                              "rate": "0.1179", "rateAfterCost": "0.0983", "extraSummary": "CANARY-UNKNOWN-3"},
                  "holdings": [
                    {"symbol": "005930", "name": "삼성전자", "marketCountry": "KR", "currency": "KRW",
                     "quantity": "100", "lastPrice": "72000", "averagePurchasePrice": "65000",
                     "purchaseAmount": "6500000", "marketValue": "7200000", "marketValueAfterCost": "7050000",
                     "profitLoss": "700000", "profitLossAfterCost": "550000",
                     "profitLossRate": "0.1077", "profitLossRateAfterCost": "0.0846",
                     "dailyProfitLoss": "100000", "dailyProfitLossRate": "0.0141",
                     "accountNo": "CANARY-ACCT-0000", "cost": {"commission": "CANARY-UNKNOWN-4"}}
                  ],
                  "openOrders": [
                    {"orderId": "CANARY-ORDER-1", "symbol": "005930", "name": "삼성전자", "side": "BUY",
                     "orderType": "LIMIT", "timeInForce": "DAY", "status": "PENDING", "currency": "KRW",
                     "price": "70000", "quantity": "10", "orderAmount": null,
                     "orderedAt": "2026-03-29T09:30:00+09:00", "canceledAt": null,
                     "filledQuantity": "0", "averageFilledPrice": null, "filledAmount": null, "commission": null,
                     "tax": null, "filledAt": null, "settlementDate": null}
                  ],
                  "closedOrders": [
                    {"orderId": "CANARY-ORDER-2", "symbol": "005930", "name": "삼성전자", "side": "BUY",
                     "orderType": "LIMIT", "timeInForce": "DAY", "status": "FILLED", "currency": "KRW",
                     "price": "70000", "quantity": "10", "orderAmount": null,
                     "orderedAt": "2026-03-28T09:30:00+09:00", "canceledAt": null,
                     "filledQuantity": "10", "averageFilledPrice": "70000", "filledAmount": "700000",
                     "commission": "1400", "tax": "0", "filledAt": "2026-03-28T09:31:15+09:00",
                     "settlementDate": "2026-03-30"}
                  ]
                },
                "US": {
                  "currency": "USD", "buyingPower": "3500.5",
                  "summary": {"purchaseAmount": "1553", "marketValue": "1785", "marketValueAfterCost": "1771.43",
                              "profitLoss": "232", "profitLossAfterCost": "218.43", "dailyProfitLoss": "25"},
                  "holdings": [
                    {"symbol": "AAPL", "name": "Apple Inc.", "marketCountry": "US", "currency": "USD",
                     "quantity": "10", "lastPrice": "178.5", "averagePurchasePrice": "155.3",
                     "purchaseAmount": "1553", "marketValue": "1785", "marketValueAfterCost": "1771.43",
                     "profitLoss": "232", "profitLossAfterCost": "218.43",
                     "profitLossRate": "0.1494", "profitLossRateAfterCost": "0.1406",
                     "dailyProfitLoss": "25", "dailyProfitLossRate": "0.0142"}
                  ],
                  "openOrders": [
                    {"orderId": "CANARY-ORDER-3", "symbol": "AAPL", "name": "Apple Inc.", "side": "SELL",
                     "orderType": "LIMIT", "timeInForce": "DAY", "status": "PARTIAL_FILLED", "currency": "USD",
                     "price": "185.5", "quantity": "5", "orderAmount": null,
                     "orderedAt": "2026-03-29T10:00:00+09:00", "canceledAt": null,
                     "filledQuantity": "2", "averageFilledPrice": "185.25", "filledAmount": "370.5",
                     "commission": "0.66", "tax": "0", "filledAt": "2026-03-29T10:00:05+09:00",
                     "settlementDate": null}
                  ],
                  "closedOrders": []
                }
              },
              "closedFrom": "2026-10-06", "closedTruncated": false, "unclassifiedCount": 0
            }
            """;

    private CollectorClient collector;
    private AppProperties properties;
    private BrokerageService service;

    private final Logger logger = (Logger) LoggerFactory.getLogger(BrokerageService.class);
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    @BeforeEach
    void setUp() {
        collector = mock(CollectorClient.class);
        properties = new AppProperties();   // 읽기 모드 auto
        service = new BrokerageService(collector, properties, CLOCK);
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void detach() {
        logger.detachAppender(appender);
    }

    private static ObjectNode payload() {
        return (ObjectNode) MAPPER.readTree(PAYLOAD);
    }

    private BrokerageAccountView answer(JsonNode payload, String market) {
        when(collector.tossAccount()).thenReturn(Optional.of(payload));
        return service.account(market);
    }

    private static JsonNode json(BrokerageAccountView view) {
        return MAPPER.readTree(MAPPER.writeValueAsString(view));
    }

    // ------------------------------------------------------------------ 꺼짐·불통

    @Test
    @DisplayName("수집기가 꺼져 있으면(enabled:false — disabled·no-service-token) DISABLED, 고정 문구, 데이터 없음")
    void collectorDisabledIsDisabled() {
        for (String reason : List.of("disabled", "no-service-token")) {
            BrokerageAccountView view = answer(MAPPER.readTree(
                    "{\"ok\": false, \"enabled\": false, \"reason\": \"" + reason + "\", \"sides\": null}"), "KR");

            assertThat(view.state()).as(reason).isEqualTo(State.DISABLED);
            assertThat(view.available()).isFalse();
            assertThat(view.message()).isEqualTo(BrokerageService.message(State.DISABLED)).isNotBlank();
            assertThat(view.market()).isEqualTo("KR");
            assertThat(view.currency()).isEqualTo("KRW");
            assertThat(view.holdings()).isEmpty();
            assertThat(view.buyingPower()).isNull();
            assertThat(view.summary()).isNull();
        }
    }

    @Test
    @DisplayName("읽기 모드 store_only(공개 데모)면 수집기를 부르지 않고 DISABLED")
    void storeOnlyNeverCallsCollector() {
        properties.setReadMode("store_only");

        BrokerageAccountView kr = service.account("KR");
        BrokerageAccountView us = service.account("US");

        assertThat(kr.state()).isEqualTo(State.DISABLED);
        assertThat(us.state()).isEqualTo(State.DISABLED);
        assertThat(us.currency()).isEqualTo("USD");
        verifyNoInteractions(collector);
    }

    @Test
    @DisplayName("수집기에 닿지 못하면 COLLECTOR_UNREACHABLE")
    void collectorUnreachable() {
        when(collector.tossAccount()).thenReturn(Optional.empty());

        BrokerageAccountView view = service.account("US");

        assertThat(view.state()).isEqualTo(State.COLLECTOR_UNREACHABLE);
        assertThat(view.available()).isFalse();
        assertThat(view.message()).isNotBlank();
    }

    @Test
    @DisplayName("market이 없거나 KR·US가 아니면 400(InvalidRequestException)이고 수집기를 부르지 않는다")
    void invalidMarketIsBadRequest() {
        for (String market : new String[]{null, "", "JP", "kr", "KRW"}) {
            assertThatThrownBy(() -> service.account(market)).as(String.valueOf(market))
                    .isInstanceOf(InvalidRequestException.class).hasMessageContaining("market");
        }
        verifyNoInteractions(collector);
    }

    // ------------------------------------------------------------------ 쪽 나누기·칸 옮기기

    @Test
    @DisplayName("KR은 원화 항목만 — 매수 가능 금액·요약·보유·주문, 대시보드 계산 손익률, 비율 × 100, KST 시각, 나이")
    void krShowsOnlyWonRows() {
        BrokerageAccountView view = answer(payload(), "KR");

        assertThat(view.state()).isEqualTo(State.OK);
        assertThat(view.available()).isTrue();
        assertThat(view.message()).isNull();
        assertThat(view.market()).isEqualTo("KR");
        assertThat(view.currency()).isEqualTo("KRW");
        assertThat(view.accountLabel()).isEqualTo("토스증권 종합매매");
        assertThat(view.accountCount()).isEqualTo(1);
        assertThat(view.fetchedAtKst()).isEqualTo("2026-11-05 14:03");
        assertThat(view.ageSeconds()).isEqualTo(60L);
        assertThat(view.isStale()).isFalse();
        assertThat(view.staleReason()).isNull();
        assertThat(view.staleSinceKst()).isNull();
        assertThat(view.buyingPower()).isEqualByComparingTo("5000000");
        assertThat(view.summary().purchaseAmount()).isEqualByComparingTo("6500000");
        assertThat(view.summary().marketValueAfterCost()).isEqualByComparingTo("7050000");
        assertThat(view.summary().dailyProfitLoss()).isEqualByComparingTo("100000");
        // 700000 × 100 / 6500000 = 10.769230… → 10.7692, 550000 × 100 / 6500000 = 8.461538… → 8.4615
        assertThat(view.summary().profitLossPct()).isEqualTo(new BigDecimal("10.7692"));
        assertThat(view.summary().profitLossPctAfterCost()).isEqualTo(new BigDecimal("8.4615"));

        assertThat(view.holdings()).extracting(HoldingRow::symbol).containsExactly("005930");
        HoldingRow holding = view.holdings().get(0);
        assertThat(holding.name()).isEqualTo("삼성전자");
        assertThat(holding.quantity()).isEqualByComparingTo("100");
        assertThat(holding.purchaseAmount()).isEqualByComparingTo("6500000");
        assertThat(holding.profitLossPct()).isEqualByComparingTo("10.77");
        assertThat(holding.profitLossPctAfterCost()).isEqualByComparingTo("8.46");
        assertThat(holding.dailyProfitLossPct()).isEqualByComparingTo("1.41");

        assertThat(view.openOrders()).extracting(OrderRow::symbol).containsExactly("005930");
        OrderRow open = view.openOrders().get(0);
        assertThat(open.status()).isEqualTo("PENDING");
        assertThat(open.orderedAtKst()).isEqualTo("2026-03-29 09:30");
        assertThat(open.orderAmount()).isNull();
        assertThat(open.filledQuantity()).as("0은 0 그대로").isEqualByComparingTo("0");
        assertThat(open.averageFilledPrice()).isNull();
        OrderRow closed = view.closedOrders().get(0);
        assertThat(closed.filledAtKst()).isEqualTo("2026-03-28 09:31");
        assertThat(closed.settlementDate()).isEqualTo("2026-03-30");
        assertThat(closed.commission()).isEqualByComparingTo("1400");
        assertThat(view.closedFromDate()).isEqualTo("2026-10-06");
        assertThat(view.closedTruncated()).isFalse();
        assertThat(view.unclassifiedCount()).isZero();
    }

    @Test
    @DisplayName("US는 달러 항목만 — 원화 종목·주문이 섞이지 않는다")
    void usShowsOnlyDollarRows() {
        BrokerageAccountView view = answer(payload(), "US");

        assertThat(view.state()).isEqualTo(State.OK);
        assertThat(view.currency()).isEqualTo("USD");
        assertThat(view.buyingPower()).isEqualByComparingTo("3500.5");
        // 232 × 100 / 1553 = 14.938828… → 14.9388
        assertThat(view.summary().profitLossPct()).isEqualTo(new BigDecimal("14.9388"));
        assertThat(view.holdings()).extracting(HoldingRow::symbol).containsExactly("AAPL");
        assertThat(view.holdings()).extracting(HoldingRow::currency).containsOnly("USD");
        assertThat(view.openOrders()).extracting(OrderRow::symbol).containsExactly("AAPL");
        assertThat(view.openOrders().get(0).filledAtKst()).isEqualTo("2026-03-29 10:00");
        assertThat(view.closedOrders()).isEmpty();
        assertThat(json(view).toString()).doesNotContain("005930", "삼성전자", "KRW");
    }

    @Test
    @DisplayName("쪽 안에 통화·시장이 맞지 않는 항목이 있으면 보이지 않고 unclassifiedCount에 더한다(수집기 값 + 백엔드에서 뺀 수)")
    void misfitsAreCountedNotShown() {
        ObjectNode payload = payload();
        payload.put("unclassifiedCount", 2);
        ObjectNode kr = (ObjectNode) payload.path("sides").path("KR");
        // 원화 쪽에 달러 종목, 시장이 US인 원화 종목, 달러 주문, 모양이 틀린 항목
        kr.withArrayProperty("holdings").add(MAPPER.readTree(
                "{\"symbol\": \"AAPL\", \"marketCountry\": \"US\", \"currency\": \"USD\", \"quantity\": \"10\"}"));
        kr.withArrayProperty("holdings").add(MAPPER.readTree(
                "{\"symbol\": \"KRX1\", \"marketCountry\": \"US\", \"currency\": \"KRW\", \"quantity\": \"1\"}"));
        kr.withArrayProperty("openOrders").add(MAPPER.readTree(
                "{\"symbol\": \"AAPL\", \"currency\": \"USD\", \"status\": \"PENDING\"}"));
        kr.withArrayProperty("closedOrders").add(MAPPER.readTree("\"not-an-object\""));
        // 종목 코드가 없는 보유는 그릴 수 없어 뺍니다(HoldingRow.symbol은 string). 주문은 symbol이 null이어도 원화면 남깁니다.
        kr.withArrayProperty("holdings").add(MAPPER.readTree(
                "{\"marketCountry\": \"KR\", \"currency\": \"KRW\", \"quantity\": \"1\"}"));
        kr.withArrayProperty("closedOrders").add(MAPPER.readTree(
                "{\"currency\": \"KRW\", \"status\": \"CANCELED\"}"));

        BrokerageAccountView view = answer(payload, "KR");

        assertThat(view.holdings()).extracting(HoldingRow::symbol).containsExactly("005930");
        assertThat(view.openOrders()).extracting(OrderRow::symbol).containsExactly("005930");
        assertThat(view.closedOrders()).extracting(OrderRow::symbol).containsExactly("005930", null);
        assertThat(view.closedOrders().get(1).status()).isEqualTo("CANCELED");
        assertThat(view.unclassifiedCount()).isEqualTo(2 + 5);
    }

    /** 명세 §4의 칸 이름 — 직렬화한 JSON의 칸이 정확히 이것이어야 합니다(모르는 칸·식별 값이 끼지 않음). */
    private static final List<String> TOP_FIELDS = List.of("available", "state", "message", "market", "currency",
            "accountLabel", "accountCount", "fetchedAtKst", "staleSinceKst", "ageSeconds", "isStale", "staleReason",
            "upstreamCode", "buyingPower", "summary", "holdings", "openOrders", "closedOrders", "closedFromDate",
            "closedTruncated", "unclassifiedCount");
    private static final List<String> SUMMARY_FIELDS = List.of("purchaseAmount", "marketValue", "marketValueAfterCost",
            "profitLoss", "profitLossAfterCost", "dailyProfitLoss", "profitLossPct", "profitLossPctAfterCost");
    private static final List<String> HOLDING_FIELDS = List.of("symbol", "name", "marketCountry", "currency", "quantity",
            "lastPrice", "averagePurchasePrice", "purchaseAmount", "marketValue", "marketValueAfterCost", "profitLoss",
            "profitLossAfterCost", "profitLossPct", "profitLossPctAfterCost", "dailyProfitLoss", "dailyProfitLossPct");
    private static final List<String> ORDER_FIELDS = List.of("symbol", "name", "side", "orderType", "timeInForce",
            "status", "currency", "price", "quantity", "orderAmount", "orderedAtKst", "canceledAtKst", "filledQuantity",
            "averageFilledPrice", "filledAmount", "commission", "tax", "filledAtKst", "settlementDate");

    @Test
    @DisplayName("직렬화한 JSON에 계좌번호·계좌 식별 키·주문 번호·모르는 칸(카나리)이 없고, 칸 이름이 명세와 정확히 같다")
    void unknownFieldsAndAccountIdsNeverReachJson() {
        for (String market : List.of("KR", "US")) {
            JsonNode out = json(answer(payload(), market));
            String text = out.toString();

            assertThat(text).as(market).doesNotContain("CANARY", "accountNo", "accountSeq", "orderId", "extraTop",
                    "extraSide", "extraSummary", "cost", "Rate\"", "\"rate");
            assertThat(out.propertyNames()).as(market + " 맨 위 칸").containsExactlyInAnyOrderElementsOf(TOP_FIELDS);
            assertThat(out.path("summary").propertyNames()).containsExactlyInAnyOrderElementsOf(SUMMARY_FIELDS);
            assertThat(out.path("holdings").get(0).propertyNames()).containsExactlyInAnyOrderElementsOf(HOLDING_FIELDS);
            assertThat(out.path("openOrders").get(0).propertyNames()).containsExactlyInAnyOrderElementsOf(ORDER_FIELDS);
            assertThat(out.path("isStale").isBoolean()).as("isStale 칸 이름 그대로").isTrue();
            assertThat(out.path("buyingPower").isNumber()).as("숫자는 JSON number").isTrue();
            assertThat(out.path("accountCount").isNumber()).isTrue();
        }
    }

    // ------------------------------------------------------------------ 숫자·시각

    @Test
    @DisplayName("빈 문자열·글자·지수 표기·NaN·불리언·객체·공백 숫자는 0이 아니라 null — 정상 0은 0, 예외 없음")
    void garbageNumbersBecomeNullNotZero() {
        ObjectNode payload = payload();
        ObjectNode kr = (ObjectNode) payload.path("sides").path("KR");
        kr.put("buyingPower", "");
        ObjectNode holding = (ObjectNode) kr.withArrayProperty("holdings").get(0);
        holding.put("quantity", "abc");
        holding.put("lastPrice", "1e5");
        holding.put("averagePurchasePrice", "NaN");
        holding.put("marketValue", true);
        holding.set("marketValueAfterCost", MAPPER.createObjectNode());
        holding.putNull("profitLoss");
        holding.put("profitLossAfterCost", "   ");
        holding.put("profitLossRate", "Infinity");
        holding.put("profitLossRateAfterCost", "1" + "0".repeat(40));
        holding.put("dailyProfitLoss", "0");
        holding.put("dailyProfitLossRate", "-0.0141");
        ObjectNode order = (ObjectNode) kr.withArrayProperty("openOrders").get(0);
        order.put("orderedAt", "yesterday");
        order.put("price", "70,000");

        BrokerageAccountView view = answer(payload, "KR");

        assertThat(view.state()).isEqualTo(State.OK);
        assertThat(view.buyingPower()).isNull();
        HoldingRow row = view.holdings().get(0);
        assertThat(row.quantity()).isNull();
        assertThat(row.lastPrice()).isNull();
        assertThat(row.averagePurchasePrice()).isNull();
        assertThat(row.marketValue()).isNull();
        assertThat(row.marketValueAfterCost()).isNull();
        assertThat(row.profitLoss()).isNull();
        assertThat(row.profitLossAfterCost()).isNull();
        assertThat(row.profitLossPct()).isNull();
        assertThat(row.profitLossPctAfterCost()).isNull();
        assertThat(row.dailyProfitLoss()).isEqualByComparingTo("0");
        assertThat(row.dailyProfitLossPct()).isEqualByComparingTo("-1.41");
        assertThat(view.openOrders().get(0).orderedAtKst()).as("못 읽은 시각").isNull();
        assertThat(view.openOrders().get(0).price()).isNull();
        JsonNode out = json(view);
        assertThat(out.path("buyingPower").isNull()).isTrue();
        assertThat(out.path("holdings").get(0).path("quantity").isNull()).isTrue();
    }

    @Test
    @DisplayName("손익률(Pct)은 매입금액이 0·null이거나 손익이 null이면 null — 0으로 나누지 않음")
    void pctIsNullWhenPurchaseAmountIsZeroOrMissing() {
        assertThat(BrokerageService.pct(new BigDecimal("100"), BigDecimal.ZERO)).isNull();
        assertThat(BrokerageService.pct(new BigDecimal("100"), new BigDecimal("0.00"))).isNull();
        assertThat(BrokerageService.pct(null, new BigDecimal("100"))).isNull();
        assertThat(BrokerageService.pct(new BigDecimal("100"), null)).isNull();
        assertThat(BrokerageService.pct(new BigDecimal("1"), new BigDecimal("3"))).isEqualTo(new BigDecimal("33.3333"));
        assertThat(BrokerageService.pct(new BigDecimal("-2"), new BigDecimal("3"))).isEqualTo(new BigDecimal("-66.6667"));

        ObjectNode payload = payload();
        ((ObjectNode) payload.path("sides").path("KR").path("summary")).put("purchaseAmount", "0");
        BrokerageAccountView view = answer(payload, "KR");

        assertThat(view.summary().purchaseAmount()).isEqualByComparingTo("0");
        assertThat(view.summary().profitLossPct()).isNull();
        assertThat(view.summary().profitLossPctAfterCost()).isNull();
        assertThat(view.summary().profitLoss()).isEqualByComparingTo("700000");
    }

    @Test
    @DisplayName("숫자 변환 도우미 — decimal 문자열·JSON 숫자는 그대로, 그 밖은 null")
    void decimalHelper() {
        assertThat(BrokerageService.decimal(MAPPER.readTree("\"1771.43\""))).isEqualTo(new BigDecimal("1771.43"));
        assertThat(BrokerageService.decimal(MAPPER.readTree("\"-0.0846\""))).isEqualTo(new BigDecimal("-0.0846"));
        assertThat(BrokerageService.decimal(MAPPER.readTree("3500"))).isEqualByComparingTo("3500");
        // 토스 decimal은 소수 자릿수 상한이 없고 길이만 30자까지(maxLength 30) — 긴 소수 비율도 값 그대로
        assertThat(BrokerageService.decimal(MAPPER.readTree("\"0.1076923076923076923\"")))
                .isEqualTo(new BigDecimal("0.1076923076923076923"));
        assertThat(BrokerageService.decimal(MAPPER.readTree("\"0.1076923076923076923076923077\""))).isNotNull();
        assertThat(BrokerageService.decimal(MAPPER.readTree("\"0.10769230769230769230769230769\""))).as("31자").isNull();
        for (String raw : List.of("\"\"", "\"-\"", "\".5\"", "\"1.\"", "\"1e3\"", "\"0x10\"", "null", "true", "[]", "{}")) {
            assertThat(BrokerageService.decimal(MAPPER.readTree(raw))).as(raw).isNull();
        }
        assertThat(BrokerageService.decimal(MAPPER.missingNode())).isNull();
        assertThat(BrokerageService.decimal(null)).isNull();
    }

    // ------------------------------------------------------------------ reason → state·이전 값·누출

    @Test
    @DisplayName("수집기 reason → state 대응 표(명세 §4) — 모르는 값·timeout·internal·없음은 UPSTREAM_ERROR, ok인데 쪽이 없어도 UPSTREAM_ERROR")
    void reasonMapsToState() {
        Map<String, State> table = new LinkedHashMap<>();
        table.put("not-configured", State.NOT_CONFIGURED);
        table.put("ip-not-allowed", State.IP_NOT_ALLOWED);
        table.put("auth-failed", State.AUTH_FAILED);
        table.put("rate-limited", State.RATE_LIMITED);
        table.put("no-account", State.NO_ACCOUNT);
        table.put("refreshing", State.REFRESHING);
        table.put("timeout", State.UPSTREAM_ERROR);
        table.put("upstream-error", State.UPSTREAM_ERROR);
        table.put("internal", State.UPSTREAM_ERROR);
        table.put("something-new", State.UPSTREAM_ERROR);
        table.forEach((reason, state) -> {
            BrokerageAccountView view = answer(MAPPER.readTree("{\"ok\": false, \"enabled\": true, \"reason\": \""
                    + reason + "\", \"sides\": null, \"accountCount\": 2}"), "KR");
            assertThat(view.state()).as(reason).isEqualTo(state);
            assertThat(view.available()).as(reason).isFalse();
            assertThat(view.message()).as(reason).isEqualTo(BrokerageService.message(state)).isNotBlank();
            assertThat(view.accountCount()).as("no-account 안내용 개수").isEqualTo(2);
        });
        assertThat(answer(MAPPER.readTree("{\"ok\": false, \"enabled\": true, \"reason\": null}"), "KR").state())
                .isEqualTo(State.UPSTREAM_ERROR);

        ObjectNode noSides = payload();
        noSides.putNull("sides");
        assertThat(answer(noSides, "KR").state()).isEqualTo(State.UPSTREAM_ERROR);
        ObjectNode noUs = payload();
        ((ObjectNode) noUs.path("sides")).remove("US");
        assertThat(answer(noUs, "US").state()).isEqualTo(State.UPSTREAM_ERROR);
        assertThat(answer(MAPPER.readTree("[1, 2]"), "KR").state()).as("객체가 아닌 응답").isEqualTo(State.UPSTREAM_ERROR);
    }

    @Test
    @DisplayName("이전 값(isStale) — state OK·available, 받은 시각·첫 실패 시각, staleReason은 그 실패의 state, 고정 문구")
    void stalePassesThrough() {
        ObjectNode payload = payload();
        payload.put("isStale", true);
        payload.put("reason", "rate-limited");
        payload.put("staleSince", "2026-11-05T14:05:00+09:00");

        BrokerageAccountView view = answer(payload, "KR");

        assertThat(view.state()).isEqualTo(State.OK);
        assertThat(view.available()).isTrue();
        assertThat(view.isStale()).isTrue();
        assertThat(view.staleReason()).isEqualTo(State.RATE_LIMITED);
        assertThat(view.staleSinceKst()).isEqualTo("2026-11-05 14:05");
        assertThat(view.fetchedAtKst()).isEqualTo("2026-11-05 14:03");
        assertThat(view.message()).isEqualTo(BrokerageService.STALE_MESSAGE);
        assertThat(view.holdings()).extracting(HoldingRow::symbol).containsExactly("005930");
        assertThat(json(view).path("staleReason").asString()).isEqualTo("RATE_LIMITED");
    }

    @Test
    @DisplayName("수집기 문구·형식이 틀린 오류 코드·모르는 칸(카나리)은 응답에 없다 — 형식이 맞는 오류 코드만 upstreamCode")
    void collectorTextNeverReachesOutput() {
        BrokerageAccountView bad = answer(MAPPER.readTree("""
                {"ok": false, "enabled": true, "reason": "upstream-error",
                 "errorCode": "CANARY Bad Code! 1234567", "message": "CANARY-MESSAGE 1234567",
                 "detail": {"body": "CANARY-BODY"}, "sides": null}
                """), "US");

        assertThat(bad.state()).isEqualTo(State.UPSTREAM_ERROR);
        assertThat(bad.upstreamCode()).isNull();
        assertThat(bad.message()).isEqualTo(BrokerageService.message(State.UPSTREAM_ERROR));
        assertThat(json(bad).toString()).doesNotContain("CANARY", "1234567");

        BrokerageAccountView tooLong = answer(MAPPER.readTree("{\"ok\": false, \"enabled\": true, \"reason\": \"auth-failed\","
                + " \"errorCode\": \"" + "a".repeat(41) + "\"}"), "KR");
        assertThat(tooLong.upstreamCode()).isNull();

        BrokerageAccountView coded = answer(MAPPER.readTree(
                "{\"ok\": false, \"enabled\": true, \"reason\": \"ip-not-allowed\", \"errorCode\": \"ip-not-allowed\"}"), "KR");
        assertThat(coded.state()).isEqualTo(State.IP_NOT_ALLOWED);
        assertThat(coded.upstreamCode()).isEqualTo("ip-not-allowed");
    }

    @Test
    @DisplayName("응답을 만드는 중 예상 못 한 예외는 UPSTREAM_ERROR이고, 로그에는 예외 클래스 이름만(예외 문구의 값은 남기지 않음)")
    void unexpectedExceptionIsUpstreamErrorAndLogsOnlyClassName() {
        JsonNode exploding = mock(JsonNode.class, invocation -> {
            throw new IllegalStateException("CANARY-9999 holdings 1234567");
        });
        BrokerageAccountView view = answer(exploding, "KR");

        assertThat(view.state()).isEqualTo(State.UPSTREAM_ERROR);
        assertThat(view.available()).isFalse();

        when(collector.tossAccount()).thenThrow(new IllegalArgumentException("CANARY-8888 1234567"));
        assertThat(service.account("US").state()).isEqualTo(State.UPSTREAM_ERROR);

        List<String> lines = appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
        assertThat(lines).hasSize(2);
        assertThat(lines).allSatisfy(line -> assertThat(line).doesNotContain("CANARY", "1234567"));
        assertThat(lines.get(0)).contains("IllegalStateException");
        assertThat(lines.get(1)).contains("IllegalArgumentException");
        assertThat(appender.list).allSatisfy(event -> assertThat(event.getThrowableProxy()).as("스택(예외 문구) 없음").isNull());
    }
}
