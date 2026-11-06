package com.macrodash.feature.realtrade;

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
 * ISA 계좌 지시 알림 글({@link ManualAccountNotices}, ADR 0029 결정 4 — 명세 §4): 제목·줄마다 방향·종목 코드·이름·수량·끝 안내, <b>금액·평가액·현금·기준가
 * 글자가 없음</b>, 이름 엔티티, 장 시간 변경일의 장전 동시호가. 종목·금액은 합성 값입니다.
 */
class ManualAccountNoticesTest {

    private static final LocalDate MONDAY = LocalDate.of(2026, 11, 9);

    private static Instruction instruction(long id, String symbol, String side, int quantity, String refPrice, String weight) {
        ObjectNode reason = MAPPER.createObjectNode();
        reason.put("equity", 98_765_432);
        reason.put("targetWeightPct", weight);
        return new Instruction(id, "isa", MONDAY, symbol, side, quantity, d(refPrice), d(weight), reason, "PLANNED", null, null, null, null);
    }

    @Test
    @DisplayName("밤·아침 글 — 제목 '[ISA 계좌] 11/09(월) 시가 매매 지시', 줄마다 '매도 코드 이름 n주', 끝 안내. 금액·평가액·현금·기준가 글자는 없음")
    void textHasSymbolsAndQuantitiesOnly() {
        String text = ManualAccountNotices.text(MONDAY, LocalTime.of(9, 0), List.of(
                instruction(1, "307950", "SELL", 3, "123457", "4.5678"),
                instruction(2, "153130", "BUY", 1, "108765", "12.3456")), Map.of("307950", "합성오토", "153130", "합성 단기채권"));

        assertThat(text).isEqualTo("<b>[ISA 계좌] 11/09(월) 시가 매매 지시</b>\n"
                + "매도 307950 합성오토 3주\n"
                + "매수 153130 합성 단기채권 1주\n"
                + "장전 동시호가(08:30~09:00)에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다. 다르게 매매했으면 화면에서 고치세요.");
        assertThat(text).doesNotContain("원", "123457", "123,457", "108765", "98765432", "98,765,432", "4.5678", "12.3456", "%", "평가",
                "현금", "금액");
    }

    @Test
    @DisplayName("이름을 모르면 코드만, 이름의 &·<·>는 엔티티로, 코드 모양이 아니거나 수량이 0 이하인 행은 뺌, 장 시간 변경일(10:00 개장)은 09:30~10:00")
    void namesEscapingAndShiftedOpen() {
        String text = ManualAccountNotices.text(MONDAY, LocalTime.of(10, 0), List.of(
                instruction(1, "005930", "BUY", 2, "1", "1"),
                instruction(2, "000660", "BUY", 1, "1", "1"),
                instruction(3, "ABC", "BUY", 1, "1", "1"),
                instruction(4, "035420", "SELL", 0, "1", "1")), Map.of("000660", "A&B<C>"));

        assertThat(text).contains("\n매수 005930 2주\n").contains("\n매수 000660 A&amp;B&lt;C&gt; 1주\n").contains("장전 동시호가(09:30~10:00)")
                .doesNotContain("ABC").doesNotContain("035420");
        assertThat(ManualAccountNotices.text(MONDAY, null, List.of(), Map.of())).contains("(08:30~09:00)");
    }

    @Test
    @DisplayName("ISA-R4: 장부를 고쳐 다시 계산한 지시는 제목에 '(다시 계산)'과 앞서 보낸 지시 대신이라는 줄, 다시 계산해 지시가 없으면 그 뜻의 글 — 금액 없음")
    void recalculatedTexts() {
        String text = ManualAccountNotices.text(MONDAY, LocalTime.of(9, 0), List.of(instruction(1, "307950", "SELL", 3, "123457", "4.5")),
                Map.of("307950", "합성오토"), true);

        assertThat(text).isEqualTo("<b>[ISA 계좌] 11/09(월) 시가 매매 지시(다시 계산)</b>\n"
                + "장부가 바뀌어 다시 계산한 지시입니다 — 앞서 보낸 지시 대신 이 지시를 따르세요.\n"
                + "매도 307950 합성오토 3주\n"
                + "장전 동시호가(08:30~09:00)에 시장가로 내면 규칙 계좌와 같은 시가에 체결됩니다. 다르게 매매했으면 화면에서 고치세요.");
        assertThat(ManualAccountNotices.text(MONDAY, LocalTime.of(9, 0), List.of(), Map.of(), false))
                .isEqualTo(ManualAccountNotices.text(MONDAY, LocalTime.of(9, 0), List.of(), Map.of()));
        assertThat(ManualAccountNotices.noTrades(MONDAY)).isEqualTo("<b>[ISA 계좌] 11/09(월) 시가 매매 지시(다시 계산)</b>\n"
                + "장부가 바뀌어 다시 계산했더니 이 세션 시가에 할 매매가 없습니다 — 앞서 보낸 지시는 내지 마세요.");
    }

    @Test
    @DisplayName("시각 맞추기 지시(ADR 0033 초안) — 제목 '11/09(월) 09:10 매매 지시', 끝줄 '09:10 이후 시장가'·장중 스탑 따로 알림, 금액 없음")
    void timedSyncText() {
        String text = ManualAccountNotices.text(MONDAY, LocalTime.of(9, 0), LocalTime.of(9, 10),
                List.of(instruction(1, "307950", "SELL", 3, "123457", "4.5")), Map.of("307950", "합성오토"), false);

        assertThat(text).isEqualTo("<b>[ISA 계좌] 11/09(월) 09:10 매매 지시</b>\n"
                + "매도 307950 합성오토 3주\n"
                + "09:10 이후 시장가로 내면 규칙 계좌와 같은 때(09:10)에 체결됩니다. 장중 스탑이 걸리면 따로 알립니다. 다르게 매매했으면 화면에서 고치세요.");
        assertThat(text).doesNotContain("원", "123457", "4.5", "장전 동시호가");
        assertThat(ManualAccountNotices.text(MONDAY, LocalTime.of(10, 0), LocalTime.of(10, 10), List.of(), Map.of(), true))
                .startsWith("<b>[ISA 계좌] 11/09(월) 10:10 매매 지시(다시 계산)</b>").contains("10:10 이후 시장가");
        assertThat(ManualAccountNotices.text(MONDAY, LocalTime.of(9, 0), null, List.of(), Map.of(), false))
                .as("시각이 없으면 예전 시가 글 그대로").isEqualTo(ManualAccountNotices.text(MONDAY, LocalTime.of(9, 0), List.of(), Map.of(), false));
    }
}
