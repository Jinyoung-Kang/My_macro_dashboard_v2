package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Bar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.Datasets;
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
 * 🧪 미국 Claude 계좌2의 장중 확인 패킷({@code checkpointVersion} 1 — 계좌2 명세 2026-10-30-claude-book2-timing-design.md §5-2·§7-3·§8 ⑨·§9-5,
 * ADR 0022). 아침 결정이 고른 시각(확인 시각 + 2~20분)에 장중 확인 작업이 한 번 보내는 사용자 메시지입니다. 시스템 프롬프트는 아침 결정과 같은
 * c2-2 렌더링이고, 응답 스키마는 {@value #SCHEMA_RESOURCE}입니다.
 *
 * <p>섹션: {@code 0_instructions} · {@code 1_basis}(판·세션·지금 시각·마감까지 분·남은 시점) · {@code 2_macroCards}(아침 패킷과 같은 매크로 카드 —
 * 각자의 지연 배지 그대로) · {@code 3_request}(아침의 요청) · {@code 4_portfolio}(장부 현금·순자산·보유·대기 주문과 그 상태·오늘 체결 —
 * 예상 상태({@code expected})는 아직 null, §10-6) · {@code 5_feed}(MINUTE = 감시 저장본의 최근 완성 1분봉 / HOURLY = 시간별 관측치) ·
 * {@code 6_hardRules}(아침 패킷 12_hardRules의 한도 + 장중 확인 메뉴·⑩ 범위 문장).
 *
 * <p><b>⑨ 조립 시각 이전 자료만</b>: 봉은 끝(시작 + 60초)이, 종목·저장본은 받은 시각이 조립 시각({@code asOfInstant}) 이하인 것만 싣고 나머지는
 * 버린 뒤 그 수를 적습니다({@code 5_feed.dropped}). 주문의 {@code created_at}은 응답 뒤 DB now()라 늘 이 시각보다 늦습니다(작업 시험이 단언).
 *
 * <p>입력({@link Inputs})을 받아 조립만 합니다 — 저장소·저장본을 읽지 않아 같은 입력이면 같은 글자입니다(고정본 시험).
 */
final class CheckpointPacket {

    private CheckpointPacket() {
    }

    private static final Logger log = LoggerFactory.getLogger(CheckpointPacket.class);

    /** 장중 확인 패킷 판. */
    static final int CHECKPOINT_VERSION = 1;
    /** 장중 확인 응답 스키마(API용과 검사용이 같은 파일 — D26). */
    static final String SCHEMA_RESOURCE = "paper/claude2-checkpoint.schema.json";
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

    /** 장중 확인 주문이 받는 체결 시점(스키마 timing enum과 같은 목록, 이른 것부터). */
    static final List<String> TIMINGS = List.of("AT_1000", "AT_1100", "AT_1200", "AT_1300", "AT_1400", "AT_1500",
            PaperBooks.NEXT_CLOSE);

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
     * 조립 재료.
     *
     * @param checkpoint       그 세션의 PLANNED 장중 확인 행
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
     */
    record Inputs(Checkpoint checkpoint, LocalDate asOf, Decision morning, BookState state, List<Position> positions,
                  List<Order> pending, List<Fill> todayFills, Optional<Snapshot> watch, Optional<Quotes> quotes,
                  JsonNode macroCards, Integer frameworkVersion, Integer settingsVersion, List<Integer> recentLags,
                  TradingCalendar calendar, Instant assembledAt) {

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
        }
    }

    /** 패킷 하나(클래스 설명). 메모 번호·측정은 없습니다. */
    static PacketBuilder.Packet build(Inputs in, ObjectMapper mapper) {
        JsonNode morningPacket = in.morning() == null ? null
                : in.morning().packet() != null ? in.morning().packet()
                : PacketBuilder.readSent(in.morning().packetText(), mapper);
        LocalDate session = in.checkpoint().sessionDate();
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("0_instructions", instructions());
        root.put("1_basis", basis(in, session, morningPacket));
        root.put("2_macroCards", in.macroCards());
        root.put("3_request", request(in.checkpoint()));
        root.put("4_portfolio", portfolio(in, session));
        root.put("5_feed", ExecutionSection.FEED_MINUTE.equals(in.checkpoint().feed()) ? minuteFeed(in, session)
                : hourlyFeed(in, morningPacket));
        root.put("6_hardRules", hardRules(morningPacket));
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

    private static Map<String, Object> basis(Inputs in, LocalDate session, JsonNode morningPacket) {
        TradingCalendar calendar = in.calendar();
        Instant now = in.assembledAt();
        Instant close = calendar.closeInstant(session);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("checkpointVersion", CHECKPOINT_VERSION);
        out.put("variant", PacketBuilder.VARIANT_CLAUDE2);
        out.put("fixedRules", PacketBuilder.CLAUDE2_FIXED_RULES_VERSION_C2);
        out.put("book", PaperBooks.CLAUDE2);
        out.put("asOfTradingDate", in.asOf());
        out.put("session", session);
        out.put("decisionKind", KIND);
        out.put("sourceDecisionId", in.checkpoint().sourceDecisionId());
        out.put("selectionAsOf", morningPacket == null ? null
                : Json.asText(Json.child(morningPacket, "1_basis"), "selectionAsOf"));
        out.put("asOfInstant", now.toString());
        out.put("nowEt", et(now, calendar));
        out.put("nowKst", Kst.stamp(now));
        out.put("closeEt", et(close, calendar));
        out.put("minutesToClose", Duration.between(now, close).toMinutes());
        out.put("earlyClose", calendar.isEarlyClose(session));
        out.put("remainingTimings", remainingTimings(session, calendar, now));
        out.put("frameworkVersion", in.frameworkVersion());
        out.put("settingsVersion", in.settingsVersion());
        return out;
    }

    /**
     * 아직 고를 수 있는 시점 — 기준 시각 T가 지금 + 60초보다 뒤(⑤)이고, 시각 지정 시점은 E 마감 전(조기 폐장일 13:00 뒤 AT_*는 없음).
     */
    static List<String> remainingTimings(LocalDate session, TradingCalendar calendar, Instant now) {
        Instant close = calendar.closeInstant(session);
        Instant earliest = now.plus(ExecutionAudit.AFTER_CREATED);
        List<String> out = new ArrayList<>();
        for (String timing : TIMINGS) {
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

    private static Map<String, Object> request(Checkpoint c) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("atEt", CLOCK.format(c.atEt()));
        out.put("feed", c.feed());
        out.put("watch", c.watch());
        out.put("question", c.question());
        return out;
    }

    private static Map<String, Object> portfolio(Inputs in, LocalDate session) {
        TradingCalendar calendar = in.calendar();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("book", PaperBooks.CLAUDE2);
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
            Instant target = ExecutionAudit.targetAt(o.timing(), session, calendar);
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
        // 예상 상태(기준 시각이 지난 대기 주문을 체결로 본 장부 — §10-6)는 다음 판에서 채웁니다.
        out.put("expected", null);
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
        } else if (!matches(payload, in.checkpoint())) {
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
        if (ok && payload.path("tickers").isObject()) {
            for (Map.Entry<String, JsonNode> e : payload.get("tickers").properties()) {
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

    /** 저장본이 이 확인(계좌·세션·시각)의 것인가 — 수집기 모양의 {@code checkpoint}. */
    private static boolean matches(JsonNode payload, Checkpoint c) {
        JsonNode cp = payload.get("checkpoint");
        return cp != null && c.bookCode().equals(Json.asText(cp, "book"))
                && c.sessionDate().toString().equals(Json.asText(cp, "sessionDate"))
                && CLOCK.format(c.atEt()).equals(Json.asText(cp, "atEt"));
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

    private static Map<String, Object> hardRules(JsonNode morningPacket) {
        Map<String, Object> out = new LinkedHashMap<>();
        List<String> lines = List.of(
                "주문 timing은 " + String.join("·", TIMINGS) + " 가운데 기준 시각이 지금 + 60초보다 뒤인 것(1_basis.remainingTimings)만 "
                        + "받는다 — 지난 시점은 LATE_FOR_TIMING, 조기 폐장일 마감 뒤 시점은 MALFORMED로 거절.",
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

    // ------------------------------------------------------------------ 값
    private static String et(Instant at, TradingCalendar calendar) {
        return CLOCK.format(at.atZone(calendar.zone()).toLocalTime());
    }

    /** 확인 시각 T — 그 세션 날짜의 뉴욕 시각. */
    static Instant targetAt(Checkpoint c, TradingCalendar calendar) {
        return ZonedDateTime.of(c.sessionDate(), c.atEt(), calendar.zone()).toInstant();
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
