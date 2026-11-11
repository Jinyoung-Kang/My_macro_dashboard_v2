package com.macrodash.feature.realtrade;

import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Instruction;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.time.LocalDate;
import java.time.LocalTime;
import java.util.List;
import java.util.Map;

import static com.macrodash.feature.realtrade.RealTradeFixtures.MAPPER;
import static com.macrodash.feature.realtrade.RealTradeFixtures.d;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * ISA 계좌 지시 알림 글({@link ManualAccountNotices}, ADR 0029 결정 4·0034): 제목·줄마다 방향·종목 코드·이름·수량·끝 안내, 금액·평가액·현금·기준가
 * 글자가 없음, 이름 엔티티, 장 시간 변경일의 장전 동시호가. 종목·금액은 합성 값입니다.
 */
class ManualAccountNoticesTest {

    private static final LocalDate MONDAY = LocalDate.of(2026, 11, 9);
    private static final String CONFIRM = "매매했으면 ISA 계좌 탭에서 '확인'을 누르세요 — 체결 값이 다르면 매매 내역의 '고치기'로 고치세요.";

    private static Instruction instruction(long id, String symbol, String side, int quantity, String refPrice, String weight) {
        ObjectNode reason = MAPPER.createObjectNode();
        reason.put("equity", 98_765_432);
        reason.put("targetWeightPct", weight);
        return new Instruction(id, "isa", MONDAY, symbol, side, quantity, d(refPrice), d(weight), reason, "PLANNED", null, null, null, null, null, null, null);
    }

    private static String plain(String markdown) {
        return markdown == null ? null : PaperTelegram.plain(markdown);
    }

    private static String text(LocalDate session, LocalTime open, LocalTime at, List<Instruction> items, Map<String, String> names) {
        return plain(ManualAccountNotices.text(session, open, at, items, names));
    }

    private static String stop(LocalDate session, LocalTime open, LocalTime close, List<ManualAccountStore.StopInstruction> items, Map<String, String> names) {
        return plain(ManualAccountNotices.stop(session, open, close, items, names));
    }

    private static String reminder(LocalDate session, boolean preclose, List<ManualAccountNotices.ReminderLine> items, Map<String, String> names) {
        return plain(ManualAccountNotices.reminder(session, preclose, items, names));
    }

    @Test
    @DisplayName("아침 글 — 제목 '[ISA 계좌] 11/09(월) 시가 매매 지시', 줄마다 '매도 코드 이름 n주', 끝 안내. 금액·평가액·현금·기준가 글자는 없음")
    void textHasSymbolsAndQuantitiesOnly() {
        String text = text(MONDAY, LocalTime.of(9, 0), null, List.of(
                instruction(1, "307950", "SELL", 3, "123457", "4.5678"),
                instruction(2, "153130", "BUY", 1, "108765", "12.3456")), Map.of("307950", "합성오토", "153130", "합성 단기채권"));

        assertThat(text).isEqualTo("[ISA 계좌] 11/09(월) 시가 매매 지시\n\n"
                + "• 매도 307950 합성오토 3주\n"
                + "• 매수 153130 합성 단기채권 1주\n\n"
                + "장전 동시호가(08:30~09:00)에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다.\n" + CONFIRM);
        assertThat(text).doesNotContain("원", "123457", "123,457", "108765", "98765432", "98,765,432", "4.5678", "12.3456", "%", "평가",
                "현금", "금액");
    }

    @Test
    @DisplayName("이름을 모르면 코드만, 이름의 특수 글자는 그대로 보이게, 코드 모양이 아니거나 수량이 0 이하인 행은 뺌, 장 시간 변경일(10:00 개장)은 09:30~10:00")
    void namesEscapingAndShiftedOpen() {
        String text = text(MONDAY, LocalTime.of(10, 0), null, List.of(
                instruction(1, "005930", "BUY", 2, "1", "1"),
                instruction(2, "000660", "BUY", 1, "1", "1"),
                instruction(3, "ABC", "BUY", 1, "1", "1"),
                instruction(4, "035420", "SELL", 0, "1", "1")), Map.of("000660", "A&B<C>"));

        assertThat(text).contains("• 매수 005930 2주\n").contains("• 매수 000660 A&B<C> 1주\n").contains("장전 동시호가(09:30~10:00)")
                .doesNotContain("ABC").doesNotContain("035420");
        assertThat(text(MONDAY, null, null, List.of(), Map.of())).contains("(08:30~09:00)");
    }

    @Test
    @DisplayName("시각 맞추기 지시(ADR 0033) — 제목 '11/09(월) 09:10 매매 지시', 끝줄 '09:10 이후 시장가'·장중 스탑 따로 알림, 금액 없음")
    void timedSyncText() {
        String text = text(MONDAY, LocalTime.of(9, 0), LocalTime.of(9, 10),
                List.of(instruction(1, "307950", "SELL", 3, "123457", "4.5")), Map.of("307950", "합성오토"));

        assertThat(text).isEqualTo("[ISA 계좌] 11/09(월) 09:10 매매 지시\n\n"
                + "• 매도 307950 합성오토 3주\n\n"
                + "09:10 이후 시장가로 내면 규칙 계좌와 같은 때(09:10)에 체결됩니다.\n그때 서킷브레이커·VI가 걸려 있으면 풀린 뒤 시장가로 내세요.\n장중 스탑이 걸리면 따로 알립니다.\n" + CONFIRM);
        assertThat(text).doesNotContain("원", "123457", "4.5", "장전 동시호가");
    }

    private static ManualAccountStore.StopInstruction stop(long id, String symbol, int quantity, String timing) {
        return new ManualAccountStore.StopInstruction(id, "isa", MONDAY, 100 + id, symbol, "SELL", quantity, timing, java.time.Instant.EPOCH,
                MAPPER.createObjectNode().put("stopPrice", 91_234).put("observedPrice", 90_111), "PLANNED", null, null, null, null, null);
    }

    @Test
    @DisplayName("QA-353 매매 뒤 안내 — 체결 값이 다르면 잔고가 아니라 매매 내역의 '고치기'(잔고의 가격 고치기는 현금·실현 손익을 못 맞춤), 금액 없음")
    void confirmGuidePointsToTradeEdit() {
        String text = stop(MONDAY, LocalTime.of(9, 0), LocalTime.of(15, 30), List.of(stop(1, "307950", 3, "MARKET")), Map.of("307950", "합성오토"));
        assertThat(text).contains("매매 내역의 '고치기'");
        assertThat(text).doesNotContain("잔고에서 고치세요", "원");
    }

    @Test
    @DisplayName("스탑 매도 지시 글 — 장중은 '지금 시장가'(개장 10분 전이면 09:10 이후), 종가 STOP은 '종가 단일가(15:20~15:30)', 수능일형은 그날 시각, 금액·기준가 없음")
    void stopTexts() {
        String text = stop(MONDAY, LocalTime.of(9, 0), LocalTime.of(15, 30),
                List.of(stop(1, "307950", 3, "MARKET"), stop(2, "005930", 7, "NEXT_CLOSE")), Map.of("307950", "합성오토"));
        assertThat(text).isEqualTo("[ISA 계좌] 11/09(월) 스탑 매도 지시\n\n"
                + "• 매도 307950 합성오토 3주\n"
                + "규칙 계좌가 트레일링 스탑으로 팔았습니다 — 지금 시장가로 매도하세요(개장 10분 전이면 09:10 이후).\n\n"
                + "• 매도 005930 7주\n"
                + "규칙 계좌가 트레일링 스탑으로 오늘 종가에 팝니다 — 종가 단일가(15:20~15:30)에 시장가로 매도하세요.\n\n"
                + CONFIRM);
        assertThat(text).doesNotContain("원", "91234", "91,234", "90111");
        assertThat(stop(MONDAY, LocalTime.of(10, 0), LocalTime.of(16, 30), List.of(stop(3, "005930", 1, "NEXT_CLOSE")),
                Map.of())).contains("종가 단일가(16:20~16:30)");
        assertThat(stop(MONDAY, LocalTime.of(10, 0), LocalTime.of(16, 30), List.of(stop(4, "005930", 1, "AT_MINUTE")),
                Map.of())).contains("10:10 이후");
    }

    @Test
    @DisplayName("확인 알림 글 — 장 중반은 '매매 확인', 마감 전은 '마감 전 매매 확인', 줄마다 방향·코드·이름·수량, 할 일. 금액 글자 없음, 보일 줄이 없으면 null")
    void reminderHasSymbolsAndQuantitiesOnly() {
        String midday = reminder(MONDAY, false, List.of(new ManualAccountNotices.ReminderLine("SELL", "307950", 3),
                new ManualAccountNotices.ReminderLine("BUY", "153130", 1)), Map.of("307950", "합성 & 오토"));
        assertThat(midday).isEqualTo("[ISA 계좌] 11/09(월) 매매 확인\n\n"
                + "장 중반까지 '확인'을 누르지 않은 지시입니다.\n\n"
                + "• 매도 307950 합성 & 오토 3주\n"
                + "• 매수 153130 1주\n\n"
                + "아직 안 했으면 지금 시장가로 내세요.\n이미 했으면 ISA 계좌 탭에서 '확인'을 누르세요(이 시스템은 실제 매매를 볼 수 없습니다).");
        assertThat(midday).doesNotContain("원");
        assertThat(reminder(MONDAY, true, List.of(new ManualAccountNotices.ReminderLine("SELL", "307950", 3)), Map.of()))
                .startsWith("[ISA 계좌] 11/09(월) 마감 전 매매 확인\n\n마감 30분 전까지 '확인'을 누르지 않은 지시입니다.");
        assertThat(reminder(MONDAY, false, List.of(new ManualAccountNotices.ReminderLine("BUY", "XX", 1)), Map.of())).isNull();
    }

    @Test
    @DisplayName("QA-381 현금이 음수라 지시를 만들지 않은 세션의 글 — 제목 '매매 지시 없음', 잔고 확인·개장 전에 고치면 다시 알림·스탑은 그대로. 금액·종목·숫자 글자 없음")
    void cashNegativeTextHasNoAmounts() {
        String text = plain(ManualAccountNotices.cashNegative(MONDAY));
        assertThat(text).isEqualTo("[ISA 계좌] 11/09(월) 매매 지시 없음\n\n"
                + "ISA 잔고의 현금이 음수라 이 세션의 매매 지시를 만들지 않았습니다.\n"
                + "ISA 계좌 탭에서 잔고(현금·보유)를 확인해 고치세요 — 개장 전에 고치면(반영에 10분쯤 걸림) 지시를 만들어 다시 알립니다.\n"
                + "전날 종가 기준 손절의 시가 매도도 이 지시에 들어 있어 함께 멈춥니다. 장중 스탑 매도 지시(장중에 감지되는 것)만 그대로 알립니다.");
        assertThat(text.substring(text.indexOf('\n'))).doesNotContain("원", "%", "주\n", "•").doesNotContainPattern("[0-9]{3,}");   // 본문의 숫자는 '10분쯤'뿐
    }
}
