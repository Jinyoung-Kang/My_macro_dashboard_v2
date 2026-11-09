package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * 연결되지 않은 다른 증권사 계좌(ISA 계좌 — ADR 0029·0034)의 표({@code manual_*}, V25 — 장중 스탑 매도 지시는 V28, 잔고·보유·매매 내역은 V31) — 백엔드가 쓰는
 * 표(ADR 0008). 이 표들의 JDBC는 <b>전부 여기</b>에 있고, 부르는 곳은 {@code feature.realtrade}의 ISA 계좌 클래스뿐입니다(ArchitectureRulesTest가 막음).
 *
 * <p><b>잠금</b>: {@link #lockAccount}가 계좌 행을 {@code SELECT … FOR UPDATE}로 잡은 트랜잭션 안에서 받은 일을 돌립니다 — 안에서 부르는 이 저장소의
 * 문장이 같은 연결·트랜잭션에 합류하므로, 잔고를 다시 읽어 고치는 일이 화면의 쓰기와 정기 작업 사이에서 섞이지 않습니다.
 *
 * <p>값의 모양: 돈·수량·가격은 {@link BigDecimal}(DB NUMERIC 그대로), 시각은 {@link Instant}, 거래일은 {@link LocalDate}, JSON 열은 {@link JsonNode}.
 * 비어 있을 수 있는 열은 null입니다(0으로 채우지 않음). 실제 계좌 값이라 레코드의 {@code toString}에 금액·수량을 싣지 않습니다(로그로 새지 않게).
 * 옛 표 {@code manual_ledger}(ADR 0029)는 ADR 0034로 쓰지 않습니다 — 지시 삭제가 그 표의 외래키에 걸리지 않게 확인하는 데만 읽습니다.
 */
@Repository
public class ManualAccountStore {

    // ------------------------------------------------------------------ 값(DB CHECK와 같은 문자열)
    public static final String MARKET_KR = "KR";
    public static final String STATE_ACTIVE = "ACTIVE";
    public static final String STATE_PAUSED = "PAUSED";

    public static final String SIDE_BUY = "BUY";
    public static final String SIDE_SELL = "SELL";

    public static final String STATUS_PLANNED = "PLANNED";
    public static final String STATUS_RECORDED = "RECORDED";
    public static final String STATUS_SKIPPED = "SKIPPED";
    public static final String STATUS_SUPERSEDED = "SUPERSEDED";

    public static final String SESSION_NONE = "NONE";
    public static final String SESSION_PLANNED = "PLANNED";
    public static final String SESSION_UNAVAILABLE = "UNAVAILABLE";

    // ------------------------------------------------------------------ 레코드
    /** 계좌 행. */
    public record Account(String code, String label, String market, String sourceBook, String state, Instant startedAt,
                          BigDecimal startCash, int version, Instant createdAt, Instant updatedAt) {

        public boolean active() {
            return STATE_ACTIVE.equals(state);
        }

        @Override
        public String toString() {
            return "Account[code=" + code + ", state=" + state + ", version=" + version + "]";
        }
    }

    /** 잔고 행(V31 {@code manual_balance}) — 이 행이 있으면 시작한 것. 현금은 음수일 수 있습니다(막지 않고 화면에 경고 — ADR 0034). */
    public record Balance(String account, Instant startedAt, BigDecimal cash, BigDecimal commissionBp, Instant updatedAt) {

        @Override
        public String toString() {
            return "Balance[account=" + account + "]";
        }
    }

    /** 종목별 보유(V31 {@code manual_positions}). {@code name}은 사용자가 고친 표시 이름(없으면 null). */
    public record Position(String account, String symbol, String name, BigDecimal quantity, BigDecimal purchaseAmount, Instant updatedAt) {

        @Override
        public String toString() {
            return "Position[account=" + account + ", symbol=" + symbol + "]";
        }
    }

    /** 새 매매 내역의 값(번호·시각 칸 제외). */
    public record TradeValues(Instant at, String side, String symbol, BigDecimal quantity, BigDecimal price, BigDecimal fee, BigDecimal tax,
                              BigDecimal costBasis, BigDecimal realizedPnl, boolean taxAssumed, Long instructionId, Long stopInstructionId,
                              String priceSource) {

        public TradeValues {
            Objects.requireNonNull(at, "at");
            Objects.requireNonNull(side, "side");
            Objects.requireNonNull(symbol, "symbol");
            Objects.requireNonNull(priceSource, "priceSource");
        }

        @Override
        public String toString() {
            return "TradeValues[side=" + side + ", instructionId=" + instructionId + ", stopInstructionId=" + stopInstructionId + "]";
        }
    }

    /** 매매 내역 한 행(V31 {@code manual_trades}). */
    public record Trade(long id, String account, Instant at, String side, String symbol, BigDecimal quantity, BigDecimal price, BigDecimal fee,
                        BigDecimal tax, BigDecimal costBasis, BigDecimal realizedPnl, boolean taxAssumed, Long instructionId,
                        Long stopInstructionId, String priceSource, Instant createdAt) {

        @Override
        public String toString() {
            return "Trade[id=" + id + ", side=" + side + ", instructionId=" + instructionId + ", stopInstructionId=" + stopInstructionId + "]";
        }
    }

    /** 종목별(또는 전체) 수수료·세금 누적 — 내역이 없으면 합도 0(실제로 낸 돈이 없음). */
    public record CostTotals(BigDecimal fees, BigDecimal taxes) {

        @Override
        public String toString() {
            return "CostTotals[]";
        }
    }

    /** 지시 행 하나(V25 {@code manual_instructions}의 모든 칸 + V30 표시·장 중반 알림 + V31 마감 30분 전 알림). */
    public record Instruction(long id, String account, LocalDate session, String symbol, String side, int quantity, BigDecimal refPrice,
                              BigDecimal weightPct, JsonNode reason, String status, Instant notifiedNightAt, Instant notifiedMorningAt,
                              Instant confirmedAt, Instant notifiedMiddayAt, Instant notifiedPrecloseAt, Instant createdAt, Instant updatedAt) {

        public boolean planned() {
            return STATUS_PLANNED.equals(status);
        }

        @Override
        public String toString() {
            return "Instruction[id=" + id + ", session=" + session + ", side=" + side + ", status=" + status + "]";
        }
    }

    /** 새 지시 행의 값. */
    public record NewInstruction(LocalDate session, String symbol, String side, int quantity, BigDecimal refPrice, BigDecimal weightPct,
                                 JsonNode reason) {

        @Override
        public String toString() {
            return "NewInstruction[session=" + session + ", side=" + side + "]";
        }
    }

    /**
     * 장중 스탑 매도 지시 행 하나(V28 {@code manual_stop_instructions}의 모든 칸 + V31 알림 시각) — 따라 하는 모의 책의 STOP 주문 하나에 한 행.
     *
     * @param session            매도할 거래일(그 모의 주문의 목표 세션)
     * @param paperOrderId       그 모의 STOP 주문 번호(참고용 — 외래키 없음)
     * @param timing             그 모의 주문의 체결 시점(MARKET·AT_MINUTE·NEXT_CLOSE·NEXT_OPEN — 알림 글이 장중 시장가와 종가 단일가를 가름)
     * @param targetAt           그 모의 주문의 기준 시각
     * @param notifiedAt         즉시 알림을 보낸 시각(보내기 전 null)
     * @param notifiedMiddayAt   장 중반 확인 알림을 보낸 시각(보내기 전 null)
     * @param notifiedPrecloseAt 마감 30분 전 확인 알림을 보낸 시각(보내기 전 null)
     */
    public record StopInstruction(long id, String account, LocalDate session, long paperOrderId, String symbol, String side, int quantity,
                                  String timing, Instant targetAt, JsonNode reason, String status, Instant notifiedAt, Instant notifiedMiddayAt,
                                  Instant notifiedPrecloseAt, Instant createdAt, Instant updatedAt) {

        public boolean planned() {
            return STATUS_PLANNED.equals(status);
        }

        @Override
        public String toString() {
            return "StopInstruction[id=" + id + ", session=" + session + ", paperOrderId=" + paperOrderId + ", status=" + status + "]";
        }
    }

    /** 새 스탑 매도 지시 행의 값(매도만). */
    public record NewStopInstruction(LocalDate session, long paperOrderId, String symbol, int quantity, String timing, Instant targetAt,
                                     JsonNode reason) {

        public NewStopInstruction {
            Objects.requireNonNull(session, "session");
            Objects.requireNonNull(symbol, "symbol");
            Objects.requireNonNull(timing, "timing");
            Objects.requireNonNull(targetAt, "targetAt");
        }

        @Override
        public String toString() {
            return "NewStopInstruction[session=" + session + ", paperOrderId=" + paperOrderId + "]";
        }
    }

    /** 세션 행 하나(V25 {@code manual_sessions}). {@code ledgerChangedAt}은 지시를 만든 뒤 잔고가 바뀌었는데 다시 계산하지 않은 시각(없으면 null). */
    public record SessionRow(String account, LocalDate session, String state, Long decisionId, JsonNode detail, Instant ledgerChangedAt,
                             Instant createdAt) {
    }

    private static final String ACCOUNT_COLUMNS = "code, label, market, source_book, state, started_at, start_cash, version, created_at, updated_at";
    private static final String INSTRUCTION_COLUMNS = "id, account, session, symbol, side, quantity, ref_price, weight_pct, reason, status, "
            + "notified_night_at, notified_morning_at, confirmed_at, notified_midday_at, notified_preclose_at, created_at, updated_at";
    private static final String SESSION_COLUMNS = "account, session, state, decision_id, detail, ledger_changed_at, created_at";
    private static final String STOP_COLUMNS = "id, account, session, paper_order_id, symbol, side, quantity, timing, target_at, reason, status, "
            + "notified_at, notified_midday_at, notified_preclose_at, created_at, updated_at";
    private static final String TRADE_COLUMNS = "id, account, at, side, symbol, quantity, price, fee, tax, cost_basis, realized_pnl, tax_assumed, "
            + "instruction_id, stop_instruction_id, price_source, created_at";

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final SchemaCheck schema;
    /** 같은 DataSource의 트랜잭션 — 안에서 부르는 이 저장소의 문장이 같은 연결에 합류합니다. */
    private final TransactionTemplate transactions;

    public ManualAccountStore(JdbcTemplate jdbc, ObjectMapper mapper, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.schema = schema;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    /**
     * 표가 있는가. 수집기가 아직 V25·V28·V30·V31을 적용하지 않았으면 false입니다(그때 ISA 계좌는 '준비 중') — 지시·잔고 조회가 그 표·칸을 읽으므로 백엔드만 새로
     * 띄운 배포(QA-016)에서 SQL 오류 대신 안내 문구가 나가게.
     */
    public boolean ready() {
        return schema.tableExists("manual_accounts") && schema.tableExists("manual_ledger")
                && schema.tableExists("manual_instructions") && schema.tableExists("manual_sessions")
                && schema.tableExists("manual_stop_instructions") && schema.columnExists("manual_ledger", "stop_instruction_id")
                && schema.columnExists("manual_instructions", "confirmed_at") && schema.columnExists("manual_instructions", "notified_midday_at")
                && schema.tableExists("manual_balance") && schema.tableExists("manual_positions") && schema.tableExists("manual_trades")
                && schema.columnExists("manual_instructions", "notified_preclose_at")
                && schema.columnExists("manual_stop_instructions", "notified_midday_at")
                && schema.columnExists("manual_stop_instructions", "notified_preclose_at");
    }

    /**
     * 쓰기 여러 개를 한 트랜잭션으로 — 안에서 예외가 나면 모두 되돌리고 그 예외를 그대로 던집니다. 이미 트랜잭션 안이면 거기에 합류합니다.
     * 안에서 DB 오류를 잡고 계속 쓰면 안 됩니다(PostgreSQL은 오류가 난 트랜잭션의 나머지 문장을 거절함).
     */
    public <T> T atomically(Supplier<T> work) {
        return transactions.execute(status -> work.get());
    }

    // ------------------------------------------------------------------ 계좌
    public Optional<Account> account(String code) {
        return jdbc.query("SELECT " + ACCOUNT_COLUMNS + " FROM manual_accounts WHERE code = ?", accountMapper(), code).stream().findFirst();
    }

    /**
     * 계좌 행을 잡은 트랜잭션 안에서 일을 돌립니다(클래스 설명의 잠금). 행이 없으면 {@code work}가 null을 받습니다(잡을 행이 없음 — 시작 전).
     * {@code work}가 던진 예외는 트랜잭션을 되돌리고 그대로 나갑니다.
     */
    public <T> T lockAccount(String code, Function<Account, T> work) {
        return atomically(() -> {
            Account current = jdbc.query("SELECT " + ACCOUNT_COLUMNS + " FROM manual_accounts WHERE code = ? FOR UPDATE", accountMapper(), code)
                    .stream().findFirst().orElse(null);
            return work.apply(current);
        });
    }

    /** 계좌를 만듭니다. 같은 코드가 이미 있으면 아무것도 하지 않고 false(시작 때 재사용). */
    public boolean insertAccount(String code, String label, String market, String sourceBook, Instant startedAt, BigDecimal startCash) {
        return jdbc.update("INSERT INTO manual_accounts (code, label, market, source_book, state, started_at, start_cash) "
                        + "VALUES (?, ?, ?, ?, 'ACTIVE', ?, ?) ON CONFLICT (code) DO NOTHING",
                code, label, market, sourceBook, Timestamp.from(startedAt), startCash) == 1;
    }

    /** 잔고·지시가 바뀌었음을 계좌 버전에 남깁니다. */
    public void bumpVersion(String code) {
        jdbc.update("UPDATE manual_accounts SET version = version + 1, updated_at = now() WHERE code = ?", code);
    }

    // ------------------------------------------------------------------ 잔고(V31)
    public Optional<Balance> balance(String code) {
        return jdbc.query("SELECT account, started_at, cash, commission_bp, updated_at FROM manual_balance WHERE account = ?", balanceMapper(), code)
                .stream().findFirst();
    }

    /** 잔고를 만듭니다 — 이미 있으면 아무것도 하지 않고 false(시작은 한 번만). 수수료율은 표 기본값. */
    public boolean insertBalance(String code, Instant startedAt, BigDecimal cash) {
        return jdbc.update("INSERT INTO manual_balance (account, started_at, cash) VALUES (?, ?, ?) ON CONFLICT (account) DO NOTHING",
                code, Timestamp.from(startedAt), cash) == 1;
    }

    /** 현금을 고칩니다. 잔고가 없으면 false. */
    public boolean updateCash(String code, BigDecimal cash) {
        return jdbc.update("UPDATE manual_balance SET cash = ?, updated_at = now() WHERE account = ?", cash, code) == 1;
    }

    /** 수수료율(bp)을 고칩니다. 잔고가 없으면 false. */
    public boolean updateCommission(String code, BigDecimal commissionBp) {
        return jdbc.update("UPDATE manual_balance SET commission_bp = ?, updated_at = now() WHERE account = ?", commissionBp, code) == 1;
    }

    // ------------------------------------------------------------------ 보유(V31)
    /** 그 계좌의 보유 전부 — 종목 코드 순. */
    public List<Position> positions(String code) {
        return jdbc.query("SELECT account, symbol, name, quantity, purchase_amount, updated_at FROM manual_positions WHERE account = ? ORDER BY symbol",
                positionMapper(), code);
    }

    public Optional<Position> position(String code, String symbol) {
        return jdbc.query("SELECT account, symbol, name, quantity, purchase_amount, updated_at FROM manual_positions WHERE account = ? AND symbol = ?",
                positionMapper(), code, symbol).stream().findFirst();
    }

    /** 보유를 넣거나 고칩니다(같은 종목이면 이름·수량·매입 금액을 덮어씀). */
    public void upsertPosition(String code, String symbol, String name, BigDecimal quantity, BigDecimal purchaseAmount) {
        jdbc.update("INSERT INTO manual_positions (account, symbol, name, quantity, purchase_amount) VALUES (?, ?, ?, ?, ?) "
                + "ON CONFLICT (account, symbol) DO UPDATE SET name = EXCLUDED.name, quantity = EXCLUDED.quantity, "
                + "purchase_amount = EXCLUDED.purchase_amount, updated_at = now()", code, symbol, name, quantity, purchaseAmount);
    }

    /** 보유를 지웁니다. 없으면 false. */
    public boolean deletePosition(String code, String symbol) {
        return jdbc.update("DELETE FROM manual_positions WHERE account = ? AND symbol = ?", code, symbol) == 1;
    }

    // ------------------------------------------------------------------ 매매 내역(V31)
    /** 최근 매매 내역 — 시각이 늦은 것부터. */
    public List<Trade> recentTrades(String code, int limit) {
        return jdbc.query("SELECT " + TRADE_COLUMNS + " FROM manual_trades WHERE account = ? ORDER BY at DESC, id DESC LIMIT ?", tradeMapper(), code, limit);
    }

    public Optional<Trade> trade(long id) {
        return jdbc.query("SELECT " + TRADE_COLUMNS + " FROM manual_trades WHERE id = ?", tradeMapper(), id).stream().findFirst();
    }

    /** 매매 내역을 씁니다 — 새 번호. */
    public long insertTrade(String code, TradeValues v) {
        Long id = jdbc.query("INSERT INTO manual_trades (account, at, side, symbol, quantity, price, fee, tax, cost_basis, realized_pnl, tax_assumed, "
                        + "instruction_id, stop_instruction_id, price_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                ps -> {
                    ps.setString(1, code);
                    ps.setTimestamp(2, Timestamp.from(v.at()));
                    ps.setString(3, v.side());
                    ps.setString(4, v.symbol());
                    ps.setBigDecimal(5, v.quantity());
                    ps.setBigDecimal(6, v.price());
                    ps.setBigDecimal(7, v.fee());
                    ps.setBigDecimal(8, v.tax());
                    ps.setBigDecimal(9, v.costBasis());
                    ps.setBigDecimal(10, v.realizedPnl());
                    ps.setBoolean(11, v.taxAssumed());
                    if (v.instructionId() == null) {
                        ps.setNull(12, Types.BIGINT);
                    } else {
                        ps.setLong(12, v.instructionId());
                    }
                    if (v.stopInstructionId() == null) {
                        ps.setNull(13, Types.BIGINT);
                    } else {
                        ps.setLong(13, v.stopInstructionId());
                    }
                    ps.setString(14, v.priceSource());
                }, (rs, rowNum) -> rs.getLong("id")).stream().findFirst().orElseThrow();
        return id;
    }

    /** 매매 내역을 지웁니다(되돌리기). 없으면 false. */
    public boolean deleteTrade(String code, long id) {
        return jdbc.update("DELETE FROM manual_trades WHERE id = ? AND account = ?", id, code) == 1;
    }

    /** 종목별 수수료·세금 누적(내역이 있는 종목만). */
    public Map<String, CostTotals> costsBySymbol(String code) {
        Map<String, CostTotals> out = new TreeMap<>();
        jdbc.query("SELECT symbol, COALESCE(SUM(fee), 0) AS fees, COALESCE(SUM(tax), 0) AS taxes FROM manual_trades WHERE account = ? GROUP BY symbol",
                rs -> {
                    out.put(rs.getString("symbol"), new CostTotals(rs.getBigDecimal("fees"), rs.getBigDecimal("taxes")));
                }, code);
        return out;
    }

    // ------------------------------------------------------------------ 지시
    public Optional<Instruction> instruction(long id) {
        return jdbc.query("SELECT " + INSTRUCTION_COLUMNS + " FROM manual_instructions WHERE id = ?", instructionMapper(), id).stream().findFirst();
    }

    /** 그 세션의 지시 — 만든 순서(매도 → 매수, 현금성 매수 마지막). */
    public List<Instruction> instructions(String code, LocalDate session) {
        return jdbc.query("SELECT " + INSTRUCTION_COLUMNS + " FROM manual_instructions WHERE account = ? AND session = ? ORDER BY id",
                instructionMapper(), code, Date.valueOf(session));
    }

    /** 아직 확인하지 않은(PLANNED) 지시 — 세션 → 번호 순. */
    public List<Instruction> plannedInstructions(String code) {
        return jdbc.query("SELECT " + INSTRUCTION_COLUMNS + " FROM manual_instructions WHERE account = ? AND status = 'PLANNED' "
                + "ORDER BY session, id", instructionMapper(), code);
    }

    /** 최근 지시 — 늦게 만든 것부터. */
    public List<Instruction> recentInstructions(String code, int limit) {
        return jdbc.query("SELECT " + INSTRUCTION_COLUMNS + " FROM manual_instructions WHERE account = ? ORDER BY id DESC LIMIT ?",
                instructionMapper(), code, limit);
    }

    /** 지시 행을 씁니다 — 같은 (계좌, 세션, 종목)이 이미 있으면 아무것도 하지 않고 empty. */
    public Optional<Long> insertInstruction(String code, NewInstruction n) {
        return jdbc.query("INSERT INTO manual_instructions (account, session, symbol, side, quantity, ref_price, weight_pct, reason) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb) ON CONFLICT (account, session, symbol) DO NOTHING RETURNING id",
                ps -> {
                    ps.setString(1, code);
                    ps.setDate(2, Date.valueOf(n.session()));
                    ps.setString(3, n.symbol());
                    ps.setString(4, n.side());
                    ps.setInt(5, n.quantity());
                    ps.setBigDecimal(6, n.refPrice());
                    ps.setBigDecimal(7, n.weightPct());
                    ps.setString(8, json(n.reason()));
                }, (rs, rowNum) -> rs.getLong("id")).stream().findFirst();
    }

    /**
     * 그 세션의 PLANNED 지시 가운데 묶인 행이 없는 것을 지우고 지운 행을 돌려줍니다(잔고 고침 뒤 다시 계산 — 같은 (계좌, 세션, 종목) 유일 제약이라 상태만 바꾸면 다시
     * 만든 지시가 들어가지 못함).
     */
    public List<Instruction> deleteUnlinkedPlanned(String code, LocalDate session) {
        return jdbc.query("DELETE FROM manual_instructions i WHERE i.account = ? AND i.session = ? AND i.status = 'PLANNED' "
                        + "AND NOT EXISTS (SELECT 1 FROM manual_ledger l WHERE l.instruction_id = i.id) "
                        + "AND NOT EXISTS (SELECT 1 FROM manual_trades t WHERE t.instruction_id = i.id) RETURNING " + INSTRUCTION_COLUMNS,
                instructionMapper(), code, Date.valueOf(session));
    }

    /**
     * 시작 때 아직 열리지 않은 세션(그 날짜 이후)의 지시(묶인 행이 없는 것 — 상태를 가리지 않음)와 세션 행을 지웁니다 — 새 잔고로 다시 만들게(같은 유일 제약 때문에 상태만
     * 바꾸면 다시 만든 지시가 들어가지 못함). 지운 세션 행 수.
     */
    public int deleteSessionsFrom(String code, LocalDate from) {
        jdbc.update("DELETE FROM manual_instructions i WHERE i.account = ? AND i.session >= ? "
                + "AND NOT EXISTS (SELECT 1 FROM manual_ledger l WHERE l.instruction_id = i.id) "
                + "AND NOT EXISTS (SELECT 1 FROM manual_trades t WHERE t.instruction_id = i.id)", code, Date.valueOf(from));
        return jdbc.update("DELETE FROM manual_sessions WHERE account = ? AND session >= ?", code, Date.valueOf(from));
    }

    /**
     * 지시 상태를 바꿉니다. {@code reasonPatch}가 있으면 근거 JSON에 덧붙입니다(같은 키는 덮어씀). {@code expected}가 있으면 그 상태일 때만 바꿉니다.
     *
     * @return 바꿨으면 true
     */
    public boolean updateInstructionStatus(long id, String status, String expected, Map<String, ?> reasonPatch) {
        String patch = reasonPatch == null || reasonPatch.isEmpty() ? "{}" : mapper.writeValueAsString(reasonPatch);
        if (expected == null) {
            return jdbc.update("UPDATE manual_instructions SET status = ?, reason = reason || ?::jsonb, updated_at = now() WHERE id = ?",
                    status, patch, id) == 1;
        }
        return jdbc.update("UPDATE manual_instructions SET status = ?, reason = reason || ?::jsonb, updated_at = now() "
                + "WHERE id = ? AND status = ?", status, patch, id, expected) == 1;
    }

    /**
     * 되돌리기 — 지시를 다시 PLANNED(또는 마감이 지났으면 SKIPPED)로 두면서 근거에서 {@code recordedBy}를 지우고 {@code reasonPatch}를 덧붙입니다.
     *
     * @return 바꿨으면 true
     */
    public boolean reopenInstruction(long id, String status, Map<String, ?> reasonPatch) {
        return jdbc.update("UPDATE manual_instructions SET status = ?, reason = (reason - 'recordedBy') || ?::jsonb, updated_at = now() WHERE id = ?",
                status, reasonPatch == null || reasonPatch.isEmpty() ? "{}" : mapper.writeValueAsString(reasonPatch), id) == 1;
    }

    /** 아침 알림을 보낸 시각을 남깁니다(아직 없는 행만). */
    public int markNotifiedMorning(Collection<Long> ids, Instant at) {
        return markNotified("manual_instructions", "notified_morning_at", ids, at);
    }

    /** 장 중반 확인 알림을 보낸 시각을 남깁니다(아직 없는 행만). */
    public int markNotifiedMidday(Collection<Long> ids, Instant at) {
        return markNotified("manual_instructions", "notified_midday_at", ids, at);
    }

    /** 마감 30분 전 확인 알림을 보낸 시각을 남깁니다(아직 없는 행만). */
    public int markNotifiedPreclose(Collection<Long> ids, Instant at) {
        return markNotified("manual_instructions", "notified_preclose_at", ids, at);
    }

    private int markNotified(String table, String column, Collection<Long> ids, Instant at) {
        if (ids.isEmpty()) {
            return 0;
        }
        Long[] array = ids.toArray(new Long[0]);
        return jdbc.update("UPDATE " + table + " SET " + column + " = ?, updated_at = now() WHERE id = ANY (?) AND " + column + " IS NULL", ps -> {
            ps.setTimestamp(1, Timestamp.from(at));
            ps.setArray(2, ps.getConnection().createArrayOf("bigint", array));
        });
    }

    // ------------------------------------------------------------------ 스탑 매도 지시(V28)
    public Optional<StopInstruction> stopInstruction(long id) {
        return jdbc.query("SELECT " + STOP_COLUMNS + " FROM manual_stop_instructions WHERE id = ?", stopMapper(), id).stream().findFirst();
    }

    /** 그 모의 STOP 주문의 지시(계좌마다 하나). */
    public Optional<StopInstruction> stopInstructionForOrder(String code, long paperOrderId) {
        return jdbc.query("SELECT " + STOP_COLUMNS + " FROM manual_stop_instructions WHERE account = ? AND paper_order_id = ?", stopMapper(),
                code, paperOrderId).stream().findFirst();
    }

    /** 그 세션의 스탑 지시 — 만든 순서. */
    public List<StopInstruction> stopInstructions(String code, LocalDate session) {
        return jdbc.query("SELECT " + STOP_COLUMNS + " FROM manual_stop_instructions WHERE account = ? AND session = ? ORDER BY id", stopMapper(),
                code, Date.valueOf(session));
    }

    /** 아직 확인하지 않은(PLANNED) 스탑 지시 — 세션 → 번호 순. */
    public List<StopInstruction> plannedStopInstructions(String code) {
        return jdbc.query("SELECT " + STOP_COLUMNS + " FROM manual_stop_instructions WHERE account = ? AND status = 'PLANNED' "
                + "ORDER BY session, id", stopMapper(), code);
    }

    /** 최근 스탑 지시 — 늦게 만든 것부터. */
    public List<StopInstruction> recentStopInstructions(String code, int limit) {
        return jdbc.query("SELECT " + STOP_COLUMNS + " FROM manual_stop_instructions WHERE account = ? ORDER BY id DESC LIMIT ?", stopMapper(),
                code, limit);
    }

    /** 스탑 지시 행을 씁니다 — 같은 (계좌, 모의 주문)이 이미 있으면 아무것도 하지 않고 empty(같은 스탑을 두 번 알리거나 적지 않게). */
    public Optional<Long> insertStopInstruction(String code, NewStopInstruction n) {
        return jdbc.query("INSERT INTO manual_stop_instructions (account, session, paper_order_id, symbol, quantity, timing, target_at, reason) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb) ON CONFLICT (account, paper_order_id) DO NOTHING RETURNING id",
                ps -> {
                    ps.setString(1, code);
                    ps.setDate(2, Date.valueOf(n.session()));
                    ps.setLong(3, n.paperOrderId());
                    ps.setString(4, n.symbol());
                    ps.setInt(5, n.quantity());
                    ps.setString(6, n.timing());
                    ps.setTimestamp(7, Timestamp.from(n.targetAt()));
                    ps.setString(8, json(n.reason()));
                }, (rs, rowNum) -> rs.getLong("id")).stream().findFirst();
    }

    /**
     * 스탑 지시 상태를 바꿉니다. {@code reasonPatch}가 있으면 근거 JSON에 덧붙입니다(같은 키는 덮어씀). {@code expected}가 있으면 그 상태일 때만 바꿉니다.
     *
     * @return 바꿨으면 true
     */
    public boolean updateStopInstructionStatus(long id, String status, String expected, Map<String, ?> reasonPatch) {
        String patch = reasonPatch == null || reasonPatch.isEmpty() ? "{}" : mapper.writeValueAsString(reasonPatch);
        if (expected == null) {
            return jdbc.update("UPDATE manual_stop_instructions SET status = ?, reason = reason || ?::jsonb, updated_at = now() WHERE id = ?",
                    status, patch, id) == 1;
        }
        return jdbc.update("UPDATE manual_stop_instructions SET status = ?, reason = reason || ?::jsonb, updated_at = now() "
                + "WHERE id = ? AND status = ?", status, patch, id, expected) == 1;
    }

    /** 되돌리기 — {@link #reopenInstruction}의 스탑 지시판. */
    public boolean reopenStopInstruction(long id, String status, Map<String, ?> reasonPatch) {
        return jdbc.update("UPDATE manual_stop_instructions SET status = ?, reason = (reason - 'recordedBy') || ?::jsonb, updated_at = now() WHERE id = ?",
                status, reasonPatch == null || reasonPatch.isEmpty() ? "{}" : mapper.writeValueAsString(reasonPatch), id) == 1;
    }

    /** 즉시 알림을 보낸 시각을 남깁니다(아직 없는 행만). */
    public int markStopNotified(Collection<Long> ids, Instant at) {
        return markNotified("manual_stop_instructions", "notified_at", ids, at);
    }

    /** 장 중반 확인 알림을 보낸 시각을 남깁니다(아직 없는 행만). */
    public int markStopMidday(Collection<Long> ids, Instant at) {
        return markNotified("manual_stop_instructions", "notified_midday_at", ids, at);
    }

    /** 마감 30분 전 확인 알림을 보낸 시각을 남깁니다(아직 없는 행만). */
    public int markStopPreclose(Collection<Long> ids, Instant at) {
        return markNotified("manual_stop_instructions", "notified_preclose_at", ids, at);
    }

    // ------------------------------------------------------------------ 세션
    public Optional<SessionRow> session(String code, LocalDate session) {
        return jdbc.query("SELECT " + SESSION_COLUMNS + " FROM manual_sessions WHERE account = ? AND session = ?", sessionMapper(), code,
                Date.valueOf(session)).stream().findFirst();
    }

    /** 가장 늦은 세션 행. */
    public Optional<SessionRow> latestSession(String code) {
        return jdbc.query("SELECT " + SESSION_COLUMNS + " FROM manual_sessions WHERE account = ? ORDER BY session DESC LIMIT 1",
                sessionMapper(), code).stream().findFirst();
    }

    /** 세션 행을 씁니다 — 이미 있으면 아무것도 하지 않고 false(같은 세션을 되풀이하지 않게). */
    public boolean insertSession(String code, LocalDate session, String state, Long decisionId, JsonNode detail) {
        return jdbc.update("INSERT INTO manual_sessions (account, session, state, decision_id, detail) VALUES (?, ?, ?, ?, ?::jsonb) "
                + "ON CONFLICT (account, session) DO NOTHING", ps -> {
                    ps.setString(1, code);
                    ps.setDate(2, Date.valueOf(session));
                    ps.setString(3, state);
                    if (decisionId == null) {
                        ps.setNull(4, Types.BIGINT);
                    } else {
                        ps.setLong(4, decisionId);
                    }
                    ps.setString(5, json(detail));
                }) == 1;
    }

    /** 세션 행을 지웁니다(잔고 고침 뒤 다시 계산 — 정기 작업이 다시 만듦). 없으면 false. */
    public boolean deleteSession(String code, LocalDate session) {
        return jdbc.update("DELETE FROM manual_sessions WHERE account = ? AND session = ?", code, Date.valueOf(session)) == 1;
    }

    /** 지시를 만든 뒤 잔고가 바뀌었는데 다시 계산하지 않음을 남깁니다. 없는 세션이면 false. */
    public boolean markLedgerChanged(String code, LocalDate session, Instant at) {
        return jdbc.update("UPDATE manual_sessions SET ledger_changed_at = ? WHERE account = ? AND session = ?", Timestamp.from(at), code,
                Date.valueOf(session)) == 1;
    }

    // ------------------------------------------------------------------ 보조
    private String json(JsonNode node) {
        return node == null ? "{}" : mapper.writeValueAsString(node);
    }

    private static RowMapper<Account> accountMapper() {
        return (rs, rowNum) -> new Account(rs.getString("code"), rs.getString("label"), rs.getString("market"), rs.getString("source_book"),
                rs.getString("state"), instant(rs, "started_at"), rs.getBigDecimal("start_cash"), rs.getInt("version"),
                instant(rs, "created_at"), instant(rs, "updated_at"));
    }

    private static RowMapper<Balance> balanceMapper() {
        return (rs, rowNum) -> new Balance(rs.getString("account"), instant(rs, "started_at"), rs.getBigDecimal("cash"),
                rs.getBigDecimal("commission_bp"), instant(rs, "updated_at"));
    }

    private static RowMapper<Position> positionMapper() {
        return (rs, rowNum) -> new Position(rs.getString("account"), rs.getString("symbol"), rs.getString("name"), rs.getBigDecimal("quantity"),
                rs.getBigDecimal("purchase_amount"), instant(rs, "updated_at"));
    }

    private static RowMapper<Trade> tradeMapper() {
        return (rs, rowNum) -> new Trade(rs.getLong("id"), rs.getString("account"), instant(rs, "at"), rs.getString("side"), rs.getString("symbol"),
                rs.getBigDecimal("quantity"), rs.getBigDecimal("price"), rs.getBigDecimal("fee"), rs.getBigDecimal("tax"), rs.getBigDecimal("cost_basis"),
                rs.getBigDecimal("realized_pnl"), rs.getBoolean("tax_assumed"), rs.getObject("instruction_id", Long.class),
                rs.getObject("stop_instruction_id", Long.class), rs.getString("price_source"), instant(rs, "created_at"));
    }

    private RowMapper<StopInstruction> stopMapper() {
        return (rs, rowNum) -> new StopInstruction(rs.getLong("id"), rs.getString("account"), rs.getDate("session").toLocalDate(),
                rs.getLong("paper_order_id"), rs.getString("symbol"), rs.getString("side"), rs.getInt("quantity"), rs.getString("timing"),
                instant(rs, "target_at"), json(rs, "reason"), rs.getString("status"), instant(rs, "notified_at"), instant(rs, "notified_midday_at"),
                instant(rs, "notified_preclose_at"), instant(rs, "created_at"), instant(rs, "updated_at"));
    }

    private RowMapper<Instruction> instructionMapper() {
        return (rs, rowNum) -> new Instruction(rs.getLong("id"), rs.getString("account"), rs.getDate("session").toLocalDate(),
                rs.getString("symbol"), rs.getString("side"), rs.getInt("quantity"), rs.getBigDecimal("ref_price"),
                rs.getBigDecimal("weight_pct"), json(rs, "reason"), rs.getString("status"), instant(rs, "notified_night_at"),
                instant(rs, "notified_morning_at"), instant(rs, "confirmed_at"), instant(rs, "notified_midday_at"), instant(rs, "notified_preclose_at"),
                instant(rs, "created_at"), instant(rs, "updated_at"));
    }

    private RowMapper<SessionRow> sessionMapper() {
        return (rs, rowNum) -> new SessionRow(rs.getString("account"), rs.getDate("session").toLocalDate(), rs.getString("state"),
                rs.getObject("decision_id", Long.class), json(rs, "detail"), instant(rs, "ledger_changed_at"), instant(rs, "created_at"));
    }

    private JsonNode json(ResultSet rs, String column) throws SQLException {
        String raw = rs.getString(column);
        return raw == null ? null : mapper.readTree(raw);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp timestamp = rs.getTimestamp(column);
        return timestamp == null ? null : timestamp.toInstant();
    }
}
