package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;

import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Claude 계좌 하나의 결정 프로필(계좌2 명세 2026-10-30-claude-book2-timing-design.md §9-1, ADR 0022) — 결정 파이프라인
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
 * @param checkpoints    장중 확인 판인가(계좌2 단계 2 — 설정 {@value Claude2Settings#CHECKPOINTS}를 켠 결정, {@link #US_CLAUDE2_C2}): 응답 스키마에
 *                       {@code checkpoint} 칸, 고정 문단 c2-2, 패킷 {@code executionMenuVersion} 2·{@code 13_execution.checkpointOptions}. 그 밖은 거짓
 * @param freeTiming     자유 시점 판인가(ADR 0027 결정 2 — 그 계좌의 스위치 {@link FreeTimingSettings}를 켠 결정): 받는 시점은
 *                       {@link FreeTiming#DECISION_TIMINGS}(시가·분 단위 지정 시각·종가), 검증 표는 결정마다 주문의 시각으로 만들고
 *                       ({@link FreeTiming#validation}), 주문 행은 {@code AT_MINUTE} + {@code target_local}. 그 밖은 거짓 — 끈 판의 프로필은
 *                       이 칸이 생기기 전과 같은 값이라 프롬프트·스키마·패킷·검증이 바이트까지 같습니다
 */
record ClaudeBookProfile(PaperMarket market, String code, String schemaResource, String fixedRules,
                         String packetVariant, List<String> timings, Map<String, Integer> timingRanks,
                         String callCapKey, Map<String, String> timingNames, boolean timed, boolean checkpoints,
                         boolean freeTiming) {

    /** 미국 Claude 계좌1({@code claude}) — 미국 시장 묶음의 값 그대로, 응답 스키마 {@value ClaudeBookService#SCHEMA_RESOURCE}. */
    static final ClaudeBookProfile US_CLAUDE = marketDefault(UsPaperMarket.INSTANCE, ClaudeBookService.SCHEMA_RESOURCE);

    /** 한국 Claude 계좌({@code kr_claude}) — 한국 시장 묶음의 값 그대로, 응답 스키마 {@value ClaudeBookService#KR_SCHEMA_RESOURCE}. */
    static final ClaudeBookProfile KR_CLAUDE = marketDefault(KrPaperMarket.INSTANCE, ClaudeBookService.KR_SCHEMA_RESOURCE);

    /**
     * 한국 Claude 계좌2({@code kr_claude2}, 사용자 결정 2026-11-02) — 한국 계좌1과 같은 한국 묶음(달력·관측치·하드 규칙 줄·금액 표기 — 패킷은
     * {@link KrPacketBuilder#forBook})에 단계 2a의 체결 시점 메뉴(명세 2026-11-02-kr-claude2-stage2 §2): 응답 스키마
     * {@value ClaudeBookService#KR_CLAUDE2_SCHEMA_RESOURCE}·고정 문단 {@link ClaudePrompts#KR_CLAUDE2_FIXED_RULES}·메뉴
     * {@link PaperBooks#KR_CLAUDE2_TIMINGS}(순위 NEXT_OPEN 0 &lt; AT_1000 1 &lt; … &lt; AT_1500 6 &lt; NEXT_CLOSE 7 — 장부가 이 순서로 매도 → 매수를
     * 처리). 시각 지정 체결 표시({@link #timed})는 켜지 않습니다(미국 전용 분기 — 닫힌 시점·E 하루 만료, §9): 한국 매시 시점의 닫힘은 결정 파이프라인이
     * {@link KrTimedLadder#closedTimings}로 더하고, 만료는 계좌1과 같은 기준일 + 3거래일입니다. 패킷 변형·소상한 키는 없음. 투자 성향 절은 렌더링이
     * 더합니다({@link FrameworkService#render}). 장중 확인(단계 2b)을 받는 계좌라 {@link #checkpoints}가 참입니다 — 파이프라인이 장중 확인 응답 스키마
     * {@value KrCheckpointPacket#SCHEMA_RESOURCE}를 기동 때 읽고, 응답 검증은 {@link #KR_CLAUDE2_CHECKPOINT}가 합니다.
     */
    static final ClaudeBookProfile KR_CLAUDE2 = new ClaudeBookProfile(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE2,
            ClaudeBookService.KR_CLAUDE2_SCHEMA_RESOURCE, ClaudePrompts.KR_CLAUDE2_FIXED_RULES, null,
            PaperBooks.KR_CLAUDE2_TIMINGS, sequence(PaperBooks.KR_CLAUDE2_TIMINGS), null, krClaude2TimingNames(), false, true);

    /**
     * 한국 Claude 계좌2 장중 확인 응답(단계 2b — 명세 2026-11-02 §10) — 장중 확인 작업({@link PaperKrCheckpointJob})이 받은 응답의 주문을 검증할 때 씁니다
     * (호출 자체는 {@link #KR_CLAUDE2}의 시스템 프롬프트와 {@value KrCheckpointPacket#SCHEMA_RESOURCE}). 같은 계좌 코드·시장 묶음이고, 받는 시점은
     * {@link PaperBooks#CHECKPOINT_TIMINGS}(장중 시장가 MARKET 0 &lt; AT_1000 1 &lt; … &lt; AT_1500 6 &lt; NEXT_CLOSE 7 — 매도는 같거나 뒤 순위의 매수에만
     * 현금을 만듦). 지난 AT_*·정규장 밖이거나 종가 단일가 시간의 MARKET은 검증기가 닫습니다({@link KrTimedLadder#closedTimings}).
     */
    static final ClaudeBookProfile KR_CLAUDE2_CHECKPOINT = new ClaudeBookProfile(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE2,
            KrCheckpointPacket.SCHEMA_RESOURCE, ClaudePrompts.KR_CLAUDE2_FIXED_RULES, null, PaperBooks.CHECKPOINT_TIMINGS,
            sequence(PaperBooks.CHECKPOINT_TIMINGS), null, krCheckpointTimingNames(), false, true);

    /**
     * 미국 Claude 계좌2({@code claude2}, 계좌2 명세 §9·ADR 0022) — 계좌1과 같은 미국 시장 묶음(달력·관측치·하드 규칙 줄·금액 표기)에 응답 스키마
     * {@value ClaudeBookService#CLAUDE2_SCHEMA_RESOURCE}·고정 문단 {@link ClaudePrompts#CLAUDE2_FIXED_RULES}·패킷 변형
     * {@value PacketBuilder#VARIANT_CLAUDE2}·체결 시점 메뉴 {@link PaperBooks#CLAUDE2_TIMINGS}(순위 NEXT_OPEN 0 &lt; AT_1000 1 &lt; … &lt; AT_1500 6 &lt;
     * NEXT_CLOSE 7 — 시점마다 다른 때 체결)·소상한 키 {@value Claude2Settings#MAX_CALLS_PER_CYCLE}·시각 지정 체결.
     */
    static final ClaudeBookProfile US_CLAUDE2 = new ClaudeBookProfile(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE2,
            ClaudeBookService.CLAUDE2_SCHEMA_RESOURCE, ClaudePrompts.CLAUDE2_FIXED_RULES, PacketBuilder.VARIANT_CLAUDE2,
            PaperBooks.CLAUDE2_TIMINGS, sequence(PaperBooks.CLAUDE2_TIMINGS), Claude2Settings.MAX_CALLS_PER_CYCLE,
            claude2TimingNames(), true, false);

    /**
     * 장중 확인을 켠 계좌2의 아침 결정(계좌2 명세 §5-2·§9-5, 단계 2 — 설정 {@value Claude2Settings#CHECKPOINTS}) — {@link #US_CLAUDE2}와 같은 계좌 코드·
     * 메뉴 여덟·순위·소상한 키·시각 지정 체결이고, 다른 것은 응답 스키마 {@value ClaudeBookService#CLAUDE2_C2_SCHEMA_RESOURCE}(선택 칸
     * {@code checkpoint})·고정 문단 {@link ClaudePrompts#CLAUDE2_FIXED_RULES_C2}(판 c2-2)·패킷 판({@link #checkpoints})뿐입니다. 아침 결정은
     * MARKET을 받지 않습니다(장중 확인 응답만). 결정 파이프라인 맵 밖의 따로 만든 파이프라인이 씁니다({@link ClaudeBookService}).
     */
    static final ClaudeBookProfile US_CLAUDE2_C2 = new ClaudeBookProfile(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE2,
            ClaudeBookService.CLAUDE2_C2_SCHEMA_RESOURCE, ClaudePrompts.CLAUDE2_FIXED_RULES_C2, PacketBuilder.VARIANT_CLAUDE2,
            PaperBooks.CLAUDE2_TIMINGS, sequence(PaperBooks.CLAUDE2_TIMINGS), Claude2Settings.MAX_CALLS_PER_CYCLE,
            claude2TimingNames(), true, true);

    /**
     * 장중 확인 응답(계좌2 명세 §5-2·§9-5·§10-5, 단계 2) — 장중 확인 작업이 받은 응답의 주문을 검증할 때 씁니다(호출 자체는 {@link #US_CLAUDE2_C2}의
     * 시스템 프롬프트 c2-2와 이 스키마). 같은 계좌 코드·소상한 키·시각 지정 체결이고, 받는 시점은 {@link PaperBooks#CHECKPOINT_TIMINGS}(장중 시장가
     * MARKET 0 &lt; AT_1000 1 &lt; … &lt; AT_1500 6 &lt; NEXT_CLOSE 7 — 매도는 같거나 뒤 순위의 매수에만 현금을 만듦), 응답 스키마
     * {@value CheckpointPacket#SCHEMA_RESOURCE}. 지난 AT_*·마감 5분 전 뒤 MARKET은 검증기가 닫습니다({@link UsTimedFills#closedTimings}).
     */
    static final ClaudeBookProfile US_CLAUDE2_CHECKPOINT = new ClaudeBookProfile(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE2,
            CheckpointPacket.SCHEMA_RESOURCE, ClaudePrompts.CLAUDE2_FIXED_RULES_C2, PacketBuilder.VARIANT_CLAUDE2,
            PaperBooks.CHECKPOINT_TIMINGS, sequence(PaperBooks.CHECKPOINT_TIMINGS), Claude2Settings.MAX_CALLS_PER_CYCLE,
            checkpointTimingNames(), true, true);

    /**
     * 미국 Claude 계좌1의 자유 시점 판(ADR 0027 결정 2 — 스위치 {@value FreeTimingSettings#US_CLAUDE}) — 계좌1과 같은 계좌 코드·미국 시장 묶음에,
     * 응답 스키마 {@value ClaudeBookService#US_FT_SCHEMA_RESOURCE}·고정 문단 {@link ClaudePrompts#US_FT_FIXED_RULES}·계좌2의 패킷 변형
     * ({@code 13_execution} — 자기 체결 기록)·받는 시점 {@link FreeTiming#DECISION_TIMINGS}·시각 지정 체결(주문은 다음 세션 하루짜리). 다음 관측치
     * (NEXT_OBSERVATION)는 받지 않습니다(참고 지표의 기준으로만 남음). 소상한 키는 없습니다(계좌1은 하루 상한만). 결정 파이프라인 맵 밖의 따로 만든
     * 파이프라인이 씁니다({@link ClaudeBookService}).
     */
    static final ClaudeBookProfile US_CLAUDE_FT = new ClaudeBookProfile(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE,
            ClaudeBookService.US_FT_SCHEMA_RESOURCE, ClaudePrompts.US_FT_FIXED_RULES, PacketBuilder.VARIANT_CLAUDE2,
            FreeTiming.DECISION_TIMINGS, sequence(FreeTiming.DECISION_TIMINGS), null, usFreeTimingNames(), true, false, true);

    /**
     * 미국 Claude 계좌2의 자유 시점 판(스위치 {@value FreeTimingSettings#US_CLAUDE2}) — {@link #US_CLAUDE_FT}와 같은 스키마·고정 문단·패킷 변형·받는
     * 시점이고, 다른 것은 계좌 코드와 소상한 키({@value Claude2Settings#MAX_CALLS_PER_CYCLE})뿐입니다(투자 성향 절은 렌더링이 계좌 코드로 더함).
     * 매시 정각 메뉴({@link #US_CLAUDE2})와 장중 확인 판({@link #US_CLAUDE2_C2})을 대신합니다.
     */
    static final ClaudeBookProfile US_CLAUDE2_FT = new ClaudeBookProfile(UsPaperMarket.INSTANCE, PaperBooks.CLAUDE2,
            ClaudeBookService.US_FT_SCHEMA_RESOURCE, ClaudePrompts.US_FT_FIXED_RULES, PacketBuilder.VARIANT_CLAUDE2,
            FreeTiming.DECISION_TIMINGS, sequence(FreeTiming.DECISION_TIMINGS), Claude2Settings.MAX_CALLS_PER_CYCLE,
            usFreeTimingNames(), true, false, true);

    /**
     * 한국 Claude 계좌1의 자유 시점 판(스위치 {@value FreeTimingSettings#KR_CLAUDE}) — 한국 계좌1과 같은 계좌 코드·한국 묶음에, 응답 스키마
     * {@value ClaudeBookService#KR_FT_SCHEMA_RESOURCE}·고정 문단 {@link ClaudePrompts#KR_FT_FIXED_RULES}·받는 시점
     * {@link FreeTiming#DECISION_TIMINGS}. 한국 계좌2처럼 시각 지정 체결 표시({@link #timed})는 켜지 않습니다(미국 전용 분기 — 만료는 기준일 +
     * 3거래일 그대로이고, 장부는 목표 세션에서 풀지 못한 지정 시각 주문을 다음 날로 넘기지 않음). 패킷은 {@link KrPacketBuilder#forFree}가 만듭니다.
     */
    static final ClaudeBookProfile KR_CLAUDE_FT = new ClaudeBookProfile(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE,
            ClaudeBookService.KR_FT_SCHEMA_RESOURCE, ClaudePrompts.KR_FT_FIXED_RULES, null, FreeTiming.DECISION_TIMINGS,
            sequence(FreeTiming.DECISION_TIMINGS), null, krFreeTimingNames(), false, false, true);

    /**
     * 한국 Claude 계좌2의 자유 시점 판(스위치 {@value FreeTimingSettings#KR_CLAUDE2}) — {@link #KR_CLAUDE_FT}와 같은 스키마·고정 문단·받는 시점이고
     * 계좌 코드만 다릅니다(투자 성향 절은 렌더링이 계좌 코드로 더함). 매시 정각 메뉴와 기존 장중 확인({@link #KR_CLAUDE2})을 대신합니다.
     */
    static final ClaudeBookProfile KR_CLAUDE2_FT = new ClaudeBookProfile(KrPaperMarket.INSTANCE, PaperBooks.KR_CLAUDE2,
            ClaudeBookService.KR_FT_SCHEMA_RESOURCE, ClaudePrompts.KR_FT_FIXED_RULES, null, FreeTiming.DECISION_TIMINGS,
            sequence(FreeTiming.DECISION_TIMINGS), null, krFreeTimingNames(), false, false, true);

    /**
     * 자유 시점 판 계좌의 장중 판단 응답 프로필(ADR 0027 결정 3) — 장중 판단 작업({@link PaperIntradayJob}·한국 작업)이 받은 응답의 주문을 검증할 때
     * 씁니다(호출 자체는 그 계좌의 자유 시점 판 프로필의 시스템 프롬프트와 장중 판단 응답 스키마). 같은 계좌 코드·시장 묶음·고정 문단·패킷 변형·소상한
     * 키·시각 지정 체결 여부이고, 받는 시점만 {@link FreeTiming#INTRADAY_TIMINGS}(장중 시장가 · 그날 남은 분 단위 지정 시각 · 그날 종가)입니다. 순위는
     * 결정마다 기준 시각 순으로 다시 만듭니다({@link FreeTiming#validation}).
     *
     * @throws IllegalArgumentException 자유 시점 판 프로필이 아님
     */
    static ClaudeBookProfile intradayReplies(ClaudeBookProfile free) {
        if (!free.freeTiming()) {
            throw new IllegalArgumentException("자유 시점 판 프로필이 아닙니다: " + free.code());
        }
        boolean korea = free.market() == KrPaperMarket.INSTANCE;
        Map<String, String> names = new LinkedHashMap<>();
        names.put(PaperBooks.MARKET, "장중 시장가");
        names.put(PaperBooks.AT_MINUTE, "지정 시각");
        names.put(PaperBooks.NEXT_CLOSE, korea ? "오늘 종가" : OrderValidator.Market.US.timingNames().get(PaperBooks.NEXT_CLOSE));
        return new ClaudeBookProfile(free.market(), free.code(), ClaudeDecisionPipeline.checkpointSchemaResource(free),
                free.fixedRules(), free.packetVariant(), FreeTiming.INTRADAY_TIMINGS, sequence(FreeTiming.INTRADAY_TIMINGS),
                free.callCapKey(), names, free.timed(), false, true);
    }

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

    /** 자유 시점 판이 아닌 계좌(끈 판) — ADR 0027 전의 열한 칸 그대로. */
    ClaudeBookProfile(PaperMarket market, String code, String schemaResource, String fixedRules, String packetVariant,
                      List<String> timings, Map<String, Integer> timingRanks, String callCapKey,
                      Map<String, String> timingNames, boolean timed, boolean checkpoints) {
        this(market, code, schemaResource, fixedRules, packetVariant, timings, timingRanks, callCapKey, timingNames, timed,
                checkpoints, false);
    }

    /** 근거 문구의 시점 이름을 그 시장 묶음의 것({@link PaperMarket#timingNames})으로, 시각 지정 체결이 아닌 계좌 — 시장 기본 계좌·시험용 계좌. */
    ClaudeBookProfile(PaperMarket market, String code, String schemaResource, String fixedRules, String packetVariant,
                      List<String> timings, Map<String, Integer> timingRanks, String callCapKey) {
        this(market, code, schemaResource, fixedRules, packetVariant, timings, timingRanks, callCapKey,
                market.timingNames(), false, false);
    }

    /** 받는 순서 그대로 0, 1, 2 … 순위(시점마다 다른 때 체결 — 계좌2). */
    private static Map<String, Integer> sequence(List<String> timings) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (String timing : timings) {
            out.put(timing, out.size());
        }
        return out;
    }

    /**
     * 미국 자유 시점 판 검증기 근거 문구의 시점 이름 — 시가·종가는 계좌2와 같은 이름, 분 단위 지정 시각은 이름만('지정 시각' — 시각이 없는 주문의
     * 거절 문구에 쓰임). 시각이 있는 주문의 이름('다음 세션 10:47 ET')은 결정마다 {@link FreeTiming#validation}이 만듭니다.
     */
    private static Map<String, String> usFreeTimingNames() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put(PaperBooks.NEXT_OPEN, "다음 세션 시가");
        out.put(PaperBooks.AT_MINUTE, "지정 시각");
        out.put(PaperBooks.NEXT_CLOSE, OrderValidator.Market.US.timingNames().get(PaperBooks.NEXT_CLOSE));
        return out;
    }

    /** 한국 자유 시점 판 검증기 근거 문구의 시점 이름 — 시가·종가는 한국 계좌2와 같은 이름, 분 단위 지정 시각은 이름만(시각은 결정마다). */
    private static Map<String, String> krFreeTimingNames() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put(PaperBooks.NEXT_OPEN, "다음 거래일 시가");
        out.put(PaperBooks.AT_MINUTE, "지정 시각");
        out.put(PaperBooks.NEXT_CLOSE, "다음 거래일 종가");
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

    /** 한국 계좌2 검증기 근거 문구의 시점 이름(예: '다음 거래일 10:00 KST(AT_1000) 매수인데 …'). 시가·종가는 한국 계좌1과 같은 이름. */
    private static Map<String, String> krClaude2TimingNames() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put(PaperBooks.NEXT_OPEN, "다음 거래일 시가");
        for (String timing : PaperBooks.KR_CLAUDE2_TIMINGS) {
            java.time.LocalTime at = KrTimedLadder.hourly(timing);
            if (at != null) {
                out.put(timing, "다음 거래일 " + KrTimedLadder.label(at) + " KST");
            }
        }
        out.put(PaperBooks.NEXT_CLOSE, "다음 거래일 종가");
        return out;
    }

    /** 한국 장중 확인 응답 검증기 근거 문구의 시점 이름(예: '장중 시장가(MARKET) 매도'·'오늘 14:00 KST(AT_1400) 매수'). */
    private static Map<String, String> krCheckpointTimingNames() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put(PaperBooks.MARKET, "장중 시장가");
        for (String timing : PaperBooks.CHECKPOINT_TIMINGS) {
            java.time.LocalTime at = KrTimedLadder.hourly(timing);
            if (at != null) {
                out.put(timing, "오늘 " + KrTimedLadder.label(at) + " KST");
            }
        }
        out.put(PaperBooks.NEXT_CLOSE, "오늘 종가");
        return out;
    }

    /** 장중 확인 응답 검증기 근거 문구의 시점 이름(예: '장중 시장가(MARKET) 매도'·'이 세션 14:00(AT_1400) 매수'). */
    private static Map<String, String> checkpointTimingNames() {
        Map<String, String> out = new LinkedHashMap<>();
        out.put(PaperBooks.MARKET, "장중 시장가");
        for (Map.Entry<String, java.time.LocalTime> entry : ExecutionAudit.MENU.entrySet()) {
            if (!PaperBooks.NEXT_OPEN.equals(entry.getKey())) {
                out.put(entry.getKey(), "이 세션 " + ExecutionAudit.label(entry.getValue()));
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
