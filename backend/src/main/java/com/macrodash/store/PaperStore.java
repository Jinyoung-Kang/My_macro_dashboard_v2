package com.macrodash.store;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.sql.Date;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.function.Supplier;

/**
 * 모의 알고리즘 매매 장부({@code paper_*}, V8) — 백엔드가 쓰는 테이블(ADR 0008). 이 테이블들의 JDBC는 <b>전부 여기</b>에
 * 있고, 기능 계층(feature/paper)은 이 저장소만 부릅니다.
 *
 * <p>값의 모양: 돈·가격·비율은 {@code double}(DB는 NUMERIC — 금액은 소수 4자리로 반올림돼 저장됨), 시각은 {@link Instant},
 * 거래일은 {@link LocalDate}(미국 동부 세션 날짜), JSON 열은 {@link JsonNode}입니다. 비어 있을 수 있는 열은 래퍼 타입
 * ({@code Double}·{@code Integer}·{@code Long})이고 없으면 null입니다 — 0으로 채우지 않습니다. NaN·무한대인 금액은 저장하지
 * 않고 {@link IllegalArgumentException}을 던집니다(NUMERIC은 NaN을 받아 주므로, 계산 오류가 장부에 조용히 남지 않게).
 *
 * <p>여러 쓰기를 한 번에 반영해야 하는 곳(관측치 하나를 책 하나에 적용 등)은 {@link #atomically}로 감쌉니다.
 */
@Repository
public class PaperStore {

    /** 작업마다 남기는 최근 실행 기록 수. 5분 주기 작업이면 약 17시간 치입니다. */
    static final int JOB_RUNS_KEPT = 200;

    // ------------------------------------------------------------------ 레코드
    /**
     * 책. {@code kind}는 RULES·CLAUDE·BENCHMARK, {@code status}는 NOT_STARTED·ACTIVE·PAUSED. 시작 전이면 {@code startedOn}이 null.
     * {@code market}은 그 책이 거래하는 시장(US·KR), {@code currency}는 장부 통화(USD·KRW)입니다(V13, DB CHECK와 같은 문자열) —
     * 둘 다 비울 수 없습니다.
     */
    public record Book(String code, String kind, String label, double initialCash, LocalDate startedOn, String status,
                       Instant createdAt, String market, String currency) {

        public static final String MARKET_US = "US";
        public static final String MARKET_KR = "KR";
        public static final String CURRENCY_USD = "USD";
        public static final String CURRENCY_KRW = "KRW";

        public Book {
            if (market == null || currency == null) {
                throw new IllegalArgumentException("책의 시장·통화는 비울 수 없습니다: " + code);
            }
        }

        /** 미국·달러 책 — V13 전부터 있던 모양(V13 열 기본값과 같음). */
        public Book(String code, String kind, String label, double initialCash, LocalDate startedOn, String status,
                    Instant createdAt) {
            this(code, kind, label, initialCash, startedOn, status, createdAt, MARKET_US, CURRENCY_USD);
        }
    }

    /** 책의 현재 상태. {@code lastProcessedCollectedAt}은 관측치 처리의 멱등 키입니다(이 저장본까지 처리함). */
    public record BookState(String bookCode, double cash, double nav, double equityValue, double exposurePct,
                            Instant lastObservedAt, Instant lastProcessedCollectedAt, LocalDate lastNavTradingDate,
                            Instant updatedAt) {
    }

    /**
     * 보유 한 건. 가격을 아직 못 받았으면 {@code lastPrice}·{@code lastPriceAt}이 null입니다. {@code fillRefDate}·
     * {@code fillRefClose}는 분할 감지 기준(체결에 쓴 봉 날짜와 그날 종가)입니다.
     */
    public record Position(String bookCode, String ticker, int qty, double avgCost, LocalDate openedOn, Instant openedAt,
                           double highWatermark, Instant watermarkAt, Double lastPrice, Instant lastPriceAt,
                           boolean priceStale, LocalDate fillRefDate, double fillRefClose, String splitNote) {
    }

    /**
     * '미처리 기업행위' 표시가 걸린 보유 하나(한국 책, 명세 K32). 걸려 있는 동안 평가는 마지막 확정가로 묶이고 스탑·주문이 보류됩니다
     * (장부 연결은 C2).
     */
    public record CorpActionHold(String bookCode, String ticker, String reason) {
    }

    /**
     * 한국 장부가 그 관측치(수집 시각 {@code collectedAt})를 처리하며 그날 보류한 대기 주문의 표시({@code paper_orders.ledger_hold_reason}·
     * {@code ledger_hold_collected_at}, V16 — 2단계 명세 §4-9 'E0'). 결정 게이트 ①이 같은 관측치로 판정할 때 그 주문을 기다리지 않습니다.
     */
    public record LedgerHold(long orderId, String bookCode, String ticker, String reason, Instant collectedAt) {
    }

    /** 재진입 금지. {@code untilTradingDate}까지(포함) 다시 사지 않습니다. */
    public record Lockout(String bookCode, String ticker, LocalDate untilTradingDate, String reason) {
    }

    /**
     * 주문. 수량({@code qty})·목표 비중({@code targetWeightPct})·매도 비율({@code sellFraction})은 주문 종류에 따라 하나만
     * 차 있고 나머지는 null입니다. {@code reason}은 근거 JSON(넣을 때 null이면 {@code {}}).
     */
    public record Order(long id, String bookCode, Long decisionId, String ticker, String side, Integer qty,
                        Double targetWeightPct, Double sellFraction, String timing, String source, String status,
                        String rejectReason, JsonNode reason, LocalDate asOfTradingDate, Instant createdAt,
                        LocalDate expiresOn, Instant filledAt) {
    }

    /**
     * 체결. 주문당 하나입니다({@code order_id} 유일). {@code price}는 체결가(미국: 관측가에 슬리피지를 얹은 값, 한국: 관측가 그대로 —
     * 2단계 K31), {@code rawPrice}는 관측치 그대로입니다. 비용 칸(V14) {@code fee}·{@code tax}·{@code slippageCost}는 한국 체결의 수수료·
     * 세금(증권거래세 + 농어촌특별세)·슬리피지 금액이고 미국은 0입니다(미국 슬리피지는 체결가에 들어 있음). 비용 칸은 DB 열과 같은
     * 소수 4자리로 맞춰 둡니다(읽은 값과 만든 값이 같은 레코드가 되게) — 0 미만이거나 소수 4자리를 넘으면 받지 않습니다.
     * 비용 칸을 받지 않는 생성자는 셋 다 0입니다(미국·사후 체결·시험).
     */
    public record Fill(long id, long orderId, String bookCode, String ticker, String side, int qty, double price,
                       double rawPrice, double slippageBp, double gross, Instant observedAt, LocalDate observationDate,
                       String priceSource, boolean backfill, Instant createdAt, BigDecimal fee, BigDecimal tax,
                       BigDecimal slippageCost) {

        /** 비용 칸의 소수 자릿수 — {@code paper_fills.fee}·{@code tax}·{@code slippage_cost} NUMERIC(18,4). */
        public static final int COST_SCALE = 4;

        public Fill {
            fee = cost(fee, "fee");
            tax = cost(tax, "tax");
            slippageCost = cost(slippageCost, "slippage_cost");
        }

        /** 비용 칸이 없는 체결(셋 다 0) — 미국 체결·사후 체결의 모양. */
        public Fill(long id, long orderId, String bookCode, String ticker, String side, int qty, double price,
                    double rawPrice, double slippageBp, double gross, Instant observedAt, LocalDate observationDate,
                    String priceSource, boolean backfill, Instant createdAt) {
            this(id, orderId, bookCode, ticker, side, qty, price, rawPrice, slippageBp, gross, observedAt,
                    observationDate, priceSource, backfill, createdAt, BigDecimal.ZERO, BigDecimal.ZERO, BigDecimal.ZERO);
        }

        private static BigDecimal cost(BigDecimal value, String column) {
            if (value == null) {
                throw new IllegalArgumentException(column + " 값이 없습니다(비용이 없으면 0)");
            }
            if (value.signum() < 0) {
                throw new IllegalArgumentException(column + "은(는) 음수일 수 없습니다(DB CHECK ≥ 0): " + value);
            }
            try {
                return value.setScale(COST_SCALE, java.math.RoundingMode.UNNECESSARY);
            } catch (ArithmeticException e) {
                throw new IllegalArgumentException(column + "은(는) 소수 " + COST_SCALE + "자리까지입니다: " + value);
            }
        }
    }

    /**
     * 확정 조정 한 행({@code paper_fill_confirmations}, V14 — 2단계 명세 K29). 한국 체결마다 금융위 확정가가 들어오면 한 번 씁니다(추가만 —
     * 체결 행은 그대로). {@code fee}·{@code tax}·{@code slippageCost}는 확정가로 다시 계산한 비용 칸, {@code cashDelta}는 확정 기준 현금 흐름 −
     * 잠정 기준 현금 흐름(음수 가능)이고, 장부가 같은 트랜잭션에서 계좌 현금에 더합니다. 금액은 DB 열과 같은 자리(가격 6, 금액 4)로 맞춰
     * 둡니다(읽은 값과 만든 값이 같은 레코드가 되게) — 비용 음수·출처가 금융위 둘이 아님·자리 넘침은 받지 않습니다(DB CHECK와 같은 규칙).
     *
     * @param source       {@link #SOURCE_FSC}(주식시세) · {@link #SOURCE_FSC_ETF}(증권상품시세)
     * @param reconciledAt 쓴 시각 — 넣을 때 null이면 DB의 now()
     */
    public record FillConfirmation(long fillId, String bookCode, BigDecimal confirmedPrice, BigDecimal fee,
                                   BigDecimal tax, BigDecimal slippageCost, BigDecimal cashDelta, String source,
                                   Instant reconciledAt) {

        public static final String SOURCE_FSC = "FSC";
        public static final String SOURCE_FSC_ETF = "FSC_ETF";
        /** 확정가 열({@code confirmed_price} NUMERIC(18,6))의 소수 자릿수. */
        public static final int PRICE_SCALE = 6;

        public FillConfirmation {
            if (bookCode == null || bookCode.isBlank()) {
                throw new IllegalArgumentException("확정 조정의 책이 없습니다");
            }
            if (!SOURCE_FSC.equals(source) && !SOURCE_FSC_ETF.equals(source)) {
                throw new IllegalArgumentException("확정 출처는 FSC·FSC_ETF만입니다(DB CHECK): " + source);
            }
            if (confirmedPrice == null || confirmedPrice.signum() <= 0) {
                throw new IllegalArgumentException("확정가는 0보다 커야 합니다: " + confirmedPrice);
            }
            confirmedPrice = scaled(confirmedPrice, PRICE_SCALE, "confirmed_price");
            fee = Fill.cost(fee, "fee");
            tax = Fill.cost(tax, "tax");
            slippageCost = Fill.cost(slippageCost, "slippage_cost");
            if (cashDelta == null) {
                throw new IllegalArgumentException("cash_delta 값이 없습니다(차이가 없으면 0)");
            }
            cashDelta = scaled(cashDelta, Fill.COST_SCALE, "cash_delta");
        }

        private static BigDecimal scaled(BigDecimal value, int scale, String column) {
            try {
                return value.setScale(scale, java.math.RoundingMode.UNNECESSARY);
            } catch (ArithmeticException e) {
                throw new IllegalArgumentException(column + "은(는) 소수 " + scale + "자리까지입니다: " + value);
            }
        }
    }

    /**
     * 아직 확정 조정 행이 없는 체결과 그 주문의 체결 시점({@code paper_orders.timing}) — 확정가가 시가({@code NEXT_OPEN} → 금융위
     * {@code mkp})인지 종가({@code NEXT_CLOSE} → {@code clpr})인지를 가릅니다.
     */
    public record UnconfirmedFill(Fill fill, String timing) {
    }

    /** 거래일별 순자산. {@code pricesFinal}이면 확정 종가로 평가한 값입니다. */
    public record NavRow(String bookCode, LocalDate tradingDate, double nav, double cash, double equityValue,
                         double exposurePct, boolean pricesFinal) {
    }

    /** 정기 작업 실행 기록. 끝나지 않았으면 {@code finishedAt}이 null. */
    public record JobRun(long id, String job, Instant startedAt, Instant finishedAt, String outcome, JsonNode detail) {
    }

    /** 설정 한 행과 그 버전. */
    public record SettingsRow(int version, JsonNode body, Instant updatedAt) {
    }

    /** 설정 변경 이력 한 줄({@code paper_settings_history}). 처음 값(버전 1)은 {@code changedKeys}가 비어 있습니다. */
    public record SettingsHistoryRow(int version, JsonNode body, List<String> changedKeys, Instant createdAt) {
        public SettingsHistoryRow {
            changedKeys = changedKeys == null ? List.of() : List.copyOf(changedKeys);
        }
    }

    /**
     * 하루(KST 달력)의 Claude 호출 사용량({@code paper_api_usage}, 명세 C8·D18). 호출 수는 성공·실패를 모두 세고, 토큰은 응답이 알려
     * 준 값만 더합니다(모르는 값은 더하지 않음 — 열이 NOT NULL이라 0을 더한 것과 같습니다).
     *
     * <p>{@code estCostUsd}·{@code estCostCalls}(V11)는 추정 비용과 그 추정에 든 호출 수입니다. 단가를 모르는 모델·토큰을 모르는
     * 호출·단가 도입 전 호출은 추정에서 빠지므로 {@code estCostCalls ≤ calls}이고, 추정한 호출이 하나도 없으면
     * {@code estCostUsd}는 null입니다(0달러로 채우지 않음).
     */
    public record ApiUsage(LocalDate day, int calls, long inputTokens, long outputTokens, long cacheReadTokens,
                           long cacheWriteTokens, Double estCostUsd, int estCostCalls) {

        /** 추정 비용 없이(V11 전 모양 — 시험·단계 3a 호출). */
        public ApiUsage(LocalDate day, int calls, long inputTokens, long outputTokens, long cacheReadTokens,
                        long cacheWriteTokens) {
            this(day, calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, null, 0);
        }
    }

    /**
     * 기간(양끝 포함)의 사용량 합계. {@code days}는 기록이 있는 날 수(호출이 없던 날은 행이 없음). {@code estCostUsd}는 추정한 날의
     * 합(추정이 하나도 없으면 null), {@code estCostCalls}는 추정에 든 호출 수 합.
     */
    public record ApiUsageTotal(LocalDate from, LocalDate to, int days, long calls, long inputTokens,
                                long outputTokens, long cacheReadTokens, long cacheWriteTokens, Double estCostUsd,
                                long estCostCalls) {

        /** 추정 비용 없이(V11 전 모양). */
        public ApiUsageTotal(LocalDate from, LocalDate to, int days, long calls, long inputTokens, long outputTokens,
                             long cacheReadTokens, long cacheWriteTokens) {
            this(from, to, days, calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, null, 0);
        }
    }

    /**
     * 투자 OS 프레임의 판 하나({@code paper_framework_versions}, 명세 F1~F5). {@code body}는 구조화한 프레임 JSON(원칙·엔진 8개·
     * 지침 — 모양은 {@code FrameworkService}가 검사), {@code rendered}는 그 판을 만들 때의 렌더링(화면용)과 그 토큰 어림입니다.
     * 판 번호는 0(임시)부터 올라가고 지금 판은 가장 큰 번호입니다. {@code createdAt}은 넣을 때 쓰지 않고 DB가 채웁니다.
     */
    public record FrameworkVersion(int version, JsonNode body, String rendered, int renderedTokensEst,
                                   String changelog, Long sourceProposalId, Instant createdAt) {
    }

    /** 판 목록의 한 줄 — 큰 열(본문·렌더링)은 읽지 않고 본문의 제목·상태만. */
    public record FrameworkVersionSummary(int version, String title, String status, String changelog,
                                          Long sourceProposalId, int renderedTokensEst, Instant createdAt) {
    }

    /**
     * 프레임 갱신 제안({@code paper_framework_proposals}, F2·F7). {@code status}는 PENDING·APPROVED·REJECTED·FAILED, 승인되면
     * {@code resultVersion}이 그 새 판. {@code response}는 형식 검사를 거친(또는 실패한 경우 받은 그대로 읽은) JSON, 읽지 못했으면
     * null이고 {@code responseRaw}는 모델이 보낸 원문입니다. {@code createdAt}은 넣을 때 쓰지 않습니다.
     */
    public record FrameworkProposal(long id, Long noteId, int baseVersion, String requestText, String model,
                                    JsonNode response, String responseRaw, String status, String error,
                                    Integer resultVersion, Instant createdAt, Instant decidedAt) {
    }

    /**
     * 메모 한 건({@code paper_notes}, F6·D14). {@code kind}는 MARKET(시황 — 만료가 있고 유효하면 패킷에 들어감)·INSIGHT(방법론 글 —
     * 만료 없음, 프레임 제안에만). 지우지 않고 {@code archived}로 내립니다. {@code createdAt}은 넣을 때 쓰지 않습니다.
     * {@code market}(V14)은 그 메모가 실리는 시장({@link Book#MARKET_US}·{@link Book#MARKET_KR}) — 목록·패킷은 그 시장 메모만
     * 읽습니다. 시장을 받지 않는 생성자는 미국입니다(V14 열 기본값).
     */
    public record Note(long id, String kind, LocalDate asOfDate, LocalDate expiresOn, String title, String body,
                       boolean archived, Instant createdAt, String market) {

        public Note {
            requireMarket(market, "메모");
        }

        /** 미국 메모 — V14 전부터 있던 모양. */
        public Note(long id, String kind, LocalDate asOfDate, LocalDate expiresOn, String title, String body,
                    boolean archived, Instant createdAt) {
            this(id, kind, asOfDate, expiresOn, title, body, archived, createdAt, Book.MARKET_US);
        }
    }

    /** 성과 화면의 프레임 경계(F5) — 그 판이 그 책의 결정에 처음 쓰인 거래일과 판의 상태(INTERIM·USER, 판이 없으면 null). */
    public record FrameworkBoundary(LocalDate tradingDate, int version, String status) {
    }

    /**
     * 얼려 둔 출발일 종가 한 건. {@code source}는 체결의 {@code price_source}와 같은 말(equity_close·paper.quotes)이고,
     * {@code capturedAt}은 넣을 때 null이면 DB가 지금으로 채웁니다.
     */
    public record StartPrice(String ticker, LocalDate tradingDate, double close, String source, Instant capturedAt) {
    }

    /**
     * 기준일 하나·기관 하나의 13F 트랙레코드(설계 §4-0 ④, {@code paper_track_record}). 수치는 {@code TrackRecord13F.Result}
     * 그대로(%는 ×100, 커버리지는 0~1 비율)이고 표본이 없으면 null입니다. {@code rank}는 자격 있는 기관만(1부터), 없으면 null.
     * {@code periods}는 구간 목록 JSON 배열(null이면 {@code []}), {@code computedAt}은 넣을 때 null이면 DB가 지금으로 채웁니다.
     *
     * <p>{@code groupCode}(V9, D27)는 어느 기관 그룹의 계산인가 — {@link #GROUP_A}(후보 27곳, 7년 창)·{@link #GROUP_B}(기존 13F
     * 메뉴 12곳, 2년 창). 두 그룹에 모두 있는 기관은 창이 달라 수치가 다르므로 같은 기준일에 행이 둘입니다. 그룹을 받지 않는
     * 생성자·메서드는 그룹 A입니다(단계 1b 호출 그대로). {@code dataSource}(V9)는 계산에 쓴 13F 저장본({@link #SOURCE_Q30}·
     * {@link #SOURCE_Q8}), 모르면 null(단계 1b 행).
     */
    public record TrackRecordRow(LocalDate asOfDate, String cik, int windowYears, String metric, int periodsUsed,
                                 int periodsTotal, LocalDate firstFilingDate, LocalDate lastFilingDate,
                                 Double cumReturnPct, Double cagrPct, Double volPct, Double mddPct, Double sharpe,
                                 Double excessVsSpyPct, Double coverageMin, Double coverageAvg, boolean eligible,
                                 String ineligibleReason, Integer rank, JsonNode periods, int settingsVersion,
                                 Instant computedAt, String groupCode, String dataSource) {

        /** 후보 27곳·7년 창(R1 그룹 A). DB CHECK와 같은 문자열. */
        public static final String GROUP_A = "A";
        /** 기존 13F 메뉴 12곳·2년 창(R1 그룹 B, D27). */
        public static final String GROUP_B = "B";
        /** 후보 수집 저장본 {@code sec.13f.{cik}.q30}(CUSIP 매핑 티커). DB CHECK와 같은 문자열. */
        public static final String SOURCE_Q30 = "q30";
        /** 기존 13F 메뉴 저장본 {@code sec.13f.{cik}.q8}(이름 매핑 티커). */
        public static final String SOURCE_Q8 = "q8";

        public TrackRecordRow {
            requireGroup(groupCode);
            if (dataSource != null && !SOURCE_Q30.equals(dataSource) && !SOURCE_Q8.equals(dataSource)) {
                throw new IllegalArgumentException("트랙레코드 출처는 q30·q8입니다: " + dataSource);
            }
        }

        /** 그룹 A 행(단계 1b 모양 — 출처 모름). */
        public TrackRecordRow(LocalDate asOfDate, String cik, int windowYears, String metric, int periodsUsed,
                              int periodsTotal, LocalDate firstFilingDate, LocalDate lastFilingDate,
                              Double cumReturnPct, Double cagrPct, Double volPct, Double mddPct, Double sharpe,
                              Double excessVsSpyPct, Double coverageMin, Double coverageAvg, boolean eligible,
                              String ineligibleReason, Integer rank, JsonNode periods, int settingsVersion,
                              Instant computedAt) {
            this(asOfDate, cik, windowYears, metric, periodsUsed, periodsTotal, firstFilingDate, lastFilingDate,
                    cumReturnPct, cagrPct, volPct, mddPct, sharpe, excessVsSpyPct, coverageMin, coverageAvg, eligible,
                    ineligibleReason, rank, periods, settingsVersion, computedAt, GROUP_A, null);
        }

        /**
         * 그룹 코드 확인 — DB CHECK보다 먼저 막아, 오타 난 그룹이 "그 그룹의 행 없음"으로 조용히 읽히지 않게 합니다.
         *
         * @throws IllegalArgumentException A·B가 아님
         */
        public static String requireGroup(String groupCode) {
            if (!GROUP_A.equals(groupCode) && !GROUP_B.equals(groupCode)) {
                throw new IllegalArgumentException("트랙레코드 그룹은 A·B입니다: " + groupCode);
            }
            return groupCode;
        }
    }

    /**
     * 기준일 하나의 기관 선정({@code paper_selection_log}). {@code selectedCiks}는 선정 순위 순, {@code ranking}은 그때의 순위표
     * JSON(null이면 {@code []}). {@code createdAt}은 넣을 때 쓰지 않고 DB가 채웁니다.
     */
    public record Selection(LocalDate asOfDate, List<String> selectedCiks, JsonNode ranking, int settingsVersion,
                            Instant createdAt) {
        public Selection {
            selectedCiks = selectedCiks == null ? List.of() : List.copyOf(selectedCiks);
        }
    }

    /**
     * 결정 한 건({@code paper_decisions}). (책, 기준 거래일, 종류)마다 하나입니다. 규칙 책은 {@code model}·{@code packet}·
     * {@code usage}처럼 Claude 호출에만 있는 열이 null이고, 판단 근거는 {@code response} JSON에 있습니다.
     * {@code decidedAt}은 넣을 때 null이면 DB가 지금으로 채웁니다.
     *
     * <p>{@code packetText}는 Claude에 보낸 패킷 문자열 그대로({@code packet_text}, V10) — {@code packetHash}는 이 문자열의
     * SHA-256이고, JSONB {@code packet}은 키 순서·표기를 바꿔 저장하므로 다시 직렬화해도 해시가 맞지 않습니다. 읽을 때 이 값이
     * 있으면 {@code packet}도 이 문자열에서 읽어 보낸 섹션 순서를 지킵니다. 규칙 책·V10 전 기록은 null.
     */
    public record Decision(long id, String bookCode, LocalDate asOfTradingDate, String kind, Instant decidedAt,
                           String status, String model, Integer frameworkVersion, int settingsVersion,
                           LocalDate selectionAsOf, Double targetExposurePct, JsonNode packet, String packetHash,
                           String responseRaw, JsonNode response, JsonNode usage, String error, List<Long> noteIds,
                           boolean pricesFinal, Long latencyMs, int retryCount, String packetText) {
        public Decision {
            noteIds = noteIds == null ? null : List.copyOf(noteIds);
        }

        /** 패킷 문자열 없이(규칙 책·호출하지 않은 결정·시험). */
        public Decision(long id, String bookCode, LocalDate asOfTradingDate, String kind, Instant decidedAt,
                        String status, String model, Integer frameworkVersion, int settingsVersion,
                        LocalDate selectionAsOf, Double targetExposurePct, JsonNode packet, String packetHash,
                        String responseRaw, JsonNode response, JsonNode usage, String error, List<Long> noteIds,
                        boolean pricesFinal, Long latencyMs, int retryCount) {
            this(id, bookCode, asOfTradingDate, kind, decidedAt, status, model, frameworkVersion, settingsVersion,
                    selectionAsOf, targetExposurePct, packet, packetHash, responseRaw, response, usage, error, noteIds,
                    pricesFinal, latencyMs, retryCount, null);
        }
    }

    /**
     * 결정 목록의 한 줄 — 큰 JSON(패킷·응답)은 읽지 않고 응답의 {@code summary}만, 그 결정이 낸 주문 수·거절 수와 함께.
     * 하루 한 건씩 쌓이는 표를 50건씩 보여 주는데 응답 JSON에는 신호 이벤트 수백 개가 들어 있을 수 있습니다.
     */
    public record DecisionSummary(long id, String bookCode, LocalDate asOfTradingDate, String kind, Instant decidedAt,
                                  String status, String model, Integer frameworkVersion, int settingsVersion,
                                  LocalDate selectionAsOf, Double targetExposurePct, String summary, String error,
                                  boolean pricesFinal, int orderCount, int rejectedCount) {
    }

    /**
     * 거래일 하나의 게이트 지표({@code paper_gate_log}, 참고 — 구속하지 않음). {@code inputs}·{@code streaks}는 JSON 그대로이고
     * {@code createdAt}은 넣을 때 쓰지 않고 DB가 채웁니다.
     */
    public record GateRow(LocalDate tradingDate, JsonNode inputs, String level, JsonNode streaks, Instant createdAt) {
    }

    /**
     * 주간 복기 한 건({@code paper_reviews}, V12 — 2단계 명세 §3 D1~D6). 시장({@code market}, V14)·주({@code weekEnding} = 그 시장
     * 달력의 ISO 주 마지막 거래일)마다 하나입니다 — 기본키 (market, week_ending). {@code input}은 코드가 만든 복기 입력(비울 수 없음 —
     * 부르지 않은 SKIPPED도 무엇을 보고 건너뛰었는지 남김), {@code inputText}는 Claude에 보낸 그 입력 JSON 문자열 그대로(구분자·안내
     * 문장 빼고 — 부르지 않았으면 null)입니다. 읽을 때 {@code inputText}가 있으면 {@code input}도 그 문자열에서 읽어 보낸 키 순서를
     * 지킵니다(JSONB는 키를 다시 정렬 — {@link Decision}의 패킷과 같은 방식). {@code proposalId}는 이 복기가 낸 프레임 제안(없으면 null),
     * {@code retryCount}는 API 오류 뒤 다시 부른 횟수(0·1), {@code createdAt}은 넣을 때 null이면 DB가 지금으로 채웁니다. 시장을 받지
     * 않는 생성자는 미국입니다(V14 열 기본값).
     */
    public record Review(LocalDate weekEnding, Integer windowWeeks, JsonNode input, String inputText, JsonNode response,
                         String responseRaw, String model, JsonNode usage, String status, String error, Long proposalId,
                         Integer frameworkVersion, int retryCount, Instant createdAt, String market) {

        /** 형식을 지난 응답. 아래 다섯은 DB CHECK와 같은 문자열입니다. */
        public static final String OK = "OK";
        /** 형식 위반 — 그 주는 이것으로 끝(다시 부르지 않음). */
        public static final String FORMAT_ERROR = "FORMAT_ERROR";
        /** 호출 실패 — 같은 행에서 한 번만 다시 부름({@link PaperStore#updateReviewRetry}). */
        public static final String API_ERROR = "API_ERROR";
        /** 모델 거절 — 그 주는 이것으로 끝. */
        public static final String REFUSED = "REFUSED";
        /** 창 안에 Claude 결정이 없어 부르지 않음. */
        public static final String SKIPPED = "SKIPPED";
        public static final Set<String> STATUSES = Set.of(OK, FORMAT_ERROR, API_ERROR, REFUSED, SKIPPED);

        public Review {
            // DB CHECK·NOT NULL보다 먼저 막습니다 — 가짜 저장소로 도는 서비스 시험도 같은 자리에서 멈추게.
            if (!STATUSES.contains(status)) {
                throw new IllegalArgumentException("복기 상태는 " + String.join("·", List.of(OK, FORMAT_ERROR, API_ERROR,
                        REFUSED, SKIPPED)) + "입니다: " + status);
            }
            if (input == null) {
                throw new IllegalArgumentException("복기 입력(input)은 비울 수 없습니다");
            }
            if (retryCount < 0) {
                throw new IllegalArgumentException("재시도 횟수는 0 이상입니다: " + retryCount);
            }
            requireMarket(market, "복기");
        }

        /** 미국 복기 — V14 전부터 있던 모양. */
        public Review(LocalDate weekEnding, Integer windowWeeks, JsonNode input, String inputText, JsonNode response,
                      String responseRaw, String model, JsonNode usage, String status, String error, Long proposalId,
                      Integer frameworkVersion, int retryCount, Instant createdAt) {
            this(weekEnding, windowWeeks, input, inputText, response, responseRaw, model, usage, status, error,
                    proposalId, frameworkVersion, retryCount, createdAt, Book.MARKET_US);
        }
    }

    /**
     * 시장 코드 확인 — DB CHECK(V13·V14의 {@code market IN ('US', 'KR')})보다 먼저 막아, 오타 난 시장이 가짜 저장소로 도는 서비스
     * 시험에서도 같은 자리에서 멈추게 합니다.
     *
     * @throws IllegalArgumentException US·KR이 아님
     */
    private static void requireMarket(String market, String what) {
        if (!Book.MARKET_US.equals(market) && !Book.MARKET_KR.equals(market)) {
            throw new IllegalArgumentException(what + "의 시장은 " + Book.MARKET_US + "·" + Book.MARKET_KR + "입니다: " + market);
        }
    }

    /**
     * 복기 목록의 한 줄 — 큰 JSON(입력·응답)은 읽지 않고, 판정 수와 연결된 제안의 상태만. 판정 수({@code held}·{@code refuted}·
     * {@code undetermined} = 응답 {@code verdicts[].thesisHeld}의 유지·반증·판단불가)는 형식을 지난(OK) 행만 세고, 그 밖의 행은 null입니다
     * (0건으로 채우지 않음 — 형식 위반 응답의 판정은 믿을 수 없음). {@code proposalStatus}는 연결된 제안의 지금 상태(없으면 null).
     */
    public record ReviewSummary(LocalDate weekEnding, Integer windowWeeks, String status, String model, String error,
                                Long proposalId, String proposalStatus, Integer frameworkVersion, int retryCount,
                                Integer held, Integer refuted, Integer undetermined, Instant createdAt) {

        /** 응답 스키마({@code paper/review.schema.json})의 {@code thesisHeld} 값 — 판정 수가 세는 문자열(StructuredSchemaTest가 대조). */
        public static final String HELD = "유지";
        public static final String REFUTED = "반증";
        public static final String UNDETERMINED = "판단불가";
    }

    private static final String BOOK_COLUMNS = "code, kind, label, initial_cash, started_on, status, created_at, market, "
            + "currency";
    private static final String STATE_COLUMNS = "book_code, cash, nav, equity_value, exposure_pct, last_observed_at, "
            + "last_processed_collected_at, last_nav_trading_date, updated_at";
    private static final String POSITION_COLUMNS = "book_code, ticker, qty, avg_cost, opened_on, opened_at, "
            + "high_watermark, watermark_at, last_price, last_price_at, price_stale, fill_ref_date, fill_ref_close, "
            + "split_note";
    private static final String ORDER_COLUMNS = "id, book_code, decision_id, ticker, side, qty, target_weight_pct, "
            + "sell_fraction, timing, source, status, reject_reason, reason::text AS reason, as_of_trading_date, "
            + "created_at, expires_on, filled_at";
    private static final String FILL_COLUMNS = "id, order_id, book_code, ticker, side, qty, price, raw_price, "
            + "slippage_bp, gross, observed_at, observation_date, price_source, is_backfill, created_at, fee, tax, "
            + "slippage_cost";
    private static final String NAV_COLUMNS = "book_code, trading_date, nav, cash, equity_value, exposure_pct, "
            + "prices_final";
    private static final String JOB_COLUMNS = "id, job, started_at, finished_at, outcome, detail::text AS detail";
    private static final String START_PRICE_COLUMNS = "ticker, trading_date, close, source, captured_at";
    private static final String TRACK_RECORD_COLUMNS = "as_of_date, cik, window_years, metric, periods_used, "
            + "periods_total, first_filing_date, last_filing_date, cum_return_pct, cagr_pct, vol_pct, mdd_pct, sharpe, "
            + "excess_vs_spy_pct, coverage_min, coverage_avg, eligible, ineligible_reason, rank, periods::text AS periods, "
            + "settings_version, computed_at, group_code, data_source";
    private static final String SELECTION_COLUMNS = "as_of_date, selected_ciks, ranking::text AS ranking, "
            + "settings_version, created_at";
    private static final String DECISION_COLUMNS = "id, book_code, as_of_trading_date, kind, decided_at, status, model, "
            + "framework_version, settings_version, selection_as_of, target_exposure_pct, "
            // 보낸 문자열이 있으면 그것을(섹션 순서 그대로), 없으면 JSONB를 — 큰 패킷을 두 번 읽지 않게 한 칸으로.
            + "COALESCE(packet_text, packet::text) AS packet, (packet_text IS NOT NULL) AS packet_text_stored, "
            + "packet_hash, response_raw, response::text AS response, usage::text AS usage, error, note_ids, "
            + "prices_final, latency_ms, retry_count";
    /** 목록용 — 응답 JSON은 요약 한 칸만 꺼내고, 주문 수·거절 수는 주문 표에서 셉니다(주문은 결정 번호로 찾음). */
    private static final String DECISION_SUMMARY_COLUMNS = "d.id, d.book_code, d.as_of_trading_date, d.kind, "
            + "d.decided_at, d.status, d.model, d.framework_version, d.settings_version, d.selection_as_of, "
            + "d.target_exposure_pct, d.response->>'summary' AS summary, d.error, d.prices_final, "
            + "(SELECT COUNT(*) FROM paper_orders o WHERE o.decision_id = d.id) AS order_count, "
            + "(SELECT COUNT(*) FROM paper_orders o WHERE o.decision_id = d.id AND o.status = 'REJECTED') "
            + "AS rejected_count";
    private static final String GATE_COLUMNS = "trading_date, inputs::text AS inputs, level, streaks::text AS streaks, "
            + "created_at";
    private static final String FRAMEWORK_COLUMNS = "version, body::text AS body, rendered, rendered_tokens_est, "
            + "changelog, source_proposal_id, created_at";
    private static final String PROPOSAL_COLUMNS = "id, note_id, base_version, request_text, model, "
            + "response::text AS response, response_raw, status, error, result_version, created_at, decided_at";
    private static final String NOTE_COLUMNS = "id, kind, as_of_date, expires_on, title, body, archived, created_at, "
            + "market";
    private static final String API_USAGE_COLUMNS = "day, calls, input_tokens, output_tokens, cache_read_tokens, "
            + "cache_write_tokens, est_cost_usd, est_cost_calls";
    private static final String REVIEW_COLUMNS = "week_ending, window_weeks, "
            // 보낸 문자열이 있으면 그것을(키 순서 그대로), 없으면 JSONB를 — 결정의 패킷과 같은 한 칸 읽기.
            + "COALESCE(input_text, input::text) AS input, (input_text IS NOT NULL) AS input_text_stored, "
            + "response::text AS response, response_raw, model, usage::text AS usage, status, error, proposal_id, "
            + "framework_version, retry_count, created_at, market";
    /** 판정 수 하나 — 형식을 지난(OK) 행의 {@code verdicts} 배열에서 그 값의 개수, 그 밖이면 NULL(목록 레코드 설명). */
    private static final String VERDICT_COUNT = "CASE WHEN r.status = 'OK' AND jsonb_typeof(r.response->'verdicts') = "
            + "'array' THEN (SELECT COUNT(*)::int FROM jsonb_array_elements(r.response->'verdicts') v "
            + "WHERE v->>'thesisHeld' = ?) END";
    private static final String REVIEW_SUMMARY_COLUMNS = "r.week_ending, r.window_weeks, r.status, r.model, r.error, "
            + "r.proposal_id, p.status AS proposal_status, r.framework_version, r.retry_count, r.created_at, "
            + VERDICT_COUNT + " AS held, " + VERDICT_COUNT + " AS refuted, " + VERDICT_COUNT + " AS undetermined";

    private final JdbcTemplate jdbc;
    private final ObjectMapper mapper;
    private final SchemaCheck schema;
    /** 같은 DataSource의 트랜잭션 — 안에서 부르는 이 저장소·{@link StoreRepository}의 문장이 같은 연결에 합류합니다. */
    private final TransactionTemplate transactions;

    public PaperStore(JdbcTemplate jdbc, ObjectMapper mapper, SchemaCheck schema) {
        this.jdbc = jdbc;
        this.mapper = mapper;
        this.schema = schema;
        this.transactions = new TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()));
    }

    /**
     * 테이블이 있는가. 수집기가 아직 V8~V16을 적용하지 않았으면 false입니다 — V8이 마지막에 만드는 테이블과 V9~V11이 더하는
     * 열({@code paper_track_record.data_source}·{@code paper_decisions.packet_text}·{@code paper_api_usage.est_cost_calls}),
     * V12의 {@code paper_reviews} 테이블, V13이 더하는 {@code paper_books.market}·{@code currency} 열, V14가 더하는
     * {@code paper_reviews.market}·{@code paper_notes.market} 열, V15가 더하는 {@code paper_positions.fill_ref_volume} 열, V16이 더하는
     * {@code paper_orders.ledger_hold_reason} 열로 봅니다.
     * V8만 있는 DB(백엔드만 새로 띄운 경우, QA-016)에서 참이면
     * 트랙레코드 읽기·쓰기가 {@code group_code}·{@code data_source} 열과 새 기본키에서, 결정 읽기·쓰기가 {@code packet_text} 열에서,
     * 사용량 읽기·쓰기가 추정 비용 열에서, 주간 복기 작업·화면이 없는 테이블에서, 책 읽기·쓰기가 시장·통화 열에서, 복기·메모
     * 읽기·쓰기가 시장 열과 새 기본키({@code ON CONFLICT (market, week_ending)})에서, 한국 장부가 since 봉 거래량 열·주문의 그날 보류
     * 표시 열에서 SQL 오류(500)를 냅니다.
     */
    public boolean ready() {
        return schema.tableExists("paper_api_usage") && schema.columnExists("paper_track_record", "data_source")
                && schema.columnExists("paper_decisions", "packet_text")
                && schema.columnExists("paper_api_usage", "est_cost_calls")
                && schema.tableExists("paper_reviews")
                && schema.columnExists("paper_books", "market") && schema.columnExists("paper_books", "currency")
                && schema.columnExists("paper_reviews", "market") && schema.columnExists("paper_notes", "market")
                && schema.columnExists("paper_positions", "fill_ref_volume")
                && schema.columnExists("paper_orders", "ledger_hold_reason");
    }

    /**
     * 장부 쓰기 여러 개를 한 트랜잭션으로 묶습니다 — 안에서 예외가 나면 모두 되돌리고 그 예외를 그대로 던집니다
     * ({@link UserStore#atomically}와 같은 방식). 이미 트랜잭션 안이면 거기에 합류합니다.
     *
     * <p>안에서 DB 오류(예: {@link #insertFill}의 중복)를 잡고 계속 쓰면 안 됩니다 — PostgreSQL은 오류가 난 트랜잭션의 나머지
     * 문장을 모두 거절합니다. 예외는 밖으로 내보내 트랜잭션째 되돌립니다.
     */
    public <T> T atomically(Supplier<T> work) {
        return transactions.execute(status -> work.get());
    }

    // ------------------------------------------------------------------ 책
    /** 모든 책(시장을 가리지 않음), code 순(화면에 보이는 순서는 서비스가 정함). 한 시장만은 {@link #books(String)}. */
    public List<Book> books() {
        return jdbc.query("SELECT " + BOOK_COLUMNS + " FROM paper_books ORDER BY code", bookMapper());
    }

    /** 그 시장({@code market} — US·KR)의 책만, code 순. 모르는 시장이면 빈 목록. */
    public List<Book> books(String market) {
        return jdbc.query("SELECT " + BOOK_COLUMNS + " FROM paper_books WHERE market = ? ORDER BY code", bookMapper(),
                market);
    }

    public Optional<Book> book(String code) {
        return jdbc.query("SELECT " + BOOK_COLUMNS + " FROM paper_books WHERE code = ?", bookMapper(), code)
                .stream().findFirst();
    }

    /**
     * 책이 없을 때만 넣습니다(초기화를 여러 번 눌러도 한 번). {@code status}가 null이면 NOT_STARTED,
     * {@code createdAt}이 null이면 지금. 시장·통화는 책 값 그대로 씁니다.
     *
     * @return 이번에 넣었으면 true, 이미 있었으면 false(기존 행은 그대로)
     */
    public boolean insertBookIfAbsent(Book book) {
        return jdbc.update("INSERT INTO paper_books (code, kind, label, initial_cash, started_on, status, created_at, "
                        + "market, currency) "
                        + "VALUES (?, ?, ?, ?, ?, COALESCE(?, 'NOT_STARTED'), COALESCE(?, now()), ?, ?) "
                        + "ON CONFLICT (code) DO NOTHING",
                ps -> {
                    ps.setString(1, book.code());
                    ps.setString(2, book.kind());
                    ps.setString(3, book.label());
                    ps.setBigDecimal(4, money(book.initialCash(), "initial_cash"));
                    setDate(ps, 5, book.startedOn());
                    ps.setString(6, book.status());
                    setInstant(ps, 7, book.createdAt());
                    ps.setString(8, book.market());
                    ps.setString(9, book.currency());
                }) == 1;
    }

    public void updateBookStatus(String code, String status) {
        jdbc.update("UPDATE paper_books SET status = ? WHERE code = ?", status, code);
    }

    /** 출발 거래일을 바꿉니다. null이면 "아직 시작 전"으로 되돌립니다(초기화). */
    public void updateBookStartedOn(String code, LocalDate startedOn) {
        jdbc.update("UPDATE paper_books SET started_on = ? WHERE code = ?", ps -> {
            setDate(ps, 1, startedOn);
            ps.setString(2, code);
        });
    }

    /**
     * 책 이름을 바꿉니다 — 지금 이름이 {@code from} 그대로일 때만. 조건부라 몇 번 불러도 결과가 같고, 다른 이름(손으로 고친 이름)은
     * 건드리지 않습니다.
     *
     * @return 이번에 바꿨으면 true(없는 책·이미 바뀐 이름·다른 이름이면 false)
     */
    public boolean relabelBook(String code, String from, String to) {
        return jdbc.update("UPDATE paper_books SET label = ? WHERE code = ? AND label = ?", to, code, from) == 1;
    }

    // ------------------------------------------------------------------ 상태
    public Optional<BookState> state(String code) {
        return jdbc.query("SELECT " + STATE_COLUMNS + " FROM paper_book_state WHERE book_code = ?",
                (rs, rowNum) -> new BookState(rs.getString("book_code"), rs.getDouble("cash"), rs.getDouble("nav"),
                        rs.getDouble("equity_value"), rs.getDouble("exposure_pct"),
                        instant(rs, "last_observed_at"), instant(rs, "last_processed_collected_at"),
                        date(rs, "last_nav_trading_date"), instant(rs, "updated_at")),
                code).stream().findFirst();
    }

    /** 상태를 넣거나 통째로 바꿉니다. {@code updatedAt}은 쓰지 않고 DB가 지금으로 채웁니다. */
    public void upsertState(BookState s) {
        jdbc.update("INSERT INTO paper_book_state (book_code, cash, nav, equity_value, exposure_pct, last_observed_at, "
                        + "last_processed_collected_at, last_nav_trading_date, updated_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (book_code) DO UPDATE SET cash = EXCLUDED.cash, nav = EXCLUDED.nav, "
                        + "equity_value = EXCLUDED.equity_value, exposure_pct = EXCLUDED.exposure_pct, "
                        + "last_observed_at = EXCLUDED.last_observed_at, "
                        + "last_processed_collected_at = EXCLUDED.last_processed_collected_at, "
                        + "last_nav_trading_date = EXCLUDED.last_nav_trading_date, updated_at = now()",
                ps -> {
                    ps.setString(1, s.bookCode());
                    ps.setBigDecimal(2, money(s.cash(), "cash"));
                    ps.setBigDecimal(3, money(s.nav(), "nav"));
                    ps.setBigDecimal(4, money(s.equityValue(), "equity_value"));
                    ps.setBigDecimal(5, money(s.exposurePct(), "exposure_pct"));
                    setInstant(ps, 6, s.lastObservedAt());
                    setInstant(ps, 7, s.lastProcessedCollectedAt());
                    setDate(ps, 8, s.lastNavTradingDate());
                });
    }

    // ------------------------------------------------------------------ 보유
    /** 한 책의 보유, ticker 순. */
    public List<Position> positions(String code) {
        return jdbc.query("SELECT " + POSITION_COLUMNS + " FROM paper_positions WHERE book_code = ? ORDER BY ticker",
                (rs, rowNum) -> new Position(rs.getString("book_code"), rs.getString("ticker"), rs.getInt("qty"),
                        rs.getDouble("avg_cost"), date(rs, "opened_on"), instant(rs, "opened_at"),
                        rs.getDouble("high_watermark"), instant(rs, "watermark_at"), nullableDouble(rs, "last_price"),
                        instant(rs, "last_price_at"), rs.getBoolean("price_stale"), date(rs, "fill_ref_date"),
                        rs.getDouble("fill_ref_close"), rs.getString("split_note")),
                code);
    }

    /** 보유를 넣거나 통째로 바꿉니다. 수량은 1 이상이어야 합니다(0주가 되면 {@link #deletePosition} — DB CHECK). */
    public void upsertPosition(Position p) {
        jdbc.update("INSERT INTO paper_positions (book_code, ticker, qty, avg_cost, opened_on, opened_at, high_watermark, "
                        + "watermark_at, last_price, last_price_at, price_stale, fill_ref_date, fill_ref_close, split_note, "
                        + "updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now()) "
                        + "ON CONFLICT (book_code, ticker) DO UPDATE SET qty = EXCLUDED.qty, avg_cost = EXCLUDED.avg_cost, "
                        + "opened_on = EXCLUDED.opened_on, opened_at = EXCLUDED.opened_at, "
                        + "high_watermark = EXCLUDED.high_watermark, watermark_at = EXCLUDED.watermark_at, "
                        + "last_price = EXCLUDED.last_price, last_price_at = EXCLUDED.last_price_at, "
                        + "price_stale = EXCLUDED.price_stale, fill_ref_date = EXCLUDED.fill_ref_date, "
                        + "fill_ref_close = EXCLUDED.fill_ref_close, split_note = EXCLUDED.split_note, updated_at = now()",
                ps -> {
                    ps.setString(1, p.bookCode());
                    ps.setString(2, p.ticker());
                    ps.setInt(3, p.qty());
                    ps.setBigDecimal(4, money(p.avgCost(), "avg_cost"));
                    setDate(ps, 5, p.openedOn());
                    setInstant(ps, 6, p.openedAt());
                    ps.setBigDecimal(7, money(p.highWatermark(), "high_watermark"));
                    setInstant(ps, 8, p.watermarkAt());
                    setMoney(ps, 9, p.lastPrice(), "last_price");
                    setInstant(ps, 10, p.lastPriceAt());
                    ps.setBoolean(11, p.priceStale());
                    setDate(ps, 12, p.fillRefDate());
                    ps.setBigDecimal(13, money(p.fillRefClose(), "fill_ref_close"));
                    ps.setString(14, p.splitNote());
                });
    }

    public void deletePosition(String code, String ticker) {
        jdbc.update("DELETE FROM paper_positions WHERE book_code = ? AND ticker = ?", code, ticker);
    }

    // ------------------------------------------------------------------ 미처리 기업행위(한국, V14)
    /**
     * 한 책에서 '미처리 기업행위' 표시가 걸린 보유, ticker 순(2단계 명세 K32, {@code paper_positions.corp_action_hold}). 표시가 없는
     * 보유는 빠집니다. 보유 레코드({@link Position})에는 이 칸이 없습니다 — {@link #upsertPosition}이 쓰지 않는 칸이라 보유 갱신이
     * 표시를 지우지 않고, 걸고 푸는 것은 아래 두 메서드만 합니다.
     */
    public List<CorpActionHold> corpActionHolds(String code) {
        return jdbc.query("SELECT book_code, ticker, corp_action_hold FROM paper_positions "
                        + "WHERE book_code = ? AND corp_action_hold IS NOT NULL ORDER BY ticker",
                (rs, rowNum) -> new CorpActionHold(rs.getString("book_code"), rs.getString("ticker"),
                        rs.getString("corp_action_hold")),
                code);
    }

    /**
     * 보유에 '미처리 기업행위' 표시를 겁니다. 이미 걸려 있으면 그대로 둡니다(처음 사유·걸린 날을 지킴 — 같은 신호가 밤마다 다시
     * 나와도 됨).
     *
     * @param reason 사유(머리에 걸린 날, {@code analytics.KrxCorporateActions.holdReason})
     * @return 새로 걸었으면 true, 이미 걸려 있거나 그 보유가 없으면 false
     * @throws IllegalArgumentException 사유가 비었음
     */
    public boolean holdForCorpAction(String code, String ticker, String reason) {
        if (reason == null || reason.isBlank()) {
            throw new IllegalArgumentException("미처리 기업행위 사유가 비었습니다: " + code + " " + ticker);
        }
        return jdbc.update("UPDATE paper_positions SET corp_action_hold = ?, updated_at = now() "
                + "WHERE book_code = ? AND ticker = ? AND corp_action_hold IS NULL", reason, code, ticker) == 1;
    }

    /**
     * '미처리 기업행위' 표시를 풉니다(사람이 확인한 뒤 — 정리 기능은 2단계에 두지 않음, 명세 §4-2).
     *
     * @return 걸려 있던 표시를 풀었으면 true
     */
    public boolean releaseCorpActionHold(String code, String ticker) {
        return jdbc.update("UPDATE paper_positions SET corp_action_hold = NULL, updated_at = now() "
                + "WHERE book_code = ? AND ticker = ? AND corp_action_hold IS NOT NULL", code, ticker) == 1;
    }

    // ------------------------------------------------------------------ since 봉 거래량(한국, V15)
    /**
     * 한 책 보유의 since 봉 거래량({@code paper_positions.fill_ref_volume}, 2단계 결정 d12) — ticker → 토스 원시 거래량. 값이 없는(NULL —
     * 미국 보유·V15 전 한국 보유) 보유는 빠집니다. since 봉은 그 보유 수량이 반영한 마지막 관측({@code fill_ref_date}·{@code fill_ref_close}와
     * 같은 봉)이고, 장부가 기업행위 판정에 저장본의 최근 봉과 함께 넘깁니다. 보유 레코드({@link Position})에는 이 칸이 없습니다 —
     * {@link #upsertPosition}이 쓰지 않는 칸이라(미국 보유 경로 그대로) 한국 장부가 {@link #updateFillRefVolume}으로 따로 씁니다.
     */
    public Map<String, Long> fillRefVolumes(String code) {
        Map<String, Long> out = new TreeMap<>();
        jdbc.query("SELECT ticker, fill_ref_volume FROM paper_positions WHERE book_code = ? AND fill_ref_volume IS NOT NULL",
                (RowCallbackHandler) rs -> out.put(rs.getString("ticker"), rs.getLong("fill_ref_volume")), code);
        return out;
    }

    /**
     * 보유의 since 봉 거래량을 씁니다(null이면 비움 — 모름). 그 보유가 없으면 아무것도 하지 않습니다.
     *
     * @throws IllegalArgumentException 거래량이 0 이하(since 봉은 관측 — 거래량 &gt; 0)
     */
    public void updateFillRefVolume(String code, String ticker, Long volume) {
        if (volume != null && volume <= 0) {
            throw new IllegalArgumentException("since 봉 거래량은 0보다 커야 합니다(관측 봉): " + code + " " + ticker + " " + volume);
        }
        jdbc.update("UPDATE paper_positions SET fill_ref_volume = ? WHERE book_code = ? AND ticker = ?", ps -> {
            setLong(ps, 1, volume);
            ps.setString(2, code);
            ps.setString(3, ticker);
        });
    }

    // ------------------------------------------------------------------ 재진입 금지
    /** 한 책의 재진입 금지, ticker 순. */
    public List<Lockout> lockouts(String code) {
        return jdbc.query("SELECT book_code, ticker, until_trading_date, reason FROM paper_lockouts "
                        + "WHERE book_code = ? ORDER BY ticker",
                (rs, rowNum) -> new Lockout(rs.getString("book_code"), rs.getString("ticker"),
                        date(rs, "until_trading_date"), rs.getString("reason")),
                code);
    }

    /** 재진입 금지를 넣거나 바꿉니다. 같은 종목이 이미 있으면 새 기한·사유로 덮습니다(늦게 걸린 스탑이 기준). */
    public void upsertLockout(Lockout l) {
        jdbc.update("INSERT INTO paper_lockouts (book_code, ticker, until_trading_date, reason) VALUES (?, ?, ?, ?) "
                        + "ON CONFLICT (book_code, ticker) DO UPDATE SET until_trading_date = EXCLUDED.until_trading_date, "
                        + "reason = EXCLUDED.reason, created_at = now()",
                ps -> {
                    ps.setString(1, l.bookCode());
                    ps.setString(2, l.ticker());
                    setDate(ps, 3, l.untilTradingDate());
                    ps.setString(4, l.reason());
                });
    }

    /**
     * 기한이 지난 재진입 금지를 지웁니다({@code until_trading_date < today} — 기한 당일까지는 남김).
     *
     * @return 지운 행 수
     */
    public int deleteLockoutsBefore(String code, LocalDate today) {
        return jdbc.update("DELETE FROM paper_lockouts WHERE book_code = ? AND until_trading_date < ?",
                code, Date.valueOf(today));
    }

    // ------------------------------------------------------------------ 주문
    /**
     * 주문을 넣습니다. {@code id}는 무시하고 DB가 매깁니다. {@code createdAt}이 null이면 지금(트랜잭션 시작 시각),
     * 아니면 그 값을 씁니다 — 사후 체결(BACKFILL)은 체결 관측치보다 앞선 시각이어야 하기 때문입니다.
     *
     * @return 새 주문 번호
     */
    public long insertOrder(Order o) {
        List<Long> ids = jdbc.query("INSERT INTO paper_orders (book_code, decision_id, ticker, side, qty, "
                        + "target_weight_pct, sell_fraction, timing, source, status, reject_reason, reason, "
                        + "as_of_trading_date, created_at, expires_on, filled_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(CAST(? AS jsonb), '{}'::jsonb), ?, "
                        + "COALESCE(CAST(? AS timestamptz), now()), ?, ?) RETURNING id",
                ps -> {
                    ps.setString(1, o.bookCode());
                    setLong(ps, 2, o.decisionId());
                    ps.setString(3, o.ticker());
                    ps.setString(4, o.side());
                    setInteger(ps, 5, o.qty());
                    setMoney(ps, 6, o.targetWeightPct(), "target_weight_pct");
                    setMoney(ps, 7, o.sellFraction(), "sell_fraction");
                    ps.setString(8, o.timing());
                    ps.setString(9, o.source());
                    ps.setString(10, o.status());
                    ps.setString(11, o.rejectReason());
                    ps.setString(12, o.reason() == null ? null : mapper.writeValueAsString(o.reason()));
                    setDate(ps, 13, o.asOfTradingDate());
                    setInstant(ps, 14, o.createdAt());
                    setDate(ps, 15, o.expiresOn());
                    setInstant(ps, 16, o.filledAt());
                },
                (rs, rowNum) -> rs.getLong("id"));
        return single(ids, "주문");
    }

    /** 한 책의 그 상태 주문, 만든 순(created_at, id). */
    public List<Order> ordersByStatus(String code, String status) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM paper_orders WHERE book_code = ? AND status = ? "
                + "ORDER BY created_at, id", orderMapper(), code, status);
    }

    /** 한 책의 최근 주문 {@code limit}건, 최근 순. */
    public List<Order> recentOrders(String code, int limit) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM paper_orders WHERE book_code = ? "
                + "ORDER BY created_at DESC, id DESC LIMIT ?", orderMapper(), code, limit);
    }

    /** 결정 하나가 낸 주문, 낸 순서(id 순). 없으면 빈 목록. */
    public List<Order> ordersByDecision(long decisionId) {
        return jdbc.query("SELECT " + ORDER_COLUMNS + " FROM paper_orders WHERE decision_id = ? ORDER BY id",
                orderMapper(), decisionId);
    }

    public void markOrderFilled(long id, Instant filledAt) {
        jdbc.update("UPDATE paper_orders SET status = 'FILLED', filled_at = ? WHERE id = ?", ps -> {
            setInstant(ps, 1, filledAt);
            ps.setLong(2, id);
        });
    }

    /** 상태와 거절 사유를 그대로 씁니다(사유가 null이면 비움). */
    public void markOrderStatus(long id, String status, String rejectReason) {
        jdbc.update("UPDATE paper_orders SET status = ?, reject_reason = ? WHERE id = ?", ps -> {
            ps.setString(1, status);
            ps.setString(2, rejectReason);
            ps.setLong(3, id);
        });
    }

    /**
     * 주문 근거(JSON)를 통째로 바꿉니다(null이면 {@code {}}). 체결하면서 알게 된 사실 — 현금이 모자라 요청보다 적게 산 것
     * ({@code cashLimited}) 같은 것 — 을 그 주문 기록에 남길 때 씁니다. 부르는 쪽이 기존 근거에 덧붙인 전체를 넘깁니다.
     */
    public void updateOrderReason(long id, JsonNode reason) {
        String json = reason == null ? null : mapper.writeValueAsString(reason);
        jdbc.update("UPDATE paper_orders SET reason = COALESCE(CAST(? AS jsonb), '{}'::jsonb) WHERE id = ?", ps -> {
            ps.setString(1, json);
            ps.setLong(2, id);
        });
    }

    /**
     * 기한이 지난 대기 주문을 만료시킵니다(PENDING이고 {@code expires_on < today}). 기한이 없는 주문은 건드리지 않습니다.
     *
     * @return 만료시킨 주문 수
     */
    public int expireOrders(String code, LocalDate today) {
        return jdbc.update("UPDATE paper_orders SET status = 'EXPIRED' "
                + "WHERE book_code = ? AND status = 'PENDING' AND expires_on < ?", code, Date.valueOf(today));
    }

    /**
     * 체결 전 주문(PENDING·PROPOSED)을 모두 취소합니다 — 일시정지할 때.
     *
     * @return 취소한 주문 수
     */
    public int cancelPendingOrders(String code) {
        return jdbc.update("UPDATE paper_orders SET status = 'CANCELLED' "
                + "WHERE book_code = ? AND status IN ('PENDING', 'PROPOSED')", code);
    }

    // ------------------------------------------------------------------ 장부의 그날 보류 표시(한국, V16)
    /**
     * 한 책 대기 주문(PENDING)의 장부 그날 보류 표시({@link LedgerHold}), 주문 번호 순. 표시가 없는 주문은 빠집니다. 주문 레코드
     * ({@link Order})에는 이 칸이 없습니다 — {@link #insertOrder}가 쓰지 않는 칸이라(미국 주문 경로 그대로) 한국 장부가
     * {@link #markLedgerHolds}로 따로 씁니다.
     */
    public List<LedgerHold> ledgerHolds(String code) {
        return jdbc.query("SELECT id, book_code, ticker, ledger_hold_reason, ledger_hold_collected_at FROM paper_orders "
                        + "WHERE book_code = ? AND status = 'PENDING' AND ledger_hold_reason IS NOT NULL ORDER BY id",
                (rs, rowNum) -> new LedgerHold(rs.getLong("id"), rs.getString("book_code"), rs.getString("ticker"),
                        rs.getString("ledger_hold_reason"), instant(rs, "ledger_hold_collected_at")),
                code);
    }

    /**
     * 장부가 수집 시각 {@code collectedAt}의 관측치로 그 책을 처리하며 그날 보류한 종목(코드 → 사유)을 그 종목의 대기 주문(PENDING)에
     * 표시하고, 그 책의 다른 표시는 모두 지웁니다(보류가 풀렸거나 주문이 대기를 벗어남). 장부 처리 트랜잭션 안에서 부릅니다 — 처리를
     * 되돌리면 표시도 앞 그대로입니다. 보류가 없으면 지우기만 합니다.
     *
     * @throws IllegalArgumentException 보류가 있는데 수집 시각이 없거나 사유가 비었음
     */
    public void markLedgerHolds(String code, Instant collectedAt, Map<String, String> byTicker) {
        if (!byTicker.isEmpty() && collectedAt == null) {
            throw new IllegalArgumentException("장부 보류 표시에 관측치 수집 시각이 없습니다: " + code);
        }
        for (Map.Entry<String, String> hold : byTicker.entrySet()) {
            if (hold.getValue() == null || hold.getValue().isBlank()) {
                throw new IllegalArgumentException("장부 보류 사유가 비었습니다: " + code + " " + hold.getKey());
            }
        }
        jdbc.update("UPDATE paper_orders SET ledger_hold_reason = NULL, ledger_hold_collected_at = NULL "
                + "WHERE book_code = ? AND ledger_hold_reason IS NOT NULL", code);
        for (Map.Entry<String, String> hold : byTicker.entrySet()) {
            jdbc.update("UPDATE paper_orders SET ledger_hold_reason = ?, ledger_hold_collected_at = ? "
                    + "WHERE book_code = ? AND status = 'PENDING' AND ticker = ?", ps -> {
                        ps.setString(1, hold.getValue());
                        setInstant(ps, 2, collectedAt);
                        ps.setString(3, code);
                        ps.setString(4, hold.getKey());
                    });
        }
    }

    // ------------------------------------------------------------------ 체결
    /**
     * 체결을 넣습니다. {@code id}는 DB가 매기고, {@code createdAt}이 null이면 지금입니다. 비용 칸(수수료·세금·슬리피지 금액 — 한국
     * 체결, 미국은 0)도 함께 씁니다.
     *
     * @return 새 체결 번호
     * @throws org.springframework.dao.DuplicateKeyException 그 주문의 체결이 이미 있으면(주문당 하나 — 같은 주문을 두 번
     *                                                       체결하지 않는 마지막 방어선). 트랜잭션 안이면 그 트랜잭션은
     *                                                       더 쓸 수 없으니 잡지 말고 내보냅니다({@link #atomically}).
     */
    public long insertFill(Fill f) {
        List<Long> ids = jdbc.query("INSERT INTO paper_fills (order_id, book_code, ticker, side, qty, price, raw_price, "
                        + "slippage_bp, gross, observed_at, observation_date, price_source, is_backfill, created_at, fee, "
                        + "tax, slippage_cost) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(CAST(? AS timestamptz), now()), ?, ?, ?) "
                        + "RETURNING id",
                ps -> {
                    ps.setLong(1, f.orderId());
                    ps.setString(2, f.bookCode());
                    ps.setString(3, f.ticker());
                    ps.setString(4, f.side());
                    ps.setInt(5, f.qty());
                    ps.setBigDecimal(6, money(f.price(), "price"));
                    ps.setBigDecimal(7, money(f.rawPrice(), "raw_price"));
                    ps.setBigDecimal(8, money(f.slippageBp(), "slippage_bp"));
                    ps.setBigDecimal(9, money(f.gross(), "gross"));
                    setInstant(ps, 10, f.observedAt());
                    setDate(ps, 11, f.observationDate());
                    ps.setString(12, f.priceSource());
                    ps.setBoolean(13, f.backfill());
                    setInstant(ps, 14, f.createdAt());
                    ps.setBigDecimal(15, f.fee());
                    ps.setBigDecimal(16, f.tax());
                    ps.setBigDecimal(17, f.slippageCost());
                },
                (rs, rowNum) -> rs.getLong("id"));
        return single(ids, "체결");
    }

    /** 한 책의 최근 체결 {@code limit}건, 최근 순. */
    public List<Fill> recentFills(String code, int limit) {
        return jdbc.query("SELECT " + FILL_COLUMNS + " FROM paper_fills WHERE book_code = ? "
                        + "ORDER BY created_at DESC, id DESC LIMIT ?",
                (rs, rowNum) -> fillOf(rs), code, limit);
    }

    /** 한 책 체결 중 가장 늦은 관측일(체결 봉 날짜) — 체결이 없으면 empty. */
    public Optional<LocalDate> latestFillDate(String code) {
        List<LocalDate> rows = jdbc.query("SELECT max(observation_date) AS day FROM paper_fills WHERE book_code = ?",
                (rs, rowNum) -> date(rs, "day"), code);
        return rows.isEmpty() ? Optional.empty() : Optional.ofNullable(rows.get(0));
    }

    // ------------------------------------------------------------------ 확정 조정(V14 — K29)
    /**
     * 확정 조정 행이 아직 없는 그 책의 체결(사후 체결 제외 — 미국 출발 경로), 체결 순(번호 순)과 그 주문의 체결 시점.
     */
    public List<UnconfirmedFill> unconfirmedFills(String code) {
        return jdbc.query("SELECT " + prefixed("f.", FILL_COLUMNS) + ", o.timing FROM paper_fills f "
                        + "JOIN paper_orders o ON o.id = f.order_id "
                        + "LEFT JOIN paper_fill_confirmations c ON c.fill_id = f.id "
                        + "WHERE f.book_code = ? AND NOT f.is_backfill AND c.fill_id IS NULL ORDER BY f.id",
                (rs, rowNum) -> new UnconfirmedFill(fillOf(rs), rs.getString("timing")), code);
    }

    /**
     * 확정 조정 한 행을 넣습니다 — 그 체결에 이미 있으면(체결마다 한 행, 기본키 {@code fill_id}) 아무것도 바꾸지 않고 false. 장부는 true일
     * 때만 같은 트랜잭션에서 현금·평단을 옮깁니다(그래서 재기동·같은 처리를 두 번 해도 현금이 두 번 움직이지 않음).
     *
     * @return 새로 넣었으면 true
     */
    public boolean insertFillConfirmationIfAbsent(FillConfirmation c) {
        return jdbc.update("INSERT INTO paper_fill_confirmations (fill_id, book_code, confirmed_price, fee, tax, "
                        + "slippage_cost, cash_delta, source, reconciled_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(CAST(? AS timestamptz), now())) "
                        + "ON CONFLICT (fill_id) DO NOTHING",
                ps -> {
                    ps.setLong(1, c.fillId());
                    ps.setString(2, c.bookCode());
                    ps.setBigDecimal(3, c.confirmedPrice());
                    ps.setBigDecimal(4, c.fee());
                    ps.setBigDecimal(5, c.tax());
                    ps.setBigDecimal(6, c.slippageCost());
                    ps.setBigDecimal(7, c.cashDelta());
                    ps.setString(8, c.source());
                    setInstant(ps, 9, c.reconciledAt());
                }) == 1;
    }

    /** 한 책의 확정 조정 행, 체결 번호 순. */
    public List<FillConfirmation> fillConfirmations(String code) {
        return jdbc.query("SELECT fill_id, book_code, confirmed_price, fee, tax, slippage_cost, cash_delta, source, "
                        + "reconciled_at FROM paper_fill_confirmations WHERE book_code = ? ORDER BY fill_id",
                (rs, rowNum) -> new FillConfirmation(rs.getLong("fill_id"), rs.getString("book_code"),
                        rs.getBigDecimal("confirmed_price"), rs.getBigDecimal("fee"), rs.getBigDecimal("tax"),
                        rs.getBigDecimal("slippage_cost"), rs.getBigDecimal("cash_delta"), rs.getString("source"),
                        instant(rs, "reconciled_at")),
                code);
    }

    private static Fill fillOf(ResultSet rs) throws SQLException {
        return new Fill(rs.getLong("id"), rs.getLong("order_id"), rs.getString("book_code"),
                rs.getString("ticker"), rs.getString("side"), rs.getInt("qty"), rs.getDouble("price"),
                rs.getDouble("raw_price"), rs.getDouble("slippage_bp"), rs.getDouble("gross"),
                instant(rs, "observed_at"), date(rs, "observation_date"), rs.getString("price_source"),
                rs.getBoolean("is_backfill"), instant(rs, "created_at"), rs.getBigDecimal("fee"),
                rs.getBigDecimal("tax"), rs.getBigDecimal("slippage_cost"));
    }

    /** 열 목록({@code "a, b, c"})의 열마다 표 별칭을 붙입니다({@code "f.a, f.b, f.c"}) — 이름은 그대로 읽힙니다. */
    private static String prefixed(String alias, String columns) {
        return String.join(", ", java.util.Arrays.stream(columns.split(",\\s*")).map(column -> alias + column).toList());
    }

    // ------------------------------------------------------------------ 순자산
    /**
     * 거래일 순자산을 넣거나 바꿉니다. 단, 이미 확정값({@code prices_final = true})이 있으면 미확정값으로 덮지 않습니다 —
     * 장 마감 뒤 확정 종가로 적은 줄을 다음 날 새벽의 묵은 관측치(같은 거래일 봉)가 지우지 않게. 확정값끼리는 새 값이 이깁니다.
     */
    public void upsertNav(NavRow r) {
        jdbc.update("INSERT INTO paper_nav_daily (book_code, trading_date, nav, cash, equity_value, exposure_pct, "
                        + "prices_final) VALUES (?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (book_code, trading_date) DO UPDATE SET nav = EXCLUDED.nav, cash = EXCLUDED.cash, "
                        + "equity_value = EXCLUDED.equity_value, exposure_pct = EXCLUDED.exposure_pct, "
                        + "prices_final = EXCLUDED.prices_final "
                        + "WHERE NOT paper_nav_daily.prices_final OR EXCLUDED.prices_final",
                ps -> {
                    ps.setString(1, r.bookCode());
                    setDate(ps, 2, r.tradingDate());
                    ps.setBigDecimal(3, money(r.nav(), "nav"));
                    ps.setBigDecimal(4, money(r.cash(), "cash"));
                    ps.setBigDecimal(5, money(r.equityValue(), "equity_value"));
                    ps.setBigDecimal(6, money(r.exposurePct(), "exposure_pct"));
                    ps.setBoolean(7, r.pricesFinal());
                });
    }

    /** 한 책의 순자산, 거래일 오름차순. */
    public List<NavRow> navSeries(String code) {
        return jdbc.query("SELECT " + NAV_COLUMNS + " FROM paper_nav_daily WHERE book_code = ? ORDER BY trading_date",
                navMapper(), code);
    }

    /** 한 책의 그 거래일 순자산 줄 하나 — 없으면 empty(확정 조정이 마지막 줄만 볼 때 전체 이력을 읽지 않게). */
    public Optional<NavRow> navRow(String code, LocalDate tradingDate) {
        return jdbc.query("SELECT " + NAV_COLUMNS + " FROM paper_nav_daily WHERE book_code = ? AND trading_date = ?",
                navMapper(), code, Date.valueOf(tradingDate)).stream().findFirst();
    }

    /** 모든 책의 순자산, (책, 거래일) 순. */
    public List<NavRow> navSeriesAll() {
        return jdbc.query("SELECT " + NAV_COLUMNS + " FROM paper_nav_daily ORDER BY book_code, trading_date",
                navMapper());
    }

    // ------------------------------------------------------------------ 작업 기록
    /**
     * 정기 작업 실행 한 건을 남기고, 그 작업의 기록은 최근 {@value #JOB_RUNS_KEPT}건만 둡니다(시작 시각 순). 두 문장을 한
     * 트랜잭션으로 씁니다. {@code detail}이 null이면 {@code {}}.
     */
    public void recordJobRun(String job, Instant startedAt, Instant finishedAt, String outcome, JsonNode detail) {
        String detailJson = detail == null ? null : mapper.writeValueAsString(detail);
        atomically(() -> {
            jdbc.update("INSERT INTO paper_job_runs (job, started_at, finished_at, outcome, detail) "
                    + "VALUES (?, ?, ?, ?, COALESCE(CAST(? AS jsonb), '{}'::jsonb))", ps -> {
                        ps.setString(1, job);
                        setInstant(ps, 2, startedAt);
                        setInstant(ps, 3, finishedAt);
                        ps.setString(4, outcome);
                        ps.setString(5, detailJson);
                    });
            jdbc.update("DELETE FROM paper_job_runs WHERE job = ? AND id NOT IN ("
                    + "SELECT id FROM paper_job_runs WHERE job = ? ORDER BY started_at DESC, id DESC LIMIT ?)",
                    job, job, JOB_RUNS_KEPT);
            return null;
        });
    }

    /** 모든 작업의 최근 기록 {@code limit}건, 최근 순(시작 시각). */
    public List<JobRun> recentJobRuns(int limit) {
        return jdbc.query("SELECT " + JOB_COLUMNS + " FROM paper_job_runs ORDER BY started_at DESC, id DESC LIMIT ?",
                jobRunMapper(), limit);
    }

    /**
     * 이름이 {@code jobPrefix}로 시작하는 작업의 최근 기록 {@code limit}건, 최근 순(시작 시각, 번호) — 한 시장의 작업 기록(작업 기록 이름의 시장
     * 접두어, 한국 {@code kr.} — 2단계 F1의 한국 개요·상태). 접두어는 글자 그대로 봅니다(LIKE·정규식의 특수 글자로 읽지 않음).
     */
    public List<JobRun> recentJobRuns(String jobPrefix, int limit) {
        return jdbc.query("SELECT " + JOB_COLUMNS + " FROM paper_job_runs WHERE starts_with(job, ?) "
                + "ORDER BY started_at DESC, id DESC LIMIT ?", jobRunMapper(), jobPrefix, limit);
    }

    /**
     * 그 작업의 기록 중 상세 {@code tradingDate}가 그 날인 것, 최근 순(시작 시각, 번호). 작업마다 최근 {@value #JOB_RUNS_KEPT}건만
     * 남으므로({@link #recordJobRun}) 그 안에서만 찾습니다 — 한국 결정 작업이 그 세션의 출발 미룸·기한 지남·기다림 판정을 재기동해도 같게
     * 다시 읽습니다(2단계 명세 §4-9 'E0', 사용자 결정 v3).
     */
    public List<JobRun> jobRunsFor(String job, LocalDate tradingDate) {
        return jdbc.query("SELECT " + JOB_COLUMNS + " FROM paper_job_runs WHERE job = ? AND detail->>'tradingDate' = ? "
                + "ORDER BY started_at DESC, id DESC", jobRunMapper(), job, tradingDate.toString());
    }

    /**
     * 작업 기록 한 건의 끝 시각과 상세를 바꿉니다(시작 시각·결과는 그대로, {@code detail}이 null이면 {@code {}}) — 같은 기다림이 다음
     * 주기에도 이어질 때 그 줄을 늘립니다(한국 결정 작업의 '기다림 한 줄', 2단계 명세 §4-9 'E0').
     *
     * @return 그 기록이 있어 바꿨으면 true
     */
    public boolean updateJobRun(long id, Instant finishedAt, JsonNode detail) {
        String detailJson = detail == null ? null : mapper.writeValueAsString(detail);
        return jdbc.update("UPDATE paper_job_runs SET finished_at = ?, detail = COALESCE(CAST(? AS jsonb), '{}'::jsonb) "
                + "WHERE id = ?", ps -> {
                    setInstant(ps, 1, finishedAt);
                    ps.setString(2, detailJson);
                    ps.setLong(3, id);
                }) == 1;
    }

    private RowMapper<JobRun> jobRunMapper() {
        return (rs, rowNum) -> new JobRun(rs.getLong("id"), rs.getString("job"), instant(rs, "started_at"),
                instant(rs, "finished_at"), rs.getString("outcome"), json(rs, "detail"));
    }

    // ------------------------------------------------------------------ 설정
    /** 설정 한 행. 아직 초기화 전이면 비어 있음(서비스가 기본값을 씀). */
    public Optional<SettingsRow> settings() {
        return jdbc.query("SELECT version, body::text AS body, updated_at FROM paper_settings WHERE id = 1",
                (rs, rowNum) -> new SettingsRow(rs.getInt("version"), json(rs, "body"), instant(rs, "updated_at")))
                .stream().findFirst();
    }

    /**
     * 설정이 없을 때만 버전 1로 넣고 이력에도 1을 남깁니다(바뀐 키 없음 = 처음 값). 한 트랜잭션입니다.
     *
     * @return 이번에 넣었으면 true, 이미 있었으면 false(기존 설정은 그대로)
     */
    public boolean initSettingsIfAbsent(JsonNode body) {
        String json = mapper.writeValueAsString(body);
        return atomically(() -> {
            int inserted = jdbc.update("INSERT INTO paper_settings (id, version, body) VALUES (1, 1, CAST(? AS jsonb)) "
                    + "ON CONFLICT (id) DO NOTHING", json);
            if (inserted == 0) {
                return false;
            }
            jdbc.update("INSERT INTO paper_settings_history (version, body, changed_keys) "
                    + "VALUES (1, CAST(? AS jsonb), '{}')", json);
            return true;
        });
    }

    /**
     * 설정을 통째로 바꾸고 버전을 하나 올립니다. 이력에 새 버전·본문·바뀐 키를 남깁니다. 한 트랜잭션이고, 동시에 저장해도
     * 버전이 겹치지 않습니다(행 잠금). 설정 행이 아직 없으면 버전 1로 만듭니다.
     *
     * @return 새 버전
     */
    public int saveSettings(JsonNode body, List<String> changedKeys) {
        String json = mapper.writeValueAsString(body);
        String[] keys = changedKeys == null ? new String[0] : changedKeys.toArray(new String[0]);
        return atomically(() -> {
            Integer version = jdbc.queryForObject("INSERT INTO paper_settings (id, version, body) "
                    + "VALUES (1, 1, CAST(? AS jsonb)) ON CONFLICT (id) DO UPDATE SET version = paper_settings.version + 1, "
                    + "body = EXCLUDED.body, updated_at = now() RETURNING version", Integer.class, json);
            if (version == null) {
                throw new IllegalStateException("새 설정 버전을 받지 못했습니다");
            }
            jdbc.update("INSERT INTO paper_settings_history (version, body, changed_keys) VALUES (?, CAST(? AS jsonb), ?)",
                    ps -> {
                        ps.setInt(1, version);
                        ps.setString(2, json);
                        ps.setArray(3, ps.getConnection().createArrayOf("text", keys));
                    });
            return version;
        });
    }

    /**
     * 그 버전의 설정 본문(변경 이력 {@code paper_settings_history}) — "이 트랙레코드는 어떤 자격 기준으로 계산했나"를 그때의
     * 값으로 보이려고. {@code updatedAt}에는 그 버전을 남긴 시각이 들어갑니다. 없으면 empty.
     */
    public Optional<SettingsRow> settingsAt(int version) {
        return jdbc.query("SELECT version, body::text AS body, created_at FROM paper_settings_history WHERE version = ?",
                (rs, rowNum) -> new SettingsRow(rs.getInt("version"), json(rs, "body"), instant(rs, "created_at")),
                version).stream().findFirst();
    }

    /**
     * 그 시각에 유효했던 설정 판 — 변경 이력에서 그 시각 이전(같은 시각 포함)에 남긴 가장 늦은 판(2단계 명세 결정 d7: 한국 확정 조정은 그
     * 체결 때의 비용 요율로 다시 셈). {@code updatedAt}에는 그 판을 남긴 시각이 들어갑니다. 그 시각 전에 남긴 판이 없으면 empty.
     */
    public Optional<SettingsRow> settingsInForceAt(Instant at) {
        return jdbc.query("SELECT version, body::text AS body, created_at FROM paper_settings_history "
                        + "WHERE created_at <= ? ORDER BY version DESC LIMIT 1",
                (rs, rowNum) -> new SettingsRow(rs.getInt("version"), json(rs, "body"), instant(rs, "created_at")),
                Timestamp.from(at)).stream().findFirst();
    }

    /** 설정 변경 이력 최근 {@code limit}건, 최근 버전 순(바뀐 키와 그 버전의 본문 전체). */
    public List<SettingsHistoryRow> settingsHistory(int limit) {
        return jdbc.query("SELECT version, body::text AS body, changed_keys, created_at FROM paper_settings_history "
                        + "ORDER BY version DESC LIMIT ?",
                (rs, rowNum) -> {
                    java.sql.Array array = rs.getArray("changed_keys");
                    List<String> keys = array == null ? List.of() : List.of((String[]) array.getArray());
                    return new SettingsHistoryRow(rs.getInt("version"), json(rs, "body"), keys,
                            instant(rs, "created_at"));
                },
                limit);
    }

    // ------------------------------------------------------------------ Claude 호출 사용량
    /** 그날(KST)의 사용량. 그날 호출이 없었으면 empty. */
    public Optional<ApiUsage> apiUsage(LocalDate day) {
        return jdbc.query("SELECT " + API_USAGE_COLUMNS + " FROM paper_api_usage WHERE day = ?",
                (rs, rowNum) -> new ApiUsage(date(rs, "day"), rs.getInt("calls"), rs.getLong("input_tokens"),
                        rs.getLong("output_tokens"), rs.getLong("cache_read_tokens"), rs.getLong("cache_write_tokens"),
                        nullableDouble(rs, "est_cost_usd"), rs.getInt("est_cost_calls")),
                Date.valueOf(day)).stream().findFirst();
    }

    /**
     * 기간(양끝 포함, KST 날짜)의 사용량 합계 — 월 누적 표시용. 기록이 없으면 모두 0·{@code days = 0}. 추정 비용은 추정한 날만
     * 더하고(SUM은 NULL을 건너뜀), 추정이 하나도 없으면 null입니다.
     */
    public ApiUsageTotal apiUsageBetween(LocalDate from, LocalDate to) {
        return jdbc.queryForObject("SELECT COUNT(*) AS days, COALESCE(SUM(calls), 0) AS calls, "
                        + "COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens, "
                        + "COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens, "
                        + "COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens, "
                        + "SUM(est_cost_usd) AS est_cost_usd, COALESCE(SUM(est_cost_calls), 0) AS est_cost_calls "
                        + "FROM paper_api_usage WHERE day BETWEEN ? AND ?",
                (rs, rowNum) -> new ApiUsageTotal(from, to, rs.getInt("days"), rs.getLong("calls"),
                        rs.getLong("input_tokens"), rs.getLong("output_tokens"), rs.getLong("cache_read_tokens"),
                        rs.getLong("cache_write_tokens"), nullableDouble(rs, "est_cost_usd"),
                        rs.getLong("est_cost_calls")),
                Date.valueOf(from), Date.valueOf(to));
    }

    /**
     * 그날 호출 한 번을 잡습니다 — 그날 호출 수가 {@code cap}보다 적을 때만 하나 올립니다(행이 없으면 1로 만듦). 검사와 증가가
     * 한 문장이라, 결정 작업과 미리보기 버튼이 동시에 불러도 상한을 넘지 않습니다(명세 D18). 호출 전에 잡고, 성공·실패와
     * 상관없이 그대로 둡니다(호출이 요청을 보내지도 않은 경우만 {@link #releaseApiCall}).
     *
     * @return 잡았으면 true, 상한에 닿았으면(또는 {@code cap ≤ 0}) false — 아무것도 바꾸지 않음
     */
    public boolean reserveApiCall(LocalDate day, int cap) {
        return reserveApiCallNumber(day, cap).isPresent();
    }

    /**
     * {@link #reserveApiCall}과 같고, 잡았으면 그 호출이 그날 몇 번째인지(이 호출까지 센 호출 수)를 같은 문장에서 돌려줍니다 —
     * 다시 읽으면 그사이 다른 호출이 끼어 번호가 어긋날 수 있습니다.
     *
     * @return 잡았으면 그날 호출 수(1 이상), 상한에 닿았으면(또는 {@code cap ≤ 0}) empty — 아무것도 바꾸지 않음
     */
    public Optional<Integer> reserveApiCallNumber(LocalDate day, int cap) {
        if (cap <= 0) {
            return Optional.empty();
        }
        return jdbc.query("INSERT INTO paper_api_usage (day, calls) VALUES (?, 1) "
                        + "ON CONFLICT (day) DO UPDATE SET calls = paper_api_usage.calls + 1 "
                        + "WHERE paper_api_usage.calls < ? RETURNING calls",
                (rs, rowNum) -> rs.getInt("calls"), Date.valueOf(day), cap).stream().findFirst();
    }

    /** 잡아 둔 호출 한 번을 돌려놓습니다 — 키가 없어 요청을 보내지도 않은 경우. 0 아래로는 내리지 않습니다. */
    public void releaseApiCall(LocalDate day) {
        jdbc.update("UPDATE paper_api_usage SET calls = GREATEST(calls - 1, 0) WHERE day = ?", Date.valueOf(day));
    }

    /**
     * 그날 사용량에 토큰을 더합니다(호출 수는 그대로 — {@link #reserveApiCall}이 셈). null인 값은 더하지 않습니다 — 응답이 없거나
     * API가 알려 주지 않은 토큰을 지어내지 않습니다(호출별 원값은 결정 기록의 {@code usage}에 null 그대로 남음).
     */
    public void addApiTokens(LocalDate day, Long inputTokens, Long outputTokens, Long cacheReadTokens,
                             Long cacheWriteTokens) {
        addApiTokens(day, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, null);
    }

    /**
     * {@link #addApiTokens(LocalDate, Long, Long, Long, Long)}에 그 호출의 추정 비용(달러)을 함께 더합니다(V11) — 추정이 있으면
     * {@code est_cost_usd = COALESCE(est_cost_usd, 0) + cost}, {@code est_cost_calls + 1}. null이면(단가를 모르는 모델·토큰을 모르는
     * 호출) 비용 열은 그대로입니다 — 추정하지 않은 호출을 0달러로 세지 않습니다. 토큰과 비용을 한 문장으로 써 둘이 어긋나지 않습니다.
     *
     * @throws IllegalArgumentException 비용이 NaN·무한대·음수(계산 오류를 장부에 남기지 않음)
     */
    public void addApiTokens(LocalDate day, Long inputTokens, Long outputTokens, Long cacheReadTokens,
                             Long cacheWriteTokens, Double estCostUsd) {
        if (estCostUsd != null && (!Double.isFinite(estCostUsd) || estCostUsd < 0)) {
            throw new IllegalArgumentException("est_cost_usd 값이 0 이상의 유한한 수가 아닙니다: " + estCostUsd);
        }
        jdbc.update("INSERT INTO paper_api_usage (day, calls, input_tokens, output_tokens, cache_read_tokens, "
                        + "cache_write_tokens, est_cost_usd, est_cost_calls) VALUES (?, 0, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (day) DO UPDATE SET "
                        + "input_tokens = paper_api_usage.input_tokens + EXCLUDED.input_tokens, "
                        + "output_tokens = paper_api_usage.output_tokens + EXCLUDED.output_tokens, "
                        + "cache_read_tokens = paper_api_usage.cache_read_tokens + EXCLUDED.cache_read_tokens, "
                        + "cache_write_tokens = paper_api_usage.cache_write_tokens + EXCLUDED.cache_write_tokens, "
                        + "est_cost_usd = CASE WHEN EXCLUDED.est_cost_usd IS NULL THEN paper_api_usage.est_cost_usd "
                        + "ELSE COALESCE(paper_api_usage.est_cost_usd, 0) + EXCLUDED.est_cost_usd END, "
                        + "est_cost_calls = paper_api_usage.est_cost_calls + EXCLUDED.est_cost_calls",
                ps -> {
                    setDate(ps, 1, day);
                    ps.setLong(2, tokens(inputTokens));
                    ps.setLong(3, tokens(outputTokens));
                    ps.setLong(4, tokens(cacheReadTokens));
                    ps.setLong(5, tokens(cacheWriteTokens));
                    setMoney(ps, 6, estCostUsd, "est_cost_usd");
                    ps.setInt(7, estCostUsd == null ? 0 : 1);
                });
    }

    private static long tokens(Long value) {
        return value == null || value < 0 ? 0 : value;
    }

    // ------------------------------------------------------------------ 트랙레코드·선정
    /**
     * 트랙레코드 한 행을 넣거나 통째로 바꿉니다({@code (as_of_date, group_code, cik)} 충돌 시 갱신 — 같은 기준일의 수동
     * 재계산이 덮어씀, V9). 수치가 NaN·무한대이면 저장하지 않고 {@link IllegalArgumentException}(DOUBLE PRECISION은 NaN을 받아
     * 주므로 여기서 막음).
     */
    public void upsertTrackRecord(TrackRecordRow r) {
        String periodsJson = r.periods() == null ? null : mapper.writeValueAsString(r.periods());
        jdbc.update("INSERT INTO paper_track_record (as_of_date, cik, window_years, metric, periods_used, periods_total, "
                        + "first_filing_date, last_filing_date, cum_return_pct, cagr_pct, vol_pct, mdd_pct, sharpe, "
                        + "excess_vs_spy_pct, coverage_min, coverage_avg, eligible, ineligible_reason, rank, periods, "
                        + "settings_version, computed_at, group_code, data_source) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                        + "COALESCE(CAST(? AS jsonb), '[]'::jsonb), ?, COALESCE(CAST(? AS timestamptz), now()), ?, ?) "
                        + "ON CONFLICT (as_of_date, group_code, cik) DO UPDATE SET window_years = EXCLUDED.window_years, "
                        + "metric = EXCLUDED.metric, periods_used = EXCLUDED.periods_used, "
                        + "periods_total = EXCLUDED.periods_total, first_filing_date = EXCLUDED.first_filing_date, "
                        + "last_filing_date = EXCLUDED.last_filing_date, cum_return_pct = EXCLUDED.cum_return_pct, "
                        + "cagr_pct = EXCLUDED.cagr_pct, vol_pct = EXCLUDED.vol_pct, mdd_pct = EXCLUDED.mdd_pct, "
                        + "sharpe = EXCLUDED.sharpe, excess_vs_spy_pct = EXCLUDED.excess_vs_spy_pct, "
                        + "coverage_min = EXCLUDED.coverage_min, coverage_avg = EXCLUDED.coverage_avg, "
                        + "eligible = EXCLUDED.eligible, ineligible_reason = EXCLUDED.ineligible_reason, "
                        + "rank = EXCLUDED.rank, periods = EXCLUDED.periods, "
                        + "settings_version = EXCLUDED.settings_version, computed_at = EXCLUDED.computed_at, "
                        + "data_source = EXCLUDED.data_source",
                ps -> {
                    setDate(ps, 1, r.asOfDate());
                    ps.setString(2, r.cik());
                    ps.setInt(3, r.windowYears());
                    ps.setString(4, r.metric());
                    ps.setInt(5, r.periodsUsed());
                    ps.setInt(6, r.periodsTotal());
                    setDate(ps, 7, r.firstFilingDate());
                    setDate(ps, 8, r.lastFilingDate());
                    setStat(ps, 9, r.cumReturnPct(), "cum_return_pct");
                    setStat(ps, 10, r.cagrPct(), "cagr_pct");
                    setStat(ps, 11, r.volPct(), "vol_pct");
                    setStat(ps, 12, r.mddPct(), "mdd_pct");
                    setStat(ps, 13, r.sharpe(), "sharpe");
                    setStat(ps, 14, r.excessVsSpyPct(), "excess_vs_spy_pct");
                    setStat(ps, 15, r.coverageMin(), "coverage_min");
                    setStat(ps, 16, r.coverageAvg(), "coverage_avg");
                    ps.setBoolean(17, r.eligible());
                    ps.setString(18, r.ineligibleReason());
                    setInteger(ps, 19, r.rank());
                    ps.setString(20, periodsJson);
                    ps.setInt(21, r.settingsVersion());
                    setInstant(ps, 22, r.computedAt());
                    ps.setString(23, r.groupCode());
                    ps.setString(24, r.dataSource());
                });
    }

    /** {@link #deleteTrackRecords(LocalDate, String)} — 그룹 A. */
    public int deleteTrackRecords(LocalDate asOf) {
        return deleteTrackRecords(asOf, TrackRecordRow.GROUP_A);
    }

    /**
     * 그 기준일·그 그룹의 트랙레코드를 모두 지웁니다 — 다시 계산할 때 후보 목록이 줄었으면 빠진 기관의 옛 행이 남지 않게,
     * {@link #atomically} 안에서 지우고 새로 넣습니다. 다른 그룹의 행은 그대로입니다.
     *
     * @return 지운 행 수
     * @throws IllegalArgumentException 그룹이 A·B가 아님
     */
    public int deleteTrackRecords(LocalDate asOf, String groupCode) {
        return jdbc.update("DELETE FROM paper_track_record WHERE as_of_date = ? AND group_code = ?", Date.valueOf(asOf),
                TrackRecordRow.requireGroup(groupCode));
    }

    /** {@link #trackRecords(LocalDate, String)} — 그룹 A. */
    public List<TrackRecordRow> trackRecords(LocalDate asOf) {
        return trackRecords(asOf, TrackRecordRow.GROUP_A);
    }

    /**
     * 그 기준일·그 그룹의 트랙레코드, 순위 순(자격 없는 기관은 뒤, CIK 순). 계산한 적 없으면 빈 목록.
     *
     * @throws IllegalArgumentException 그룹이 A·B가 아님
     */
    public List<TrackRecordRow> trackRecords(LocalDate asOf, String groupCode) {
        return jdbc.query("SELECT " + TRACK_RECORD_COLUMNS + " FROM paper_track_record WHERE as_of_date = ? "
                        + "AND group_code = ? ORDER BY rank NULLS LAST, cik",
                (rs, rowNum) -> new TrackRecordRow(date(rs, "as_of_date"), rs.getString("cik"),
                        rs.getInt("window_years"), rs.getString("metric"), rs.getInt("periods_used"),
                        rs.getInt("periods_total"), date(rs, "first_filing_date"), date(rs, "last_filing_date"),
                        stat(rs, "cum_return_pct"), stat(rs, "cagr_pct"), stat(rs, "vol_pct"), stat(rs, "mdd_pct"),
                        stat(rs, "sharpe"), stat(rs, "excess_vs_spy_pct"), stat(rs, "coverage_min"),
                        stat(rs, "coverage_avg"), rs.getBoolean("eligible"), rs.getString("ineligible_reason"),
                        rs.getObject("rank", Integer.class), json(rs, "periods"), rs.getInt("settings_version"),
                        instant(rs, "computed_at"), rs.getString("group_code"), rs.getString("data_source")),
                Date.valueOf(asOf), TrackRecordRow.requireGroup(groupCode));
    }

    /** {@link #latestTrackRecordAsOf(String)} — 그룹 A. */
    public Optional<LocalDate> latestTrackRecordAsOf() {
        return latestTrackRecordAsOf(TrackRecordRow.GROUP_A);
    }

    /**
     * 그 그룹의 트랙레코드를 계산한 가장 늦은 기준일. 한 번도 없으면 empty.
     *
     * @throws IllegalArgumentException 그룹이 A·B가 아님
     */
    public Optional<LocalDate> latestTrackRecordAsOf(String groupCode) {
        List<LocalDate> rows = jdbc.query("SELECT max(as_of_date) AS as_of_date FROM paper_track_record "
                        + "WHERE group_code = ?", (rs, rowNum) -> date(rs, "as_of_date"),
                TrackRecordRow.requireGroup(groupCode));
        return rows.isEmpty() ? Optional.empty() : Optional.ofNullable(rows.get(0));
    }

    /**
     * 선정이 그 기준일에 아직 없을 때만 넣습니다({@code ON CONFLICT DO NOTHING}). 선정은 재선정일·초기 선정 때 한 번이고,
     * 같은 기준일을 다시 계산해도(수동 재계산) 바꾸지 않습니다 — 그 선정으로 낸 주문 기록과 어긋나지 않게(설계 §4-0 ⑤).
     *
     * @return 이번에 넣었으면 true, 이미 있었으면 false(기존 선정 그대로)
     */
    public boolean insertSelectionIfAbsent(Selection s) {
        String rankingJson = s.ranking() == null ? null : mapper.writeValueAsString(s.ranking());
        String[] ciks = s.selectedCiks().toArray(new String[0]);
        return jdbc.update("INSERT INTO paper_selection_log (as_of_date, selected_ciks, ranking, settings_version) "
                        + "VALUES (?, ?, COALESCE(CAST(? AS jsonb), '[]'::jsonb), ?) ON CONFLICT (as_of_date) DO NOTHING",
                ps -> {
                    setDate(ps, 1, s.asOfDate());
                    ps.setArray(2, ps.getConnection().createArrayOf("text", ciks));
                    ps.setString(3, rankingJson);
                    ps.setInt(4, s.settingsVersion());
                }) == 1;
    }

    /** 모든 선정, 최근 기준일 순. */
    public List<Selection> selections() {
        return jdbc.query("SELECT " + SELECTION_COLUMNS + " FROM paper_selection_log ORDER BY as_of_date DESC",
                selectionMapper());
    }

    /** 그날(포함) 이전의 가장 최근 선정 — 그날 유효한 선정. 없으면 empty. */
    public Optional<Selection> selectionOnOrBefore(LocalDate date) {
        return jdbc.query("SELECT " + SELECTION_COLUMNS + " FROM paper_selection_log WHERE as_of_date <= ? "
                + "ORDER BY as_of_date DESC LIMIT 1", selectionMapper(), Date.valueOf(date)).stream().findFirst();
    }

    // ------------------------------------------------------------------ 결정
    /**
     * 결정을 (책, 기준 거래일, 종류)에 아직 없을 때만 넣습니다({@code ON CONFLICT DO NOTHING}) — 결정 작업이 같은 거래일에
     * 두 번 돌아도 결정은 한 건입니다(수용 기준). {@code id}는 무시하고 DB가 매기며, {@code decidedAt}이 null이면 지금입니다.
     *
     * @return 이번에 넣었으면 새 번호, 이미 있었으면 empty(기존 결정은 그대로 — {@link #decisionFor}로 읽음)
     */
    public Optional<Long> insertDecisionIfAbsent(Decision d) {
        String packet = d.packet() == null ? null : mapper.writeValueAsString(d.packet());
        String response = d.response() == null ? null : mapper.writeValueAsString(d.response());
        String usage = d.usage() == null ? null : mapper.writeValueAsString(d.usage());
        List<Long> ids = jdbc.query("INSERT INTO paper_decisions (book_code, as_of_trading_date, kind, decided_at, status, "
                        + "model, framework_version, settings_version, selection_as_of, target_exposure_pct, packet, "
                        + "packet_hash, response_raw, response, usage, error, note_ids, prices_final, latency_ms, "
                        + "retry_count, packet_text) VALUES (?, ?, ?, COALESCE(CAST(? AS timestamptz), now()), ?, ?, ?, "
                        + "?, ?, ?, CAST(? AS jsonb), ?, ?, CAST(? AS jsonb), CAST(? AS jsonb), ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT (book_code, as_of_trading_date, kind) DO NOTHING RETURNING id",
                ps -> {
                    ps.setString(1, d.bookCode());
                    setDate(ps, 2, d.asOfTradingDate());
                    ps.setString(3, d.kind());
                    setInstant(ps, 4, d.decidedAt());
                    ps.setString(5, d.status());
                    ps.setString(6, d.model());
                    setInteger(ps, 7, d.frameworkVersion());
                    ps.setInt(8, d.settingsVersion());
                    setDate(ps, 9, d.selectionAsOf());
                    setMoney(ps, 10, d.targetExposurePct(), "target_exposure_pct");
                    ps.setString(11, packet);
                    ps.setString(12, d.packetHash());
                    ps.setString(13, d.responseRaw());
                    ps.setString(14, response);
                    ps.setString(15, usage);
                    ps.setString(16, d.error());
                    if (d.noteIds() == null) {
                        ps.setNull(17, Types.ARRAY);
                    } else {
                        ps.setArray(17, ps.getConnection().createArrayOf("bigint", d.noteIds().toArray()));
                    }
                    ps.setBoolean(18, d.pricesFinal());
                    setLong(ps, 19, d.latencyMs());
                    ps.setInt(20, d.retryCount());
                    ps.setString(21, d.packetText());
                },
                (rs, rowNum) -> rs.getLong("id"));
        return ids.stream().findFirst();
    }

    public Optional<Decision> decision(long id) {
        return jdbc.query("SELECT " + DECISION_COLUMNS + " FROM paper_decisions WHERE id = ?", decisionMapper(), id)
                .stream().findFirst();
    }

    /** 그 (책, 기준 거래일, 종류)의 결정. 없으면 empty. */
    public Optional<Decision> decisionFor(String code, LocalDate tradingDate, String kind) {
        return jdbc.query("SELECT " + DECISION_COLUMNS + " FROM paper_decisions "
                        + "WHERE book_code = ? AND as_of_trading_date = ? AND kind = ?", decisionMapper(), code,
                Date.valueOf(tradingDate), kind).stream().findFirst();
    }

    /**
     * 한 책에서 그 종류들의 결정 중 그 선정(기준일 {@code selection_as_of})으로 낸 것이 있나 — 결정 작업이 "이 분기 재선정일 r의
     * 선정으로 매수 결정(REBALANCE·INITIAL)을 냈나"를 봅니다. 날짜가 아니라 선정으로 보는 것은, r에 선정을 건너뛰면 그날
     * REBALANCE가 지난 선정으로(매수 없이) 남기 때문입니다. 종류가 비었거나 선정 기준일이 null이면 false.
     */
    public boolean hasDecisionWithSelection(String code, Collection<String> kinds, LocalDate selectionAsOf) {
        if (kinds == null || kinds.isEmpty() || selectionAsOf == null) {
            return false;
        }
        List<Object> args = new ArrayList<>();
        args.add(code);
        args.add(Date.valueOf(selectionAsOf));
        args.addAll(kinds);
        String marks = String.join(", ", Collections.nCopies(kinds.size(), "?"));
        Boolean found = jdbc.queryForObject("SELECT EXISTS (SELECT 1 FROM paper_decisions WHERE book_code = ? "
                + "AND selection_as_of = ? AND kind IN (" + marks + "))", Boolean.class, args.toArray());
        return Boolean.TRUE.equals(found);
    }

    /**
     * 한 책에서 그 종류·상태의 결정이 있는 기준 거래일(오름차순, 같은 날은 한 번) — 한국 규칙 계좌의 재선정 따라잡기(2단계 명세 K33)가 "그 주기에
     * 매수 결정(상태 OK인 REBALANCE·INITIAL)을 냈나"를 날짜 범위로 봅니다({@code analytics.KrReselection}). {@code from}이 있으면 그날(포함)
     * 뒤만 — 리셋 전의 다른 출발 기록을 세지 않게 출발일을 넘깁니다. 종류가 비었으면 빈 목록.
     */
    public List<LocalDate> decisionDates(String code, Collection<String> kinds, String status, LocalDate from) {
        if (kinds == null || kinds.isEmpty()) {
            return List.of();
        }
        List<Object> args = new ArrayList<>();
        args.add(code);
        args.add(status);
        args.addAll(kinds);
        String marks = String.join(", ", Collections.nCopies(kinds.size(), "?"));
        String since = "";
        if (from != null) {
            since = " AND as_of_trading_date >= ?";
            args.add(Date.valueOf(from));
        }
        return jdbc.query("SELECT DISTINCT as_of_trading_date FROM paper_decisions WHERE book_code = ? AND status = ? "
                        + "AND kind IN (" + marks + ")" + since + " ORDER BY as_of_trading_date",
                (rs, rowNum) -> rs.getDate("as_of_trading_date").toLocalDate(), args.toArray());
    }

    /** 한 책의 최근 결정 {@code limit}건 — 기준 거래일 최근 순(같은 날이면 나중에 낸 것 먼저). */
    /**
     * 한국 규칙 계좌의 거래일별 주식 비중(%) — 그날 결정 응답 {@code holdings[]}의 {@code weightPct} 합에서 현금성 종목을 뺀 값(2단계 명세 §3·K40의
     * '전날 규칙 계좌 주식 비중', 노출 맞춘 참고선이 씀). 결정 응답 전체를 읽지 않고 DB에서 합만 읽습니다(개요를 60초마다 읽어도 가볍게). 같은 날
     * 결정이 여럿이면 나중 결정(결정 시각·번호 순)입니다. 응답에 {@code holdings} 배열이 없는 결정(기한 지남 NO_TRADE·일시정지 SKIPPED 등)은
     * 세지 않고, 현금성 밖 보유에 비중을 모르는(숫자가 아닌) 줄이 있으면 그날은 뺍니다(모르는 비중을 0으로 채우지 않음). 보유가 없으면 0.
     *
     * @param cashLike 뺄 현금성 종목 코드(설정 {@code kr.cashLikeTickers})
     * @return 거래일 → 주식 비중(%), 거래일 오름차순
     */
    public java.util.NavigableMap<LocalDate, BigDecimal> ruleStockWeights(String bookCode, Collection<String> cashLike) {
        String[] excluded = cashLike.toArray(String[]::new);
        TreeMap<LocalDate, BigDecimal> out = new TreeMap<>();
        jdbc.query("""
                SELECT trading_date, stock_weight FROM (
                  SELECT DISTINCT ON (d.as_of_trading_date) d.as_of_trading_date AS trading_date,
                         (SELECT CASE WHEN bool_or(jsonb_typeof(h->'weightPct') IS DISTINCT FROM 'number') THEN NULL
                                      ELSE COALESCE(SUM((h->>'weightPct')::numeric), 0) END
                            FROM jsonb_array_elements(d.response->'holdings') h
                           WHERE NOT (COALESCE(h->>'code', '') = ANY(?))) AS stock_weight
                    FROM paper_decisions d
                   WHERE d.book_code = ? AND jsonb_typeof(d.response->'holdings') = 'array'
                   ORDER BY d.as_of_trading_date, d.decided_at DESC, d.id DESC
                ) latest WHERE stock_weight IS NOT NULL ORDER BY trading_date
                """, ps -> {
                    ps.setArray(1, ps.getConnection().createArrayOf("text", excluded));
                    ps.setString(2, bookCode);
                }, (RowCallbackHandler) rs ->
                        out.put(rs.getDate("trading_date").toLocalDate(), rs.getBigDecimal("stock_weight")));
        return out;
    }

    public List<DecisionSummary> decisions(String code, int limit) {
        return jdbc.query("SELECT " + DECISION_SUMMARY_COLUMNS + " FROM paper_decisions d WHERE d.book_code = ? "
                        + "ORDER BY d.as_of_trading_date DESC, d.decided_at DESC, d.id DESC LIMIT ?",
                (rs, rowNum) -> new DecisionSummary(rs.getLong("id"), rs.getString("book_code"),
                        date(rs, "as_of_trading_date"), rs.getString("kind"), instant(rs, "decided_at"),
                        rs.getString("status"), rs.getString("model"), rs.getObject("framework_version", Integer.class),
                        rs.getInt("settings_version"), date(rs, "selection_as_of"),
                        nullableDouble(rs, "target_exposure_pct"), rs.getString("summary"), rs.getString("error"),
                        rs.getBoolean("prices_final"), rs.getInt("order_count"), rs.getInt("rejected_count")),
                code, limit);
    }

    /**
     * 결정의 상태·응답·오류를 바꿉니다(응답이 null이면 그대로 둠). 결정 행을 먼저 넣어 번호를 받고 그 번호로 주문·체결을 낸 뒤,
     * 체결 결과(사후 체결의 체결가·건너뛴 종목)를 같은 기록에 덧붙일 때 씁니다.
     */
    public void updateDecision(long id, String status, JsonNode response, String error) {
        String json = response == null ? null : mapper.writeValueAsString(response);
        jdbc.update("UPDATE paper_decisions SET status = ?, response = COALESCE(CAST(? AS jsonb), response), error = ? "
                + "WHERE id = ?", ps -> {
                    ps.setString(1, status);
                    ps.setString(2, json);
                    ps.setString(3, error);
                    ps.setLong(4, id);
                });
    }

    /**
     * API 오류로 끝난 결정을 <b>같은 행</b>에서 한 번 더 낸 결과로 바꿉니다(재시도, 명세 C7 "같은 거래일에 한 번"). 그 행이 아직
     * {@code status = 'API_ERROR'}이고 {@code retry_count = 0}일 때만 바꾸고 {@code retry_count}를 1 올립니다 — 두 곳에서 동시에
     * 재시도해도 한 번만 반영됩니다. 번호·책·거래일·종류는 그대로이고, 나머지 열은 {@code d}의 값으로 통째로 씁니다
     * ({@code decidedAt}이 null이면 지금).
     *
     * @return 바꿨으면 true, 이미 재시도했거나 상태가 바뀌었으면 false(아무것도 바꾸지 않음)
     */
    public boolean updateDecisionRetry(Decision d) {
        String packet = d.packet() == null ? null : mapper.writeValueAsString(d.packet());
        String response = d.response() == null ? null : mapper.writeValueAsString(d.response());
        String usage = d.usage() == null ? null : mapper.writeValueAsString(d.usage());
        return jdbc.update("UPDATE paper_decisions SET decided_at = COALESCE(CAST(? AS timestamptz), now()), status = ?, "
                        + "model = ?, framework_version = ?, settings_version = ?, selection_as_of = ?, "
                        + "target_exposure_pct = ?, packet = CAST(? AS jsonb), packet_hash = ?, response_raw = ?, "
                        + "response = CAST(? AS jsonb), usage = CAST(? AS jsonb), error = ?, note_ids = ?, prices_final = ?, "
                        + "latency_ms = ?, packet_text = ?, retry_count = retry_count + 1 "
                        + "WHERE id = ? AND status = 'API_ERROR' AND retry_count = 0",
                ps -> {
                    setInstant(ps, 1, d.decidedAt());
                    ps.setString(2, d.status());
                    ps.setString(3, d.model());
                    setInteger(ps, 4, d.frameworkVersion());
                    ps.setInt(5, d.settingsVersion());
                    setDate(ps, 6, d.selectionAsOf());
                    setMoney(ps, 7, d.targetExposurePct(), "target_exposure_pct");
                    ps.setString(8, packet);
                    ps.setString(9, d.packetHash());
                    ps.setString(10, d.responseRaw());
                    ps.setString(11, response);
                    ps.setString(12, usage);
                    ps.setString(13, d.error());
                    if (d.noteIds() == null) {
                        ps.setNull(14, Types.ARRAY);
                    } else {
                        ps.setArray(14, ps.getConnection().createArrayOf("bigint", d.noteIds().toArray()));
                    }
                    ps.setBoolean(15, d.pricesFinal());
                    setLong(ps, 16, d.latencyMs());
                    ps.setString(17, d.packetText());
                    ps.setLong(18, d.id());
                }) == 1;
    }

    // ------------------------------------------------------------------ 게이트 지표
    /**
     * 그 거래일의 게이트 지표가 아직 없을 때만 넣습니다({@code ON CONFLICT DO NOTHING}) — 거래일마다 한 번 계산하고(연속 일수가
     * 두 번 세지지 않게), 같은 날 다시 돌아도 처음 값이 남습니다.
     *
     * @return 이번에 넣었으면 true
     */
    public boolean insertGateIfAbsent(GateRow g) {
        String inputs = mapper.writeValueAsString(g.inputs());
        String streaks = g.streaks() == null ? null : mapper.writeValueAsString(g.streaks());
        return jdbc.update("INSERT INTO paper_gate_log (trading_date, inputs, level, streaks) "
                        + "VALUES (?, CAST(? AS jsonb), ?, COALESCE(CAST(? AS jsonb), '{}'::jsonb)) "
                        + "ON CONFLICT (trading_date) DO NOTHING",
                ps -> {
                    setDate(ps, 1, g.tradingDate());
                    ps.setString(2, inputs);
                    ps.setString(3, g.level());
                    ps.setString(4, streaks);
                }) == 1;
    }

    /** 그 거래일의 게이트 지표. 없으면 empty. */
    public Optional<GateRow> gate(LocalDate tradingDate) {
        return jdbc.query("SELECT " + GATE_COLUMNS + " FROM paper_gate_log WHERE trading_date = ?", gateMapper(),
                Date.valueOf(tradingDate)).stream().findFirst();
    }

    /** 그 거래일보다 앞선 가장 최근 게이트 지표(연속 일수를 이어 셀 직전 기록). 없으면 empty. */
    public Optional<GateRow> latestGateBefore(LocalDate tradingDate) {
        return jdbc.query("SELECT " + GATE_COLUMNS + " FROM paper_gate_log WHERE trading_date < ? "
                + "ORDER BY trading_date DESC LIMIT 1", gateMapper(), Date.valueOf(tradingDate)).stream().findFirst();
    }

    /** 최근 게이트 지표 {@code limit}건, 최근 거래일 순. */
    public List<GateRow> recentGate(int limit) {
        return jdbc.query("SELECT " + GATE_COLUMNS + " FROM paper_gate_log ORDER BY trading_date DESC LIMIT ?",
                gateMapper(), limit);
    }

    // ------------------------------------------------------------------ 출발일 종가
    /** 얼려 둔 출발일 종가 하나. 없으면 empty(그 거래일이 맞는지는 부르는 쪽이 봅니다). */
    public Optional<StartPrice> startPrice(String ticker) {
        return jdbc.query("SELECT " + START_PRICE_COLUMNS + " FROM paper_start_prices WHERE ticker = ?",
                startPriceMapper(), ticker).stream().findFirst();
    }

    /** 얼려 둔 출발일 종가 전부, ticker 순. */
    public List<StartPrice> startPrices() {
        return jdbc.query("SELECT " + START_PRICE_COLUMNS + " FROM paper_start_prices ORDER BY ticker",
                startPriceMapper());
    }

    /**
     * 그 종목의 출발일 종가가 아직 없을 때만 넣습니다. <b>같은 거래일의 값은 절대 덮지 않습니다</b> — 처음 얼린 값이 기준이고,
     * 그 뒤 수정주가 이력이 배당락으로 낮아져도 사후 체결·리셋이 같은 값을 쓰게 하려는 것입니다(V8 주석). 다른 거래일의
     * 행(출발일 설정을 바꾼 경우)은 그 날짜에는 쓸 수 없는 값이라 새 값으로 바꿉니다.
     *
     * @return 이번에 넣었거나 바꿨으면 true, 같은 거래일 값이 이미 있었으면 false(기존 값 그대로)
     */
    public boolean insertStartPriceIfAbsent(StartPrice p) {
        return jdbc.update("INSERT INTO paper_start_prices (ticker, trading_date, close, source, captured_at) "
                        + "VALUES (?, ?, ?, ?, COALESCE(CAST(? AS timestamptz), now())) "
                        + "ON CONFLICT (ticker) DO UPDATE SET trading_date = EXCLUDED.trading_date, "
                        + "close = EXCLUDED.close, source = EXCLUDED.source, captured_at = EXCLUDED.captured_at "
                        + "WHERE paper_start_prices.trading_date <> EXCLUDED.trading_date",
                ps -> {
                    ps.setString(1, p.ticker());
                    setDate(ps, 2, p.tradingDate());
                    ps.setBigDecimal(3, money(p.close(), "close"));
                    ps.setString(4, p.source());
                    setInstant(ps, 5, p.capturedAt());
                }) == 1;
    }

    // ------------------------------------------------------------------ 투자 OS 프레임
    /**
     * 판 하나를 그 번호가 아직 없을 때만 넣습니다({@code ON CONFLICT (version) DO NOTHING}) — 임시 v0 시드가 여러 번(동시에) 불려도
     * 한 행이고, 새 판 저장이 같은 번호와 겹치면 기존 판을 덮지 않습니다. {@code createdAt}은 쓰지 않고 DB가 채웁니다.
     *
     * @return 이번에 넣었으면 true, 그 번호가 이미 있었으면 false(기존 판 그대로)
     */
    public boolean insertFrameworkVersionIfAbsent(FrameworkVersion v) {
        String body = mapper.writeValueAsString(v.body());
        return jdbc.update("INSERT INTO paper_framework_versions (version, body, rendered, rendered_tokens_est, changelog, "
                        + "source_proposal_id) VALUES (?, CAST(? AS jsonb), ?, ?, ?, ?) ON CONFLICT (version) DO NOTHING",
                ps -> {
                    ps.setInt(1, v.version());
                    ps.setString(2, body);
                    ps.setString(3, v.rendered());
                    ps.setInt(4, v.renderedTokensEst());
                    ps.setString(5, v.changelog());
                    setLong(ps, 6, v.sourceProposalId());
                }) == 1;
    }

    /** 지금 판 — 가장 큰 번호. 판이 하나도 없으면 empty(서비스가 임시 v0을 시드). */
    public Optional<FrameworkVersion> currentFramework() {
        return jdbc.query("SELECT " + FRAMEWORK_COLUMNS + " FROM paper_framework_versions ORDER BY version DESC LIMIT 1",
                frameworkMapper()).stream().findFirst();
    }

    /** 그 번호의 판. 없으면 empty. */
    public Optional<FrameworkVersion> frameworkVersion(int version) {
        return jdbc.query("SELECT " + FRAMEWORK_COLUMNS + " FROM paper_framework_versions WHERE version = ?",
                frameworkMapper(), version).stream().findFirst();
    }

    /**
     * 모든 판의 본문, 번호 순 — 렌더링은 읽지 않습니다. 새 원칙·규칙 번호가 지운 id를 다시 쓰지 않게 서비스가 "쓴 적 있는 가장 큰 번호"를
     * 모을 때 씁니다.
     */
    public List<JsonNode> frameworkBodies() {
        return jdbc.query("SELECT body::text AS body FROM paper_framework_versions ORDER BY version",
                (rs, rowNum) -> json(rs, "body"));
    }

    /** 판 목록, 최근 번호 순 — 본문·렌더링은 읽지 않고 제목·상태만(판이 쌓여도 목록이 가볍게). */
    public List<FrameworkVersionSummary> frameworkVersions() {
        return jdbc.query("SELECT version, body->>'title' AS title, body->>'status' AS status, changelog, "
                        + "source_proposal_id, rendered_tokens_est, created_at FROM paper_framework_versions "
                        + "ORDER BY version DESC",
                (rs, rowNum) -> new FrameworkVersionSummary(rs.getInt("version"), rs.getString("title"),
                        rs.getString("status"), rs.getString("changelog"), rs.getObject("source_proposal_id", Long.class),
                        rs.getInt("rendered_tokens_est"), instant(rs, "created_at")));
    }

    /**
     * 그 책의 결정에 판마다 처음 쓰인 거래일(F5 성과 화면의 버전 경계) — 거래일 순(같은 날이면 번호 순). 판 번호가 없는 결정
     * (규칙 책·Claude를 부르지 않은 SKIPPED·3b 전 결정)은 세지 않습니다. 상태는 그 판 본문의 {@code status}(판 행이 없으면 null).
     */
    public List<FrameworkBoundary> frameworkBoundaries(String bookCode) {
        return jdbc.query("SELECT d.framework_version AS version, MIN(d.as_of_trading_date) AS trading_date, "
                        + "MAX(f.body->>'status') AS status FROM paper_decisions d "
                        + "LEFT JOIN paper_framework_versions f ON f.version = d.framework_version "
                        + "WHERE d.book_code = ? AND d.framework_version IS NOT NULL "
                        + "GROUP BY d.framework_version ORDER BY trading_date, version",
                (rs, rowNum) -> new FrameworkBoundary(date(rs, "trading_date"), rs.getInt("version"),
                        rs.getString("status")),
                bookCode);
    }

    // ------------------------------------------------------------------ 프레임 제안
    /**
     * 제안을 넣습니다(PENDING 또는 FAILED — 승인·거절은 {@link #decideProposal}). {@code id}·{@code createdAt}·{@code decidedAt}·
     * {@code resultVersion}은 무시합니다.
     *
     * @return 새 제안 번호
     * @throws IllegalArgumentException 상태가 PENDING·FAILED가 아님(결정된 제안을 바로 넣지 않음)
     */
    public long insertProposal(FrameworkProposal p) {
        if (!"PENDING".equals(p.status()) && !"FAILED".equals(p.status())) {
            throw new IllegalArgumentException("새 제안의 상태는 PENDING·FAILED입니다: " + p.status());
        }
        String response = p.response() == null ? null : mapper.writeValueAsString(p.response());
        List<Long> ids = jdbc.query("INSERT INTO paper_framework_proposals (note_id, base_version, request_text, model, "
                        + "response, response_raw, status, error) VALUES (?, ?, ?, ?, CAST(? AS jsonb), ?, ?, ?) RETURNING id",
                ps -> {
                    setLong(ps, 1, p.noteId());
                    ps.setInt(2, p.baseVersion());
                    ps.setString(3, p.requestText());
                    ps.setString(4, p.model());
                    ps.setString(5, response);
                    ps.setString(6, p.responseRaw());
                    ps.setString(7, p.status());
                    ps.setString(8, p.error());
                },
                (rs, rowNum) -> rs.getLong("id"));
        return single(ids, "제안");
    }

    public Optional<FrameworkProposal> proposal(long id) {
        return jdbc.query("SELECT " + PROPOSAL_COLUMNS + " FROM paper_framework_proposals WHERE id = ?",
                proposalMapper(), id).stream().findFirst();
    }

    /** 최근 제안 {@code limit}건, 최근 순(만든 시각, 번호). */
    public List<FrameworkProposal> recentProposals(int limit) {
        return jdbc.query("SELECT " + PROPOSAL_COLUMNS + " FROM paper_framework_proposals "
                + "ORDER BY created_at DESC, id DESC LIMIT ?", proposalMapper(), limit);
    }

    /**
     * 대기 중인 제안을 승인·거절로 바꿉니다 — {@code status = 'PENDING'}인 행만 바꾸는 한 문장이라, 두 곳에서 동시에 눌러도 한 번만
     * 반영됩니다. 승인이면 {@code resultVersion}(새 판), 거절이면 null. {@code decided_at}은 지금.
     *
     * @return 바꿨으면 true, 없거나 이미 결정됐으면 false(아무것도 바꾸지 않음)
     * @throws IllegalArgumentException 상태가 APPROVED·REJECTED가 아님
     */
    public boolean decideProposal(long id, String status, Integer resultVersion) {
        if (!"APPROVED".equals(status) && !"REJECTED".equals(status)) {
            throw new IllegalArgumentException("제안 결정은 APPROVED·REJECTED입니다: " + status);
        }
        return jdbc.update("UPDATE paper_framework_proposals SET status = ?, result_version = ?, decided_at = now() "
                + "WHERE id = ? AND status = 'PENDING'", ps -> {
                    ps.setString(1, status);
                    setInteger(ps, 2, resultVersion);
                    ps.setLong(3, id);
                }) == 1;
    }

    // ------------------------------------------------------------------ 메모
    /**
     * 메모를 넣습니다(시장은 {@link Note#market}). {@code id}·{@code createdAt}은 무시하고, {@code archived}는 늘 false로 시작합니다.
     *
     * @return 새 메모 번호
     */
    public long insertNote(Note n) {
        List<Long> ids = jdbc.query("INSERT INTO paper_notes (kind, as_of_date, expires_on, title, body, market) "
                        + "VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
                ps -> {
                    ps.setString(1, n.kind());
                    setDate(ps, 2, n.asOfDate());
                    setDate(ps, 3, n.expiresOn());
                    ps.setString(4, n.title());
                    ps.setString(5, n.body());
                    ps.setString(6, n.market());
                },
                (rs, rowNum) -> rs.getLong("id"));
        return single(ids, "메모");
    }

    /** 번호로 메모 한 건 — 시장을 가리지 않습니다(결정의 {@code note_ids}·제안의 {@code note_id}가 가리키는 행). */
    public Optional<Note> note(long id) {
        return jdbc.query("SELECT " + NOTE_COLUMNS + " FROM paper_notes WHERE id = ?", noteMapper(), id)
                .stream().findFirst();
    }

    /** 미국 메모 목록 — {@link #notes(String, boolean, LocalDate)}의 미국 판(V14 전부터 있던 시그니처). */
    public List<Note> notes(boolean includeExpired, LocalDate today) {
        return notes(Book.MARKET_US, includeExpired, today);
    }

    /**
     * 그 시장의 메모 목록, 기준일 최근 순(같으면 번호 최근 순). {@code includeExpired}가 false면 보관하지 않았고 {@code today}에 아직
     * 만료되지 않은 것만(만료일 당일까지는 유효 — 만료가 없는 INSIGHT는 늘 포함), true면 보관·만료한 것까지 전부.
     */
    public List<Note> notes(String market, boolean includeExpired, LocalDate today) {
        if (includeExpired) {
            return jdbc.query("SELECT " + NOTE_COLUMNS + " FROM paper_notes WHERE market = ? "
                    + "ORDER BY as_of_date DESC, id DESC", noteMapper(), market);
        }
        return jdbc.query("SELECT " + NOTE_COLUMNS + " FROM paper_notes WHERE market = ? AND NOT archived "
                        + "AND (expires_on IS NULL OR expires_on >= ?) ORDER BY as_of_date DESC, id DESC",
                noteMapper(), market, Date.valueOf(today));
    }

    /** 미국 패킷의 유효한 시황 메모 — {@link #activeMarketNotes(String, LocalDate)}의 미국 판(V14 전부터 있던 시그니처). */
    public List<Note> activeMarketNotes(LocalDate asOf) {
        return activeMarketNotes(Book.MARKET_US, asOf);
    }

    /**
     * 그 시장·그 거래일에 유효한 시황 메모(F6, 계약 E) — 그 시장의 MARKET이고 보관하지 않았고 기준일 ≤ {@code asOf}이고 만료가
     * 없거나 만료일 ≥ {@code asOf}. 최신부터(기준일 최근 순, 같으면 번호 최근 순). 글자 수 상한은 부르는 쪽이 셉니다.
     */
    public List<Note> activeMarketNotes(String market, LocalDate asOf) {
        return jdbc.query("SELECT " + NOTE_COLUMNS + " FROM paper_notes WHERE market = ? AND kind = 'MARKET' "
                        + "AND NOT archived AND as_of_date <= ? AND (expires_on IS NULL OR expires_on >= ?) "
                        + "ORDER BY as_of_date DESC, id DESC",
                noteMapper(), market, Date.valueOf(asOf), Date.valueOf(asOf));
    }

    /**
     * 메모를 보관합니다(지우지 않음 — 결정 기록의 {@code note_ids}·제안의 {@code note_id}가 가리키는 행이 남게). 이미 보관한
     * 메모도 그대로 참입니다(멱등). 번호로 찾으므로 시장을 가리지 않습니다.
     *
     * @return 그 번호의 메모가 있었으면 true
     */
    public boolean archiveNote(long id) {
        return jdbc.update("UPDATE paper_notes SET archived = true WHERE id = ?", id) == 1;
    }

    // ------------------------------------------------------------------ 주간 복기(V12 — V14부터 시장마다)
    /**
     * 복기를 그 시장·그 주({@link Review#market}·{@code weekEnding})에 아직 없을 때만 넣습니다({@code ON CONFLICT (market,
     * week_ending) DO NOTHING}) — 정기 작업이 30분마다 돌고 수동 실행과 겹쳐도 시장마다 한 주에 한 건입니다(명세 §3-3 "두 번 돌아도
     * 1건"). 같은 주의 다른 시장 행과는 부딪치지 않습니다. {@code createdAt}이 null이면 지금입니다.
     *
     * @return 이번에 넣었으면 true, 그 시장·그 주의 행이 이미 있었으면 false(기존 행 그대로 — {@link #review}로 읽음)
     * @throws IllegalArgumentException {@code inputText}가 JSON 문자열이 아님(읽을 때 입력을 그 문자열에서 만듦 — {@link Review})
     */
    public boolean insertReviewIfAbsent(Review r) {
        requireJsonText(r.inputText(), "input_text");
        String input = mapper.writeValueAsString(r.input());
        String response = r.response() == null ? null : mapper.writeValueAsString(r.response());
        String usage = r.usage() == null ? null : mapper.writeValueAsString(r.usage());
        return jdbc.update("INSERT INTO paper_reviews (week_ending, window_weeks, input, input_text, response, "
                        + "response_raw, model, usage, status, error, proposal_id, framework_version, retry_count, "
                        + "created_at, market) VALUES (?, ?, CAST(? AS jsonb), ?, CAST(? AS jsonb), ?, ?, CAST(? AS jsonb), "
                        + "?, ?, ?, ?, ?, COALESCE(CAST(? AS timestamptz), now()), ?) "
                        + "ON CONFLICT (market, week_ending) DO NOTHING",
                ps -> {
                    setDate(ps, 1, r.weekEnding());
                    setInteger(ps, 2, r.windowWeeks());
                    ps.setString(3, input);
                    ps.setString(4, r.inputText());
                    ps.setString(5, response);
                    ps.setString(6, r.responseRaw());
                    ps.setString(7, r.model());
                    ps.setString(8, usage);
                    ps.setString(9, r.status());
                    ps.setString(10, r.error());
                    setLong(ps, 11, r.proposalId());
                    setInteger(ps, 12, r.frameworkVersion());
                    ps.setInt(13, r.retryCount());
                    setInstant(ps, 14, r.createdAt());
                    ps.setString(15, r.market());
                }) == 1;
    }

    /** 그 주의 미국 복기 — {@link #review(String, LocalDate)}의 미국 판(V14 전부터 있던 시그니처). */
    public Optional<Review> review(LocalDate weekEnding) {
        return review(Book.MARKET_US, weekEnding);
    }

    /** 그 시장·그 주의 복기. 없으면 empty. */
    public Optional<Review> review(String market, LocalDate weekEnding) {
        return jdbc.query("SELECT " + REVIEW_COLUMNS + " FROM paper_reviews WHERE market = ? AND week_ending = ?",
                reviewMapper(), market, Date.valueOf(weekEnding)).stream().findFirst();
    }

    /** 최근 미국 복기 — {@link #reviews(String, int)}의 미국 판(V14 전부터 있던 시그니처). */
    public List<ReviewSummary> reviews(int limit) {
        return reviews(Book.MARKET_US, limit);
    }

    /** 그 시장의 최근 복기 {@code limit}건 — 주 최근 순, 큰 JSON 없이 판정 수·연결된 제안 상태와 함께({@link ReviewSummary}). */
    public List<ReviewSummary> reviews(String market, int limit) {
        return jdbc.query("SELECT " + REVIEW_SUMMARY_COLUMNS + " FROM paper_reviews r "
                        + "LEFT JOIN paper_framework_proposals p ON p.id = r.proposal_id "
                        + "WHERE r.market = ? ORDER BY r.week_ending DESC LIMIT ?",
                (rs, rowNum) -> new ReviewSummary(date(rs, "week_ending"), rs.getObject("window_weeks", Integer.class),
                        rs.getString("status"), rs.getString("model"), rs.getString("error"),
                        rs.getObject("proposal_id", Long.class), rs.getString("proposal_status"),
                        rs.getObject("framework_version", Integer.class), rs.getInt("retry_count"),
                        rs.getObject("held", Integer.class), rs.getObject("refuted", Integer.class),
                        rs.getObject("undetermined", Integer.class), instant(rs, "created_at")),
                ReviewSummary.HELD, ReviewSummary.REFUTED, ReviewSummary.UNDETERMINED, market, limit);
    }

    /**
     * API 오류로 끝난 복기를 <b>같은 행</b>에서 한 번 더 부른 결과로 바꿉니다(결정의 C7 재시도와 같은 규칙 — 형식 오류·거절은 그 주의
     * 끝). 그 시장·그 주의 행이 아직 {@code status = 'API_ERROR'}이고 {@code retry_count = 0}일 때만 바꾸고 {@code retry_count}를 1
     * 올립니다 — 정기 작업과 수동 실행이 동시에 재시도해도 한 번만 반영됩니다. 시장·주는 그대로이고 나머지 열은 {@code r}의 값으로
     * 통째로 씁니다({@code createdAt}이 null이면 지금 — 남은 내용을 만든 시각).
     *
     * @return 바꿨으면 true, 이미 재시도했거나 상태가 API 오류가 아니거나 그 시장·그 주의 행이 없으면 false(아무것도 바꾸지 않음)
     * @throws IllegalArgumentException {@code inputText}가 JSON 문자열이 아님
     */
    public boolean updateReviewRetry(Review r) {
        requireJsonText(r.inputText(), "input_text");
        String input = mapper.writeValueAsString(r.input());
        String response = r.response() == null ? null : mapper.writeValueAsString(r.response());
        String usage = r.usage() == null ? null : mapper.writeValueAsString(r.usage());
        return jdbc.update("UPDATE paper_reviews SET window_weeks = ?, input = CAST(? AS jsonb), input_text = ?, "
                        + "response = CAST(? AS jsonb), response_raw = ?, model = ?, usage = CAST(? AS jsonb), status = ?, "
                        + "error = ?, proposal_id = ?, framework_version = ?, retry_count = retry_count + 1, "
                        + "created_at = COALESCE(CAST(? AS timestamptz), now()) "
                        + "WHERE market = ? AND week_ending = ? AND status = 'API_ERROR' AND retry_count = 0",
                ps -> {
                    setInteger(ps, 1, r.windowWeeks());
                    ps.setString(2, input);
                    ps.setString(3, r.inputText());
                    ps.setString(4, response);
                    ps.setString(5, r.responseRaw());
                    ps.setString(6, r.model());
                    ps.setString(7, usage);
                    ps.setString(8, r.status());
                    ps.setString(9, r.error());
                    setLong(ps, 10, r.proposalId());
                    setInteger(ps, 11, r.frameworkVersion());
                    setInstant(ps, 12, r.createdAt());
                    ps.setString(13, r.market());
                    setDate(ps, 14, r.weekEnding());
                }) == 1;
    }

    /** 미국 복기에 제안을 잇습니다 — {@link #linkReviewProposal(String, LocalDate, long)}의 미국 판(V14 전부터 있던 시그니처). */
    public boolean linkReviewProposal(LocalDate weekEnding, long proposalId) {
        return linkReviewProposal(Book.MARKET_US, weekEnding, proposalId);
    }

    /**
     * 그 시장·그 주의 복기에 그 복기가 낸 프레임 제안을 잇습니다 — 아직 이은 제안이 없을 때만(한 복기에 제안은 하나, 먼저 이은 것을
     * 덮지 않음). 제안을 넣은 뒤 번호를 받아 부르거나, 복기 행과 함께 {@link #atomically} 안에서 부릅니다.
     *
     * @return 이었으면 true, 그 시장·그 주의 행이 없거나 이미 이은 제안이 있으면 false
     */
    public boolean linkReviewProposal(String market, LocalDate weekEnding, long proposalId) {
        return jdbc.update("UPDATE paper_reviews SET proposal_id = ? WHERE market = ? AND week_ending = ? "
                + "AND proposal_id IS NULL", proposalId, market, Date.valueOf(weekEnding)) == 1;
    }

    /** 입력 문자열이 JSON인가 — 아니면 읽을 때마다 깨지므로 넣을 때 막습니다(null은 "보내지 않음"이라 통과). */
    private void requireJsonText(String text, String column) {
        if (text == null) {
            return;
        }
        try {
            mapper.readTree(text);
        } catch (JacksonException e) {
            throw new IllegalArgumentException(column + "는 입력 JSON 문자열이어야 합니다(구분자·안내 문장 빼고): "
                    + e.getOriginalMessage());
        }
    }

    // ------------------------------------------------------------------ 초기화
    /**
     * 한 책의 장부를 비웁니다 — 체결·주문·결정·보유·재진입 금지·순자산·상태를 한 트랜잭션으로 지웁니다. 책 행(상태·출발일)은
     * 그대로 두니 호출자가 {@link #updateBookStatus}·{@link #updateBookStartedOn}·{@link #upsertState}로 다시 맞춥니다.
     * 작업 기록·설정·얼려 둔 출발일 종가는 책에 속하지 않아 남깁니다(다시 사후 체결할 때 같은 종가를 쓰려고).
     */
    public void resetBook(String code) {
        atomically(() -> {
            // 외래키 방향(체결 → 주문 → 결정)대로 아래에서부터 지웁니다.
            for (String table : List.of("paper_fills", "paper_orders", "paper_decisions", "paper_positions",
                    "paper_lockouts", "paper_nav_daily", "paper_book_state")) {
                jdbc.update("DELETE FROM " + table + " WHERE book_code = ?", code);
            }
            return null;
        });
    }

    // ------------------------------------------------------------------ 매핑
    private static RowMapper<Book> bookMapper() {
        return (rs, rowNum) -> new Book(rs.getString("code"), rs.getString("kind"), rs.getString("label"),
                rs.getDouble("initial_cash"), date(rs, "started_on"), rs.getString("status"),
                instant(rs, "created_at"), rs.getString("market"), rs.getString("currency"));
    }

    private RowMapper<Order> orderMapper() {
        return (rs, rowNum) -> new Order(rs.getLong("id"), rs.getString("book_code"),
                rs.getObject("decision_id", Long.class), rs.getString("ticker"), rs.getString("side"),
                rs.getObject("qty", Integer.class), nullableDouble(rs, "target_weight_pct"),
                nullableDouble(rs, "sell_fraction"), rs.getString("timing"), rs.getString("source"),
                rs.getString("status"), rs.getString("reject_reason"), json(rs, "reason"),
                date(rs, "as_of_trading_date"), instant(rs, "created_at"), date(rs, "expires_on"),
                instant(rs, "filled_at"));
    }

    private static RowMapper<StartPrice> startPriceMapper() {
        return (rs, rowNum) -> new StartPrice(rs.getString("ticker"), date(rs, "trading_date"), rs.getDouble("close"),
                rs.getString("source"), instant(rs, "captured_at"));
    }

    private RowMapper<Selection> selectionMapper() {
        return (rs, rowNum) -> {
            java.sql.Array array = rs.getArray("selected_ciks");
            List<String> ciks = array == null ? List.of() : List.of((String[]) array.getArray());
            return new Selection(date(rs, "as_of_date"), ciks, json(rs, "ranking"), rs.getInt("settings_version"),
                    instant(rs, "created_at"));
        };
    }

    private RowMapper<Decision> decisionMapper() {
        return (rs, rowNum) -> {
            java.sql.Array array = rs.getArray("note_ids");
            List<Long> noteIds = null;
            if (array != null) {
                noteIds = new java.util.ArrayList<>();
                for (Object id : (Object[]) array.getArray()) {
                    noteIds.add(((Number) id).longValue());
                }
            }
            String packet = rs.getString("packet");
            return new Decision(rs.getLong("id"), rs.getString("book_code"), date(rs, "as_of_trading_date"),
                    rs.getString("kind"), instant(rs, "decided_at"), rs.getString("status"), rs.getString("model"),
                    rs.getObject("framework_version", Integer.class), rs.getInt("settings_version"),
                    date(rs, "selection_as_of"), nullableDouble(rs, "target_exposure_pct"),
                    packet == null ? null : mapper.readTree(packet), rs.getString("packet_hash"),
                    rs.getString("response_raw"), json(rs, "response"), json(rs, "usage"), rs.getString("error"),
                    noteIds, rs.getBoolean("prices_final"), rs.getObject("latency_ms", Long.class),
                    rs.getInt("retry_count"), rs.getBoolean("packet_text_stored") ? packet : null);
        };
    }

    private RowMapper<FrameworkVersion> frameworkMapper() {
        return (rs, rowNum) -> new FrameworkVersion(rs.getInt("version"), json(rs, "body"), rs.getString("rendered"),
                rs.getInt("rendered_tokens_est"), rs.getString("changelog"), rs.getObject("source_proposal_id", Long.class),
                instant(rs, "created_at"));
    }

    private RowMapper<FrameworkProposal> proposalMapper() {
        return (rs, rowNum) -> new FrameworkProposal(rs.getLong("id"), rs.getObject("note_id", Long.class),
                rs.getInt("base_version"), rs.getString("request_text"), rs.getString("model"), json(rs, "response"),
                rs.getString("response_raw"), rs.getString("status"), rs.getString("error"),
                rs.getObject("result_version", Integer.class), instant(rs, "created_at"), instant(rs, "decided_at"));
    }

    private RowMapper<Review> reviewMapper() {
        return (rs, rowNum) -> {
            String input = rs.getString("input");
            return new Review(date(rs, "week_ending"), rs.getObject("window_weeks", Integer.class), mapper.readTree(input),
                    rs.getBoolean("input_text_stored") ? input : null, json(rs, "response"), rs.getString("response_raw"),
                    rs.getString("model"), json(rs, "usage"), rs.getString("status"), rs.getString("error"),
                    rs.getObject("proposal_id", Long.class), rs.getObject("framework_version", Integer.class),
                    rs.getInt("retry_count"), instant(rs, "created_at"), rs.getString("market"));
        };
    }

    private static RowMapper<Note> noteMapper() {
        return (rs, rowNum) -> new Note(rs.getLong("id"), rs.getString("kind"), date(rs, "as_of_date"),
                date(rs, "expires_on"), rs.getString("title"), rs.getString("body"), rs.getBoolean("archived"),
                instant(rs, "created_at"), rs.getString("market"));
    }

    private RowMapper<GateRow> gateMapper() {
        return (rs, rowNum) -> new GateRow(date(rs, "trading_date"), json(rs, "inputs"), rs.getString("level"),
                json(rs, "streaks"), instant(rs, "created_at"));
    }

    private static RowMapper<NavRow> navMapper() {
        return (rs, rowNum) -> new NavRow(rs.getString("book_code"), date(rs, "trading_date"), rs.getDouble("nav"),
                rs.getDouble("cash"), rs.getDouble("equity_value"), rs.getDouble("exposure_pct"),
                rs.getBoolean("prices_final"));
    }

    private JsonNode json(ResultSet rs, String column) throws SQLException {
        String raw = rs.getString(column);
        return raw == null ? null : mapper.readTree(raw);
    }

    private static Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp timestamp = rs.getTimestamp(column);
        return timestamp == null ? null : timestamp.toInstant();
    }

    private static LocalDate date(ResultSet rs, String column) throws SQLException {
        Date date = rs.getDate(column);
        return date == null ? null : date.toLocalDate();
    }

    private static Double nullableDouble(ResultSet rs, String column) throws SQLException {
        BigDecimal value = rs.getBigDecimal(column);
        return value == null ? null : value.doubleValue();
    }

    /** DOUBLE PRECISION 열(트랙레코드 수치). NULL은 null — 0으로 읽지 않습니다. */
    private static Double stat(ResultSet rs, String column) throws SQLException {
        double value = rs.getDouble(column);
        return rs.wasNull() ? null : value;
    }

    /** 트랙레코드 수치. null은 NULL, NaN·무한대는 계산 오류라 저장하지 않습니다(DOUBLE PRECISION은 NaN을 받아 주므로). */
    private static void setStat(PreparedStatement ps, int index, Double value, String column) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.DOUBLE);
        } else if (!Double.isFinite(value)) {
            throw new IllegalArgumentException(column + " 값이 유한한 수가 아닙니다: " + value);
        } else {
            ps.setDouble(index, value);
        }
    }

    /** NUMERIC 열에 넣을 값. NaN·무한대는 계산 오류라 저장하지 않습니다(NUMERIC은 NaN을 받아 주므로 여기서 막음). */
    private static BigDecimal money(double value, String column) {
        if (!Double.isFinite(value)) {
            throw new IllegalArgumentException(column + " 값이 유한한 수가 아닙니다: " + value);
        }
        return BigDecimal.valueOf(value);
    }

    private static void setMoney(PreparedStatement ps, int index, Double value, String column) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.NUMERIC);
        } else {
            ps.setBigDecimal(index, money(value, column));
        }
    }

    private static void setDate(PreparedStatement ps, int index, LocalDate value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.DATE);
        } else {
            ps.setDate(index, Date.valueOf(value));
        }
    }

    private static void setInstant(PreparedStatement ps, int index, Instant value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.TIMESTAMP_WITH_TIMEZONE);
        } else {
            ps.setTimestamp(index, Timestamp.from(value));
        }
    }

    private static void setInteger(PreparedStatement ps, int index, Integer value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.INTEGER);
        } else {
            ps.setInt(index, value);
        }
    }

    private static void setLong(PreparedStatement ps, int index, Long value) throws SQLException {
        if (value == null) {
            ps.setNull(index, Types.BIGINT);
        } else {
            ps.setLong(index, value);
        }
    }

    private static long single(List<Long> ids, String what) {
        if (ids.isEmpty()) {
            throw new IllegalStateException("새 " + what + " 번호를 받지 못했습니다");
        }
        return ids.get(0);
    }
}
