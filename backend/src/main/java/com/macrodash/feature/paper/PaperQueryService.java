package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.CalendarWindow;
import com.macrodash.analytics.KrFinancialSector;
import com.macrodash.analytics.PaperStats;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.JobRun;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.NavRow;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.Snapshot;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.YearMonth;
import java.time.temporal.TemporalAccessor;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * 🧪 모의 매매 화면 응답(API.md "🧪 모의 매매") — 장부 테이블을 읽어 화면이 그대로 그릴 숫자로 만듭니다(ADR 0004: 화면은 계산하지 않음).
 *
 * <p>준비 여부는 {@code SchemaCheck}가 아니라 {@link PaperStore#ready()}로 봅니다(V8의 마지막 테이블·V9의 마지막 열). 테이블이 없으면 모든 응답이
 * {@code {available:false, message}}입니다. 초기화 전이면 {@code available:true, initialized:false}.
 *
 * <p>숫자 규칙: 총액(현금·순자산·평가액·체결 금액)은 소수 2자리, 주당 가격(평단·체결가·최고가·스탑가)은 4자리 — 5bp 슬리피지가
 * 싼 종목에서도 보이게, 비율(%)은 2자리로 반올림해 보냅니다. 모르는 값은 null(화면 —)이고 0으로 채우지 않습니다. 시각은 KST 문자열,
 * 거래일은 미국 동부 세션 날짜(yyyy-MM-dd)입니다.
 *
 * <p>관측치 저장본은 {@link StoreReader#quietly}로 읽습니다 — 화면을 열어도 수집을 깨우거나 기다리지 않습니다(명세 §2).
 * 장부는 백엔드 테이블이라 응답 캐시(ComputedCache)도 쓰지 않습니다.
 *
 * <p><b>시장 문맥</b>(2단계 명세 §9 A6): 개요·상태는 시장 묶음({@link PaperMarket})을 받아 그 시장 책·그 책들의 순자산 줄·그 시장
 * 관측치(확정 판정 포함)·그 시장 Claude 책의 노출 추이와 프레임 경계·초기화 판정(그 시장 책 정의)만 씁니다. 13F 선정·게이트 지표는
 * 미국 전용이라 미국 밖 시장에는 싣지 않습니다(null), 한계 문구는 시장마다 다릅니다(한국 §6 — {@link #krLimits}, F2). 화면 경로는 {@code ?market}(F1, 명세 §4-16 —
 * 없으면 미국, {@link PaperMarkets#requested})으로 시장을 고르고, 미국 밖 시장 응답에는 시장·통화·정기 작업이 쉬는 사유와 그 시장의 출발일·
 * 초기 현금·작업 기록·설정 키가 실립니다({@link #overview(PaperMarket)}·{@link #status(PaperMarket)}). 호출 사용량은 시장과 상관없이 하나(상한
 * 공유)입니다. 계좌 코드 경로(보유·주문·체결·순자산)는 그 책의 시장({@code paper_books.market}) 달력·비교 기준을 씁니다. 시장을 받지 않는
 * 옛 시그니처는 미국입니다. 조회 한 번은 그 시장의 실행 문맥({@link MarketRun} — 달력 한 벌·설정 행 하나)을 한 번 열어 씁니다(C1a).
 */
@Service
public class PaperQueryService {

    static final String NOT_READY_MESSAGE = "모의 매매 테이블이 아직 없습니다. 수집기가 스키마(V8·V9·V10·V11·V12)를 적용하면 생깁니다 — "
            + "make up 후 다시 보세요.";
    /** 개요에 싣는 최근 작업 기록 수. */
    static final int OVERVIEW_JOBS = 10;
    /** 상태 응답에 싣는 최근 작업 기록 수. */
    static final int STATUS_JOBS = 30;
    /** 주문·체결 목록 상한. */
    static final int MAX_LIMIT = 500;
    /**
     * 미국 관측치가 이보다 오래되면 늦었다고 표시합니다 — 수집 주기 1시간의 세 배(두 번 연속 못 받음). 미국 시장 묶음의
     * {@link PaperMarket#quotesLateAt}(늦음이 되는 순간)이 이 값으로 셈하고, 관측치 요약은 그 시장 묶음의 규칙을 씁니다.
     */
    static final Duration QUOTES_LATE = Duration.ofHours(3);

    private final PaperStore store;
    private final PaperMarketData marketData;
    private final StoreReader reader;
    private final PaperSettingsService settings;
    private final PaperConfig config;
    private final Clock clock;
    /** 이 서비스가 아는 시장 — 계좌 코드 경로가 책의 시장 묶음을 찾는 목록이고, 결정 목록이 받는 책 코드의 출처. */
    private final PaperMarkets markets;

    @Autowired
    PaperQueryService(PaperStore store, PaperMarketData marketData, StoreReader reader, PaperSettingsService settings,
                      PaperConfig config, PaperMarkets markets) {
        this(store, marketData, reader, settings, config, Clock.systemUTC(), markets);
    }

    /** 테스트용 — 시계를 움직입니다(시장 목록은 운영 목록). */
    PaperQueryService(PaperStore store, PaperMarketData marketData, StoreReader reader, PaperSettingsService settings,
                      PaperConfig config, Clock clock) {
        this(store, marketData, reader, settings, config, clock, new PaperMarkets(store, reader));
    }

    /** 테스트용 — 시계와 시장 목록을 바꿉니다(시장 격리 시험이 시험용 한국 시장을 넣음). */
    PaperQueryService(PaperStore store, PaperMarketData marketData, StoreReader reader, PaperSettingsService settings,
                      PaperConfig config, Clock clock, List<PaperMarket> markets) {
        this(store, marketData, reader, settings, config, clock, new PaperMarkets(store, reader, markets));
    }

    private PaperQueryService(PaperStore store, PaperMarketData marketData, StoreReader reader,
                              PaperSettingsService settings, PaperConfig config, Clock clock, PaperMarkets markets) {
        this.store = store;
        this.marketData = marketData;
        this.reader = reader;
        this.settings = settings;
        this.config = config;
        this.clock = clock;
        this.markets = markets;
    }

    public boolean ready() {
        return store.ready();
    }

    /** 테이블이 없을 때의 응답. */
    public Map<String, Object> notReady() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", false);
        out.put("message", NOT_READY_MESSAGE);
        return out;
    }

    /** 명세 §6 "화면에 반드시 적을 한계" — 순서대로. */
    List<String> limits() {
        return List.of(
                "모의 매매입니다. 어떤 주문도 밖으로 나가지 않습니다.",
                "체결가는 최대 1시간 묵은 지연 시세입니다.",
                "장부는 배당을 반영하지 않습니다(가격 수익률, 네 계좌 같은 조건). 트랙레코드는 수정주가라 배당이 들어갑니다 — "
                        + "두 숫자를 섞어 비교하지 마세요.",
                config.startDate() + " 체결은 사후 체결입니다.",
                "13F 신호는 공시 시차 45일을 안고 있습니다. 트랙레코드는 공시일 다음 영업일부터 복제한 값이라 실제 기관 수익률이 "
                        + "아닙니다.",
                "후보 기관 목록은 오늘 알려진 운용사라 생존 편향이 있습니다. 커버리지(티커 붙은 비중)가 100% 미만이면 "
                        + "'커버 보유분 기준'입니다.",
                "몇 달치 결과로는 통계적 결론을 낼 수 없습니다.",
                "Claude 계좌는 같은 입력에도 답이 달라질 수 있습니다. 재현은 기록으로만 합니다.");
    }

    /**
     * 한국 개요의 한계 문구(2단계 명세 §6 "화면에 반드시 적을 한계", F2) — 순서대로. 설정에서 오는 숫자(수수료·슬리피지 bp·세율 시행일)는 그
     * 조회 실행의 설정 판에서 넣습니다({@link MarketRun#settings} — 미국 {@link #limits()}가 출발일을 배포 설정에서 넣는 것과 같은 방식, 설정을
     * 바꾸면 문장도 바뀜). 금융업 코드 표의 회사 수는 그 표({@link KrFinancialSector#table})에서 셉니다. 쉬는 한국(출발 전)에도 같은 문구입니다.
     */
    static List<String> krLimits(MarketRun market) {
        PaperSettings settings = market.settings();
        PaperSettings.CostRates costs = settings.costRates() != null ? settings.costRates()
                : PaperSettings.CostRates.defaults();
        return List.of(
                "모의 매매입니다. 어떤 주문도 밖으로 나가지 않습니다.",
                "장중 관측치가 없습니다(서버는 밤에만 켜짐). 주문은 다음 KR 거래일 시가(KRX 시가 단일가)에 체결합니다.",
                "잠정 체결가·평가는 토스증권, 확정가는 금융위원회(공공데이터포털)입니다 — 금융위 값은 하루 늦게 들어오고, 체결 행은 "
                        + "고치지 않은 채 체결마다 '확정 조정' 행으로 현금·평단을 맞춥니다(차이를 표시).",
                "순자산 줄은 그날까지의 체결이 모두 금융위로 확정되고 모든 보유가 금융위 그날 종가로 평가되며 그날 이하 봉으로 체결될 수 "
                        + "있는 대기 주문(1분봉 실패로 기다리는 시가 주문·거래정지 종목의 대기 매도 등)이 없는 날만 확정입니다. 금융위 값이 다음 "
                        + "세션 관측치 처리보다 늦게 들어오면 그날 줄은 잠정으로 남고(현금은 고쳐짐) 다음 줄부터 확정되며, 금융위 행이 끝내 "
                        + "없는 체결이 남으면 그 뒤 줄은 잠정으로 남습니다. 확정 조정의 평단 이동은 병합·일부 매도가 끼면 근사입니다(현금은 정확).",
                "종가·시가는 KRX 정규장 단일가 기준이고 NXT·애프터마켓(16~20시) 체결은 반영하지 않습니다 — 예외: 1분봉을 못 받은 날의 "
                        + "시가 체결과 G2 미통과 때의 잠정 평가는 토스 통합가('KRX+NXT 통합가')이고 금융위 확정 때 고칩니다.",
                "G2 미통과 기간의 잠정 순자산은 주식(KRX+NXT 통합가)과 ETF(KRX 종가)의 시각이 섞입니다 — 확정 때 금융위 값으로 다시 씁니다.",
                "한국 스탑은 다음 거래일 시가에 체결합니다(갭 손실 가능, 체결 때 확정 종가로 다시 판정) — 미국은 걸린 관측치에서 바로 "
                        + "체결합니다. 한국 최고가는 금융위 확정 종가로만 올라 하루 늦게 따라가고, 금융위 값이 아직 없을 때의 스탑은 잠정 "
                        + "판정대로 집행합니다.",
                "미국·한국 책은 출발일·비용 모형·체결 시점·스탑 집행·통화가 달라 수익률을 서로 비교하지 않습니다.",
                "ETF는 금융위 증권상품시세로 확정하고, 그 값이 없는 체결은 '금융위 확정 미보정'으로 남습니다. 배당·분배금·ETF 소득세는 "
                        + "반영하지 않습니다.",
                "분할·병합 밖의 기업행위(인적분할·유무상증자 권리·합병·상장폐지)는 자동 반영하지 않습니다 — '기업행위 확인 필요' 배지를 "
                        + "달고, 그동안 평가는 마지막 확정가입니다.",
                "수수료 " + bp(costs.commissionBp()) + "bp는 가정이고, 세율은 " + costs.tax().effectiveFrom() + " 시행 기준(설정값), 슬리피지 "
                        + bp(settings.slippageBp()) + "bp는 체결가가 아니라 비용 칸입니다(실제 체결가는 단일가 그대로) — 실제 증권사와 다를 수 "
                        + "있습니다.",
                "규칙 계좌 결과는 종목 신호와 주식 노출(후보가 모자란 만큼 153130)이 섞인 값입니다 — 노출 맞춘 참고선과 함께 보세요.",
                "규칙 유니버스는 코스피 시총 상위 100 보통주(코스닥 없음)입니다. 수급은 토스증권 자료(NXT 체결 포함 여부 미확인)이고 수급 "
                        + "이력은 수집을 시작한 뒤부터입니다. Claude 패킷의 국면은 전날 밤 판정입니다.",
                "규칙 계좌의 금융업(부채비율 상한을 보지 않음)은 DART 업종으로 만든 코드 표 " + KrFinancialSector.table().size() + "곳입니다(판 "
                        + KrFinancialSector.VERSION + ") — 표 밖의 금융사(그 뒤 상장·업종이 바뀐 회사 포함)는 표를 고칠 때까지 비금융으로 "
                        + "보고(상한 적용), '유동자산' 계정이 없으면 빠진 사유에 '금융업 코드 표 확인 필요'를 보입니다.",
                "가격 이력은 토스 수정주가 1년 백필(통합가)·금융위 400일이라 장기 통계는 표본 부족입니다. 규칙 계좌 백테스트는 수급 이력이 "
                        + "쌓인 뒤입니다.",
                "U를 벗어난 지 400일이 지난 보유는 한국 수집 범위에서 빠져 시가 체결(매도 포함)·스탑 감지를 받지 못하고, 평가는 마지막 "
                        + "가격에 '가격 없음' 배지로 묶입니다(그 종목 매도 주문은 기준일 + 3거래일에 만료).");
    }

    /** bp 숫자 — 소수 끝 0을 뗀 글자(1.5 → "1.5", 5.0 → "5"). */
    private static String bp(double value) {
        return BigDecimal.valueOf(value).stripTrailingZeros().toPlainString();
    }

    // ------------------------------------------------------------------ 개요·상태
    /** GET /api/paper/overview — {@link #overview(PaperMarket)}의 미국 판. */
    public Map<String, Object> overview() {
        return overview(UsPaperMarket.INSTANCE);
    }

    /**
     * GET /api/paper/overview?market= (2단계 명세 §4-16, F1) — 시장 값이 없으면(null) 미국 판({@link #overview()}와 같은 응답), US·KR이면 그 시장
     * ({@link #overview(PaperMarket)}), 그 밖은 400({@link PaperMarkets#requested}).
     */
    public Map<String, Object> overview(String market) {
        return overview(markets.requested(market));
    }

    /**
     * 그 시장의 개요(클래스 설명의 시장 문맥). 미국 밖 시장은 {@code available} 뒤에 {@code market}·{@code currency}·{@code dormantReason}(그 시장
     * 정기 작업이 쉬는 사유 — 한국 출발일·한국 계좌가 갖춰지지 않음, 돌면 null)을 싣고, 출발일은 그 시장 배포 설정(한국
     * {@code dashboard.paper.kr.start-date}, 없으면 null), 작업 기록은 그 시장 것만({@link PaperMarket#jobPrefix})입니다. 미국 응답은 이 칸들이
     * 없는 그대로입니다.
     */
    Map<String, Object> overview(PaperMarket requested) {
        if (!ready()) {
            return notReady();
        }
        // 이 조회의 시장 문맥 — 통계 표본·관측치 확정 판정이 같은 달력 한 벌(PaperMarkets#open), 쉬는 시장도 엶(PaperMarkets#scope).
        PaperMarkets.Scope scope = markets.scope(requested, config);
        MarketRun market = scope.run();
        boolean us = usOnly(market);
        List<Book> books = sortedBooks(market);
        Set<String> codes = new HashSet<>();
        books.forEach(book -> codes.add(book.code()));
        List<NavRow> allNav = store.navSeriesAll();
        Map<String, List<NavRow>> navByBook = new HashMap<>();
        allNav.stream().filter(row -> codes.contains(row.bookCode()))
                .forEach(row -> navByBook.computeIfAbsent(row.bookCode(), key -> new ArrayList<>()).add(row));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        if (!us) {
            putMarket(out, market, scope.dormantReason());
        }
        out.put("initialized", initialized(market, books));
        out.put("pendingBackfill", pendingBackfill(books));
        out.put("startDate", startDate(market));
        List<Map<String, Object>> summaries = new ArrayList<>();
        for (Book book : books) {
            summaries.add(summary(market, book, navByBook));
        }
        out.put("books", summaries);
        out.put("navSeries", navSeries(books, navByBook));
        out.put("quotes", quotesSummary(market));
        out.put("selection", us ? latestSelection() : null);
        // OS 게이트 지표(참고 — 구속하지 않음, D7·D19): 결정 작업이 거래일마다 남긴 가장 최근 줄. 없으면 null.
        out.put("gate", us ? store.recentGate(1).stream().findFirst().map(PaperGate::view).orElse(null) : null);
        out.put("claudeExposureSeries", claudeExposureSeries(market,
                navByBook.getOrDefault(market.claudeBook(), List.of())));
        out.put("frameworkBoundaries", frameworkBoundaries(market));
        out.put("limits", us ? limits() : korea(market) ? krLimits(market) : List.of());
        out.put("jobs", jobs(market, OVERVIEW_JOBS));
        return out;
    }

    /** 미국 전용 칸(13F 선정·게이트 지표·한계 문구·출발일·초기 현금)을 싣는 시장인가 — 미국 묶음 그 자체일 때만(클래스 설명). */
    private static boolean usOnly(PaperMarket market) {
        return market.definition() == UsPaperMarket.INSTANCE;
    }

    /** 미국 밖 시장 응답의 머리 칸 — 시장·장부 통화·정기 작업이 쉬는 사유(돌면 null). 미국 응답에는 싣지 않습니다(옛 응답 그대로). */
    private static void putMarket(Map<String, Object> out, PaperMarket market, String dormantReason) {
        out.put("market", market.code());
        out.put("currency", market.currency());
        out.put("dormantReason", dormantReason);
    }

    /** 한국 책 묶음 그 자체인가 — 한국 배포 설정(출발일·초기 현금)·{@code kr.*} 설정 키를 싣는 시장(시험용 한국 묶음은 아님). */
    private static boolean korea(PaperMarket market) {
        return market.definition() == KrPaperMarket.INSTANCE;
    }

    /** 그 시장의 출발일(배포 설정) — 미국 {@code dashboard.paper.start-date}, 한국 {@code dashboard.paper.kr.start-date}(비었으면 null). */
    private String startDate(PaperMarket market) {
        if (usOnly(market)) {
            return config.startDate().toString();
        }
        return korea(market) && config.krStartDate() != null ? config.krStartDate().toString() : null;
    }

    /** 그 시장 계좌마다 시작 현금(배포 설정) — 미국 달러(소수 2자리), 한국 원(정수). 그 밖 시장은 null. */
    private Object initialCash(PaperMarket market) {
        if (usOnly(market)) {
            return round2(config.initialCash());
        }
        return korea(market) ? config.krInitialCash().longValueExact() : null;
    }

    // ------------------------------------------------------------------ 결정
    /**
     * GET /api/paper/decisions?book=&limit= (1–500, 최근 순). 결정을 내는 책은 시장마다 규칙·Claude 책뿐입니다(미국 rules·claude —
     * 아는 시장 순서대로).
     */
    public Map<String, Object> decisions(String book, int limit) {
        if (!ready()) {
            return notReady();
        }
        Set<String> deciding = new LinkedHashSet<>();
        markets.all().forEach(market -> {
            deciding.add(market.rulesBook());
            deciding.add(market.claudeBook());
        });
        String code = Params.oneOf("book", book, List.copyOf(deciding));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (PaperStore.DecisionSummary d : store.decisions(code, Params.clamp(limit, 1, MAX_LIMIT))) {
            rows.add(decisionRow(d.id(), d.bookCode(), d.asOfTradingDate(), d.kind(), d.status(), d.decidedAt(),
                    d.model(), d.frameworkVersion(), d.settingsVersion(), d.selectionAsOf(), d.targetExposurePct(),
                    d.summary(), d.orderCount(), d.rejectedCount(), d.pricesFinal(), d.error()));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("decisions", rows);
        return out;
    }

    /**
     * GET /api/paper/decisions/{id} — 결정 한 건의 전체 기록(패킷·응답·사용량)과 그 결정이 낸 주문.
     *
     * @throws InvalidRequestException 없는 결정 번호(404가 아니라 400 — 책 코드와 같은 규칙)
     */
    public Map<String, Object> decision(long id) {
        if (!ready()) {
            return notReady();
        }
        PaperStore.Decision d = store.decision(id).orElseThrow(() -> new InvalidRequestException(
                "없는 결정입니다: " + id));
        List<Order> orders = store.ordersByDecision(id);
        Map<String, Object> detail = decisionSummary(d, orders);
        detail.put("packet", d.packet());
        detail.put("packetHash", d.packetHash());
        detail.put("response", d.response());
        detail.put("usage", d.usage());
        detail.put("noteIds", d.noteIds());
        detail.put("latencyMs", d.latencyMs());
        detail.put("retryCount", d.retryCount());
        // Claude 책: 모델이 보낸 원문(형식 오류일 때 무엇이 왔는지)과 목표 노출·주문의 어긋남(결정 표에 열이 없어 응답에서).
        detail.put("responseRaw", d.responseRaw());
        JsonNode mismatch = Json.child(d.response(), "exposureMismatch");
        detail.put("exposureMismatch", mismatch != null && mismatch.isBoolean() ? mismatch.asBoolean() : null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("decision", detail);
        out.put("orders", orders.stream().map(PaperQueryService::orderRow).toList());
        return out;
    }

    /** 결정 요약 한 줄(목록과 같은 모양) — 버튼 응답(수동 결정·시작)이 방금 낸 결정을 그릴 때. */
    public Map<String, Object> decisionSummary(PaperStore.Decision d) {
        return decisionSummary(d, store.ordersByDecision(d.id()));
    }

    private static Map<String, Object> decisionSummary(PaperStore.Decision d, List<Order> orders) {
        int rejected = (int) orders.stream().filter(o -> "REJECTED".equals(o.status())).count();
        return decisionRow(d.id(), d.bookCode(), d.asOfTradingDate(), d.kind(), d.status(), d.decidedAt(), d.model(),
                d.frameworkVersion(), d.settingsVersion(), d.selectionAsOf(), d.targetExposurePct(),
                Json.asText(d.response(), "summary"), orders.size(), rejected, d.pricesFinal(), d.error());
    }

    private static Map<String, Object> decisionRow(long id, String book, LocalDate asOf, String kind, String status,
                                                   Instant decidedAt, String model, Integer frameworkVersion,
                                                   int settingsVersion, LocalDate selectionAsOf,
                                                   Double targetExposurePct, String summary, int orderCount,
                                                   int rejectedCount, boolean pricesFinal, String error) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", id);
        row.put("book", book);
        row.put("asOfTradingDate", text(asOf));
        row.put("kind", kind);
        row.put("status", status);
        row.put("decidedAtKst", stamp(decidedAt));
        row.put("model", model);
        row.put("frameworkVersion", frameworkVersion);
        row.put("settingsVersion", settingsVersion);
        row.put("selectionAsOf", text(selectionAsOf));
        row.put("targetExposurePct", round2(targetExposurePct));
        row.put("summary", summary);
        row.put("orderCount", orderCount);
        row.put("rejectedCount", rejectedCount);
        row.put("pricesFinal", pricesFinal);
        row.put("error", error);
        return row;
    }

    /** 체결 행(체결 목록과 같은 모양) — 시작(사후 체결) 응답이 방금 낸 체결을 그릴 때. */
    public List<Map<String, Object>> fillRows(List<Fill> fills) {
        return fills.stream().map(PaperQueryService::fillRow).toList();
    }

    /** GET /api/paper/status — {@link #status(PaperMarket)}의 미국 판. */
    public Map<String, Object> status() {
        return status(UsPaperMarket.INSTANCE);
    }

    /**
     * GET /api/paper/status?market= (2단계 명세 §4-16, F1) — 시장 값이 없으면(null) 미국 판({@link #status()}와 같은 응답), US·KR이면 그 시장,
     * 그 밖은 400({@link PaperMarkets#requested}).
     */
    public Map<String, Object> status(String market) {
        return status(markets.requested(market));
    }

    /**
     * 그 시장의 상태 — 초기화 판정·관측치·출발일·초기 현금·작업 기록은 그 시장 것, 호출 사용량(상한 공유)은 시장과 상관없이 하나. 미국 밖 시장은
     * {@link #overview(PaperMarket)}처럼 머리 칸({@code market}·{@code currency}·{@code dormantReason})을 싣고, 설정 판·기본값으로 읽은 키는 그 조회
     * 실행이 읽은 설정 행의 그 시장 키(한국 {@code kr.*} — 설정 화면의 한국 읽기와 같은 목록, {@link PaperSettingsService#krFallbacks}), 미국 수집
     * 상태 넷({@code fundamentals}·{@code calendar}·{@code news}·{@code earnings} — 미국 패킷의 자료)은 null입니다. 한국은 그 뒤에 한국 수집 상태
     * 요약 {@code collection}({@link KrCollectionStatus}, 2단계 명세 §9 x4)을 싣습니다.
     */
    Map<String, Object> status(PaperMarket requested) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!ready()) {
            out.putAll(notReady());
            out.put("schemaReady", false);
            out.put("enabled", config.enabled());
            return out;
        }
        PaperMarkets.Scope scope = markets.scope(requested, config);
        MarketRun market = scope.run();
        boolean us = usOnly(market);
        out.put("available", true);
        if (!us) {
            putMarket(out, market, scope.dormantReason());
        }
        out.put("schemaReady", true);
        out.put("initialized", initialized(market, sortedBooks(market)));
        out.put("enabled", config.enabled());
        out.put("startDate", startDate(market));
        out.put("initialCash", initialCash(market));
        out.put("quotes", quotesSummary(market));
        out.put("jobs", jobs(market, STATUS_JOBS));
        if (us) {
            PaperSettingsService.Current current = settings.current();
            out.put("settingsVersion", current.version());
            // 장부 키와 섞기 키(blend.*)·규칙 책 묶음(rules.*) — 둘 다 단계 2 전 설정 행에는 없음 — 를 함께, 어느 키를 기본값으로
            // 읽고 있는지 화면이 한 곳에서 보게.
            List<String> fallbacks = new ArrayList<>(current.settings().fallbacks());
            fallbacks.addAll(current.settings().blend().fallbacks());
            fallbacks.addAll(current.settings().rules().fallbacks());
            out.put("settingsFallbacks", fallbacks);
        } else {
            out.put("settingsVersion", market.settingsVersion());
            out.put("settingsFallbacks", korea(market)
                    ? market.settingsRow().map(row -> PaperSettingsService.krFallbacks(row.body())).orElse(List.of())
                    : List.of());
        }
        out.put("apiUsage", apiUsage());
        out.put("fundamentals", us ? fundamentalsStatus() : null);
        out.put("calendar", us ? calendarStatus() : null);
        out.put("news", us ? newsStatus() : null);
        out.put("earnings", us ? earningsStatus() : null);
        if (korea(market)) {
            // 한국 수집 상태 요약(x4 — 사용자 결정 2026-10-29): 저장본·최신 기준일만 읽음(수집 유발 없음), 미국 응답에는 이 칸이 없음.
            out.put("collection", KrCollectionStatus.view(reader, marketData, market, clock.instant()));
        }
        return out;
    }

    /**
     * 어닝 서프라이즈 수집 범위(2단계 C) — 수집기 상태 저장본 {@code us.earnings_surprise.status}의 요약
     * {@code {available, covered, universe, withEstimate4, generatedAtKst}}. covered = 저장된 분기 행이 하나라도 있는 종목 수,
     * universe = 대상(유니버스 주식 — ETF 제외, 실적 일정과 같은 범위) 수, withEstimate4 = 추정치가 있는 분기가 4개 이상 저장된 종목 수
     * (셋 다 수집기가 이번 응답이 아니라 저장된 행으로 셈), generatedAtKst = 저장본을 마지막으로 쓴 수집 시각(저장본의
     * {@code generatedAt}, 없으면 저장 시각). 한 종목도 받지 못한 실행·yfinance 내부 API가 바뀐 실행은 저장본을 쓰지 않으므로(수집기
     * 규칙 — 직전 저장본 유지) 그때는 시각이 멈춰 보입니다. 저장본이 없으면 숫자·시각은 null(0으로 채우지 않음). 수집 요청 없이
     * 저장본만 읽습니다(화면이 수집기를 깨우지 않게).
     */
    private Map<String, Object> earningsStatus() {
        Optional<Snapshot> found = reader.readStored(Datasets.SNAP_EARNINGS_SURPRISE_STATUS);
        JsonNode payload = found.map(Snapshot::payload).filter(JsonNode::isObject).orElse(null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", payload != null);
        out.put("covered", payload == null ? null : integer(payload, "covered"));
        out.put("universe", payload == null ? null : integer(payload, "universe"));
        out.put("withEstimate4", payload == null ? null : integer(payload, "withEstimate4"));
        Instant generated = payload == null ? null : parseInstant(Json.asText(payload, "generatedAt"));
        if (generated == null && payload != null) {
            generated = found.get().collectedAt();
        }
        out.put("generatedAtKst", generated == null ? null : Kst.stamp(generated));
        return out;
    }

    /**
     * 사건 뉴스 수집 상태(2단계 B) — 수집기 상태 저장본 {@code news.headlines.status}의 요약
     * {@code {available, stored7d, lastFetchKst, feedsOk, feedsTotal, failedFeeds:[{feed, source, reason}]}}. stored7d = 보존 7일 안의
     * 헤드라인 수(거르기 전 — 패킷에 싣는 것은 그중 대상 종목·키워드에 걸린 것), lastFetchKst = 피드를 하나라도 받은 마지막 수집 시각
     * (저장본의 {@code generatedAt}, 없으면 저장 시각), feedsOk/feedsTotal = 그 수집에서 받은 피드 수/전체, failedFeeds = 그때 실패한
     * 피드와 사유. 피드가 모두 실패한 수집은 저장본을 쓰지 않으므로(수집기 규칙 — 직전 저장본 유지) 그때는 시각이 멈춰 보입니다.
     * 저장본이 없으면 숫자·시각은 null, 목록은 빈 목록이 아니라 null(0으로 채우지 않음). 수집 요청 없이 저장본만 읽습니다.
     */
    private Map<String, Object> newsStatus() {
        Optional<Snapshot> found = reader.readStored(Datasets.SNAP_NEWS_STATUS);
        JsonNode payload = found.map(Snapshot::payload).filter(JsonNode::isObject).orElse(null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", payload != null);
        out.put("stored7d", payload == null ? null : integer(payload, "stored7d"));
        Instant fetched = payload == null ? null : parseInstant(Json.asText(payload, "generatedAt"));
        if (fetched == null && payload != null) {
            fetched = found.get().collectedAt();
        }
        out.put("lastFetchKst", fetched == null ? null : Kst.stamp(fetched));
        out.put("feedsOk", payload == null ? null : integer(payload, "feedsOk"));
        out.put("feedsTotal", payload == null ? null : integer(payload, "feedsTotal"));
        List<Map<String, Object>> failed = null;
        if (payload != null) {
            failed = new ArrayList<>();
            for (JsonNode f : Json.array(payload, "failedFeeds")) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("feed", Json.asText(f, "feed"));
                row.put("source", Json.asText(f, "source"));
                row.put("reason", Json.asText(f, "reason"));
                failed.add(row);
            }
        }
        out.put("failedFeeds", failed);
        return out;
    }

    /** 정수 칸 — 없거나 정수가 아니면 null(0으로 채우지 않음). */
    private static Integer integer(JsonNode node, String field) {
        JsonNode v = Json.child(node, field);
        return v != null && v.isIntegralNumber() && v.canConvertToInt() ? v.intValue() : null;
    }

    /** ISO 시각(오프셋 포함, 수집기의 {@code datetime.isoformat()}). 없거나 읽을 수 없으면 null. */
    private static Instant parseInstant(String text) {
        if (text == null || text.isBlank()) {
            return null;
        }
        try {
            return java.time.OffsetDateTime.parse(text.strip()).toInstant();
        } catch (java.time.format.DateTimeParseException e) {
            return null;
        }
    }

    /**
     * 발표·실적 일정 수집 범위(2단계 A) — 수집기 저장본 {@code calendar.us_events}의 요약
     * {@code {available, macroCount, earningsCovered, universe, generatedAtKst, fredStatus}}. macroCount = 수집 창(앞으로 45일)의
     * 거시 일정 수(FOMC + FRED 발표일 — 패킷 창 10거래일보다 넓음), earningsCovered = 실적 일정을 받아 둔 종목 수, universe = 실적
     * 일정 대상(유니버스 주식 — ETF 제외) 수, fredStatus = FRED 부분 상태(ok·키 미설정·실패 — 키가 없어도 FOMC 상수는 macroCount에
     * 셈). 저장본이 없으면 숫자·시각·상태가 모두 null(0으로 채우지 않음). 수집 요청 없이 저장본만 읽습니다(화면이 수집기를 깨우지
     * 않게). 저장본 모양 읽기는 패킷과 같은 함수({@link CalendarSection#stored})라 두 곳이 같은 칸을 다르게 읽지 않습니다.
     */
    private Map<String, Object> calendarStatus() {
        Optional<Snapshot> found = reader.readStored(Datasets.SNAP_US_CALENDAR);
        CalendarWindow.Stored stored = CalendarSection.stored(found.map(Snapshot::payload).orElse(null));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", stored != null);
        out.put("macroCount", stored == null ? null : stored.macroEvents().size());
        out.put("earningsCovered", stored == null ? null : stored.covered());
        out.put("universe", stored == null ? null : stored.universe());
        out.put("generatedAtKst", stored == null || found.get().collectedAt() == null ? null
                : Kst.stamp(found.get().collectedAt()));
        out.put("fredStatus", stored == null ? null : stored.fredStatus());
        return out;
    }

    /**
     * 재무 수집 범위(D28) — 수집기 상태 저장본 {@code us.fundamentals.status}의 요약
     * {@code {available, universe, mapped, covered, latestFetchKst, staleCompanies, note}}. universe = 유니버스(ETF 제외) 종목 수,
     * mapped = SEC CIK가 잡힌 수, covered = 상태 줄에 최신 공시일이 있는 회사 수(받았지만 companyfacts가 없는 회사·아직 못 받은 회사는
     * 빠짐 — 상태 줄 기준이라, 실패가 3일 넘게 이어져 오류만 남은 회사는 저장된 관측 행이 있어도 빠짐), latestFetchKst = 저장본을
     * 마지막으로 쓴 수집 시각, staleCompanies = 지금 이어받은 상태(isStale)인 회사 수(실패해 이전 값을 이어받은 뒤 아직 다시 받지
     * 못한 회사 — 그 뒤 실행에서 예산·시간 상한으로 시도하지 않은 회사도 들어가므로 '이번 실행의 실패 수'가 아님). 저장본이
     * 없으면 숫자는 모두 null(0으로 채우지 않음). 수집 요청 없이 저장본만 읽습니다(화면이 수집기를 깨우지 않게).
     */
    private Map<String, Object> fundamentalsStatus() {
        Optional<Snapshot> found = reader.readStored(Datasets.SNAP_US_FUNDAMENTALS_STATUS);
        JsonNode payload = found.map(Snapshot::payload).filter(JsonNode::isObject).orElse(null);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", payload != null);
        if (payload == null) {
            out.put("universe", null);
            out.put("mapped", null);
            out.put("covered", null);
            out.put("latestFetchKst", null);
            out.put("staleCompanies", null);
            out.put("note", "재무 상태 저장본(" + Datasets.SNAP_US_FUNDAMENTALS_STATUS + ")이 아직 없습니다 — 수집기의 "
                    + "sec_fundamentals 태스크가 한 번 돌면 생깁니다.");
            return out;
        }
        Integer covered = null;
        Integer stale = null;
        JsonNode companies = Json.child(payload, "companies");
        if (companies != null && companies.isObject()) {
            int withFacts = 0;
            int carried = 0;
            for (Map.Entry<String, JsonNode> entry : companies.properties()) {
                JsonNode company = entry.getValue();
                if (Json.asText(company, "latestFiled") != null) {
                    withFacts++;
                }
                if (Json.asBoolean(company, "isStale")) {
                    carried++;
                }
            }
            covered = withFacts;
            stale = carried;
        }
        out.put("universe", count(payload, "universe"));
        out.put("mapped", count(payload, "mapped"));
        out.put("covered", covered);
        out.put("latestFetchKst", found.get().collectedAt() == null ? null : Kst.stamp(found.get().collectedAt()));
        out.put("staleCompanies", stale);
        // 예산은 설정(FUNDAMENTALS_FETCH_BUDGET)이라 저장본에 남은 값으로 적습니다 — 모르면 문장에서 뺍니다.
        Integer budget = count(payload, "budget");
        out.put("note", "SEC XBRL Company Facts — Claude 계좌 패킷(8b_fundamentals)에만 씁니다(규칙 계좌·검증기는 읽지 않음). "
                + (budget == null ? "" : "12시간마다 CIK " + budget + "건까지 받아 유니버스를 여러 번에 나눠 돕니다. ")
                + "실적 보도자료(8-K)는 들어오지 않습니다.");
        return out;
    }

    /** 저장본의 개수 칸 — 정수가 아니면 null. */
    private static Integer count(JsonNode payload, String field) {
        JsonNode value = Json.child(payload, field);
        return value != null && value.isIntegralNumber() ? value.asInt() : null;
    }

    /**
     * Claude 호출 사용량(명세 C8) — 오늘(KST)의 호출 수·상한·정기 작업 몫 예약·수동 호출 문턱(상한 − 예약)·토큰·추정 비용과 이달(KST) 누적. 추정 비용({@code estCostUsd})은 호출
     * 때의 설정 단가({@code pricing.*})로 낸 값의 합이고 {@code estimatedCalls}회만 셉니다(단가를 모르는 모델·토큰을 모르는 호출·단가
     * 도입(V11) 전 호출은 빠짐 — {@link PaperApiCalls}). 추정한 호출이 없으면 null(0달러로 채우지 않음), 늘 {@code isEstimated:true}.
     */
    private Map<String, Object> apiUsage() {
        LocalDate today = Kst.today(clock);
        JsonNode body = store.settings().map(PaperStore.SettingsRow::body).orElse(null);
        ClaudeBookService.ClaudeSettings claude = ClaudeBookService.ClaudeSettings.from(
                body == null ? settings.defaultsJson() : body);
        Optional<PaperStore.ApiUsage> day = store.apiUsage(today);
        Map<String, Object> todayView = new LinkedHashMap<>();
        todayView.put("day", today.toString());
        todayView.put("calls", day.map(PaperStore.ApiUsage::calls).orElse(0));
        todayView.put("cap", claude.dailyCallCap());
        // 수동 호출(미리보기·시작·수동 결정·프레임 제안·수동 복기)은 정기 작업 몫을 남긴 문턱까지(2단계 명세 §4-10) — 상한만 보이면 남은 몫을
        // 잘못 읽습니다(묶음 E 리뷰).
        todayView.put("scheduledReserve", claude.scheduledReserve());
        todayView.put("manualLimit", claude.callLimit(false));
        todayView.put("inputTokens", day.map(PaperStore.ApiUsage::inputTokens).orElse(0L));
        todayView.put("outputTokens", day.map(PaperStore.ApiUsage::outputTokens).orElse(0L));
        todayView.put("cacheReadTokens", day.map(PaperStore.ApiUsage::cacheReadTokens).orElse(0L));
        todayView.put("cacheWriteTokens", day.map(PaperStore.ApiUsage::cacheWriteTokens).orElse(0L));
        todayView.put("estCostUsd", round4(day.map(PaperStore.ApiUsage::estCostUsd).orElse(null)));
        todayView.put("estimatedCalls", day.map(PaperStore.ApiUsage::estCostCalls).orElse(0));
        todayView.put("isEstimated", true);
        YearMonth month = YearMonth.from(today);
        PaperStore.ApiUsageTotal total = store.apiUsageBetween(month.atDay(1), month.atEndOfMonth());
        Map<String, Object> monthView = new LinkedHashMap<>();
        monthView.put("month", month.toString());
        monthView.put("days", total.days());
        monthView.put("calls", total.calls());
        monthView.put("inputTokens", total.inputTokens());
        monthView.put("outputTokens", total.outputTokens());
        monthView.put("cacheReadTokens", total.cacheReadTokens());
        monthView.put("cacheWriteTokens", total.cacheWriteTokens());
        monthView.put("estCostUsd", round4(total.estCostUsd()));
        monthView.put("estimatedCalls", total.estCostCalls());
        monthView.put("isEstimated", true);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("today", todayView);
        out.put("month", monthView);
        out.put("note", "호출 수는 성공·실패를 모두 셉니다. 토큰은 응답이 알려 준 값의 합입니다. 추정 비용은 설정의 단가(pricing.*)로 낸 "
                + "어림이고 estimatedCalls회만 셉니다 — 단가를 모르는 모델·토큰을 모르는 호출·단가 도입 전 호출은 추정에서 빠졌습니다.");
        return out;
    }

    /**
     * 성과 화면의 프레임 경계(F5, 계약 보충 §4) — Claude 책 결정에 판마다 처음 쓰인 거래일 {@code [{tradingDate, version, status}]},
     * 거래일 순. 판 번호가 남은 결정이 없으면 빈 목록입니다(단계 3b 전 결정은 판 번호가 null이라 세지 않음).
     */
    private List<Map<String, Object>> frameworkBoundaries(PaperMarket market) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (PaperStore.FrameworkBoundary b : store.frameworkBoundaries(market.claudeBook())) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("tradingDate", text(b.tradingDate()));
            row.put("version", b.version());
            row.put("status", b.status());
            out.add(row);
        }
        return out;
    }

    /**
     * Claude 노출 추이(설계 §8) — 거래일 오름차순 {@code [{tradingDate, targetExposurePct, actualExposurePct}]}. 목표는 그 거래일
     * 결정이 적은 {@code targetEquityExposurePct}(같은 날 결정이 여럿이면 가장 나중의 값 있는 것 — 실패한 결정은 값이 없음), 실제는
     * 그 거래일 순자산 줄의 노출({@code exposure_pct}, 현금성 포함). 둘 중 하나라도 있는 거래일만 싣고, 없는 쪽은 null입니다.
     * 그 거래일 결정의 목표는 다음 세션에 체결돼 반영되므로, 같은 줄의 실제 노출은 "결정할 때의 노출"입니다.
     */
    private List<Map<String, Object>> claudeExposureSeries(PaperMarket market, List<NavRow> nav) {
        java.util.TreeMap<LocalDate, Double> target = new java.util.TreeMap<>();
        // 최근 순(같은 날은 나중 결정 먼저)이라 그날 처음 만난 값 있는 결정이 가장 나중 것입니다.
        for (PaperStore.DecisionSummary d : store.decisions(market.claudeBook(), MAX_LIMIT)) {
            if (d.targetExposurePct() != null) {
                target.putIfAbsent(d.asOfTradingDate(), d.targetExposurePct());
            }
        }
        java.util.TreeMap<LocalDate, Double> actual = new java.util.TreeMap<>();
        nav.forEach(row -> actual.put(row.tradingDate(), row.exposurePct()));
        TreeSet<LocalDate> dates = new TreeSet<>(target.keySet());
        dates.addAll(actual.keySet());
        List<Map<String, Object>> out = new ArrayList<>();
        for (LocalDate date : dates) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("tradingDate", date.toString());
            row.put("targetExposurePct", round2(target.get(date)));
            row.put("actualExposurePct", round2(actual.get(date)));
            out.add(row);
        }
        return out;
    }

    /** 책 하나의 요약(BookSummary) — 버튼 응답이 바뀐 책을 다시 그릴 때. */
    public Map<String, Object> bookSummary(String code) {
        Book book = existing(code);
        return bookSummary(book, markets.open(marketOf(book)));
    }

    /** {@link #bookSummary(String)} — 이미 연 조회의 시장 문맥으로(한 조회가 달력을 두 번 만들지 않게). */
    private Map<String, Object> bookSummary(Book book, MarketRun market) {
        Map<String, List<NavRow>> navByBook = new HashMap<>();
        navByBook.put(book.code(), store.navSeries(book.code()));
        String benchmark = market.benchmarkOf(book.code());
        if (benchmark != null) {
            navByBook.put(benchmark, store.navSeries(benchmark));
        }
        return summary(market, book, navByBook);
    }

    // ------------------------------------------------------------------ 책별
    /** GET /api/paper/books/{code}/positions */
    public Map<String, Object> positions(String code) {
        if (!ready()) {
            return notReady();
        }
        Book book = existing(code);
        // 이 조회의 시장 문맥(그 책의 시장) — 보유 거래일의 달력 한 벌.
        MarketRun run = markets.open(marketOf(book));
        Optional<BookState> state = store.state(code);
        // 그 책 시장의 설정(현금성·스탑 비율 — 그 실행이 읽은 판, C1a).
        PaperSettings current = run.settings();
        boolean benchmark = PaperBooks.KIND_BENCHMARK.equals(book.kind());
        Double nav = state.map(BookState::nav).orElse(null);
        TradingCalendar calendar = run.calendar();
        // 달력이 모르는 해(공휴일 목록 없음)에 닿으면 보유 거래일만 null + 사유 — 응답 전체를 실패시키지 않습니다(명세 K35).
        LocalDate session = null;
        String calendarGap = null;
        try {
            session = calendar.currentOrLastSession(clock.instant());
        } catch (CalendarUnavailableException e) {
            calendarGap = e.getMessage();
        }

        // 사후 체결로 연 보유: 그 종목의 사후 매수 체결 관측 시각 = 보유를 연 시각.
        Map<String, Instant> backfillOpened = new HashMap<>();
        for (Fill fill : store.recentFills(code, MAX_LIMIT)) {
            if (fill.backfill() && PaperBooks.BUY.equals(fill.side())) {
                backfillOpened.put(fill.ticker(), fill.observedAt());
            }
        }

        List<Map<String, Object>> rows = new ArrayList<>();
        for (Position p : store.positions(code)) {
            boolean cashLike = current.cashLike(p.ticker());
            double valuationPrice = p.lastPrice() != null ? p.lastPrice() : p.avgCost();
            double marketValue = p.qty() * valuationPrice;
            Double stopPrice = benchmark || cashLike ? null : TrailingStop.stopPrice(p.highWatermark(),
                    current.trailingStopPct());
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", p.ticker());
            row.put("qty", p.qty());
            row.put("avgCost", round4(p.avgCost()));
            row.put("lastPrice", round4(p.lastPrice()));
            row.put("lastPriceAtKst", stamp(p.lastPriceAt()));
            // 가격을 한 번도 받지 못했으면 평단으로 평가한 값입니다(장부 평가와 같음) — priceStale로 함께 표시.
            row.put("marketValue", round2(marketValue));
            row.put("weightPct", nav != null && nav > 0 ? round2(marketValue / nav * 100.0) : null);
            row.put("unrealizedPct", p.lastPrice() != null && p.avgCost() > 0
                    ? round2((p.lastPrice() / p.avgCost() - 1.0) * 100.0) : null);
            row.put("highWatermark", round4(p.highWatermark()));
            row.put("stopPrice", round4(stopPrice));
            row.put("stopDistancePct", stopPrice != null && p.lastPrice() != null && stopPrice > 0
                    ? round2((p.lastPrice() / stopPrice - 1.0) * 100.0) : null);
            row.put("openedOn", text(p.openedOn()));
            Integer holdingDays = null;
            String holdingDaysReason = p.openedOn() == null ? null : calendarGap;
            if (p.openedOn() != null && session != null) {
                try {
                    holdingDays = calendar.tradingDaysBetween(p.openedOn(), session);
                } catch (CalendarUnavailableException e) {
                    holdingDaysReason = e.getMessage();
                }
            }
            row.put("holdingTradingDays", holdingDays);
            row.put("holdingTradingDaysReason", holdingDaysReason);
            row.put("priceStale", p.priceStale() || p.lastPrice() == null);
            row.put("splitNote", p.splitNote());
            row.put("cashLike", cashLike);
            row.put("backfilled", p.openedAt() != null && p.openedAt().equals(backfillOpened.get(p.ticker())));
            rows.add(row);
        }
        List<Map<String, Object>> lockouts = new ArrayList<>();
        for (Lockout lockout : store.lockouts(code)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("ticker", lockout.ticker());
            row.put("untilTradingDate", text(lockout.untilTradingDate()));
            row.put("reason", lockout.reason());
            lockouts.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("book", bookSummary(book, run));
        out.put("positions", rows);
        out.put("lockouts", lockouts);
        out.put("cash", state.map(s -> round2(s.cash())).orElse(null));
        return out;
    }

    /** GET /api/paper/books/{code}/orders?limit= (1–500, 최근 순) */
    public Map<String, Object> orders(String code, int limit) {
        if (!ready()) {
            return notReady();
        }
        existing(code);
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Order o : store.recentOrders(code, Params.clamp(limit, 1, MAX_LIMIT))) {
            rows.add(orderRow(o));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("orders", rows);
        return out;
    }

    /** 주문 한 줄(주문 목록·결정 상세가 같은 모양). */
    private static Map<String, Object> orderRow(Order o) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", o.id());
        row.put("ticker", o.ticker());
        row.put("side", o.side());
        row.put("qty", o.qty());
        row.put("targetWeightPct", o.targetWeightPct());
        row.put("sellFraction", o.sellFraction());
        row.put("timing", o.timing());
        row.put("source", o.source());
        row.put("status", o.status());
        row.put("rejectReason", o.rejectReason());
        row.put("reason", o.reason());
        row.put("asOfTradingDate", text(o.asOfTradingDate()));
        row.put("createdAtKst", stamp(o.createdAt()));
        row.put("expiresOn", text(o.expiresOn()));
        row.put("filledAtKst", stamp(o.filledAt()));
        return row;
    }

    /** GET /api/paper/books/{code}/fills?limit= (1–500, 최근 순) */
    public Map<String, Object> fills(String code, int limit) {
        if (!ready()) {
            return notReady();
        }
        existing(code);
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Fill f : store.recentFills(code, Params.clamp(limit, 1, MAX_LIMIT))) {
            rows.add(fillRow(f));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("fills", rows);
        return out;
    }

    /** 체결 한 줄(체결 목록·시작 응답이 같은 모양). */
    private static Map<String, Object> fillRow(Fill f) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("id", f.id());
        row.put("orderId", f.orderId());
        row.put("ticker", f.ticker());
        row.put("side", f.side());
        row.put("qty", f.qty());
        row.put("price", round4(f.price()));
        row.put("rawPrice", round4(f.rawPrice()));
        row.put("slippageBp", f.slippageBp());
        row.put("gross", round2(f.gross()));
        row.put("observedAtKst", stamp(f.observedAt()));
        row.put("observationDate", text(f.observationDate()));
        row.put("priceSource", f.priceSource());
        row.put("backfill", f.backfill());
        return row;
    }

    /** GET /api/paper/books/{code}/nav — 거래일 오름차순. */
    public Map<String, Object> nav(String code) {
        if (!ready()) {
            return notReady();
        }
        existing(code);
        List<Map<String, Object>> rows = new ArrayList<>();
        for (NavRow r : store.navSeries(code)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("tradingDate", text(r.tradingDate()));
            row.put("nav", round2(r.nav()));
            row.put("cash", round2(r.cash()));
            row.put("equityValue", round2(r.equityValue()));
            row.put("exposurePct", round2(r.exposurePct()));
            row.put("pricesFinal", r.pricesFinal());
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("book", bookSummary(code));
        out.put("series", rows);
        return out;
    }

    // ------------------------------------------------------------------ 조각
    /**
     * BookSummary. 시작 전 책은 수익률·통계를 내지 않습니다(null) — 현금만 든 책의 "0%"는 성과가 아니라 아직 시작하지 않은
     * 것이기 때문입니다. 통계는 그 책의 거래일 순자산과 같은 날의 SPY 100% 책 순자산(없는 날은 null)으로 계산합니다(L10).
     */
    private Map<String, Object> summary(PaperMarket market, Book book, Map<String, List<NavRow>> navByBook) {
        Optional<BookState> state = store.state(book.code());
        List<Position> positions = store.positions(book.code());
        boolean started = !PaperBooks.NOT_STARTED.equals(book.status());
        String benchmark = market.benchmarkOf(book.code());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("code", book.code());
        out.put("kind", book.kind());
        out.put("label", book.label());
        out.put("status", book.status());
        out.put("startedOn", text(book.startedOn()));
        out.put("initialCash", round2(book.initialCash()));
        out.put("cash", state.map(s -> round2(s.cash())).orElse(null));
        out.put("nav", state.map(s -> round2(s.nav())).orElse(null));
        out.put("equityValue", state.map(s -> round2(s.equityValue())).orElse(null));
        out.put("exposurePct", state.map(s -> round2(s.exposurePct())).orElse(null));
        out.put("returnPct", started && book.initialCash() > 0
                ? state.map(s -> round2((s.nav() / book.initialCash() - 1.0) * 100.0)).orElse(null) : null);
        out.put("lastObservedAtKst", state.map(s -> stamp(s.lastObservedAt())).orElse(null));
        out.put("positions", positions.size());
        out.put("staleCount", (int) positions.stream().filter(p -> p.priceStale() || p.lastPrice() == null).count());
        Map<String, Object> stats = null;
        String statsReason = null;
        if (started) {
            try {
                stats = stats(market.calendar(), navByBook.getOrDefault(book.code(), List.of()),
                        benchmark == null ? null : navByBook.getOrDefault(benchmark, List.of()));
            } catch (CalendarUnavailableException e) {
                // 순자산 줄이 걸친 해의 공휴일 목록이 없음 — 표본 거래일을 셀 수 없어 통계만 null + 사유(명세 K35).
                statsReason = e.getMessage();
            }
        }
        out.put("stats", stats);
        out.put("statsReason", statsReason);
        out.put("benchmark", benchmark);
        return out;
    }

    /**
     * 통계 — 표본·하루 간격 쌍의 거래일은 그 책 시장의 달력으로 셉니다. 순자산이 0 이하인 날(있을 수 없지만)은 빼고, 계산이
     * 거절되면(날짜 순서 등) null. 달력이 그 줄들이 걸친 해를 모르면 {@link CalendarUnavailableException}이 나갑니다(부르는 쪽이
     * null + 사유로 — {@code statsReason}).
     */
    private static Map<String, Object> stats(TradingCalendar calendar, List<NavRow> rows, List<NavRow> benchmarkRows) {
        Map<LocalDate, Double> benchmarkByDate = new HashMap<>();
        if (benchmarkRows != null) {
            benchmarkRows.forEach(row -> benchmarkByDate.put(row.tradingDate(), row.nav()));
        }
        List<LocalDate> dates = new ArrayList<>();
        List<Double> nav = new ArrayList<>();
        List<Double> bench = new ArrayList<>();
        for (NavRow row : rows) {
            if (row.nav() > 0) {
                dates.add(row.tradingDate());
                nav.add(row.nav());
                Double b = benchmarkByDate.get(row.tradingDate());
                bench.add(b != null && b > 0 ? b : null);
            }
        }
        PaperStats.Stats s;
        try {
            s = PaperStats.compute(calendar, dates, nav, benchmarkRows == null ? null : bench);
        } catch (IllegalArgumentException e) {
            return null;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("cumReturnPct", round2(s.cumReturnPct()));
        out.put("cagrPct", round2(s.cagrPct()));
        out.put("volPct", round2(s.volPct()));
        out.put("mddPct", round2(s.mddPct()));
        out.put("sharpe", round2(s.sharpe()));
        out.put("excessPct", round2(s.excessPct()));
        out.put("beta", round2(s.beta()));
        out.put("sampleDays", s.sampleDays());
        return out;
    }

    /** 순자산 곡선 — 거래일 합집합, 책마다 같은 길이(그날 기록이 없으면 null, 화면이 끊어 그림). */
    private static Map<String, Object> navSeries(List<Book> books, Map<String, List<NavRow>> navByBook) {
        TreeSet<LocalDate> dates = new TreeSet<>();
        navByBook.values().forEach(rows -> rows.forEach(row -> dates.add(row.tradingDate())));
        List<String> dateTexts = dates.stream().map(LocalDate::toString).toList();
        Map<String, Object> series = new LinkedHashMap<>();
        for (Book book : books) {
            Map<LocalDate, Double> byDate = new HashMap<>();
            navByBook.getOrDefault(book.code(), List.of()).forEach(row -> byDate.put(row.tradingDate(), row.nav()));
            List<Double> values = new ArrayList<>();
            for (LocalDate date : dates) {
                values.add(round2(byDate.get(date)));
            }
            series.put(book.code(), values);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("dates", dateTexts);
        out.put("books", series);
        return out;
    }

    /** 그 시장 관측치 요약. 저장본이 없으면 null. */
    private Map<String, Object> quotesSummary(PaperMarket market) {
        Optional<Quotes> found = reader.quietly(() -> marketData.quotes(market));
        if (found.isEmpty()) {
            return null;
        }
        Quotes quotes = found.get();
        Instant now = clock.instant();
        long age = Math.max(0, Duration.between(quotes.collectedAt(), now).getSeconds());
        LocalDate barDate = quotes.modalBarDate();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("collectedAtKst", Kst.stamp(quotes.collectedAt()));
        out.put("ageSeconds", age);
        out.put("barDate", text(barDate));
        try {
            // 그 봉의 종가가 나왔나(장중 값이 아님 — 시장의 closeAvailable, 결정 d9). 금융위 확정 여부가 아닙니다(순자산 줄의 prices_final).
            out.put("finalClose", barDate != null && market.closeAvailable(barDate, quotes.collectedAt()));
        } catch (CalendarUnavailableException e) {
            // 봉 날짜의 해를 달력이 모름(명세 K35 — 그 계산만) — 확정 여부를 지어내지 않고 null + 사유. 미국은 생기지 않습니다.
            out.put("finalClose", null);
            out.put("finalCloseReason", e.getMessage());
        }
        out.put("tickers", quotes.bars().size());
        out.put("staleTickers", quotes.staleTickers());
        try {
            // 늦음이 되는 순간은 시장 규칙(그 실행의 달력) — 저장본 머리가 밝힌 세션(한국 계약 1의 session, C2b)으로, 없으면(미국) 수집 시각으로.
            out.put("stale", !now.isBefore(market.quotesLateAt(quotes.collectedAt(), quotes.session(), market.calendar())));
        } catch (CalendarUnavailableException e) {
            // 그 계산만 모름(명세 K35) — 늦음을 지어내지 않고 null + 사유. 미국 달력은 늘 알아 이 칸이 생기지 않습니다.
            out.put("stale", null);
            out.put("staleReason", e.getMessage());
        }
        return out;
    }

    /**
     * 가장 최근 기관 선정의 요지 {@code {asOfDate, groupA:[{cik, name, rank}], groupB:[{cik, name, rank}],
     * pool:[{cik, name, groups, weight}]}}(D27 — 자세한 것은 GET /track-record). groupA·groupB는 그 그룹의 선정(순위 순), pool은
     * 신호 풀(풀 순서, weight = 기관 가중 0~1). 이름·순위는 선정 때 남긴 순위표의 값이고 모르면 null. 섞기(D27) 전에 남긴
     * 선정은 groupA만 있고 groupB는 빈 목록입니다({@link PaperSelectionService#signalPool}). 선정이 없으면 null — 선정은 1년에
     * 몇 줄뿐이라 싸게 읽습니다.
     */
    private Map<String, Object> latestSelection() {
        return store.selections().stream().findFirst().map(selection -> {
            PaperSelectionService.SignalPool pool = PaperSelectionService.signalPool(selection);
            List<Map<String, Object>> pooled = new ArrayList<>();
            for (PaperSelectionService.PoolMember m : pool.members()) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("cik", m.cik());
                row.put("name", m.name());
                row.put("groups", m.groups());
                row.put("weight", m.weight());
                pooled.add(row);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("asOfDate", selection.asOfDate().toString());
            out.put("groupA", selectedView(pool.selectedA()));
            out.put("groupB", selectedView(pool.selectedB()));
            out.put("pool", pooled);
            return out;
        }).orElse(null);
    }

    private static List<Map<String, Object>> selectedView(List<PaperSelectionService.RankedFiler> filers) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (PaperSelectionService.RankedFiler f : filers) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("cik", f.cik());
            row.put("name", f.name());
            row.put("rank", f.rank());
            out.add(row);
        }
        return out;
    }

    /**
     * 최근 작업 기록 — 미국 응답은 모든 작업(시장을 나누기 전 그대로), 미국 밖 시장은 그 시장 작업 기록 이름의 접두어로 시작하는 것만
     * ({@link PaperMarket#jobPrefix} — 한국 {@code kr.}).
     */
    private List<Map<String, Object>> jobs(PaperMarket market, int limit) {
        List<Map<String, Object>> out = new ArrayList<>();
        List<JobRun> runs = usOnly(market) ? store.recentJobRuns(limit)
                : store.recentJobRuns(market.jobPrefix(), limit);
        for (JobRun run : runs) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("job", run.job());
            row.put("startedAtKst", stamp(run.startedAt()));
            row.put("finishedAtKst", stamp(run.finishedAt()));
            row.put("outcome", run.outcome());
            row.put("detail", run.detail());
            out.add(row);
        }
        return out;
    }

    /** 그 시장 책, 정의 순. */
    private List<Book> sortedBooks(PaperMarket market) {
        List<Book> books = new ArrayList<>(store.books(market.code()));
        books.sort(Comparator.comparing(Book::code, market.bookOrder()));
        return books;
    }

    /** 그 시장 책 정의가 모두 있나. */
    private static boolean initialized(PaperMarket market, List<Book> books) {
        return market.books().stream().allMatch(d -> books.stream().anyMatch(b -> b.code().equals(d.code())));
    }

    /** 그 책의 시장 묶음({@code paper_books.market}). 이 서비스가 모르는 시장이면 IllegalStateException(코드·자료 오류). */
    private PaperMarket marketOf(Book book) {
        return markets.of(book.market()).orElseThrow(() -> new IllegalStateException(
                "모르는 시장의 계좌입니다: " + book.code() + " (" + book.market() + ")"));
    }

    /**
     * 아직 사후 체결하지 못한(시작 전) 벤치마크 책 코드, 정의 순. 초기화는 책 넷을 만들고 끝나므로 {@code initialized}는
     * true가 되지만, 출발일 종가를 받기 전에 눌렀으면 벤치마크가 시작 전으로 남습니다 — 화면은 이 목록이 비지 않으면
     * 초기화 버튼을 계속 보여 줍니다(다시 누르면 그때 체결, 초기화는 멱등).
     */
    private static List<String> pendingBackfill(List<Book> books) {
        return books.stream().filter(b -> PaperBooks.KIND_BENCHMARK.equals(b.kind())
                && PaperBooks.NOT_STARTED.equals(b.status())).map(Book::code).toList();
    }

    /** 없는 책 코드는 404가 아니라 400 — 고칠 것(코드)을 알려 줍니다. */
    private Book existing(String code) {
        return store.book(code).orElseThrow(() -> new InvalidRequestException(
                "없는 계좌입니다: " + Params.echo(code) + " (rules · claude · bench_spy · bench_mix)"));
    }

    // ------------------------------------------------------------------ 숫자·글자
    static Double round2(Double value) {
        return round(value, 2);
    }

    static Double round4(Double value) {
        return round(value, 4);
    }

    private static Double round(Double value, int scale) {
        if (value == null || !Double.isFinite(value)) {
            return null;
        }
        return BigDecimal.valueOf(value).setScale(scale, RoundingMode.HALF_UP).doubleValue();
    }

    private static String stamp(TemporalAccessor moment) {
        return moment == null ? null : Kst.stamp(moment);
    }

    private static String text(LocalDate date) {
        return date == null ? null : date.toString();
    }
}
