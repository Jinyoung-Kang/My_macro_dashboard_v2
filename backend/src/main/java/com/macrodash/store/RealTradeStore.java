package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.sql.Array;
import java.sql.Date;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * 실제 매매 표({@code real_trade_*}, V24 — ADR 0028 결정 7, 명세 docs/specs/2026-11-06-real-trade-mirror.md §6) — 백엔드가 쓰는 표(ADR 0008).
 * 이 표들의 JDBC는 <b>전부 여기</b>에 있고, 부르는 곳은 {@code feature.realtrade} 하나입니다(ArchitectureRulesTest가 막음).
 *
 * <p><b>잠금</b>(명세 §1): {@link #lockConfig}가 그 시장 설정 행을 {@code SELECT … FOR UPDATE}로 잡은 트랜잭션 안에서 받은 일을 돌립니다 — 안에서 부르는
 * 이 저장소의 쓰기({@link #updateConfig}·{@link #insertSending}·{@link #addEvent})가 같은 연결·트랜잭션에 합류하므로 '상태가 LIVE이고 버전이 같음 +
 * SENDING 행 삽입'이 한 트랜잭션입니다. 끄기가 커밋된 뒤에는 그 행을 잡은 다음 트랜잭션이 바뀐 상태를 보므로 새 SENDING이 생길 수 없습니다.
 *
 * <p><b>유일 위반은 결과로</b>: SENDING 삽입은 {@code ON CONFLICT DO NOTHING}이라 같은 키(모의 주문 뿌리·용도·시도, 묶음의 종목·용도·시도,
 * {@code client_order_id})가 이미 있으면 예외 없이 빈 값을 돌려줍니다 — PostgreSQL은 오류가 난 트랜잭션의 나머지 문장을 모두 거절하므로, 잠금
 * 트랜잭션 안에서 중복을 예외로 받으면 같은 트랜잭션의 다른 쓰기까지 못 하게 됩니다.
 *
 * <p>값의 모양: 돈·수량·가격은 {@link BigDecimal}(DB NUMERIC 그대로 — 실제 돈이라 {@code double}로 어림하지 않음), 시각은 {@link Instant}, 거래일은
 * {@link LocalDate}, JSON 열은 {@link JsonNode}입니다. 비어 있을 수 있는 열은 null입니다(0으로 채우지 않음). 토스 주문 번호({@code tossOrderId})는
 * DB에만 두는 값이라 레코드의 {@code toString}에 싣지 않습니다(로그로 새지 않게 — 응답에도 싣지 않는 것은 부르는 쪽 몫).
 */
@Repository
public class RealTradeStore {

    // ------------------------------------------------------------------ 값(DB CHECK와 같은 문자열)
    public static final String MARKET_KR = "KR";
    public static final String MARKET_US = "US";

    public static final String STATE_OFF = "OFF";
    public static final String STATE_LIVE = "LIVE";
    public static final String STATE_HALTED = "HALTED";
    public static final String STATE_STOPPING = "STOPPING";

    public static final String PURPOSE_SYNC = "SYNC";
    public static final String PURPOSE_SYNC_FOLLOWUP = "SYNC_FOLLOWUP";
    public static final String PURPOSE_MIRROR = "MIRROR";

    public static final String OUTCOME_SENDING = "SENDING";
    public static final String OUTCOME_ACCEPTED = "ACCEPTED";
    public static final String OUTCOME_REJECTED = "REJECTED";
    public static final String OUTCOME_UNKNOWN = "UNKNOWN";
    public static final String OUTCOME_NOT_SENT = "NOT_SENT";

    public static final String BATCH_SYNC = "SYNC";

    /** 이벤트 종류(명세 §6 — 목록은 열어 둠, DB는 대문자·밑줄 이름만 받음). */
    public static final String EVENT_ENABLE = "ENABLE";
    public static final String EVENT_DISABLE = "DISABLE";
    public static final String EVENT_UPDATE = "UPDATE";
    public static final String EVENT_RESUME = "RESUME";
    public static final String EVENT_HALT = "HALT";
    public static final String EVENT_BUYS_PAUSED = "BUYS_PAUSED";
    public static final String EVENT_SKIP_DAY = "SKIP_DAY";
    public static final String EVENT_WINDOW_SUMMARY = "WINDOW_SUMMARY";
    public static final String EVENT_PASSWORD_FAILED = "PASSWORD_FAILED";
    public static final String EVENT_RESTORED = "RESTORED";

    /** 설정 행이 없을 때의 손실 한도(DB 기본값과 같음 — 명세 §6). */
    public static final BigDecimal DEFAULT_LOSS_LIMIT_PCT = new BigDecimal("15.00");

    // ------------------------------------------------------------------ 레코드
    /**
     * 시장 하나의 설정 행. {@code version}은 낙관적 잠금 값(바꿀 때마다 1씩 늘어남), {@code updatedBy}는 바꾼 운영자(정기 작업이면 null).
     * {@code baselineEquity}는 켤 때(또는 기준 다시 잡기)의 운용 평가액(안전 상한 적용 — 손실 한도 금액의 분모), {@code baselineTotal}은 같은 때의 상한 없는
     * 총액(손실 판정의 기준 — 모르면 null). 바꿀 때는 {@code with…}로 새 값을 만들어 {@link #updateConfig}에 넘깁니다(버전은 읽은 값 그대로 — 비교에 씀).
     */
    public record Config(String market, String state, String sourceBook, String bookGeneration, BigDecimal lossLimitPct,
                         BigDecimal baselineEquity, BigDecimal baselineTotal, boolean buysPaused, boolean syncPending, String haltReason,
                         JsonNode haltDetail, int version, Instant updatedAt, Long updatedBy) {

        /** 행이 없는 시장 — 꺼짐, 버전 0(DB 기본값과 같음). 저장하지 않은 값입니다. */
        public static Config off(String market) {
            return new Config(market, STATE_OFF, null, null, DEFAULT_LOSS_LIMIT_PCT, null, null, false, false, null, null, 0, null,
                    null);
        }

        public Config withState(String next) {
            return new Config(market, next, sourceBook, bookGeneration, lossLimitPct, baselineEquity, baselineTotal, buysPaused, syncPending,
                    haltReason, haltDetail, version, updatedAt, updatedBy);
        }

        public Config withSource(String book, String generation) {
            return new Config(market, state, book, generation, lossLimitPct, baselineEquity, baselineTotal, buysPaused, syncPending,
                    haltReason, haltDetail, version, updatedAt, updatedBy);
        }

        public Config withLossLimitPct(BigDecimal pct) {
            return new Config(market, state, sourceBook, bookGeneration, pct, baselineEquity, baselineTotal, buysPaused, syncPending,
                    haltReason, haltDetail, version, updatedAt, updatedBy);
        }

        public Config withBaselineEquity(BigDecimal equity) {
            return new Config(market, state, sourceBook, bookGeneration, lossLimitPct, equity, baselineTotal, buysPaused, syncPending,
                    haltReason, haltDetail, version, updatedAt, updatedBy);
        }

        public Config withBaselineTotal(BigDecimal total) {
            return new Config(market, state, sourceBook, bookGeneration, lossLimitPct, baselineEquity, total, buysPaused, syncPending,
                    haltReason, haltDetail, version, updatedAt, updatedBy);
        }

        public Config withBuysPaused(boolean paused) {
            return new Config(market, state, sourceBook, bookGeneration, lossLimitPct, baselineEquity, baselineTotal, paused, syncPending,
                    haltReason, haltDetail, version, updatedAt, updatedBy);
        }

        public Config withSyncPending(boolean pending) {
            return new Config(market, state, sourceBook, bookGeneration, lossLimitPct, baselineEquity, baselineTotal, buysPaused, pending,
                    haltReason, haltDetail, version, updatedAt, updatedBy);
        }

        /** 이상 멈춤 사유(해제할 때는 둘 다 null). */
        public Config withHalt(String reason, JsonNode detail) {
            return new Config(market, state, sourceBook, bookGeneration, lossLimitPct, baselineEquity, baselineTotal, buysPaused, syncPending,
                    reason, detail, version, updatedAt, updatedBy);
        }
    }

    /**
     * 보내기 전에 쓰는 실제 주문 행(SENDING). {@code firstSentAt}은 요청 본문의 {@code firstSentAt}과 같은 값이어야 합니다(재전송 7분 창의 시작 —
     * 명세 §4). 장중 따라 하기(MIRROR)는 {@code paperOrderId}·{@code paperRootOrderId}가, 시가 맞추기·마무리는 {@code batchId}가 있어야 합니다(DB CHECK).
     */
    public record NewOrder(String market, LocalDate session, String purpose, Long batchId, String sourceBook,
                           String bookGeneration, Long paperOrderId, Long paperRootOrderId, String symbol, String side,
                           int quantity, String timeInForce, BigDecimal refPrice, int attempt, String clientOrderId,
                           String requestBody, Instant firstSentAt) {

        public NewOrder {
            Objects.requireNonNull(market, "market");
            Objects.requireNonNull(session, "session");
            Objects.requireNonNull(purpose, "purpose");
            Objects.requireNonNull(clientOrderId, "clientOrderId");
            Objects.requireNonNull(requestBody, "requestBody");
            Objects.requireNonNull(firstSentAt, "firstSentAt");
        }

        @Override
        public String toString() {
            return "NewOrder[market=" + market + ", session=" + session + ", purpose=" + purpose + ", batchId=" + batchId
                    + ", sourceBook=" + sourceBook + ", paperOrderId=" + paperOrderId + ", paperRootOrderId=" + paperRootOrderId
                    + ", symbol=" + symbol + ", side=" + side + ", quantity=" + quantity + ", timeInForce=" + timeInForce
                    + ", attempt=" + attempt + "]";
        }
    }

    /**
     * 실제 주문 행 하나(V24 {@code real_trade_orders}의 모든 칸). 취소는 처음 보낸 시각({@code cancelRequestedAt})·마지막 결과·보낸 횟수·마지막으로 보낸
     * 시각·포기를 알린 시각을 둡니다. {@code toString}에는 클라이언트 키·토스 주문 번호·요청 본문을 싣지 않습니다.
     */
    public record OrderRow(long id, String market, LocalDate session, String purpose, Long batchId, String sourceBook,
                           String bookGeneration, Long paperOrderId, Long paperRootOrderId, String symbol, String side,
                           int quantity, String timeInForce, BigDecimal refPrice, int attempt, String clientOrderId,
                           String requestBody, String sendOutcome, String outcomeCode, String tossOrderId, String brokerStatus,
                           boolean terminal, BigDecimal filledQuantity, BigDecimal averageFilledPrice, BigDecimal filledAmount,
                           BigDecimal commission, BigDecimal tax, Instant filledAt, Instant firstSentAt, Instant lastSentAt,
                           int sendCount, Instant cancelRequestedAt, String cancelOutcome, int cancelCount, Instant cancelLastAt,
                           Instant cancelGaveUpAt, Instant createdAt, Instant updatedAt) {

        @Override
        public String toString() {
            return "OrderRow[id=" + id + ", market=" + market + ", session=" + session + ", purpose=" + purpose + ", batchId="
                    + batchId + ", paperOrderId=" + paperOrderId + ", paperRootOrderId=" + paperRootOrderId + ", symbol=" + symbol
                    + ", side=" + side + ", quantity=" + quantity + ", timeInForce=" + timeInForce + ", attempt=" + attempt
                    + ", sendOutcome=" + sendOutcome + ", outcomeCode=" + outcomeCode + ", brokerStatus=" + brokerStatus
                    + ", terminal=" + terminal + ", sendCount=" + sendCount + ", cancelCount=" + cancelCount + "]";
        }
    }

    /** 상태 추적 결과(명세 §4 — 토스 주문 조회의 상태와 체결). 모르는 값은 null(0으로 채우지 않음). */
    public record Tracking(String brokerStatus, boolean terminal, BigDecimal filledQuantity, BigDecimal averageFilledPrice,
                           BigDecimal filledAmount, BigDecimal commission, BigDecimal tax, Instant filledAt) {
    }

    /** {@link #recordOutcome}의 결과. */
    public enum OutcomeWrite {
        /** 썼음. */
        WRITTEN,
        /** 행이 없거나 이미 결과가 정해져 바꾸지 않음(SENDING·UNKNOWN이 아님, 또는 UNKNOWN을 NOT_SENT로 내리려 함). */
        STALE,
        /** 그 토스 주문 번호가 이미 다른 행에 묶여 있음(대조가 같은 주문을 둘에 묶지 않게). */
        TOSS_ID_IN_USE
    }

    /** 이벤트 하나. {@code notifies}는 알림 대상인가(DB {@code notify} 칸 — {@code Object.notify}와 이름이 겹쳐 레코드 칸 이름만 다름). */
    public record Event(long id, String market, Instant at, String kind, Long userId, JsonNode detail, boolean notifies,
                        Instant notifiedAt) {
    }

    /** 시가 맞추기 묶음 하나. {@code targets}는 종목 → 비중(%). */
    public record Batch(long id, String market, LocalDate session, String kind, String sourceBook, JsonNode targets,
                        List<Long> absorbedOrderIds, BigDecimal equity, Instant createdAt, Instant updatedAt) {

        public Batch {
            absorbedOrderIds = List.copyOf(absorbedOrderIds);
        }
    }

    private static final String CONFIG_COLUMNS = "market, state, source_book, book_generation, loss_limit_pct, baseline_equity, "
            + "baseline_total, buys_paused, sync_pending, halt_reason, halt_detail, version, updated_at, updated_by";
    private static final String ORDER_COLUMNS = "id, market, session, purpose, batch_id, source_book, book_generation, "
            + "paper_order_id, paper_root_order_id, symbol, side, quantity, time_in_force, ref_price, attempt, client_order_id, "
            + "request_body, send_outcome, outcome_code, toss_order_id, broker_status, terminal, filled_quantity, "
            + "average_filled_price, filled_amount, commission, tax, filled_at, first_sent_at, last_sent_at, send_count, "
            + "cancel_requested_at, cancel_outcome, cancel_count, cancel_last_at, cancel_gave_up_at, created_at, updated_at";
    private static final String EVENT_COLUMNS = "id, market, at, kind, user_id, detail, notify, notified_at";
    private static final String BATCH_COLUMNS = "id, market, session, kind, source_book, targets, absorbed_order_ids, equity, "
            + "created_at, updated_at";
    /** 비밀번호 확인을 지난 사람의 일 — 그 뒤의 비밀번호 실패만 '연속'으로 셉니다. */
    private static final List<String> PASSWORD_SUCCESS_KINDS = List.of(EVENT_ENABLE, EVENT_UPDATE, EVENT_RESUME);

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final SchemaCheck schema;
    /** 같은 DataSource의 트랜잭션 — 안에서 부르는 이 저장소의 문장이 같은 연결에 합류합니다. */
    private final TransactionTemplate transactions;

    public RealTradeStore(JdbcTemplate jdbc, ObjectMapper mapper, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.schema = schema;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    /** 표가 있는가. 수집기가 아직 V24를 적용하지 않았으면 false입니다(그때 실제 매매는 '준비 중'). */
    public boolean ready() {
        return schema.tableExists("real_trade_config") && schema.tableExists("real_trade_events")
                && schema.tableExists("real_trade_batches") && schema.tableExists("real_trade_orders");
    }

    /**
     * 쓰기 여러 개를 한 트랜잭션으로 — 안에서 예외가 나면 모두 되돌리고 그 예외를 그대로 던집니다. 이미 트랜잭션 안이면 거기에 합류합니다.
     * 안에서 DB 오류를 잡고 계속 쓰면 안 됩니다(PostgreSQL은 오류가 난 트랜잭션의 나머지 문장을 거절함).
     */
    public <T> T atomically(Supplier<T> work) {
        return transactions.execute(status -> work.get());
    }

    // ------------------------------------------------------------------ 설정
    /** 그 시장 설정 행 — 없으면 empty(꺼짐으로 보려면 {@link #configOrOff}). */
    public Optional<Config> config(String market) {
        return jdbc.query("SELECT " + CONFIG_COLUMNS + " FROM real_trade_config WHERE market = ?", configMapper(), market)
                .stream().findFirst();
    }

    /** 그 시장 설정 행, 없으면 꺼짐 기본값({@link Config#off}). */
    public Config configOrOff(String market) {
        return config(market).orElseGet(() -> Config.off(market));
    }

    /**
     * 그 시장 설정 행을 잡고({@code SELECT … FOR UPDATE}) 받은 일을 한 트랜잭션에서 돌립니다(클래스 설명의 잠금). 행이 없으면 꺼짐 행을 먼저 만듭니다.
     * 일은 잡은 순간의 행을 받고, 안에서 이 저장소의 쓰기를 부르면 같은 트랜잭션에 합류합니다. 일이 예외를 던지면 그 안의 쓰기가 모두 되돌려지고
     * 예외가 그대로 나갑니다. 같은 시장을 잡으려는 다른 트랜잭션은 이 트랜잭션이 끝날 때까지 기다립니다 — 일 안에서 네트워크(토스·수집기) 호출을
     * 하지 마세요.
     */
    public <T> T lockConfig(String market, Function<Config, T> work) {
        Objects.requireNonNull(work, "work");
        return transactions.execute(status -> {
            jdbc.update("INSERT INTO real_trade_config (market, state) VALUES (?, 'OFF') ON CONFLICT (market) DO NOTHING", market);
            Config current = jdbc.queryForObject("SELECT " + CONFIG_COLUMNS + " FROM real_trade_config WHERE market = ? FOR UPDATE",
                    configMapper(), market);
            return work.apply(current);
        });
    }

    /**
     * 설정 행을 바꿉니다 — 지금 버전이 {@code next.version()}(읽은 값)과 같을 때만. 바꾸면 버전이 1 늘고 {@code updated_at}·{@code updated_by}가 바뀝니다.
     * 행이 없으면(한 번도 잠그지 않은 시장) 바꾸지 않습니다 — {@link #lockConfig} 안에서 부르세요.
     *
     * @param userId 바꾼 운영자(정기 작업이면 null)
     * @return 바꿨으면 true, 버전이 달라(그사이 다른 쓰기) 바꾸지 않았으면 false
     */
    public boolean updateConfig(Config next, Long userId) {
        Objects.requireNonNull(next, "next");
        return jdbc.update("UPDATE real_trade_config SET state = ?, source_book = ?, book_generation = ?, loss_limit_pct = ?, "
                        + "baseline_equity = ?, baseline_total = ?, buys_paused = ?, sync_pending = ?, halt_reason = ?, halt_detail = ?::jsonb, "
                        + "version = version + 1, updated_at = now(), updated_by = ? WHERE market = ? AND version = ?",
                ps -> {
                    ps.setString(1, next.state());
                    ps.setString(2, next.sourceBook());
                    ps.setString(3, next.bookGeneration());
                    ps.setBigDecimal(4, next.lossLimitPct());
                    ps.setBigDecimal(5, next.baselineEquity());
                    ps.setBigDecimal(6, next.baselineTotal());
                    ps.setBoolean(7, next.buysPaused());
                    ps.setBoolean(8, next.syncPending());
                    ps.setString(9, next.haltReason());
                    ps.setString(10, next.haltDetail() == null ? null : mapper.writeValueAsString(next.haltDetail()));
                    setLong(ps, 11, userId);
                    ps.setString(12, next.market());
                    ps.setInt(13, next.version());
                }) == 1;
    }

    // ------------------------------------------------------------------ 주문
    /**
     * SENDING 행을 씁니다(보내기 전에 — 명세 §4). 같은 키가 이미 있으면(모의 주문 뿌리·용도·시도, 묶음의 종목·용도·시도, {@code client_order_id} 중
     * 하나라도) 쓰지 않고 empty — 예외가 아니므로 {@link #lockConfig} 트랜잭션이 그대로 이어집니다(클래스 설명). DB CHECK(용도별 키·시도 1·2·수량 &gt; 0·
     * 한국 종목 코드 모양 등)에 걸리면 예외를 던집니다 — 부르는 쪽 오류이므로 잡지 말고 내보냅니다.
     *
     * @return 새 행 번호, 같은 키가 이미 있으면 empty
     */
    public Optional<Long> insertSending(NewOrder order) {
        Objects.requireNonNull(order, "order");
        List<Long> ids = jdbc.query("INSERT INTO real_trade_orders (market, session, purpose, batch_id, source_book, book_generation, "
                        + "paper_order_id, paper_root_order_id, symbol, side, quantity, time_in_force, ref_price, attempt, "
                        + "client_order_id, request_body, send_outcome, first_sent_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'SENDING', ?) ON CONFLICT DO NOTHING RETURNING id",
                ps -> {
                    ps.setString(1, order.market());
                    ps.setDate(2, Date.valueOf(order.session()));
                    ps.setString(3, order.purpose());
                    setLong(ps, 4, order.batchId());
                    ps.setString(5, order.sourceBook());
                    ps.setString(6, order.bookGeneration());
                    setLong(ps, 7, order.paperOrderId());
                    setLong(ps, 8, order.paperRootOrderId());
                    ps.setString(9, order.symbol());
                    ps.setString(10, order.side());
                    ps.setInt(11, order.quantity());
                    ps.setString(12, order.timeInForce());
                    ps.setBigDecimal(13, order.refPrice());
                    ps.setInt(14, order.attempt());
                    ps.setString(15, order.clientOrderId());
                    ps.setString(16, order.requestBody());
                    ps.setTimestamp(17, Timestamp.from(order.firstSentAt()));
                },
                (rs, rowNum) -> rs.getLong(1));
        return ids.stream().findFirst();
    }

    /** 수집기로 보낸 한 번(첫 전송·재전송)을 셉니다 — {@code send_count} + 1, {@code last_sent_at}. */
    public void recordSend(long id, Instant at) {
        jdbc.update("UPDATE real_trade_orders SET send_count = send_count + 1, last_sent_at = ?, updated_at = now() WHERE id = ?",
                Timestamp.from(at), id);
    }

    /**
     * 전송 결과를 씁니다(명세 §4의 분류). 결과가 아직 정해지지 않은 행(SENDING)과 모르는 행(UNKNOWN — 같은 키 재전송·대조로 정해짐)만 바꿉니다.
     * REJECTED·NOT_SENT는 '주문이 생기지 않음이 확실'이라 그 행을 종료({@code terminal})로 둡니다. <b>UNKNOWN은 NOT_SENT로 내리지 않습니다</b> — 재전송이
     * 네트워크로 나가지 않았다고 첫 전송이 주문을 만들지 않았다는 뜻은 아니기 때문입니다(그런 경우 STALE). ACCEPTED는 토스 주문 번호가 있어야 하고,
     * 그 번호가 이미 다른 행에 묶여 있으면 쓰지 않습니다(TOSS_ID_IN_USE). 동시에 같은 번호를 두 행에 묶으려 하면 DB 유일 색인이 예외를 던집니다.
     *
     * @param outcome     ACCEPTED·REJECTED·UNKNOWN·NOT_SENT
     * @param code        사유 코드(없으면 null)
     * @param tossOrderId 토스 주문 번호(ACCEPTED면 필수, 그 밖은 null이면 기존 값 유지)
     * @throws IllegalArgumentException SENDING·모르는 결과, 번호 없는 ACCEPTED
     */
    public OutcomeWrite recordOutcome(long id, String outcome, String code, String tossOrderId) {
        if (!List.of(OUTCOME_ACCEPTED, OUTCOME_REJECTED, OUTCOME_UNKNOWN, OUTCOME_NOT_SENT).contains(outcome)) {
            throw new IllegalArgumentException("전송 결과는 ACCEPTED·REJECTED·UNKNOWN·NOT_SENT 중 하나여야 합니다: " + outcome);
        }
        if (OUTCOME_ACCEPTED.equals(outcome) && (tossOrderId == null || tossOrderId.isBlank())) {
            throw new IllegalArgumentException("ACCEPTED에는 토스 주문 번호가 있어야 합니다");
        }
        boolean terminal = OUTCOME_REJECTED.equals(outcome) || OUTCOME_NOT_SENT.equals(outcome);
        int rows = jdbc.update("UPDATE real_trade_orders SET send_outcome = ?, outcome_code = ?, "
                        + "toss_order_id = COALESCE(?, toss_order_id), terminal = terminal OR ?, updated_at = now() "
                        + "WHERE id = ? AND (send_outcome = 'SENDING' OR (send_outcome = 'UNKNOWN' AND ? <> 'NOT_SENT')) "
                        + "AND (?::text IS NULL OR NOT EXISTS (SELECT 1 FROM real_trade_orders o WHERE o.toss_order_id = ? AND o.id <> ?))",
                ps -> {
                    ps.setString(1, outcome);
                    ps.setString(2, code);
                    ps.setString(3, tossOrderId);
                    ps.setBoolean(4, terminal);
                    ps.setLong(5, id);
                    ps.setString(6, outcome);
                    ps.setString(7, tossOrderId);
                    ps.setString(8, tossOrderId);
                    ps.setLong(9, id);
                });
        if (rows == 1) {
            return OutcomeWrite.WRITTEN;
        }
        if (tossOrderId != null) {
            Integer bound = jdbc.queryForObject("SELECT COUNT(*) FROM real_trade_orders WHERE toss_order_id = ? AND id <> ?",
                    Integer.class, tossOrderId, id);
            if (bound != null && bound > 0) {
                return OutcomeWrite.TOSS_ID_IN_USE;
            }
        }
        return OutcomeWrite.STALE;
    }

    /**
     * 상태 추적 결과를 씁니다(토스 주문 번호가 있는 행만). 종료 표시는 되돌리지 않습니다(한 번 종료면 계속 종료).
     *
     * @return 썼으면 true(행이 없거나 토스 주문 번호가 없으면 false)
     */
    public boolean recordTracking(long id, Tracking tracking) {
        Objects.requireNonNull(tracking, "tracking");
        return jdbc.update("UPDATE real_trade_orders SET broker_status = ?, terminal = terminal OR ?, filled_quantity = ?, "
                        + "average_filled_price = ?, filled_amount = ?, commission = ?, tax = ?, filled_at = ?, updated_at = now() "
                        + "WHERE id = ? AND toss_order_id IS NOT NULL",
                ps -> {
                    ps.setString(1, tracking.brokerStatus());
                    ps.setBoolean(2, tracking.terminal());
                    ps.setBigDecimal(3, tracking.filledQuantity());
                    ps.setBigDecimal(4, tracking.averageFilledPrice());
                    ps.setBigDecimal(5, tracking.filledAmount());
                    ps.setBigDecimal(6, tracking.commission());
                    ps.setBigDecimal(7, tracking.tax());
                    setInstant(ps, 8, tracking.filledAt());
                    ps.setLong(9, id);
                }) == 1;
    }

    /**
     * 취소 요청과 그 결과를 씁니다 — 보낸 횟수 + 1, 마지막으로 보낸 시각. 처음 요청한 시각은 덮지 않습니다.
     *
     * @param cancelOutcome 취소 결과(수집기 outcome·사유 코드 등 — 부르는 쪽이 정한 글)
     */
    public void recordCancel(long id, Instant requestedAt, String cancelOutcome) {
        jdbc.update("UPDATE real_trade_orders SET cancel_requested_at = COALESCE(cancel_requested_at, ?), cancel_outcome = ?, "
                + "cancel_count = cancel_count + 1, cancel_last_at = ?, updated_at = now() WHERE id = ?",
                Timestamp.from(requestedAt), cancelOutcome, Timestamp.from(requestedAt), id);
    }

    /**
     * 취소를 상한까지 보내도 원 주문이 살아 있는 행에 포기 시각을 씁니다(아직 쓰지 않은 미종료 행만 — 알림을 한 번만 하게).
     *
     * @return 이번에 쓴 행 수
     */
    public int markCancelGaveUp(List<Long> ids, Instant at) {
        if (ids == null || ids.isEmpty()) {
            return 0;
        }
        Long[] array = ids.toArray(new Long[0]);
        return jdbc.update("UPDATE real_trade_orders SET cancel_gave_up_at = ?, updated_at = now() "
                        + "WHERE id = ANY(?) AND cancel_gave_up_at IS NULL AND NOT terminal",
                ps -> {
                    ps.setTimestamp(1, Timestamp.from(at));
                    ps.setArray(2, ps.getConnection().createArrayOf("bigint", array));
                });
    }

    public Optional<OrderRow> order(long id) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM real_trade_orders WHERE id = ?", orderMapper(), id).stream().findFirst();
    }

    /** 그 시장의 종료가 확인 안 된 행(SENDING·UNKNOWN·접수 뒤 추적 중), 번호 순. */
    public List<OrderRow> unfinishedOrders(String market) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM real_trade_orders WHERE market = ? AND NOT terminal ORDER BY id",
                orderMapper(), market);
    }

    /** 그 시장 그 거래일의 행, 번호 순. */
    public List<OrderRow> ordersOn(String market, LocalDate session) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM real_trade_orders WHERE market = ? AND session = ? ORDER BY id",
                orderMapper(), market, Date.valueOf(session));
    }

    /** 그 시장의 최근 행 {@code limit}개, 최근 것부터. */
    public List<OrderRow> recentOrders(String market, int limit) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM real_trade_orders WHERE market = ? ORDER BY id DESC LIMIT ?",
                orderMapper(), market, limit);
    }

    /**
     * {@code since}(DB 시각) 이후에 종료가 된 그 시장 행, 번호 순 — 끄기 정리 결과(취소로 끝남·체결로 끝남)를 셀 때. 종료된 행은 더 바꾸지 않으므로
     * {@code updated_at}이 종료된 때입니다.
     */
    public List<OrderRow> endedSince(String market, Instant since) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM real_trade_orders WHERE market = ? AND terminal AND updated_at >= ? ORDER BY id",
                orderMapper(), market, Timestamp.from(since));
    }

    /** 그 모의 주문 뿌리의 행(모든 용도·시도), 번호 순 — 같은 뿌리는 한 번만 따라 함(명세 §3.2). */
    public List<OrderRow> ordersForRoot(String market, long paperRootOrderId) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM real_trade_orders WHERE market = ? AND paper_root_order_id = ? ORDER BY id",
                orderMapper(), market, paperRootOrderId);
    }

    /** 그 묶음의 행(시가 맞추기·마무리), 번호 순. */
    public List<OrderRow> ordersForBatch(long batchId) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM real_trade_orders WHERE batch_id = ? ORDER BY id", orderMapper(), batchId);
    }

    /** 그 시장 행에 묶인 토스 주문 번호 전부 — 대조가 '다른 행에 묶이지 않은 후보'를 고를 때(명세 §4). 값은 응답·로그에 싣지 마세요. */
    public Set<String> boundTossOrderIds(String market) {
        return new HashSet<>(jdbc.queryForList("SELECT toss_order_id FROM real_trade_orders WHERE market = ? AND toss_order_id IS NOT NULL",
                String.class, market));
    }

    // ------------------------------------------------------------------ 묶음
    /**
     * 그 시장·거래일·종류의 묶음을 넣거나, 이미 있으면 따라 하는 책·목표·흡수 번호·평가액을 이 값으로 바꿉니다(번호는 그대로).
     *
     * @param targets 종목 → 비중(%) JSON(null이면 빈 객체)
     */
    public Batch upsertBatch(String market, LocalDate session, String kind, String sourceBook, JsonNode targets,
                             List<Long> absorbedOrderIds, BigDecimal equity) {
        Long[] absorbed = (absorbedOrderIds == null ? List.<Long>of() : absorbedOrderIds).toArray(new Long[0]);
        return jdbc.query("INSERT INTO real_trade_batches (market, session, kind, source_book, targets, absorbed_order_ids, equity) "
                        + "VALUES (?, ?, ?, ?, ?::jsonb, ?, ?) ON CONFLICT (market, session, kind) DO UPDATE SET "
                        + "source_book = EXCLUDED.source_book, targets = EXCLUDED.targets, "
                        + "absorbed_order_ids = EXCLUDED.absorbed_order_ids, equity = EXCLUDED.equity, updated_at = now() "
                        + "RETURNING " + BATCH_COLUMNS,
                ps -> {
                    ps.setString(1, market);
                    ps.setDate(2, Date.valueOf(session));
                    ps.setString(3, kind);
                    ps.setString(4, sourceBook);
                    ps.setString(5, targets == null ? "{}" : mapper.writeValueAsString(targets));
                    ps.setArray(6, ps.getConnection().createArrayOf("bigint", absorbed));
                    ps.setBigDecimal(7, equity);
                },
                batchMapper()).getFirst();
    }

    public Optional<Batch> batch(String market, LocalDate session, String kind) {
        return jdbc.query("SELECT " + BATCH_COLUMNS + " FROM real_trade_batches WHERE market = ? AND session = ? AND kind = ?",
                batchMapper(), market, Date.valueOf(session), kind).stream().findFirst();
    }

    public Optional<Batch> batch(long id) {
        return jdbc.query("SELECT " + BATCH_COLUMNS + " FROM real_trade_batches WHERE id = ?", batchMapper(), id).stream().findFirst();
    }

    /** 그 시장·종류에서 가장 최근에 만든 묶음(번호가 가장 큰 것) — 새 묶음을 만들기 전에 부르면 바로 앞 묶음입니다. */
    public Optional<Batch> latestBatch(String market, String kind) {
        return jdbc.query("SELECT " + BATCH_COLUMNS + " FROM real_trade_batches WHERE market = ? AND kind = ? ORDER BY id DESC LIMIT 1",
                batchMapper(), market, kind).stream().findFirst();
    }

    // ------------------------------------------------------------------ 이벤트
    /**
     * 이벤트를 남깁니다. {@code notify}면 알림 대기({@link #unnotifiedEvents})에 들어갑니다.
     *
     * @param userId 사람이 한 일이면 그 운영자(정기 작업이면 null)
     * @param detail 사유 코드·건수(null이면 빈 객체)
     * @return 새 이벤트 번호
     */
    public long addEvent(String market, String kind, Long userId, JsonNode detail, boolean notify) {
        return jdbc.query("INSERT INTO real_trade_events (market, kind, user_id, detail, notify) VALUES (?, ?, ?, ?::jsonb, ?) "
                        + "RETURNING id",
                ps -> {
                    ps.setString(1, market);
                    ps.setString(2, kind);
                    setLong(ps, 3, userId);
                    ps.setString(4, detail == null ? "{}" : mapper.writeValueAsString(detail));
                    ps.setBoolean(5, notify);
                },
                (rs, rowNum) -> rs.getLong(1)).getFirst();
    }

    /** {@link #addEvent(String, String, Long, JsonNode, boolean)}에 맵으로 — 값은 JSON으로 옮깁니다. */
    public long addEvent(String market, String kind, Long userId, Map<String, ?> detail, boolean notify) {
        return addEvent(market, kind, userId, detail == null ? null : (JsonNode) mapper.valueToTree(detail), notify);
    }

    /** 알림을 아직 보내지 못한 이벤트(알림 대상만), 번호 순 {@code limit}개 — 보낼 때까지 다음 주기에 다시 나옵니다(명세 §7.4). */
    public List<Event> unnotifiedEvents(int limit) {
        return jdbc.query("SELECT " + EVENT_COLUMNS + " FROM real_trade_events WHERE notify AND notified_at IS NULL ORDER BY id LIMIT ?",
                eventMapper(), limit);
    }

    /**
     * 알림을 보냈다고 표시합니다(처음 한 번만).
     *
     * @return 이번에 표시했으면 true
     */
    public boolean markNotified(long id, Instant at) {
        return jdbc.update("UPDATE real_trade_events SET notified_at = ? WHERE id = ? AND notified_at IS NULL", Timestamp.from(at), id) == 1;
    }

    /** 그 시장 그 종류의 이벤트 가운데 {@code since}(DB 시각) 뒤의 것, 번호 순. */
    public List<Event> eventsSince(String market, String kind, Instant since) {
        return jdbc.query("SELECT " + EVENT_COLUMNS + " FROM real_trade_events WHERE market = ? AND kind = ? AND at >= ? ORDER BY id",
                eventMapper(), market, kind, Timestamp.from(since));
    }

    /** 그 시장의 최근 이벤트 {@code limit}개, 최근 것부터. */
    public List<Event> recentEvents(String market, int limit) {
        return jdbc.query("SELECT " + EVENT_COLUMNS + " FROM real_trade_events WHERE market = ? ORDER BY id DESC LIMIT ?",
                eventMapper(), market, limit);
    }

    /**
     * 연속 비밀번호 실패의 시각들, 최근 것부터 — {@code since} 뒤이고 마지막 성공(비밀번호를 지난 켜기·바꾸기·해제 — {@value #EVENT_ENABLE}·
     * {@value #EVENT_UPDATE}·{@value #EVENT_RESUME} 이벤트, 시장 무관 — 비밀번호는 하나) 뒤의 {@value #EVENT_PASSWORD_FAILED} 이벤트. 잠금(연속 5회면
     * 30분 — 명세 §7.1)은 부르는 쪽이 이 목록으로 판정합니다.
     */
    public List<Instant> passwordFailuresSinceLastSuccess(Instant since) {
        String[] success = PASSWORD_SUCCESS_KINDS.toArray(new String[0]);
        return jdbc.query("SELECT at FROM real_trade_events WHERE kind = ? AND at > ? AND at > COALESCE("
                        + "(SELECT max(at) FROM real_trade_events WHERE kind = ANY(?)), '-infinity'::timestamptz) ORDER BY at DESC, id DESC",
                ps -> {
                    ps.setString(1, EVENT_PASSWORD_FAILED);
                    ps.setTimestamp(2, Timestamp.from(since));
                    ps.setArray(3, ps.getConnection().createArrayOf("text", success));
                },
                (rs, rowNum) -> rs.getTimestamp("at").toInstant());
    }

    // ------------------------------------------------------------------ 매핑
    private RowMapper<Config> configMapper() {
        return (rs, rowNum) -> new Config(rs.getString("market"), rs.getString("state"), rs.getString("source_book"),
                rs.getString("book_generation"), rs.getBigDecimal("loss_limit_pct"), rs.getBigDecimal("baseline_equity"),
                rs.getBigDecimal("baseline_total"), rs.getBoolean("buys_paused"), rs.getBoolean("sync_pending"), rs.getString("halt_reason"), json(rs, "halt_detail"),
                rs.getInt("version"), instant(rs, "updated_at"), rs.getObject("updated_by", Long.class));
    }

    private static RowMapper<OrderRow> orderMapper() {
        return (rs, rowNum) -> new OrderRow(rs.getLong("id"), rs.getString("market"), rs.getDate("session").toLocalDate(),
                rs.getString("purpose"), rs.getObject("batch_id", Long.class), rs.getString("source_book"),
                rs.getString("book_generation"), rs.getObject("paper_order_id", Long.class),
                rs.getObject("paper_root_order_id", Long.class), rs.getString("symbol"), rs.getString("side"),
                rs.getInt("quantity"), rs.getString("time_in_force"), rs.getBigDecimal("ref_price"), rs.getInt("attempt"),
                rs.getString("client_order_id"), rs.getString("request_body"), rs.getString("send_outcome"),
                rs.getString("outcome_code"), rs.getString("toss_order_id"), rs.getString("broker_status"),
                rs.getBoolean("terminal"), rs.getBigDecimal("filled_quantity"), rs.getBigDecimal("average_filled_price"),
                rs.getBigDecimal("filled_amount"), rs.getBigDecimal("commission"), rs.getBigDecimal("tax"),
                instant(rs, "filled_at"), instant(rs, "first_sent_at"), instant(rs, "last_sent_at"), rs.getInt("send_count"),
                instant(rs, "cancel_requested_at"), rs.getString("cancel_outcome"), rs.getInt("cancel_count"),
                instant(rs, "cancel_last_at"), instant(rs, "cancel_gave_up_at"), instant(rs, "created_at"), instant(rs, "updated_at"));
    }

    private RowMapper<Event> eventMapper() {
        return (rs, rowNum) -> new Event(rs.getLong("id"), rs.getString("market"), instant(rs, "at"), rs.getString("kind"),
                rs.getObject("user_id", Long.class), json(rs, "detail"), rs.getBoolean("notify"), instant(rs, "notified_at"));
    }

    private RowMapper<Batch> batchMapper() {
        return (rs, rowNum) -> {
            List<Long> absorbed = new ArrayList<>();
            Array array = rs.getArray("absorbed_order_ids");
            if (array != null) {
                for (Object value : (Object[]) array.getArray()) {
                    absorbed.add(((Number) value).longValue());
                }
            }
            return new Batch(rs.getLong("id"), rs.getString("market"), rs.getDate("session").toLocalDate(), rs.getString("kind"),
                    rs.getString("source_book"), json(rs, "targets"), absorbed, rs.getBigDecimal("equity"),
                    instant(rs, "created_at"), instant(rs, "updated_at"));
        };
    }

    private JsonNode json(ResultSet rs, String column) throws SQLException {
        String raw = rs.getString(column);
        return raw == null ? null : mapper.readTree(raw);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp timestamp = rs.getTimestamp(column);
        return timestamp == null ? null : timestamp.toInstant();
    }

    private static void setInstant(PreparedStatement ps, int index, Instant value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.TIMESTAMP_WITH_TIMEZONE);
        } else {
            ps.setTimestamp(index, Timestamp.from(value));
        }
    }

    private static void setLong(PreparedStatement ps, int index, Long value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.BIGINT);
        } else {
            ps.setLong(index, value);
        }
    }
}
