package com.macrodash.feature.paper;

import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.StartPrice;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Params;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * 🧪 모의 매매 관리 — 초기화(네 책 + 벤치마크 사후 체결)·일시정지/재개·초기화(리셋). 명세 L1·L2·L11.
 *
 * <p><b>초기화는 멱등입니다.</b> 이미 있는 책·설정은 그대로 두고 없는 것만 만듭니다. 벤치마크 두 책은 출발일
 * ({@code dashboard.paper.start-date}, 2026-10-23) 종가로 <b>사후 체결</b>합니다 — 그날 종가가 아직 없으면(수집 전) 그 책은
 * 시작하지 않고 결과에 사유를 남깁니다. 다시 누르면 그때 체결합니다. 규칙·Claude 책은 현금만 든 '시작 전' 책으로 만듭니다
 * (시작은 단계 2·3의 초기 결정, 명세 L2).
 *
 * <p><b>출발일 종가는 한 번 얼립니다</b>({@code paper_start_prices}). 처음 초기화할 때 관측치 유니버스 전체의 출발일 종가를
 * 넣어 두고, 사후 체결(지금은 벤치마크, 뒤 단계에서는 규칙·Claude 책)과 리셋 뒤 다시 사후 체결은 모두 그 값({@link #startClose})을
 * 씁니다. 수집기는 이력·관측치를 수정주가({@code auto_adjust=True})로 받아서, 출발일 뒤 배당락이 지나면 출발일 '종가'가 낮게
 * 다시 쓰입니다 — 그 값으로 늦게 사면 주식 수가 늘어 배당이 장부 수익률에 섞이고(장부는 가격 수익률, 한계 문구 3), 리셋할 때마다
 * 출발점이 달라져 다른 책과의 비교 기준(bench_spy)이 틀어집니다.
 *
 * <p>사후 체결의 시각 규칙(룩어헤드 기록이 거꾸로 보이지 않게): 주문 생성 = 출발일 마감 1초 전, 기준 거래일 = 그 전 거래일,
 * 체결 관측 시각 = 출발일 마감(16:00 ET), {@code is_backfill = true}. 상태의 멱등 키도 그 마감 시각으로 두어, 출발일 전에 수집한
 * 저장본이 나중에 처리되며 장부를 과거 가격으로 되돌리지 않게 합니다.
 *
 * <p>장부를 바꾸는 일은 관측치 처리와 겹치지 않게 {@link PaperLedgerService#exclusively} 안에서 합니다.
 *
 * <p><b>시장 문맥</b>(2단계 명세 §9 A6): 초기화는 시장 묶음({@link PaperMarket})을 받아 그 시장 책 정의로 책을 만들고 책 행에 그
 * 시장·통화를 적으며, 실패로 기억해 둔 관측치도 그 시장 것만 지웁니다. 출발일 종가 얼리기와 벤치마크 사후 체결은 미국 묶음의
 * 달력·확정 지연·관측치로 하는 미국 전용 일입니다(한국은 출발일 사후 체결·{@code paper_start_prices}가 없음, 명세 K28). 초기 현금·
 * 출발일이 아직 미국 설정({@code dashboard.paper.*})뿐이라 미국 밖 시장의 초기화는 거절합니다(한국 초기화는 C1). 계좌 하나의
 * 리셋은 그 책의 시장 기억만 지우고, 벤치마크 다시 사후 체결은 미국 책만 합니다. 시장을 받지 않는 옛 시그니처는 미국입니다.
 */
@Service
public class PaperAdminService {

    private static final Logger log = LoggerFactory.getLogger(PaperAdminService.class);

    /**
     * 초기화 결과.
     *
     * @param startPricesCaptured 이번에 새로 얼린 출발일 종가 수(이미 얼린 종목은 세지 않음)
     */
    public record InitResult(boolean settingsCreated, List<String> created, List<String> backfilled,
                             List<Map<String, String>> skipped, int startPricesCaptured) {
    }

    /** 일시정지/재개 결과. */
    public record StatusChange(String code, String status, int cancelledOrders) {
    }

    /** 리셋 결과. 벤치마크를 다시 사후 체결하지 못했으면 그 사유. */
    public record ResetResult(String code, boolean backfilled, String skippedReason) {
    }

    private final PaperStore store;
    private final PaperMarketData marketData;
    private final StoreReader reader;
    private final PaperSettingsService settings;
    private final PaperLedgerService ledger;
    private final PaperConfig config;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 계좌 행의 시장 코드로 시장 묶음을 찾는 목록(리셋 — 그 책 시장의 기억만 지움). */
    private final PaperMarkets markets;
    /** 출발일 종가·벤치마크 사후 체결·옛 시그니처의 시장(클래스 설명). */
    private static final PaperMarket US = UsPaperMarket.INSTANCE;

    @Autowired
    PaperAdminService(PaperStore store, PaperMarketData marketData, StoreReader reader, PaperSettingsService settings,
                      PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper, PaperMarkets markets) {
        this(store, marketData, reader, settings, ledger, config, mapper, Clock.systemUTC(), markets);
    }

    /** 테스트용 — 시계를 움직입니다(시장 목록은 운영 목록). */
    PaperAdminService(PaperStore store, PaperMarketData marketData, StoreReader reader, PaperSettingsService settings,
                      PaperLedgerService ledger, PaperConfig config, ObjectMapper mapper, Clock clock) {
        this(store, marketData, reader, settings, ledger, config, mapper, clock, new PaperMarkets(store, reader));
    }

    private PaperAdminService(PaperStore store, PaperMarketData marketData, StoreReader reader,
                              PaperSettingsService settings, PaperLedgerService ledger, PaperConfig config,
                              ObjectMapper mapper, Clock clock, PaperMarkets markets) {
        this.markets = markets;
        this.store = store;
        this.marketData = marketData;
        this.reader = reader;
        this.settings = settings;
        this.ledger = ledger;
        this.config = config;
        this.mapper = mapper;
        this.clock = clock;
    }

    /**
     * 네 책·상태·설정 행을 만들고, 출발일 종가를 얼리고, 벤치마크를 사후 체결합니다(클래스 설명). 이미 시작한 벤치마크는
     * 다시 사지 않습니다. 몇 번을 불러도 됩니다 — 종가가 없어 건너뛴 벤치마크는 다시 부를 때 체결합니다.
     *
     * @throws IllegalStateException 테이블이 없을 때(부르는 쪽이 {@link PaperStore#ready()}를 먼저 봄)
     */
    public InitResult init() {
        return init(US);
    }

    /**
     * 그 시장의 초기화(클래스 설명의 시장 문맥) — 그 시장 책 정의로 책을 만들고 책 행에 그 시장·통화를 적습니다.
     *
     * @throws IllegalArgumentException 초기 현금·출발일 설정이 없는 시장(미국 밖 — 한국은 C1)
     */
    InitResult init(PaperMarket market) {
        if (market.definition() != US) {
            throw new IllegalArgumentException(market.code() + " 시장 초기화는 아직 없습니다 — 초기 현금·출발일 설정이 미국뿐입니다"
                    + "(2단계 명세 §9 C1)");
        }
        requireReady();
        // 이미 있는 책은 아래에서 다시 넣지 않으므로(이름도 그대로), 옛 이름이면 여기서 맞춥니다.
        reconcileLabels();
        // 초기화로 원인이 풀렸을 수 있으니, 실패로 기억해 둔 그 시장 관측치도 다음 처리에서 다시 시도합니다.
        ledger.forgetFailures(market);
        return ledger.exclusively(() -> {
            boolean settingsCreated = settings.ensureInitialized();
            int captured = captureStartPrices();
            PaperSettings current = settings.current(market).settings();
            List<String> created = new ArrayList<>();
            List<String> backfilled = new ArrayList<>();
            List<Map<String, String>> skipped = new ArrayList<>();
            for (PaperBooks.Definition definition : market.books()) {
                boolean inserted = store.atomically(() -> {
                    boolean fresh = store.insertBookIfAbsent(new Book(definition.code(), definition.kind(),
                            definition.label(), config.initialCash(), null, PaperBooks.NOT_STARTED, null,
                            market.code(), market.currency()));
                    if (store.state(definition.code()).isEmpty()) {
                        store.upsertState(cashOnly(definition.code(), config.initialCash()));
                    }
                    return fresh;
                });
                if (inserted) {
                    created.add(definition.code());
                }
                if (!definition.benchmark()) {
                    continue;
                }
                Book book = store.book(definition.code()).orElseThrow();
                if (!PaperBooks.NOT_STARTED.equals(book.status())) {
                    continue;   // 이미 사후 체결함(또는 운용·일시정지 중) — 다시 사지 않습니다
                }
                Optional<String> reason = backfill(book, definition, current);
                if (reason.isEmpty()) {
                    backfilled.add(definition.code());
                } else {
                    Map<String, String> skip = new LinkedHashMap<>();
                    skip.put("code", definition.code());
                    skip.put("reason", reason.get());
                    skipped.add(skip);
                }
            }
            return new InitResult(settingsCreated, created, backfilled, skipped, captured);
        });
    }

    // ------------------------------------------------------------------ 화면 이름
    /**
     * 책 이름을 지금 정의({@link PaperBooks#ALL})로 맞춥니다 — 행 이름이 옛 이름({@link PaperBooks#LEGACY_LABELS}) 그대로일 때만.
     * 이름은 처음 초기화 때 행에 들어가고 그 뒤로는 다시 쓰지 않아서, 화면 이름을 바꿔도 이미 만든 장부는 옛 이름을 계속 보였습니다.
     * 조건부 UPDATE라 몇 번 불러도 같고, 손으로 고친 이름은 건드리지 않습니다. 장부 숫자가 아니라 이름 한 칸이라 관측치 처리와
     * 겹쳐도 됩니다(exclusively 밖). 스키마 파일로 고치지 않는 까닭: paper_books는 백엔드가 쓰는 표이고(ADR 0008) 이름은 이 정의가 정합니다.
     *
     * @return 이번에 이름을 바꾼 책 코드(정의 순)
     */
    public List<String> reconcileLabels() {
        requireReady();
        List<String> renamed = new ArrayList<>();
        for (PaperBooks.Definition definition : PaperBooks.ALL) {
            String legacy = PaperBooks.LEGACY_LABELS.get(definition.code());
            if (legacy != null && !legacy.equals(definition.label())
                    && store.relabelBook(definition.code(), legacy, definition.label())) {
                renamed.add(definition.code());
            }
        }
        return renamed;
    }

    /**
     * 기동 때 한 번 이름을 맞춥니다. 운영 장부는 이미 초기화돼 있어 초기화를 다시 누를 일이 없으므로, 기동이 옛 이름을 고치는 자리입니다.
     * 테이블이 아직 없으면(스키마 적용 전) 건너뜁니다 — 그때는 옛 이름의 행도 없고, 다음 기동·초기화가 맞춥니다. 실패해도 기동은 막지 않습니다.
     */
    @EventListener(ApplicationReadyEvent.class)
    public void reconcileLabelsOnStartup() {
        try {
            if (!store.ready()) {
                return;
            }
            List<String> renamed = reconcileLabels();
            if (!renamed.isEmpty()) {
                log.info("모의 매매 책 이름을 지금 정의로 맞췄습니다: {}", renamed);
            }
        } catch (RuntimeException e) {
            log.warn("모의 매매 책 이름 맞추기 실패 — 다음 기동·초기화 때 다시 합니다: {}", e.toString());
        }
    }

    // ------------------------------------------------------------------ 출발일 종가
    /**
     * 출발일 종가를 초기화와 상관없이 미리 얼려 둡니다(정기 실행, 30분마다 — 이미 얼린 종목은 묻지 않으므로 싼 작업).
     *
     * <p>얼리는 시점이 '처음 초기화를 누를 때'뿐이면, 그 전에 배당락이 지난 종목(SHY는 매달 초)은 수정주가로 낮아진 값이
     * 얼려집니다(단계 1 재검증). 출발일 마감 15분 뒤 확정 종가가 들어오는 대로 얼려 두면 그 창이 거의 없어집니다.
     * 꺼져 있거나 테이블이 없으면 아무것도 하지 않고, 실패해도 다음 주기에 다시 합니다.
     */
    @Scheduled(initialDelayString = "${dashboard.paper.start-price-initial-delay-ms:120000}",
            fixedDelayString = "${dashboard.paper.start-price-interval-ms:1800000}")
    public void scheduledCaptureStartPrices() {
        if (!config.enabled() || !store.ready()) {
            return;
        }
        try {
            int captured = ledger.exclusively(this::captureStartPrices);
            if (captured > 0) {
                log.info("모의 매매 출발일({}) 종가 {}종목을 얼렸습니다", config.startDate(), captured);
            }
        } catch (RuntimeException e) {
            log.warn("출발일 종가 얼리기 실패 — 다음 주기에 다시 시도합니다: {}", e.toString());
        }
    }

    /**
     * 관측치 유니버스 전체(관측치 저장본의 종목 + 벤치마크 종목)의 출발일 종가를 아직 없는 종목만 얼립니다(클래스 설명).
     * 출발일 마감 15분 전이면 아무것도 하지 않습니다(그날 값은 아직 장중 값). 종가를 찾지 못한 종목은 건너뛰고, 다음
     * 초기화나 {@link #startClose}가 다시 찾습니다.
     *
     * @return 이번에 새로 얼린 종목 수
     */
    int captureStartPrices() {
        LocalDate start = config.startDate();
        if (clock.instant().isBefore(US.calendar().closeInstant(start).plus(US.finalDelay()))) {
            return 0;
        }
        Set<String> universe = new TreeSet<>();
        reader.quietly(() -> marketData.quotes(US)).ifPresent(quotes -> universe.addAll(quotes.bars().keySet()));
        US.books().forEach(definition -> universe.addAll(definition.weights().keySet()));
        for (StartPrice frozen : store.startPrices()) {
            if (start.equals(frozen.tradingDate())) {
                universe.remove(frozen.ticker());
            }
        }
        if (universe.isEmpty()) {
            return 0;
        }
        Map<String, PaperMarketData.SourcedClose> found =
                reader.quietly(() -> marketData.sourcedClosesOn(universe, start));
        if (found == null || found.isEmpty()) {
            return 0;
        }
        return store.atomically(() -> {
            int inserted = 0;
            for (Map.Entry<String, PaperMarketData.SourcedClose> entry : found.entrySet()) {
                if (store.insertStartPriceIfAbsent(new StartPrice(entry.getKey(), start, entry.getValue().close(),
                        entry.getValue().source(), null))) {
                    inserted++;
                }
            }
            return inserted;
        });
    }

    /**
     * 출발일 종가 — 얼려 둔 값이 있으면 그것, 없으면 지금 찾아 얼린 뒤 그 값(클래스 설명). 사후 체결은 모두 이 값을 씁니다
     * (벤치마크, 뒤 단계의 규칙·Claude 책). 얼린 값을 저장 열(NUMERIC(18,6))에서 다시 읽어 돌려주므로 처음 체결과 리셋 뒤
     * 체결이 같은 숫자입니다. 화면 요청에서 불려도 수집을 깨우거나 기다리지 않습니다.
     *
     * @return 찾지 못했으면(수집 전) empty
     */
    public Optional<PaperMarketData.SourcedClose> startClose(String ticker) {
        LocalDate start = config.startDate();
        Optional<PaperMarketData.SourcedClose> frozen = frozenStartClose(ticker, start);
        if (frozen.isPresent()) {
            return frozen;
        }
        Optional<PaperMarketData.SourcedClose> found = reader.quietly(() -> marketData.sourcedCloseOn(ticker, start));
        if (found == null || found.isEmpty()) {
            return Optional.empty();
        }
        store.insertStartPriceIfAbsent(new StartPrice(ticker, start, found.get().close(), found.get().source(), null));
        return frozenStartClose(ticker, start).or(() -> found);
    }

    private Optional<PaperMarketData.SourcedClose> frozenStartClose(String ticker, LocalDate start) {
        return store.startPrice(ticker).filter(p -> start.equals(p.tradingDate()))
                .map(p -> new PaperMarketData.SourcedClose(p.close(), p.source()));
    }

    /**
     * 책을 운용(ACTIVE)·일시정지(PAUSED)로 바꿉니다. 일시정지하면 체결 전 주문(PENDING·PROPOSED)을 모두 취소합니다 —
     * 재개했을 때 며칠 묵은 주문이 그날 가격으로 체결되지 않게.
     *
     * @throws InvalidRequestException 없는 책, ACTIVE·PAUSED 밖의 값, 시작 전 책(시작은 단계 2·3의 초기 결정이 함)
     */
    public StatusChange setStatus(String code, String status) {
        requireReady();
        String target = Params.oneOf("status", status, List.of(PaperBooks.ACTIVE, PaperBooks.PAUSED));
        return ledger.exclusively(() -> store.atomically(() -> {
            Book book = existing(code);
            if (PaperBooks.NOT_STARTED.equals(book.status())) {
                throw new InvalidRequestException("시작 전 계좌(" + code + ")는 운용·일시정지를 바꿀 수 없습니다. "
                        + "규칙·Claude 계좌는 개요의 '규칙 계좌 시작'·'Claude 계좌 시작'(초기 결정)으로 시작합니다.");
            }
            int cancelled = 0;
            if (PaperBooks.PAUSED.equals(target)) {
                cancelled = store.cancelPendingOrders(code);
            }
            store.updateBookStatus(code, target);
            return new StatusChange(code, target, cancelled);
        }));
    }

    /**
     * 책 하나의 장부를 비우고 처음 상태로 되돌립니다(L11). 확인 문구로 책 코드를 그대로 받아야 합니다(실수 방지).
     * 벤치마크는 얼려 둔 출발일 종가({@link #startClose})로 다시 사후 체결하므로 처음과 같은 가격·수량이 됩니다. 규칙·Claude
     * 책은 현금만 든 '시작 전' 책이 됩니다. 작업 기록·설정·얼린 종가는 남깁니다.
     *
     * @throws InvalidRequestException 없는 책이거나 확인 문구가 책 코드와 다름
     */
    public ResetResult reset(String code, String confirm) {
        requireReady();
        Book book = existing(code);
        if (confirm == null || !confirm.equals(code)) {
            throw new InvalidRequestException("초기화하려면 확인 문구로 계좌 코드(" + code + ")를 그대로 입력하세요.");
        }
        PaperMarket market = markets.of(book.market()).orElse(null);
        // 그 책 시장의 설정 읽기(C1a) — 모르는 시장의 책이면 다시 사후 체결하지 않으므로(아래) 미국 판으로 둡니다.
        PaperSettings current = market == null ? settings.current().settings() : settings.current(market).settings();
        // 비운 책은 같은 관측치로 다시 처리해도 됩니다 — 그 책 시장의 기억만(모르는 시장이면 전부) 지웁니다.
        if (market == null) {
            ledger.forgetFailures();
        } else {
            ledger.forgetFailures(market);
        }
        return ledger.exclusively(() -> store.atomically(() -> {
            store.resetBook(code);
            store.updateBookStatus(code, PaperBooks.NOT_STARTED);
            store.updateBookStartedOn(code, null);
            store.upsertState(cashOnly(code, book.initialCash()));
            // 벤치마크를 다시 사후 체결하는 것은 미국 책뿐입니다(클래스 설명 — 한국은 출발일 사후 체결이 없음, K28).
            Optional<PaperBooks.Definition> definition = market != null && market.definition() == US
                    ? PaperBooks.find(code) : Optional.empty();
            if (definition.isEmpty() || !definition.get().benchmark()) {
                return new ResetResult(code, false, null);
            }
            Book cleared = store.book(code).orElseThrow();
            Optional<String> reason = backfill(cleared, definition.get(), current);
            return new ResetResult(code, reason.isEmpty(), reason.orElse(null));
        }));
    }

    // ------------------------------------------------------------------ 사후 체결
    /**
     * 벤치마크 책을 얼려 둔 출발일 종가로 삽니다(한 트랜잭션). 종가가 하나라도 없으면 체결은 쓰지 않고 그 사유를 돌려줍니다.
     *
     * @return 체결했으면 empty, 못 했으면 사유
     */
    private Optional<String> backfill(Book book, PaperBooks.Definition definition, PaperSettings current) {
        LocalDate start = config.startDate();
        Instant close = US.calendar().closeInstant(start);
        if (clock.instant().isBefore(close.plus(US.finalDelay()))) {
            return Optional.of(start + " 장 마감 15분 뒤부터 종가로 사후 체결할 수 있습니다.");
        }
        Map<String, PaperMarketData.SourcedClose> closes = new LinkedHashMap<>();
        for (String ticker : definition.weights().keySet()) {
            // 얼린 값이 없으면 지금 찾아 얼립니다. 그것도 없으면 사유를 돌려주고 다음 초기화에서 다시 봅니다.
            Optional<PaperMarketData.SourcedClose> found = startClose(ticker);
            if (found.isEmpty()) {
                return Optional.of(start + " " + ticker + " 종가가 아직 없습니다(10년 이력 equity_close·관측치 paper.quotes)"
                        + " — 수집기가 받은 뒤 초기화를 다시 누르세요.");
            }
            closes.put(ticker, found.get());
        }
        List<PaperLedgerService.BackfillLeg> legs = new ArrayList<>();
        for (Map.Entry<String, Double> leg : definition.weights().entrySet()) {
            Map<String, Object> reason = new LinkedHashMap<>();
            reason.put("backfill", true);
            reason.put("startDate", start.toString());
            reason.put("weightPct", leg.getValue());
            reason.put("note", "벤치마크 " + definition.label() + " — 출발일 종가로 사후 체결");
            legs.add(new PaperLedgerService.BackfillLeg(leg.getKey(), PaperBooks.BUY, leg.getValue(), null,
                    mapper.valueToTree(reason)));
        }
        // 체결·평가·순자산·상태·운용 전환은 규칙 책 "시작"과 같은 사후 체결 함수가 합니다(장부 서비스). 벤치마크는 정한 비중을
        // 다 사야 하므로 한 다리라도 못 사면 트랜잭션째 되돌립니다(바깥 트랜잭션에 사후 체결이 합류).
        double initialCash = book.initialCash();
        return store.atomically(() -> {
            PaperLedgerService.BackfillResult result = ledger.backfill(new PaperLedgerService.BackfillRequest(book,
                    start, PaperBooks.SOURCE_BENCHMARK, null, initialCash, initialCash, legs, closes, current));
            if (!result.skipped().isEmpty()) {
                throw new IllegalStateException(result.skipped().get(0).getValue());
            }
            return Optional.<String>empty();
        });
    }

    // ------------------------------------------------------------------ 보조
    private static BookState cashOnly(String code, double cash) {
        return new BookState(code, cash, cash, 0, 0, null, null, null, null);
    }

    private Book existing(String code) {
        return store.book(code).orElseThrow(() -> new InvalidRequestException(
                "없는 계좌입니다: " + Params.echo(code) + " (rules · claude · bench_spy · bench_mix)"));
    }

    private void requireReady() {
        if (!store.ready()) {
            throw new IllegalStateException("모의 매매 테이블이 아직 없습니다(V8·V9 적용 전)");
        }
    }
}
