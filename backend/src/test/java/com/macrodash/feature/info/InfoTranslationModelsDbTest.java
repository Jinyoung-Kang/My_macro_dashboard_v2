package com.macrodash.feature.info;

import com.macrodash.collector.CollectorClient;
import com.macrodash.feature.ai.AiService;
import com.macrodash.read.StoreReader;
import com.macrodash.store.FetchStateStore;
import com.macrodash.store.InfoStore;
import com.macrodash.store.SchemaCheck;
import com.macrodash.store.StoreRepository;
import com.macrodash.store.TranslationStore;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * 저장된 번역을 다시 읽을 때의 번역 모델 이름(QA-403, ADR 0037 개정 1) — 실제 번역 표(테스트 DB)로 봅니다. 모델은 부르지 않습니다(대역).
 *
 * <p>한 등급 아래 Gemini 모델이 인명을 바꿔 옮긴 적이 있어 '번역 행·화면에 실제 모델 이름을 남김'으로 그 위험을 덮기로 했는데, 저장본만으로
 * 끝난 응답은 모델이 null이라 화면에 이름이 나오지 않았습니다. 한 글의 제목·조각을 여러 모델이 옮겨도 응답의 모델은 하나였습니다.
 */
class InfoTranslationModelsDbTest {

    private static final Instant NOW = Instant.parse("2026-11-11T12:00:00Z");
    private static final String TITLE = "QA-403 Fed holds rates steady";
    private static final String TEXT = "QA-403 The Committee decided to maintain the target range for the federal funds rate.";

    private JdbcTemplate jdbc;
    private TranslationStore translations;
    private AiService ai;
    private GeminiClient gemini;
    private InfoService service;

    @BeforeEach
    void setUp() {
        String url = System.getenv().getOrDefault("TEST_DATABASE_URL", "jdbc:postgresql://localhost:5432/macrodash_test");
        assertThat(url).as("테스트 DB만 씁니다").endsWith("_test");
        jdbc = new JdbcTemplate(new DriverManagerDataSource(url,
                System.getenv().getOrDefault("DATABASE_USER", "macro"),
                System.getenv().getOrDefault("DATABASE_PASSWORD", "macro")));
        translations = new TranslationStore(jdbc, new SchemaCheck(jdbc));
        cleanUp();
        ai = mock(AiService.class);
        gemini = mock(GeminiClient.class);
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        InfoTranslator translator = new InfoTranslator(ai, gemini, translations, new ObjectMapper(), "claude", "claude-haiku-5-5",
                "gemini-3.5-flash", "gemini-3.5-flash-lite", "low", 1_000_000, 30, 20, clock);
        service = new InfoService(mock(InfoStore.class), mock(FetchStateStore.class), mock(StoreReader.class), mock(StoreRepository.class),
                mock(CollectorClient.class), translator, clock);
    }

    @AfterEach
    void cleanUp() {
        jdbc.update("DELETE FROM info_translations WHERE model LIKE 'test-model%'");
    }

    @Test
    @DisplayName("QA-403: 저장된 번역을 다시 읽어도 그 번역을 옮긴 모델들을 응답에 싣는다(제목·본문 조각이 서로 다른 모델이면 모두)")
    void storedTranslationKeepsItsModels() {
        assertThat(translations.ready()).isTrue();
        translations.put(TranslationStore.id(TranslationStore.TITLE, TITLE), TranslationStore.TITLE, TITLE.length(), "연준, 금리 동결", "test-model-upper");
        translations.put(TranslationStore.id(TranslationStore.BODY, TEXT), TranslationStore.BODY, TEXT.length(), "위원회는 목표 범위를 유지했다.", "test-model-lower");

        Map<String, Object> out = service.translate(null, TITLE, TEXT);

        assertThat(out).containsEntry("ok", true).containsEntry("titleKo", "연준, 금리 동결").containsEntry("textKo", "위원회는 목표 범위를 유지했다.")
                .containsEntry("cached", true)
                .containsEntry("model", null);                                   // 이번에는 모델을 부르지 않았습니다
        assertThat(out.get("models")).isEqualTo(List.of("test-model-upper", "test-model-lower"));
        verify(ai, never()).structured(anyString(), anyString(), anyString(), any(), anyString(), anyInt());
        verify(gemini, never()).structured(anyString(), anyString(), anyString(), any(), anyInt());
    }

    @Test
    @DisplayName("QA-403: 제목만 번역한 응답도 저장된 모델을 싣고, 번역이 없으면 빈 목록이다")
    void titleOnlyAndNothingStored() {
        translations.put(TranslationStore.id(TranslationStore.TITLE, TITLE), TranslationStore.TITLE, TITLE.length(), "연준, 금리 동결", "test-model-lower");

        assertThat(service.translate(null, TITLE, null).get("models")).isEqualTo(List.of("test-model-lower"));
        assertThat(service.translate(null, "한국어 제목", "이미 한국어인 본문입니다.").get("models")).isEqualTo(List.of());
    }
}
