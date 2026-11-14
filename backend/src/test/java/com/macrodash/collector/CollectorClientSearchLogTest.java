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

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 정보 검색 호출({@code liveSearch*}, ADR 0041 결정 12)의 실패 로그 — 검색어·대상 키·요청 주소를 남기지 않고 경로 이름표와 상태 코드·예외 클래스만.
 *
 * <p>일반 {@code get}은 실패 때 {@code e.getMessage()}를 남기는데, 연결·시간 초과 예외의 메시지에는 쿼리까지 든 요청 주소가, 4xx·5xx 예외의
 * 메시지에는 응답 본문이 들어갑니다. 검색어는 사용자가 친 글이라 로그에 남기지 않습니다. 검색어·본문은 합성 카나리입니다.
 */
class CollectorClientSearchLogTest {

    private static final String CANARY = "CANARYSEARCH9";

    private HttpServer server;
    private int status = 500;

    private final Logger logger = (Logger) LoggerFactory.getLogger(CollectorClient.class);
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    @BeforeEach
    void start() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            byte[] bytes = ("{\"detail\": \"" + CANARY + " echoed\"}").getBytes(StandardCharsets.UTF_8);
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

    private static CollectorClient client(String url) {
        AppProperties properties = new AppProperties();
        properties.setCollectorUrl(url);
        properties.setCollectorTimeoutSeconds(5);
        return new CollectorClient(properties);
    }

    private CollectorClient client() {
        return client("http://127.0.0.1:" + server.getAddress().getPort());
    }

    private List<String> logLines() {
        return appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    /** 네 호출 — 검색어·대상 키 자리에 카나리를 넣습니다. */
    private static final List<Function<CollectorClient, Optional<?>>> CALLS = List.of(
            c -> c.liveSearchSuggest(CANARY + " 검색어", true, false),
            c -> c.liveSearchResolve(CANARY + " 검색어", true, false),
            c -> c.liveSearchEntity("topic:" + CANARY, true, false),
            c -> c.liveSearchFeed("topic:" + CANARY, "news", true, false));

    @Test
    @DisplayName("수집기가 오류 상태와 본문을 내면 빈 값이고, 로그에는 경로 이름표와 상태 코드만")
    void errorStatusLogsOnlyLabelAndStatus() {
        for (int code : new int[]{400, 500}) {
            status = code;
            appender.list.clear();
            CollectorClient client = client();
            for (Function<CollectorClient, Optional<?>> call : CALLS) {
                assertThat(call.apply(client)).isEmpty();
            }
            assertThat(logLines()).hasSize(CALLS.size());
            assertThat(logLines()).allSatisfy(line -> assertThat(line)
                    .contains("/live/search/", String.valueOf(code))
                    .doesNotContain(CANARY, "검색어", "topic", "q=", "e=", "?"));
        }
    }

    @Test
    @DisplayName("수집기에 닿지 못하면 빈 값이고, 로그에 요청 주소·검색어를 남기지 않는다")
    void connectionFailureLogsNoUri() {
        // 포트 1은 연결이 바로 거부됩니다.
        CollectorClient client = client("http://127.0.0.1:1");
        for (Function<CollectorClient, Optional<?>> call : CALLS) {
            assertThat(call.apply(client)).isEmpty();
        }
        assertThat(logLines()).hasSize(CALLS.size());
        assertThat(logLines()).allSatisfy(line -> assertThat(line)
                .contains("/live/search/")
                .doesNotContain(CANARY, "127.0.0.1", "http://", "q=", "e=", "?"));
    }

    @Test
    @DisplayName("치는 동안의 후보(외부 호출 없음)는 짧게 기다린다 — 일반 호출의 90초가 아니다")
    void suggestReadTimeoutIsShort() {
        assertThat(CollectorClient.SEARCH_SUGGEST_READ_TIMEOUT).isEqualTo(Duration.ofSeconds(10));
    }
}
