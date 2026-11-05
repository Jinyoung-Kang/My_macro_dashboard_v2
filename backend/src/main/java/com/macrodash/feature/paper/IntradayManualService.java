package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.IntradayPlan;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.temporal.ChronoUnit;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;

/**
 * 장중 판단을 운영자가 당기는 수동 경로(자유 시점 판 — ADR 0027 결정 3, 명세 docs/specs/2026-11-05-free-fill-timing.md §7 '수동 실행') —
 * {@code POST /api/paper/run/intraday}. <b>예약만 합니다</b>: 그 계좌의 오늘 세션에서 가장 이른 남은 PLANNED 계획 행의 확인 시각을 '지금 + 1분'으로
 * 당기고 수동 표시({@code manual})를 켜거나, 남은 예약이 없고 순번이 남았으면 새 행을 넣습니다. Claude 호출은 장중 판단 작업
 * ({@link PaperIntradayJob}·{@link PaperKrIntradayJob})이 자기 잠금 안에서 그 시각 + 2분 뒤 창에 한 번 합니다 — 같은 창의 정기 주기와 겹쳐 두 번
 * 과금되지 않게. 수동 행은 수동 문턱(하루 상한 − 정기 작업 몫 예약)으로 셉니다.
 *
 * <p>거절(400): 그 시장의 Claude 계좌가 아님, 정기 작업이 꺼진 서버({@code PAPER_ENABLED=false} — 부를 작업이 없음), 세션당 횟수 설정이 0
 * (계좌2는 {@code claude2.enabled} 꺼짐), 오늘이 거래일이 아님·지금 + 1분이 받는 범위 밖, 계좌가 운용 중이 아님, 가장 이른 예약이 이미 호출 창에
 * 들어옴(당길 것이 없음), 새 행을 넣을 오늘 세션의 자유 시점 판 결정이 없음. 순번을 다 썼으면 409입니다.
 *
 * <p>새 행의 볼 자료는 미국 시간별 관측치({@code HOURLY} — 감시 목록 없이도 되는 피드), 한국 감시 1분봉({@code MINUTE} — 한국은 늘, 보유·대기·기준
 * 종목)입니다. 당긴 행은 예약한 피드·감시 목록·질문 그대로입니다. 쓰기는 장부 잠금 안 한 트랜잭션입니다.
 */
@Service
public class IntradayManualService {

    /** 운영자가 넣은 새 행의 질문. */
    static final String MANUAL_QUESTION = "운영자가 요청한 장중 판단 — 지금 대기 주문과 보유를 그대로 둘지 본다";
    /** 당긴 시각 = 지금을 분으로 내린 뒤 + 이만큼. */
    static final Duration AHEAD = Duration.ofMinutes(1);

    private final PaperStore store;
    private final PaperMarkets markets;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;

    @Autowired
    IntradayManualService(PaperStore store, PaperMarkets markets, PaperLedgerService ledger, PaperConfig config,
                          ObjectMapper mapper) {
        this(store, markets, ledger, config, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다. */
    IntradayManualService(PaperStore store, PaperMarkets markets, PaperLedgerService ledger, PaperConfig config,
                          ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.markets = markets;
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
    }

    /**
     * 당긴(또는 새로 넣은) 계획 행.
     *
     * @param created 새 행을 넣었으면 참, 있던 예약을 당겼으면 거짓
     * @param korea   한국 계좌인가(시각 표기의 시간대)
     */
    record Pulled(String book, LocalDate session, int slot, LocalTime at, String feed, boolean created, boolean korea) {
    }

    /**
     * 그 계좌의 오늘 세션 장중 판단을 지금으로 당깁니다(클래스 설명).
     *
     * @throws InvalidRequestException 받는 조건이 아님(클래스 설명의 400)
     * @throws ResponseStatusException 409 — 오늘 세션의 순번을 다 씀
     */
    Pulled pull(PaperMarket market, String book) {
        boolean korea = market.definition() == KrPaperMarket.INSTANCE;
        String code = Params.oneOf("book", book, korea ? PaperKrIntradayJob.BOOKS : PaperIntradayJob.BOOKS);
        if (!config.enabled()) {
            throw new InvalidRequestException("이 서버는 모의 매매 정기 작업이 꺼져 있어(PAPER_ENABLED=false) 장중 판단을 부를 작업이 없습니다.");
        }
        MarketRun run = markets.open(market);
        SettingsRow row = run.settingsRow().orElseThrow(() -> new InvalidRequestException(
                "모의 매매 설정이 없습니다 — 초기화를 먼저 하세요."));
        int max = Math.min(FreeTimingSettings.from(row.body()).intradayMax(code), RuleBookService.INTRADAY_MAX);
        if (max <= 0) {
            throw new InvalidRequestException("세션당 장중 판단 횟수 설정이 0입니다 — 장중 판단을 부르지 않습니다(설정 "
                    + (korea ? FreeTimingSettings.KR_INTRADAY_MAX : FreeTimingSettings.US_INTRADAY_MAX) + ").");
        }
        if (PaperBooks.CLAUDE2.equals(code) && !Claude2Settings.from(row.body()).enabled()) {
            throw new InvalidRequestException("계좌2가 꺼져 있습니다(설정 claude2.enabled) — 장중 판단을 부르지 않습니다.");
        }
        TradingCalendar calendar = run.calendar();
        Instant now = clock.instant();
        LocalDate session = now.atZone(calendar.zone()).toLocalDate();
        String zone = korea ? " KST" : " ET";
        if (!calendar.isTradingDay(session)) {
            throw new InvalidRequestException("오늘(" + session + ")은 거래일이 아닙니다 — 장중 판단은 정규장 안에서만 부릅니다.");
        }
        Instant at = now.truncatedTo(ChronoUnit.MINUTES).plus(AHEAD);
        IntradayRequest.Window window = IntradayRequest.window(session, calendar, korea);
        if (!window.accepts(at)) {
            throw new InvalidRequestException("지금은 장중 판단을 받는 시간이 아닙니다 — " + session + " "
                    + FreeTiming.label(window.first().atZone(calendar.zone()).toLocalTime()) + "~"
                    + FreeTiming.label(window.last().atZone(calendar.zone()).toLocalTime()) + zone + " 안에서만 당길 수 있습니다.");
        }
        LocalTime local = at.atZone(calendar.zone()).toLocalTime();
        return ledger.exclusively(() -> store.atomically(() -> {
            Book current = store.book(code).orElseThrow(() -> new InvalidRequestException("계좌 " + code + "가 없습니다 — 초기화를 먼저 하세요."));
            if (!PaperBooks.ACTIVE.equals(current.status())) {
                throw new InvalidRequestException("계좌 " + code + "가 운용 중이 아닙니다(상태 " + current.status() + ") — 장중 판단을 부르지 않습니다.");
            }
            List<IntradayPlan> rows = store.intradayPlans(code, session);
            Optional<IntradayPlan> earliest = rows.stream().filter(p -> PaperBooks.CHECKPOINT_PLANNED.equals(p.status()))
                    .min(Comparator.comparing(IntradayPlan::atLocal));
            if (earliest.isPresent()) {
                IntradayPlan p = earliest.get();
                if (!p.atLocal().isAfter(local)) {
                    throw new InvalidRequestException("가장 이른 예약(" + FreeTiming.label(p.atLocal()) + zone + ", " + p.slot()
                            + "번째)이 이미 부를 차례입니다 — 당길 것이 없습니다(장중 판단 작업이 그 시각 + 2분 뒤 창에서 부릅니다).");
                }
                store.upsertPlannedIntradayPlan(IntradayPlan.planned(code, session, p.slot(), local, p.feed(), p.watch(), p.question(),
                        p.variant(), true, p.sourceDecisionId(), p.requestedByDecisionId()));
                return new Pulled(code, session, p.slot(), local, p.feed(), false, korea);
            }
            int next = 1 + rows.stream().filter(IntradayPlanner::finished).mapToInt(IntradayPlan::slot).max().orElse(0);
            if (next > max) {
                throw new ResponseStatusException(HttpStatus.CONFLICT, "오늘 세션(" + session + ")의 장중 판단 횟수(" + max
                        + "번)를 다 썼습니다.");
            }
            Decision source = sessionDecision(code, session, calendar).orElseThrow(() -> new InvalidRequestException(
                    "오늘 세션(" + session + ")의 자유 시점 판 결정이 없습니다 — 장중 판단은 그 세션의 결정이 자유 시점 판일 때만 부릅니다."));
            String feed = korea ? ExecutionSection.FEED_MINUTE : ExecutionSection.FEED_HOURLY;
            store.upsertPlannedIntradayPlan(IntradayPlan.planned(code, session, next, local, feed, List.of(), MANUAL_QUESTION,
                    korea ? KrPacketBuilder.KR_FREE_FIXED_RULES_VERSION : PacketBuilder.FREE_FIXED_RULES_VERSION, true, source.id(),
                    null));
            return new Pulled(code, session, next, local, feed, true, korea);
        }));
    }

    /**
     * 오늘 세션을 목표로 한 그 계좌의 자유 시점 판 결정 — 기준 거래일이 오늘 세션의 앞 거래일인 정기·수동·출발 결정 가운데 판단을 낸 것(OK·NO_TRADE)
     * 이고 보낸 패킷의 판이 자유 시점 판({@code 1_basis.variant})인 것, 가장 늦게 낸 것. 스위치를 그 결정 뒤에 켰으면 없습니다(끈 판 결정의 주문을
     * 켠 판이 받지 않음).
     */
    private Optional<Decision> sessionDecision(String code, LocalDate session, TradingCalendar calendar) {
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
