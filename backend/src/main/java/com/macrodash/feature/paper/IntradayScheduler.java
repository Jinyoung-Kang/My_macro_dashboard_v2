package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * 장중 판단 계획 행을 결정 응답 밖에서 넣거나 당기는 규칙(자유 시점 판 — ADR 0027 결정 3, 명세 docs/specs/2026-11-05-free-fill-timing.md §7) — 운영자
 * 당김({@link IntradayManualService})이 씁니다. 결정의 예약·장중 판단의 다음 예약은 {@link IntradayPlanner}가 씁니다.
 *
 * <p>규칙은 결정이 지키는 불변식을 그대로 둡니다: 끝난 순번(DONE·EXPIRED·SKIPPED) &lt; PLANNED 순번이고 PLANNED 순번 순 = 시각 순입니다. 그래서 당김은
 * 가장 이른 PLANNED 행을 고르고, 새 행은 끝난 순번 가운데 가장 큰 것 + 1을 씁니다(뒤 결정이 닫은 SUPERSEDED 순번은 다시 씀).
 */
final class IntradayScheduler {

    /** 운영자가 넣은 새 행의 질문. */
    static final String MANUAL_QUESTION = "운영자가 요청한 장중 판단 — 지금 대기 주문과 보유를 그대로 둘지 본다";
    /** 당긴 시각 = 지금을 분으로 내린 뒤 + 이만큼. */
    static final Duration AHEAD = Duration.ofMinutes(1);

    private final PaperStore store;
    private final ObjectMapper mapper;

    IntradayScheduler(PaperStore store, ObjectMapper mapper) {
        this.store = store;
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
}
