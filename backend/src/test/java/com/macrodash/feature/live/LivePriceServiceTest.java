package com.macrodash.feature.live;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.TooManyRequestsException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.startsWith;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;

/**
 * 화면 실시간 시세({@link LivePriceService}, ADR 0024) — 종목·주기 검사, 수집기 응답 전달(store_only·무응답은 available:false), 장이 닫히면 다음
 * 보내기를 늦춤, 연결 상한, SSE 구독이 바로 'prices' 이벤트를 보냄.
 */
class LivePriceServiceTest {

    private static final JsonMapper MAPPER = JsonMapper.builder().build();

    private StoreReader store;
    private CollectorClient collector;
    private LivePriceService service;

    @BeforeEach
    void setUp() {
        store = mock(StoreReader.class);
        collector = mock(CollectorClient.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        service = new LivePriceService(store, collector);
    }

    @AfterEach
    void tearDown() {
        service.shutdown();
    }

    private static JsonNode payload(String... statuses) {
        StringBuilder items = new StringBuilder();
        for (int i = 0; i < statuses.length; i++) {
            items.append(i == 0 ? "" : ",").append("\"US:T").append(i).append("\":{\"price\":1.5,\"status\":")
                    .append(statuses[i] == null ? "null" : "\"" + statuses[i] + "\"").append('}');
        }
        return MAPPER.readTree("{\"fetchedAt\":\"2026-11-03T05:00:00Z\",\"items\":{" + items + "},\"missing\":[],\"errors\":{}}");
    }

    @Test
    @DisplayName("종목은 'US:심볼'·'KR:6자리'만 — 대문자로, 같은 것은 하나, 순서 유지, 60개까지")
    void items() {
        assertThat(LivePriceService.items(" us:aapl,KR:005930,US:AAPL, us:^gspc ,KR:0088m0,US:KRW=X"))
                .containsExactly("US:AAPL", "KR:005930", "US:^GSPC", "KR:0088M0", "US:KRW=X");
        assertThat(LivePriceService.items("tv:tvc:dxy,TV:CME_MINI:ES1!,NI:.INX"))
                .as("시장 메뉴 카드 — 트레이딩뷰·네이버 해외 지수").containsExactly("TV:TVC:DXY", "TV:CME_MINI:ES1!", "NI:.INX");
        for (String bad : new String[]{"", "AAPL", "JP:7203", "KR:12345", "US:" + "A".repeat(25), "US:AA PL", "TV:DXY", "NI:INX", "TV:TVC:D/X"}) {
            assertThatThrownBy(() -> LivePriceService.items(bad)).as(bad).isInstanceOf(InvalidRequestException.class);
        }
        StringBuilder sixtyOne = new StringBuilder();
        for (int i = 0; i < LivePriceService.MAX_ITEMS + 1; i++) {
            sixtyOne.append(i == 0 ? "" : ",").append("US:A").append(i);
        }
        assertThatThrownBy(() -> LivePriceService.items(sixtyOne.toString())).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("주기는 5초~3시간의 정해진 값만 — 그 밖은 400")
    void interval() {
        assertThat(LivePriceService.interval(5)).isEqualTo(5);
        assertThat(LivePriceService.interval(3600)).isEqualTo(3600);
        for (Integer bad : new Integer[]{null, 0, 1, 7, 86_400}) {
            assertThatThrownBy(() -> LivePriceService.interval(bad)).as(String.valueOf(bad)).isInstanceOf(InvalidRequestException.class);
        }
    }

    @Test
    @DisplayName("한 번 읽기 — 수집기 응답 그대로, 무응답은 available:false, store_only는 수집기를 부르지 않음")
    void snapshot() {
        when(collector.livePrices("US:AAPL,KR:005930")).thenReturn(Optional.of(payload("OPEN")));
        Map<String, Object> ok = service.snapshot("US:AAPL,KR:005930");
        assertThat(ok).containsEntry("available", true);
        assertThat(((JsonNode) ok.get("prices")).path("fetchedAt").asString()).isEqualTo("2026-11-03T05:00:00Z");

        when(collector.livePrices("US:MSFT")).thenReturn(Optional.empty());
        assertThat(service.snapshot("US:MSFT")).containsEntry("available", false).containsKey("message");

        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        assertThat(service.snapshot("US:NVDA")).containsEntry("available", false);
        verify(collector, never()).livePrices("US:NVDA");
    }

    @Test
    @DisplayName("받은 종목이 모두 장이 닫혀 있으면(CLOSED·모름) 다음 보내기는 5분 이상 뒤 — 하나라도 정규장·시간 외면 고른 주기")
    void closedMarketsSlowDown() {
        assertThat(LivePriceService.anyTrading(Map.of("prices", payload("CLOSED", "OPEN")))).isTrue();
        assertThat(LivePriceService.anyTrading(Map.of("prices", payload("POST")))).isTrue();
        assertThat(LivePriceService.anyTrading(Map.of("prices", payload("CLOSED", null)))).isFalse();
        assertThat(LivePriceService.anyTrading(Map.of("available", false))).isFalse();
        assertThat(LivePriceService.nextDelaySeconds(5, true)).isEqualTo(5);
        assertThat(LivePriceService.nextDelaySeconds(5, false)).isEqualTo(300);
        assertThat(LivePriceService.nextDelaySeconds(3600, false)).isEqualTo(3600);
    }

    @Test
    @DisplayName("연결은 20개까지 — 넘으면 429(검사는 연결 전에, 틀린 요청은 400)")
    void streamLimit() {
        when(collector.livePrices(anyString())).thenReturn(Optional.of(payload("CLOSED")));
        for (int i = 0; i < LivePriceService.MAX_STREAMS; i++) {
            service.stream("US:AAPL", 3600);
        }
        assertThat(service.openStreams()).isEqualTo(LivePriceService.MAX_STREAMS);
        assertThatThrownBy(() -> service.stream("US:AAPL", 3600)).isInstanceOf(TooManyRequestsException.class);
        assertThatThrownBy(() -> service.stream("US:AAPL", 7)).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("SSE 구독은 바로 'prices' 이벤트로 수집기 응답을 보낸다(text/event-stream)")
    void streamSendsImmediately() throws Exception {
        when(collector.livePrices("US:AAPL")).thenReturn(Optional.of(payload("OPEN")));
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new LivePriceController(service)).build();

        MvcResult result = mvc.perform(get("/api/live/prices/stream").param("items", "us:aapl").param("interval", "5"))
                .andExpect(request().asyncStarted())
                .andReturn();

        verify(collector, timeout(3000)).livePrices("US:AAPL");
        String body = "";
        for (int i = 0; i < 30 && !body.contains("event:prices"); i++) {
            Thread.sleep(100);
            body = result.getResponse().getContentAsString(StandardCharsets.UTF_8);
        }
        assertThat(result.getResponse().getContentType()).startsWith("text/event-stream");
        assertThat(body).contains("event:prices").contains("\"available\":true").contains("\"US:T0\"");
        assertThat(service.openStreams()).isEqualTo(1);
    }

    @Test
    @Disabled("QA-254 재현 — 수정 전: 구독의 주기 실행과 하트비트가 스레드 4개짜리 실행기 하나를 같이 써, 느린 출처를 기다리는 구독 넷이 다른 구독의 첫 값을 막음")
    @DisplayName("QA-254: 느린 출처를 기다리는 구독이 넷이어도 다른 구독의 첫 읽기는 바로 — 수집기 호출을 기다리는 구독이 실행기를 독차지하지 않음")
    void slowReadsDoNotStarveOtherStreams() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        when(collector.livePrices(startsWith("US:"))).thenAnswer(invocation -> {
            release.await(30, TimeUnit.SECONDS);   // 프록시가 응답하지 않는 출처(수집기 읽기 상한까지 기다림)
            return Optional.of(payload("OPEN"));
        });
        when(collector.livePrices("KR:005930")).thenReturn(Optional.of(payload("OPEN")));
        try {
            for (String ticker : List.of("CSCO", "INTC", "AMD", "QCOM")) {
                service.stream("US:" + ticker, 5);
            }
            verify(collector, timeout(3000).times(4)).livePrices(startsWith("US:"));
            service.stream("KR:005930", 5);
            verify(collector, timeout(2000)).livePrices("KR:005930");
        } finally {
            release.countDown();
        }
    }
}
