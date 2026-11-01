package com.macrodash.feature.paper;

import com.macrodash.store.PaperStore.Decision;
import com.macrodash.support.InvalidRequestException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.LocalDate;

/**
 * 한국 Claude 계좌2의 출발 패킷(사용자 결정 2026-11-02) — 한국 Claude 계좌1의 출발 결정(INITIAL)이 보낸 패킷을 그대로 쓰고, 계좌 몫 세 곳과 출발
 * 문장만 바꿉니다: {@code 0_instructions}의 '한국 책(kr_claude)이다', {@code 1_basis.book}, {@code 9_portfolio.book}(출발 결정의 장부는 두 계좌 모두 출발
 * 현금뿐이라 그 밖의 계좌 몫은 같음), 그리고 '다음 KRX 거래일 시가에 네 계좌가 함께 체결(사후 체결 없음)' 문장을 '출발일 종가(금융위 확정 종가)로 사후
 * 체결'로. 시장 자료(가격·수급·재무·국면·일정·사건·메모)는 계좌1이 출발일 밤에 읽은 그대로입니다 — 그 뒤 수집된 자료가 끼지 않게(입력 동결, 미국
 * 계좌2와 같은 원칙). 바꿀 자리가 정해진 수만큼 있지 않으면 짐작하지 않고 거절합니다(패킷 모양이 바뀐 뒤의 오용 방지).
 */
final class KrClaude2Start {

    private KrClaude2Start() {
    }

    /** 계좌1 패킷에서 계좌 코드가 나오는 자리 수(지시 한 줄·1_basis·9_portfolio). */
    static final int BOOK_MENTIONS = 3;

    /**
     * 계좌1 출발 패킷 → 계좌2 출발 패킷(글).
     *
     * @throws InvalidRequestException 패킷 글이 없음·계좌 코드 자리 수가 다름·출발 문장이 없음
     */
    static String packetText(Decision source, LocalDate start) {
        String text = source.packetText();
        if (text == null || text.isBlank()) {
            throw new InvalidRequestException("한국 Claude 계좌1 출발 결정 " + source.id() + "에 패킷 글이 없습니다");
        }
        String quoted = "\"" + PaperBooks.KR_CLAUDE + "\"";
        String inLine = "(" + PaperBooks.KR_CLAUDE + ")";
        int quotedCount = count(text, quoted);
        int lineCount = count(text, inLine);
        if (quotedCount + lineCount != BOOK_MENTIONS || count(text, PaperBooks.KR_CLAUDE) != BOOK_MENTIONS) {
            throw new InvalidRequestException("계좌1 출발 패킷의 계좌 코드 자리가 " + count(text, PaperBooks.KR_CLAUDE) + "곳입니다(기대 "
                    + BOOK_MENTIONS + ") — 패킷 모양이 달라 계좌2 패킷을 만들지 않았습니다");
        }
        String oldStart = "이번은 출발 결정이다(기준일 " + start + ") — 통과한 주문은 다음 KRX 거래일 시가에 네 계좌가 함께 체결된다(사후 체결 "
                + "없음). 장부는 출발 현금뿐이다.";
        if (count(text, oldStart) != 1) {
            throw new InvalidRequestException("계좌1 출발 패킷에 출발 문장(기준일 " + start + ")이 한 번 있어야 합니다 — 계좌2 패킷을 만들지 않았습니다");
        }
        String newStart = "이번은 출발 결정이다(기준일 " + start + ") — 통과한 주문은 기준일 " + start + " 종가(금융위 확정 종가)로 사후 체결된다"
                + "(사용자 결정 2026-11-02 — 한국 Claude 계좌1과 같은 자료, 계좌1의 결정은 넣지 않음). 장부는 출발 현금뿐이다.";
        return text.replace(quoted, "\"" + PaperBooks.KR_CLAUDE2 + "\"")
                .replace(inLine, "(" + PaperBooks.KR_CLAUDE2 + ")")
                .replace(oldStart, newStart);
    }

    /** 계좌2 출발 패킷({@link #packetText}) — 본문은 그 글을 다시 읽은 것, 해시는 그 글의 것, 메모는 계좌1 결정의 메모 번호. */
    static PacketBuilder.Packet packet(Decision source, LocalDate start, ObjectMapper mapper) {
        String text = packetText(source, start);
        JsonNode body;
        try {
            body = mapper.readTree(text);
        } catch (RuntimeException e) {
            throw new IllegalStateException("계좌2 출발 패킷을 다시 읽지 못했습니다", e);
        }
        return new PacketBuilder.Packet(body, text, PacketBuilder.sha256(text), source.noteIds(), null);
    }

    private static int count(String text, String part) {
        int n = 0;
        for (int at = text.indexOf(part); at >= 0; at = text.indexOf(part, at + part.length())) {
            n++;
        }
        return n;
    }
}
