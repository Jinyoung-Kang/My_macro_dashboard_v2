package com.macrodash.feature.paper;

import com.macrodash.analytics.KrFinancialSector;
import com.macrodash.read.StoreReader;
import com.macrodash.store.StoreRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;

/**
 * 한국 개요의 한계 문구(2단계 명세 §6, F2): 비지 않고 §6 순서(두 책 비교하지 않음 포함), 설정에서 오는 숫자는 그 조회 실행의 설정 판(수수료·슬리피지
 * bp·세율 시행일 — 설정을 바꾸면 문장이 바뀜), 금융업 코드 표의 회사 수는 표에서 셈, 쉬는 한국에도 같은 문구. 미국 개요의 한계 문구는 그대로
 * ({@code PaperQueryUsGoldenTest}의 고정본).
 */
class PaperQueryKrLimitsTest {

    private static final Instant NOW = Instant.parse("2026-10-13T01:00:00Z");

    private FakePaperStore store;
    private StoreReader reader;
    private PaperMarketData marketData;

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        store.initSettingsIfAbsent(PaperFixtures.settings(store).defaultsJson());
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        marketData = new PaperMarketData(reader, mock(StoreRepository.class), Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private PaperQueryService query(PaperConfig config) {
        return new PaperQueryService(store, marketData, reader, PaperFixtures.settings(store), config,
                Clock.fixed(NOW, ZoneOffset.UTC));
    }

    private static PaperConfig krConfig() {
        return new PaperConfig(true, PaperFixtures.FRI, 100_000, LocalDate.of(2026, 11, 30), PaperConfig.DEFAULT_KR_INITIAL_CASH);
    }

    @SuppressWarnings("unchecked")
    private static List<String> limits(PaperQueryService query) {
        return (List<String>) query.overview("KR").get("limits");
    }

    @Test
    @DisplayName("한국 개요 limits는 §6 문구 — 비교하지 않음·확정 조정·스탑·기업행위·400일 줄, 기본 설정 판의 수수료 1.5bp·슬리피지 5bp·세율 2026-01-01 시행, 금융업 표 회사 수")
    void koreanLimitsFollowSectionSix() {
        List<String> limits = limits(query(krConfig()));

        assertThat(limits).hasSize(16);
        assertThat(limits.get(0)).isEqualTo("모의 매매입니다. 어떤 주문도 밖으로 나가지 않습니다.");
        assertThat(limits).contains("미국·한국 책은 출발일·비용 모형·체결 시점·스탑 집행·통화가 달라 수익률을 서로 비교하지 않습니다.");
        assertThat(limits).anyMatch(line -> line.startsWith("잠정 체결가·평가는 토스증권, 확정가는 금융위원회(공공데이터포털)"))
                .anyMatch(line -> line.startsWith("한국 스탑은 다음 거래일 시가에 체결합니다"))
                .anyMatch(line -> line.contains("'기업행위 확인 필요' 배지"))
                .anyMatch(line -> line.contains("'금융위 확정 미보정'"))
                .anyMatch(line -> line.startsWith("U를 벗어난 지 400일이 지난 보유"))
                .anyMatch(line -> line.contains("노출 맞춘 참고선과 함께"));
        assertThat(limits).anyMatch(line -> line.startsWith("수수료 1.5bp는 가정이고, 세율은 2026-01-01 시행 기준(설정값), 슬리피지 5bp는"));
        assertThat(limits).anyMatch(line -> line.contains("코드 표 " + KrFinancialSector.table().size() + "곳입니다(판 "
                + KrFinancialSector.VERSION + ")"));
        assertThat(String.join("", limits)).as("미국 고유 문구가 섞이지 않음").doesNotContain("SHY").doesNotContain("13F")
                .doesNotContain("사후 체결").doesNotContain("$");
    }

    @Test
    @DisplayName("설정 판의 kr.commissionBp·kr.slippageBp·kr.tax.effectiveFrom을 바꾸면 그 숫자가 문장에 바뀌어 실린다(문장에 숫자를 박지 않음)")
    void settingsNumbersFollowTheRunSettings() {
        ObjectNode kr = (ObjectNode) store.settings.body().get("kr");
        kr.put("commissionBp", 2.25).put("slippageBp", 7);
        ((ObjectNode) kr.get("tax")).put("effectiveFrom", "2026-07-01");

        List<String> limits = limits(query(krConfig()));
        assertThat(limits).anyMatch(line -> line.startsWith("수수료 2.25bp는 가정이고, 세율은 2026-07-01 시행 기준(설정값), 슬리피지 7bp는"));
        assertThat(limits).noneMatch(line -> line.contains("1.5bp"));
    }

    @Test
    @DisplayName("쉬는 한국(출발일·한국 계좌 없음)에도 같은 문구, 미국 개요의 한계 문구는 미국 여덟 줄 그대로")
    void dormantKoreaCarriesTheSameLimits() {
        List<String> running = limits(query(krConfig()));
        PaperQueryService dormant = query(PaperFixtures.config());

        assertThat(dormant.overview("KR").get("dormantReason")).isNotNull();
        assertThat(limits(dormant)).isEqualTo(running);
        assertThat(dormant.overview("US").get("limits")).isEqualTo(dormant.limits());
        assertThat(dormant.limits()).hasSize(8);
    }
}
