package com.macrodash.feature.paper;

import tools.jackson.databind.JsonNode;

import java.util.Arrays;
import java.util.List;

/**
 * 한국 장중 감시 STOP 체결의 장중 기록 스위치(ADR 0045) — {@value #KEY}, 값은 세 단계입니다.
 *
 * <ul>
 *   <li>{@link #OFF}(기본): 장중 감시 STOP은 지금처럼 그날 밤 장부가 체결합니다.</li>
 *   <li>{@link #SHADOW}: 장부는 그대로 두고, 장중 단계({@code KrStopFillStep})가 '장중에 적었을 것'(R1 체결가·비용·관문 판정)을 그 주문 근거
 *       {@code intradayFill}에 한 번 남기고 밤 체결과 견줍니다(대조만 — 고정본·장부·실제 계좌 무변경).</li>
 *   <li>{@link #ON}: 관문을 지난 R1 체결(토스 1분봉 라벨 T+1 시가 — 밤과 같은 값)을 장중에 장부에 적습니다.</li>
 * </ul>
 *
 * <p>뜻은 {@value StopWatchMode#KR_KEY}가 {@code ON}일 때만 있습니다 — 그 밖에는 감시 STOP이 생기지 않으므로 유효 값은 {@link #OFF}입니다({@link #effective}
 * — 장중 단계의 관문 G1과 ON 판 글 스위치가 함께 쓰는 한 술어). 키가 없거나 세 값 밖이면 {@link #OFF}입니다(이 키가 생기기 전 설정 행 — 배포만으로는 바뀌지
 * 않음). 규칙 계좌 스탑의 장부 반영 시각이 바뀌는 키라 규칙 계좌 영향 키입니다. 저장은 장 마감 뒤 ~ 다음 정기 결정 전에 합니다(ADR 0045 — 장중 판단
 * 패킷에 옛 문장과 새 문장이 섞이지 않게).
 */
enum KrStopFill {
    OFF, SHADOW, ON;

    static final String KEY = "kr.stopWatch.fill";
    /** 설정 화면·쓰기 검사가 받는 값(이 순서로 보임). */
    static final List<String> OPTIONS = Arrays.stream(values()).map(Enum::name).toList();
    /** 키가 없는 행·빈 본문의 값. */
    static final KrStopFill DEFAULT = OFF;

    /** 설정 본문에 적힌 값(클래스 설명 — 없거나 틀리면 꺼짐). 감시 스위치는 보지 않습니다 — 쓰는 쪽은 {@link #effective}. */
    static KrStopFill of(JsonNode body) {
        JsonNode value = body == null ? null : PaperSettingsService.valueAt(body, KEY);
        if (value == null || !value.isString()) {
            return DEFAULT;
        }
        String text = value.asString();
        for (KrStopFill fill : values()) {
            if (fill.name().equals(text)) {
                return fill;
            }
        }
        return DEFAULT;
    }

    /**
     * 유효 값 — {@value StopWatchMode#KR_KEY}가 {@code ON}이고 이 키가 {@link #SHADOW}·{@link #ON}일 때만 그 값, 아니면 {@link #OFF}(감시를 끄거나
     * SHADOW로 둔 날에는 감시 STOP이 없고, 세션 중에 감시를 끈 날의 남은 STOP도 밤 장부가 맡음).
     */
    static KrStopFill effective(JsonNode body) {
        return StopWatchMode.of(body, true).orders() ? of(body) : OFF;
    }

    /** 장중 단계가 관문을 판정해 근거를 남기는가({@link #SHADOW}·{@link #ON}). */
    boolean evaluates() {
        return this != OFF;
    }

    /** 장부에 장중 체결을 적는가({@link #ON}만). */
    boolean records() {
        return this == ON;
    }
}
