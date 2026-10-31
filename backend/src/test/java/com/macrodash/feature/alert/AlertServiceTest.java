package com.macrodash.feature.alert;

import com.macrodash.analytics.AlertRules;
import com.macrodash.analytics.FlowRecord;
import com.macrodash.analytics.Holding;
import com.macrodash.store.AlertStore;
import com.macrodash.support.CurrentUser;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class AlertServiceTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final CurrentUser FREE = new CurrentUser(1, "f@x", "MEMBER", "FREE", null);
    private static final CurrentUser PRO = new CurrentUser(2, "p@x", "MEMBER", "PRO", null);

    @Test
    @DisplayName("무료는 국면 전환 1개만, 유료는 종류·대상 검사를 통과해야 만든다")
    void rulesByTier() {
        AlertStore store = mock(AlertStore.class);
        AlertService service = new AlertService(store, MAPPER);

        assertThat(service.create(FREE, "FOREIGN_STREAK", MAPPER.createObjectNode().put("target", "KOSPI").put("n", 5))
                .status()).isEqualTo(403);
        when(store.countRules(1)).thenReturn(1);
        assertThat(service.create(FREE, "REGIME_CHANGE", MAPPER.createObjectNode()).status()).as("상한 1개").isEqualTo(400);

        assertThat(service.create(PRO, "FOREIGN_STREAK", MAPPER.createObjectNode().put("target", "KOSPI").put("n", 2))
                .status()).as("N은 3~20").isEqualTo(400);
        assertThat(service.create(PRO, "FOREIGN_STREAK", MAPPER.createObjectNode().put("target", "STOCK").put("code", "59"))
                .status()).isEqualTo(400);
        assertThat(service.create(PRO, "INSTITUTION_NEW", MAPPER.createObjectNode().put("cik", "999")).status())
                .as("추적 기관만").isEqualTo(400);
        assertThat(service.create(PRO, "FOREIGN_STREAK", MAPPER.createObjectNode().put("target", "KOSPI").put("n", 5))
                .status()).isEqualTo(200);
        verify(store).insertRule(anyLong(), anyString(), any());
    }

    @Test
    @DisplayName("관심 종목이 수집 범위(전체 60종목)를 넘으면 만들 때 거절 — 받아 두고 조용히 안 보내지 않음")
    void stockUniverseCap() {
        AlertStore store = mock(AlertStore.class);
        when(store.countStockCodes(null)).thenReturn(60);
        when(store.hasStockCode("005930")).thenReturn(false);
        AlertService service = new AlertService(store, MAPPER);

        assertThat(service.create(PRO, "FOREIGN_STREAK",
                MAPPER.createObjectNode().put("target", "STOCK").put("code", "005930").put("n", 5)).message())
                .contains("수집 범위 초과");
        verify(store, never()).insertRule(anyLong(), anyString(), any());
    }

    @Test
    @DisplayName("QA-041 꺼 둔 종목 규칙을 다시 켤 때도 관심 종목 상한(사용자 20·전체 60)을 본다 — 넘친 종목이 조용히 수집에서 빠지지 않게")
    void reEnablingStockRuleChecksCaps() {
        AlertStore store = mock(AlertStore.class);
        AlertStore.Rule disabled = new AlertStore.Rule(9, PRO.id(), "FOREIGN_STREAK",
                MAPPER.createObjectNode().put("target", "STOCK").put("code", "000660").put("n", 5), false,
                java.time.Instant.now());
        when(store.rules(PRO.id())).thenReturn(List.of(disabled));
        when(store.countStockCodes(null)).thenReturn(60);
        when(store.hasStockCode("000660")).thenReturn(false);
        AlertService service = new AlertService(store, MAPPER);

        AlertService.Result result = service.setEnabled(PRO, 9, true);

        assertThat(result.status()).isEqualTo(400);
        assertThat(result.message()).contains("수집 범위");
        verify(store, never()).setEnabled(anyLong(), anyLong(), org.mockito.ArgumentMatchers.anyBoolean());
    }

    @Test
    @DisplayName("QA-062 이미 켜 둔 종목의 다른 규칙은 사용자 상한(20종목)을 채운 상태에서도 켤 수 있다 — 종목 수가 늘지 않으므로")
    void reEnablingRuleForAlreadyWatchedCodeIsAllowedAtUserCap() {
        AlertStore store = mock(AlertStore.class);
        AlertStore.Rule watching = new AlertStore.Rule(1, PRO.id(), "FOREIGN_STREAK",
                MAPPER.createObjectNode().put("target", "STOCK").put("code", "000660").put("n", 5), true,
                java.time.Instant.now());
        AlertStore.Rule disabled = new AlertStore.Rule(9, PRO.id(), "FOREIGN_STREAK",
                MAPPER.createObjectNode().put("target", "STOCK").put("code", "000660").put("n", 10), false,
                java.time.Instant.now());
        when(store.rules(PRO.id())).thenReturn(List.of(watching, disabled));
        when(store.countStockCodes(PRO.id())).thenReturn(20);
        when(store.countStockCodes(null)).thenReturn(30);
        when(store.hasStockCode("000660")).thenReturn(true);
        when(store.setEnabled(9, PRO.id(), true)).thenReturn(1);
        AlertService service = new AlertService(store, MAPPER);

        assertThat(service.setEnabled(PRO, 9, true).status()).isEqualTo(200);
    }

    @Test
    @DisplayName("QA-091 무료 등급은 꺼 둔 유료 종류 규칙을 다시 켤 수 없다 — 만들 때와 같은 403(국면 전환은 켜고, 끄기는 언제나)")
    void freeTierCannotReEnablePaidKinds() {
        AlertStore store = mock(AlertStore.class);
        AlertStore.Rule institution = new AlertStore.Rule(9, FREE.id(), "INSTITUTION_NEW",
                MAPPER.createObjectNode().put("cik", "0001067983"), false, java.time.Instant.now());
        AlertStore.Rule market = new AlertStore.Rule(10, FREE.id(), "FOREIGN_STREAK",
                MAPPER.createObjectNode().put("target", "KOSPI").put("n", 5), false, java.time.Instant.now());
        AlertStore.Rule regime = new AlertStore.Rule(11, FREE.id(), "REGIME_CHANGE",
                MAPPER.createObjectNode(), false, java.time.Instant.now());
        when(store.rules(FREE.id())).thenReturn(List.of(institution, market, regime));
        when(store.setEnabled(anyLong(), anyLong(), anyBoolean())).thenReturn(1);
        AlertService service = new AlertService(store, MAPPER);

        AlertService.Result reEnabled = service.setEnabled(FREE, 9, true);
        assertThat(reEnabled.status()).isEqualTo(403);
        assertThat(reEnabled.message()).contains("무료 등급은 국면 전환 알림만");
        assertThat(service.setEnabled(FREE, 10, true).status()).isEqualTo(403);
        verify(store, never()).setEnabled(9, FREE.id(), true);
        verify(store, never()).setEnabled(10, FREE.id(), true);

        assertThat(service.setEnabled(FREE, 11, true).status()).as("국면 전환은 무료 등급도 켬").isEqualTo(200);
        assertThat(service.setEnabled(FREE, 9, false).status()).as("끄기는 등급과 무관").isEqualTo(200);
    }

    @Test
    @DisplayName("QA-064 종목의 지난 기록도 저녁 확정 칸이 비면 확정이 아니다 — 그날은 '모름'으로 연속을 끊는다")
    void incompletePastStockRecordBreaksStreak() {
        LocalDate today = LocalDate.of(2026, 10, 9);
        FlowRecord.Amounts plus = new FlowRecord.Amounts(10L, 5L, 5L);
        // 장중에 한 번 받고 레이더 대상에서 빠져 다시 받지 않은 기록(개인 칸이 빔) — 실제 저장본에 62개 있었다
        FlowRecord intradayOnly = new FlowRecord("2026-10-07", null,
                Map.of("foreigner", plus, "institution", plus), Map.of("pensionFund", plus), 0.5);
        FlowRecord complete6 = complete("2026-10-06", plus);
        FlowRecord complete8 = complete("2026-10-08", plus);

        List<AlertRules.DayNet> days = AlertEvaluator.finalizedForeignNet(
                List.of(complete8, intradayOnly, complete6), today, true, null);

        assertThat(days).extracting(AlertRules.DayNet::date).containsExactly(
                LocalDate.of(2026, 10, 6), LocalDate.of(2026, 10, 7), LocalDate.of(2026, 10, 8));
        assertThat(days.get(1).net()).as("장중 잠정치는 확정치가 아니다").isNull();
    }

    private static FlowRecord complete(String date, FlowRecord.Amounts amounts) {
        return new FlowRecord(date, null,
                Map.of("foreigner", amounts, "individual", amounts, "otherCorporation", amounts),
                Map.of("pensionFund", amounts), 0.5);
    }

    @Test
    @DisplayName("확정 기록만 — 시장은 오늘 기록을 빼고, 종목은 저녁 확정 칸이 모두 찬 오늘 기록만 쓴다")
    void finalizedRecordsOnly() {
        LocalDate today = LocalDate.of(2026, 10, 9);
        FlowRecord.Amounts plus = new FlowRecord.Amounts(10L, 5L, 5L);
        FlowRecord yesterday = new FlowRecord("2026-10-08", null, Map.of("foreigner", plus), Map.of(), null);
        FlowRecord todayPartial = new FlowRecord("2026-10-09", null, Map.of("foreigner", plus), Map.of(), null);
        FlowRecord todayComplete = new FlowRecord("2026-10-09", null,
                Map.of("foreigner", plus, "individual", plus, "otherCorporation", plus),
                Map.of("pensionFund", plus), 0.5);

        assertThat(AlertEvaluator.finalizedForeignNet(List.of(todayPartial, yesterday), today, false, today))
                .extracting(AlertRules.DayNet::date).containsExactly(LocalDate.of(2026, 10, 8));
        assertThat(AlertEvaluator.finalizedForeignNet(List.of(todayPartial, yesterday), today, false,
                LocalDate.of(2026, 10, 8))).as("시장 저장본을 어제(장중) 받았으면 어제 기록도 확정이 아님(QA-040)").isEmpty();
        assertThat(AlertEvaluator.finalizedForeignNet(List.of(todayPartial, yesterday), today, true, null))
                .as("종목도 잠정 칸이 비면 제외").hasSize(1);
        assertThat(AlertEvaluator.finalizedForeignNet(List.of(todayComplete, yesterday), today, true, null)).hasSize(2);
    }

    @Test
    @DisplayName("알림 문구에 매수·매도 같은 행동 지시가 없다(근거·기준일·한계만)")
    void noActionWords() {
        List<String> bodies = List.of(
                AlertText.regime(new AlertRules.RegimeChange(LocalDate.of(2026, 10, 9), LocalDate.of(2026, 10, 7),
                        "EXPANSION", "확장 (Expansion)", "LATE", "후퇴 경계 (Late cycle)"), Map.of(), 2).body(),
                AlertText.foreignStreak("코스피", false, new AlertRules.StreakHit(LocalDate.of(2026, 10, 9), 5),
                        1_234_000_000_000L).body(),
                AlertText.institutionNew("버크셔", "2026-06-30", "2026-08-14",
                        List.of(new Holding("NVIDIA CORP", "x", "COM", 1.0, 1.0, 2.5))).body());
        for (String body : bodies) {
            for (String banned : List.of("매수하세요", "매도하세요", "사세요", "파세요", "추천", "목표가", "비중을 늘", "비중을 줄")) {
                assertThat(body).doesNotContain(banned);
            }
            assertThat(body).contains("투자 권유가 아닙니다");
        }
        assertThat(bodies.get(0)).as("국면 알림의 끝줄은 화면 이름만 — 그림 문자 없이")
                .endsWith(AlertText.DISCLAIMER + " (시장 국면)");
        assertThat(AlertText.won(1_234_000_000_000L)).isEqualTo("+1.23조 원");
        assertThat(AlertText.won(-5_600_000_000L)).isEqualTo("-56.0억 원");
    }
}
