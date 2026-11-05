package com.macrodash.feature.paper;

import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.Objects;

/**
 * 장중 감시 저장본(미국·한국 — {@link PaperMarketData#watchUs()}·{@link PaperMarketData#watchKr()})이 어느 계획의 것인가 — 저장본이 실은 계획 신원과 계획 행 하나의 대조
 * (ADR 0027 결정 3, 명세 docs/specs/2026-11-05-free-fill-timing.md §7 '감시 저장본').
 *
 * <p>수집기는 지금 창 안인 계획 전부의 신원을 {@code checkpoints} 목록({@code {book, sessionDate, atEt|atKst, slot}} — 끈 판 장중 확인 행은
 * {@code slot} null, 켠 판 장중 판단 행은 1·2)으로 싣고, 가장 이른 것 하나를 예전 모양의 {@code checkpoint}로도 둡니다. 계획이 여럿이면 저장본 한
 * 장이 여러 계획의 것이므로, 읽는 쪽은 <b>자기 행의 신원이 목록에 있을 때만</b> 그 저장본을 씁니다. 목록이 없는 저장본(이 목록이 생기기 전에 받은
 * 것)은 {@code checkpoint} 하나를 순번 없는 신원으로 봅니다 — 끈 판 장중 확인 행만 맞을 수 있습니다.
 *
 * <p>상태가 없는 대조입니다. 받은 시각·나이는 부르는 쪽이 봅니다.
 */
final class WatchIdentity {

    private WatchIdentity() {
    }

    /** 미국 감시 저장본의 확인 시각 칸(뉴욕 'HH:MM'). */
    static final String US_AT = "atEt";
    /** 한국 감시 저장본의 확인 시각 칸(서울 'HH:MM'). */
    static final String KR_AT = KrCheckpointRequest.AT_FIELD;

    /**
     * 저장본이 그 계획(계좌·세션·확인 시각·순번)을 싣고 있는가.
     *
     * @param payload 저장본 본문(null이면 거짓)
     * @param atField 확인 시각 칸 이름({@link #US_AT}·{@link #KR_AT})
     * @param at      확인 시각 글자('HH:MM' — 그 시장 현지 시각)
     * @param slot    계획의 순번(끈 판 장중 확인 행은 null)
     */
    static boolean carries(JsonNode payload, String atField, String book, LocalDate session, String at, Integer slot) {
        if (payload == null) {
            return false;
        }
        JsonNode list = payload.get("checkpoints");
        if (list != null && list.isArray()) {
            for (JsonNode item : list) {
                if (same(item, atField, book, session, at) && Objects.equals(slotOf(item), slot)) {
                    return true;
                }
            }
            return false;
        }
        return slot == null && same(payload.get("checkpoint"), atField, book, session, at);
    }

    private static boolean same(JsonNode item, String atField, String book, LocalDate session, String at) {
        return item != null && item.isObject() && book.equals(Json.asText(item, "book"))
                && session.toString().equals(Json.asText(item, "sessionDate")) && at.equals(Json.asText(item, atField));
    }

    private static Integer slotOf(JsonNode item) {
        JsonNode slot = item.get("slot");
        return slot != null && slot.isIntegralNumber() ? slot.asInt() : null;
    }
}
