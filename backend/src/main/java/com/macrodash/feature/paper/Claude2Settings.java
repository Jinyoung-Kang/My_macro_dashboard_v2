package com.macrodash.feature.paper;

import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 미국 Claude 계좌2의 설정 — 설정 한 행의 {@code claude2.*} 묶음(계좌2 명세 2026-10-30-claude-book2-timing-design.md §13-2, ADR 0022 결정 9;
 * 범위 {@link PaperSettingKeys.Scope#CLAUDE2}, 모두 규칙 계좌 영향 없음). 키가 없거나 형·범위 밖이면 그 키만 기본값으로 읽고 {@link #fallbacks}에
 * 남깁니다({@link ClaudeBookService.ClaudeSettings}와 같은 방식 — 손으로 고친 행이 있어도 결정·장부가 멈추지 않게. 쓰기 API는
 * {@link PaperSettingsService#update}가 같은 범위로 막습니다). 기본값은 '꺼짐'과 단계 1 값이라, 이 키가 생기기 전의 설정 행(서버의 지금 행)으로
 * 배포해도 아무것도 바뀌지 않습니다 — 운영자가 설정을 저장할 때 켜집니다(§16-2의 3). 예외는 투자 성향({@value #RISK_PROFILE})입니다 — 사용자
 * 결정(2026-11-01)으로 기본이 {@value #DEFAULT_RISK_PROFILE}이라, 키가 없는 행으로 배포하면 그 뒤 계좌2 호출부터 시스템 프롬프트에 그 성향 절이 들어갑니다.
 *
 * @param enabled          계좌2 결정·출발({@value #ENABLED}, 기본 꺼짐)
 * @param maxCallsPerCycle 계좌2 소상한 — 같은 기준 거래일(결정 주기)의 정기 결정·출발·재시도·장중 확인 호출 수({@value #MAX_CALLS_PER_CYCLE},
 *                         0~{@value #MAX_CALLS_PER_CYCLE_LIMIT}, 기본 {@value #DEFAULT_MAX_CALLS_PER_CYCLE})
 * @param barsWaitMinutes  1분봉 기다림 상한(분, {@value #BARS_WAIT_MINUTES}, 0~{@value #MAX_BARS_WAIT_MINUTES}, 기본
 *                         {@value #DEFAULT_BARS_WAIT_MINUTES} — {@link UsTimedFills#barsWait})
 * @param executionRecord  패킷 {@code 13_execution.record}(최근 체결 20건 — T14, 기본 켬)
 * @param checkpoints      장중 확인({@value #CHECKPOINTS}, 단계 2 — 세션당 최대 1회, 기본 꺼짐). 켠 실행의 아침 결정은 c2 판(응답 스키마
 *                         {@code checkpoint} 칸·고정 문단 c2-2·패킷 {@code executionMenuVersion} 2 — {@link ClaudeBookProfile#US_CLAUDE2_C2})으로 확인
 *                         시각·자료를 고를 수 있음. 끄면 단계 1과 바이트까지 같음(계좌2 명세 §16-3)
 * @param riskProfile      투자 성향({@value #RISK_PROFILE} — {@link #RISK_PROFILES} 가운데 하나, 기본 {@value #DEFAULT_RISK_PROFILE}). 계좌2 시스템
 *                         프롬프트의 '투자 성향' 절({@link ClaudePrompts#withClaude2RiskProfile})이 이 성향으로 목표 노출·집중도·현금 여력·손실 감내를
 *                         정하게 합니다(코드가 집행하지 않는 판단 기준 — 하드 규칙·검증기·체결 메뉴는 그대로)
 * @param fallbacks        기본값으로 읽은 키(행에 없거나 형·범위 밖)
 */
record Claude2Settings(boolean enabled, int maxCallsPerCycle, int barsWaitMinutes, boolean executionRecord,
                       boolean checkpoints, String riskProfile, List<String> fallbacks) {

    static final String ENABLED = "claude2.enabled";
    static final String MAX_CALLS_PER_CYCLE = "claude2.maxCallsPerCycle";
    static final String BARS_WAIT_MINUTES = "claude2.barsWaitMinutes";
    static final String EXECUTION_RECORD = "claude2.executionRecord";
    static final String CHECKPOINTS = "claude2.checkpoints";
    static final String RISK_PROFILE = "claude2.riskProfile";

    /**
     * 고를 수 있는 투자 성향 — 국내 금융회사가 쓰는 투자자 성향 다섯 유형 가운데 '안정형'을 뺀 넷(위험을 많이 받는 쪽부터, 사용자 결정 2026-11-01).
     * 값은 화면 설정 탭에 그대로 보이는 이름입니다.
     */
    static final List<String> RISK_PROFILES = List.of("공격투자형", "적극투자형", "위험중립형", "안정추구형");
    static final String DEFAULT_RISK_PROFILE = "적극투자형";

    static final int DEFAULT_MAX_CALLS_PER_CYCLE = 2;
    static final int MAX_CALLS_PER_CYCLE_LIMIT = 10;
    /** 1분봉 기다림의 기본 상한 — {@link UsTimedFills#BARS_WAIT}와 같은 값(설정이 없을 때). */
    static final int DEFAULT_BARS_WAIT_MINUTES = (int) UsTimedFills.BARS_WAIT.toMinutes();
    static final int MAX_BARS_WAIT_MINUTES = 30;

    /** 이 키가 생기기 전 행·빈 본문의 값(꺼짐·단계 1 값). */
    static final Claude2Settings DEFAULTS = new Claude2Settings(false, DEFAULT_MAX_CALLS_PER_CYCLE,
            DEFAULT_BARS_WAIT_MINUTES, true, false, DEFAULT_RISK_PROFILE, List.of());

    Claude2Settings {
        fallbacks = List.copyOf(fallbacks);
    }

    /** 1분봉 기다림 상한({@link #barsWaitMinutes}분). */
    Duration barsWait() {
        return Duration.ofMinutes(barsWaitMinutes);
    }

    /**
     * 설정 본문에서 읽습니다(클래스 설명 — 없거나 틀린 키는 그 키만 기본값). null 본문은 기본값 그대로({@link #DEFAULTS}, 기본값으로 읽은 키
     * 없음 — 행이 없을 때).
     */
    static Claude2Settings from(JsonNode body) {
        if (body == null) {
            return DEFAULTS;
        }
        List<String> fallbacks = new ArrayList<>();
        boolean enabled = bool(body, ENABLED, DEFAULTS.enabled(), fallbacks);
        int calls = integer(body, MAX_CALLS_PER_CYCLE, 0, MAX_CALLS_PER_CYCLE_LIMIT, DEFAULTS.maxCallsPerCycle(), fallbacks);
        int wait = integer(body, BARS_WAIT_MINUTES, 0, MAX_BARS_WAIT_MINUTES, DEFAULTS.barsWaitMinutes(), fallbacks);
        boolean record = bool(body, EXECUTION_RECORD, DEFAULTS.executionRecord(), fallbacks);
        boolean checkpoints = bool(body, CHECKPOINTS, DEFAULTS.checkpoints(), fallbacks);
        String riskProfile = choice(body, RISK_PROFILE, RISK_PROFILES, DEFAULTS.riskProfile(), fallbacks);
        return new Claude2Settings(enabled, calls, wait, record, checkpoints, riskProfile, fallbacks);
    }

    /** 기본 설정 본문의 {@code claude2} 묶음({@link PaperSettingsService#defaultsJson}). */
    static Map<String, Object> defaultsBody() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", DEFAULTS.enabled());
        out.put("maxCallsPerCycle", DEFAULTS.maxCallsPerCycle());
        out.put("barsWaitMinutes", DEFAULTS.barsWaitMinutes());
        out.put("executionRecord", DEFAULTS.executionRecord());
        out.put("checkpoints", DEFAULTS.checkpoints());
        out.put("riskProfile", DEFAULTS.riskProfile());
        return out;
    }

    private static boolean bool(JsonNode body, String key, boolean fallback, List<String> fallbacks) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        if (value != null && value.isBoolean()) {
            return value.booleanValue();
        }
        fallbacks.add(key);
        return fallback;
    }

    private static String choice(JsonNode body, String key, List<String> options, String fallback, List<String> fallbacks) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        if (value != null && value.isString() && options.contains(value.asString())) {
            return value.asString();
        }
        fallbacks.add(key);
        return fallback;
    }

    private static int integer(JsonNode body, String key, int min, int max, int fallback, List<String> fallbacks) {
        JsonNode value = PaperSettingsService.valueAt(body, key);
        if (value != null && value.isNumber()) {
            double number = value.asDouble();
            if (Double.isFinite(number) && number == Math.rint(number) && number >= min && number <= max) {
                return (int) number;
            }
        }
        fallbacks.add(key);
        return fallback;
    }
}
