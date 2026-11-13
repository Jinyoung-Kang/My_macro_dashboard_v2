package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Checkpoint;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * 미국 Claude 계좌2의 장중 확인 패킷({@code checkpointVersion} 1 — 계좌2 명세 2026-10-30-claude-book2-timing-design.md §5-2·§7-3·§8 ⑨·§9-5,
 * ADR 0022). 아침 결정이 고른 시각(확인 시각 + 2~20분)에 장중 확인 작업이 한 번 보내는 사용자 메시지입니다. 시스템 프롬프트는 아침 결정과 같은
 * c2-2 렌더링이고, 응답 스키마는 {@value #SCHEMA_RESOURCE}입니다.
 *
 * <p>섹션: {@code 0_instructions} · {@code 1_basis}(판·세션·지금 시각·마감까지 분·남은 시점) · {@code 2_macroCards}(아침 패킷과 같은 매크로 카드 —
 * 각자의 지연 배지 그대로) · {@code 3_request}(아침의 요청) · {@code 4_portfolio}(장부 현금·순자산·보유·대기 주문과 그 상태·오늘 체결 —
 * 예상 상태({@code expected} — {@link ExpectedState}, §10-6)) · {@code 5_feed}(MINUTE = 감시 저장본의 최근 완성 1분봉 / HOURLY = 시간별 관측치) ·
 * {@code 6_hardRules}(아침 패킷 12_hardRules의 한도 + 장중 확인 메뉴·⑩ 범위 문장).
 *
 * <p><b>⑨ 조립 시각 이전 자료만</b>: 봉은 끝(시작 + 60초)이, 종목·저장본은 받은 시각이 조립 시각({@code asOfInstant}) 이하인 것만 싣고 나머지는
 * 버린 뒤 그 수를 적습니다({@code 5_feed.dropped}). 주문의 {@code created_at}은 응답 뒤 DB now()라 늘 이 시각보다 늦습니다(작업 시험이 단언).
 *
 * <p>입력({@link Inputs})을 받아 조립만 합니다 — 저장소·저장본을 읽지 않아 같은 입력이면 같은 글자입니다(고정본 시험).
 *
 * <p><b>자유 시점 판의 장중 판단</b>(ADR 0027 결정 3 — {@link Free}가 있을 때): 같은 섹션·같은 자료에 그 계좌(계좌1·계좌2)와 순번을 적고, 남은 시점은
 * 장중 시장가·그날 남은 분 단위 지정 시각({@code 1_basis.atMinute} 범위)·그날 종가, 다음 판단을 예약할 수 있는지({@code 1_basis.nextCheckpoint}),
 * 지시문·하드 규칙 문장은 그 판의 것입니다. 응답 스키마는 {@value #FREE_SCHEMA_RESOURCE}. MINUTE 피드는 그 계획의 종목(감시 목록·보유·대기·기준
 * 종목)만 싣습니다 — 감시 저장본 한 장이 다른 계좌 계획의 종목도 싣기 때문입니다. {@link Free}가 없으면 끈 판 장중 확인 글자 그대로입니다.
 */
final class CheckpointPacket {

    private CheckpointPacket() {
    }

    private static final Logger log = LoggerFactory.getLogger(CheckpointPacket.class);

    /** 장중 확인 패킷 판. */
    static final int CHECKPOINT_VERSION = 1;
    /** 장중 확인 응답 스키마(API용과 검사용이 같은 파일 — D26). */
    static final String SCHEMA_RESOURCE = "paper/claude2-checkpoint.schema.json";
    /** 자유 시점 판의 장중 판단 응답 스키마(ADR 0027 결정 3 — 시점 셋·{@code atLocal}·{@code nextCheckpoint}). */
    static final String FREE_SCHEMA_RESOURCE = "paper/us-intraday-ft.schema.json";
    /** 결정 종류(paper_decisions.kind — V18). */
    static final String KIND = RuleBookService.CHECKPOINT;
    /** 목표 크기(토큰 어림) — 넘으면 경고 로그만(§9-5 '약 10K'). */
    static final int CHECKPOINT_TARGET_TOKENS = 12_000;
    /** HOURLY 피드에 싣는 종목 상한(§9-5 — 감시 ∪ 보유 ∪ 대기 ∪ 아침 8_prices 대상). */
    static final int HOURLY_MAX = 60;
    /** MINUTE 종목마다 싣는 완성 봉 수(수집기 BARS_KEPT와 같음). */
    static final int BARS_SHOWN = 30;
    /** 봉 하나의 길이 — 봉 끝 = 시작 + 이것. */
    static final Duration BAR = Duration.ofSeconds(60);
    /** 정규장인데 기준 종목의 새 봉이 이만큼 없으면 '멈춤'(§7-3). */
    static final Duration STALL = Duration.ofMinutes(10);
    /** 준실시간(측정): 최근 {@value ExecutionSection#RECENT_LAG_SESSIONS}세션 p95 ≤ 이 값(초)이고 이번 값 ≤ {@link #DELAY_AFTER_SECONDS}. */
    static final int NEAR_P95_SECONDS = 90;
    /** 이번 지연이 이 값(초)을 넘으면 '지연 n분(측정)'. */
    static final int DELAY_AFTER_SECONDS = 120;
    /** 지연 기준 종목(수집기 REFERENCE). */
    static final String REFERENCE = "SPY";

    /** 장중 확인 주문이 받는 체결 시점(스키마 timing enum·확인 프로필과 같은 목록, 이른 것부터 — MARKET 0 < AT_1000 1 < … < NEXT_CLOSE 7). */
    static final List<String> TIMINGS = PaperBooks.CHECKPOINT_TIMINGS;

    /** 아침 패킷 12_hardRules에서 그대로 옮기는 한도 칸. */
    static final List<String> HARD_RULE_KEYS = List.of("maxWeightStockPct", "maxWeightEtfPct", "maxPositions",
            "minOrderNotional", "maxDiscretionaryOrdersPerMonth", "minHoldTradingDaysForSell", "trailingStopPct",
            "lockoutTradingDays", "cashLikeTickers", "etfTickers", "lockedOut", "universeSize", "universe");

    /** 대기 주문 상태 — 기준 시각이 지남(현실에서는 이미 체결됐을 주문 — ⑩이 대신하지 않음). */
    static final String PENDING_DUE = "기준 시각 지남(체결 예정)";
    /** 대기 주문 상태 — 기준 시각 전(REPLACE가 대신함). */
    static final String PENDING_AHEAD = "대기";

    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT);

    /**
     * 자유 시점 판의 장중 판단으로 조립할 때의 차이(ADR 0027 결정 3) — 없으면(null) 끈 판 장중 확인.
     *
     * @param book     계좌 코드(미국 Claude 계좌1·계좌2)
     * @param slot     그 세션의 몇 번째 판단인가(결정 종류 {@code INTRADAY_<slot>})
     * @param max      그 호출이 읽은 설정의 세션당 장중 판단 횟수
     * @param manual   운영자가 당긴 판단인가
     * @param origin   그 계획 행을 누가 만들었나({@code PaperStore.IntradayPlan.ORIGINS} — ADR 0031, null이면 수동 표시로 정함)
     * @param trigger  사건이 당기거나 더하거나 붙인 판단이면 그 사건(계획 행의 {@code trigger} — {@code originalAt}·{@code events}), 없으면 null
     * @param replaces  이 판단의 {@code nextCheckpoint}가 대신하게 될 남은 예약(다음 순번의 PLANNED 행), 없으면 null
     * @param later     그대로 남는 뒤 예약(다음 순번 뒤의 PLANNED 행 — {@link Reserved#later}), 없으면 null. {@code nextCheckpoint}는 그 시각보다
     *                  {@link IntradayRequest#MIN_GAP} 이상 앞이어야 합니다(QA-309)
     * @param stopWatch 장중 스탑 감시가 주문을 내는 판인가({@code stopWatch.mode} ON — {@code 1_basis.stopWatch}·스탑 줄, ADR 0032)
     */
    record Free(String book, int slot, int max, boolean manual, String origin, JsonNode trigger, Reserved replaces, Reserved later,
                boolean stopWatch) {

        Free {
            Objects.requireNonNull(book, "book");
            origin = origin != null ? origin : manual ? PaperStore.IntradayPlan.ORIGIN_MANUAL : PaperStore.IntradayPlan.ORIGIN_RESERVED;
            trigger = trigger == null || trigger.isNull() || trigger.isMissingNode() ? null : trigger;
        }

        /** 그대로 남는 뒤 예약 없이. */
        Free(String book, int slot, int max, boolean manual, String origin, JsonNode trigger, Reserved replaces, boolean stopWatch) {
            this(book, slot, max, manual, origin, trigger, replaces, null, stopWatch);
        }

        /** 장중 스탑 감시 OFF·SHADOW 판. */
        Free(String book, int slot, int max, boolean manual, String origin, JsonNode trigger, Reserved replaces) {
            this(book, slot, max, manual, origin, trigger, replaces, null, false);
        }

        /** 출처·사건·남은 예약 없이(운영자 행이면 출처 MANUAL, 아니면 RESERVED). */
        Free(String book, int slot, int max, boolean manual) {
            this(book, slot, max, manual, null, null, null);
        }

        /** 이 판단의 결정 종류. */
        String kind() {
            return RuleBookService.intradayKind(slot);
        }

        /** 이 판단 뒤 이 세션에 남은 장중 판단 횟수 — min(세션당 횟수, 코드가 부를 수 있는 순번 수) − 순번(0 아래면 0). */
        int remaining() {
            return Math.max(0, Math.min(max, RuleBookService.INTRADAY_MAX) - slot);
        }
    }

    /**
     * 남은 예약 하나 — 이 판단의 {@code nextCheckpoint}가 대신하게 될 다음 순번의 PLANNED 행(그 시장 현지 시각과 출처).
     *
     * @param at     예약 시각(그 시장 현지 시각)
     * @param origin 그 행의 출처
     */
    record Reserved(LocalTime at, String origin) {

        Reserved {
            Objects.requireNonNull(at, "at");
        }

        /** 그 세션 행들에서 {@code slot} 다음 순번의 PLANNED 행(없으면 null). */
        static Reserved after(List<PaperStore.IntradayPlan> rows, int slot) {
            for (PaperStore.IntradayPlan p : rows) {
                if (p.slot() == slot + 1 && PaperBooks.CHECKPOINT_PLANNED.equals(p.status())) {
                    return new Reserved(p.atLocal(), p.origin());
                }
            }
            return null;
        }

        /**
         * 그 세션 행들에서 {@code nextCheckpoint}가 대신하지 않고 그대로 남는 뒤 예약 — {@code slot} + 1 뒤 순번의 PLANNED 행 가운데 가장 앞 순번
         * ({@link IntradayPlanner#laterPlanned}, 없으면 null).
         */
        static Reserved later(List<PaperStore.IntradayPlan> rows, int slot) {
            PaperStore.IntradayPlan p = IntradayPlanner.laterPlanned(rows, slot);
            return p == null ? null : new Reserved(p.atLocal(), p.origin());
        }
    }

    /** 장중 판단 패킷 지시문의 출처 한 줄(켠 판 — 1_basis.origin의 값과 뜻). */
    static final String ORIGIN_LINE = "1_basis.origin은 이 판단의 시각을 누가 정했나다 — RESERVED(이 세션의 결정이 예약)·NEXT(앞선 장중 판단이 예약)·"
            + "GUARANTEE(코드 보장 — 이 세션에 장중 판단이 아직 없어 세션 중간에)·EVENT(코드 사건 규칙이 앞당기거나 더함)·MANUAL(운영자). "
            + "이 판단 뒤 이 세션에 남은 횟수는 1_basis.remainingJudgments다.";

    /** 사건(trigger)이 있는 판단의 지시문 한 줄(켠 판). */
    static String triggerLine(String requestSection) {
        return requestSection + ".trigger가 있으면 코드 사건 규칙이 그 사건으로 이 판단을 앞당기거나 더했거나 이 판단에 그 사건을 붙인 것이다 — 그 사건부터 "
                + "본다. 사건은 판단할 계기일 뿐 매매하라는 뜻이 아니고, 이미 대기 중인 스탑 매도는 코드가 집행한다.";
    }

    /** 출처에 따른 요청 칸의 한 줄 설명(켠 판 — 운영자·보장·사건만, 그 밖은 null). */
    static String originNote(boolean manual, String origin) {
        return originNote(manual, origin, null);
    }

    /**
     * {@link #originNote(boolean, String)}에 그 행의 질문을 함께 본 것 — 고정 일정 판(ADR 0039)의 고정 시각 행은 보장 행과 같은 출처지만 질문이
     * 고정 시각의 것이라, 그 행에는 '보장'이 아니라 '고정 시각' 설명을 답니다.
     */
    static String originNote(boolean manual, String origin, String question) {
        if (!manual && PaperStore.IntradayPlan.ORIGIN_GUARANTEE.equals(origin)
                && (IntradayScheduler.FIXED_QUESTION_OPEN.equals(question) || IntradayScheduler.FIXED_QUESTION_CLOSE.equals(question))) {
            return "코드가 정한 고정 시각의 판단이다(개장 1시간 뒤·마감 40분 전) — 예약한 판단이 아니고, 이 판단 뒤의 예약(nextCheckpoint)도 받지 않는다";
        }
        if (manual) {
            return "운영자가 당긴 판단이다 — 예약한 시각이 아니라 지금 부른다";
        }
        if (PaperStore.IntradayPlan.ORIGIN_GUARANTEE.equals(origin)) {
            return "코드가 넣은 보장 판단이다 — 이 세션에 장중 판단이 아직 없어 세션 중간에 한 번 부른다(예약한 판단이 아님)";
        }
        if (PaperStore.IntradayPlan.ORIGIN_EVENT.equals(origin)) {
            return "코드 사건 규칙이 앞당기거나 더한 판단이다 — trigger의 사건이 그 까닭이다";
        }
        return null;
    }

    /**
     * 요청 칸의 사건({@code trigger}) — 계획 행의 사건을 그대로(원래 시각은 그 시장 시각 이름 {@code originalAt<Et|Kst>}로) 싣고 규칙 한 줄을 더합니다.
     * 사건이 없으면 null.
     */
    static Map<String, Object> triggerView(JsonNode trigger, boolean korea) {
        if (trigger == null || !trigger.isObject()) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        String original = Json.asText(trigger, "originalAt");
        out.put(korea ? "originalAtKst" : "originalAtEt", original);
        JsonNode events = trigger.get("events");
        out.put("events", events != null && events.isArray() ? events : List.of());
        out.put("rule", IntradayScheduler.eventRule(korea));
        return out;
    }

    /**
     * 조립 재료.
     *
     * @param checkpoint       그 세션의 PLANNED 장중 확인 행(자유 시점 판이면 장중 판단 계획 행을 같은 모양으로 — {@code IntradayPlan.asCheckpoint})
     * @param asOf             아침 결정의 기준 거래일 d
     * @param morning          요청을 낸 아침 결정 행(보낸 패킷의 selectionAsOf·8_prices·12_hardRules를 읽음)
     * @param state            계좌2 장부 상태(현금·순자산)
     * @param positions        계좌2 보유
     * @param pending          계좌2 대기 주문(출처 CLAUDE)
     * @param todayFills       계좌2의 E 세션 체결
     * @param watch            감시 저장본(MINUTE — 없으면 empty)
     * @param quotes           시간별 관측치(HOURLY — 없으면 empty)
     * @param macroCards       매크로 카드 섹션(아침 패킷 빌더의 시장 입력 그대로)
     * @param frameworkVersion 시스템 프롬프트로 쓴 프레임 판
     * @param settingsVersion  읽은 설정 판
     * @param recentLags       최근 장중 확인(DONE·MINUTE)이 잰 지연(초), 최근 순 — 등급의 5세션 기준
     * @param calendar         미국 달력
     * @param assembledAt      조립 시각(⑨)
     * @param bars             1분봉 저장본(예상 상태의 T 가격 — 없으면 empty, 조립 뒤에 받은 것은 쓰지 않음)
     * @param free             자유 시점 판의 장중 판단이면 그 차이({@link Free}), 끈 판 장중 확인이면 null
     */
    record Inputs(Checkpoint checkpoint, LocalDate asOf, Decision morning, BookState state, List<Position> positions,
                  List<Order> pending, List<Fill> todayFills, Optional<Snapshot> watch, Optional<Quotes> quotes,
                  JsonNode macroCards, Integer frameworkVersion, Integer settingsVersion, List<Integer> recentLags,
                  TradingCalendar calendar, Instant assembledAt, Optional<Snapshot> bars, Free free) {

        /** 끈 판 장중 확인(계좌2 단계 2) — 자유 시점 판 칸({@code free}) 없이. */
        Inputs(Checkpoint checkpoint, LocalDate asOf, Decision morning, BookState state, List<Position> positions,
               List<Order> pending, List<Fill> todayFills, Optional<Snapshot> watch, Optional<Quotes> quotes,
               JsonNode macroCards, Integer frameworkVersion, Integer settingsVersion, List<Integer> recentLags,
               TradingCalendar calendar, Instant assembledAt, Optional<Snapshot> bars) {
            this(checkpoint, asOf, morning, state, positions, pending, todayFills, watch, quotes, macroCards,
                    frameworkVersion, settingsVersion, recentLags, calendar, assembledAt, bars, null);
        }

        /** 1분봉 저장본 없이(예상 상태는 감시 봉·마지막 가격으로). */
        Inputs(Checkpoint checkpoint, LocalDate asOf, Decision morning, BookState state, List<Position> positions,
               List<Order> pending, List<Fill> todayFills, Optional<Snapshot> watch, Optional<Quotes> quotes,
               JsonNode macroCards, Integer frameworkVersion, Integer settingsVersion, List<Integer> recentLags,
               TradingCalendar calendar, Instant assembledAt) {
            this(checkpoint, asOf, morning, state, positions, pending, todayFills, watch, quotes, macroCards,
                    frameworkVersion, settingsVersion, recentLags, calendar, assembledAt, Optional.empty());
        }

        Inputs {
            Objects.requireNonNull(checkpoint, "checkpoint");
            Objects.requireNonNull(asOf, "asOf");
            Objects.requireNonNull(calendar, "calendar");
            Objects.requireNonNull(assembledAt, "assembledAt");
            positions = positions == null ? List.of() : List.copyOf(positions);
            pending = pending == null ? List.of() : List.copyOf(pending);
            todayFills = todayFills == null ? List.of() : List.copyOf(todayFills);
            watch = watch == null ? Optional.empty() : watch;
            quotes = quotes == null ? Optional.empty() : quotes;
            recentLags = recentLags == null ? List.of() : List.copyOf(recentLags);
            bars = bars == null ? Optional.empty() : bars;
        }

        /** 예상 상태(§10-6) — 조립 시각 이전 자료만(⑨: 1분봉·감시 저장본은 조립 전에 받은 것). 작업의 검증 문맥과 같은 함수. */
        ExpectedState.State expected() {
            JsonNode barsPayload = bars.filter(s -> s.collectedAt() != null && !s.collectedAt().isAfter(assembledAt))
                    .map(Snapshot::payload).orElse(null);
            JsonNode watchPayload = watch.filter(s -> s.collectedAt() != null && !s.collectedAt().isAfter(assembledAt))
                    .map(Snapshot::payload).orElse(null);
            return ExpectedState.of(state, positions, pending, checkpoint.sessionDate(), assembledAt, barsPayload,
                    watchPayload, quotes.filter(q -> q.collectedAt() != null && !q.collectedAt().isAfter(assembledAt))
                            .orElse(null), calendar);
        }
    }

    /** 패킷 하나(클래스 설명). 메모 번호·측정은 없습니다. */
    static PacketBuilder.Packet build(Inputs in, ObjectMapper mapper) {
        return build(in, mapper, null);
    }

    /**
     * {@link #build(Inputs, ObjectMapper)}에 판단 이어받기(ADR 0038)의 칸을 더한 패킷 — {@code extra}가 있으면 그 세션 결정의 요약·주문 논거
     * ({@value Continuity#INTRADAY_DECISION}), 그 결정의 조건을 이 패킷의 값(매크로 카드·시세의 마지막 값)으로 다시 매긴
     * {@value Continuity#INTRADAY_CARRIED}(전 거래일 종가 포함), 그 결정 뒤의 사건 뉴스({@value Continuity#INTRADAY_EVENTS}), 보유 행의 진입
     * 논거({@code entry})가 실립니다. null이면 예전 패킷과 바이트까지 같습니다.
     */
    static PacketBuilder.Packet build(Inputs in, ObjectMapper mapper, Continuity.Intraday extra) {
        JsonNode morningPacket = in.morning() == null ? null
                : in.morning().packet() != null ? in.morning().packet()
                : PacketBuilder.readSent(in.morning().packetText(), mapper);
        LocalDate session = in.checkpoint().sessionDate();
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("0_instructions", in.free() == null ? instructions() : freeInstructions());
        root.put("1_basis", basis(in, session, morningPacket));
        root.put("2_macroCards", in.macroCards());
        root.put("3_request", request(in.checkpoint(), in.free()));
        Map<String, Object> portfolio = portfolio(in, session);
        Map<String, Object> feed = ExecutionSection.FEED_MINUTE.equals(in.checkpoint().feed()) ? minuteFeed(in, session)
                : hourlyFeed(in, morningPacket);
        if (extra != null) {
            Continuity.attachEntries(portfolio.get("positions"), extra.entries());
            JsonNode feedNode = PacketBuilder.toNode(feed);
            Map<String, Double> metrics = new LinkedHashMap<>(Continuity.usMacro(in.macroCards(), null));
            Map<String, Double> prices = new LinkedHashMap<>(Continuity.feedLast(feedNode));
            Continuity.table(feedNode, "ticker", "close").forEach(prices::putIfAbsent);
            prices.forEach(metrics::putIfAbsent);
            root.put(Continuity.INTRADAY_DECISION, Continuity.intradayDecision(in.morning()));
            Map<String, Object> carried = Continuity.intradayCarried(in.morning(), metrics);
            carried.put(Continuity.HOLDING_CHECKS, Continuity.attachChecks(portfolio.get("positions"), extra.checks(), metrics));
            Set<String> tickers = new LinkedHashSet<>(Continuity.tickers(portfolio.get("positions")));
            tickers.addAll(prices.keySet());
            carried.put("prevCloses", Continuity.prevCloses(morningPacket, "ticker", tickers));
            root.put(Continuity.INTRADAY_CARRIED, carried);
            if (extra.events() != null) {
                root.put(Continuity.INTRADAY_EVENTS, extra.events());
            }
        }
        root.put("4_portfolio", portfolio);
        root.put("5_feed", feed);
        root.put("6_hardRules", hardRules(morningPacket, in.free() != null, in.free() != null && in.free().stopWatch()));
        JsonNode body = PacketBuilder.toNode(root);
        String text = mapper.writer().without(SerializationFeature.INDENT_OUTPUT).writeValueAsString(body);
        int tokens = PacketBuilder.estimateTokens(text);
        if (tokens > CHECKPOINT_TARGET_TOKENS) {
            log.warn("장중 확인 패킷이 목표보다 큽니다: {} {} 약 {}토큰(목표 {})", session, in.checkpoint().feed(), tokens,
                    CHECKPOINT_TARGET_TOKENS);
        }
        return new PacketBuilder.Packet(body, text, PacketBuilder.sha256(text), List.of(), null);
    }

    // ------------------------------------------------------------------ 섹션
    private static Map<String, Object> instructions() {
        List<String> lines = List.of(
                "장중 확인이다 — 아침 결정(1_basis.sourceDecisionId)이 고른 시각에 한 번만 부른다. 재시도는 없다.",
                "자료는 조립 시각(1_basis.asOfInstant) 전에 끝난 봉·받은 값만 실었다. 지연 자료로 더 좋은 체결가를 얻을 수는 없다 — 체결은 늘 주문 뒤 그 시각의 1분봉이다.",
                "action이 KEEP이면 아무것도 바꾸지 않는다. REPLACE이면 기준 시각이 아직 오지 않은 대기 주문(4_portfolio.pending의 state '"
                        + PENDING_AHEAD + "')만 취소되고 새 주문을 받는다 — 기준 시각이 지난 주문은 체결 예정으로 남는다.",
                "주문 timing은 1_basis.remainingTimings 가운데 하나다. 주문마다 executionNote를 쓰고, 주문이 없으면 noTradeReason을 쓴다.",
                "시각 표기 …Et는 뉴욕 시각, …Kst는 한국 시각이다.");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("lines", lines);
        return out;
    }

    /** 자유 시점 판 장중 판단의 지시문 — 끈 판과 같은 뜻에 순번·남은 시점(장중 시장가·지정 시각·종가)·다음 판단 예약을 적습니다. */
    private static Map<String, Object> freeInstructions() {
        List<String> lines = List.of(
                "장중 판단이다 — 이 세션의 결정(1_basis.sourceDecisionId)이나 앞선 장중 판단이 예약한 시각, 또는 코드 규칙(보장·사건)·운영자가 정한 "
                        + "시각에 한 번만 부른다(1_basis.slot번째, 세션당 1_basis.maxPerSession번까지). 재시도는 없다.",
                ORIGIN_LINE,
                triggerLine("3_request"),
                "자료는 조립 시각(1_basis.asOfInstant) 전에 끝난 봉·받은 값만 실었다. 지연 자료로 더 좋은 체결가를 얻을 수는 없다 — 체결은 늘 주문 뒤 그 시각의 1분봉이다.",
                "action이 KEEP이면 아무것도 바꾸지 않는다. REPLACE이면 기준 시각이 아직 오지 않은 대기 주문(4_portfolio.pending의 state '"
                        + PENDING_AHEAD + "')만 취소되고 새 주문을 받는다 — 기준 시각이 지난 주문은 체결 예정으로 남는다.",
                "주문 timing은 1_basis.remainingTimings 가운데 하나다 — AT_MINUTE이면 atLocal(뉴욕 시각 HH:MM)을 1_basis.atMinute 범위 안에서 "
                        + "적는다. 주문마다 executionNote를 쓰고, 주문이 없으면 noTradeReason을 쓴다.",
                "다음 판단이 필요하면 nextCheckpoint에 시각을 적는다(1_basis.nextCheckpoint — available이 false면 적어도 버려진다). 필요 없으면 null로 둔다.",
                "시각 표기 …Et는 뉴욕 시각, …Kst는 한국 시각이다.");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("lines", lines);
        return out;
    }

    private static Map<String, Object> basis(Inputs in, LocalDate session, JsonNode morningPacket) {
        TradingCalendar calendar = in.calendar();
        Instant now = in.assembledAt();
        Instant close = calendar.closeInstant(session);
        Map<String, Object> out = new LinkedHashMap<>();
        Free free = in.free();
        out.put("checkpointVersion", CHECKPOINT_VERSION);
        out.put("variant", free == null ? PacketBuilder.VARIANT_CLAUDE2 : PacketBuilder.VARIANT_FREE);
        out.put("fixedRules", free == null ? PacketBuilder.CLAUDE2_FIXED_RULES_VERSION_C2 : PacketBuilder.FREE_FIXED_RULES_VERSION);
        out.put("book", free == null ? PaperBooks.CLAUDE2 : free.book());
        out.put("asOfTradingDate", in.asOf());
        out.put("session", session);
        out.put("decisionKind", free == null ? KIND : free.kind());
        if (free != null) {
            out.put("slot", free.slot());
            out.put("maxPerSession", free.max());
            out.put("manual", free.manual());
            out.put("origin", free.origin());
            out.put("remainingJudgments", free.remaining());
        }
        out.put("sourceDecisionId", in.checkpoint().sourceDecisionId());
        out.put("selectionAsOf", morningPacket == null ? null
                : Json.asText(Json.child(morningPacket, "1_basis"), "selectionAsOf"));
        out.put("asOfInstant", now.toString());
        out.put("nowEt", et(now, calendar));
        out.put("nowKst", Kst.stamp(now));
        out.put("closeEt", et(close, calendar));
        out.put("minutesToClose", Duration.between(now, close).toMinutes());
        out.put("earlyClose", calendar.isEarlyClose(session));
        if (free == null) {
            out.put("remainingTimings", remainingTimings(session, calendar, now));
        } else {
            Instant[] minutes = freeMinutes(session, calendar, now);
            out.put("remainingTimings", freeRemainingTimings(session, calendar, now));
            Map<String, Object> range = new LinkedHashMap<>();
            range.put("firstEt", minutes == null ? null : et(minutes[0], calendar));
            range.put("lastEt", minutes == null ? null : et(minutes[1], calendar));
            range.put("note", "AT_MINUTE 주문의 atLocal은 이 범위(양 끝 포함)의 뉴욕 시각 HH:MM — 주문 생성 + 60초 뒤의 분부터 마감 5분 전 앞까지. "
                    + "null이면 남은 분이 없다");
            out.put("atMinute", range);
            out.put("nextCheckpoint", nextCheckpoint(free, in.checkpoint(), session, calendar, now));
        }
        out.put("frameworkVersion", in.frameworkVersion());
        out.put("settingsVersion", in.settingsVersion());
        if (free != null && free.stopWatch()) {
            out.put("stopWatch", StopWatch.basis(false));
        }
        return out;
    }

    /** 장중 스탑 감시 ON 판 장중 판단 패킷의 하드 규칙 한 줄(켠 판 — 끈 판·OFF·SHADOW는 없음). */
    static final String STOP_WATCH_LINE = "트레일링 스탑은 코드가 장중 감시로 집행한다(1_basis.stopWatch.rule) — 스탑가 이하는 판단하지 않아도 팔리고, 대기 중인 "
            + "감시 스탑 매도가 있는 종목의 새 매수는 재진입 금지와 같게 거절된다.";

    /**
     * 아직 고를 수 있는 시점 — 기준 시각 T가 지금 + 60초보다 뒤(⑤)이고, 시각 지정 시점은 E 마감 전(조기 폐장일 13:00 뒤 AT_*는 없음). MARKET은 검증기와
     * 같은 규칙({@link UsTimedFills#closedTimings} — 지금 + 60초 뒤 첫 분이 정규장 안·마감 5분 전 앞)일 때만.
     */
    static List<String> remainingTimings(LocalDate session, TradingCalendar calendar, Instant now) {
        Instant close = calendar.closeInstant(session);
        Instant earliest = now.plus(ExecutionAudit.AFTER_CREATED);
        List<String> out = new ArrayList<>();
        for (String timing : TIMINGS) {
            if (PaperBooks.MARKET.equals(timing)) {
                if (calendar.isTradingDay(session) && UsTimedFills.closedTimings(List.of(timing),
                        calendar.previousTradingDay(session), now, calendar).isEmpty()) {
                    out.add(timing);
                }
                continue;
            }
            Instant at = ExecutionAudit.targetAt(timing, session, calendar);
            if (at == null || !at.isAfter(earliest)) {
                continue;
            }
            if (UsTimedFills.timed(timing) && !at.isBefore(close)) {
                continue;
            }
            out.add(timing);
        }
        return out;
    }

    /**
     * 자유 시점 판 장중 판단 주문이 아직 고를 수 있는 분 단위 지정 시각의 범위 {@code [첫 분, 마지막 분]} — 검증({@link FreeTiming#validation})과 같은
     * 규칙: 그 세션의 받는 범위({@link FreeTiming#window}) 안이고 지금 + 60초보다 뒤. 남은 분이 없으면 null.
     */
    static Instant[] freeMinutes(LocalDate session, TradingCalendar calendar, Instant now) {
        if (!calendar.isTradingDay(session)) {
            return null;
        }
        FreeTiming.Window window = FreeTiming.window(session, calendar, false);
        // 지금 + 60초보다 '뒤'인 첫 분 — (지금 + 60초)를 분으로 내린 뒤 + 1분(장중 시장가의 기준 분과 같은 식).
        Instant first = ExecutionAudit.marketTarget(now);
        if (first.isBefore(window.first())) {
            first = window.first();
        }
        return window.accepts(first) ? new Instant[]{first, window.last()} : null;
    }

    /**
     * 자유 시점 판 장중 판단 주문이 아직 고를 수 있는 시점({@link FreeTiming#INTRADAY_TIMINGS} 가운데) — 장중 시장가는 끈 판과 같은 규칙
     * ({@link UsTimedFills#closedTimings})에 더해 기준 분이 그 세션 첫 분(개장 10분 뒤 — {@link FreeTiming#window}) 이상일 때(검증
     * {@link FreeTiming#validation}의 하한과 같음), 분 단위 지정 시각은 남은 분이 있을 때({@link #freeMinutes}), 그날 종가는 마감 전일 때.
     */
    static List<String> freeRemainingTimings(LocalDate session, TradingCalendar calendar, Instant now) {
        List<String> out = new ArrayList<>();
        if (!calendar.isTradingDay(session)) {
            return out;
        }
        for (String timing : FreeTiming.INTRADAY_TIMINGS) {
            if (PaperBooks.MARKET.equals(timing)) {
                if (UsTimedFills.closedTimings(List.of(timing), calendar.previousTradingDay(session), now, calendar).isEmpty()
                        && !ExecutionAudit.marketTarget(now).isBefore(FreeTiming.window(session, calendar, false).first())) {
                    out.add(timing);
                }
            } else if (PaperBooks.AT_MINUTE.equals(timing)) {
                if (freeMinutes(session, calendar, now) != null) {
                    out.add(timing);
                }
            } else if (calendar.closeInstant(session).isAfter(now.plus(ExecutionAudit.AFTER_CREATED))) {
                out.add(timing);
            }
        }
        return out;
    }

    /**
     * 다음 판단을 예약할 수 있는가({@code 1_basis.nextCheckpoint}) — 순번이 남았고(이 판단의 순번 < 세션당 횟수) 받는 범위에 이 판단 시각 + 최소 간격
     * 뒤의 시각이 남아 있을 때. 범위는 {@link IntradayRequest#window}, 가장 이른 시각은 이 판단의 예약 시각 + {@link IntradayRequest#MIN_GAP}과
     * 지금(호출 창 시작이 지금보다 뒤 — 지금 − 2분의 다음 분) 가운데 늦은 쪽입니다. 가장 늦은 시각은 범위 끝이고, 그대로 남는 뒤 예약
     * ({@code laterReserved})이 있으면 그 시각 − {@link IntradayRequest#MIN_GAP}까지입니다(QA-309 — 계획 쓰기 {@link IntradayPlanner#next}와 같은 규칙).
     */
    private static Map<String, Object> nextCheckpoint(Free free, Checkpoint c, LocalDate session, TradingCalendar calendar,
                                                      Instant now) {
        IntradayRequest.Window window = IntradayRequest.window(session, calendar, false);
        Instant earliest = targetAt(c, calendar).plus(IntradayRequest.MIN_GAP);
        Instant afterNow = now.minus(PaperCheckpointJob.WINDOW_START).truncatedTo(java.time.temporal.ChronoUnit.MINUTES)
                .plus(Duration.ofMinutes(1));
        if (afterNow.isAfter(earliest)) {
            earliest = afterNow;
        }
        if (earliest.isBefore(window.first())) {
            earliest = window.first();
        }
        Instant last = window.last();
        if (free.later() != null) {
            Instant before = FreeTiming.at(session, free.later().at(), calendar).minus(IntradayRequest.MIN_GAP);
            if (before.isBefore(last)) {
                last = before;
            }
        }
        boolean room = free.slot() < Math.min(free.max(), RuleBookService.INTRADAY_MAX);
        boolean inWindow = room && calendar.isTradingDay(session) && !earliest.isAfter(window.last());
        boolean available = inWindow && !earliest.isAfter(last);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", available);
        out.put("firstEt", available ? et(earliest, calendar) : null);
        out.put("lastEt", available ? et(last, calendar) : null);
        out.put("minGapMinutes", IntradayRequest.MIN_GAP.toMinutes());
        out.put("replaces", reserved(free.replaces(), "atEt"));
        out.put("laterReserved", reserved(free.later(), "atEt"));
        out.put("note", nextCheckpointNote(room, inWindow, available, free.later() != null, "뉴욕 시각"));
        return out;
    }

    /** {@code 1_basis.nextCheckpoint.note} — 미국·한국 패킷이 같은 문장을 씁니다(시각 이름만 다름). */
    static String nextCheckpointNote(boolean room, boolean inWindow, boolean available, boolean later, String zoneName) {
        if (!room) {
            return "세션당 횟수를 다 썼다 — nextCheckpoint를 적어도 버려진다";
        }
        if (!inWindow) {
            return "받는 범위에 남은 시각이 없다 — nextCheckpoint를 적어도 버려진다";
        }
        if (!available) {
            return "그대로 남는 뒤 예약(laterReserved)보다 " + IntradayRequest.MIN_GAP.toMinutes()
                    + "분 앞에 남은 시각이 없다 — nextCheckpoint를 적어도 버려진다";
        }
        return "nextCheckpoint.at은 이 범위(양 끝 포함)의 " + zoneName + " HH:MM — 이 판단 시각과 " + IntradayRequest.MIN_GAP.toMinutes()
                + "분 이상 떨어져야 한다. 남은 예약이 있으면(replaces) 그 시각을 대신한다"
                + (later ? ". 그 뒤 예약(laterReserved)은 그대로 남으므로 범위의 끝은 그 시각 " + IntradayRequest.MIN_GAP.toMinutes() + "분 전이다" : "");
    }

    /** 남은 예약의 칸 — 시각(그 시장 시각 이름)과 출처, 없으면 null. */
    static Map<String, Object> reserved(Reserved replaces, String zoneField) {
        if (replaces == null) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put(zoneField, CLOCK.format(replaces.at()));
        out.put("origin", replaces.origin());
        return out;
    }

    private static Map<String, Object> request(Checkpoint c, Free free) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("atEt", CLOCK.format(c.atLocal()));
        out.put("feed", c.feed());
        out.put("watch", c.watch());
        out.put("question", c.question());
        if (free != null) {
            String note = originNote(free.manual(), free.origin(), c.question());
            if (note != null) {
                out.put("note", note);
            }
            out.put("trigger", triggerView(free.trigger(), false));
        }
        return out;
    }

    private static Map<String, Object> portfolio(Inputs in, LocalDate session) {
        TradingCalendar calendar = in.calendar();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("book", in.free() == null ? PaperBooks.CLAUDE2 : in.free().book());
        out.put("cash", in.state() == null ? null : PacketBuilder.decimal(in.state().cash(), 2));
        out.put("nav", in.state() == null ? null : PacketBuilder.decimal(in.state().nav(), 2));
        List<Map<String, Object>> positions = new ArrayList<>();
        for (Position p : in.positions()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", p.ticker());
            row.put("qty", p.qty());
            row.put("avgCost", PacketBuilder.decimal(p.avgCost(), 4));
            row.put("openedOn", p.openedOn());
            row.put("lastPrice", PacketBuilder.decimal(p.lastPrice(), 4));
            row.put("lastPriceAtKst", p.lastPriceAt() == null ? null : Kst.stamp(p.lastPriceAt()));
            positions.add(row);
        }
        out.put("positions", positions);
        List<Map<String, Object>> pending = new ArrayList<>();
        for (Order o : in.pending()) {
            Instant target = ExecutionAudit.targetAt(o, session, calendar);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("orderId", o.id());
            row.put("ticker", o.ticker());
            row.put("side", o.side());
            row.put("targetWeightPct", PacketBuilder.decimal(o.targetWeightPct(), 4));
            row.put("sellFraction", PacketBuilder.decimal(o.sellFraction(), 4));
            row.put("timing", o.timing());
            row.put("targetAtEt", target == null ? null : et(target, calendar));
            row.put("state", target != null && !target.isAfter(in.assembledAt()) ? PENDING_DUE : PENDING_AHEAD);
            pending.add(row);
        }
        out.put("pending", pending);
        List<Map<String, Object>> fills = new ArrayList<>();
        for (Fill f : in.todayFills()) {
            if (f.observedAt() != null && f.observedAt().isAfter(in.assembledAt())) {
                continue;   // ⑨ — 조립 뒤에 장부에 든 체결은 싣지 않음
            }
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("orderId", f.orderId());
            row.put("ticker", f.ticker());
            row.put("side", f.side());
            row.put("qty", f.qty());
            row.put("rawPrice", PacketBuilder.decimal(f.rawPrice(), 4));
            row.put("observedAtKst", f.observedAt() == null ? null : Kst.stamp(f.observedAt()));
            fills.add(row);
        }
        out.put("todayFills", fills);
        // 예상 상태(기준 시각이 지난 대기 주문을 체결로 본 장부 — §10-6, 추정) — 확인 응답의 검증 문맥과 같은 계산.
        out.put("expected", in.expected().toMap(calendar));
        return out;
    }

    // ------------------------------------------------------------------ 5_feed
    private static Map<String, Object> minuteFeed(Inputs in, LocalDate session) {
        Instant now = in.assembledAt();
        TradingCalendar calendar = in.calendar();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("feed", ExecutionSection.FEED_MINUTE);
        out.put("source", Datasets.SNAP_PAPER_WATCH_US);
        Snapshot snapshot = in.watch().orElse(null);
        JsonNode payload = snapshot == null ? null : snapshot.payload();
        String status;
        if (snapshot == null || payload == null) {
            status = "NO_SNAPSHOT";
        } else if (snapshot.collectedAt() == null || snapshot.collectedAt().isAfter(now)) {
            status = "AFTER_ASSEMBLY";   // ⑨ — 조립 뒤에 받은 저장본은 싣지 않음
        } else if (!matches(payload, in.checkpoint(), in.free())) {
            status = "OTHER_CHECKPOINT";
        } else {
            status = "OK";
        }
        boolean ok = "OK".equals(status);
        out.put("status", status);
        out.put("fetchedAtKst", ok ? Kst.stamp(snapshot.collectedAt()) : null);
        out.put("ageSeconds", ok ? Duration.between(snapshot.collectedAt(), now).getSeconds() : null);
        Integer lag = ok ? integer(payload.get("lagSeconds")) : null;
        out.put("lagSeconds", lag);
        out.put("declaredDelayMin", null);
        Map<String, Object> tickers = new LinkedHashMap<>();
        int droppedTickers = 0;
        int droppedBars = 0;
        int otherSession = 0;
        Instant referenceEnd = null;
        // 자유 시점 판: 저장본 한 장이 창 안 계획 여럿(다른 계좌 포함)의 종목을 실으므로 이 계획의 종목만 — 감시 목록·보유·대기·기준 종목.
        Set<String> scope = in.free() == null ? null : feedScope(in, payload);
        if (ok && payload.path("tickers").isObject()) {
            for (Map.Entry<String, JsonNode> e : payload.get("tickers").properties()) {
                if (scope != null && !scope.contains(e.getKey())) {
                    continue;
                }
                JsonNode entry = e.getValue();
                Instant fetched = instant(entry.get("fetchedAt"));
                if (fetched == null || fetched.isAfter(now)) {
                    droppedTickers++;
                    continue;
                }
                if (!session.toString().equals(Json.asText(entry, "session"))) {
                    otherSession++;   // 임시 휴장·지난 세션 봉 — E가 아님
                    continue;
                }
                List<List<Object>> rows = new ArrayList<>();
                Instant lastTraded = null;
                Double last = null;
                Instant lastAt = null;
                for (JsonNode bar : entry.path("bars")) {
                    Instant t = instant(bar.get("t"));
                    if (t == null || t.plus(BAR).isAfter(now)) {
                        droppedBars++;
                        continue;
                    }
                    List<Object> row = new ArrayList<>(6);
                    row.add(et(t, calendar));
                    row.add(number(bar.get("o")));
                    row.add(number(bar.get("h")));
                    row.add(number(bar.get("l")));
                    row.add(number(bar.get("c")));
                    row.add(integerLong(bar.get("v")));
                    rows.add(row);
                    last = number(bar.get("c"));
                    lastAt = t;
                    Long volume = integerLong(bar.get("v"));
                    if (volume != null && volume > 0) {
                        lastTraded = t.plus(BAR);
                    }
                }
                if (rows.size() > BARS_SHOWN) {
                    rows = new ArrayList<>(rows.subList(rows.size() - BARS_SHOWN, rows.size()));
                }
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("dayOpen", number(entry.path("day").get("open")));
                view.put("dayHigh", number(entry.path("day").get("high")));
                view.put("dayLow", number(entry.path("day").get("low")));
                view.put("last", last);
                view.put("lastBarEt", lastAt == null ? null : et(lastAt, calendar));
                view.put("secondsSinceLastTrade", lastTraded == null ? null : Duration.between(lastTraded, now).getSeconds());
                view.put("isStale", entry.path("isStale").isBoolean() && entry.get("isStale").booleanValue());
                view.put("bars", rows);
                tickers.put(e.getKey(), view);
                if (REFERENCE.equals(e.getKey()) && lastAt != null) {
                    referenceEnd = lastAt.plus(BAR);
                }
            }
        }
        out.put("grade", grade(lag, in.recentLags(), stalled(referenceEnd, ok, session, calendar, now)));
        out.put("recentLag", ExecutionSection.lagSummary(in.recentLags().subList(0,
                Math.min(in.recentLags().size(), ExecutionSection.RECENT_LAG_SESSIONS))));
        Map<String, Object> dropped = new LinkedHashMap<>();
        dropped.put("tickersAfterAssembly", droppedTickers);
        dropped.put("barsAfterAssembly", droppedBars);
        dropped.put("otherSession", otherSession);
        out.put("dropped", dropped);
        out.put("barColumns", List.of("tEt", "o", "h", "l", "c", "v"));
        out.put("note", "완성된 1분봉(봉 시작 시각 tEt, 뉴욕)만 — 5분마다 수집. lagSeconds = 받은 시각 − (SPY 마지막 봉 시작 + 60초), "
                + "정규장 밖·모름은 null. secondsSinceLastTrade = 거래량이 있던 마지막 봉 끝부터 조립 시각까지(무거래 종목은 커서 지연과 섞지 않음)");
        out.put("tickers", tickers);
        return out;
    }

    /** 저장본이 이 확인(계좌·세션·시각 — 장중 판단이면 순번까지)을 싣고 있는가 — 수집기 모양의 신원({@link WatchIdentity}). */
    private static boolean matches(JsonNode payload, Checkpoint c, Free free) {
        return WatchIdentity.carries(payload, WatchIdentity.US_AT, c.bookCode(), c.sessionDate(), CLOCK.format(c.atLocal()),
                free == null ? null : free.slot());
    }

    /** 자유 시점 판 MINUTE 피드에 싣는 종목 — 그 계획의 감시 목록 ∪ 그 계좌 보유·대기 ∪ 기준 종목(저장본의 reference)·QQQ. */
    private static Set<String> feedScope(Inputs in, JsonNode payload) {
        Set<String> out = new LinkedHashSet<>(in.checkpoint().watch());
        in.positions().forEach(p -> out.add(p.ticker()));
        in.pending().forEach(o -> out.add(o.ticker()));
        out.add(REFERENCE);
        out.add("QQQ");
        return out;
    }

    /** 정규장 안인데 기준 종목의 새 봉이 {@link #STALL}보다 오래 없음(§7-3 '멈춤'). 기준 종목이 없으면 거짓(모름). */
    private static boolean stalled(Instant referenceEnd, boolean ok, LocalDate session, TradingCalendar calendar,
                                   Instant now) {
        if (!ok || referenceEnd == null) {
            return false;
        }
        boolean regular = !now.isBefore(calendar.openInstant(session)) && now.isBefore(calendar.closeInstant(session));
        return regular && Duration.between(referenceEnd, now).compareTo(STALL) > 0;
    }

    /**
     * 신선도 등급(§7-3) — 이번 지연 모름이면 '지연 모름', 멈춤, 이번 값 > {@value #DELAY_AFTER_SECONDS}초면 '지연 n분(측정)', 최근
     * {@value ExecutionSection#RECENT_LAG_SESSIONS}세션 p95 ≤ {@value #NEAR_P95_SECONDS}초면 '준실시간(측정)', 그 밖(세션이 모자람)은 '지연 모름'.
     */
    static String grade(Integer lag, List<Integer> recentLags, boolean stalled) {
        if (stalled) {
            return "멈춤";
        }
        if (lag == null) {
            return "지연 모름";
        }
        if (lag > DELAY_AFTER_SECONDS) {
            return "지연 " + Math.round(lag / 60.0) + "분(측정)";
        }
        List<Integer> window = recentLags.subList(0, Math.min(recentLags.size(), ExecutionSection.RECENT_LAG_SESSIONS));
        Map<String, Object> summary = ExecutionSection.lagSummary(window);
        if (summary != null && ((Integer) summary.get("p95")) <= NEAR_P95_SECONDS) {
            return "준실시간(측정)";
        }
        return "지연 모름";
    }

    private static Map<String, Object> hourlyFeed(Inputs in, JsonNode morningPacket) {
        Instant now = in.assembledAt();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("feed", ExecutionSection.FEED_HOURLY);
        out.put("source", Datasets.SNAP_PAPER_QUOTES);
        Quotes quotes = in.quotes().orElse(null);
        String status = quotes == null ? "NO_SNAPSHOT"
                : quotes.collectedAt() == null || quotes.collectedAt().isAfter(now) ? "AFTER_ASSEMBLY" : "OK";
        boolean ok = "OK".equals(status);
        out.put("status", status);
        out.put("collectedAtKst", ok ? Kst.stamp(quotes.collectedAt()) : null);
        out.put("ageSeconds", ok ? Duration.between(quotes.collectedAt(), now).getSeconds() : null);
        Set<String> targets = new LinkedHashSet<>(in.checkpoint().watch());
        in.positions().forEach(p -> targets.add(p.ticker()));
        in.pending().forEach(o -> targets.add(o.ticker()));
        if (morningPacket != null) {
            for (JsonNode row : morningPacket.path("8_prices").path("rows")) {
                if (row.isArray() && !row.isEmpty() && row.get(0).isString()) {
                    targets.add(row.get(0).asString());
                }
            }
        }
        List<List<Object>> rows = new ArrayList<>();
        int omitted = 0;
        for (String ticker : targets) {
            if (rows.size() >= HOURLY_MAX) {
                omitted++;
                continue;
            }
            Bar bar = ok ? quotes.bars().get(ticker) : null;
            List<Object> row = new ArrayList<>(4);
            row.add(ticker);
            row.add(bar == null ? null : bar.date());
            row.add(bar == null ? null : PacketBuilder.decimal(bar.close(), 4));
            row.add(bar == null ? null : bar.stale());
            rows.add(row);
        }
        out.put("columns", List.of("ticker", "barDate", "close", "stale"));
        out.put("rows", rows);
        out.put("omitted", omitted);
        out.put("note", "시간별 관측치 — 최대 60분 묵은 값(collectedAtKst에 받음). close가 null이면 그 종목 값 없음, stale = 이번에 받지 못해 "
                + "이어 쓴 값. 봉 날짜가 세션보다 앞이면 그날 장중 값이 아직 없음");
        return out;
    }

    private static Map<String, Object> hardRules(JsonNode morningPacket, boolean free, boolean stopWatch) {
        Map<String, Object> out = new LinkedHashMap<>();
        List<String> lines = free ? freeHardRuleLines(stopWatch) : List.of(
                "주문 timing은 " + String.join("·", TIMINGS) + " 가운데 기준 시각이 지금 + 60초보다 뒤인 것(1_basis.remainingTimings)만 "
                        + "받는다 — 지난 시점은 LATE_FOR_TIMING, 조기 폐장일 마감 뒤 시점은 MALFORMED로 거절. MARKET은 응답 뒤 생성 + 60초가 "
                        + "지난 첫 분의 1분봉 시가로 체결하고, 그 분이 마감 5분 전(조기 폐장일 12:55 ET) 이후면 MALFORMED로 거절.",
                "REPLACE는 기준 시각이 아직 오지 않은 대기 주문만 대신한다(취소) — 기준 시각이 지난 대기 주문은 이미 체결된 주문으로 보고 자료가 "
                        + "오는 대로 체결한다. 형식 검사를 통과하면 새 주문이 모두 거절돼도 그 취소는 일어난다. KEEP은 아무것도 바꾸지 않는다.",
                "한도·재량 매도 보유 기간·월 상한·재진입 금지는 아침 결정과 같다(아래 값).");
        out.put("lines", lines);
        JsonNode morning = morningPacket == null ? null : morningPacket.get("12_hardRules");
        for (String key : HARD_RULE_KEYS) {
            out.put(key, morning == null || !morning.has(key) ? null : morning.get(key));
        }
        return out;
    }

    /** 자유 시점 판 장중 판단의 하드 규칙 줄 — 장중 스탑 감시 ON이면 스탑 줄({@link #STOP_WATCH_LINE})을 끝에 더함. */
    private static List<String> freeHardRuleLines(boolean stopWatch) {
        List<String> lines = new ArrayList<>(List.of(
                "주문 timing은 " + String.join("·", FreeTiming.INTRADAY_TIMINGS) + " 가운데 아직 고를 수 있는 것(1_basis.remainingTimings)만 받는다. "
                        + "MARKET은 응답 뒤 생성 + 60초가 지난 첫 분의 1분봉 시가로 체결하고, 그 분이 마감 5분 전(조기 폐장일 12:55 ET) 이후면 "
                        + "MALFORMED로 거절. AT_MINUTE은 atLocal의 분에 시작한 1분봉 시가 — atLocal이 없거나 받는 범위 밖이면 MALFORMED, 주문 생성 "
                        + "+ 60초 이전의 분이면 LATE_FOR_TIMING으로 거절(1_basis.atMinute). NEXT_CLOSE는 이 세션 확정 종가.",
                "매도는 같은 시각이거나 더 늦은 시각 매수의 현금·종목 자리만 만든다(기준 시각 순 — MARKET < AT_MINUTE(이른 순) < NEXT_CLOSE).",
                "REPLACE는 기준 시각이 아직 오지 않은 대기 주문만 대신한다(취소) — 기준 시각이 지난 대기 주문은 이미 체결된 주문으로 보고 자료가 "
                        + "오는 대로 체결한다. 형식 검사를 통과하면 새 주문이 모두 거절돼도 그 취소는 일어난다. KEEP은 아무것도 바꾸지 않는다.",
                "한도·재량 매도 보유 기간·월 상한·재진입 금지는 이 세션의 결정과 같다(아래 값)."));
        if (stopWatch) {
            lines.add(STOP_WATCH_LINE);
        }
        return lines;
    }

    // ------------------------------------------------------------------ 값
    private static String et(Instant at, TradingCalendar calendar) {
        return CLOCK.format(at.atZone(calendar.zone()).toLocalTime());
    }

    /** 확인 시각 T — 그 세션 날짜의 뉴욕 시각. */
    static Instant targetAt(Checkpoint c, TradingCalendar calendar) {
        return ZonedDateTime.of(c.sessionDate(), c.atLocal(), calendar.zone()).toInstant();
    }

    private static Instant instant(JsonNode node) {
        if (node == null || !node.isString()) {
            return null;
        }
        try {
            return java.time.OffsetDateTime.parse(node.asString()).toInstant();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static Double number(JsonNode node) {
        return node == null || !node.isNumber() ? null : node.asDouble();
    }

    private static Long integerLong(JsonNode node) {
        return node == null || !node.isNumber() ? null : node.asLong();
    }

    private static Integer integer(JsonNode node) {
        return node == null || !node.isNumber() ? null : node.asInt();
    }

    /** 확인 시각 'HH:mm'. */
    static String clock(LocalTime t) {
        return CLOCK.format(t);
    }
}
