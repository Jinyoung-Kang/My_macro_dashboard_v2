package com.macrodash.collector;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.macrodash.config.AppProperties;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 실제 계좌 조회({@link CollectorClient#tossAccount()}, ADR 0025)의 호출 모양과 로그 가림.
 *
 * <p>실제 HTTP 서버를 띄워 수집기가 받는 요청(GET·경로·서비스 토큰)을 보고, 수집기가 오류 상태와 함께 본문을 내도 백엔드 로그에 그 본문이
 * 남지 않는지 logback으로 잡아 확인합니다 — Spring 7은 4xx·5xx 본문을 예외 메시지에 넣으므로 일반 경로처럼 {@code e.getMessage()}를 남기면
 * 계좌 값이 로그로 샙니다. 본문의 카나리 글자는 합성 값입니다.
 */
class CollectorClientAccountTest {

    private static final String TOKEN = "test-service-token";
    private static final String CANARY = "CANARY-ACCT-5555";

    private HttpServer server;
    private final List<String> methods = new ArrayList<>();
    private final List<String> paths = new ArrayList<>();
    private final List<String> queries = new ArrayList<>();
    private final List<String> tokens = new ArrayList<>();
    private int status = 200;
    private String body = "{}";

    private final Logger logger = (Logger) LoggerFactory.getLogger(CollectorClient.class);
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            methods.add(exchange.getRequestMethod());
            paths.add(exchange.getRequestURI().getRawPath());
            queries.add(exchange.getRequestURI().getRawQuery());
            tokens.add(exchange.getRequestHeaders().getFirst("X-Service-Token"));
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
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

    private CollectorClient client(String url) {
        AppProperties properties = new AppProperties();
        properties.setCollectorUrl(url);
        properties.setCollectorToken(TOKEN);
        properties.setCollectorTimeoutSeconds(5);
        return new CollectorClient(properties);
    }

    private CollectorClient client() {
        return client("http://127.0.0.1:" + server.getAddress().getPort());
    }

    private List<String> logLines() {
        return appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    @Test
    @DisplayName("GET /toss/account 하나만, 쿼리 없이, 서비스 토큰을 붙여 보내고 받은 JSON을 그대로 돌려준다")
    void sendsOneGetWithServiceToken() {
        body = "{\"ok\": false, \"enabled\": false, \"reason\": \"disabled\"}";

        Optional<JsonNode> result = client().tossAccount();

        assertThat(result).isPresent();
        assertThat(result.get().path("reason").asString()).isEqualTo("disabled");
        assertThat(methods).containsExactly("GET");
        assertThat(paths).containsExactly("/toss/account");
        assertThat(queries).containsOnlyNulls();
        assertThat(tokens).containsExactly(TOKEN);
        assertThat(logLines()).as("성공은 로그를 남기지 않음").isEmpty();
    }

    @Test
    @DisplayName("수집기가 500과 함께 본문을 내면 빈 값이고, 로그에는 상태 코드만 — 본문(카나리)은 남기지 않는다")
    void errorBodyNeverReachesLogs() {
        status = 500;
        body = "{\"detail\": \"" + CANARY + " holdings 1234567\"}";

        assertThat(client().tossAccount()).isEmpty();

        assertThat(logLines()).isNotEmpty();
        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain(CANARY, "1234567"));
        assertThat(logLines()).anySatisfy(line -> assertThat(line).contains("500"));
    }

    @Test
    @DisplayName("수집기가 4xx를 내도 같은 규칙 — 상태 코드만")
    void clientErrorBodyNeverReachesLogs() {
        status = 404;
        body = "{\"detail\": \"" + CANARY + "\"}";

        assertThat(client().tossAccount()).isEmpty();

        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain(CANARY));
        assertThat(logLines()).anySatisfy(line -> assertThat(line).contains("404"));
    }

    @Test
    @DisplayName("200인데 JSON이 아니면 빈 값이고, 로그에는 예외 클래스 이름만 — 본문은 남기지 않는다")
    void unreadableBodyNeverReachesLogs() {
        body = "<html>" + CANARY + "</html>";

        assertThat(client().tossAccount()).isEmpty();

        assertThat(logLines()).isNotEmpty();
        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain(CANARY));
    }

    @Test
    @DisplayName("수집기에 닿지 못하면 빈 값이고, 로그에 요청 주소를 남기지 않는다")
    void connectionFailureLogsOnlyTheExceptionClass() {
        // 포트 1은 연결이 바로 거부됩니다.
        assertThat(client("http://127.0.0.1:1").tossAccount()).isEmpty();

        assertThat(logLines()).isNotEmpty();
        assertThat(logLines()).allSatisfy(line -> assertThat(line).doesNotContain("127.0.0.1", "http://"));
    }

    @Test
    @DisplayName("계좌 조회의 읽기 타임아웃은 35초 — 일반 호출의 90초가 아니다")
    void accountReadTimeoutIsShort() {
        assertThat(CollectorClient.ACCOUNT_READ_TIMEOUT).isEqualTo(Duration.ofSeconds(35));
    }
}
