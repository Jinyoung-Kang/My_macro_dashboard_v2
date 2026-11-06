package com.macrodash.collector;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.macrodash.collector.CollectorTradeClient.Outcome;
import com.macrodash.config.AppProperties;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.InetSocketAddress;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 수집기 실제 매매 경로 클라이언트({@link CollectorTradeClient}, ADR 0028) — 실제 HTTP 서버를 띄워 요청 모양(메서드·경로·쿼리·서비스 토큰·본문 바이트)과
 * 결과 분류(연결 실패 = NOT_SENT, 읽기 시간 초과·5xx·해석 실패 = UNKNOWN), 로그 가림(오류 본문·주문 번호가 로그에 없음)을 확인합니다. 본문의 카나리 글자와
 * 주문 번호는 합성 값입니다.
 */
class CollectorTradeClientTest {

    private static final String TOKEN = "test-service-token";
    private static final String CANARY = "CANARY-TRADE-7777";
    private static final String ORDER_ID = "TossOrd_SyntheticId-0001";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private HttpServer server;
    private final List<String> methods = new ArrayList<>();
    private final List<String> paths = new ArrayList<>();
    private final List<String> queries = new ArrayList<>();
    private final List<String> tokens = new ArrayList<>();
    private final List<String> bodies = new ArrayList<>();
    private volatile int status = 200;
    private volatile String body = "{}";
    private volatile long delayMillis;

    private final Logger logger = (Logger) LoggerFactory.getLogger(CollectorTradeClient.class);
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            synchronized (methods) {
                methods.add(exchange.getRequestMethod());
                paths.add(exchange.getRequestURI().getRawPath());
                queries.add(exchange.getRequestURI().getRawQuery());
                tokens.add(exchange.getRequestHeaders().getFirst("X-Service-Token"));
                bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            }
            if (delayMillis > 0) {
                try {
                    Thread.sleep(delayMillis);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            if (status >= 300 && status < 400) {
                exchange.getResponseHeaders().add("Location", "http://127.0.0.1:1/elsewhere");
            }
            try {
                exchange.sendResponseHeaders(status, bytes.length);
                try (OutputStream out = exchange.getResponseBody()) {
                    out.write(bytes);
                }
            } catch (IOException ignored) {
                // 클라이언트가 시간 초과로 먼저 끊은 경우
            }
        });
        server.start();
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void stop() {
        logger.detachAppender(appender);
        server.stop(0);
    }

    private CollectorTradeClient client(String url, String token, Duration readTimeout) {
        AppProperties properties = new AppProperties();
        properties.setCollectorUrl(url);
        properties.setCollectorToken(token);
        return new CollectorTradeClient(properties, MAPPER, Duration.ofSeconds(2), readTimeout, readTimeout, readTimeout);
    }

    private CollectorTradeClient client() {
        return client("http://127.0.0.1:" + server.getAddress().getPort(), TOKEN, Duration.ofSeconds(5));
    }

    private List<String> logLines() {
        return appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    private static String orderBody() {
        return CollectorTradeClient.orderBody("3f2b8c1e-6a4d-4f7b-9c0e-123456789abc", "005930", "BUY", "OPG", 12,
                Instant.parse("2026-11-05T23:50:31.123456Z"));
    }

    // ------------------------------------------------------------------ 주문
    @Test
    @DisplayName("주문 본문은 키 순서가 정해진 한 줄 — 수량은 문자열, firstSentAt은 밀리초로 자른 UTC")
    void orderBodyShape() {
        assertThat(orderBody()).isEqualTo("{\"clientOrderId\":\"3f2b8c1e-6a4d-4f7b-9c0e-123456789abc\",\"symbol\":\"005930\","
                + "\"side\":\"BUY\",\"timeInForce\":\"OPG\",\"quantity\":\"12\",\"firstSentAt\":\"2026-11-05T23:50:31.123Z\"}");
        Instant at = Instant.parse("2026-11-05T23:50:31Z");
        assertThatThrownBy(() -> CollectorTradeClient.orderBody("bad key!", "005930", "BUY", "DAY", 1, at))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CollectorTradeClient.orderBody("k", "AAPL", "BUY", "DAY", 1, at))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CollectorTradeClient.orderBody("k", "005930", "HOLD", "DAY", 1, at))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CollectorTradeClient.orderBody("k", "005930", "SELL", "CLS", 1, at))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CollectorTradeClient.orderBody("k", "005930", "SELL", "DAY", 0, at))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> CollectorTradeClient.orderBody("0123456789012345678901234567890123456", "005930", "SELL",
                "DAY", 1, at)).as("37자").isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("ACCEPTED — POST 한 번, 서비스 토큰, 받은 본문 바이트 그대로; 결과의 toString에 주문 번호가 없다")
    void acceptedSendsBodyVerbatim() {
        body = "{\"outcome\":\"ACCEPTED\",\"orderId\":\"" + ORDER_ID + "\",\"httpStatus\":200}";
        String request = orderBody();

        CollectorTradeClient.OrderResult result = client().placeOrder(request);

        assertThat(result.outcome()).isEqualTo(Outcome.ACCEPTED);
        assertThat(result.orderId()).isEqualTo(ORDER_ID);
        assertThat(result.httpStatus()).isEqualTo(200);
        assertThat(result.toString()).doesNotContain(ORDER_ID);
        assertThat(methods).containsExactly("POST");
        assertThat(paths).containsExactly("/toss/trading/orders");
        assertThat(queries).containsOnlyNulls();
        assertThat(tokens).containsExactly(TOKEN);
        assertThat(bodies).containsExactly(request);
        assertThat(logLines()).as("성공은 로그를 남기지 않음").isEmpty();
    }

    @Test
    @DisplayName("수집기가 준 REJECTED·NOT_SENT·UNKNOWN과 사유 코드는 그대로 — 코드 모양이 아닌 사유(오류 문구)는 버린다")
    void collectorOutcomesPassThrough() {
        body = "{\"outcome\":\"REJECTED\",\"code\":\"opposite-pending-order-exists\",\"httpStatus\":409}";
        CollectorTradeClient.OrderResult rejected = client().placeOrder(orderBody());
        assertThat(rejected.outcome()).isEqualTo(Outcome.REJECTED);
        assertThat(rejected.code()).isEqualTo("opposite-pending-order-exists");
        assertThat(rejected.httpStatus()).isEqualTo(409);
        assertThat(rejected.orderId()).isNull();

        body = "{\"outcome\":\"NOT_SENT\",\"code\":\"outside-window\"}";
        assertThat(client().placeOrder(orderBody())).isEqualTo(new CollectorTradeClient.OrderResult(Outcome.NOT_SENT, null,
                "outside-window", null));

        body = "{\"outcome\":\"UNKNOWN\",\"code\":\"" + CANARY + " message from toss\"}";
        CollectorTradeClient.OrderResult unknown = client().placeOrder(orderBody());
        assertThat(unknown.outcome()).isEqualTo(Outcome.UNKNOWN);
        assertThat(unknown.code()).as("모양이 아닌 코드").isNull();
        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain(CANARY));
    }

    @Test
    @DisplayName("주문 번호 없는 ACCEPTED·모르는 outcome·JSON 아님·5xx·3xx·4xx는 UNKNOWN — 로그에는 상태 코드만, 본문은 남기지 않는다")
    void outOfContractIsUnknown() {
        body = "{\"outcome\":\"ACCEPTED\"}";
        assertThat(client().placeOrder(orderBody()))
                .isEqualTo(new CollectorTradeClient.OrderResult(Outcome.UNKNOWN, null, "accepted-without-order-id", null));
        body = "{\"outcome\":\"ACCEPTED\",\"orderId\":\"has space " + CANARY + "\"}";
        assertThat(client().placeOrder(orderBody()).outcome()).isEqualTo(Outcome.UNKNOWN);
        body = "{\"outcome\":\"MAYBE\"}";
        assertThat(client().placeOrder(orderBody()).code()).isEqualTo("collector-bad-response");
        body = "<html>" + CANARY + "</html>";
        assertThat(client().placeOrder(orderBody()))
                .isEqualTo(new CollectorTradeClient.OrderResult(Outcome.UNKNOWN, null, "collector-bad-response", null));

        status = 500;
        body = "{\"detail\":\"" + CANARY + " account 1234567890\"}";
        assertThat(client().placeOrder(orderBody()))
                .isEqualTo(new CollectorTradeClient.OrderResult(Outcome.UNKNOWN, null, "collector-http-500", null));
        status = 302;
        assertThat(client().placeOrder(orderBody()).outcome()).as("리다이렉트를 따라가지 않음").isEqualTo(Outcome.UNKNOWN);
        status = 403;
        assertThat(client().placeOrder(orderBody()).code()).isEqualTo("collector-http-403");

        assertThat(logLines()).anySatisfy(line -> assertThat(line).contains("500"));
        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain(CANARY, "1234567890", "3f2b8c1e", "005930"));
    }

    @Test
    @DisplayName("읽기 시간 초과는 UNKNOWN(collector-timeout) — 수집기가 토스로 보냈는지 모름")
    void readTimeoutIsUnknown() {
        delayMillis = 1_500;
        body = "{\"outcome\":\"ACCEPTED\",\"orderId\":\"" + ORDER_ID + "\"}";
        CollectorTradeClient.OrderResult result = client("http://127.0.0.1:" + server.getAddress().getPort(), TOKEN,
                Duration.ofMillis(300)).placeOrder(orderBody());

        assertThat(result.outcome()).isEqualTo(Outcome.UNKNOWN);
        assertThat(result.code()).isEqualTo("collector-timeout");
        assertThat(methods).as("요청은 수집기에 닿았음").containsExactly("POST");
    }

    @Test
    @DisplayName("연결 거부는 NOT_SENT(collector-unreachable) — 로그에 주소를 남기지 않는다")
    void connectionRefusedIsNotSent() {
        CollectorTradeClient.OrderResult result = client("http://127.0.0.1:1", TOKEN, Duration.ofSeconds(2)).placeOrder(orderBody());

        assertThat(result.outcome()).isEqualTo(Outcome.NOT_SENT);
        assertThat(result.code()).isEqualTo("collector-unreachable");
        assertThat(logLines()).isNotEmpty();
        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain("127.0.0.1", "http://"));
    }

    @Test
    @DisplayName("예외 분류 — 연결 시간 초과·연결 거부·그것을 감싼 IOException은 NOT_SENT, 읽기 시간 초과·끊김·그 밖은 UNKNOWN")
    void classification() {
        assertThat(CollectorTradeClient.classify(new HttpConnectTimeoutException("connect"))).isEqualTo(Outcome.NOT_SENT);
        assertThat(CollectorTradeClient.classify(new ConnectException("refused"))).isEqualTo(Outcome.NOT_SENT);
        assertThat(CollectorTradeClient.classify(new IOException("wrapped", new ConnectException("refused"))))
                .isEqualTo(Outcome.NOT_SENT);
        assertThat(CollectorTradeClient.classify(new HttpTimeoutException("request timed out"))).isEqualTo(Outcome.UNKNOWN);
        assertThat(CollectorTradeClient.classify(new IOException("connection reset"))).isEqualTo(Outcome.UNKNOWN);
        assertThat(CollectorTradeClient.classify(new IllegalStateException("x"))).isEqualTo(Outcome.UNKNOWN);
        assertThat(CollectorTradeClient.transportCode(new HttpTimeoutException("t"))).isEqualTo("collector-timeout");
        assertThat(CollectorTradeClient.transportCode(new IOException("reset"))).isEqualTo("collector-io");
        assertThat(CollectorTradeClient.transportCode(new ConnectException("refused"))).isEqualTo("collector-unreachable");
        assertThat(CollectorTradeClient.ORDER_READ_TIMEOUT).isEqualTo(Duration.ofSeconds(25));
    }

    @Test
    @DisplayName("서비스 토큰이 비었거나 본문이 비면 네트워크로 보내지 않고 NOT_SENT")
    void noTokenNotSent() {
        CollectorTradeClient noToken = client("http://127.0.0.1:" + server.getAddress().getPort(), "  ", Duration.ofSeconds(2));
        assertThat(noToken.placeOrder(orderBody())).isEqualTo(new CollectorTradeClient.OrderResult(Outcome.NOT_SENT, null,
                "no-service-token", null));
        assertThat(noToken.cancelOrder(ORDER_ID).outcome()).isEqualTo(Outcome.NOT_SENT);
        assertThat(noToken.status().reason()).isEqualTo("no-service-token");
        assertThat(client().placeOrder(" ").outcome()).isEqualTo(Outcome.NOT_SENT);
        assertThat(methods).isEmpty();
    }

    // ------------------------------------------------------------------ 취소·조회
    @Test
    @DisplayName("취소 — 주문 번호가 경로 모양이 아니면 보내지 않고 NOT_SENT, 맞으면 그 경로로 POST")
    void cancel() {
        assertThat(client().cancelOrder("../orders").outcome()).isEqualTo(Outcome.NOT_SENT);
        assertThat(client().cancelOrder("a%2Fb").code()).isEqualTo("invalid-order-id");
        assertThat(methods).isEmpty();

        body = "{\"outcome\":\"ACCEPTED\",\"cancelOrderId\":\"CancelSynthetic-9\"}";
        CollectorTradeClient.CancelResult result = client().cancelOrder(ORDER_ID);
        assertThat(result.outcome()).isEqualTo(Outcome.ACCEPTED);
        assertThat(result.cancelOrderId()).isEqualTo("CancelSynthetic-9");
        assertThat(result.toString()).doesNotContain("CancelSynthetic-9");
        assertThat(methods).containsExactly("POST");
        assertThat(paths).containsExactly("/toss/trading/orders/" + ORDER_ID + "/cancel");

        status = 500;
        body = "{\"detail\":\"" + CANARY + "\"}";
        assertThat(client().cancelOrder(ORDER_ID).outcome()).isEqualTo(Outcome.UNKNOWN);
        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain(CANARY, ORDER_ID));
    }

    @Test
    @DisplayName("주문 조회 — 정리된 주문을 읽고, 실패 로그에는 주문 번호 자리만 남긴다")
    void orders() {
        body = "{\"ok\":true,\"orders\":[{\"orderId\":\"" + ORDER_ID + "\",\"symbol\":\"005930\",\"side\":\"BUY\","
                + "\"orderType\":\"MARKET\",\"timeInForce\":\"OPG\",\"status\":\"PARTIAL_FILLED\",\"quantity\":\"12\","
                + "\"filledQuantity\":\"5\",\"averageFilledPrice\":\"70100.5\",\"filledAmount\":\"350502.5\",\"commission\":\"52\","
                + "\"tax\":\"0\",\"orderedAt\":\"2026-11-06T08:50:31+09:00\",\"canceledAt\":null,\"filledAt\":null,\"currency\":\"KRW\"}]}";
        CollectorTradeClient.Reply<List<CollectorTradeClient.BrokerOrder>> open = client().openOrders();
        assertThat(open.ok()).isTrue();
        CollectorTradeClient.BrokerOrder order = open.value().getFirst();
        assertThat(order.orderId()).isEqualTo(ORDER_ID);
        assertThat(order.status()).isEqualTo("PARTIAL_FILLED");
        assertThat(order.filledQuantity()).isEqualByComparingTo("5");
        assertThat(order.averageFilledPrice()).isEqualByComparingTo("70100.5");
        assertThat(order.orderedAt()).isEqualTo(Instant.parse("2026-11-05T23:50:31Z"));
        assertThat(order.toString()).doesNotContain(ORDER_ID);
        assertThat(paths).containsExactly("/toss/trading/orders/open");

        assertThat(client().todayOrders().ok()).isTrue();
        assertThat(paths).last().isEqualTo("/toss/trading/orders/today");

        body = "{\"ok\":true,\"order\":{\"orderId\":\"" + ORDER_ID + "\",\"status\":\"FILLED\"}}";
        assertThat(client().order(ORDER_ID).value().status()).isEqualTo("FILLED");
        assertThat(client().order("no/slash").reason()).isEqualTo("invalid-order-id");

        status = 502;
        assertThat(client().order(ORDER_ID).reason()).isEqualTo("collector-http-502");
        status = 200;
        body = "{\"ok\":false,\"reason\":\"rate-limited\"}";
        assertThat(client().openOrders().reason()).isEqualTo("rate-limited");
        body = "{\"ok\":true,\"orders\":[{\"status\":\"FILLED\"}]}";
        assertThat(client().openOrders().reason()).as("주문 번호 없는 주문").isEqualTo("collector-bad-response");
        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain(ORDER_ID));
        assertThat(logLines()).anySatisfy(line -> assertThat(line).contains("{orderId}"));
    }

    @Test
    @DisplayName("상태 — 켜짐이면 한도 넷, 꺼짐이면 사유, 켜졌는데 한도를 못 읽으면 꺼짐(limits-unreadable)")
    void status() {
        body = "{\"ok\":true,\"enabled\":true,\"reason\":null,\"limits\":{\"maxOrderKrw\":3000000,\"maxOrdersPerDay\":40,"
                + "\"maxBuyKrwPerDay\":20000000,\"maxEquityKrw\":50000000},\"tokenContention\":false,"
                + "\"serverTime\":\"2026-11-06T08:45:00+09:00\"}";
        CollectorTradeClient.Status on = client().status().value();
        assertThat(on.enabled()).isTrue();
        assertThat(on.limits()).isEqualTo(new CollectorTradeClient.Limits(3_000_000, 40, 20_000_000, 50_000_000));
        assertThat(on.serverTime()).isEqualTo(Instant.parse("2026-11-05T23:45:00Z"));
        assertThat(paths).containsExactly("/toss/trading/status");
        assertThat(tokens).containsExactly(TOKEN);

        body = "{\"ok\":true,\"enabled\":false,\"reason\":\"limits-invalid\",\"limits\":null,\"tokenContention\":true}";
        CollectorTradeClient.Status off = client().status().value();
        assertThat(off.enabled()).isFalse();
        assertThat(off.reason()).isEqualTo("limits-invalid");
        assertThat(off.tokenContention()).isTrue();

        body = "{\"ok\":true,\"enabled\":true,\"limits\":{\"maxOrderKrw\":0}}";
        CollectorTradeClient.Status unreadable = client().status().value();
        assertThat(unreadable.enabled()).isFalse();
        assertThat(unreadable.reason()).isEqualTo("limits-unreadable");

        body = "{\"ok\":false,\"enabled\":false,\"reason\":\"no-service-token\"}";
        assertThat(client().status().value().reason()).isEqualTo("no-service-token");

        assertThat(client("http://127.0.0.1:1", TOKEN, Duration.ofSeconds(1)).status().reason()).isEqualTo("collector-unreachable");
    }

    @Test
    @DisplayName("RT3-UI-1·OPS-3: 상태 — 스위치 상태를 안 응답(known)과 모르는 응답(본문 ok:false 수집기 안의 예외·enabled 없음)을 구분, '분명히 꺼짐'은 한도 해석 실패가 아님")
    void statusKnownAndSwitchedOff() {
        body = "{\"ok\":true,\"enabled\":false,\"reason\":\"disabled\",\"limits\":null,\"tokenContention\":false}";
        CollectorTradeClient.Status off = client().status().value();
        assertThat(off.known()).isTrue();
        assertThat(off.switchedOff()).isTrue();

        body = "{\"ok\":false,\"enabled\":false,\"reason\":\"no-service-token\"}";
        CollectorTradeClient.Status noToken = client().status().value();
        assertThat(noToken.known()).as("서비스 토큰 없이 뜬 수집기 — 꺼짐이 분명").isTrue();
        assertThat(noToken.switchedOff()).isTrue();

        body = "{\"ok\":false,\"enabled\":true,\"reason\":\"internal\"}";
        CollectorTradeClient.Status internal = client().status().value();
        assertThat(internal.enabled()).isFalse();
        assertThat(internal.known()).as("수집기 안의 예외 — 스위치 상태 모름").isFalse();
        assertThat(internal.switchedOff()).isFalse();

        body = "{\"ok\":false,\"enabled\":false,\"reason\":\"internal\"}";
        assertThat(client().status().value().known()).isFalse();

        body = "{\"ok\":true,\"reason\":null}";
        assertThat(client().status().value().known()).as("enabled가 참거짓이 아님").isFalse();

        body = "{\"ok\":true,\"enabled\":true,\"limits\":{\"maxOrderKrw\":0}}";
        CollectorTradeClient.Status unreadable = client().status().value();
        assertThat(unreadable.known()).isTrue();
        assertThat(unreadable.switchedOff()).as("한도 해석 실패 — 수집기는 켜졌다고 답함").isFalse();

        body = "{\"ok\":true,\"enabled\":true,\"reason\":null,\"limits\":{\"maxOrderKrw\":3000000,\"maxOrdersPerDay\":40,"
                + "\"maxBuyKrwPerDay\":20000000,\"maxEquityKrw\":50000000},\"tokenContention\":false}";
        CollectorTradeClient.Status on = client().status().value();
        assertThat(on.known()).isTrue();
        assertThat(on.switchedOff()).isFalse();
    }

    @Test
    @DisplayName("RT2-FE-1: 상태 읽기는 따로 짧은 시간 초과(5초) — 수집기가 멈춰도 상태 API가 오래 묶이지 않음, 다른 읽기는 그대로")
    void statusHasShortReadTimeout() {
        assertThat(CollectorTradeClient.STATUS_READ_TIMEOUT).isEqualTo(Duration.ofSeconds(5));
        assertThat(CollectorTradeClient.STATUS_READ_TIMEOUT).isLessThan(CollectorTradeClient.READ_TIMEOUT);
        AppProperties properties = new AppProperties();
        properties.setCollectorUrl("http://127.0.0.1:" + server.getAddress().getPort());
        properties.setCollectorToken(TOKEN);
        CollectorTradeClient shortStatus = new CollectorTradeClient(properties, MAPPER, Duration.ofSeconds(2), Duration.ofSeconds(5),
                Duration.ofSeconds(5), Duration.ofSeconds(5), Duration.ofMillis(300));
        delayMillis = 1_000;
        body = "{\"ok\":true,\"enabled\":false,\"reason\":\"disabled\",\"limits\":null,\"tokenContention\":false}";

        long started = System.nanoTime();
        assertThat(shortStatus.status().reason()).isEqualTo("collector-timeout");
        assertThat(Duration.ofNanos(System.nanoTime() - started)).isLessThan(Duration.ofMillis(900));

        body = "{\"ok\":true,\"order\":{\"orderId\":\"" + ORDER_ID + "\",\"status\":\"FILLED\"}}";
        assertThat(shortStatus.order(ORDER_ID).ok()).as("주문 조회는 보통 읽기 시간 초과(5초)").isTrue();
    }

    @Test
    @DisplayName("달력 — 세션 시각을 순간으로 읽고, 휴장(today null)은 그대로, 시각 하나라도 못 읽으면 실패")
    void calendar() {
        body = "{\"ok\":true,\"date\":\"2026-11-06\",\"skewSeconds\":0.42,\"today\":{"
                + "\"preMarket\":{\"start\":\"2026-11-06T08:00:00+09:00\",\"auctionStart\":\"2026-11-06T08:50:00+09:00\","
                + "\"end\":\"2026-11-06T09:00:00+09:00\"},"
                + "\"regular\":{\"start\":\"2026-11-06T09:00:00+09:00\",\"closingAuctionStart\":null,\"end\":\"2026-11-06T15:30:00+09:00\"}},"
                + "\"previousBusinessDay\":\"2026-11-05\",\"nextBusinessDay\":\"2026-11-09\"}";
        CollectorTradeClient.Calendar calendar = client().calendar().value();
        assertThat(calendar.date()).isEqualTo(LocalDate.of(2026, 11, 6));
        assertThat(calendar.skewSeconds()).isEqualTo(0.42);
        assertThat(calendar.today().preMarket().auctionStart()).isEqualTo(Instant.parse("2026-11-05T23:50:00Z"));
        assertThat(calendar.today().regular().closingAuctionStart()).as("결손은 null").isNull();
        assertThat(calendar.today().regular().end()).isEqualTo(Instant.parse("2026-11-06T06:30:00Z"));
        assertThat(calendar.nextBusinessDay()).isEqualTo(LocalDate.of(2026, 11, 9));

        body = "{\"ok\":true,\"date\":\"2026-11-07\",\"skewSeconds\":null,\"today\":null,\"previousBusinessDay\":\"2026-11-06\","
                + "\"nextBusinessDay\":\"2026-11-09\"}";
        CollectorTradeClient.Calendar holiday = client().calendar().value();
        assertThat(holiday.today()).isNull();
        assertThat(holiday.skewSeconds()).isNull();

        body = "{\"ok\":true,\"date\":\"2026-11-06\",\"today\":{\"preMarket\":null,\"regular\":{\"start\":\"09:00\","
                + "\"end\":\"2026-11-06T15:30:00+09:00\"}}}";
        assertThat(client().calendar().reason()).isEqualTo("collector-bad-response");
    }

    @Test
    @DisplayName("사전 조회 — 종목 코드 모양이 아니면 보내지 않고, 쿼리는 정렬·중복 없이, 십진수는 문자열 그대로 읽는다")
    void preflight() {
        assertThat(client().preflight(List.of("005930", "../x"), List.of()).reason()).isEqualTo("invalid-symbol");
        assertThat(methods).isEmpty();

        body = "{\"ok\":true,\"fetchedAt\":\"2026-11-06T08:50:35+09:00\",\"cashBuyingPowerKrw\":\"1234567.89\","
                + "\"holdings\":[{\"symbol\":\"000660\",\"name\":\"합성종목\",\"quantity\":\"10.5\",\"lastPrice\":\"201000\"}],"
                + "\"quotes\":{\"005930\":{\"lastPrice\":\"70000\",\"upperLimitPrice\":\"91000\",\"lowerLimitPrice\":\"49000\"}},"
                + "\"sellable\":{\"000660\":\"10\"}}";
        CollectorTradeClient.Preflight preflight = client().preflight(Set.of("005930", "000660"), List.of("000660", "000660"))
                .value();
        assertThat(queries).containsExactly("symbols=000660,005930&sell=000660");
        assertThat(paths).containsExactly("/toss/trading/preflight");
        assertThat(preflight.cashBuyingPowerKrw()).isEqualByComparingTo("1234567.89");
        assertThat(preflight.holdings().getFirst().quantity()).isEqualByComparingTo("10.5");
        assertThat(preflight.quotes().get("005930").upperLimitPrice()).isEqualByComparingTo("91000");
        assertThat(preflight.sellable().get("000660")).isEqualByComparingTo("10");
        assertThat(preflight.fetchedAt()).isEqualTo(Instant.parse("2026-11-05T23:50:35Z"));

        body = "{\"ok\":false,\"reason\":\"sellable-failed\"}";
        assertThat(client().preflight(List.of(), List.of()).reason()).isEqualTo("sellable-failed");
        assertThat(queries).last().isNull();
        body = "{\"ok\":true,\"holdings\":[]}";
        assertThat(client().preflight(List.of(), List.of()).reason()).as("매수 가능 금액 없음").isEqualTo("collector-bad-response");
    }

    @Test
    @DisplayName("토큰 예열 — POST 한 번")
    void warmup() {
        body = "{\"ok\":true,\"tokenRefreshed\":true}";
        assertThat(client().warmup().value().tokenRefreshed()).isTrue();
        assertThat(methods).containsExactly("POST");
        assertThat(paths).containsExactly("/toss/trading/warmup");
    }
}
