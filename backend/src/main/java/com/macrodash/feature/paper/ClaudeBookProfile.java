package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;

import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * 🧪 Claude 계좌 하나의 결정 프로필(계좌2 명세 2026-10-30-claude-book2-timing-design.md §9-1, ADR 0022) — 결정 파이프라인
 * ({@link ClaudeDecisionPipeline})이 계좌마다 다르게 쓰는 것을 한곳에 둡니다: 계좌 코드·응답 스키마 파일·시스템 프롬프트 끝의 고정 문단·패킷
 * 변형·받는 체결 시점·시점 순위·결정 주기 소상한의 설정 키.
 *
 * <p>결정 파이프라인의 열쇠는 시장이 아니라 이 프로필의 계좌 코드입니다({@link ClaudeBookService}) — 한 시장에 Claude 계좌가 둘(미국 계좌1·
 * 계좌2)이어도 기동이 막히지 않게. 시장 묶음의 {@link PaperMarket#claudeBook}은 그 시장의 '기본 Claude 계좌'(미국 {@code claude}·한국
 * {@code kr_claude})로 남고, 그 계좌의 프로필은 시장 묶음의 값을 그대로 옮긴 것입니다({@link #marketDefault}). 그래서 미국 계좌1·한국 Claude
 * 계좌의 패킷·시스템 프롬프트·응답 스키마·검증은 프로필 전과 글자 그대로입니다(고정본 시험). 미국 Claude 계좌2의 프로필은 {@link #US_CLAUDE2}입니다
 * (계좌2 명세 §9 — 시각 지정 체결 메뉴·{@code CLAUDE2_FIXED_RULES}·패킷 변형 {@code claude2}·소상한 {@code claude2.maxCallsPerCycle}).
 *
 * @param market         계좌의 시장 묶음(정의 — 달력·하드 규칙 줄·검증기의 시장 몫은 여기서)
 * @param code           계좌 코드({@code paper_books.code})
 * @param schemaResource 응답 스키마 파일(API용과 검사용이 같은 파일 — D26)
 * @param fixedRules     시스템 프롬프트 끝의 고정 문단 — 렌더링이 하드 규칙 줄 다음에 넣습니다
 *                       ({@link FrameworkService#render(ClaudeBookProfile, tools.jackson.databind.JsonNode, int,
 *                       tools.jackson.databind.JsonNode)})
 * @param packetVariant  패킷 머리의 변형 이름 — 기본 계좌는 null(패킷에 그 칸이 없음)
 * @param timings        받는 체결 시점, 이른 것부터 — 기본 계좌는 그 시장의 {@link PaperMarket#timings}
 * @param timingRanks    체결 시점 → 순위(작을수록 이른 시점, 시점마다 하나) — 기본 계좌는 이른 시점 0·나머지 1(검증기의 '이른 시점 하나 +
 *                       나머지' 두 갈래와 같은 뜻)
 * @param callCapKey     결정 주기 소상한의 설정 키 — 기본 계좌는 null(소상한 없음, 하루 상한만)
 * @param timingNames    받는 체결 시점 → 검증기 근거 문구의 이름(시점마다 하나, 그 밖의 항목은 버림) — 기본 계좌는 그 시장의
 *                       {@link PaperMarket#timingNames}
 * @param timed          시각 지정 체결 계좌인가({@link PaperBooks.Execution#TIMED} — 미국 Claude 계좌2): 주문은 목표 세션 E 하루짜리, 검증기가 그
 *                       결정에서 닫힌 시점(조기 폐장 마감 뒤·지금 + 60초 안 — {@link UsTimedFills#closedTimings})을 거절, 앞으로 체결로 출발하므로
 *                       이달 재량 주문 수에서 출발(INITIAL) 결정의 주문을 뺌(한국 계산 — 계좌2 명세 §4-1의 5·§10-5). 기본 계좌는 거짓
 */
record ClaudeBookProfile(PaperMarket market, String code, String schemaResource, String fixedRules,
                         String packetVariant, List<String> timings, Map<String, Integer> timingRanks,
                         String callCapKey, Map<String, String> timingNames, boolean timed) {

    /** 미국 Claude 계좌1({@code claude}) — 미국 시장 묶음의 값 그대로, 응답 스키마 {@value ClaudeBookService#SCHEMA_RESOURCE}. */
    static final ClaudeBookProfile US_CLAUDE = marketDefault(UsPaperMarket.INSTANCE, ClaudeBookService.SCHEMA_RESOURCE);

    /** 한국 Claude 계좌({@code kr_claude}) — 한국 시장 묶음의 값 그대로, 응답 스키마 {@value ClaudeBookService#KR_SCHEMA_RESOURCE}. */
    static final ClaudeBookProfile KR_CLAUDE = marketDefault(KrPaperMarket.INSTANCE, ClaudeBookService.KR_SCHEMA_RESOURCE);

    /**
     * 미국 Claude 계좌2({@code claude2}, 계좌2 명세 §9·ADR 0022) — 계좌1과 같은 미국 시장 묶음(달력·관측치·하드 규칙 줄·금액 표기)에 응답 스키마
     * {@value ClaudeBookService#CLAUDE2_SCHEMA_RESOURCE}·고정 문단 {@link ClaudePrompts#CLAUDE2_FIXED_RULES}·패킷 변형
     * {@value PacketBuilder#VARIANT_CLAUDE2}·체결 시점 메뉴 {@link PaperBooks#CLAUDE2_TIMINGS}(순위 NEXT_OPEN 0 &lt; AT_1000 1 &lt; … &lt; AT_1500 6 &lt;
     * NEXT_CLOSE 7 — 시점마다 다른 때 체결)·소상한 키 {@value Claude2Settings#MAX_CALLS_PER_CYCLE}·시각 지정 체결.
     */
    static final ClaudeBookProfile US_CLAUDE2 = new ClaudeBookProfile(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE2,
            ClaudeBookService.CLAUDE2_SCHEMA_RESOURCE, ClaudePrompts.CLAUDE2_FIXED_RULES, PacketBuilder.VARIANT_CLAUDE2,
            PaperBooks.CLAUDE2_TIMINGS, sequence(PaperBooks.CLAUDE2_TIMINGS), Claude2Settings.MAX_CALLS_PER_CYCLE,
            claude2TimingNames(), true);

    ClaudeBookProfile {
        Objects.requireNonNull(market, "market");
        Objects.requireNonNull(code, "code");
        Objects.requireNonNull(schemaResource, "schemaResource");
        Objects.requireNonNull(fixedRules, "fixedRules");
        Objects.requireNonNull(timingRanks, "timingRanks");
        timings = List.copyOf(timings);
        if (timings.isEmpty()) {
            throw new IllegalArgumentException("받는 체결 시점이 없습니다: " + code);
        }
        if (!timingRanks.keySet().equals(new HashSet<>(timings))) {
            throw new IllegalArgumentException("시점 순위는 받는 체결 시점마다 하나입니다: " + code + " " + timingRanks.keySet()
                    + " ≠ " + timings);
        }
        timingRanks = Collections.unmodifiableMap(new LinkedHashMap<>(timingRanks));
        Objects.requireNonNull(timingNames, "timingNames");
        Map<String, String> names = new LinkedHashMap<>();
        for (String timing : timings) {
            String name = timingNames.get(timing);
            if (name == null || name.isBlank()) {
                throw new IllegalArgumentException("받는 체결 시점마다 근거 문구의 이름이 있어야 합니다: " + code + " " + timing);
            }
            names.put(timing, name);
        }
        timingNames = Collections.unmodifiableMap(names);
    }

    /** 근거 문구의 시점 이름을 그 시장 묶음의 것({@link PaperMarket#timingNames})으로, 시각 지정 체결이 아닌 계좌 — 시장 기본 계좌·시험용 계좌. */
    ClaudeBookProfile(PaperMarket market, String code, String schemaResource, String fixedRules, String packetVariant,
                      List<String> timings, Map<String, Integer> timingRanks, String callCapKey) {
        this(market, code, schemaResource, fixedRules, packetVariant, timings, timingRanks, callCapKey,
                market.timingNames(), false);
    }

    /** 받는 순서 그대로 0, 1, 2 … 순위(시점마다 다른 때 체결 — 계좌2). */
    private static Map<String, Integer> sequence(List<String> timings) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (String timing : timings) {
            out.put(timing, out.size());
        }
        return out;
    }

    /** 계좌2 검증기 근거 문구의 시점 이름(예: '다음 세션 10:00(AT_1000) 매수인데 …'). 확정 종가는 계좌1과 같은 이름. */
    private static Map<String, String> claude2TimingNames() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put(PaperBooks.NEXT_OPEN, "다음 세션 시가");
        for (Map.Entry<String, java.time.LocalTime> entry : ExecutionAudit.MENU.entrySet()) {
            if (!PaperBooks.NEXT_OPEN.equals(entry.getKey())) {
                out.put(entry.getKey(), "다음 세션 " + ExecutionAudit.label(entry.getValue()));
            }
        }
        out.put(PaperBooks.NEXT_CLOSE, OrderValidator.Market.US.timingNames().get(PaperBooks.NEXT_CLOSE));
        return out;
    }

    /**
     * 이 계좌 주문 검증의 시장 몫({@link OrderValidator.Market}) — 받는 시점·시점 순위·근거 문구의 시점 이름은 이 프로필의 것, 금액 표기는 시장
     * 묶음의 것({@link PaperMarket#money}). 이른 시점은 가장 작은 순위의 시점 가운데 받는 순서의 첫째입니다. 시장 기본 계좌는 시장 묶음의
     * {@link PaperMarket#orderValidation}에 이 순위를 준 것과 같습니다({@code DecisionTimingsLockTest}).
     */
    OrderValidator.Market orderValidation() {
        String early = timings.get(0);
        for (String timing : timings) {
            if (timingRanks.get(timing) < timingRanks.get(early)) {
                early = timing;
            }
        }
        return new OrderValidator.Market(timings, early, timingNames, market.money(), timingRanks);
    }

    /**
     * 그 시장의 기본 Claude 계좌({@link PaperMarket#claudeBook})의 프로필 — 코드·고정 문단·받는 체결 시점은 시장 묶음의 값 그대로, 시점 순위는
     * 이른 시점({@link PaperMarket#earlyTiming}) 0·나머지 1, 패킷 변형·소상한 키는 없음. 운영 시장은 {@link #US_CLAUDE}·{@link #KR_CLAUDE}이고,
     * 시험용 시장 묶음은 결정 문맥이 이것으로 만듭니다({@link ClaudeDecisionPipeline.MarketContext}). 시장 단위 렌더링(주간 복기의 시스템 프롬프트 —
     * {@link FrameworkService#render(PaperMarket, tools.jackson.databind.JsonNode, int, tools.jackson.databind.JsonNode)})도 같은 시장 묶음의
     * 고정 문단을 씁니다.
     *
     * @param schemaResource 그 계좌의 응답 스키마 파일
     */
    static ClaudeBookProfile marketDefault(PaperMarket market, String schemaResource) {
        Map<String, Integer> ranks = new LinkedHashMap<>();
        for (String timing : market.timings()) {
            ranks.put(timing, timing.equals(market.earlyTiming()) ? 0 : 1);
        }
        return new ClaudeBookProfile(market, market.claudeBook(), schemaResource, market.promptFixedRules(), null,
                market.timings(), ranks, null);
    }
}
