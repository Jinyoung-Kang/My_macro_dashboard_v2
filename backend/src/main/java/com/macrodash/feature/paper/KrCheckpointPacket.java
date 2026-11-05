package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Checkpoint;
import com.macrodash.store.PaperStore.Decision;
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
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * 한국 Claude 계좌2 장중 확인 패킷(단계 2b — 명세 2026-11-02 §10) — 미국 {@link CheckpointPacket}의 한국판. 밤 결정(요청을 낸 결정)의 판단을 장중에 한
 * 번 다시 보게 하는 작은 패킷이고, 시스템 프롬프트는 한국 계좌2 고정 문단(장중 확인 절 포함) 그대로입니다.
 *
 * <ul>
 *   <li>{@code 0_instructions}: KEEP·REPLACE·대신하는 규칙·고를 수 있는 시점·자료 지연 문장('실시간'이라 쓰지 않음).</li>
 *   <li>{@code 1_basis}: 기준 거래일 d·세션 E·요청 결정·조립 시각·그날 개장·마감·남은 분·남은 시점·프레임·설정 판.</li>
 *   <li>{@code 2_request}: 확인 시각·질문·감시 목록.</li>
 *   <li>{@code 3_night}: 밤 결정 응답의 요약·국면·목표 노출·주문(Claude가 낸 그대로).</li>
 *   <li>{@code 4_portfolio}: 장부(현금·순자산·보유)·대기 주문(기준 시각·지났나)·예상 상태({@link KrExpectedState}).</li>
 *   <li>{@code 5_feed}: 감시 저장본({@code paper.watch.kr} — 조립 전에 받은 것만)의 종목마다 마지막 봉·최근 봉({@value #BARS_SHOWN}개 — [라벨, 시, 고, 저, 종,
 *       거래량])과 저장본 지연.</li>
 *   <li>{@code 12_hardRules}: 밤 패킷의 그 절 그대로 — 검증기의 한국 칸({@link KrClaudeValidation#checks})이 같은 유니버스·ETF·재진입 금지를 읽습니다.</li>
 * </ul>
 */
final class KrCheckpointPacket {

    private static final Logger log = LoggerFactory.getLogger(KrCheckpointPacket.class);

    private KrCheckpointPacket() {
    }

    /** 장중 확인 패킷 판. */
    static final int CHECKPOINT_VERSION = 1;
    /** 장중 확인 응답 스키마(미국과 같은 모양, 종목 코드만 6자리). */
    static final String SCHEMA_RESOURCE = "paper/kr-claude2-checkpoint.schema.json";
    /** 자유 시점 판의 한국 장중 판단 응답 스키마(ADR 0027 결정 3 — 시점 셋·{@code atLocal}·{@code nextCheckpoint}). */
    static final String FREE_SCHEMA_RESOURCE = "paper/kr-intraday-ft.schema.json";
    /** 목표 크기(토큰 어림) — 넘으면 경고 로그만. */
    static final int TARGET_TOKENS = 12_000;
    /** 종목마다 싣는 완성 봉 수(수집기 BARS_KEPT와 같음). */
    static final int BARS_SHOWN = 30;
    /** 장중 확인 주문이 받는 시점(이른 것부터 — MARKET 0 &lt; AT_1000 1 &lt; … &lt; NEXT_CLOSE 7). */
    static final List<String> TIMINGS = PaperBooks.CHECKPOINT_TIMINGS;

    /**
     * 조립 재료.
     *
     * @param checkpoint       그 세션의 PLANNED 장중 확인 행
     * @param asOf             밤 결정의 기준 거래일 d
     * @param night            요청을 낸 밤 결정 행(보낸 패킷의 12_hardRules·응답을 읽음)
     * @param state            계좌2 장부 상태
     * @param positions        계좌2 보유
     * @param pending          계좌2 대기 주문(출처 CLAUDE)
     * @param watch            감시 저장본(없으면 empty)
     * @param quotes           밤 관측치(예상 상태의 마지막 가격)
     * @param frameworkVersion 시스템 프롬프트로 쓴 프레임 판
     * @param settingsVersion  읽은 설정 판
     * @param calendar         한국 달력(그 실행)
     * @param assembledAt      조립 시각
     */
    record Inputs(Checkpoint checkpoint, LocalDate asOf, Decision night, BookState state, List<Position> positions,
                  List<Order> pending, Optional<Snapshot> watch, Optional<Quotes> quotes, Integer frameworkVersion,
                  Integer settingsVersion, TradingCalendar calendar, Instant assembledAt) {

        Inputs {
            Objects.requireNonNull(checkpoint, "checkpoint");
            Objects.requireNonNull(asOf, "asOf");
            Objects.requireNonNull(calendar, "calendar");
            Objects.requireNonNull(assembledAt, "assembledAt");
            positions = positions == null ? List.of() : List.copyOf(positions);
            pending = pending == null ? List.of() : List.copyOf(pending);
            watch = watch == null ? Optional.empty() : watch;
            quotes = quotes == null ? Optional.empty() : quotes;
        }

        /** 조립 시각 전에 받은 감시 저장본 본문(없으면 null). */
        JsonNode watchPayload() {
            return watch.filter(s -> s.collectedAt() != null && !s.collectedAt().isAfter(assembledAt)).map(Snapshot::payload)
                    .orElse(null);
        }

        /** 예상 상태 — 작업의 검증 문맥과 같은 함수·같은 재료. */
        ExpectedState.State expected() {
            return KrExpectedState.of(state, positions, pending, checkpoint.sessionDate(), assembledAt, watchPayload(),
                    quotes.orElse(null), calendar);
        }
    }

    /** 패킷 하나(클래스 설명). 메모 번호·측정은 없습니다. */
    static PacketBuilder.Packet build(Inputs in, ObjectMapper mapper) {
        JsonNode nightPacket = in.night() == null ? null
                : in.night().packet() != null ? in.night().packet() : PacketBuilder.readSent(in.night().packetText(), mapper);
        LocalDate session = in.checkpoint().sessionDate();
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("0_instructions", instructions());
        root.put("1_basis", basis(in, session));
        root.put("2_request", request(in.checkpoint()));
        root.put("3_night", night(in.night()));
        root.put("4_portfolio", portfolio(in, session));
        root.put("5_feed", feed(in));
        root.put(PacketBuilder.HARD_RULES, nightPacket == null ? Map.of() : Json.child(nightPacket, PacketBuilder.HARD_RULES));
        JsonNode body = PacketBuilder.toNode(root);
        String text = mapper.writer().without(SerializationFeature.INDENT_OUTPUT).writeValueAsString(body);
        int tokens = PacketBuilder.estimateTokens(text);
        if (tokens > TARGET_TOKENS) {
            log.warn("한국 장중 확인 패킷이 목표보다 큽니다: {} 약 {}토큰(목표 {})", session, tokens, TARGET_TOKENS);
        }
        return new PacketBuilder.Packet(body, text, PacketBuilder.sha256(text), List.of(), null);
    }

    // ------------------------------------------------------------------ 섹션
    private static Map<String, Object> instructions() {
        List<String> lines = List.of(
                "장중 확인이다 — 밤 결정(1_basis.sourceDecisionId)이 고른 시각에 한 번만 부른다. 재시도는 없다.",
                "자료는 조립 시각(1_basis.asOfInstant) 전에 끝난 봉·받은 값만 실었다. 5_feed는 확인 시각 뒤에 한 번 받은 토스증권 1분봉 저장본이라 "
                        + "실시간이 아니다(지연은 5_feed.lagSeconds). 체결은 늘 주문 뒤 그 시각의 1분봉이다.",
                "action이 KEEP이면 아무것도 바꾸지 않는다. REPLACE이면 기준 시각이 아직 오지 않은 대기 주문(4_portfolio.pending의 state '"
                        + CheckpointPacket.PENDING_AHEAD + "')만 취소되고 새 주문을 받는다 — 기준 시각이 지난 주문은 체결 예정으로 남고, "
                        + "4_portfolio.expected가 그 주문을 체결로 본 예상 장부다.",
                "주문 timing은 1_basis.remainingTimings 가운데 하나다. 주문마다 executionNote를 쓰고, 주문이 없으면 noTradeReason을 쓴다. "
                        + "한도·유니버스는 12_hardRules(밤 결정과 같음)이고 검증 문맥은 예상 장부다.",
                "통화는 원(KRW), 시각 표기는 한국 시간(KST), 종목은 6자리 코드다.");
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("lines", lines);
        return out;
    }

    private static Map<String, Object> basis(Inputs in, LocalDate session) {
        TradingCalendar calendar = in.calendar();
        Instant now = in.assembledAt();
        Instant open = calendar.openInstant(session);
        Instant close = calendar.closeInstant(session);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("checkpointVersion", CHECKPOINT_VERSION);
        out.put("book", PaperBooks.KR_CLAUDE2);
        out.put("asOfTradingDate", in.asOf());
        out.put("session", session);
        out.put("decisionKind", RuleBookService.CHECKPOINT);
        out.put("sourceDecisionId", in.checkpoint().sourceDecisionId());
        out.put("asOfInstant", now.toString());
        out.put("nowKst", Kst.stamp(now));
        out.put("sessionOpenKst", clock(open));
        out.put("sessionCloseKst", clock(close));
        out.put("minutesToClose", Duration.between(now, close).toMinutes());
        out.put("remainingTimings", remainingTimings(in.asOf(), session, calendar, now));
        out.put("frameworkVersion", in.frameworkVersion());
        out.put("settingsVersion", in.settingsVersion());
        return out;
    }

    /**
     * 아직 고를 수 있는 시점 — 검증기와 같은 규칙({@link KrTimedLadder#closedTimings} — 지난 AT_*는 LATE, 정규장 밖·종가 단일가의 MARKET·AT_*는 MALFORMED)에
     * 닫히지 않은 것, 시점 순.
     */
    static List<String> remainingTimings(LocalDate asOf, LocalDate session, TradingCalendar calendar, Instant now) {
        Map<String, com.macrodash.analytics.OrderValidator.Closed> closed = KrTimedLadder.closedTimings(TIMINGS, asOf, now,
                calendar);
        List<String> out = new ArrayList<>();
        for (String timing : TIMINGS) {
            if (!closed.containsKey(timing) && calendar.isTradingDay(session)) {
                out.add(timing);
            }
        }
        return out;
    }

    private static Map<String, Object> request(Checkpoint c) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("atKst", KrTimedLadder.label(c.atLocal()));
        out.put("question", c.question());
        out.put("watch", c.watch());
        return out;
    }

    private static Map<String, Object> night(Decision night) {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode response = night == null ? null : night.response();
        out.put("decisionId", night == null ? null : night.id());
        out.put("summary", Json.asText(response, "summary"));
        out.put("stance", Json.asText(response, "stance"));
        out.put("targetEquityExposurePct", Json.asDouble(response, "targetEquityExposurePct"));
        List<Map<String, Object>> orders = new ArrayList<>();
        for (JsonNode o : Json.array(response, "orders")) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", Json.asText(o, "ticker"));
            row.put("side", Json.asText(o, "side"));
            row.put("timing", Json.asText(o, "timing"));
            row.put("targetWeightPct", Json.asDouble(o, "targetWeightPct"));
            row.put("sellFraction", Json.asDouble(o, "sellFraction"));
            row.put("executionNote", Json.asText(o, "executionNote"));
            row.put("thesis", Json.asText(o, "thesis"));
            orders.add(row);
        }
        out.put("orders", orders);
        return out;
    }

    private static Map<String, Object> portfolio(Inputs in, LocalDate session) {
        Map<String, Object> out = new LinkedHashMap<>();
        Map<String, Object> ledger = new LinkedHashMap<>();
        ledger.put("cash", in.state() == null ? null : PacketBuilder.decimal(in.state().cash(), 0));
        ledger.put("nav", in.state() == null ? null : PacketBuilder.decimal(in.state().nav(), 0));
        List<Map<String, Object>> held = new ArrayList<>();
        for (Position p : in.positions()) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", p.ticker());
            row.put("qty", p.qty());
            row.put("avgCost", PacketBuilder.decimal(p.avgCost(), 0));
            row.put("lastPrice", p.lastPrice() == null ? null : PacketBuilder.decimal(p.lastPrice(), 0));
            row.put("openedOn", p.openedOn());
            held.add(row);
        }
        ledger.put("positions", held);
        ledger.put("note", "장부는 지난밤 관측치로 평가한 값이다(한국 장부는 밤에 한 번 체결·평가 — 오늘 시가 주문도 아직 대기)");
        out.put("ledger", ledger);
        List<Map<String, Object>> pending = new ArrayList<>();
        for (Order o : in.pending()) {
            Instant target = KrExpectedState.targetAt(o, session, in.calendar());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("orderId", o.id());
            row.put("ticker", o.ticker());
            row.put("side", o.side());
            row.put("timing", o.timing());
            row.put("targetKst", target == null ? null : Kst.stamp(target));
            row.put("state", target != null && !target.isAfter(in.assembledAt()) ? CheckpointPacket.PENDING_DUE
                    : CheckpointPacket.PENDING_AHEAD);
            row.put("targetWeightPct", o.targetWeightPct());
            row.put("sellFraction", o.sellFraction());
            row.put("qty", o.qty());
            pending.add(row);
        }
        out.put("pending", pending);
        Map<String, Object> expected = in.expected().toMap(in.calendar());
        expected.put("note", KrExpectedState.NOTE);
        out.put("expected", expected);
        return out;
    }

    private static Map<String, Object> feed(Inputs in) {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode payload = in.watchPayload();
        out.put("source", "토스증권 1분봉(원시가) — 확인 시각 뒤 한 번 받은 저장본(실시간 아님), 라벨은 봉 끝 시각 KST");
        if (payload == null) {
            out.put("missing", "감시 저장본 없음");
            return out;
        }
        String fetched = Json.asText(payload, "fetchedAt");
        out.put("fetchedAtKst", fetched == null ? null : Kst.stamp(Instant.parse(fetched)));
        JsonNode lag = payload.get("lagSeconds");
        out.put("lagSeconds", lag != null && lag.isNumber() ? lag.asInt() : null);
        Map<String, Object> tickers = new LinkedHashMap<>();
        for (Map.Entry<String, JsonNode> entry : payload.path("tickers").properties()) {
            JsonNode t = entry.getValue();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("lastBar", t.get("lastBar"));
            List<List<Object>> bars = new ArrayList<>();
            List<JsonNode> all = new ArrayList<>();
            t.path("bars").forEach(all::add);
            for (JsonNode bar : all.subList(Math.max(0, all.size() - BARS_SHOWN), all.size())) {
                List<Object> cells = new ArrayList<>();
                for (String key : List.of("label", "o", "h", "l", "c", "v")) {
                    JsonNode v = bar.get(key);
                    cells.add(v == null || v.isNull() ? null : v.isNumber() ? v.numberValue() : v.asString(""));
                }
                bars.add(cells);
            }
            row.put("bars", bars);
            if (t.path("isStale").asBoolean(false)) {
                row.put("isStale", true);
                row.put("staleReason", Json.asText(t, "staleReason"));
            }
            tickers.put(entry.getKey(), row);
        }
        out.put("barColumns", List.of("label", "open", "high", "low", "close", "volume"));
        out.put("tickers", tickers);
        out.put("missing", payload.get("missing"));
        return out;
    }

    private static String clock(Instant instant) {
        return KrTimedLadder.label(instant.atZone(KrxCalendar.SEOUL).toLocalTime());
    }
}
