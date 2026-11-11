package com.macrodash.feature.realtrade;

import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.store.RealTradeStore;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 실제 매매 텔레그램 글({@link RealTradeNotices}, 명세 2026-11-06 §7.4 — 건수·상태만) — 이벤트 detail에 종목·수량·금액·주문 번호가 들어 있어도 글에는 고정
 * 문구·상태·건수·사유 코드만 나갑니다. 값은 합성입니다.
 */
class RealTradeNoticesTest {

    /** detail에 일부러 섞는 민감 값 — 글에 나오면 안 됨. */
    private static final Map<String, Object> SENSITIVE = Map.of("symbol", "005930", "quantity", 37, "amount", 1234567,
            "orderId", "TOSS-ORDER-1", "accountSeq", "99887766", "price", "70000");

    /** 표시를 뗀 글 — 서식 자체는 {@code markdownShape}가 봅니다. */
    private static String text(RealTradeStore.Event event) {
        String text = RealTradeNotices.text(event);
        return text == null ? null : PaperTelegram.plain(text);
    }

    private static RealTradeStore.Event event(String kind, Map<String, Object> detail) {
        Map<String, Object> all = new LinkedHashMap<>(SENSITIVE);
        all.putAll(detail);
        JsonNode node = RealTradeFixtures.MAPPER.valueToTree(all);
        return new RealTradeStore.Event(1, "KR", Instant.EPOCH, kind, null, node, true, null);
    }

    @Test
    @DisplayName("종류마다 고정 문구 + 상태 + 건수 + 사유 코드 — 종목·수량·금액·주문 번호·계좌 값 없음, 이모지 없음")
    void texts() {
        Map<String, String> expected = new LinkedHashMap<>();
        expected.put("HALT", "[실제 매매] 멈춤\n\n사유: unknown-order");
        expected.put("BUYS_PAUSED", "[실제 매매] 매수 멈춤\n\n사유: unknown-order");
        expected.put("SKIP_DAY", "[실제 매매] 오늘 쉼\n\n사유: unknown-order");
        expected.put("ENABLE", "[실제 매매] 켜짐\n\n다음 맞추기부터 따라 합니다");
        expected.put("DISABLE", "[실제 매매] 끄기\n\n새 주문 멈춤 · 미체결 취소 중");
        expected.put("UPDATE", "[실제 매매] 설정 바뀜");
        expected.put("RESUME", "[실제 매매] 멈춤 해제");
        expected.put("RESTORED", "[실제 매매] 복원 뒤 멈춤\n\n사유: restored");
        for (Map.Entry<String, String> e : expected.entrySet()) {
            assertThat(text(event(e.getKey(), Map.of("reason", "unknown-order")))).as(e.getKey()).isEqualTo(e.getValue());
        }
        assertThat(text(event("WINDOW_SUMMARY", Map.of("window", "NEXT_CLOSE", "accepted", 2, "filled", 1, "missed", 1,
                "skipped", 0, "blocked", 1, "deferred", 0, "reasons", Map.of("opposite-pending", 1)))))
                .isEqualTo("[실제 매매] 종가 따라 하기\n\n접수 2 · 체결 1 · 놓침 1\n건너뜀 0 · 막힘 1 · 미룸 0");
        assertThat(text(event("STOPPED", Map.of("unresolved", 2))))
                .isEqualTo("[실제 매매] 꺼짐\n\n취소로 끝남 0 · 체결로 끝남 0\n확인 필요 2건");
        assertThat(text(event("STOPPED", Map.of("canceled", 3, "filled", 1, "other", 1, "unresolved", 0))))
                .as("끈 뒤 끝난 방식을 나눠 — '정리 끝'으로 단정하지 않음").isEqualTo("[실제 매매] 꺼짐\n\n취소로 끝남 3 · 체결로 끝남 1 · 그 밖 1");
        assertThat(text(event("CANCEL_GAVE_UP", Map.of("count", 2))))
                .isEqualTo("[실제 매매] 취소 못 함\n\n2건 — 토스증권 앱에서 직접 취소하세요");
        assertThat(text(event("PASSWORD_FAILED", Map.of("consecutive", 5, "locked", true))))
                .isEqualTo("[실제 매매] 비밀번호 틀림\n\n연속 5회 · 30분 잠금");
        assertThat(text(event("SKIPPED", Map.of("reason", "opposite-pending", "count", 2))))
                .isEqualTo("[실제 매매] 건너뜀\n\n사유: opposite-pending · 2건");
        assertThat(text(event("STOP_SELL", Map.of("sent", 2, "blocked", 1, "missed", 0))))
                .as("장중 스탑 매도(ADR 0033) — 건수만").isEqualTo("[실제 매매] 스탑 매도\n\n보냄 2 · 막힘 1 · 놓침 0");
        assertThat(text(event("UNAVAILABLE", Map.of("reason", "calendar-unavailable"))))
                .as("QA-342 — 개장이 가깝도록 장 운영 정보·수집기 상태를 못 받음(사유 코드만)")
                .isEqualTo("[실제 매매] 준비 안 됨\n\n사유: calendar-unavailable\n개장이 가까운데 주문을 낼 준비가 안 됐습니다. 받는 대로 이어서 따라 합니다");
        assertThat(text(event("SKIP_DAY", Map.of("reason", "market-closed", "paperOpen", true))))
                .as("QA-342 — 토스만 휴장이라 답한 날").isEqualTo("[실제 매매] 오늘 쉼\n\n사유: market-closed\n모의 달력은 거래일입니다. 토스 장 운영 정보를 확인하세요");
        assertThat(text(event("WINDOW_SUMMARY", Map.of("window", "SYNC_AT", "accepted", 3))))
                .isEqualTo("[실제 매매] 개장 10분 뒤 맞추기\n\n접수 3 · 체결 0 · 놓침 0\n건너뜀 0 · 막힘 0 · 미룸 0");

        for (String kind : List.of("HALT", "WINDOW_SUMMARY", "SKIPPED", "PASSWORD_FAILED", "STOPPED", "CANCEL_GAVE_UP", "SKIP_DAY", "ENABLE",
                "STOP_SELL", "RESTRICTED", "UNAVAILABLE", "SOMETHING_NEW")) {
            String text = text(event(kind, Map.of("reason", "x")));
            assertThat(text).as(kind).isNotNull().doesNotContain("005930", "37주", "1234567", "1,234,567", "TOSS-ORDER-1", "99887766", "70000");
            assertThat(text.codePoints().noneMatch(cp -> Character.getType(cp) == Character.OTHER_SYMBOL)).as(kind + " 이모지 없음").isTrue();
        }
    }

    @Test
    @DisplayName("사유 코드가 코드 모양이 아니면(토스 오류 문구 등) 'unknown', 건수가 정수가 아니면 0")
    void sanitizes() {
        assertThat(text(event("HALT", Map.of("reason", "토스 오류 문구 <script>"))))
                .isEqualTo("[실제 매매] 멈춤\n\n사유: unknown");
        assertThat(text(event("WINDOW_SUMMARY", Map.of("window", "SYNC", "accepted", "5개", "filled", 2.5))))
                .isEqualTo("[실제 매매] 시가 맞추기\n\n접수 0 · 체결 0 · 놓침 0\n건너뜀 0 · 막힘 0 · 미룸 0");
        assertThat(text(new RealTradeStore.Event(1, "KR", Instant.EPOCH, "bad kind", null, null, true, null))).isNull();
    }

    @Test
    @DisplayName("서식 — 제목은 MarkdownV2 굵은 글씨, 사유 코드의 하이픈은 이스케이프")
    void markdownShape() {
        assertThat(RealTradeNotices.text(event("HALT", Map.of("reason", "unknown-order")))).isEqualTo("*\\[실제 매매\\] 멈춤*\n\n사유: unknown\\-order");
    }
}
