package com.macrodash.feature.realtrade;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperMirrorService;
import com.macrodash.feature.paper.PaperMirrorService.BookInfo;
import com.macrodash.feature.paper.PaperMirrorService.SessionHours;
import com.macrodash.feature.paper.PaperMirrorService.TradeCosts;
import com.macrodash.store.ManualAccountStore;
import com.macrodash.store.ManualAccountStore.Account;
import com.macrodash.store.ManualAccountStore.Balance;
import com.macrodash.store.ManualAccountStore.CostTotals;
import com.macrodash.store.ManualAccountStore.Instruction;
import com.macrodash.store.ManualAccountStore.Position;
import com.macrodash.store.ManualAccountStore.SessionRow;
import com.macrodash.store.ManualAccountStore.StopInstruction;
import com.macrodash.store.ManualAccountStore.Trade;
import com.macrodash.store.ManualAccountStore.TradeValues;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * ISA 계좌 API(운영자 전용 — ADR 0029·0034) — 연결되지 않은 다른 증권사 계좌의 잔고와 다음 매매 지시를 보여 주고, 시작·잔고 고침·지시 확인·건너뜀·되돌림을 받습니다.
 * 증권사 호출·주문은 없습니다(돈을 움직이는 것은 사용자).
 *
 * <ul>
 *   <li><b>잔고가 정답</b>({@code manual_balance}·{@code manual_positions}): 현금·보유·매입 금액은 지금 값 하나뿐입니다. 쓰기는 모두 계좌 행을 잡은 트랜잭션
 *       안에서 잔고를 다시 읽고 고칩니다. 현금이 음수가 되어도 <b>막지 않고</b> 저장합니다(화면 경고 — 사용자 결정 2026-11-09).</li>
 *   <li><b>시작</b>은 한 번만(잔고 행이 이미 있으면 409 {@code already-started}) — 현금 = 총평가금액 − Σ(수량 × 가격). 가격은 본문의 실시간 가격 → 서버 직전 종가 →
 *       매입 금액 어림(응답 {@code notes}). 계좌 행이 있으면 재사용하고, 옛 PLANNED 지시는 SKIPPED({@code restart})로 닫고 아직 열리지 않은 세션은 지워
 *       새 잔고로 다시 만들게 합니다.</li>
 *   <li><b>확인</b>({@link #apply}): 지시 또는 스탑 지시 줄마다 가격(본문 → 서버 직전 종가, 직전 종가의 ±40% 밖이면 400)으로 비용을 더해 잔고에 바로 반영하고
 *       {@code manual_trades}에 남깁니다(한 트랜잭션). PLANNED만 받습니다. 팔 보유가 없는 매도는 그 지시만 SKIPPED({@code no-holding}).</li>
 *   <li><b>되돌림</b>({@link #undoTrade}): 잔고를 정확히 되돌리고 그 지시를 PLANNED(세션 마감이 지났으면 SKIPPED)로, 내역 행은 지웁니다.</li>
 *   <li><b>고친 잔고로 다음 지시</b>: 잔고를 바꾸는 쓰기는 같은 잠금 안에서 다음 세션 S의 지시가 이미 있으면 S 08:00(KST) 전에는 S의 PLANNED 지시와 세션 행을 지워 정기
 *       작업이 다시 만들게 하고, 08:00 뒤에는 이미 주문을 냈을 수 있어 지우지 않고 '지시 뒤 잔고가 바뀜'({@code instructions.ledgerChanged})만 남깁니다.</li>
 *   <li>평가는 마지막 가격({@link PaperMirrorService#lastPrices})으로 — 모르는 종목은 평가에서 빼고 {@code unpriced}로 알리며, 그때 손익은 비웁니다(없는 숫자를 만들지
 *       않음).</li>
 *   <li>거절은 {@code {ok:false, error, message}}(400 {@code invalid-request}, 404 {@code not-found}, 409 {@code already-started}·{@code not-started}·
 *       {@code already-recorded}). 메시지에 금액을 넣지 않습니다. 잔고 작업이라 비밀번호는 없습니다(Origin 검사는 기존 SessionFilter).</li>
 * </ul>
 */
@Service
public class ManualAccountService {

    static final String CODE = "isa";
    static final String LABEL = "ISA 계좌";
    /** 따라 하는 모의 책 — 한국 규칙 계좌. */
    static final String SOURCE_BOOK = "kr_rules";
    static final int TRADES_SHOWN = 200;
    static final int INSTRUCTIONS_SHOWN = 30;
    static final int MAX_POSITIONS = 100;
    static final int MAX_APPLY = 200;
    static final int NAME_MAX = 100;
    static final BigDecimal MAX_QUANTITY = new BigDecimal("1000000000");
    static final BigDecimal MAX_PRICE = new BigDecimal("10000000000");
    static final BigDecimal MAX_AMOUNT = new BigDecimal("1000000000000000");
    /** 확인 가격의 범위 — 직전 종가의 ±40%. */
    static final BigDecimal PRICE_BAND = new BigDecimal("0.40");
    /** 수수료율 상한(%). */
    static final BigDecimal MAX_COMMISSION_PCT = BigDecimal.ONE;

    /** 가격 출처 — 화면이 보던 실시간 가격. */
    static final String SOURCE_LIVE = "live";
    /** 가격 출처 — 서버 직전 종가. */
    static final String SOURCE_CLOSE = "close";
    private static final Set<String> SOURCES = Set.of(SOURCE_LIVE, SOURCE_CLOSE);

    /** 표가 없을 때의 안내(보기의 {@code message}). */
    static final String NOT_READY = "ISA 계좌 표가 아직 없습니다 — 수집기가 마이그레이션(V31)을 적용한 뒤 다시 보세요.";
    private static final String NEED_CODE = "종목을 찾지 못했습니다 — 여섯 자리 코드를 넣으세요.";

    // ------------------------------------------------------------------ 요청 본문
    /** 시작 때 보유 한 줄. */
    public record StartPosition(String symbol, BigDecimal quantity, BigDecimal purchaseAmount) {

        @Override
        public String toString() {
            return "StartPosition[symbol=" + symbol + "]";
        }
    }

    /** {@code POST /api/manual/isa/start} 본문 — 총평가금액과 줄마다 종목·수량·매입 금액, 화면이 보낸 실시간 가격(코드 → 가격). */
    public record StartRequest(BigDecimal totalAsset, List<StartPosition> positions, Map<String, BigDecimal> prices) {

        @Override
        public String toString() {
            return "StartRequest[positions=" + (positions == null ? 0 : positions.size()) + "]";
        }
    }

    /** {@code POST /api/manual/isa/balance/total} 본문. */
    public record TotalRequest(BigDecimal totalAsset, Map<String, BigDecimal> prices) {

        @Override
        public String toString() {
            return "TotalRequest[]";
        }
    }

    /** {@code POST /api/manual/isa/balance/commission} 본문 — 수수료율(%, 0~1). */
    public record CommissionRequest(BigDecimal commissionPct) {

        @Override
        public String toString() {
            return "CommissionRequest[]";
        }
    }

    /** {@code POST /api/manual/isa/positions} 본문 — {@code originalSymbol}이 있으면 그 행을 고침(코드가 바뀌면 옮김). {@code price}는 평균 매입가. */
    public record PositionRequest(String originalSymbol, String symbol, String name, BigDecimal quantity, BigDecimal price) {

        @Override
        public String toString() {
            return "PositionRequest[symbol=" + symbol + ", originalSymbol=" + originalSymbol + "]";
        }
    }

    /** 확인 한 줄 — 다음 지시({@code instructionId})나 장중 스탑 지시({@code stopInstructionId}) 하나에 묶입니다. {@code price}가 없으면 서버 직전 종가. */
    public record ApplyItem(Long instructionId, Long stopInstructionId, BigDecimal price, String priceSource) {

        @Override
        public String toString() {
            return "ApplyItem[instructionId=" + instructionId + ", stopInstructionId=" + stopInstructionId + "]";
        }
    }

    /** {@code POST /api/manual/isa/instructions/apply} 본문. */
    public record ApplyRequest(List<ApplyItem> items) {

        @Override
        public String toString() {
            return "ApplyRequest[items=" + (items == null ? 0 : items.size()) + "]";
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
    /** {@code GET /api/manual/isa}. */
    public Map<String, Object> view() {
        Map<String, Object> out = new LinkedHashMap<>();
        boolean ready = store.ready();
        Optional<Account> account = ready ? store.account(CODE) : Optional.empty();
        Optional<Balance> balance = ready ? store.balance(CODE) : Optional.empty();
        out.put("available", ready);
        out.put("started", balance.isPresent());
        out.put("serverTime", iso(clock.instant()));
        out.put("account", account(account.orElse(null), balance.orElse(null)));
        Map<String, Object> jobView = new LinkedHashMap<>();
        jobView.put("enabled", job.enabled());
        jobView.put("lastCycleAt", iso(job.lastCycleAt()));
        out.put("job", jobView);
        List<String> notes = new ArrayList<>();
        if (!ready || balance.isEmpty()) {
            out.put("summary", null);
            out.put("positions", List.of());
            out.put("instructions", null);
            out.put("recentInstructions", List.of());
            out.put("stopInstructions", List.of());
            out.put("trades", List.of());
            if (!ready) {
                out.put("message", NOT_READY);
            }
            notes.add(ready ? "시작 전입니다 — 총 잔고(총평가금액)와 지금 들고 있는 종목을 넣으면 그 잔고로 다음 매매 지시를 만듭니다." : NOT_READY);
            out.put("notes", notes);
            return out;
        }
        Balance bal = balance.get();
        List<Position> positions = store.positions(CODE);
        Optional<SessionRow> latest = store.latestSession(CODE);
        List<Instruction> current = latest.map(s -> store.instructions(CODE, s.session())).orElse(List.of());
        List<Instruction> recent = store.recentInstructions(CODE, INSTRUCTIONS_SHOWN);
        List<StopInstruction> stops = store.recentStopInstructions(CODE, INSTRUCTIONS_SHOWN);
        List<Trade> trades = store.recentTrades(CODE, TRADES_SHOWN);
        Map<String, CostTotals> costs = store.costsBySymbol(CODE);

        Set<String> symbols = new TreeSet<>();
        positions.forEach(p -> symbols.add(p.symbol()));
        current.forEach(i -> symbols.add(i.symbol()));
        recent.forEach(i -> symbols.add(i.symbol()));
        stops.forEach(s -> symbols.add(s.symbol()));
        trades.forEach(t -> symbols.add(t.symbol()));
        Map<String, String> names = new HashMap<>(paper.names(symbols));
        positions.stream().filter(p -> p.name() != null && !p.name().isBlank()).forEach(p -> names.put(p.symbol(), p.name()));
        Map<String, BigDecimal> last = paper.lastPrices(positions.stream().map(Position::symbol).toList());

        BigDecimal marketValue = BigDecimal.ZERO;
        BigDecimal purchaseTotal = BigDecimal.ZERO;
        List<String> unpriced = new ArrayList<>();
        for (Position p : positions) {
            purchaseTotal = purchaseTotal.add(p.purchaseAmount());
            BigDecimal price = last.get(p.symbol());
            if (price == null) {
                unpriced.add(p.symbol());
            } else {
                marketValue = marketValue.add(p.quantity().multiply(price));
            }
        }
        BigDecimal totalAsset = bal.cash().add(marketValue);
        BigDecimal profitLoss = unpriced.isEmpty() ? marketValue.subtract(purchaseTotal) : null;
        BigDecimal feesPaid = costs.values().stream().map(CostTotals::fees).reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal taxesPaid = costs.values().stream().map(CostTotals::taxes).reduce(BigDecimal.ZERO, BigDecimal::add);
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("cash", money(bal.cash()));
        summary.put("marketValue", money(marketValue));
        summary.put("totalAsset", money(totalAsset));
        summary.put("purchaseTotal", money(purchaseTotal));
        summary.put("profitLoss", money(profitLoss));
        summary.put("profitLossPct", plain(ManualAccountBalance.percent(profitLoss, purchaseTotal)));
        summary.put("feesPaid", money(feesPaid));
        summary.put("taxesPaid", money(taxesPaid));
        summary.put("commissionPct", plain(bal.commissionBp().divide(new BigDecimal("100"), 6, RoundingMode.HALF_UP)));
        summary.put("unpriced", unpriced);
        out.put("summary", summary);

        List<Map<String, Object>> positionRows = new ArrayList<>();
        for (Position p : positions) {
            BigDecimal price = last.get(p.symbol());
            BigDecimal value = price == null ? null : p.quantity().multiply(price);
            BigDecimal pnl = value == null ? null : value.subtract(p.purchaseAmount());
            CostTotals c = costs.get(p.symbol());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("symbol", p.symbol());
            row.put("name", names.get(p.symbol()));
            row.put("quantity", plain(p.quantity()));
            row.put("avgPrice", plain(ManualAccountBalance.avgPrice(p.purchaseAmount(), p.quantity())));
            row.put("purchaseAmount", money(p.purchaseAmount()));
            row.put("lastPrice", plain(price));
            row.put("marketValue", money(value));
            row.put("profitLoss", money(pnl));
            row.put("profitLossPct", plain(ManualAccountBalance.percent(pnl, p.purchaseAmount())));
            row.put("weightPct", plain(ManualAccountBalance.percent(value, totalAsset)));
            row.put("feesPaid", money(c == null ? BigDecimal.ZERO : c.fees()));
            row.put("taxesPaid", money(c == null ? BigDecimal.ZERO : c.taxes()));
            positionRows.add(row);
        }
        out.put("positions", positionRows);

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
        List<Map<String, Object>> recentItems = new ArrayList<>();
        recent.forEach(i -> recentItems.add(instruction(i, names, true)));
        out.put("recentInstructions", recentItems);
        List<Map<String, Object>> stopItems = new ArrayList<>();
        stops.forEach(s -> stopItems.add(stopInstruction(s, names)));
        out.put("stopInstructions", stopItems);
        List<Map<String, Object>> tradeRows = new ArrayList<>();
        trades.forEach(t -> tradeRows.add(tradeRow(t, names)));
        out.put("trades", tradeRows);

        if (account.isPresent() && !account.get().active()) {
            notes.add("계좌가 멈춤 상태라 지시를 만들지 않습니다.");
        }
        if (!job.enabled()) {
            notes.add("이 서버의 정기 작업이 꺼져 있어 지시를 만들지 않습니다(모의 매매 정기 작업이 도는 서버에서만 동작).");
        }
        if (!unpriced.isEmpty()) {
            notes.add("가격을 모르는 종목 " + unpriced.size() + "개는 평가에서 뺐고, 그동안 손익은 비웁니다.");
        }
        ManualAccountJob.Waiting wait = job.waiting();
        if (wait != null && wait.session() != null && (latest.isEmpty() || wait.session().isAfter(latest.get().session()))) {
            notes.add(wait.session() + " 지시 대기 — " + ManualAccountJob.reasonLabel(wait.reason()));
        }
        latest.map(SessionRow::detail).map(d -> d.path("notes")).filter(n -> n.isArray()).ifPresent(n -> n.forEach(x -> {
            if (x.isString()) {
                notes.add(x.asString());
            }
        }));
        out.put("notes", notes);
        return out;
    }

    /** 계좌 칸 — 시작 시각은 잔고 행(시작 전이면 null). */
    private Map<String, Object> account(Account acc, Balance balance) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", CODE);
        out.put("label", acc == null ? LABEL : acc.label());
        out.put("market", acc == null ? ManualAccountStore.MARKET_KR : acc.market());
        String book = acc == null ? SOURCE_BOOK : acc.sourceBook();
        out.put("sourceBook", book);
        out.put("sourceLabel", paper.book(book).map(BookInfo::label).orElse(null));
        out.put("state", acc == null ? null : acc.state());
        out.put("startedAt", balance == null ? null : iso(balance.startedAt()));
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
        out.put("notifiedPrecloseAt", iso(i.notifiedPrecloseAt()));
        out.put("autoNote", autoNote(i.reason()));
        out.put("recordedByUser", ManualAccountJob.recordedByUser(i));
        return out;
    }

    /** 장중 스탑 매도 지시 하나(ADR 0033 결정 7) — 종목·수량·체결 시점·기준 시각·상태·즉시 알림 시각과 메모(금액 없음). */
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
        out.put("notifiedMiddayAt", iso(i.notifiedMiddayAt()));
        out.put("notifiedPrecloseAt", iso(i.notifiedPrecloseAt()));
        out.put("autoNote", autoNote(i.reason()));
        out.put("recordedByUser", i.reason() != null && "USER".equals(i.reason().path("recordedBy").asString("")));
        return out;
    }

    private static String autoNote(JsonNode reason) {
        JsonNode note = reason == null ? null : reason.get("autoNote");
        return note != null && note.isString() ? note.asString() : null;
    }

    private static Map<String, Object> tradeRow(Trade t, Map<String, String> names) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("id", t.id());
        out.put("at", iso(t.at()));
        out.put("side", t.side());
        out.put("symbol", t.symbol());
        out.put("name", names.get(t.symbol()));
        out.put("quantity", plain(t.quantity()));
        out.put("price", plain(t.price()));
        out.put("amount", money(t.quantity().multiply(t.price())));
        out.put("fee", plain(t.fee()));
        out.put("tax", plain(t.tax()));
        out.put("realizedPnl", money(t.realizedPnl()));
        out.put("realizedPct", plain(ManualAccountBalance.percent(t.realizedPnl(), t.costBasis())));
        out.put("priceSource", t.priceSource());
        out.put("taxAssumed", t.taxAssumed());
        out.put("instructionId", t.instructionId());
        out.put("stopInstructionId", t.stopInstructionId());
        return out;
    }

    // ------------------------------------------------------------------ 시작
    /** {@code POST /api/manual/isa/start}(클래스 설명) — 한 번만, 한 트랜잭션. */
    public Map<String, Object> start(StartRequest body) {
        requireReady();
        if (body == null) {
            throw ManualAccountException.invalid("요청 본문이 없습니다.");
        }
        BigDecimal total = amount(body.totalAsset(), "총 잔고", true);
        List<StartPosition> rows = body.positions() == null ? List.of() : body.positions();
        if (rows.size() > MAX_POSITIONS) {
            throw ManualAccountException.invalid("보유는 " + MAX_POSITIONS + "줄까지입니다.");
        }
        Map<String, String> allNames = paper.allKrNames();
        Map<String, StartPosition> lines = new LinkedHashMap<>();
        for (StartPosition row : rows) {
            if (row == null) {
                throw ManualAccountException.invalid("보유 목록에 빈 줄이 있습니다.");
            }
            String symbol = resolve(row.symbol(), allNames);
            if (lines.containsKey(symbol)) {
                throw ManualAccountException.invalid("같은 종목을 두 줄로 넣을 수 없습니다.");
            }
            quantity(row.quantity());
            amount(row.purchaseAmount(), "매입 금액", false);
            lines.put(symbol, row);
        }
        Instant now = clock.instant();
        List<String> notes = new ArrayList<>();
        Map<String, BigDecimal> last = paper.lastPrices(lines.keySet());
        List<ManualAccountBalance.Lot> valued = new ArrayList<>();
        lines.forEach((symbol, row) -> valued.add(new ManualAccountBalance.Lot(row.quantity(), priceFor(symbol, body.prices(), last, row.purchaseAmount(), row.quantity(), notes))));
        BigDecimal cash = bounded(ManualAccountBalance.cashFromTotal(total, valued));
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        LocalDate fromSession = next != null ? next.date() : Kst.today(clock).plusDays(1);
        store.atomically(() -> {
            store.insertAccount(CODE, LABEL, ManualAccountStore.MARKET_KR, SOURCE_BOOK, now, cash.max(BigDecimal.ZERO));
            store.lockAccount(CODE, acc -> {
                if (!store.insertBalance(CODE, now, cash)) {
                    throw new ManualAccountException(409, ManualAccountException.ALREADY_STARTED, "이미 시작한 계좌입니다 — 잔고에서 고치세요.");
                }
                lines.forEach((symbol, row) -> store.upsertPosition(CODE, symbol, null, row.quantity(), row.purchaseAmount()));
                closeOldInstructions(fromSession);
                store.bumpVersion(CODE);
                return null;
            });
            return null;
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("notes", dedupe(notes));
        return out;
    }

    /** 잠금 안 — 시작 때 옛 지시를 닫습니다: 아직 열리지 않은 세션({@code fromSession} 이후)은 지워 다시 만들게 하고, 나머지 PLANNED 지시·스탑 지시는 SKIPPED(restart). */
    private void closeOldInstructions(LocalDate fromSession) {
        store.deleteSessionsFrom(CODE, fromSession);
        for (Instruction i : store.plannedInstructions(CODE)) {
            store.updateInstructionStatus(i.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                    Map.of("skippedBy", "AUTO", "autoNote", ManualAccountJob.AUTO_RESTART));
        }
        for (StopInstruction s : store.plannedStopInstructions(CODE)) {
            store.updateStopInstructionStatus(s.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED,
                    Map.of("skippedBy", "AUTO", "autoNote", ManualAccountJob.AUTO_RESTART));
        }
    }

    // ------------------------------------------------------------------ 잔고 고침
    /** {@code POST /api/manual/isa/balance/total} — 총 잔고를 다시 넣어 현금을 다시 셉니다. */
    public Map<String, Object> setTotal(TotalRequest body) {
        requireReady();
        if (body == null) {
            throw ManualAccountException.invalid("요청 본문이 없습니다.");
        }
        BigDecimal total = amount(body.totalAsset(), "총 잔고", true);
        Instant now = clock.instant();
        Map<String, BigDecimal> last = paper.lastPrices(store.positions(CODE).stream().map(Position::symbol).toList());
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        List<String> notes = new ArrayList<>();
        store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            List<ManualAccountBalance.Lot> valued = new ArrayList<>();
            for (Position p : store.positions(CODE)) {
                valued.add(new ManualAccountBalance.Lot(p.quantity(), priceFor(p.symbol(), body.prices(), last, p.purchaseAmount(), p.quantity(), notes)));
            }
            store.updateCash(CODE, bounded(ManualAccountBalance.cashFromTotal(total, valued)));
            invalidateUpcoming(acc, next, now);
            store.bumpVersion(CODE);
            return null;
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("notes", dedupe(notes));
        return out;
    }

    /** {@code POST /api/manual/isa/balance/commission} — 수수료율(%, 0~1). 잔고 숫자는 바꾸지 않습니다. */
    public Map<String, Object> setCommission(CommissionRequest body) {
        requireReady();
        BigDecimal pct = body == null ? null : body.commissionPct();
        if (pct == null || pct.signum() < 0 || pct.compareTo(MAX_COMMISSION_PCT) > 0 || pct.stripTrailingZeros().scale() > 6) {
            throw ManualAccountException.invalid("수수료율은 0~1% 사이의 값입니다.");
        }
        store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            store.updateCommission(CODE, pct.multiply(new BigDecimal("100")));
            store.bumpVersion(CODE);
            return null;
        });
        return Map.of("ok", true);
    }

    /** {@code POST /api/manual/isa/positions} — 추가·고치기(매입 금액 = 수량 × 가격, 코드가 바뀌면 그 행을 옮김). */
    public Map<String, Object> savePosition(PositionRequest body) {
        requireReady();
        if (body == null) {
            throw ManualAccountException.invalid("요청 본문이 없습니다.");
        }
        Map<String, String> allNames = paper.allKrNames();
        String symbol = resolve(body.symbol(), allNames);
        String original = body.originalSymbol() == null || body.originalSymbol().isBlank() ? null : code(body.originalSymbol());
        BigDecimal quantity = quantity(body.quantity());
        BigDecimal price = price(body.price());
        BigDecimal purchase = bounded(ManualAccountBalance.money(quantity.multiply(price)));
        String name = cleanName(body.name(), allNames.get(symbol));
        Instant now = clock.instant();
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            boolean exists = store.position(CODE, symbol).isPresent();
            if (original != null) {
                if (store.position(CODE, original).isEmpty()) {
                    throw ManualAccountException.notFound("보유를 찾을 수 없습니다.");
                }
                if (!original.equals(symbol) && exists) {
                    throw ManualAccountException.invalid("이미 있는 종목으로 옮길 수 없습니다 — 그 행을 고치세요.");
                }
                if (!original.equals(symbol)) {
                    store.deletePosition(CODE, original);
                }
            } else if (exists) {
                throw ManualAccountException.invalid("이미 있는 종목입니다 — 그 행을 고치세요.");
            }
            store.upsertPosition(CODE, symbol, name, quantity, purchase);
            invalidateUpcoming(acc, next, now);
            store.bumpVersion(CODE);
            return null;
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("symbol", symbol);
        return out;
    }

    /** {@code POST /api/manual/isa/positions/{symbol}/delete}. */
    public Map<String, Object> deletePosition(String rawSymbol) {
        requireReady();
        String symbol = rawSymbol == null ? "" : rawSymbol.strip().toUpperCase(Locale.ROOT);
        if (!ManualAccountBalance.KR_SYMBOL.matcher(symbol).matches()) {
            throw ManualAccountException.notFound("보유를 찾을 수 없습니다.");
        }
        Instant now = clock.instant();
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            if (!store.deletePosition(CODE, symbol)) {
                throw ManualAccountException.notFound("보유를 찾을 수 없습니다.");
            }
            invalidateUpcoming(acc, next, now);
            store.bumpVersion(CODE);
            return null;
        });
        return Map.of("ok", true);
    }

    // ------------------------------------------------------------------ 확인
    /** 지시 하나의 공통 칸. */
    private record Ref(long id, boolean stop, String side, String symbol, int quantity, String status) {
    }

    /** {@code POST /api/manual/isa/instructions/apply}(클래스 설명) — 한 트랜잭션. */
    public Map<String, Object> apply(ApplyRequest body) {
        requireReady();
        List<ApplyItem> items = body == null ? null : body.items();
        if (items == null || items.isEmpty() || items.size() > MAX_APPLY || items.stream().anyMatch(i -> i == null)) {
            throw ManualAccountException.invalid("확인할 지시를 1줄 이상 " + MAX_APPLY + "줄 이하로 넣으세요.");
        }
        Set<Long> seen = new HashSet<>();
        Set<Long> seenStops = new HashSet<>();
        Set<String> symbols = new TreeSet<>();
        for (ApplyItem item : items) {
            if ((item.instructionId() == null) == (item.stopInstructionId() == null)) {
                throw ManualAccountException.invalid("확인 한 줄은 지시 번호나 스탑 지시 번호 가운데 하나에 묶어야 합니다.");
            }
            if (item.instructionId() != null ? !seen.add(item.instructionId()) : !seenStops.add(item.stopInstructionId())) {
                throw ManualAccountException.invalid("같은 지시를 두 줄로 확인할 수 없습니다.");
            }
            if (item.price() != null) {
                price(item.price());
            }
            if (item.priceSource() != null && !SOURCES.contains(item.priceSource())) {
                throw ManualAccountException.invalid("가격 출처는 live·close 가운데 하나입니다.");
            }
            if (item.instructionId() != null) {
                store.instruction(item.instructionId()).filter(i -> CODE.equals(i.account())).ifPresent(i -> symbols.add(i.symbol()));
            } else {
                store.stopInstruction(item.stopInstructionId()).filter(s -> CODE.equals(s.account())).ifPresent(s -> symbols.add(s.symbol()));
            }
        }
        Map<String, BigDecimal> last = paper.lastPrices(symbols);
        Instant now = clock.instant();
        LocalDate today = Kst.today(clock);
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        int[] done = store.lockAccount(CODE, acc -> {
            Balance balance = requireStarted(acc);
            BigDecimal cash = balance.cash();
            int applied = 0;
            int skipped = 0;
            for (ApplyItem item : items) {
                Ref ref = item.instructionId() != null ? instructionRef(item.instructionId()) : stopRef(item.stopInstructionId());
                requirePlanned(ref);
                BigDecimal close = last.get(ref.symbol());
                BigDecimal chosen = item.price() != null ? item.price() : close;
                if (chosen == null || chosen.signum() <= 0) {
                    throw ManualAccountException.invalid("가격을 모르는 종목이 있습니다 — 실시간 가격을 받은 뒤 다시 누르세요.");
                }
                if (item.price() != null && close != null && close.signum() > 0 && outOfBand(item.price(), close)) {
                    throw ManualAccountException.invalid("가격이 직전 종가의 ±40% 밖입니다 — 잘못 들어온 가격이면 다시 누르세요.");
                }
                String source = item.price() != null ? (item.priceSource() != null ? item.priceSource() : SOURCE_LIVE) : SOURCE_CLOSE;
                boolean sell = ManualAccountStore.SIDE_SELL.equals(ref.side());
                Position held = store.position(CODE, ref.symbol()).orElse(null);
                int quantity = ref.quantity();
                if (sell) {
                    BigDecimal whole = held == null ? BigDecimal.ZERO : held.quantity().setScale(0, RoundingMode.FLOOR);
                    quantity = whole.min(BigDecimal.valueOf(ref.quantity())).intValue();
                    if (quantity < 1) {
                        closeNoHolding(ref);
                        skipped++;
                        continue;
                    }
                }
                TradeCosts costs = paper.krTradeCosts(ref.symbol(), sell, quantity, chosen, balance.commissionBp(), today);
                BigDecimal qty = BigDecimal.valueOf(quantity);
                ManualAccountBalance.Applied result = sell
                        ? ManualAccountBalance.sell(cash, held.quantity(), held.purchaseAmount(), qty, chosen, costs.fee(), costs.tax())
                        : ManualAccountBalance.buy(cash, held == null ? null : held.quantity(), held == null ? null : held.purchaseAmount(), qty, chosen, costs.fee());
                cash = bounded(result.cash());
                if (result.empty()) {
                    store.deletePosition(CODE, ref.symbol());
                } else {
                    store.upsertPosition(CODE, ref.symbol(), held == null ? null : held.name(), result.quantity(), bounded(result.purchaseAmount()));
                }
                store.insertTrade(CODE, new TradeValues(now, ref.side(), ref.symbol(), qty, chosen, costs.fee(), costs.tax(), result.costBasis(), result.realizedPnl(),
                        costs.taxAssumed(), ref.stop() ? null : ref.id(), ref.stop() ? ref.id() : null, source));
                markRecorded(ref);
                applied++;
            }
            if (applied > 0) {
                store.updateCash(CODE, cash);
                invalidateUpcoming(acc, next, now);
            }
            if (applied + skipped > 0) {
                store.bumpVersion(CODE);
            }
            return new int[]{applied, skipped};
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("count", done[0]);
        out.put("skipped", done[1]);
        return out;
    }

    private Ref instructionRef(long id) {
        Instruction i = store.instruction(id).filter(row -> CODE.equals(row.account()))
                .orElseThrow(() -> ManualAccountException.notFound("지시를 찾을 수 없습니다."));
        return new Ref(i.id(), false, i.side(), i.symbol(), i.quantity(), i.status());
    }

    private Ref stopRef(long id) {
        StopInstruction s = store.stopInstruction(id).filter(row -> CODE.equals(row.account()))
                .orElseThrow(() -> ManualAccountException.notFound("스탑 지시를 찾을 수 없습니다."));
        return new Ref(s.id(), true, s.side(), s.symbol(), s.quantity(), s.status());
    }

    private static void requirePlanned(Ref ref) {
        if (ManualAccountStore.STATUS_RECORDED.equals(ref.status())) {
            throw new ManualAccountException(409, ManualAccountException.ALREADY_RECORDED, "이미 확인한 지시입니다 — 다시 읽은 뒤 매매 내역에서 되돌리세요.");
        }
        if (!ManualAccountStore.STATUS_PLANNED.equals(ref.status())) {
            throw ManualAccountException.invalid("건너뛰었거나 대체된 지시는 확인할 수 없습니다.");
        }
    }

    private static boolean outOfBand(BigDecimal price, BigDecimal close) {
        BigDecimal low = close.multiply(BigDecimal.ONE.subtract(PRICE_BAND));
        BigDecimal high = close.multiply(BigDecimal.ONE.add(PRICE_BAND));
        return price.compareTo(low) < 0 || price.compareTo(high) > 0;
    }

    private void closeNoHolding(Ref ref) {
        Map<String, String> patch = Map.of("skippedBy", "AUTO", "autoNote", ManualAccountJob.AUTO_NO_HOLDING);
        if (ref.stop()) {
            store.updateStopInstructionStatus(ref.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED, patch);
        } else {
            store.updateInstructionStatus(ref.id(), ManualAccountStore.STATUS_SKIPPED, ManualAccountStore.STATUS_PLANNED, patch);
        }
    }

    private void markRecorded(Ref ref) {
        Map<String, String> patch = Map.of("recordedBy", "USER");
        if (ref.stop()) {
            store.updateStopInstructionStatus(ref.id(), ManualAccountStore.STATUS_RECORDED, ManualAccountStore.STATUS_PLANNED, patch);
        } else {
            store.updateInstructionStatus(ref.id(), ManualAccountStore.STATUS_RECORDED, ManualAccountStore.STATUS_PLANNED, patch);
        }
    }

    // ------------------------------------------------------------------ 되돌림·건너뜀
    /** {@code POST /api/manual/isa/trades/{id}/undo}(클래스 설명). */
    public Map<String, Object> undoTrade(long id) {
        requireReady();
        Trade found = store.trade(id).filter(t -> CODE.equals(t.account()))
                .orElseThrow(() -> ManualAccountException.notFound("매매 내역을 찾을 수 없습니다."));
        Instant now = clock.instant();
        boolean closed = sessionClosed(found, now);   // 달력은 잠금 밖에서 읽음
        SessionHours next = ManualAccountCalendar.nextSession(paper, now);
        store.lockAccount(CODE, acc -> {
            Balance balance = requireStarted(acc);
            Trade trade = store.trade(id).filter(t -> CODE.equals(t.account()))
                    .orElseThrow(() -> ManualAccountException.notFound("매매 내역을 찾을 수 없습니다."));
            Position held = store.position(CODE, trade.symbol()).orElse(null);
            boolean sell = ManualAccountStore.SIDE_SELL.equals(trade.side());
            ManualAccountBalance.Applied result = sell
                    ? ManualAccountBalance.undoSell(balance.cash(), held == null ? null : held.quantity(), held == null ? null : held.purchaseAmount(), trade.quantity(),
                    trade.price(), trade.fee(), trade.tax(), trade.costBasis())
                    : ManualAccountBalance.undoBuy(balance.cash(), held == null ? null : held.quantity(), held == null ? null : held.purchaseAmount(), trade.quantity(),
                    trade.price(), trade.fee(), trade.costBasis());
            store.updateCash(CODE, bounded(result.cash()));
            if (result.empty()) {
                store.deletePosition(CODE, trade.symbol());
            } else {
                store.upsertPosition(CODE, trade.symbol(), held == null ? null : held.name(), result.quantity(), bounded(result.purchaseAmount()));
            }
            store.deleteTrade(CODE, trade.id());
            String status = closed ? ManualAccountStore.STATUS_SKIPPED : ManualAccountStore.STATUS_PLANNED;
            Map<String, String> patch = closed ? Map.of("skippedBy", "AUTO", "autoNote", ManualAccountJob.AUTO_EXPIRED) : Map.of();
            if (trade.instructionId() != null) {
                store.reopenInstruction(trade.instructionId(), status, patch);
            }
            if (trade.stopInstructionId() != null) {
                store.reopenStopInstruction(trade.stopInstructionId(), status, patch);
            }
            invalidateUpcoming(acc, next, now);
            store.bumpVersion(CODE);
            return null;
        });
        return Map.of("ok", true);
    }

    /** 그 내역이 묶인 지시의 세션 마감이 지났는가 — 달력을 모르면 그 세션이 오늘 전이면 지난 것으로 봅니다. */
    private boolean sessionClosed(Trade trade, Instant now) {
        LocalDate session = trade.instructionId() != null ? store.instruction(trade.instructionId()).map(Instruction::session).orElse(null)
                : trade.stopInstructionId() != null ? store.stopInstruction(trade.stopInstructionId()).map(StopInstruction::session).orElse(null) : null;
        if (session == null) {
            return true;
        }
        SessionHours hours = ManualAccountCalendar.hours(paper, session);
        return hours != null && hours.close() != null ? !now.isBefore(hours.close()) : session.isBefore(Kst.today(clock));
    }

    /** {@code POST /api/manual/isa/instructions/{id}/skip} — 잔고에 쓰지 않음. PLANNED는 SKIPPED로, 이미 SKIPPED면 그대로, 확인한 지시는 409, 대체된 지시는 400. */
    public Map<String, Object> skipInstruction(long id) {
        requireReady();
        store.lockAccount(CODE, acc -> {
            requireStarted(acc);
            Instruction instruction = store.instruction(id).filter(i -> CODE.equals(i.account()))
                    .orElseThrow(() -> ManualAccountException.notFound("지시를 찾을 수 없습니다."));
            switch (instruction.status()) {
                case ManualAccountStore.STATUS_SKIPPED -> {
                    return null;
                }
                case ManualAccountStore.STATUS_SUPERSEDED -> throw ManualAccountException.invalid("대체된 지시는 건너뛸 수 없습니다.");
                case ManualAccountStore.STATUS_RECORDED -> throw new ManualAccountException(409, ManualAccountException.ALREADY_RECORDED,
                        "이미 확인한 지시입니다 — 매매 내역에서 되돌리세요.");
                default -> {
                    // PLANNED — 잔고에 쓰지 않음
                }
            }
            store.updateInstructionStatus(id, ManualAccountStore.STATUS_SKIPPED, null, Map.of("skippedBy", "USER"));
            store.bumpVersion(CODE);
            return null;
        });
        return Map.of("ok", true);
    }

    // ------------------------------------------------------------------ 검사
    private void requireReady() {
        if (!store.ready()) {
            throw ManualAccountException.invalid("ISA 계좌 표가 아직 없습니다 — 수집기가 마이그레이션(V31)을 적용한 뒤 다시 하세요.");
        }
    }

    /** 잠금 안 — 시작한 계좌의 잔고. 없으면 409 not-started. */
    private Balance requireStarted(Account acc) {
        Balance balance = acc == null ? null : store.balance(CODE).orElse(null);
        if (balance == null) {
            throw new ManualAccountException(409, ManualAccountException.NOT_STARTED, "아직 시작하지 않은 계좌입니다 — 먼저 시작하세요.");
        }
        return balance;
    }

    /**
     * 잠금 안 — 잔고가 바뀐 뒤 다음 세션 지시(클래스 설명 '고친 잔고로 다음 지시'). {@code next}는 잠금 밖에서 미리 구한 다음 세션(모르면 null — 아무것도
     * 하지 않음). 계좌가 멈춤이면 정기 작업이 다시 만들지 않으므로 지우지 않고 '잔고가 바뀜'만 남깁니다.
     */
    private void invalidateUpcoming(Account acc, SessionHours next, Instant now) {
        if (next == null) {
            return;
        }
        LocalDate session = next.date();
        if (store.session(CODE, session).isEmpty()) {
            return;
        }
        Instant morning = session.atTime(ManualAccountJob.MORNING).atZone(Kst.ZONE).toInstant();
        Instant cutoff = next.open() != null && next.open().isBefore(morning) ? next.open() : morning;
        if (!now.isBefore(cutoff) || !acc.active()) {
            store.markLedgerChanged(CODE, session, now);
            return;
        }
        store.deleteUnlinkedPlanned(CODE, session);
        store.deleteSession(CODE, session);
    }

    /** 가격: 본문 실시간 → 서버 직전 종가 → 매입 금액 어림(메모). */
    private static BigDecimal priceFor(String symbol, Map<String, BigDecimal> body, Map<String, BigDecimal> last, BigDecimal purchase, BigDecimal quantity,
                                       List<String> notes) {
        BigDecimal given = body == null ? null : body.get(symbol);
        if (given != null) {
            return price(given);
        }
        BigDecimal close = last.get(symbol);
        if (close != null && close.signum() > 0) {
            return close;
        }
        notes.add("가격을 몰라 매입 금액으로 어림한 종목이 있습니다 — 뒤에 가격이 들어오면 '총 잔고 다시 맞추기'를 쓰세요.");
        return purchase.divide(quantity, 4, RoundingMode.HALF_UP);
    }

    private static List<String> dedupe(List<String> notes) {
        return new ArrayList<>(new java.util.LinkedHashSet<>(notes));
    }

    /** 입력 → 코드(코드 모양이거나 이름표에서 찾음). 없거나 여럿이면 400. */
    private static String resolve(String raw, Map<String, String> names) {
        String symbol = ManualAccountBalance.resolveSymbol(raw, names);
        if (symbol == null) {
            throw ManualAccountException.invalid(NEED_CODE);
        }
        return symbol;
    }

    /** 코드 모양 입력만(이름 해석 없음). */
    private static String code(String raw) {
        String symbol = raw == null ? "" : raw.strip().toUpperCase(Locale.ROOT);
        if (!ManualAccountBalance.KR_SYMBOL.matcher(symbol).matches()) {
            throw ManualAccountException.invalid("종목 코드는 국내 6자리(예: 005930)입니다.");
        }
        return symbol;
    }

    private static String cleanName(String raw, String tableName) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String name = raw.strip();
        if (name.length() > NAME_MAX) {
            throw ManualAccountException.invalid("종목명은 " + NAME_MAX + "자까지입니다.");
        }
        return name.equals(tableName) ? null : name;   // 이름표와 같으면 고친 이름이 아님
    }

    /** 수량 — 양수, 소수 여섯째 자리까지, 상한 안. */
    private static BigDecimal quantity(BigDecimal value) {
        if (value == null || value.signum() <= 0) {
            throw ManualAccountException.invalid("수량은 0보다 커야 합니다.");
        }
        if (value.compareTo(MAX_QUANTITY) > 0 || value.stripTrailingZeros().scale() > 6) {
            throw ManualAccountException.invalid("수량이 범위 밖이거나 소수 자리가 너무 깁니다.");
        }
        return value;
    }

    private static BigDecimal price(BigDecimal value) {
        if (value == null || value.signum() <= 0 || value.compareTo(MAX_PRICE) > 0 || value.stripTrailingZeros().scale() > 4) {
            throw ManualAccountException.invalid("가격은 0보다 큰 값이어야 합니다(소수 넷째 자리까지).");
        }
        return value;
    }

    private static BigDecimal amount(BigDecimal value, String label, boolean positive) {
        if (value == null || (positive ? value.signum() <= 0 : value.signum() < 0) || value.compareTo(MAX_AMOUNT) > 0
                || value.stripTrailingZeros().scale() > 2) {
            throw ManualAccountException.invalid(label + "은 " + (positive ? "0보다 큰" : "0 이상의") + " 금액이어야 합니다(원 단위, 소수 둘째 자리까지).");
        }
        return value;
    }

    /** 현금·매입 금액이 표의 자리(NUMERIC(20,2))를 넘지 않게 — 넘으면 입력 실수로 봅니다. */
    private static BigDecimal bounded(BigDecimal value) {
        if (value.abs().compareTo(MAX_AMOUNT) > 0) {
            throw ManualAccountException.invalid("금액이 범위를 넘습니다 — 수량·가격을 확인하세요.");
        }
        return value;
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
