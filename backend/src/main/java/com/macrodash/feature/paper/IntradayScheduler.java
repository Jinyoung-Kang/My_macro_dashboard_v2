package com.macrodash.feature.paper;

import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 장중 판단 계획 행을 결정 응답 밖에서 넣거나 당기는 규칙(자유 시점 판 — ADR 0027 결정 3·ADR 0031 초안 결정 4, 명세
 * docs/specs/2026-11-05-free-fill-timing.md §7) — 운영자 당김({@link IntradayManualService})과 코드의 보장 1회({@link #guarantee} — 장중 판단 작업
 * {@link PaperIntradayJob}·{@link PaperKrIntradayJob}이 주기마다)가 씁니다. 결정의 예약·장중 판단의 다음 예약은 {@link IntradayPlanner}가 씁니다.
 *
 * <p>규칙은 결정이 지키는 불변식을 그대로 둡니다: 끝난 순번(DONE·EXPIRED·SKIPPED) &lt; PLANNED 순번이고 PLANNED 순번 순 = 시각 순입니다. 그래서 당김은
 * 가장 이른 PLANNED 행을 고르고, 새 행은 끝난 순번 가운데 가장 큰 것 + 1을 씁니다(뒤 결정이 닫은 SUPERSEDED 순번은 다시 씀).
 *
 * <p><b>보장</b>(설정 {@value IntradayPolicy#US_MIN}·{@value IntradayPolicy#KR_MIN} ≥ 1, 기본 0 — 사용자 결정 2026-11-06 '최소 1'): 보장 시각 G(개장
 * 기준 — 미국 + {@link #GUARANTEE_AFTER_OPEN_US}, 보통 날 12:30 ET · 한국 + {@link #GUARANTEE_AFTER_OPEN_KR}, 보통 날 11:30 KST, 받는 범위 끝 − 1분으로 자름)가
 * 지났는데 그 세션에 남은 예약(PLANNED)이 없고 부른 판단(DONE)이 최소 횟수보다 적으면, 순번이 남았을 때 한 행을 넣습니다 — 시각 = max(G, 지금 + 1분,
 * 끝난 판단 시각 + {@link IntradayRequest#MIN_GAP}), 받는 범위 안일 때만. 출처 {@value PaperStore.IntradayPlan#ORIGIN_GUARANTEE}, 수동 아님(정기 문턱으로
 * 셈), 피드는 운영자 새 행과 같음(미국 시간별 관측치 — 감시 목록 없이도 되는 피드, 한국 감시 1분봉). 그 계좌의 스위치가 켜져 있고 그 세션의 자유 시점 판
 * 결정이 있으며 계좌가 운용 중이고, 부를 때 막힐 것(작업이 보는 {@link Gate} — 파이프라인·계좌2 꺼짐·계좌2 소상한·하루 정기 문턱)이 없을 때만입니다.
 * 행이 있으면 다시 넣지 않아 같은 주기·재기동에도 한 번이고, 넣은 예약이 놓침·건너뜀으로 끝나면 순번이 남은 동안 다시 넣습니다(재시도 없음 규칙과 상한
 * 때문에 '최소 1'은 절대 보장이 아님).
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
    /** 보장 행의 질문. */
    static final String GUARANTEE_QUESTION = "코드가 부른 보장 판단 — 이 세션에 장중 판단이 아직 없어 세션 중간에 한 번 본다(대기 주문과 보유를 그대로 둘지)";

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
     * 그 세션의 보장 시각 G — 개장 + 오프셋(미국 180분·한국 150분). 받는 범위 끝({@link IntradayRequest#window}) − {@link #AHEAD}보다 늦으면 그 시각
     * (미국 조기 폐장일 13:00 마감이면 범위 끝 12:30 − 1분 = 12:29 — 그때 넣는 행의 시각 '지금 + 1분'이 범위 안에 들게).
     */
    static Instant guaranteeAt(LocalDate session, TradingCalendar calendar, boolean korea) {
        Instant at = calendar.openInstant(session).plus(korea ? GUARANTEE_AFTER_OPEN_KR : GUARANTEE_AFTER_OPEN_US);
        Instant latest = IntradayRequest.window(session, calendar, korea).last().minus(AHEAD);
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
}
