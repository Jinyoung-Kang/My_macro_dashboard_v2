package com.macrodash.feature.insight;

import com.macrodash.Kst;
import com.macrodash.analytics.Regime;
import com.macrodash.read.StoreReader;
import com.macrodash.store.RegimeLogStore;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.properties.source.ConfigurationPropertySources;
import org.springframework.core.env.StandardEnvironment;
import org.springframework.core.env.SystemEnvironmentPropertySource;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 국면 판정 라이브 기록 — 언제 기록하고, 무엇을 "판정 불가"로 남기는가.
 */
class RegimeLogServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final LocalDate TODAY = LocalDate.of(2026, 10, 9);

    /** KST 기준 시각에 멈춘 시계. */
    private static Clock kstAt(int hour) {
        return Clock.fixed(Instant.parse("2026-10-09T%02d:30:00Z".formatted(hour - 9)), ZoneOffset.UTC);
    }

    private static Map<String, Object> input(Double value, String asOf) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("value", value);
        out.put("asOf", asOf);
        return out;
    }

    private static AnalyticsService.RegimeReading reading(String nfciAsOf) {
        Regime.Verdict verdict = Regime.classify(0.42, -0.48, 2.85, 0.025);
        Map<String, Map<String, Object>> inputs = new LinkedHashMap<>();
        inputs.put("curve10y3m", input(0.42, "2026-10-08"));
        inputs.put("nfci", input(-0.48, nfciAsOf));
        inputs.put("hyOas", input(2.85, "2026-10-08"));
        inputs.put("liquidity4w", input(0.025, "2026-10-08"));
        return new AnalyticsService.RegimeReading(verdict, inputs);
    }

    @SuppressWarnings("unchecked")
    private static StoreReader quietStore() {
        StoreReader store = mock(StoreReader.class);
        when(store.quietly(any())).thenAnswer(call -> ((Supplier<Object>) call.getArgument(0)).get());
        return store;
    }

    @Test
    @DisplayName("입력이 모두 신선하면 화면과 같은 판정을 그대로 기록한다")
    void freshInputsAreRecordedAsIs() {
        RegimeLogService service = new RegimeLogService(mock(AnalyticsService.class), quietStore(),
                mock(RegimeLogStore.class), MAPPER, kstAt(19));

        RegimeLogStore.Entry entry = service.toEntry(TODAY, reading("2026-10-02"));

        assertThat(entry.code()).isEqualTo("EXPANSION");
        assertThat(entry.missing()).isEmpty();
        assertThat(entry.ruleVersion()).isEqualTo(Regime.RULE_VERSION);
        assertThat(entry.inputs().path("nfci").path("asOf").asText()).isEqualTo("2026-10-02");
    }

    @Test
    @DisplayName("입력이 오래됐으면 '판정 불가'로 남기고 어느 입력이 며칠 지났는지 적는다")
    void staleInputBecomesUnknown() {
        RegimeLogService service = new RegimeLogService(mock(AnalyticsService.class), quietStore(),
                mock(RegimeLogStore.class), MAPPER, kstAt(19));

        RegimeLogStore.Entry entry = service.toEntry(TODAY, reading("2026-09-18"));

        assertThat(entry.code()).isEqualTo("UNKNOWN");
        assertThat(entry.label()).isEqualTo("판정 불가");
        assertThat(entry.missing()).containsExactly("입력 오래됨: NFCI (2026-09-18, 21일 전)");
    }

    @Test
    @DisplayName("KST 18시 전에는 기록하지 않는다 — 밤사이 수집이 아직 안 돌았을 수 있음")
    void waitsUntilEvening() {
        RegimeLogStore regimeLog = mock(RegimeLogStore.class);
        when(regimeLog.ready()).thenReturn(true);
        AnalyticsService analytics = mock(AnalyticsService.class);
        RegimeLogService service = new RegimeLogService(analytics, quietStore(), regimeLog, MAPPER, kstAt(17));

        assertThat(service.recordToday()).isEqualTo(RegimeLogService.Outcome.TOO_EARLY);
        verify(analytics, never()).regimeNow();
    }

    /**
     * 서버(Vultr, ADR 0023)의 하루 — 24시간 켜져 있어 백엔드가 30분마다 00:29 · 00:59 · … · 23:59에 돕니다.
     * 실행마다 그 시각의 시계로 서비스를 만듭니다.
     */
    private static List<RegimeLogService.Outcome> serverDay(int recordHourKst) {
        RegimeLogStore regimeLog = mock(RegimeLogStore.class);
        when(regimeLog.ready()).thenReturn(true);
        Set<LocalDate> recorded = new HashSet<>();
        when(regimeLog.exists(any())).thenAnswer(call -> recorded.contains(call.<LocalDate>getArgument(0)));
        when(regimeLog.insertIfAbsent(any())).thenAnswer(call -> recorded.add(call.<RegimeLogStore.Entry>getArgument(0).verdictDate()));
        AnalyticsService analytics = mock(AnalyticsService.class);
        when(analytics.regimeNow()).thenReturn(reading("2026-10-02"));

        List<RegimeLogService.Outcome> outcomes = new ArrayList<>();
        for (int run = 0; run < 48; run++) {
            LocalTime at = LocalTime.of(0, 29).plusMinutes(30L * run);
            Clock clock = Clock.fixed(TODAY.atTime(at).atZone(Kst.ZONE).toInstant(), ZoneOffset.UTC);
            outcomes.add(new RegimeLogService(analytics, quietStore(), regimeLog, MAPPER, clock, recordHourKst)
                    .recordToday());
        }
        return outcomes;
    }

    @Test
    @DisplayName("ADR 0023: 서버 덧붙임(compose.vultr.yml)의 기록 시각이면 하루에 한 번, 그 시각 뒤 첫 실행에 기록한다")
    void serverDeploymentRecordsOnceADay() throws Exception {
        Path compose = Path.of("../compose.vultr.yml");
        assumeTrue(Files.exists(compose), "compose.vultr.yml을 찾을 수 없습니다");
        Matcher setting = Pattern.compile("(DASHBOARD_SCHEDULER_REGIME\\w*):\\s*\"(\\d+)\"")
                .matcher(Files.readString(compose));
        assertThat(setting.find()).as("compose.vultr.yml backend에 판정 기록 시각 설정이 있어야 함").isTrue();

        // 그 환경변수 이름이 실제로 이 설정에 붙는지 — 스프링 부트의 환경변수 이름 규칙으로 풀어 봅니다.
        StandardEnvironment env = new StandardEnvironment();
        env.getPropertySources().replace(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                new SystemEnvironmentPropertySource(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME,
                        Map.of(setting.group(1), setting.group(2))));
        ConfigurationPropertySources.attach(env);
        int hour = Integer.parseInt(env.resolvePlaceholders("${dashboard.scheduler.regime-record-hour-kst:18}"));
        assertThat(hour).isEqualTo(Integer.parseInt(setting.group(2)));

        List<RegimeLogService.Outcome> day = serverDay(hour);
        assertThat(day).containsOnlyOnce(RegimeLogService.Outcome.RECORDED);
        int recordedAt = day.indexOf(RegimeLogService.Outcome.RECORDED);
        assertThat(LocalTime.of(0, 29).plusMinutes(30L * recordedAt).getHour()).as("기록 시각 뒤 첫 실행").isEqualTo(hour);
        assertThat(day.subList(0, recordedAt)).as("그 전에는 기다림").containsOnly(RegimeLogService.Outcome.TOO_EARLY);
    }

    @Test
    @DisplayName("기록 시각이 0–23 밖이면 기동하지 않는다 — 24면 하루도 기록하지 않고 조용히 지나감")
    void rejectsRecordHourOutsideTheDay() {
        assertThatThrownBy(() -> new RegimeLogService(mock(AnalyticsService.class), quietStore(),
                mock(RegimeLogStore.class), MAPPER, kstAt(19), 24))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("regime-record-hour-kst");
    }

    @Test
    @DisplayName("저장본은 quietly로 읽는다(수집을 일으키지 않음). 이미 기록한 날은 다시 계산하지 않는다")
    void recordsOncePerDayWithoutTriggeringCollection() {
        RegimeLogStore regimeLog = mock(RegimeLogStore.class);
        when(regimeLog.ready()).thenReturn(true);
        when(regimeLog.exists(TODAY)).thenReturn(false, true);
        when(regimeLog.insertIfAbsent(any())).thenReturn(true);
        AnalyticsService analytics = mock(AnalyticsService.class);
        when(analytics.regimeNow()).thenReturn(reading("2026-10-02"));
        StoreReader store = quietStore();
        RegimeLogService service = new RegimeLogService(analytics, store, regimeLog, MAPPER, kstAt(19));

        assertThat(service.recordToday()).isEqualTo(RegimeLogService.Outcome.RECORDED);
        assertThat(service.recordToday()).isEqualTo(RegimeLogService.Outcome.ALREADY_RECORDED);

        verify(store).quietly(any());
        verify(analytics).regimeNow();
    }

    @Test
    @DisplayName("테이블이 아직 없으면(수집기가 V3 적용 전) 기록하지 않고 화면에는 이유를 알린다")
    void schemaNotReady() {
        RegimeLogStore regimeLog = mock(RegimeLogStore.class);
        when(regimeLog.ready()).thenReturn(false);
        RegimeLogService service = new RegimeLogService(mock(AnalyticsService.class), quietStore(),
                regimeLog, MAPPER, kstAt(19));

        assertThat(service.recordToday()).isEqualTo(RegimeLogService.Outcome.SCHEMA_NOT_READY);
        Map<String, Object> recent = service.recent(30, true);
        assertThat(recent.get("available")).isEqualTo(false);
        assertThat(String.valueOf(recent.get("message"))).contains("V3");
    }
}
