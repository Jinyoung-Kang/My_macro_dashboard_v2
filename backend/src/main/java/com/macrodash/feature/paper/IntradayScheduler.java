package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.ToDoubleFunction;

/**
 * 장중 판단 계획 행을 결정 응답 밖에서 넣거나 당기는 규칙(자유 시점 판 — ADR 0027 결정 3·ADR 0031 초안 결정 4, 명세
 * docs/specs/2026-11-05-free-fill-timing.md §7) — 운영자 당김({@link IntradayManualService})과 코드의 보장 1회({@link #guarantee} — 장중 판단 작업
 * {@link PaperIntradayJob}·{@link PaperKrIntradayJob}이 주기마다)가 씁니다. 결정의 예약·장중 판단의 다음 예약은 {@link IntradayPlanner}가 씁니다.
 *
 * <p>규칙은 결정이 지키는 불변식을 그대로 둡니다: 끝난 순번(DONE·EXPIRED·SKIPPED) &lt; PLANNED 순번이고 PLANNED 순번 순 = 시각 순입니다. 그래서 당김은
 * 가장 이른 PLANNED 행을 고르고, 새 행은 끝난 순번 가운데 가장 큰 것 + 1을 씁니다(뒤 결정이 닫은 SUPERSEDED 순번은 다시 씀).
 *
 * <p><b>보장</b>(설정 {@value IntradayPolicy#US_MIN}·{@value IntradayPolicy#KR_MIN} ≥ 1, 기본 0 — 사용자 결정 2026-11-06 '최소 1'): 보장 시각 G(개장
 * 기준 — 미국 + {@link #GUARANTEE_AFTER_OPEN_US}, 보통 날 12:30 ET · 한국 + {@link #GUARANTEE_AFTER_OPEN_KR}, 보통 날 11:30 KST, 받는 범위 끝 −
 * {@link #GUARANTEE_BEFORE_LAST}로 자름)가
 * 지났는데 그 세션에 남은 예약(PLANNED)이 없고 부른 판단(DONE)이 최소 횟수보다 적으면, 순번이 남았을 때 한 행을 넣습니다 — 시각 = max(G, 지금 + 1분,
 * 끝난 판단 시각 + {@link IntradayRequest#MIN_GAP}), 받는 범위 안일 때만. 출처 {@value PaperStore.IntradayPlan#ORIGIN_GUARANTEE}, 수동 아님(정기 문턱으로
 * 셈), 피드는 운영자 새 행과 같음(미국 시간별 관측치 — 감시 목록 없이도 되는 피드, 한국 감시 1분봉). 그 계좌의 스위치가 켜져 있고 그 세션의 자유 시점 판
 * 결정이 있으며 계좌가 운용 중이고, 부를 때 막힐 것(작업이 보는 {@link Gate} — 파이프라인·계좌2 꺼짐·계좌2 소상한·하루 정기 문턱)이 없을 때만입니다.
 * 행이 있으면 다시 넣지 않아 같은 주기·재기동에도 한 번이고, 넣은 예약이 놓침·건너뜀으로 끝나면 순번이 남은 동안 다시 넣습니다(재시도 없음 규칙과 상한
 * 때문에 '최소 1'은 절대 보장이 아님).
 *
 * <p><b>사건</b>(설정 {@value IntradayPolicy#US_EVENTS}·{@value IntradayPolicy#KR_EVENTS}, 기본 꺼짐 — 사용자 결정 2026-11-06, 단순판 — 통합 검토 R10,
 * {@link #events}): 자료는 그 시장 장중 스탑 감시 저장본({@code paper.stopwatch.us}·{@code kr} — 감시 스위치가 SHADOW·ON일 때만 생김)이고, 사건은
 * 셋입니다 — 보유 종목이 전일 종가 대비 ±{@value #HELD_MOVE_PCT}% 이상({@code HELD_MOVE}, 위·아래 따로), 지수({@value #US_INDEX}·{@value #KR_INDEX})가
 * ±{@value #INDEX_MOVE_PCT}% 이상({@code INDEX_MOVE}), 보유 종목이 트레일링 스탑가 위 {@value #NEAR_STOP_PCT}% 안({@code NEAR_STOP} — 스탑가 이하는
 * 장중 스탑 감시의 몫). 저장본이 {@link #MONITOR_MAX_AGE}보다 오래됐거나, 그 종목 항목이 그 세션 것이 아니거나 이어받은 것이거나, 갭 가드
 * ({@link StopWatch#guard} — 기업행위 의심)가 판단되지 않거나 걸렸으면 그 종목의 사건을 만들지 않습니다(없는 숫자를 만들지 않음). 사건 하나(종류·종목·
 * 방향)는 세션에 한 번만 씁니다 — 그 세션 행들의 {@code trigger}와 이 작업의 메모리로 셉니다. 새 사건이 있으면 한 번에 하나를 합니다: 가장 이른 남은
 * 예약(PLANNED)이 사건 시각 t = max(지금 + 1분, 받는 범위 시작, 끝난 판단 + {@link IntradayRequest#MIN_GAP}) 뒤면 t로 당기고(출처 EVENT, 원래 시각은
 * {@code trigger.originalAt} — 미국 시간별 피드는 감시 1분봉으로 바꿔 장 초반에도 자료가 오게 함), t 이전이면 사건만 붙이고, 남은 예약이 없으면 순번이
 * 남았을 때 t에 사건 행(출처 EVENT, 감시 1분봉 — 감시 목록은 사건 종목)을 넣습니다. 그 밖(순번을 다 씀·받는 범위에 남은 시각 없음·부를 때 막힐 것 —
 * {@link Gate})은 버리고(SUPPRESSED) 작업 기록에만 남깁니다. 당김이 막히면({@link Gate}) 사건만 붙입니다.
 */
final class IntradayScheduler {

    /** 운영자가 넣은 새 행의 질문. */
    static final String MANUAL_QUESTION = "운영자가 요청한 장중 판단 — 지금 대기 주문과 보유를 그대로 둘지 본다";
    /** 당긴 시각 = 지금을 분으로 내린 뒤 + 이만큼. */
    static final Duration AHEAD = Duration.ofMinutes(1);
    /** 미국 보장 시각 = 개장 + 이만큼(보통 날 12:30 ET — 사용자 결정 2026-11-06 '세션 중간', 개장 기준으로 셈). */
    static final Duration GUARANTEE_AFTER_OPEN_US = Duration.ofMinutes(180);
    /** 한국 보장 시각 = 개장 + 이만큼(보통 날 11:30 KST, 수능일 12:30 KST). */
    static final Duration GUARANTEE_AFTER_OPEN_KR = Duration.ofMinutes(150);
    /**
     * 보장 시각은 받는 범위 끝보다 늦어도 이만큼 앞(미국 조기 폐장일 13:00 마감 — 범위 끝 12:30이면 12:20 ET, QA-310). 넣을 시각 '지금 + 1분'이 범위 안에
     * 드는 주기가 이 길이만큼 남아, 장중 판단 작업(한 줄·60초 간격)의 긴 호출(최대 300초) 하나에 밀려도 보장 행을 넣을 기회가 남습니다 — 범위 끝 − 1분이면
     * 그 1분에 시작한 주기 하나뿐이었음.
     */
    static final Duration GUARANTEE_BEFORE_LAST = Duration.ofMinutes(10);
    /** 보장 행의 질문. */
    static final String GUARANTEE_QUESTION = "코드가 부른 보장 판단 — 이 세션에 장중 판단이 아직 없어 세션 중간에 한 번 본다(대기 주문과 보유를 그대로 둘지)";

    /** 사건 — 보유 종목이 전일 종가 대비 이만큼(%) 이상 움직임(위·아래 따로 — 사용자 결정 2026-11-06 '보유 ±4%'). */
    static final double HELD_MOVE_PCT = 4.0;
    /** 사건 — 지수({@link #US_INDEX}·{@link #KR_INDEX})가 전일 종가 대비 이만큼(%) 이상 움직임('지수 ±1.5%'). */
    static final double INDEX_MOVE_PCT = 1.5;
    /** 사건 — 보유 종목이 트레일링 스탑가 위 이만큼(%) 안('스탑 2% 근접' — 스탑가 이하는 장중 스탑 감시의 몫). */
    static final double NEAR_STOP_PCT = 2.0;
    /** 미국 지수 사건의 종목(감시 저장본의 기준 종목). */
    static final String US_INDEX = CheckpointPacket.REFERENCE;
    /** 한국 지수 사건의 종목(감시 저장본의 기준 종목 — KODEX 200). */
    static final String KR_INDEX = PaperBooks.KODEX_200;

    /** 결정 패킷의 보장 규칙 한 줄(켠 판 — {@code 13_execution.intraday.guarantee}·한국 {@code 1_basis.intraday.guarantee}). */
    static final String GUARANTEE_RULE = "이 세션에 남은 예약(PLANNED)이 없고 부른 장중 판단이 minPerSession번보다 적으면 코드가 이 시각(그 전 판단 뒤 "
            + IntradayRequest.MIN_GAP.toMinutes() + "분이 안 됐으면 그때)에 한 번 부른다 — 정기 몫(하루 상한 안), 재시도 없음. 남은 예약이 있으면 그 예약이 "
            + "이 몫을 하고, 그 예약을 놓치면 순번이 남은 동안 다시 본다";

    /** 그 시장 지수 사건의 종목. */
    static String indexTicker(boolean korea) {
        return korea ? KR_INDEX : US_INDEX;
    }

    /** 결정 패킷·장중 판단 패킷의 사건 규칙 한 줄(그 시장 지수 이름으로). */
    static String eventRule(boolean korea) {
        return "코드가 5분 장중 감시 저장본으로 보유 종목이 전일 종가 대비 ±" + trim(HELD_MOVE_PCT) + "% 이상, 지수(" + indexTicker(korea)
                + ")가 ±" + trim(INDEX_MOVE_PCT) + "% 이상 움직이거나 보유 종목이 트레일링 스탑가 위 " + trim(NEAR_STOP_PCT)
                + "% 안으로 오면(사건마다 세션에 한 번) 가장 이른 남은 예약을 지금으로 앞당기고, 남은 예약이 없으면 세션당 횟수 안에서 판단을 하나 "
                + "더한다 — 세션당 횟수·간격(" + IntradayRequest.MIN_GAP.toMinutes() + "분)·받는 범위를 넘지 않고, 넘으면 그 사건은 버린다. 사건은 "
                + "판단할 계기일 뿐 매매하라는 뜻이 아니다";
    }

    /**
     * 결정 패킷의 보장 칸(켠 판) — 세션당 최소 횟수가 1 이상일 때 그 세션의 보장 시각(그 시장 현지 시각 HH:MM과 KST)·규칙, 0이면 null(보장 없음).
     *
     * @param session 결정의 목표 세션
     */
    static Map<String, Object> guaranteeView(LocalDate session, TradingCalendar calendar, boolean korea, int min) {
        if (min < 1) {
            return null;
        }
        Instant at = guaranteeAt(session, calendar, korea);
        Map<String, Object> out = new LinkedHashMap<>();
        if (korea) {
            out.put("atKst", FreeTiming.label(at.atZone(calendar.zone()).toLocalTime()));
        } else {
            out.put("atEt", FreeTiming.label(at.atZone(calendar.zone()).toLocalTime()));
            out.put("atKst", Kst.stamp(at));
        }
        out.put("rule", GUARANTEE_RULE);
        return out;
    }

    /**
     * 결정 패킷의 사건 칸(켠 판) — 사건이 판단을 당길 수 있을 때(그 계좌의 {@value IntradayPolicy#US_EVENTS}·{@value IntradayPolicy#KR_EVENTS}가 켜져
     * 있고 그 시장 장중 스탑 감시가 SHADOW·ON — 사건의 자료가 감시 저장본이라) 문턱과 규칙, 아니면 null.
     */
    static Map<String, Object> eventsView(boolean korea, boolean on) {
        if (!on) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("heldMovePct", HELD_MOVE_PCT);
        out.put("indexTicker", indexTicker(korea));
        out.put("indexMovePct", INDEX_MOVE_PCT);
        out.put("nearStopPct", NEAR_STOP_PCT);
        out.put("rule", eventRule(korea));
        return out;
    }

    /** 그 계좌의 사건이 실제로 판단을 당길 수 있나 — 사건 스위치와 그 시장 장중 스탑 감시(SHADOW·ON — 사건의 자료). */
    static boolean eventsOn(JsonNode body, String code, boolean korea) {
        return IntradayPolicy.from(body).events(code) && StopWatchMode.of(body, korea).watching();
    }

    private static String trim(double value) {
        return java.math.BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }

    /**
     * 보장 행을 넣기 전에 작업이 보는 문 — 그 행을 부를 때 막힐 까닭(파이프라인 없음·계좌2 꺼짐·계좌2 소상한·하루 정기 문턱)을 미리 봅니다. 막히는 행을
     * 넣으면 창 시작에 놓침으로 끝나고 다음 주기가 다음 순번을 또 넣어 순번만 씁니다.
     */
    @FunctionalInterface
    interface Gate {

        /** 넣지 않을 까닭(사유 코드 글) — 넣어도 되면 null. */
        String blocked(String code, Decision source);
    }

    private final PaperStore store;
    private final PaperLedgerService ledger;
    private final ObjectMapper mapper;
    /** 사건 메모리의 세션(바뀌면 아래 둘을 비움). */
    private LocalDate eventSession;
    /** 계좌 → 사건을 다 본 감시 저장본({@code fetchedAt}) — 새 저장본(5분마다)에서만 다시 셈. */
    private final Map<String, String> eventSnapshotSeen = new HashMap<>();
    /** '계좌|사건 열쇠' — 이 세션에 이미 쓴 사건(행의 trigger가 뒤 예약에 덮여도 다시 쏘지 않게). 재기동하면 행의 trigger로만 셈. */
    private final Set<String> eventsUsed = new HashSet<>();

    IntradayScheduler(PaperStore store, PaperLedgerService ledger, ObjectMapper mapper) {
        this.store = store;
        this.ledger = ledger;
        this.mapper = mapper;
    }

    /** 당기거나 넣을 시각 — 지금을 분으로 내린 뒤 + {@link #AHEAD}. */
    static Instant pullAt(Instant now) {
        return now.truncatedTo(ChronoUnit.MINUTES).plus(AHEAD);
    }

    /** 그 세션의 가장 이른 PLANNED 행(없으면 빈 값). */
    static Optional<IntradayPlan> earliestPlanned(List<IntradayPlan> rows) {
        return rows.stream().filter(p -> PaperBooks.CHECKPOINT_PLANNED.equals(p.status())).min(Comparator.comparing(IntradayPlan::atLocal));
    }

    /** 남은 예약이 없을 때 새 행이 쓸 순번 — 끝난 순번 가운데 가장 큰 것 + 1(없으면 1). */
    static int nextSlot(List<IntradayPlan> rows) {
        return 1 + rows.stream().filter(IntradayPlanner::finished).mapToInt(IntradayPlan::slot).max().orElse(0);
    }

    /** 있던 예약을 {@code at}으로 당긴 행 — 피드·감시 목록·질문·판·그 세션의 결정·예약한 판단은 그대로, 수동 표시를 켬. */
    static IntradayPlan pulled(IntradayPlan p, LocalTime at) {
        return IntradayPlan.planned(p.bookCode(), p.sessionDate(), p.slot(), at, p.feed(), p.watch(), p.question(), p.variant(), true,
                p.sourceDecisionId(), p.requestedByDecisionId());
    }

    /**
     * 운영자가 넣는 새 행 — 미국은 시간별 관측치({@code HOURLY} — 감시 목록 없이도 되는 피드), 한국은 감시 1분봉({@code MINUTE} — 보유·대기·기준
     * 종목), 감시 목록 없음, 지금 켠 판의 판 이름.
     */
    static IntradayPlan manualRow(String code, LocalDate session, int slot, LocalTime at, boolean korea, long sourceDecisionId) {
        return IntradayPlan.planned(code, session, slot, at, feed(korea), List.of(), MANUAL_QUESTION, variant(korea), true,
                sourceDecisionId, null);
    }

    /** 결정 응답 밖에서 넣는 행의 피드 — 미국 시간별 관측치, 한국 감시 1분봉. */
    static String feed(boolean korea) {
        return korea ? ExecutionSection.FEED_MINUTE : ExecutionSection.FEED_HOURLY;
    }

    /** 그 시장 켠 판의 판 이름(패킷 {@code 1_basis.fixedRules}와 같은 글자). */
    static String variant(boolean korea) {
        return korea ? KrPacketBuilder.KR_FREE_FIXED_RULES_VERSION : PacketBuilder.FREE_FIXED_RULES_VERSION;
    }

    /**
     * 오늘 세션을 목표로 한 그 계좌의 자유 시점 판 결정 — 기준 거래일이 오늘 세션의 앞 거래일인 정기·수동·출발 결정 가운데 판단을 낸 것(OK·NO_TRADE)
     * 이고 보낸 패킷의 판이 자유 시점 판({@code 1_basis.variant})인 것, 가장 늦게 낸 것. 스위치를 그 결정 뒤에 켰으면 없습니다(끈 판 결정의 주문을
     * 켠 판이 받지 않음).
     */
    Optional<Decision> sessionDecision(String code, LocalDate session, TradingCalendar calendar) {
        LocalDate asOf = calendar.previousTradingDay(session);
        Decision latest = null;
        for (String kind : List.of(RuleBookService.SCHEDULED, RuleBookService.MANUAL, RuleBookService.INITIAL)) {
            Decision d = store.decisionFor(code, asOf, kind).orElse(null);
            if (d == null || !(ClaudeBookService.STATUS_OK.equals(d.status()) || ClaudeBookService.STATUS_NO_TRADE.equals(d.status()))) {
                continue;
            }
            JsonNode packet = d.packet() != null ? d.packet() : PacketBuilder.readSent(d.packetText(), mapper);
            if (packet == null || !PacketBuilder.VARIANT_FREE.equals(Json.asText(packet.path("1_basis"), "variant"))) {
                continue;
            }
            if (latest == null || (d.decidedAt() != null && (latest.decidedAt() == null || d.decidedAt().isAfter(latest.decidedAt())))) {
                latest = d;
            }
        }
        return Optional.ofNullable(latest);
    }

    // ------------------------------------------------------------------ 보장 1회(ADR 0031 초안 결정 4)

    /**
     * 그 세션의 보장 시각 G — 개장 + 오프셋(미국 180분·한국 150분). 받는 범위 끝({@link IntradayRequest#window}) − {@link #GUARANTEE_BEFORE_LAST}보다
     * 늦으면 그 시각(미국 조기 폐장일 13:00 마감이면 범위 끝 12:30 − 10분 = 12:20 — 12:20~12:29:59에 시작한 어느 주기든 넣는 행의 시각 '지금 + 1분'이
     * 범위 안에 들게, QA-310).
     */
    static Instant guaranteeAt(LocalDate session, TradingCalendar calendar, boolean korea) {
        Instant at = calendar.openInstant(session).plus(korea ? GUARANTEE_AFTER_OPEN_KR : GUARANTEE_AFTER_OPEN_US);
        Instant latest = IntradayRequest.window(session, calendar, korea).last().minus(GUARANTEE_BEFORE_LAST);
        return at.isAfter(latest) ? latest : at;
    }

    /**
     * 보장 행의 시각(그 시장 현지 시각) — 넣을 때가 아니면 null(클래스 설명의 조건 가운데 행과 시계로 정해지는 것). 순수 함수입니다.
     *
     * @param rows 그 세션의 그 계좌 행 전부
     * @param min  세션당 최소 장중 판단 수(0이면 늘 null)
     * @param max  세션당 장중 판단 횟수(설정 — 코드가 부를 수 있는 순번 수를 넘지 않게 자름)
     */
    static LocalTime guaranteeTime(List<IntradayPlan> rows, LocalDate session, TradingCalendar calendar, boolean korea, Instant now,
                                   int min, int max) {
        if (min < 1 || max < 1) {
            return null;
        }
        Instant g = guaranteeAt(session, calendar, korea);
        if (now.isBefore(g)) {
            return null;
        }
        if (rows.stream().anyMatch(p -> PaperBooks.CHECKPOINT_PLANNED.equals(p.status()))) {
            return null;   // 남은 예약이 그 몫을 함 — 놓침·건너뜀으로 끝나면 그때 다시 봄
        }
        long done = rows.stream().filter(p -> PaperBooks.CHECKPOINT_DONE.equals(p.status())).count();
        if (done >= min || nextSlot(rows) > Math.min(max, RuleBookService.INTRADAY_MAX)) {
            return null;
        }
        Instant at = g;
        Instant pull = pullAt(now);
        if (pull.isAfter(at)) {
            at = pull;
        }
        for (IntradayPlan p : rows) {
            if (IntradayPlanner.finished(p)) {
                Instant after = FreeTiming.at(session, p.atLocal(), calendar).plus(IntradayRequest.MIN_GAP);
                if (after.isAfter(at)) {
                    at = after;
                }
            }
        }
        if (!IntradayRequest.window(session, calendar, korea).accepts(at)) {
            return null;
        }
        return at.atZone(calendar.zone()).toLocalTime();
    }

    /** 보장 행 — 출처 {@value PaperStore.IntradayPlan#ORIGIN_GUARANTEE}, 수동 아님(정기 문턱), 피드는 운영자 새 행과 같음, 감시 목록 없음, 사건 없음. */
    static IntradayPlan guaranteeRow(String code, LocalDate session, int slot, LocalTime at, boolean korea, long sourceDecisionId) {
        return IntradayPlan.planned(code, session, slot, at, feed(korea), List.of(), GUARANTEE_QUESTION, variant(korea), false,
                sourceDecisionId, null, IntradayPlan.ORIGIN_GUARANTEE, null);
    }

    /** 그 시장 계좌 가운데 보장을 켠(세션당 최소 횟수 ≥ 1) 계좌가 있나 — 없으면 작업이 달력·계획 행을 읽지 않습니다(기본 설정에서는 늘 거짓). */
    static boolean guaranteeWanted(List<String> books, JsonNode body) {
        if (body == null) {
            return false;
        }
        IntradayPolicy policy = IntradayPolicy.from(body);
        return books.stream().anyMatch(code -> policy.minPerSession(code) >= 1);
    }

    /**
     * 보장 한 번(클래스 설명) — 그 시장 Claude 계좌마다 조건을 보고 맞으면 보장 행을 넣습니다. 보장 시각 전·받는 범위 뒤·거래일이 아닌 날(달력이 그 해를
     * 모르는 날 포함)에는 계획 행도 읽지 않습니다. 쓰기는 장부 잠금 안 한 트랜잭션이고 그 안에서 계좌 상태·행을 다시 읽어 판정합니다(운영자 당김·결정과
     * 겹쳐도 한 번).
     *
     * @param row  그 실행의 설정 행(없으면 아무것도 하지 않음)
     * @param gate 부를 때 막힐 까닭을 보는 문(작업이 줌)
     * @return 넣은 행 '계좌 세션 #순번' → 'PLANNED GUARANTEE HH:MM ET|KST'
     */
    Map<String, String> guarantee(List<String> books, SettingsRow row, TradingCalendar calendar, boolean korea, Instant now, Gate gate) {
        Map<String, String> out = new LinkedHashMap<>();
        if (row == null || !guaranteeWanted(books, row.body())) {
            return out;
        }
        LocalDate session = now.atZone(calendar.zone()).toLocalDate();
        Instant g;
        Instant last;
        try {
            if (!calendar.isTradingDay(session)) {
                return out;
            }
            g = guaranteeAt(session, calendar, korea);
            last = IntradayRequest.window(session, calendar, korea).last();
        } catch (CalendarUnavailableException e) {
            return out;   // 그 해 공휴일을 모름 — 장중 판단 작업·결정도 그 세션을 부르지 않음
        }
        if (now.isBefore(g) || now.isAfter(last)) {
            return out;
        }
        IntradayPolicy policy = IntradayPolicy.from(row.body());
        FreeTimingSettings free = FreeTimingSettings.from(row.body());
        String zone = korea ? " KST" : " ET";
        for (String code : books) {
            int min = policy.minPerSession(code);
            int max = free.intradayMax(code);
            if (min < 1 || max < 1 || !free.on(code)
                    || guaranteeTime(store.intradayPlans(code, session), session, calendar, korea, now, min, max) == null) {
                continue;
            }
            Decision source = sessionDecision(code, session, calendar).orElse(null);
            if (source == null || gate.blocked(code, source) != null) {
                continue;
            }
            IntradayPlan created = ledger.exclusively(() -> store.atomically(() -> {
                Book book = store.book(code).orElse(null);
                if (book == null || !PaperBooks.ACTIVE.equals(book.status())) {
                    return null;
                }
                List<IntradayPlan> rows = store.intradayPlans(code, session);
                LocalTime at = guaranteeTime(rows, session, calendar, korea, now, min, max);
                if (at == null) {
                    return null;
                }
                IntradayPlan plan = guaranteeRow(code, session, nextSlot(rows), at, korea, source.id());
                return store.upsertPlannedIntradayPlan(plan) ? plan : null;
            }));
            if (created != null) {
                out.put(PaperIntradayJob.key(created), PaperBooks.CHECKPOINT_PLANNED + " " + IntradayPlan.ORIGIN_GUARANTEE + " "
                        + FreeTiming.label(created.atLocal()) + zone);
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ 사건(ADR 0031 초안 결정 7 — 단순판, 통합 검토 R10)

    /** 감시 저장본이 이보다 오래되면 사건을 만들지 않습니다(감시는 5분마다 — 두 회차를 놓치면 묵은 자료). */
    static final Duration MONITOR_MAX_AGE = Duration.ofMinutes(10);
    static final String HELD_MOVE = "HELD_MOVE";
    static final String INDEX_MOVE = "INDEX_MOVE";
    static final String NEAR_STOP = "NEAR_STOP";
    static final String UP = "UP";
    static final String DOWN = "DOWN";
    /** 사건 행의 질문. */
    static final String EVENT_QUESTION = "코드 사건 규칙이 부른 판단 — 요청의 trigger 사건(보유 종목·지수 급변, 트레일링 스탑 근접)을 보고 대기 주문과 보유를 "
            + "그대로 둘지 본다";
    /** 사건 행을 넣지 못한 까닭 — 그 세션의 자유 시점 판 결정이 없음(그 판의 장중 판단이 아님). */
    static final String NO_DECISION = "NO_DECISION — 그 세션의 자유 시점 판 결정이 없음";
    /** 사건을 버린 까닭 — 순번을 다 씀. */
    static final String NO_SLOT = "NO_SLOT — 세션당 장중 판단 횟수를 다 씀";
    /** 사건을 버린 까닭 — 받는 범위에 남은 시각이 없음(간격·마감 30분 전). */
    static final String NO_TIME = "NO_TIME — 받는 범위에 남은 시각이 없음";
    /** 사건을 버린 까닭 — 계좌가 운용 중이 아님. */
    static final String NOT_ACTIVE = "BOOK_NOT_ACTIVE — 계좌가 운용 중이 아님";
    /** 판정 경계의 부동소수 여유(4.00%가 3.9999…%로 빠지지 않게). */
    private static final double EPSILON = 1e-9;

    /**
     * 사건 하나 — 종류·종목·방향(움직임만), 전일 종가·마지막 가격·변화율(움직임), 스탑가·최고가·스탑가 위 거리(스탑 근접), 그 가격의 봉 시각.
     */
    record Event(String type, String ticker, String direction, Double prevClose, double last, Double changePct, Double stopPrice,
                 Double highWatermark, Double distancePct, Instant barAt) {

        /** 세션에 한 번을 세는 열쇠 — 종류·종목·방향. */
        String key() {
            return key(type, ticker, direction);
        }

        static String key(String type, String ticker, String direction) {
            return type + ":" + ticker + (direction == null ? "" : ":" + direction);
        }

        /** 계획 행 {@code trigger.events[]} 한 줄 — 봉 시각은 그 시장 현지 시각(미국 봉 시작 {@code barEt}, 한국 봉 끝 {@code barKst}). */
        ObjectNode toJson(ObjectMapper mapper, TradingCalendar calendar, boolean korea) {
            ObjectNode out = mapper.createObjectNode();
            out.put("type", type);
            out.put("ticker", ticker);
            if (direction != null) {
                out.put("direction", direction);
            }
            if (prevClose != null) {
                out.put("prevClose", PaperLedger.round4(prevClose));
            }
            out.put("last", PaperLedger.round4(last));
            if (changePct != null) {
                out.put("changePct", Math.round(changePct * 100.0) / 100.0);
            }
            if (stopPrice != null) {
                out.put("stopPrice", PaperLedger.round4(stopPrice));
                out.put("highWatermark", PaperLedger.round4(highWatermark));
                out.put("distancePct", Math.round(distancePct * 100.0) / 100.0);
            }
            out.put(korea ? "barKst" : "barEt", FreeTiming.label(barAt.atZone(calendar.zone()).toLocalTime()));
            return out;
        }

        /** 작업 기록 한 조각 — 'HELD_MOVE AAA DOWN −4.13%'. */
        String label() {
            String detail = changePct != null ? String.format(java.util.Locale.ROOT, " %+.2f%%", changePct)
                    : distancePct != null ? String.format(java.util.Locale.ROOT, " 스탑가 위 %.2f%%", distancePct) : "";
            return type + " " + ticker + (direction == null ? "" : " " + direction) + detail;
        }
    }

    /**
     * 사건 판정에 쓰는 보유 하나.
     *
     * @param ticker          종목
     * @param highWatermark   트레일링 스탑의 최고가(한국은 장중 스탑 감시와 같은 유효 최고가)
     * @param ledgerPrevClose 장부가 아는 전일 종가(그 보유의 기준일이 그 세션 전 거래일일 때 — 갭 가드와 같은 규칙), 모르면 null
     */
    record Held(String ticker, double highWatermark, Double ledgerPrevClose) {
    }

    /** 사건 판정의 입력 — 작업이 줍니다(감시 저장본은 조용히 읽음, 보유와 최고가는 그 시장 규칙으로). */
    interface EventSource {

        /** 그 시장 장중 스탑 감시 저장본(없으면 empty). */
        Optional<Snapshot> monitor();

        /** 그 계좌의 보유(현금성·미처리 기업행위 보유 빼고). */
        List<Held> held(String code, LocalDate session);

        /** 트레일링 스탑 비율(%). */
        double stopPct();
    }

    /**
     * 보유 → 사건 판정 보유(현금성·수량 0·{@code skip} 종목 빼고, 종목 순).
     *
     * @param previous  그 세션 전 거래일(장부 전일 종가의 기준일 대조)
     * @param watermark 그 보유의 최고가(미국은 저장된 값, 한국은 유효 최고가)
     */
    static List<Held> held(List<Position> positions, PaperSettings settings, Collection<String> skip, LocalDate previous,
                           ToDoubleFunction<Position> watermark) {
        List<Held> out = new ArrayList<>();
        for (Position p : positions.stream().sorted(Comparator.comparing(Position::ticker)).toList()) {
            if (p.qty() <= 0 || settings.cashLike(p.ticker()) || skip.contains(p.ticker())) {
                continue;
            }
            out.add(new Held(p.ticker(), watermark.applyAsDouble(p), previous.equals(p.fillRefDate()) ? p.fillRefClose() : null));
        }
        return out;
    }

    /** 그 시장 계좌 가운데 사건을 켠 계좌가 있고 그 시장 장중 스탑 감시가 SHADOW·ON인가 — 아니면 작업이 아무것도 읽지 않습니다(기본 설정에서는 늘 거짓). */
    static boolean eventsWanted(List<String> books, JsonNode body, boolean korea) {
        if (body == null || !StopWatchMode.of(body, korea).watching()) {
            return false;
        }
        IntradayPolicy policy = IntradayPolicy.from(body);
        return books.stream().anyMatch(policy::events);
    }

    /** 사건 판정에 쓰는 한 종목의 관측 — 전일 종가(움직임 기준, 모르면 null)·마지막 거래 봉 가격·그 봉 시각. */
    private record Observed(Double prevClose, double last, Instant barAt) {
    }

    /**
     * 한 종목 항목의 관측(클래스 설명) — 그 세션의 이어받지 않은 항목이고 갭 가드가 판단되어 통과했고 마지막 거래 봉이 있을 때만. 전일 종가는 갭 가드와 같은
     * 기준(미국 장부 값 → Yahoo, 한국 토스 원시 → 장부 값).
     */
    private static Observed observe(JsonNode entry, LocalDate session, TradingCalendar calendar, boolean korea, Double ledgerPrevClose) {
        if (!StopWatch.usable(entry, session) || !StopWatch.guard(entry, korea, ledgerPrevClose).clear()) {
            return null;
        }
        StopWatch.Check latest = StopWatch.latest(entry, session, calendar, korea);
        if (latest.price() == null) {
            return null;
        }
        Double prev = korea ? positive(Json.asDouble(Json.child(entry, "prevClose"), "raw")) : positive(ledgerPrevClose);
        if (prev == null) {
            prev = korea ? positive(ledgerPrevClose) : positive(Json.asDouble(entry, "prevClose"));
        }
        return new Observed(prev, latest.price(), latest.barAt());
    }

    private static Double positive(Double value) {
        return value != null && value > 0 && Double.isFinite(value) ? value : null;
    }

    /** 움직임 사건 하나(문턱 이상이면) — 전일 종가가 없으면 없음. */
    private static void move(List<Event> out, String type, String ticker, Observed o, double pct) {
        if (o == null || o.prevClose() == null) {
            return;
        }
        double change = (o.last() / o.prevClose() - 1.0) * 100.0;
        if (Math.abs(change) + EPSILON >= pct) {
            out.add(new Event(type, ticker, change > 0 ? UP : DOWN, o.prevClose(), o.last(), change, null, null, null, o.barAt()));
        }
    }

    /**
     * 그 저장본의 사건(클래스 설명) — 지수 먼저, 그다음 보유 종목 순으로 움직임·스탑 근접. 순수 함수입니다.
     *
     * @param payload 장중 스탑 감시 저장본 본문
     * @param held    그 계좌의 보유({@link #held})
     * @param stopPct 트레일링 스탑 비율(%) — 범위 밖이면 스탑 근접을 보지 않음
     */
    static List<Event> detect(JsonNode payload, LocalDate session, TradingCalendar calendar, boolean korea, List<Held> held,
                              double stopPct) {
        List<Event> out = new ArrayList<>();
        JsonNode tickers = Json.child(payload, "tickers");
        String index = indexTicker(korea);
        move(out, INDEX_MOVE, index, observe(Json.child(tickers, index), session, calendar, korea, null), INDEX_MOVE_PCT);
        boolean stops = stopPct > 0 && stopPct < 100;
        for (Held h : held) {
            Observed o = observe(Json.child(tickers, h.ticker()), session, calendar, korea, h.ledgerPrevClose());
            if (o == null) {
                continue;
            }
            move(out, HELD_MOVE, h.ticker(), o, HELD_MOVE_PCT);
            if (stops && h.highWatermark() > 0) {
                double stop = TrailingStop.stopPrice(h.highWatermark(), stopPct);
                double distance = (o.last() / stop - 1.0) * 100.0;
                if (distance > 0 && distance <= NEAR_STOP_PCT + EPSILON) {
                    out.add(new Event(NEAR_STOP, h.ticker(), null, o.prevClose(), o.last(), null, stop, h.highWatermark(), distance,
                            o.barAt()));
                }
            }
        }
        return out;
    }

    /** 그 세션 행들에 이미 붙은 사건의 열쇠(끝난 행·닫힌 행 포함). */
    static Set<String> usedKeys(List<IntradayPlan> rows) {
        Set<String> out = new HashSet<>();
        for (IntradayPlan p : rows) {
            for (JsonNode e : Json.array(p.trigger(), "events")) {
                String type = Json.asText(e, "type");
                String ticker = Json.asText(e, "ticker");
                if (type != null && ticker != null) {
                    out.add(Event.key(type, ticker, Json.asText(e, "direction")));
                }
            }
        }
        return out;
    }

    /** 사건 처리 한 걸음. */
    enum EventStep {
        /** 가장 이른 남은 예약이 사건 시각 이전 — 사건만 붙임. */
        ATTACH,
        /** 가장 이른 남은 예약을 사건 시각으로 당김. */
        PULL,
        /** 남은 예약이 없음 — 사건 행을 넣음. */
        APPEND,
        /** 버림(순번·시각이 없음). */
        SUPPRESS,
        /** 창이 끝났는데 아직 닫히지 않은 예약이 있음 — 장중 판단 작업이 닫은 뒤 다시 봄. */
        WAIT
    }

    /**
     * 사건 처리 계획.
     *
     * @param row    붙이거나 당길 남은 예약(ATTACH·PULL)
     * @param slot   넣을 순번(APPEND)
     * @param at     당기거나 넣을 시각(그 시장 현지 시각 — PULL·APPEND)
     * @param reason 버린 까닭(SUPPRESS)
     */
    record EventPlan(EventStep step, IntradayPlan row, int slot, LocalTime at, String reason) {
    }

    /**
     * 사건 처리 계획(클래스 설명 — 단순판). 순수 함수입니다. 받는 범위 밖이 된 예약이나 창이 끝났는데 PLANNED로 남은 예약이 있으면 WAIT(장중 판단 작업이
     * 그 행을 닫을 때까지 — 닫히는 행에 사건을 붙여 잃지 않게).
     *
     * @param rows 그 세션의 그 계좌 행 전부
     * @param max  세션당 장중 판단 횟수(설정 — 코드가 부를 수 있는 순번 수를 넘지 않게 자름)
     */
    static EventPlan planEvents(List<IntradayPlan> rows, LocalDate session, TradingCalendar calendar, boolean korea, Instant now, int max) {
        IntradayRequest.Window window = IntradayRequest.window(session, calendar, korea);
        Instant t = pullAt(now);
        if (t.isBefore(window.first())) {
            t = window.first();
        }
        for (IntradayPlan p : rows) {
            Instant at = FreeTiming.at(session, p.atLocal(), calendar);
            if (PaperBooks.CHECKPOINT_PLANNED.equals(p.status())
                    && (now.isAfter(at.plus(PaperCheckpointJob.WINDOW_END)) || !window.accepts(at))) {
                return new EventPlan(EventStep.WAIT, p, 0, null, null);
            }
            if (IntradayPlanner.finished(p) && at.plus(IntradayRequest.MIN_GAP).isAfter(t)) {
                t = at.plus(IntradayRequest.MIN_GAP);
            }
        }
        LocalTime local = t.atZone(calendar.zone()).toLocalTime();
        IntradayPlan earliest = earliestPlanned(rows).orElse(null);
        if (earliest != null) {
            return FreeTiming.at(session, earliest.atLocal(), calendar).isAfter(t)
                    ? new EventPlan(EventStep.PULL, earliest, earliest.slot(), local, null)
                    : new EventPlan(EventStep.ATTACH, earliest, earliest.slot(), null, null);
        }
        if (t.isAfter(window.last())) {
            return new EventPlan(EventStep.SUPPRESS, null, 0, null, NO_TIME);
        }
        int slot = nextSlot(rows);
        if (slot > Math.min(max, RuleBookService.INTRADAY_MAX)) {
            return new EventPlan(EventStep.SUPPRESS, null, 0, null, NO_SLOT);
        }
        return new EventPlan(EventStep.APPEND, null, slot, local, null);
    }

    /** 사건 종목들(첫 나온 순, 감시 상한까지) — 사건 행의 감시 목록. */
    private static List<String> eventTickers(Collection<String> first, List<Event> events) {
        Set<String> out = new LinkedHashSet<>(first);
        events.forEach(e -> out.add(e.ticker()));
        return out.stream().limit(ExecutionSection.WATCH_MAX).toList();
    }

    /** 계획 행의 사건 — 원래 시각(있으면)과 그 행의 사건 + 새 사건(열쇠가 겹치면 앞의 것). */
    private ObjectNode trigger(JsonNode existing, String originalAt, List<Event> events, TradingCalendar calendar, boolean korea) {
        ObjectNode out = mapper.createObjectNode();
        String original = Json.asText(existing, "originalAt");
        if (original == null) {
            original = originalAt;
        }
        if (original != null) {
            out.put("originalAt", original);
        }
        ArrayNode list = out.putArray("events");
        Set<String> keys = new HashSet<>();
        for (JsonNode e : Json.array(existing, "events")) {
            keys.add(Event.key(Json.asText(e, "type"), Json.asText(e, "ticker"), Json.asText(e, "direction")));
            list.add(e);
        }
        for (Event e : events) {
            if (keys.add(e.key())) {
                list.add(e.toJson(mapper, calendar, korea));
            }
        }
        return out;
    }

    /** 사건 처리의 결과 — 걸음·바뀐 행의 열쇠·작업 기록 문구. */
    private record EventOutcome(EventStep step, String key, String text) {
    }

    /**
     * 사건 한 번(클래스 설명) — 그 시장 Claude 계좌마다, 새 감시 저장본이면 새 사건을 세고 있으면 한 걸음({@link #planEvents})을 합니다. 받는 범위 뒤·
     * 개장 전·거래일이 아닌 날(달력이 그 해를 모르는 날 포함)·감시 스위치 OFF·사건을 켠 계좌가 없으면 아무것도 읽지 않습니다. 쓰기는 장부 잠금 안 한
     * 트랜잭션이고 그 안에서 계좌 상태·행을 다시 읽어 정합니다(운영자 당김·결정·보장과 겹쳐도 한 번).
     *
     * @param row    그 실행의 설정 행(없으면 아무것도 하지 않음)
     * @param gate   부를 때 막힐 까닭을 보는 문(작업이 줌 — 당김·새 행에만)
     * @param source 감시 저장본·보유·스탑 비율(작업이 줌)
     * @return 바꾼 행 '계좌 세션 #순번'(버리면 '계좌 세션 사건') → 'EVENT PULL|ATTACH|PLANNED|SUPPRESSED …'
     */
    Map<String, String> events(List<String> books, SettingsRow row, TradingCalendar calendar, boolean korea, Instant now, Gate gate,
                               EventSource source) {
        Map<String, String> out = new LinkedHashMap<>();
        if (row == null || !eventsWanted(books, row.body(), korea)) {
            return out;
        }
        LocalDate session = now.atZone(calendar.zone()).toLocalDate();
        Instant open;
        Instant last;
        try {
            if (!calendar.isTradingDay(session)) {
                return out;
            }
            open = calendar.openInstant(session);
            last = IntradayRequest.window(session, calendar, korea).last();
        } catch (CalendarUnavailableException e) {
            return out;
        }
        if (now.isBefore(open) || now.isAfter(last)) {
            return out;
        }
        if (!session.equals(eventSession)) {
            eventSession = session;
            eventSnapshotSeen.clear();
            eventsUsed.clear();
        }
        Snapshot snapshot = source.monitor().orElse(null);
        Instant fetchedAt = snapshot == null ? null : instant(Json.asText(snapshot.payload(), "fetchedAt"));
        if (snapshot == null || snapshot.collectedAt() == null || snapshot.collectedAt().isAfter(now)
                || Duration.between(snapshot.collectedAt(), now).compareTo(MONITOR_MAX_AGE) > 0 || fetchedAt == null || fetchedAt.isBefore(open)) {
            return out;   // 묵은 저장본·다른 세션 — 사건을 만들지 않음
        }
        String fetched = fetchedAt.toString();
        IntradayPolicy policy = IntradayPolicy.from(row.body());
        FreeTimingSettings free = FreeTimingSettings.from(row.body());
        for (String code : books) {
            int max = free.intradayMax(code);
            if (!policy.events(code) || !free.on(code) || max < 1 || fetched.equals(eventSnapshotSeen.get(code))) {
                continue;
            }
            Set<String> used = usedKeys(store.intradayPlans(code, session));
            List<Event> fresh = detect(snapshot.payload(), session, calendar, korea, source.held(code, session), source.stopPct()).stream()
                    .filter(e -> !used.contains(e.key()) && !eventsUsed.contains(code + "|" + e.key())).toList();
            if (fresh.isEmpty()) {
                eventSnapshotSeen.put(code, fetched);
                continue;
            }
            Decision decision = sessionDecision(code, session, calendar).orElse(null);
            String blocked = decision == null ? NO_DECISION : gate.blocked(code, decision);
            EventOutcome outcome = ledger.exclusively(() -> store.atomically(() -> applyEvents(code, session, calendar, korea, now, max,
                    fresh, decision, blocked)));
            if (outcome.step() == EventStep.WAIT) {
                continue;   // 같은 저장본을 다음 주기에 다시 봄
            }
            eventSnapshotSeen.put(code, fetched);
            fresh.forEach(e -> eventsUsed.add(code + "|" + e.key()));
            out.put(outcome.key(), outcome.text());
        }
        return out;
    }

    /** 사건 한 걸음의 쓰기(장부 잠금 안 한 트랜잭션) — 계좌 상태·행을 다시 읽어 정합니다. */
    private EventOutcome applyEvents(String code, LocalDate session, TradingCalendar calendar, boolean korea, Instant now, int max,
                                     List<Event> events, Decision decision, String blocked) {
        String zone = korea ? " KST" : " ET";
        String labels = String.join(", ", events.stream().map(Event::label).toList());
        String suppressKey = code + " " + session + " 사건";
        Book book = store.book(code).orElse(null);
        if (book == null || !PaperBooks.ACTIVE.equals(book.status())) {
            return new EventOutcome(EventStep.SUPPRESS, suppressKey, "SUPPRESSED " + NOT_ACTIVE + ": " + labels);
        }
        List<IntradayPlan> rows = store.intradayPlans(code, session);
        EventPlan plan = planEvents(rows, session, calendar, korea, now, max);
        switch (plan.step()) {
            case WAIT -> {
                return new EventOutcome(EventStep.WAIT, null, null);
            }
            case SUPPRESS -> {
                return new EventOutcome(EventStep.SUPPRESS, suppressKey, "SUPPRESSED " + plan.reason() + ": " + labels);
            }
            case APPEND -> {
                if (blocked != null) {
                    return new EventOutcome(EventStep.SUPPRESS, suppressKey, "SUPPRESSED " + blocked + ": " + labels);
                }
                IntradayPlan created = IntradayPlan.planned(code, session, plan.slot(), plan.at(), ExecutionSection.FEED_MINUTE,
                        eventTickers(List.of(), events), EVENT_QUESTION, variant(korea), false, decision.id(), null, IntradayPlan.ORIGIN_EVENT,
                        trigger(null, null, events, calendar, korea));
                if (!store.upsertPlannedIntradayPlan(created)) {
                    return new EventOutcome(EventStep.SUPPRESS, suppressKey, "SUPPRESSED 순번 " + plan.slot() + "이 끝난 행: " + labels);
                }
                return new EventOutcome(EventStep.APPEND, PaperIntradayJob.key(created), PaperBooks.CHECKPOINT_PLANNED + " "
                        + IntradayPlan.ORIGIN_EVENT + " " + FreeTiming.label(plan.at()) + zone + " — " + labels);
            }
            case PULL -> {
                IntradayPlan p = plan.row();
                if (blocked == null) {
                    // 미국 시간별 피드는 감시 1분봉으로 — 당긴 시각(장 초반 포함)에도 자료가 오게(시간별 관측치는 매시 :15).
                    IntradayPlan pulled = IntradayPlan.planned(code, session, p.slot(), plan.at(), ExecutionSection.FEED_MINUTE,
                            eventTickers(p.watch(), events), p.question(), p.variant(), p.manual(), p.sourceDecisionId(),
                            p.requestedByDecisionId(), IntradayPlan.ORIGIN_EVENT,
                            trigger(p.trigger(), FreeTiming.label(p.atLocal()), events, calendar, korea));
                    if (store.upsertPlannedIntradayPlan(pulled)) {
                        return new EventOutcome(EventStep.PULL, PaperIntradayJob.key(pulled), "EVENT PULL " + FreeTiming.label(plan.at()) + zone
                                + "(원래 " + FreeTiming.label(p.atLocal()) + ") — " + labels);
                    }
                }
                // 당길 수 없음(부를 때 막힘) — 그 예약에 사건만 붙임.
                store.attachIntradayTrigger(code, session, p.slot(), trigger(p.trigger(), null, events, calendar, korea));
                return new EventOutcome(EventStep.ATTACH, PaperIntradayJob.key(p), "EVENT ATTACH " + FreeTiming.label(p.atLocal()) + zone
                        + (blocked == null ? "" : "(당기지 않음 — " + blocked + ")") + " — " + labels);
            }
            default -> {
                IntradayPlan p = plan.row();
                store.attachIntradayTrigger(code, session, p.slot(), trigger(p.trigger(), null, events, calendar, korea));
                return new EventOutcome(EventStep.ATTACH, PaperIntradayJob.key(p), "EVENT ATTACH " + FreeTiming.label(p.atLocal()) + zone
                        + " — " + labels);
            }
        }
    }

    private static Instant instant(String text) {
        if (text == null) {
            return null;
        }
        try {
            return java.time.OffsetDateTime.parse(text).toInstant();
        } catch (java.time.format.DateTimeParseException e) {
            try {
                return Instant.parse(text);
            } catch (java.time.format.DateTimeParseException again) {
                return null;
            }
        }
    }
}
