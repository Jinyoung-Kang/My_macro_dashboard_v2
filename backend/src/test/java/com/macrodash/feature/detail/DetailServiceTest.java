package com.macrodash.feature.detail;

import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 검색 상세 화면의 외부 정보 전달(DetailService) — 시장·코드 형식 검사(수집기와 같은 규칙), store_only면 부르지 않음, 수집기 응답 그대로 전함.
 */
class DetailServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private StoreReader store;
    private CollectorClient collector;
    private DetailService service;

    @BeforeEach
    void setUp() {
        store = mock(StoreReader.class);
        collector = mock(CollectorClient.class);
        when(store.readMode()).thenReturn(AppProperties.ReadMode.AUTO);
        service = new DetailService(store, collector);
    }

    private static JsonNode json(String text) {
        return MAPPER.readTree(text);
    }

    @Test
    @DisplayName("시장·코드 형식 — us는 Yahoo 심볼(대문자로), kr은 6자리 대문자 영숫자, 그 밖은 400")
    void targets() {
        assertThat(DetailService.target("US", " brk-b ")).isEqualTo(new DetailService.Target("us", "BRK-B"));
        assertThat(DetailService.target("kr", "0088m0")).isEqualTo(new DetailService.Target("kr", "0088M0"));
        assertThat(DetailService.target("us", "^GSPC")).isEqualTo(new DetailService.Target("us", "^GSPC"));
        for (String[] bad : new String[][]{{"jp", "7203"}, {"kr", "5930"}, {"kr", "005930.KS"}, {"us", "AAPL;rm"}, {"us", "A".repeat(25)},
                {null, "AAPL"}, {"us", null}}) {
            assertThatThrownBy(() -> DetailService.target(bad[0], bad[1])).isInstanceOf(InvalidRequestException.class);
        }
    }

    @Test
    @DisplayName("시세 — 수집기 응답을 그대로 quote에, 받지 못하면 available:false와 사유")
    void quoteRelays() {
        JsonNode payload = json("{\"market\":\"us\",\"code\":\"AAPL\",\"price\":344.63}");
        when(collector.liveQuote("us", "AAPL")).thenReturn(Optional.of(payload));
        Map<String, Object> out = service.quote("us", "aapl");
        assertThat(out).containsEntry("available", true).containsEntry("quote", payload);

        when(collector.liveQuote("kr", "005930")).thenReturn(Optional.empty());
        assertThat(service.quote("kr", "005930")).containsEntry("available", false).containsKey("message");
    }

    @Test
    @DisplayName("store_only 읽기 모드에서는 외부 정보를 부르지 않는다(공개 데모 약속 — ADR 0012)")
    void storeOnlyDoesNotCall() {
        when(store.readMode()).thenReturn(AppProperties.ReadMode.STORE_ONLY);
        assertThat(service.quote("us", "AAPL")).containsEntry("available", false);
        assertThat(service.news("us", "AAPL", "Apple")).containsEntry("available", false);
        assertThat(service.symbols("삼성")).containsEntry("available", false);
        verifyNoInteractions(collector);
    }

    @Test
    @DisplayName("뉴스 — 종목이나 검색어 중 하나는 있어야 하고(없으면 400), 검색어만이면 시장은 소문자 그대로·코드 없음, 검색어 60자 초과는 400")
    void newsArguments() {
        when(collector.liveNews(any(), any(), any())).thenReturn(Optional.of(json("{\"items\":[]}")));
        service.news("KR", "005930", " 삼성전자 ");
        verify(collector).liveNews("kr", "005930", "삼성전자");
        service.news(null, null, "Bridgewater");
        verify(collector).liveNews(null, null, "Bridgewater");
        service.news("US", " ", "Fed funds");
        verify(collector).liveNews("us", null, "Fed funds");
        assertThatThrownBy(() -> service.news("us", null, "  ")).isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.news(null, null, "가".repeat(61))).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("종목 찾기 — 빈 검색어는 부르지 않고 빈 목록, 40자 초과는 400")
    void symbols() {
        assertThat(service.symbols("  ")).containsEntry("available", true);
        verify(collector, never()).liveSymbols(anyString());
        assertThatThrownBy(() -> service.symbols("a".repeat(41))).isInstanceOf(InvalidRequestException.class);
        when(collector.liveSymbols("nvidia")).thenReturn(Optional.of(json("{\"items\":[{\"code\":\"NVDA\"}]}")));
        assertThat(service.symbols(" nvidia ")).containsEntry("available", true).containsKey("symbols");
    }
}
