package com.macrodash.collector;

import com.macrodash.config.AppProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;
import org.springframework.web.util.UriBuilder;
import tools.jackson.databind.JsonNode;

import java.net.URI;
import java.time.Duration;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;

/**
 * 수집기(FastAPI) 호출 클라이언트.
 *
 * <p>백엔드는 스스로 외부 시장 데이터를 긁지 않습니다. 키 관리와 파싱을 한 곳에
 * 모아 두면 "진단은 통과하는데 화면은 비는" 어긋남이 생기지 않습니다.
 *
 * <p>수집기가 죽어 있어도 백엔드는 살아 있어야 합니다. 모든 호출은 실패를
 * {@link Optional#empty()}로 돌려주고, 호출부는 저장본으로 화면을 그립니다.
 */
@Component
public class CollectorClient {

    private static final Logger log = LoggerFactory.getLogger(CollectorClient.class);

    /**
     * 제어용 호출(상태 조회·백그라운드 실행 요청)의 읽기 타임아웃.
     *
     * <p>수집기가 연결은 받는데 응답을 못 하면(스레드가 외부 소스에 묶임) 90초 타임아웃의
     * 호출이 그만큼 화면을 멈춥니다. 저장본이 있는데 "수집해 두라"고 알리는 호출과 상태
     * 화면의 호출은 수 초면 충분합니다 — 오래 걸리는 것은 실제 수집(wait=true·live 조회)뿐입니다.
     */
    static final Duration CONTROL_READ_TIMEOUT = Duration.ofSeconds(3);

    /**
     * 실제 계좌 조회({@link #tossAccount()})의 읽기 타임아웃. 수집기의 갱신 예산(12초)에, 끊지 않는 토큰 발급 하나(최대 16초)를 더한 최악값보다 길게 —
     * 일반 호출의 90초를 쓰면 토스가 느릴 때 요청 스레드가 그만큼 묶입니다(명세 docs/specs/2026-11-05-toss-account-readonly.md §2).
     */
    static final Duration ACCOUNT_READ_TIMEOUT = Duration.ofSeconds(35);

    /**
     * 정보 검색의 치는 동안 후보({@link #liveSearchSuggest})의 읽기 타임아웃. 수집기가 이미 가진 색인만 찾고 외부를 부르지 않으므로(ADR 0041 결정 4)
     * 글자마다 오는 요청이 일반 호출의 90초만큼 요청 스레드를 묶지 않게 짧게 둡니다.
     */
    static final Duration SEARCH_SUGGEST_READ_TIMEOUT = Duration.ofSeconds(10);

    private final RestClient client;
    private final RestClient controlClient;
    private final RestClient accountClient;
    private final RestClient suggestClient;
    private final AppProperties properties;

    public CollectorClient(AppProperties properties) {
        this.properties = properties;
        this.client = build(properties, Duration.ofSeconds(properties.getCollectorTimeoutSeconds()));
        this.controlClient = build(properties, CONTROL_READ_TIMEOUT);
        this.accountClient = build(properties, ACCOUNT_READ_TIMEOUT);
        this.suggestClient = build(properties, SEARCH_SUGGEST_READ_TIMEOUT);
    }

    private static RestClient build(AppProperties properties, Duration readTimeout) {
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(5));
        factory.setReadTimeout(readTimeout);

        RestClient.Builder builder = RestClient.builder()
                .baseUrl(properties.getCollectorUrl())
                .requestFactory(factory);

        if (!properties.getCollectorToken().isBlank()) {
            builder = builder.defaultHeader("X-Service-Token", properties.getCollectorToken());
        }
        return builder.build();
    }

    /**
     * 태스크 1건 실행.
     *
     * @param wait false면 수집기가 백그라운드로 돌리고 즉시 응답합니다.
     *             보여 줄 저장본이 이미 있다면 기다릴 이유가 없습니다 —
     *             기다리면 그만큼 화면이 멈춥니다(sec_13f 31.8초, fred_series 11.5초).
     */
    public Optional<JsonNode> runTask(String taskName, boolean wait) {
        return post(wait ? client : controlClient, uri -> uri.path("/collect/task/{task}")
                .queryParam("wait", wait)
                .build(taskName), Map.of(), "/collect/task/" + taskName);
    }

    /** 작업군 전체 실행 (수동 새로고침 버튼 등). */
    public Optional<JsonNode> runGroup(String group, boolean wait) {
        return post(wait ? client : controlClient, uri -> uri.path("/collect")
                .queryParam("group", group)
                .queryParam("wait", wait)
                .build(), Map.of(), "/collect");
    }

    public Optional<JsonNode> requestRefresh() {
        return post(controlClient, builder -> builder.path("/refresh").build(), Map.of(), "/refresh");
    }

    public Optional<JsonNode> status() {
        return get(controlClient, builder -> builder.path("/status").build(), "/status");
    }

    public Optional<JsonNode> tasks() {
        return get(controlClient, builder -> builder.path("/tasks").build(), "/tasks");
    }

    public Optional<JsonNode> taskHistory(String task, int limit) {
        return get(controlClient, uri -> uri.path("/task-history")
                .queryParam("limit", limit)
                .queryParamIfPresent("task", Optional.ofNullable(task))
                .build(), "/task-history");
    }

    public Optional<JsonNode> diagnostics() {
        return get("/diagnostics/connections");
    }

    /** 정보 수집의 작동 방식(스위치·계층·예산·간격 — 수집기 코드의 실제 값, ADR 0036). 외부를 부르지 않는 응답입니다. */
    public Optional<JsonNode> infoMechanism() {
        return get("/info/mechanism");
    }

    /** 국내 공공 API 연결 진단 (API마다 1회 호출). 결과에 키는 없습니다. */
    public Optional<JsonNode> publicApiDiagnostics() {
        return get("/diagnostics/public-apis");
    }

    public Optional<JsonNode> tossDiagnostics() {
        return get("/diagnostics/toss");
    }

    public Optional<JsonNode> tossExchangeRate(String base, String quote) {
        return get(uri -> uri.path("/toss/exchange-rate")
                .queryParam("base", base)
                .queryParam("quote", quote)
                .build(), "/toss/exchange-rate");
    }

    public Optional<JsonNode> tossIndices(String symbols) {
        return get(uri -> uri.path("/toss/indices")
                .queryParam("symbols", symbols)
                .build(), "/toss/indices");
    }

    /**
     * 토스증권 실제 계좌 읽기 전용 조회(수집기 {@code GET /toss/account}, ADR 0025). 파라미터 없음 — 계좌 식별 값은 수집기만 쥡니다.
     *
     * <p>전용 조용한 경로입니다. 일반 {@link #get}은 실패 때 {@code e.getMessage()}를 남기는데, Spring 7은 4xx·5xx 응답 본문을 자르지 않고
     * 그 메시지에 넣습니다 — 계좌 값이 백엔드 로그로 새지 않게 상태 코드나 예외 클래스 이름만 남깁니다.
     */
    public Optional<JsonNode> tossAccount() {
        try {
            return Optional.ofNullable(accountClient.get().uri(builder -> builder.path("/toss/account").build())
                    .retrieve().body(JsonNode.class));
        } catch (RestClientResponseException e) {
            log.warn("수집기 호출 실패 (GET /toss/account): HTTP {}", e.getStatusCode().value());
            return Optional.empty();
        } catch (RuntimeException e) {
            log.warn("수집기 호출 실패 (GET /toss/account): {}", e.getClass().getSimpleName());
            return Optional.empty();
        }
    }

    public Optional<JsonNode> verificationReadings(String market, String investor, String tradeType) {
        return get(uri -> uri.path("/verify/readings")
                .queryParam("market", market)
                .queryParam("investor", investor)
                .queryParam("tradeType", tradeType)
                .build(), "/verify/readings");
    }

    public Optional<JsonNode> liveRadar(String market, String investor, String tradeType,
                                        int topN, String intervalType, String targetDate) {
        return get(uri -> uri.path("/live/radar")
                .queryParam("market", market)
                .queryParam("investor", investor)
                .queryParam("tradeType", tradeType)
                .queryParam("topN", topN)
                .queryParam("intervalType", intervalType)
                .queryParamIfPresent("targetDate", Optional.ofNullable(targetDate))
                .build(), "/live/radar");
    }

    public Optional<JsonNode> liveTicker(String symbol, String period) {
        // 티커는 경로에 들어가고 '^VIX'처럼 그냥 쓸 수 없는 글자가 섞입니다.
        // 문자열로 이어 붙이지 않고 템플릿 변수로 넘겨 한 번만 인코딩되게 합니다.
        return get(uri -> uri.path("/live/ticker/{symbol}")
                .queryParam("period", period)
                .build(symbol), "/live/ticker");
    }

    /** 검색 상세 화면의 시세·핵심 지표·개요(수집기 /live/quote — 미국·해외 Yahoo, 국내 네이버, 5분 캐시). */
    public Optional<JsonNode> liveQuote(String market, String code) {
        return get(uri -> uri.path("/live/quote")
                .queryParam("market", market)
                .queryParam("code", code)
                .build(), "/live/quote");
    }

    /** 검색 상세 화면의 주요 뉴스(수집기 /live/news — 종목 뉴스 Yahoo·네이버 + 검색어 구글 뉴스 RSS, 15분 캐시). 빈 값은 보내지 않습니다. */
    public Optional<JsonNode> liveNews(String market, String code, String q) {
        return get(uri -> uri.path("/live/news")
                .queryParamIfPresent("market", Optional.ofNullable(market))
                .queryParamIfPresent("code", Optional.ofNullable(code))
                .queryParamIfPresent("q", Optional.ofNullable(q))
                .build(), "/live/news");
    }

    /** 종목 찾기(수집기 /live/symbols — 네이버 자동완성 + Yahoo 검색, 1시간 캐시). */
    public Optional<JsonNode> liveSymbols(String q) {
        return get(uri -> uri.path("/live/symbols")
                .queryParam("q", q)
                .build(), "/live/symbols");
    }

    /**
     * 화면 실시간 시세(수집기 /live/prices — 미국 네이버 → Yahoo, 국내 네이버 → 다음 → 토스 1분봉, 3초 캐시, ADR 0024).
     * 종목 목록('US:AAPL,KR:005930')은 URI 변수로 넘겨 ':'·','·'^'·'='까지 한 번만 인코딩합니다.
     */
    public Optional<JsonNode> livePrices(String items) {
        return get(uri -> uri.path("/live/prices")
                .queryParam("items", "{items}")
                .build(items), "/live/prices");
    }

    public Optional<JsonNode> daumIntraday(int minutes) {
        return get(uri -> uri.path("/live/daum-intraday")
                .queryParam("minutes", minutes)
                .build(), "/live/daum-intraday");
    }

    // -------------------------------------------------------------- 정보 검색 (ADR 0041, 계약 docs/specs/2026-11-14-info-search-contract.md §3)
    //
    // 검색어·대상 키는 URI 변수로 넘겨 한 번만, 빠짐없이 인코딩합니다('+'·'&'·'{'·한글까지 — 템플릿 글자로 두면 '+'가 공백으로 풀립니다).
    // external(false면 수집기가 외부를 부르지 않음 — 데모·store_only)과 owner(운영자 전용 줄을 섞음)는 백엔드가 정해 늘 붙입니다.
    // 실패 로그는 경로 이름표와 상태 코드·예외 클래스만 남깁니다(getQuietly — 검색어를 로그에 남기지 않음, 결정 12).

    /** 치는 동안의 후보(수집기 /live/search/suggest — 이미 가진 색인만, 외부 호출 없음). 읽기 한도 {@link #SEARCH_SUGGEST_READ_TIMEOUT}. */
    public Optional<JsonNode> liveSearchSuggest(String q, boolean external, boolean owner) {
        return getQuietly(suggestClient, uri -> uri.path("/live/search/suggest")
                .queryParam("q", "{q}")
                .queryParam("external", external)
                .queryParam("owner", owner)
                .build(Map.of("q", q)), "/live/search/suggest");
    }

    /** Enter의 후보(수집기 /live/search/resolve — 로컬 색인 + Wikidata 검색, 1시간 캐시). */
    public Optional<JsonNode> liveSearchResolve(String q, boolean external, boolean owner) {
        return getQuietly(client, uri -> uri.path("/live/search/resolve")
                .queryParam("q", "{q}")
                .queryParam("external", external)
                .queryParam("owner", owner)
                .build(Map.of("q", q)), "/live/search/resolve");
    }

    /** 대상 풀기(수집기 /live/search/entity — Wikidata·SEC·DART 표, 하루 캐시). */
    public Optional<JsonNode> liveSearchEntity(String e, boolean external, boolean owner) {
        return getQuietly(client, uri -> uri.path("/live/search/entity")
                .queryParam("e", "{e}")
                .queryParam("external", external)
                .queryParam("owner", owner)
                .build(Map.of("e", e)), "/live/search/entity");
    }

    /** 결과(수집기 /live/search/feed — 출처별 상태와 2년 묶음, 15분 캐시). */
    public Optional<JsonNode> liveSearchFeed(String e, String tab, boolean external, boolean owner) {
        return getQuietly(client, uri -> uri.path("/live/search/feed")
                .queryParam("e", "{e}")
                .queryParam("tab", "{tab}")
                .queryParam("external", external)
                .queryParam("owner", owner)
                .build(Map.of("e", e, "tab", tab)), "/live/search/feed");
    }

    // -------------------------------------------------------------- 호출 공통
    //
    // URI는 **UriBuilder에 맡겨 한 번만 인코딩**합니다.
    //
    // 예전에는 UriComponentsBuilder…toUriString()으로 만든 문자열을 그대로
    // RestClient에 넘겼습니다. toUriString()이 이미 인코딩을 하고, RestClient가
    // 받은 문자열을 URI 템플릿으로 보고 또 인코딩해서 **두 번** 인코딩됐습니다.
    //
    //   보낸 값 : investor=기관
    //   1차     : investor=%EA%B8%B0%EA%B4%80
    //   2차     : investor=%25EA%25B8%25B0%25EA%25B4%2580   ← 수집기가 받은 것
    //
    // 수집기는 '기관' 대신 '%EA%B8%B0%EA%B4%80'이라는 글자를 받아 "미지원
    // 투자주체"로 처리했고, 화면에는 "수급 데이터를 얻지 못했습니다"만 떴습니다.
    // ASCII만 쓰는 호출은 멀쩡해서 한글이 들어가는 조합에서만 터졌습니다.
    private Optional<JsonNode> get(Function<UriBuilder, URI> uriFunction, String label) {
        return get(client, uriFunction, label);
    }

    private Optional<JsonNode> get(RestClient via, Function<UriBuilder, URI> uriFunction, String label) {
        try {
            return Optional.ofNullable(
                    via.get().uri(uriFunction).retrieve().body(JsonNode.class));
        } catch (Exception e) {
            log.warn("수집기 호출 실패 (GET {}): {}", label, e.getMessage());
            return Optional.empty();
        }
    }

    private Optional<JsonNode> get(String uri) {
        return get(builder -> builder.path(uri).build(), uri);
    }

    /**
     * 로그에 요청 주소·응답 본문을 남기지 않는 GET. {@link #get}은 {@code e.getMessage()}를 남기는데, 연결·시간 초과 예외의 메시지에는 쿼리까지 든
     * 주소가, 4xx·5xx 예외의 메시지에는 응답 본문이 들어갑니다 — 경로 이름표({@code label})와 상태 코드나 예외 클래스 이름만 남깁니다.
     */
    private Optional<JsonNode> getQuietly(RestClient via, Function<UriBuilder, URI> uriFunction, String label) {
        try {
            return Optional.ofNullable(via.get().uri(uriFunction).retrieve().body(JsonNode.class));
        } catch (RestClientResponseException e) {
            log.warn("수집기 호출 실패 (GET {}): HTTP {}", label, e.getStatusCode().value());
            return Optional.empty();
        } catch (RuntimeException e) {
            log.warn("수집기 호출 실패 (GET {}): {}", label, e.getClass().getSimpleName());
            return Optional.empty();
        }
    }

    private Optional<JsonNode> post(RestClient via, Function<UriBuilder, URI> uriFunction,
                                    Object body,
                                    String label) {
        try {
            return Optional.ofNullable(
                    via.post().uri(uriFunction).body(body).retrieve().body(JsonNode.class));
        } catch (Exception e) {
            log.warn("수집기 호출 실패 (POST {}): {}", label, e.getMessage());
            return Optional.empty();
        }
    }
}
