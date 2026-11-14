package com.macrodash.collector;

import com.macrodash.config.AppProperties;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 수집기로 나가는 URL이 <b>한 번만</b> 인코딩되는지 확인합니다.
 *
 * <p><b>무엇이 있었나</b> — 수급 레이더에서 '기관 / 순매도'를 고르면 화면에
 * "수급 데이터를 얻지 못했습니다"만 떴습니다. 저장해 둔 세 조합(외국인·순매수 등)은
 * 멀쩡했기 때문에 수집기나 KRX 문제로 보였지만, 실제 원인은 URL이었습니다.
 *
 * <pre>
 * 보낸 값 : investor=기관
 * 받은 값 : investor=%25EA%25B8%25B0%25EA%25B4%2580   (%25 = '%')
 * </pre>
 *
 * 수집기는 '기관' 대신 '%EA%B8%B0%EA%B4%80'이라는 <b>글자</b>를 받아 "미지원
 * 투자주체"로 처리했고, 폴백 체인 전체가 차례로 실패했습니다. 영문·숫자만 쓰는
 * 호출은 두 번 인코딩해도 똑같아서 이 버그는 한글이 들어가는 조합에서만 드러납니다.
 *
 * <p>그래서 실제 HTTP 서버를 띄워 <b>수집기가 받는 값</b>을 그대로 확인합니다.
 * 문자열 조립을 눈으로 검사하는 테스트는 같은 실수를 다시 놓칩니다.
 */
class CollectorClientUriTest {

    private HttpServer server;
    private final List<String> receivedQueries = new ArrayList<>();
    private final List<String> receivedPaths = new ArrayList<>();
    private CollectorClient client;

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            receivedPaths.add(exchange.getRequestURI().getRawPath());
            receivedQueries.add(exchange.getRequestURI().getRawQuery());
            byte[] body = "{}".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(body);
            }
        });
        server.start();

        AppProperties properties = new AppProperties();
        properties.setCollectorUrl("http://127.0.0.1:" + server.getAddress().getPort());
        properties.setCollectorTimeoutSeconds(5);
        client = new CollectorClient(properties);
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    /** 수집기의 FastAPI가 하는 것과 같은 해석: 퍼센트 인코딩을 한 번 푼 값. */
    private String decodedParam(String name) {
        assertThat(receivedQueries).as("요청이 도착하지 않았습니다").isNotEmpty();
        for (String pair : receivedQueries.get(0).split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts[0].equals(name)) {
                return URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
            }
        }
        throw new AssertionError(name + " 파라미터가 없습니다: " + receivedQueries.get(0));
    }

    @Test
    @DisplayName("수급 레이더의 한글 파라미터가 그대로 도착한다")
    void radarKoreanParametersArriveIntact() {
        client.liveRadar("KOSPI", "기관", "순매도", 30, "TODAY", null);

        assertThat(decodedParam("investor")).isEqualTo("기관");
        assertThat(decodedParam("tradeType")).isEqualTo("순매도");
        assertThat(decodedParam("market")).isEqualTo("KOSPI");
    }

    @Test
    @DisplayName("교차 검증의 한글 파라미터도 그대로 도착한다")
    void verificationKoreanParametersArriveIntact() {
        client.verificationReadings("KOSPI", "외국인", "순매수");

        assertThat(decodedParam("investor")).isEqualTo("외국인");
        assertThat(decodedParam("tradeType")).isEqualTo("순매수");
    }

    @Test
    @DisplayName("'^'가 든 티커도 경로에서 두 번 인코딩되지 않는다")
    void tickerSymbolIsEncodedOnce() {
        client.liveTicker("^VIX", "1mo");

        // '^'는 URL에 그대로 쓸 수 없어 %5E가 됩니다. 두 번 인코딩되면 %255E입니다.
        assertThat(receivedPaths).first(org.assertj.core.api.InstanceOfAssertFactories.STRING)
                .isEqualTo("/live/ticker/%5EVIX")
                .doesNotContain("%25");
    }

    @Test
    @DisplayName("태스크 이름이 경로에 그대로 들어간다")
    void taskNameArrivesIntact() {
        client.runTask("macro_collected", false);

        assertThat(receivedPaths).containsExactly("/collect/task/macro_collected");
        assertThat(decodedParam("wait")).isEqualTo("false");
    }

    @Test
    @DisplayName("정보 검색 후보 — 한글 검색어가 그대로, external·owner가 함께 도착한다")
    void searchSuggestKoreanQueryArrivesIntact() {
        client.liveSearchSuggest("엔비디아 반도체", false, true);

        assertThat(receivedPaths).containsExactly("/live/search/suggest");
        assertThat(decodedParam("q")).isEqualTo("엔비디아 반도체");
        assertThat(decodedParam("external")).isEqualTo("false");
        assertThat(decodedParam("owner")).isEqualTo("true");
        assertThat(receivedQueries.get(0)).doesNotContain("%25");
    }

    @Test
    @DisplayName("정보 검색 Enter 후보 — '+'·'&'·'{'가 든 검색어도 한 번만 인코딩되어 그대로 도착한다")
    void searchResolveReservedCharactersArriveIntact() {
        client.liveSearchResolve("C++ & {AT&T} 100%", true, false);

        assertThat(receivedPaths).containsExactly("/live/search/resolve");
        assertThat(decodedParam("q")).isEqualTo("C++ & {AT&T} 100%");
        assertThat(decodedParam("external")).isEqualTo("true");
        assertThat(decodedParam("owner")).isEqualTo("false");
    }

    @Test
    @DisplayName("정보 검색 대상 풀기 — 'topic:' 키의 한글·공백·콜론이 그대로 도착한다")
    void searchEntityTopicKeyArrivesIntact() {
        client.liveSearchEntity("topic:AI 반도체", true, true);

        assertThat(receivedPaths).containsExactly("/live/search/entity");
        assertThat(decodedParam("e")).isEqualTo("topic:AI 반도체");
        assertThat(decodedParam("external")).isEqualTo("true");
        assertThat(decodedParam("owner")).isEqualTo("true");
    }

    @Test
    @DisplayName("정보 검색 결과 — 대상 키·탭·external·owner가 그대로 도착한다")
    void searchFeedParametersArriveIntact() {
        client.liveSearchFeed("us:BRK.B", "news", false, false);

        assertThat(receivedPaths).containsExactly("/live/search/feed");
        assertThat(decodedParam("e")).isEqualTo("us:BRK.B");
        assertThat(decodedParam("tab")).isEqualTo("news");
        assertThat(decodedParam("external")).isEqualTo("false");
        assertThat(decodedParam("owner")).isEqualTo("false");
    }

    @Test
    @DisplayName("정보 검색 지금 새로 받기 — refresh=true가 함께 도착하고, 묻지 않으면 refresh 인자가 없다")
    void searchFeedRefreshArrives() {
        client.liveSearchFeed("topic:AI 반도체", "timeline", true, true, true);
        assertThat(receivedPaths).containsExactly("/live/search/feed");
        assertThat(decodedParam("e")).isEqualTo("topic:AI 반도체");
        assertThat(decodedParam("refresh")).isEqualTo("true");

        receivedQueries.clear();
        client.liveSearchFeed("us:NVDA", "news", true, false);
        assertThat(receivedQueries.get(0)).doesNotContain("refresh");
    }

    @Test
    @DisplayName("정보 검색 Finviz(계약 §8-4·8-5) — finviz=1|0이 늘 숫자로 도착하고, 빈도를 세지 않는 예전 겹쳐 쓰기(인자 넷·다섯)는 finviz=0")
    void searchFeedFinvizArrives() {
        client.liveSearchFeed("us:NVDA", "news", true, false, false, true);
        assertThat(receivedPaths).containsExactly("/live/search/feed");
        assertThat(decodedParam("finviz")).isEqualTo("1");
        assertThat(decodedParam("e")).isEqualTo("us:NVDA");
        assertThat(decodedParam("external")).isEqualTo("true");
        assertThat(receivedQueries.get(0)).doesNotContain("refresh");

        receivedQueries.clear();
        client.liveSearchFeed("us:BRK.B", "timeline", true, true, true, false);
        assertThat(decodedParam("finviz")).isEqualTo("0");
        assertThat(decodedParam("refresh")).isEqualTo("true");
        assertThat(decodedParam("e")).isEqualTo("us:BRK.B");
        assertThat(decodedParam("owner")).isEqualTo("true");

        receivedQueries.clear();
        client.liveSearchFeed("us:NVDA", "news", true, false);
        assertThat(decodedParam("finviz")).isEqualTo("0");

        receivedQueries.clear();
        client.liveSearchFeed("topic:AI 반도체", "news", true, false, true);
        assertThat(decodedParam("finviz")).isEqualTo("0");
        assertThat(decodedParam("refresh")).isEqualTo("true");
        assertThat(decodedParam("e")).isEqualTo("topic:AI 반도체");
    }

    @Test
    @DisplayName("정보 검색 결과의 관심 대상 별칭(계약 §9-4) — JSON 배열 글 하나로 한 번만 인코딩되어 도착하고(한글·쉼표·따옴표·'&'·'+' 그대로), 비었거나 없으면 인자가 없다")
    void searchFeedAliasesArrive() {
        List<String> aliases = List.of("NVIDIA Corp", "엔비디아", "합성, 별칭", "A&B+C \"인용\"", "50% 할인");
        client.liveSearchFeed("us:NVDA", "news", true, false, false, true, aliases);

        assertThat(receivedPaths).containsExactly("/live/search/feed");
        tools.jackson.databind.JsonNode decoded = new tools.jackson.databind.ObjectMapper().readTree(decodedParam("aliases"));
        assertThat(decoded.isArray()).isTrue();
        List<String> values = new ArrayList<>();
        decoded.forEach(node -> values.add(node.asString()));
        assertThat(values).containsExactlyElementsOf(aliases);
        assertThat(decodedParam("e")).isEqualTo("us:NVDA");
        assertThat(decodedParam("finviz")).isEqualTo("1");
        assertThat(receivedQueries.get(0)).doesNotContain("%25EA");

        receivedQueries.clear();
        client.liveSearchFeed("us:NVDA", "news", true, false, false, true, List.of());
        assertThat(receivedQueries.get(0)).doesNotContain("aliases");
        receivedQueries.clear();
        client.liveSearchFeed("us:NVDA", "news", true, false, false, true, null);
        assertThat(receivedQueries.get(0)).doesNotContain("aliases");
        receivedQueries.clear();
        client.liveSearchFeed("us:NVDA", "news", true, false, false, true);
        assertThat(receivedQueries.get(0)).doesNotContain("aliases");
    }

    @Test
    @DisplayName("정보 검색 첫 화면 최근 글·매체 제외 목록의 처음 값 — 경로와 owner가 그대로 도착한다")
    void searchRecentAndExcludesArrive() {
        client.liveSearchRecent(true);
        client.liveSearchExcludes();

        assertThat(receivedPaths).containsExactly("/live/search/recent", "/live/search/excludes");
        assertThat(decodedParam("owner")).isEqualTo("true");
        assertThat(receivedQueries.get(1)).isNull();
    }

    @Test
    @DisplayName("정보 검색 연결 보강 — 대상 키(한글·공백·콜론·'.')와 external·owner가 그대로 도착한다")
    void searchLinksParametersArrive() {
        client.liveSearchLinks("topic:AI 반도체", false, true);

        assertThat(receivedPaths).containsExactly("/live/search/links");
        assertThat(decodedParam("e")).isEqualTo("topic:AI 반도체");
        assertThat(decodedParam("external")).isEqualTo("false");
        assertThat(decodedParam("owner")).isEqualTo("true");
        assertThat(receivedQueries.get(0)).doesNotContain("%25");

        receivedQueries.clear();
        client.liveSearchLinks("us:BRK.B", true, false);
        assertThat(decodedParam("e")).isEqualTo("us:BRK.B");
        assertThat(decodedParam("external")).isEqualTo("true");
        assertThat(decodedParam("owner")).isEqualTo("false");
    }
}
