package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.realtrade.ManualAccountLedger.Entry;
import com.macrodash.feature.realtrade.ManualAccountLedger.Holding;
import com.macrodash.feature.realtrade.ManualAccountLedger.State;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Account;
import com.macrodash.store.ManualAccountStore.Instruction;
import com.macrodash.store.ManualAccountStore.StopInstruction;
import com.macrodash.store.ManualAccountStore.LedgerRow;
import com.macrodash.store.ManualAccountStore.LedgerValues;
import com.macrodash.store.ManualAccountStore.SessionRow;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Pattern;

/**
 * ISA 계좌 API(운영자 전용 — ADR 0029, 명세 docs/specs/2026-11-06-isa-manual-account.md §1·§3·§5) — 연결되지 않은 다른 증권사 계좌의 장부와 다음 시가 매매
 * 지시를 보여 주고, 시작·장부 고침·지시 건너뜀을 받습니다. 증권사 호출·주문은 없습니다(돈을 움직이는 것은 사용자).
 *
 * <ul>
 *   <li><b>장부가 정본</b>: 현금·보유·평단은 장부 행으로만 셉니다({@link ManualAccountLedger}). 쓰기는 모두 계좌 행을 잡은 트랜잭션 안에서 장부를 다시 읽고,
 *       고친 뒤의 장부가 어느 시점에서도 현금·보유가 음수가 되지 않을 때만 씁니다(아니면 400 {@code ledger-invalid}).</li>
 *   <li><b>시작</b>은 한 번만(이미 시작했으면 409 {@code already-started}) — 시작 현금(DEPOSIT)과 시작 매수(BUY, USER)를 한 트랜잭션으로.</li>
 *   <li><b>고침</b>: 장부 행 추가·수정(정기 작업이 자동 기록한 행을 고치면 USER가 됨)·삭제, 지시 건너뜀. 지시에 묶어 넣은 행은 그 지시를 RECORDED로 둡니다
 *       (자동 기록보다 사용자 입력이 우선 — 그 지시에 자동 기록 행만 묶여 있으면 같은 트랜잭션에서 그 행을 지우고 바꾸며, 직접 입력한 행이 이미 묶여 있으면
 *       409 {@code already-recorded}). 지시에 묶인 마지막 행을 지우면 그 지시는 SKIPPED입니다(다시 자동 기록하지 않음).</li>
 *   <li><b>고친 장부로 다음 지시</b>: 장부를 바꾸는 쓰기(추가·고침·삭제, 자동 기록 행을 지우는 건너뜀)는 같은 잠금 안에서 다음 세션 S의 지시가 이미 있으면
 *       S 08:00(KST) 전에는 S의 묶인 행 없는 PLANNED 지시와 S 세션 행을 지워 정기 작업이 고친 장부로 다시 만들게 하고(알림을 이미 보냈으면 다시 만든 지시를
 *       '다시 계산'으로 알림), 08:00 뒤에는 이미 장전 주문을 냈을 수 있어 지우지 않고 '지시 뒤 장부가 바뀜'({@code instructions.ledgerChanged})만 남깁니다.</li>
 *   <li>평가는 마지막 가격({@link PaperMirrorService#lastPrices})으로 — 모르는 종목은 평가에서 빼고 {@code unpriced}로 알리며, 그때 손익은 비웁니다
 *       (없는 숫자를 만들지 않음).</li>
 *   <li>거절은 {@code {ok:false, error, message}}(400 {@code invalid-request}·{@code ledger-invalid}, 404 {@code not-found}, 409 {@code already-started}·
 *       {@code not-started}·{@code already-recorded}). 메시지에 금액·종목을 넣지 않습니다. 장부 작업이라 비밀번호는 없습니다(Origin 검사는 기존 SessionFilter).</li>
 * </ul>
 */
@Service
public class ManualAccountService {

    static final String CODE = "isa";
    static final String LABEL = "ISA 계좌";
    /** 따라 하는 모의 책 — 한국 규칙 계좌. */
    static final String SOURCE_BOOK = "kr_rules";
    static final int LEDGER_SHOWN = 200;
    static final int INSTRUCTIONS_SHOWN = 30;
    static final int MAX_BUYS = 100;
    static final int NOTE_MAX = 200;
    /** 시각이 지금보다 이만큼 넘게 뒤면 받지 않습니다(입력 실수). */
    static final Duration FUTURE_SLACK = Duration.ofMinutes(10);
    static final BigDecimal MAX_QUANTITY = new BigDecimal("1000000000");
    static final BigDecimal MAX_PRICE = new BigDecimal("10000000000");
    static final BigDecimal MAX_AMOUNT = new BigDecimal("1000000000000000");

    /** 표가 없을 때의 안내(보기의 {@code message}). */
    static final String NOT_READY = "ISA 계좌 표가 아직 없습니다 — 수집기가 마이그레이션(V25)을 적용한 뒤 다시 보세요.";

    private static final Pattern KR_SYMBOL = Pattern.compile("^[0-9][0-9A-Z]{5}$");
    private static final Set<String> KINDS = Set.of(ManualAccountStore.KIND_DEPOSIT, ManualAccountStore.KIND_WITHDRAW,
            ManualAccountStore.KIND_BUY, ManualAccountStore.KIND_SELL, ManualAccountStore.KIND_ADJUST);
    private static final BigDecimal HUNDRED = new BigDecimal("100");

    // ------------------------------------------------------------------ 요청 본문
    /** 시작 매수 한 줄. */
    public record StartBuy(String symbol, BigDecimal quantity, BigDecimal price) {

        @Override
        public String toString() {
            return "StartBuy[symbol=" + symbol + "]";
        }
    }

    /** {@code POST /api/manual/isa/start} 본문. {@code startedAt}은 ISO 시각(오프셋 없으면 KST), 없으면 지금. */
    public record StartRequest(BigDecimal cash, String startedAt, List<StartBuy> buys) {

        @Override
        public String toString() {
            return "StartRequest[buys=" + (buys == null ? 0 : buys.size()) + "]";
        }
    }

    /** {@code POST /api/manual/isa/ledger} 본문 — {@code id}가 있으면 그 행을 고치고, 없으면 새 행. */
    public record LedgerRequest(Long id, String kind, String symbol, BigDecimal quantity, BigDecimal price, BigDecimal amount,
                                BigDecimal fee, BigDecimal tax, String at, String note, Long instructionId) {

        @Override
        public String toString() {
            return "LedgerRequest[id=" + id + ", kind=" + kind + ", instructionId=" + instructionId + "]";
        }
    }

    /** {@code POST /api/manual/isa/instructions/confirm} 본문 — 지시 번호들과 표시할지({@code confirmed}, 없으면 표시, false면 표시를 지움). */
    public record ConfirmRequest(List<Long> ids, Boolean confirmed) {
    }

    /** 한 번에 표시하는 지시 수 상한(한 세션의 지시는 많아야 수십 줄). */
    static final int MAX_CONFIRM_IDS = 200;

    /** 체결 한 줄 — 다음 시가 지시({@code instructionId})나 장중 스탑 지시({@code stopInstructionId}) 하나에 묶입니다(둘 중 하나만). */
    public record FillItem(Long instructionId, Long stopInstructionId, BigDecimal quantity, BigDecimal price, BigDecimal fee, BigDecimal tax) {

        @Override
        public String toString() {
            return "FillItem[instructionId=" + instructionId + ", stopInstructionId=" + stopInstructionId + "]";
        }
    }

    /** {@code POST /api/manual/isa/instructions/fills} 본문. */
    public record FillsRequest(List<FillItem> fills) {

        @Override
        public String toString() {
            return "FillsRequest[fills=" + (fills == null ? 0 : fills.size()) + "]";
        }
    }

    private final ManualAccountStore store;
    private final PaperMirrorService paper;
    private final ManualAccountJob job;
    private final Clock clock;

    @Autowired
    ManualAccountService(ManualAccountStore store, PaperMirrorService paper, ManualAccountJob job) {
        this(store, paper, job, Clock.systemUTC());
    }

    /** 시험용 — 시계를 정합니다. */
    ManualAccountService(ManualAccountStore store, PaperMirrorService paper, ManualAccountJob job, Clock clock) {
        this.store = store;
        this.paper = paper;
        this.job = job;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ 보기
    /** {@code GET /api/manual/isa}(명세 §5). */
    public Map<String, Object> view() {
        Map<String, Object> out = new LinkedHashMap<>();
        boolean ready = store.ready();
        Optional<Account> account = ready ? store.account(CODE) : Optional.empty();
        out.put("available", ready);
        out.put("started", account.isPresent());
        out.put("serverTime", iso(clock.instant()));
        out.put("account", account(account.orElse(null), null));
        Map<String, Object> jobView = new LinkedHashMap<>();
        jobView.put("enabled", job.enabled());
        jobView.put("lastCycleAt", iso(job.lastCycleAt()));
        out.put("job", jobView);
        List<String> notes = new ArrayList<>();
        if (!ready || account.isEmpty()) {
            out.put("summary", null);
            out.put("holdings", List.of());
            out.put("instructions", null);
            out.put("pendingInstructions", List.of());
            out.put("recentInstructions", List.of());
            out.put("stopInstructions", List.of());
            out.put("ledger", List.of());
            if (!ready) {
                out.put("message", NOT_READY);
            }
            notes.add(ready ? "시작 전입니다 — 시작 현금과 지금 들고 있는 종목(시작 매수)을 넣으면 그 장부로 다음 시가 매매 지시를 만듭니다." : NOT_READY);
            out.put("notes", notes);
            return out;
        }
        Account acc = account.get();
        List<LedgerRow> rows = store.ledger(CODE);
        State state = ManualAccountLedger.replay(rows.stream().map(Entry::of).toList());
        Optional<SessionRow> latest = store.latestSession(CODE);
        List<Instruction> current = latest.map(s -> store.instructions(CODE, s.session())).orElse(List.of());
        List<Instruction> planned = store.plannedInstructions(CODE);
        // 최신 세션보다 앞 세션의 PLANNED 지시 — 처리(체결 고치기·건너뜀)해야 다음 지시를 만듦
        List<Instruction> pending = planned.stream().filter(i -> latest.isEmpty() || i.session().isBefore(latest.get().session())).toList();
        List<Instruction> recent = store.recentInstructions(CODE, INSTRUCTIONS_SHOWN);
        List<StopInstruction> stops = store.recentStopInstructions(CODE, INSTRUCTIONS_SHOWN);
        List<LedgerRow> shown = store.recentLedger(CODE, LEDGER_SHOWN);

        Set<String> symbols = new TreeSet<>(state.holdings().keySet());
        current.forEach(i -> symbols.add(i.symbol()));
        pending.forEach(i -> symbols.add(i.symbol()));
        recent.forEach(i -> symbols.add(i.symbol()));
        stops.forEach(i -> symbols.add(i.symbol()));
        shown.stream().map(LedgerRow::symbol).filter(Objects::nonNull).forEach(symbols::add);
        Map<String, String> names = paper.names(symbols);
        Map<String, BigDecimal> last = paper.lastPrices(state.holdings().keySet());

        BigDecimal marketValue = BigDecimal.ZERO;
        List<String> unpriced = new ArrayList<>();
        for (Holding h : state.holdings().values()) {
            BigDecimal price = last.get(h.symbol());
            if (price == null || h.quantity().signum() <= 0) {
                if (h.quantity().signum() > 0) {
                    unpriced.add(h.symbol());
                }
                continue;
            }
            marketValue = marketValue.add(h.quantity().multiply(price));
        }
        BigDecimal equity = state.cash().add(marketValue);
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("cash", money(state.cash()));
        summary.put("marketValue", money(marketValue));
        summary.put("equity", money(equity));
        summary.put("netDeposit", money(state.netDeposit()));
        BigDecimal profit = unpriced.isEmpty() ? equity.subtract(state.netDeposit()) : null;
        summary.put("profitLoss", profit == null ? null : money(profit));
        summary.put("profitLossPct", profit == null || state.netDeposit().signum() <= 0 ? null
                : plain(profit.multiply(HUNDRED).divide(state.netDeposit(), 2, RoundingMode.HALF_UP)));
        summary.put("unpriced", unpriced);
        out.put("summary", summary);
        // 시작 현금 — 장부 기준(시작 시각의 입금 행 합 — 시작 입금 행을 고치면 따라 바뀜). 같은 키라 칸 순서는 그대로
        out.put("account", account(acc, startCash(rows, acc.startedAt())));

        List<Map<String, Object>> holdings = new ArrayList<>();
        for (Holding h : state.holdings().values()) {
            BigDecimal price = last.get(h.symbol());
            BigDecimal value = price == null ? null : h.quantity().multiply(price);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("symbol", h.symbol());
            row.put("name", names.get(h.symbol()));
            row.put("quantity", plain(h.quantity()));
            row.put("avgPrice", plain(h.avgPrice()));
            row.put("lastPrice", plain(price));
            row.put("marketValue", value == null ? null : money(value));
            row.put("weightPct", value == null || equity.signum() <= 0 ? null
                    : plain(value.multiply(HUNDRED).divide(equity, 2, RoundingMode.HALF_UP)));
            holdings.add(row);
        }
        out.put("holdings", holdings);

        if (latest.isPresent()) {
            SessionRow row = latest.get();
            Map<String, Object> block = new LinkedHashMap<>();
            block.put("session", row.session().toString());
            block.put("status", row.state());
            List<Map<String, Object>> items = new ArrayList<>();
            current.forEach(i -> items.add(instruction(i, names, false)));
            block.put("items", items);
            SessionHours hours = ManualAccountCalendar.hours(paper, row.session());
            block.put("open", hours == null ? null : iso(hours.open()));
            JsonNode reason = row.detail() == null ? null : row.detail().get("reason");
            block.put("reason", reason != null && reason.isString() ? reason.asString() : null);
            block.put("ledgerChanged", row.ledgerChangedAt() != null);
            JsonNode target = row.detail() == null ? null : row.detail().get(ManualAccountJob.DETAIL_TARGET_AT);
            block.put("targetAt", target != null && target.isString() ? target.asString() : null);   // 시각 맞추기 지시(ADR 0033), 시가 지시면 null
            out.put("instructions", block);
        } else {
            out.put("instructions", null);
        }
        List<Map<String, Object>> pendingItems = new ArrayList<>();
        pending.forEach(i -> pendingItems.add(instruction(i, names, true)));
        out.put("pendingInstructions", pendingItems);
        List<Map<String, Object>> recentItems = new ArrayList<>();
        recent.forEach(i -> recentItems.add(instruction(i, names, true)));
        out.put("recentInstructions", recentItems);
        List<Map<String, Object>> stopItems = new ArrayList<>();
        stops.forEach(i -> stopItems.add(stopInstruction(i, names)));
        out.put("stopInstructions", stopItems);
        List<Map<String, Object>> ledger = new ArrayList<>();
        Map<Long, BigDecimal> realized = ManualAccountLedger.realizedPct(rows.stream().map(Entry::of).toList());
        shown.forEach(r -> ledger.add(ledgerRow(r, names, realized.get(r.id()))));
        out.put("ledger", ledger);

        notes.add("자동 기록은 지시대로 규칙 계좌와 같은 값 — 시가 지시는 그 세션 시가, 개장 10분 뒤 시각 맞추기 지시·장중 스탑 지시는 그 시각의 1분봉 값 — "
                + "에 수수료·세금 0으로 적습니다 — 실제 체결과 다르면 고치세요.");
        if (!acc.active()) {
            notes.add("계좌가 멈춤 상태라 지시를 만들거나 자동 기록하지 않습니다.");
        }
        if (!job.enabled()) {
            notes.add("이 서버의 정기 작업이 꺼져 있어 지시를 만들거나 자동 기록하지 않습니다(모의 매매 정기 작업이 도는 서버에서만 동작).");
        }
        if (!unpriced.isEmpty()) {
            notes.add("가격을 모르는 종목 " + unpriced.size() + "개는 평가에서 뺐고, 그동안 손익은 비웁니다.");
        }
        Instant now = clock.instant();
        LocalDate today = Kst.today(clock);
        Instant todayOpen = Optional.ofNullable(ManualAccountCalendar.hours(paper, today)).map(SessionHours::open).orElse(null);
        long waiting = planned.stream().filter(i -> i.session().isBefore(today)
                || (i.session().equals(today) && todayOpen != null && !now.isBefore(todayOpen))).count();
        if (waiting > 0) {
            notes.add("개장이 지난 지시 " + waiting + "건이 체결 기록을 기다립니다 — 그 세션 밤 시가가 들어오면 지시대로 적고, 그 전에 직접 넣거나 건너뛸 수 있습니다"
                    + "(기록이 끝나야 다음 지시를 만듭니다).");
        }
        ManualAccountJob.Waiting wait = job.waiting();
        if (wait != null && wait.session() != null && (latest.isEmpty() || wait.session().isAfter(latest.get().session()))) {
            notes.add(wait.session() + " 시가 지시 대기 — " + ManualAccountJob.reasonLabel(wait.reason()));
        }
        latest.map(SessionRow::detail).map(d -> d.path("notes")).filter(n -> n.isArray()).ifPresent(n -> n.forEach(x -> {
            if (x.isString()) {
                notes.add(x.asString());
            }
        }));
        out.put("notes", notes);
        return out;
    }

    /** 시작 시각의 입금 행 합(시작 현금 — 장부 기준). 없으면 0. */
    private static BigDecimal startCash(List<LedgerRow> rows, Instant startedAt) {
        BigDecimal sum = BigDecimal.ZERO;
        for (LedgerRow r : rows) {
            if (ManualAccountStore.KIND_DEPOSIT.equals(r.kind()) && r.amount() != null && Objects.equals(r.at(), startedAt)) {
                sum = sum.add(r.amount());
            }
        }
        return sum;
    }

    /** 계좌 칸 — {@code startCash}는 장부 기준 시작 현금(시작 전이면 null). */
    private Map<String, Object> account(Account acc, BigDecimal startCash) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", CODE);
        out.put("label", acc == null ? LABEL : acc.label());
        out.put("market", acc == null ? ManualAccountStore.MARKET_KR : acc.market());
        String book = acc == null ? SOURCE_BOOK : acc.sourceBook();
        out.put("sourceBook", book);
        out.put("sourceLabel", paper.book(book).map(BookInfo::label).orElse(null));
        out.put("state", acc == null ? null : acc.state());
        out.put("startedAt", acc == null ? null : iso(acc.startedAt()));
        out.put("startCash", money(startCash));
        return out;
    }

    private static Map<String, Object> instruction(Instruction i, Map<String, String> names, boolean withSession) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", i.id());
        if (withSession) {
            out.put("session", i.session().toString());
        }
        out.put("symbol", i.symbol());
        out.put("name", names.get(i.symbol()));
        out.put("side", i.side());
        out.put("quantity", i.quantity());
        out.put("refPrice", plain(i.refPrice()));
        out.put("weightPct", plain(i.weightPct()));
        out.put("status", i.status());
        out.put("targetAt", iso(ManualAccountJob.targetAt(i)));
        out.put("notifiedNightAt", iso(i.notifiedNightAt()));
        out.put("notifiedMorningAt", iso(i.notifiedMorningAt()));
        out.put("confirmedAt", iso(i.confirmedAt()));
        out.put("notifiedMiddayAt", iso(i.notifiedMiddayAt()));
        out.put("recordedByUser", ManualAccountJob.recordedByUser(i));
        return out;
    }

    /** 장중 스탑 매도 지시 하나(ADR 0033 결정 7) — 종목·수량·체결 시점·기준 시각·상태·즉시 알림 시각과 자동 기록 메모(금액 없음). */
    private static Map<String, Object> stopInstruction(StopInstruction i, Map<String, String> names) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", i.id());
        out.put("session", i.session().toString());
        out.put("symbol", i.symbol());
        out.put("name", names.get(i.symbol()));
        out.put("side", i.side());
        out.put("quantity", i.quantity());
        out.put("timing", i.timing());
        out.put("targetAt", iso(i.targetAt()));
        out.put("status", i.status());
        out.put("notifiedAt", iso(i.notifiedAt()));
        JsonNode note = i.reason() == null ? null : i.reason().get("autoNote");
        out.put("autoNote", note != null && note.isString() ? note.asString() : null);
        out.put("recordedByUser", recordedByUser(i));
        return out;
    }

    /** 사용자가 체결을 적은 스탑 지시인가(화면이 '매매함' 단추를 빼는 근거 — 자동 기록만 있으면 덮어쓸 수 있음). */
    private static boolean recordedByUser(StopInstruction i) {
        return i.reason() != null && "USER".equals(i.reason().path("recordedBy").asString(""));
    }

    private static Map<String, Object> ledgerRow(LedgerRow r, Map<String, String> names, BigDecimal realizedPct) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", r.id());
        out.put("at", iso(r.at()));
        out.put("kind", r.kind());
        out.put("symbol", r.symbol());
        out.put("name", r.symbol() == null ? null : names.get(r.symbol()));
        out.put("quantity", plain(r.quantity()));
        out.put("price", plain(r.price()));
        boolean trade = ManualAccountStore.KIND_BUY.equals(r.kind()) || ManualAccountStore.KIND_SELL.equals(r.kind());
        BigDecimal amount = trade && r.quantity() != null && r.price() != null ? r.quantity().multiply(r.price()) : r.amount();
        out.put("amount", amount == null ? null : money(amount));
        out.put("fee", plain(r.fee()));
        out.put("tax", plain(r.tax()));
        out.put("source", r.source());
        out.put("instructionId", r.instructionId());
        out.put("stopInstructionId", r.stopInstructionId());
        out.put("note", r.note());
        out.put("realizedPct", plain(realizedPct));   // 매도 행의 실현 손익률(%) — 그 밖의 행·평단을 모르면 null
        return out;
    }

    // ------------------------------------------------------------------ 시작
    /** {@code POST /api/manual/isa/start}(명세 §3) — 한 번만, 한 트랜잭션. */
    public Map<String, Object> start(StartRequest body) {
        requireReady();
        if (body == null) {
            throw ManualAccountException.invalid("요청 본문이 없습니다.");
        }
        BigDecimal cash = amount(body.cash(), "시작 현금", true);
        Instant now = clock.instant();
        // 비우면 지금을 초 단위로 자른 시각 — 화면이 시각을 초까지 되돌려 보내도 시작 행끼리 순서가 뒤집히지 않게
        Instant startedAt = body.startedAt() == null || body.startedAt().isBlank() ? now.truncatedTo(ChronoUnit.SECONDS)
                : instant(body.startedAt(), "시작 시각");
        notFuture(startedAt, now, "시작 시각");
        List<StartBuy> buys = body.buys() == null ? List.of() : body.buys();
        if (buys.size() > MAX_BUYS) {
            throw ManualAccountException.invalid("시작 매수는 " + MAX_BUYS + "줄까지입니다.");
        }
        List<LedgerValues> values = new ArrayList<>();
        values.add(new LedgerValues(startedAt, ManualAccountStore.KIND_DEPOSIT, null, null, null, cash, BigDecimal.ZERO, BigDecimal.ZERO, null,
                ManualAccountStore.SOURCE_USER, "시작 현금"));
        for (StartBuy buy : buys) {
            if (buy == null) {
                throw ManualAccountException.invalid("시작 매수에 빈 줄이 있습니다.");
            }
            values.add(new LedgerValues(startedAt, ManualAccountStore.KIND_BUY, symbol(buy.symbol()), quantity(buy.quantity(), false),
                    price(buy.price()), null, BigDecimal.ZERO, BigDecimal.ZERO, null, ManualAccountStore.SOURCE_USER, "시작 매수"));
        }
        List<Entry> entries = new ArrayList<>();
        for (LedgerValues v : values) {
            entries.add(entry(null, v));
        }
        if (ManualAccountLedger.firstInvalid(entries) != null) {
            throw ManualAccountException.ledgerInvalid("시작 매수 금액이 시작 현금보다 큽니다.");
        }
        store.atomically(() -> {
            if (!store.insertAccount(CODE, LABEL, ManualAccountStore.MARKET_KR, SOURCE_BOOK, startedAt, cash)) {
                throw new ManualAccountException(409, ManualAccountException.ALREADY_STARTED, "이미 시작한 계좌입니다 — 장부에서 고치세요.");
            }
            for (LedgerValues v : values) {
                store.insertLedger(CODE, v);
            }
            return null;
        });
        return Map.of("ok", true);
    }

    // ------------------------------------------------------------------ 장부
    /** {@code POST /api/manual/isa/ledger}(명세 §3·§5) — {@code id}가 있으면 수정, 없으면 추가. */
    public Map<String, Object> saveLedger(LedgerRequest body) {
        requireReady();
        if (body == null) {
            throw ManualAccountException.invalid("요청 본문이 없습니다.");
        }
        Instant now = clock.instant();
        LedgerValues requested = values(body, now);
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        long id = store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            LedgerRow existing = null;
            if (body.id() != null) {
                existing = store.ledgerRow(body.id()).filter(r -> CODE.equals(r.account()))
                        .orElseThrow(() -> ManualAccountException.notFound("장부 행을 찾을 수 없습니다."));
            }
            Long instructionId = body.instructionId() != null ? body.instructionId() : existing == null ? null : existing.instructionId();
            LedgerValues v = withInstruction(requested, instructionId);
            Set<Long> replaced = new TreeSet<>();
            if (instructionId != null) {
                checkLink(instructionId, v);
                if (existing == null || !instructionId.equals(existing.instructionId())) {
                    replaced.addAll(autoRowsToReplace(instructionId, existing == null ? null : existing.id()));
                }
            }
            List<Entry> entries = new ArrayList<>();
            for (LedgerRow r : store.ledger(CODE)) {
                if ((existing == null || r.id() != existing.id()) && !replaced.contains(r.id())) {
                    entries.add(Entry.of(r));
                }
            }
            entries.add(entry(existing == null ? null : existing.id(), v));
            rejectInvalid(entries);
            replaced.forEach(rowId -> store.deleteLedger(CODE, rowId));
            long written;
            if (existing == null) {
                written = store.insertLedger(CODE, v);
            } else {
                store.updateLedger(CODE, existing.id(), v);
                written = existing.id();
                if (existing.instructionId() != null && !existing.instructionId().equals(instructionId)) {
                    skipIfOrphan(existing.instructionId());
                }
            }
            if (instructionId != null) {
                store.updateInstructionStatus(instructionId, ManualAccountStore.STATUS_RECORDED, null, Map.of("recordedBy", "USER"));
            }
            invalidateUpcoming(acc, next, now);
            store.bumpVersion(CODE);
            return written;
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id);
        return out;
    }

    /**
     * {@code POST /api/manual/isa/instructions/fills}(2026-11-09 사용자 결정 — '매매함'에서 체결가를 받아 바로 장부에) — 지시·스탑 지시마다 사용자 체결 한 행을
     * 한 트랜잭션으로 적습니다(한 줄이라도 안 되면 아무것도 적지 않음). 행 시각은 자동 기록과 같은 시각(스탑은 그 기준 시각, 시각 맞추기 지시는 그 시각, 그 밖은
     * 세션 개장)이고, 그 지시의 자동 기록 행은 이 행으로 바꿉니다. 사용자가 이미 적은 지시는 409, 건너뜀·대체된 지시는 400입니다. 묶인 지시는 밤 자동 기록이
     * 다시 적지 않습니다.
     */
    public Map<String, Object> saveFills(FillsRequest body) {
        requireReady();
        if (body == null || body.fills() == null || body.fills().isEmpty() || body.fills().size() > MAX_CONFIRM_IDS
                || body.fills().stream().anyMatch(Objects::isNull)) {
            throw ManualAccountException.invalid("체결을 1줄 이상 " + MAX_CONFIRM_IDS + "줄 이하로 넣으세요.");
        }
        Set<Long> seen = new HashSet<>();
        Set<Long> seenStops = new HashSet<>();
        Map<LocalDate, Instant> opens = new HashMap<>();
        for (FillItem item : body.fills()) {
            if ((item.instructionId() == null) == (item.stopInstructionId() == null)) {
                throw ManualAccountException.invalid("체결 한 줄은 지시 번호나 스탑 지시 번호 가운데 하나에 묶어야 합니다.");
            }
            if (item.instructionId() != null ? !seen.add(item.instructionId()) : !seenStops.add(item.stopInstructionId())) {
                throw ManualAccountException.invalid("같은 지시를 두 줄로 적을 수 없습니다.");
            }
            quantity(item.quantity(), false);
            price(item.price());
            cost(item.fee(), "수수료");
            cost(item.tax(), "세금");
            if (item.instructionId() != null) {   // 달력은 잠금 밖에서 읽음(saveLedger와 같은 이유)
                store.instruction(item.instructionId()).ifPresent(i -> {
                    SessionHours hours = opens.containsKey(i.session()) ? null : ManualAccountCalendar.hours(paper, i.session());
                    if (hours != null) {
                        opens.put(i.session(), hours.open());
                    }
                });
            }
        }
        Instant now = clock.instant();
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        int written = store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            Set<Long> replaced = new TreeSet<>();
            List<LedgerValues> rows = new ArrayList<>();
            for (FillItem item : body.fills()) {
                rows.add(item.instructionId() != null ? instructionFill(item, opens, now, replaced) : stopFill(item, now, replaced));
            }
            List<Entry> entries = new ArrayList<>();
            for (LedgerRow r : store.ledger(CODE)) {
                if (!replaced.contains(r.id())) {
                    entries.add(Entry.of(r));
                }
            }
            rows.forEach(v -> entries.add(entry(null, v)));
            rejectInvalid(entries);
            replaced.forEach(rowId -> store.deleteLedger(CODE, rowId));
            for (LedgerValues v : rows) {
                store.insertLedger(CODE, v);
                if (v.instructionId() != null) {
                    store.updateInstructionStatus(v.instructionId(), ManualAccountStore.STATUS_RECORDED, null, Map.of("recordedBy", "USER"));
                } else {
                    store.updateStopInstructionStatus(v.stopInstructionId(), ManualAccountStore.STATUS_RECORDED, null, Map.of("recordedBy", "USER"));
                }
            }
            invalidateUpcoming(acc, next, now);
            store.bumpVersion(CODE);
            return rows.size();
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("count", written);
        return out;
    }

    /** 잠금 안 — 다음 시가 지시의 체결 한 행(시각은 자동 기록과 같게). 그 지시의 자동 기록 행은 {@code replaced}에 넣습니다. */
    private LedgerValues instructionFill(FillItem item, Map<LocalDate, Instant> opens, Instant now, Set<Long> replaced) {
        Instruction i = store.instruction(item.instructionId()).filter(row -> CODE.equals(row.account()))
                .orElseThrow(() -> ManualAccountException.notFound("지시를 찾을 수 없습니다."));
        requireFillable(i.status());
        replaced.addAll(autoRowsToReplace(i.id(), null));
        Instant target = ManualAccountJob.targetAt(i);
        Instant at = target != null ? target : opens.get(i.session());
        if (at == null) {
            at = i.session().atTime(9, 0).atZone(Kst.ZONE).toInstant();
        }
        notFuture(at, now, "체결 시각");
        return new LedgerValues(at, i.side(), i.symbol(), item.quantity(), item.price(), null, cost(item.fee(), "수수료"), cost(item.tax(), "세금"),
                i.id(), ManualAccountStore.SOURCE_USER, null);
    }

    /** 잠금 안 — 장중 스탑 지시의 체결 한 행(시각은 그 기준 시각). 그 지시의 자동 기록 행은 {@code replaced}에 넣습니다. */
    private LedgerValues stopFill(FillItem item, Instant now, Set<Long> replaced) {
        StopInstruction s = store.stopInstruction(item.stopInstructionId()).filter(row -> CODE.equals(row.account()))
                .orElseThrow(() -> ManualAccountException.notFound("스탑 지시를 찾을 수 없습니다."));
        requireFillable(s.status());
        for (LedgerRow r : store.ledgerForStopInstruction(s.id())) {
            if (!ManualAccountStore.SOURCE_AUTO.equals(r.source())) {
                throw new ManualAccountException(409, ManualAccountException.ALREADY_RECORDED,
                        "이미 체결을 적은 지시입니다 — 다시 읽은 뒤 장부에서 그 행을 고치세요.");
            }
            replaced.add(r.id());
        }
        notFuture(s.targetAt(), now, "체결 시각");
        return new LedgerValues(s.targetAt(), ManualAccountStore.KIND_SELL, s.symbol(), item.quantity(), item.price(), null,
                cost(item.fee(), "수수료"), cost(item.tax(), "세금"), null, ManualAccountStore.SOURCE_USER, null, s.id());
    }

    private static void requireFillable(String status) {
        if (!ManualAccountStore.STATUS_PLANNED.equals(status) && !ManualAccountStore.STATUS_RECORDED.equals(status)) {
            throw ManualAccountException.invalid("건너뜀·대체된 지시에는 체결을 적을 수 없습니다 — 장부의 '행 추가'를 쓰세요.");
        }
    }

    /** {@code POST /api/manual/isa/ledger/{id}/delete}. */
    public Map<String, Object> deleteLedger(long id) {
        requireReady();
        Instant now = clock.instant();
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            LedgerRow row = store.ledgerRow(id).filter(r -> CODE.equals(r.account()))
                    .orElseThrow(() -> ManualAccountException.notFound("장부 행을 찾을 수 없습니다."));
            List<Entry> entries = new ArrayList<>();
            for (LedgerRow r : store.ledger(CODE)) {
                if (r.id() != row.id()) {
                    entries.add(Entry.of(r));
                }
            }
            rejectInvalid(entries);
            store.deleteLedger(CODE, row.id());
            if (row.instructionId() != null) {
                skipIfOrphan(row.instructionId());
            }
            invalidateUpcoming(acc, next, now);
            store.bumpVersion(CODE);
            return null;
        });
        return Map.of("ok", true);
    }

    /**
     * {@code POST /api/manual/isa/instructions/{id}/skip} — 장부에 쓰지 않음. PLANNED는 SKIPPED로, 자동 기록만 있는 RECORDED는 그 행을 지우고 SKIPPED로,
     * 이미 SKIPPED면 그대로. 직접 입력한 행이 묶인 지시·대체된 지시는 400.
     */
    public Map<String, Object> skipInstruction(long id) {
        requireReady();
        Instant now = clock.instant();
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            Instruction instruction = store.instruction(id).filter(i -> CODE.equals(i.account()))
                    .orElseThrow(() -> ManualAccountException.notFound("지시를 찾을 수 없습니다."));
            switch (instruction.status()) {
                case ManualAccountStore.STATUS_SKIPPED -> {
                    return null;
                }
                case ManualAccountStore.STATUS_SUPERSEDED -> throw ManualAccountException.invalid("대체된 지시는 건너뛸 수 없습니다.");
                case ManualAccountStore.STATUS_RECORDED -> {
                    List<LedgerRow> linked = store.ledgerForInstruction(id);
                    if (linked.stream().anyMatch(r -> ManualAccountStore.SOURCE_USER.equals(r.source()))) {
                        throw ManualAccountException.invalid("직접 입력·고친 체결이 묶인 지시입니다 — 장부에서 그 행을 지우세요.");
                    }
                    Set<Long> remove = new TreeSet<>();
                    linked.forEach(r -> remove.add(r.id()));
                    List<Entry> entries = new ArrayList<>();
                    for (LedgerRow r : store.ledger(CODE)) {
                        if (!remove.contains(r.id())) {
                            entries.add(Entry.of(r));
                        }
                    }
                    rejectInvalid(entries);
                    remove.forEach(rowId -> store.deleteLedger(CODE, rowId));
                    if (!remove.isEmpty()) {
                        invalidateUpcoming(acc, next, now);   // 자동 기록 행을 지움 — 장부가 바뀜
                    }
                }
                default -> {
                    // PLANNED — 장부에 쓰지 않음
                }
            }
            store.updateInstructionStatus(id, ManualAccountStore.STATUS_SKIPPED, null, Map.of("skippedBy", "USER"));
            store.bumpVersion(CODE);
            return null;
        });
        return Map.of("ok", true);
    }

    /**
     * {@code POST /api/manual/isa/instructions/confirm} — '매매함' 표시를 남기거나 지웁니다(장 중반 확인 알림의 신호 — 장부·지시 상태·다음 지시 계산은 바꾸지
     * 않음). PLANNED·RECORDED 지시만 바뀌고, 그사이 건너뛰거나 지워진 지시는 세지 않습니다(화면은 다시 읽음).
     */
    public Map<String, Object> confirmInstructions(ConfirmRequest body) {
        requireReady();
        if (body == null || body.ids() == null || body.ids().isEmpty() || body.ids().size() > MAX_CONFIRM_IDS
                || body.ids().stream().anyMatch(Objects::isNull)) {
            throw ManualAccountException.invalid("지시 번호를 1개 이상 " + MAX_CONFIRM_IDS + "개 이하로 넣으세요.");
        }
        Instant at = Boolean.FALSE.equals(body.confirmed()) ? null : clock.instant();
        int changed = store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            int n = store.setInstructionsConfirmed(CODE, new TreeSet<>(body.ids()), at);
            if (n > 0) {
                store.bumpVersion(CODE);
            }
            return n;
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("changed", changed);
        return out;
    }

    // ------------------------------------------------------------------ 검사
    private void requireReady() {
        if (!store.ready()) {
            throw ManualAccountException.invalid("ISA 계좌 표가 아직 없습니다 — 수집기가 마이그레이션(V25)을 적용한 뒤 다시 하세요.");
        }
    }

    private static void requireStarted(Account acc) {
        if (acc == null) {
            throw new ManualAccountException(409, ManualAccountException.NOT_STARTED, "아직 시작하지 않은 계좌입니다 — 먼저 시작하세요.");
        }
    }

    private static void rejectInvalid(List<Entry> entries) {
        Entry bad = ManualAccountLedger.firstInvalid(entries);
        if (bad != null) {
            throw ManualAccountException.ledgerInvalid("현금이나 보유가 음수가 되는 장부입니다(" + bad.kind() + " 행 시점) — 그 전에 입금·매수 행이 "
                    + "있는지 보세요.");
        }
    }

    /** 지시에 묶을 수 있는가 — 그 계좌의 지시이고, 대체되지 않았고, 매수·매도 방향과 종목이 같아야 함. */
    private void checkLink(long instructionId, LedgerValues v) {
        Instruction instruction = store.instruction(instructionId).filter(i -> CODE.equals(i.account()))
                .orElseThrow(() -> ManualAccountException.invalid("묶을 지시를 찾을 수 없습니다."));
        if (ManualAccountStore.STATUS_SUPERSEDED.equals(instruction.status())) {
            throw ManualAccountException.invalid("대체된 지시에는 체결을 묶을 수 없습니다.");
        }
        if (!instruction.side().equals(v.kind()) || !instruction.symbol().equals(v.symbol())) {
            throw ManualAccountException.invalid("지시와 방향·종목이 다른 행은 그 지시에 묶을 수 없습니다.");
        }
    }

    /**
     * 새로 묶는 지시에 이미 묶인 행(고치는 행 {@code keepId} 제외) — 자동 기록 행만 있으면 그 번호들(사용자 입력 우선 — 지우고 바꿈), 직접 입력한 행이 있으면
     * 409 {@code already-recorded}(같은 체결을 장부에 두 번 적지 않게 — 화면은 다시 읽고 그 행을 고침).
     */
    private Set<Long> autoRowsToReplace(long instructionId, Long keepId) {
        Set<Long> auto = new TreeSet<>();
        for (LedgerRow r : store.ledgerForInstruction(instructionId)) {
            if (keepId != null && r.id() == keepId) {
                continue;
            }
            if (!ManualAccountStore.SOURCE_AUTO.equals(r.source())) {
                throw new ManualAccountException(409, ManualAccountException.ALREADY_RECORDED,
                        "이미 체결을 적은 지시입니다 — 다시 읽은 뒤 장부에서 그 행을 고치세요.");
            }
            auto.add(r.id());
        }
        return auto;
    }

    /**
     * 잠금 안 — 장부가 바뀐 뒤 다음 세션 지시(클래스 설명 '고친 장부로 다음 지시'). {@code next}는 잠금 밖에서 미리 구한 다음 세션(모르면 null — 아무것도
     * 하지 않음). 계좌가 멈춤이면 정기 작업이 다시 만들지 않으므로 지우지 않고 '장부가 바뀜'만 남깁니다.
     */
    private void invalidateUpcoming(Account acc, SessionHours next, Instant now) {
        if (next == null) {
            return;
        }
        LocalDate session = next.date();
        SessionRow row = store.session(CODE, session).orElse(null);
        if (row == null) {
            return;
        }
        Instant morning = session.atTime(ManualAccountJob.MORNING).atZone(Kst.ZONE).toInstant();
        Instant cutoff = next.open() != null && next.open().isBefore(morning) ? next.open() : morning;
        if (!now.isBefore(cutoff) || !acc.active()) {
            store.markLedgerChanged(CODE, session, now);
            return;
        }
        List<Instruction> removed = store.deleteUnlinkedPlanned(CODE, session);
        boolean announced = (row.detail() != null && row.detail().path(ManualAccountJob.DETAIL_RECALCULATED).asBoolean(false))
                || removed.stream().anyMatch(i -> i.notifiedNightAt() != null || i.notifiedMorningAt() != null
                || (i.reason() != null && i.reason().path(ManualAccountJob.DETAIL_RECALCULATED).asBoolean(false)));
        store.deleteSession(CODE, session);
        if (announced) {
            store.setRecalcSession(CODE, session);
        }
    }

    /** 지시에 묶인 행이 더 없으면 그 지시를 SKIPPED로(다시 자동 기록하지 않음). */
    private void skipIfOrphan(long instructionId) {
        if (store.ledgerForInstruction(instructionId).isEmpty()) {
            store.updateInstructionStatus(instructionId, ManualAccountStore.STATUS_SKIPPED, null, Map.of("skippedBy", "LEDGER_DELETED"));
        }
    }

    /** 요청 → 장부 값(종류마다 쓰는 칸만 — 쓰지 않는 칸은 비움). 지시 번호는 따로({@link #withInstruction}). */
    private LedgerValues values(LedgerRequest body, Instant now) {
        String kind = body.kind() == null ? null : body.kind().strip().toUpperCase(Locale.ROOT);
        if (kind == null || !KINDS.contains(kind)) {
            throw ManualAccountException.invalid("종류(kind)는 DEPOSIT·WITHDRAW·BUY·SELL·ADJUST 중 하나입니다.");
        }
        Instant at = body.at() == null || body.at().isBlank() ? now : instant(body.at(), "시각");
        notFuture(at, now, "시각");
        String note = body.note() == null || body.note().isBlank() ? null : body.note().strip();
        if (note != null && note.length() > NOTE_MAX) {
            throw ManualAccountException.invalid("메모는 " + NOTE_MAX + "자까지입니다.");
        }
        return switch (kind) {
            case ManualAccountStore.KIND_DEPOSIT, ManualAccountStore.KIND_WITHDRAW -> {
                if (body.instructionId() != null) {
                    throw ManualAccountException.invalid("입출금 행은 지시에 묶을 수 없습니다.");
                }
                yield new LedgerValues(at, kind, null, null, null, amount(body.amount(), "금액", true), BigDecimal.ZERO, BigDecimal.ZERO,
                        null, ManualAccountStore.SOURCE_USER, note);
            }
            case ManualAccountStore.KIND_ADJUST -> {
                if (body.instructionId() != null) {
                    throw ManualAccountException.invalid("조정 행은 지시에 묶을 수 없습니다.");
                }
                yield new LedgerValues(at, kind, symbol(body.symbol()), quantity(body.quantity(), true), null, null, BigDecimal.ZERO,
                        BigDecimal.ZERO, null, ManualAccountStore.SOURCE_USER, note);
            }
            default -> new LedgerValues(at, kind, symbol(body.symbol()), quantity(body.quantity(), false), price(body.price()), null,
                    cost(body.fee(), "수수료"), cost(body.tax(), "세금"), null, ManualAccountStore.SOURCE_USER, note);
        };
    }

    private static LedgerValues withInstruction(LedgerValues v, Long instructionId) {
        return new LedgerValues(v.at(), v.kind(), v.symbol(), v.quantity(), v.price(), v.amount(), v.fee(), v.tax(), instructionId,
                v.source(), v.note());
    }

    private static Entry entry(Long id, LedgerValues v) {
        return new Entry(id, v.at(), v.kind(), v.symbol(), v.quantity(), v.price(), v.amount(), v.fee(), v.tax());
    }

    private static String symbol(String raw) {
        String s = raw == null ? null : raw.strip().toUpperCase(Locale.ROOT);
        if (s == null || !KR_SYMBOL.matcher(s).matches()) {
            throw ManualAccountException.invalid("종목 코드는 국내 6자리(예: 005930)입니다.");
        }
        return s;
    }

    /** 수량 — 양수(조정은 0이 아닌 값, 음수 가능), 소수 여섯째 자리까지, 상한 안. */
    private static BigDecimal quantity(BigDecimal value, boolean signed) {
        if (value == null || (signed ? value.signum() == 0 : value.signum() <= 0)) {
            throw ManualAccountException.invalid(signed ? "조정 수량은 0이 아닌 값입니다." : "수량은 0보다 커야 합니다.");
        }
        if (value.abs().compareTo(MAX_QUANTITY) > 0 || value.stripTrailingZeros().scale() > 6) {
            throw ManualAccountException.invalid("수량이 범위 밖이거나 소수 자리가 너무 깁니다.");
        }
        return value;
    }

    private static BigDecimal price(BigDecimal value) {
        if (value == null || value.signum() <= 0 || value.compareTo(MAX_PRICE) > 0 || value.stripTrailingZeros().scale() > 4) {
            throw ManualAccountException.invalid("체결가는 0보다 큰 값이어야 합니다(소수 넷째 자리까지).");
        }
        return value;
    }

    private static BigDecimal amount(BigDecimal value, String label, boolean positive) {
        if (value == null || (positive ? value.signum() <= 0 : value.signum() < 0) || value.compareTo(MAX_AMOUNT) > 0
                || value.stripTrailingZeros().scale() > 2) {
            throw ManualAccountException.invalid(label + "은 0보다 큰 금액이어야 합니다(원 단위, 소수 둘째 자리까지).");
        }
        return value;
    }

    private static BigDecimal cost(BigDecimal value, String label) {
        if (value == null) {
            return BigDecimal.ZERO;
        }
        if (value.signum() < 0 || value.compareTo(MAX_AMOUNT) > 0 || value.stripTrailingZeros().scale() > 2) {
            throw ManualAccountException.invalid(label + "는 0 이상의 금액이어야 합니다(소수 둘째 자리까지).");
        }
        return value;
    }

    private static void notFuture(Instant at, Instant now, String label) {
        if (at.isAfter(now.plus(FUTURE_SLACK))) {
            throw ManualAccountException.invalid(label + "이 지금보다 뒤입니다.");
        }
    }

    /** ISO 시각 — 오프셋이 있으면 그대로, 없으면 KST 벽시계로 읽습니다. */
    static Instant instant(String raw, String label) {
        String text = raw.strip();
        try {
            return OffsetDateTime.parse(text).toInstant();
        } catch (DateTimeParseException ignored) {
            // 오프셋 없는 글 — 아래에서 KST로
        }
        try {
            return LocalDateTime.parse(text).atZone(Kst.ZONE).toInstant();
        } catch (DateTimeParseException e) {
            throw ManualAccountException.invalid(label + "을 읽지 못했습니다(예: 2026-11-06T14:55).");
        }
    }

    // ------------------------------------------------------------------ 값 모양
    static String iso(Instant at) {
        return at == null ? null : at.toString();
    }

    /** 금액(소수 둘째 자리 반올림, 뒤 0 없음). */
    static BigDecimal money(BigDecimal value) {
        return value == null ? null : plain(value.setScale(2, RoundingMode.HALF_UP));
    }

    /** 숫자 그대로(뒤 0을 떼되 지수 표기가 되지 않게). */
    static BigDecimal plain(BigDecimal value) {
        if (value == null) {
            return null;
        }
        BigDecimal stripped = value.stripTrailingZeros();
        return stripped.scale() < 0 ? stripped.setScale(0) : stripped;
    }
}
