package com.macrodash.feature.paper;

import tools.jackson.databind.JsonNode;

import java.util.Arrays;
import java.util.List;

/**
 * 모의 장중 스탑 감시의 스위치(ADR 0032 결정 5) — 미국 {@value #US_KEY}·한국 {@value #KR_KEY}, 값은 세 단계입니다.
 *
 * <ul>
 *   <li>{@link #OFF}(기본): 감시하지 않음 — 수집기가 외부를 부르지 않고 백엔드도 판정하지 않습니다(기존 시간별·밤 스탑만).</li>
 *   <li>{@link #SHADOW}: 수집·판정은 하되 주문을 내지 않고 '걸렸을 것'을 작업 기록에만 남깁니다.</li>
 *   <li>{@link #ON}: 판정되면 STOP 주문을 냅니다.</li>
 * </ul>
 *
 * <p>키가 없거나 세 값 밖이면 {@link #OFF}입니다(이 키가 생기기 전 설정 행 — 배포만으로는 바뀌지 않음). 수집기는 같은 글자를 {@code paper_settings}에서
 * 읽기만 합니다(ADR 0008). 그 시장 규칙 계좌의 스탑 시점이 바뀌는 키라 규칙 계좌 영향 키입니다.
 */
enum StopWatchMode {
    OFF, SHADOW, ON;

    static final String US_KEY = "stopWatch.mode";
    static final String KR_KEY = "kr.stopWatch.mode";
    /** 설정 화면·쓰기 검사가 받는 값(이 순서로 보임). */
    static final List<String> OPTIONS = Arrays.stream(values()).map(Enum::name).toList();
    /** 키가 없는 행·빈 본문의 값. */
    static final StopWatchMode DEFAULT = OFF;

    /** 그 시장의 키. */
    static String key(boolean korea) {
        return korea ? KR_KEY : US_KEY;
    }

    /** 설정 본문에서 그 시장의 값(클래스 설명 — 없거나 틀리면 꺼짐). */
    static StopWatchMode of(JsonNode body, boolean korea) {
        JsonNode value = body == null ? null : PaperSettingsService.valueAt(body, key(korea));
        if (value == null || !value.isString()) {
            return DEFAULT;
        }
        String text = value.asString();
        for (StopWatchMode mode : values()) {
            if (mode.name().equals(text)) {
                return mode;
            }
        }
        return DEFAULT;
    }

    /** 수집·판정을 하는가({@link #SHADOW}·{@link #ON}). */
    boolean watching() {
        return this != OFF;
    }

    /** 판정되면 주문을 내는가({@link #ON}만). */
    boolean orders() {
        return this == ON;
    }
}
