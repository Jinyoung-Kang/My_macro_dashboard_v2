package com.macrodash.feature.paper;

import com.macrodash.store.PaperStore.Decision;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.List;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 한국 Claude 계좌2 출발 패킷({@link KrClaude2Start} — 사용자 결정 2026-11-02): 계좌1 출발 패킷의 계좌 코드 세 곳과 출발 문장만 바뀌고 나머지는 글자 그대로,
 * 자리 수가 다르면 거절.
 */
class KrClaude2StartTest {

    private static final LocalDate S = LocalDate.of(2026, 10, 30);
    private static final String START_LINE = "이번은 출발 결정이다(기준일 2026-10-30) — 통과한 주문은 다음 KRX 거래일 시가에 네 계좌가 함께 체결된다(사후 체결 "
            + "없음). 장부는 출발 현금뿐이다.";

    private static Decision source(String text) {
        return new Decision(13, PaperBooks.KR_CLAUDE, S, RuleBookService.INITIAL, null, "OK", "claude-test", 5, 9, null, 40.0,
                null, null, null, MAPPER.createObjectNode(), null, null, List.of(7L), true, null, 0, text);
    }

    private static String packet(String extra) {
        return "{\"0_instructions\":{\"lines\":[\"한국 책(kr_claude)이다 — 통화는 원(KRW).\",\"" + START_LINE + "\"]},"
                + "\"1_basis\":{\"packetVersion\":6,\"book\":\"kr_claude\",\"asOfTradingDate\":\"2026-10-30\"},"
                + "\"8_prices\":{\"rows\":[[\"005930\",70000]]},"
                + "\"9_portfolio\":{\"book\":\"kr_claude\",\"status\":\"NOT_STARTED\"}" + extra + "}";
    }

    @Test
    @DisplayName("계좌 코드 세 곳(지시 한 줄·1_basis·9_portfolio)과 출발 문장만 바꾸고 나머지는 그대로 — 해시는 바꾼 글의 것, 메모 번호는 계좌1 결정의 것")
    void rewritesOnlyTheBookParts() {
        String text = packet("");
        PacketBuilder.Packet packet = KrClaude2Start.packet(source(text), S, MAPPER);

        assertThat(packet.text()).contains("한국 책(kr_claude2)이다").doesNotContain("\"kr_claude\"").doesNotContain(START_LINE)
                .contains("기준일 2026-10-30 종가(금융위 확정 종가)로 사후 체결된다");
        assertThat(packet.body().path("1_basis").path("book").asString()).isEqualTo("kr_claude2");
        assertThat(packet.body().path("9_portfolio").path("book").asString()).isEqualTo("kr_claude2");
        assertThat(packet.body().path("8_prices")).isEqualTo(MAPPER.readTree(text).path("8_prices"));
        assertThat(packet.sha256()).isEqualTo(PacketBuilder.sha256(packet.text()));
        assertThat(packet.noteIds()).containsExactly(7L);
        assertThat(packet.text().replace("kr_claude2", "kr_claude").replace(
                packet.body().path("0_instructions").path("lines").get(1).asString(), START_LINE)).isEqualTo(text);
    }

    @Test
    @DisplayName("계좌 코드 자리가 셋이 아니거나 출발 문장이 없으면 거절(패킷 모양이 바뀐 뒤의 오용 방지)")
    void refusesUnexpectedShapes() {
        assertThatThrownBy(() -> KrClaude2Start.packet(source(packet(",\"note\":\"kr_claude\"")), S, MAPPER))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("4곳");
        assertThatThrownBy(() -> KrClaude2Start.packet(source(packet("").replace(START_LINE, "다른 문장")), S, MAPPER))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("출발 문장");
        assertThatThrownBy(() -> KrClaude2Start.packet(source(null), S, MAPPER))
                .isInstanceOf(InvalidRequestException.class).hasMessageContaining("패킷 글이 없습니다");
    }
}
