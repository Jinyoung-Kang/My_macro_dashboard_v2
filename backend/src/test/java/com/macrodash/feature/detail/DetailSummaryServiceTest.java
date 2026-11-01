package com.macrodash.feature.detail;

import com.macrodash.feature.ai.AiService;
import com.macrodash.feature.auth.UsageService;
import com.macrodash.support.CurrentUser;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 검색 상세 화면의 AI 요약(DetailSummaryService) — 서버가 모은 자료만 번호를 붙여 넘김, 근거 번호 → 출처, 같은 날 같은 대상은 다시 부르지 않음,
 * 하루 한도(못 쓰면 부르지 않음, 모델에 닿지 않은 실패는 되돌림), 자료가 없으면 부르지도 한도를 쓰지도 않음.
 */
class DetailSummaryServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final CurrentUser PRO = new CurrentUser(1, "p@test.local", "MEMBER", "PRO", null);

    private DetailService details;
    private AiService ai;
    private UsageService usage;
    private DetailSummaryService service;

    @BeforeEach
    void setUp() {
        details = mock(DetailService.class);
        ai = mock(AiService.class);
        usage = mock(UsageService.class);
        Clock clock = Clock.fixed(Instant.parse("2026-11-01T14:30:00Z"), ZoneOffset.UTC);
        service = new DetailSummaryService(details, ai, usage, clock);
        when(usage.consume(any(), eq(UsageService.AI_DETAIL))).thenReturn(new UsageService.Quota(true, 1, 20));
    }

    private static JsonNode json(String text) {
        return MAPPER.readTree(text);
    }

    private void stubQuoteAndNews() {
        when(details.quote("us", "AAPL")).thenReturn(Map.of("available", true, "quote", json("""
                {"name":"Apple Inc.","exchange":"NasdaqGS","currency":"USD","price":344.63,"change":-4.28,"changePct":-1.2267,
                 "asOf":"2026-10-30T20:00:01+00:00","fetchedAt":"2026-11-01T14:29:00+00:00",
                 "stats":[{"label":"시가총액","value":5029592301568,"text":null},{"label":"PER","value":null,"text":"39.52배"}],
                 "profile":{"sector":"Technology","industry":"Consumer Electronics","summary":"Apple designs devices."},
                 "consensus":{"targetMean":360.5,"recommendation":"buy"},
                 "source":{"label":"Yahoo Finance(yfinance)","url":"https://finance.yahoo.com/quote/AAPL"},"error":null}""")));
        when(details.news("us", "AAPL", "Apple")).thenReturn(Map.of("available", true, "news", json("""
                {"items":[{"title":"Apple beats estimates","url":"https://news.example/a","publisher":"Reuters","publishedAt":"2026-11-01T12:00:00+00:00","source":"Google News"},
                          {"title":"No publisher","url":"https://news.example/b","publisher":null,"publishedAt":null,"source":"Yahoo Finance"}]}""")));
    }

    private static Map<String, Object> aiOk(String text) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", true);
        out.put(AiService.CHARGED, true);
        out.put("model", "claude-haiku-5-5");
        out.put("response", text);
        return out;
    }

    @Test
    @DisplayName("자료는 번호를 붙인 시세·지표 한 덩어리와 뉴스 줄 — 없는 숫자는 적지 않고, 번호 → 출처 링크")
    void gatherNumbersSources() {
        stubQuoteAndNews();
        DetailSummaryService.Material material = service.gather(new DetailService.Target("us", "AAPL"), "Apple");
        assertThat(material.text())
                .contains("[1] 시세·지표 (출처 Yahoo Finance(yfinance), 받은 시각 2026-11-01T14:29:00+00:00)")
                .contains("- 가격: 344.63").contains("- 전일 대비: -4.28 · -1.23%").contains("- 시가총액: 5,029,592,301,568")
                .contains("- PER: 39.52배").contains("- 업종: Technology · Consumer Electronics").contains("- 투자의견: buy")
                .contains("[2] 뉴스 — Reuters, 2026-11-01T12:00:00+00:00: Apple beats estimates")
                .contains("[3] 뉴스 — Yahoo Finance, 시각 모름: No publisher");
        assertThat(material.sources()).extracting(s -> s.get("n"), s -> s.get("url"))
                .containsExactly(org.assertj.core.groups.Tuple.tuple(1, "https://finance.yahoo.com/quote/AAPL"),
                        org.assertj.core.groups.Tuple.tuple(2, "https://news.example/a"),
                        org.assertj.core.groups.Tuple.tuple(3, "https://news.example/b"));
    }

    @Test
    @DisplayName("요약 — 엔진 anthropic_haiku·고정 시스템 지시, 같은 날 같은 대상은 다시 부르지 않고 한도도 쓰지 않음(cached)")
    void summarizeAndCache() {
        stubQuoteAndNews();
        when(ai.generate(eq(DetailSummaryService.ENGINE), anyString(), eq(DetailSummaryService.SYSTEM_PROMPT)))
                .thenReturn(aiOk("  한 줄 요약: 애플은 하락 마감 [1]\n핵심:\n- 실적 상회 [2]  "));
        var request = new DetailSummaryService.Request("us", "AAPL", "Apple", "애플");
        Map<String, Object> first = service.summarize(request, PRO);
        assertThat(first).containsEntry("status", true).containsEntry("cached", false)
                .containsEntry("summary", "한 줄 요약: 애플은 하락 마감 [1]\n핵심:\n- 실적 상회 [2]")
                .containsEntry("generatedAtKst", "2026-11-01 23:30 KST").containsKey("quota");
        ArgumentCaptor<String> prompt = ArgumentCaptor.forClass(String.class);
        verify(ai).generate(eq(DetailSummaryService.ENGINE), prompt.capture(), eq(DetailSummaryService.SYSTEM_PROMPT));
        assertThat(prompt.getValue()).startsWith("<자료>\n[1] 시세·지표").contains("요청: 종목 '애플'(us:AAPL)");

        Map<String, Object> second = service.summarize(request, PRO);
        assertThat(second).containsEntry("cached", true).containsEntry("summary", first.get("summary"));
        verify(ai, times(1)).generate(anyString(), anyString(), anyString());
        verify(usage, times(1)).consume(PRO, UsageService.AI_DETAIL);
    }

    @Test
    @DisplayName("한도를 다 썼으면 부르지 않고, 모델에 닿지 않은 실패(키 없음 등)는 한도를 되돌리며 캐시하지 않는다")
    void quotaAndRefund() {
        stubQuoteAndNews();
        when(usage.consume(any(), eq(UsageService.AI_DETAIL))).thenReturn(new UsageService.Quota(false, 20, 20));
        Map<String, Object> denied = service.summarize(new DetailSummaryService.Request("us", "AAPL", "Apple", null), PRO);
        assertThat(denied).containsEntry("status", false);
        assertThat((String) denied.get("error")).contains("20건");
        verify(ai, never()).generate(anyString(), anyString(), anyString());

        when(usage.consume(any(), eq(UsageService.AI_DETAIL))).thenReturn(new UsageService.Quota(true, 1, 20));
        Map<String, Object> fail = new LinkedHashMap<>();
        fail.put("status", false);
        fail.put(AiService.CHARGED, false);
        fail.put("error", "API Key 누락");
        when(ai.generate(anyString(), anyString(), anyString())).thenReturn(fail);
        Map<String, Object> out = service.summarize(new DetailSummaryService.Request("us", "AAPL", "Apple", null), PRO);
        assertThat(out).containsEntry("status", false).containsEntry("error", "API Key 누락");
        verify(usage).refund(PRO, UsageService.AI_DETAIL);
        service.summarize(new DetailSummaryService.Request("us", "AAPL", "Apple", null), PRO);
        verify(ai, times(2)).generate(anyString(), anyString(), anyString());
    }

    @Test
    @DisplayName("자료가 하나도 없으면 부르지도 한도를 쓰지도 않고, 대상이 없거나 틀리면 400")
    void noMaterialOrBadRequest() {
        when(details.news(null, null, "Unknown Fund")).thenReturn(Map.of("available", true, "news", json("{\"items\":[]}")));
        Map<String, Object> out = service.summarize(new DetailSummaryService.Request(null, null, "Unknown Fund", null), PRO);
        assertThat(out).containsEntry("status", false).containsEntry("sources", List.of());
        verify(usage, never()).consume(any(), anyString());
        verify(ai, never()).generate(anyString(), anyString(), anyString());
        assertThatThrownBy(() -> service.summarize(new DetailSummaryService.Request("us", null, " ", null), PRO))
                .isInstanceOf(InvalidRequestException.class);
        assertThatThrownBy(() -> service.summarize(new DetailSummaryService.Request("jp", "7203", null, null), PRO))
                .isInstanceOf(InvalidRequestException.class);
    }
}
