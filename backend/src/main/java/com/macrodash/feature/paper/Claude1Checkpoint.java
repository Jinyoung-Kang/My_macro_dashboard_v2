package com.macrodash.feature.paper;

import tools.jackson.databind.JsonNode;

import java.time.LocalTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;

/**
 * 미국 Claude 계좌1의 장중 확인 설정(사용자 결정 2026-11-02 — 계좌1도 장중 확인 '없음' → '세션당 한 번'). 설정 한 행의 {@code claude.checkpoint}
 * (켜기, 기본 꺼짐)·{@code claude.checkpointAtEt}(뉴욕 시각 HH:mm, 10:00~15:00, 기본 12:00). 키가 없거나 형·범위 밖이면 그 키만 기본값으로 읽고
 * {@link #fallbacks}에 남깁니다({@link Claude2Settings}와 같은 방식 — 설정 화면·상태의 fallbacks에 실림). 범위는 쓰기 검사
 * ({@link PaperSettingKeys#policy})도 같은 상수로 막으므로 범위 밖 값은 손으로 고친 행에만 있습니다(QA-182).
 *
 * <p>계좌2의 장중 확인(아침 결정이 시각·자료를 고르는 시각 지정 체결용 장치)과 달리, 계좌1은 정한 시각 뒤 첫 시간별 관측치로 계좌1의 정기 결정과
 * 같은 패킷·검증을 한 번 더 돌립니다({@link PaperClaude1CheckpointJob} — 결정 종류 {@code CHECKPOINT}, 통과 주문은 다음 시간별 관측치·종가 체결이고
 * 남은 대기 주문을 대신함).
 */
record Claude1Checkpoint(boolean enabled, LocalTime atEt, List<String> fallbacks) {

    static final String ENABLED = "claude.checkpoint";
    static final String AT_ET = "claude.checkpointAtEt";
    static final LocalTime DEFAULT_AT = LocalTime.of(12, 0);
    static final LocalTime EARLIEST = LocalTime.of(10, 0);
    static final LocalTime LATEST = LocalTime.of(15, 0);
    static final Claude1Checkpoint DEFAULTS = new Claude1Checkpoint(false, DEFAULT_AT, List.of());

    Claude1Checkpoint {
        fallbacks = List.copyOf(fallbacks);
    }

    /** 설정 본문에서 읽습니다(없거나 틀린 키는 그 키만 기본값). null 본문은 기본값 그대로. */
    static Claude1Checkpoint from(JsonNode body) {
        if (body == null) {
            return DEFAULTS;
        }
        List<String> fallbacks = new ArrayList<>();
        JsonNode on = PaperSettingsService.valueAt(body, ENABLED);
        boolean enabled = DEFAULTS.enabled();
        if (on != null && on.isBoolean()) {
            enabled = on.booleanValue();
        } else {
            fallbacks.add(ENABLED);
        }
        LocalTime at = DEFAULT_AT;
        JsonNode time = PaperSettingsService.valueAt(body, AT_ET);
        LocalTime parsed = null;
        if (time != null && time.isString()) {
            try {
                parsed = LocalTime.parse(time.asString());
            } catch (DateTimeParseException e) {
                parsed = null;
            }
        }
        if (parsed != null && !parsed.isBefore(EARLIEST) && !parsed.isAfter(LATEST)) {
            at = parsed;
        } else {
            fallbacks.add(AT_ET);
        }
        return new Claude1Checkpoint(enabled, at, fallbacks);
    }
}
