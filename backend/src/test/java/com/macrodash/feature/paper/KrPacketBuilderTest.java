package com.macrodash.feature.paper;

import com.macrodash.Golden;
import com.macrodash.analytics.KrxCalendar;
import com.macrodash.feature.paper.PacketBuilder.Packet;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.Book;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Note;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.RegimeLogStore;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.store.StoreRepository.TimeseriesColumns;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 한국 Claude 패킷(2단계 명세 §4-7·K8·K39, E1a) — 섹션 구성(미국의 2·3_fred·4·5·6·6b·7 없음, 3_kr_macro), 판 6·KR·KRW, 국면 전날 판정, 1b 금통위·
 * 일정 미확인 발표·실적·컨센서스 null, 8_prices 줄 순서(보유 → ETF → U 점수 순)·잠정 종가·수정 종가 수익률·수급·체결할 수 없는 사유, 8b DART 접수일 ≤
 * 기준일, 9 장부·대기 주문·이달 재량 주문(출발 결정 주문 제외), 11 한국 메모(공유 설정 키), 11b 한국 사건(연합뉴스 포함 피드 넷), 12 한국 하드 규칙,
 * <b>읽은 순간 뒤의 값 없음</b>(미국 {@code initialPacketHasNothingAfterAsOf}의 한국판), 크기 예산 자르기, 고정본.
 *
 * <p>가짜 저장소는 읽기 범위(to)를 일부러 무시하고 기준일 뒤 값(가격 이력·시장 합계·환율·선물·시장 매매대금·수급 11-04·11-05)과 읽은 순간 뒤에
 * 받은 값(사건 하나)을 둡니다 — 패킷이 스스로 자르는지 봅니다. 날짜: 출발 S = 2026-10-29(목), 정기 결정 D = 2026-11-03(화)(U 기준일 11-02).
 * 외부 호출 없음.
 */
class KrPacketBuilderTest {

    static final LocalDate S = KrRuleBookServiceTest.S;
    static final LocalDate D = LocalDate.of(2026, 11, 3);
    static final LocalDate D1 = LocalDate.of(2026, 11, 2);
    static final Instant READ_D = kst("2026-11-03T22:31");
    static final Instant READ_S = kst("2026-10-29T22:31");
    private static final Pattern DATE = Pattern.compile("\\d{4}-\\d{2}-\\d{2}");
    /** 자료가 아니라 달력·규칙이 정한 미래 날짜를 담는 키(다음 세션·휴장·재진입 금지 끝·주문·메모 만료). */
    private static final Set<String> CALENDAR_KEYS = Set.of("nextSession", "upcomingClosures", "untilTradingDate",
            "expiresOn");

    private FakePaperStore store;
    private StoreReader reader;
    private StoreRepository repository;
    private RegimeLogStore regimeLog;
    private PaperMarketData marketData;
    private KrFixtures.MovableClock clock;
    private KrRulesFixtures data;
    private KrPacketBuilder builder;
    private final List<JsonNode> news = new ArrayList<>();
    private final Map<String, Snapshot> snapshots = new LinkedHashMap<>();

    static Instant kst(String local) {
        return ZonedDateTime.of(LocalDateTime.parse(local), KrxCalendar.SEOUL).toInstant();
    }

    @BeforeEach
    void setUp() {
        store = new FakePaperStore();
        reader = PaperFixtures.quietReader();
        KrFixtures.stubHolidays(reader, KrFixtures.holidays(2026, 2027));
        repository = mock(StoreRepository.class);
        marketData = new PaperMarketData(reader, repository);
        clock = new KrFixtures.MovableClock(kst("2026-10-28T12:00"));
        KrRuleBookServiceTest.startedBooks(store, reader, marketData, clock);
        data = KrRulesFixtures.standard(LocalDate.of(2026, 10, 28), S, LocalDate.of(2026, 10, 30), D1, D,
                LocalDate.of(2026, 11, 4));
        data.install(repository, reader);
        regimeLog = mock(RegimeLogStore.class);
        when(regimeLog.ready()).thenReturn(true);
        when(regimeLog.recent(anyInt())).thenReturn(List.of(regime(D), regime(D1), regime(LocalDate.of(2026, 10, 28))));
        stubHistory();
        stubSnapshots(D);
        stubNews(D);
        builder = builder(KrPacketBuilder.TARGET_TOKENS);
    }

    private KrPacketBuilder builder(int target) {
        KrRuleBookService rules = new KrRuleBookService(store, reader, marketData,
                new PaperLedgerService(store, marketData, MAPPER), MAPPER, clock);
        return new KrPacketBuilder(store, reader, repository, regimeLog, marketData,
                new NoteService(store, PaperFixtures.settings(store)), rules, KrRuleBookServiceTest.config(), MAPPER,
                target);
    }

    private MarketRun run() {
        return new PaperMarkets(store, reader).open(KrPaperMarket.INSTANCE);
    }

    private static RegimeLogStore.Entry regime(LocalDate date) {
        ObjectNode inputs = MAPPER.createObjectNode();
        inputs.putObject("curve10y3m").put("value", 0.42).put("asOf", date.minusDays(1).toString());
        return new RegimeLogStore.Entry(date, "EXPANSION", "확장 (Expansion)", inputs, List.of(), "regime/v1");
    }

    // ------------------------------------------------------------------ 재료
    /** 수정 종가 이력(kr_close_adj)·시장 합계(fsc_market) — 기준일 뒤 날짜까지(가짜는 to를 무시). */
    private void stubHistory() {
        when(repository.readTimeseriesColumns(eq(Datasets.TS_KR_CLOSE_ADJ), anyCollection(), any(), any()))
                .thenAnswer(invocation -> {
                    Collection<String> codes = invocation.getArgument(1);
                    Map<String, TimeseriesColumns> out = new LinkedHashMap<>();
                    for (String code : codes) {
                        double base = "069500".equals(code) ? 95_000 : "153130".equals(code) ? 108_000 : 10_000;
                        out.put(code, columns(LocalDate.of(2026, 11, 6), 300, base, (code.hashCode() & 7) * 0.0002));
                    }
                    return out;
                });
        when(repository.readTimeseriesColumns(eq(Datasets.TS_FSC_MARKET), anyCollection(), any(), any()))
                .thenAnswer(invocation -> {
                    Map<String, TimeseriesColumns> out = new LinkedHashMap<>();
                    out.put("KOSDAQ.marketCap", columns(LocalDate.of(2026, 11, 4), 30, 480e12, 0.001));
                    out.put("KOSDAQ.tradingValue", columns(LocalDate.of(2026, 11, 4), 30, 9e12, 0));
                    out.put("KOSPI.marketCap", columns(LocalDate.of(2026, 11, 4), 30, 4_800e12, 0.002));
                    out.put("KOSPI.tradingValue", columns(LocalDate.of(2026, 11, 4), 30, 20e12, 0));
                    return out;
                });
    }

    /** {@code end}로 끝나는 KR 거래일 {@code days}일 — 값 = base × (1 + step)^i. */
    private static TimeseriesColumns columns(LocalDate end, int days, double base, double step) {
        List<LocalDate> dates = tradingDays(end, days);
        int[] epoch = new int[days];
        double[] values = new double[days];
        for (int i = 0; i < days; i++) {
            epoch[i] = (int) dates.get(i).toEpochDay();
            values[i] = Math.round(base * Math.pow(1 + step, i));
        }
        return new TimeseriesColumns(epoch, values);
    }

    /** {@code end}로 끝나는 거래일 {@code days}일 — 시험 달력이 아는 2026년부터는 KRX 거래일, 그 앞은 평일(이력 재료일 뿐). */
    private static List<LocalDate> tradingDays(LocalDate end, int days) {
        List<LocalDate> out = new ArrayList<>();
        LocalDate day = end;
        while (out.size() < days) {
            boolean open = day.getYear() >= 2026 ? KrRulesFixtures.CALENDAR.isTradingDay(day)
                    : day.getDayOfWeek().getValue() <= 5;
            if (open) {
                out.add(0, day);
            }
            day = day.minusDays(1);
        }
        return out;
    }

    /** 기준 세션의 밤 저장본들 — 모두 그날 22:2x KST에 수집(읽은 순간 22:31 전). 날짜가 있는 값은 기준일 뒤 날도 둠. */
    private void stubSnapshots(LocalDate session) {
        String day = session.toString();
        ObjectNode macro = MAPPER.createObjectNode();
        ArrayNode items = macro.putArray("categories").addObject().putArray("items");
        card(items, "kospi", "코스피 (KOSPI)", 4_012.5, 3_990.1, day + " 22:25 KST (TradingView 수집 시각)", "TradingView (KRX:KOSPI)");
        card(items, "sp500", "S&P 500", 7_000, 6_990, day + " 05:00 KST", "Yahoo Finance (^GSPC)");
        card(items, "kospi200_night_scraped", "코스피200 야간선물", 560.3, 558.0, day + " 22:25 KST (TradingView 수집 시각)",
                "TradingView Scanner");
        card(items, "usdkrw", "원/달러 (USD/KRW)", 1_386.4, 1_380.0, day + " 22:25 KST", "Yahoo Finance (KRW=X)");
        card(items, "jpykrw", "엔/원 100엔당 (JPY/KRW)", 905.2, 903.0, day + " 22:25 KST (TradingView 수집 시각)",
                "TradingView (FX_IDC:JPYKRW)");
        snapshot(Datasets.SNAP_MACRO_COLLECTED, macro, kst(day + "T22:25"));

        ObjectNode fx = MAPPER.createObjectNode();
        ObjectNode series = fx.putObject("series");
        fxSeries(series, "usdkrw", "원/달러", 1_350);
        fxSeries(series, "jpykrw", "엔/원", 900);
        fxSeries(series, "usdjpy", "달러/엔", 150);
        fxSeries(series, "dxy", "달러 인덱스", 104);
        snapshot(Datasets.SNAP_FX_HISTORY, fx, kst(day + "T22:05"));

        ObjectNode futures = MAPPER.createObjectNode();
        ArrayNode rows = futures.putArray("rows");
        int i = 0;
        for (LocalDate date : tradingDays(LocalDate.of(2026, 11, 4), 5)) {
            rows.addObject().put("date", date.toString()).put("contractName", "코스피200 F 202612 (주간)")
                    .put("futuresClose", 560.0 + i).put("changePct", 0.25).put("openInterest", 250_000.0 + i)
                    .put("oiChange", 1_000.0).put("marketBasis", 0.5).put("marketPhase", "신규 롱 (Long Accumulation)");
            i++;
        }
        snapshot(Datasets.SNAP_KRX_FUTURES, futures, kst(day + "T22:04"));

        ObjectNode trend = MAPPER.createObjectNode();
        ArrayNode trendRows = trend.putArray("rows");
        trendRows.addObject().put("investor", "외국인 (스마트머니)").put("netToday", 6_002).put("net5d", 13_852)
                .put("net20d", 10_200).put("stance", "🟢 매수 우위(Long)");
        trendRows.addObject().put("investor", "개인 (리테일)").put("netToday", -1_487).put("net5d", -842)
                .put("net20d", 1_446).put("stance", "🔴 매도 우위(Short)");
        trend.put("unit", "계약").put("measure", "CONTRACT").put("dataDate", day).put("isPlaceholder", false);
        snapshot(Datasets.daumFuturesTrend(Datasets.DAUM_TREND_LOOKBACK), trend, kst(day + "T22:04"));

        ObjectNode market = MAPPER.createObjectNode();
        market.put("unit", "KRW");
        ObjectNode markets = market.putObject("markets");
        for (String name : List.of("KOSPI", "KOSDAQ")) {
            ArrayNode records = markets.putObject(name).putArray("records");
            int k = 0;
            List<LocalDate> dates = tradingDays(LocalDate.of(2026, 11, 4), 25);
            for (int j = dates.size() - 1; j >= 0; j--) {
                LocalDate date = dates.get(j);
                ObjectNode r = records.addObject();
                r.put("date", date.toString());
                ObjectNode inv = r.putObject("investors");
                inv.putObject("foreigner").put("net", (k % 3 - 1) * 120_000_000_000L);
                inv.putObject("institution").put("net", 40_000_000_000L);
                inv.putObject("individual").put("net", -(k % 3 - 1) * 120_000_000_000L - 40_000_000_000L);
                r.put("updatedAt", date + "T20:06:03.000+09:00");
                k++;
            }
        }
        snapshot(Datasets.SNAP_TOSS_MARKET_FLOWS, market, kst(day + "T22:03"));

        ObjectNode calendar = MAPPER.createObjectNode();
        ObjectNode m = calendar.putObject("macro");
        String bokUrl = "https://www.bok.or.kr/portal/singl/crncyPolicyDrcMtg/listYear.do?mtgSe=A&menuNo=200755";
        m.putObject("bok").put("note", "2027 일정 미게시 — 시험").put("source", bokUrl).put("status", "갱신 필요")
                .put("through", "2026-11-26").put("checkedAt", "2026-10-26");
        ArrayNode events = m.putArray("events");
        events.addObject().put("date", "2026-11-26").put("kind", "MPB").put("name", "금통위 통화정책방향 결정").put("source", bokUrl);
        events.addObject().put("date", "2026-11-11").put("kind", "RELEASE").put("name", "고용동향(시험)")
                .put("source", "국가데이터처 국가통계 공표일정(시험)");
        events.addObject().put("date", "2026-10-30").put("kind", "RELEASE").put("name", "산업활동동향(시험)")
                .put("source", "국가데이터처 국가통계 공표일정(시험)");
        m.putObject("horizon").put("from", day).put("to", session.plusDays(45).toString());
        ObjectNode releases = m.putObject("releases");
        releases.putObject("CPI").put("name", "소비자물가동향").put("agency", "국가데이터처").put("status", "일정 미확인")
                .putNull("through");
        releases.putObject("EMPLOYMENT").put("name", "고용동향(시험)").put("agency", "국가데이터처").put("status", "확인")
                .put("through", "2026-12-31");
        m.putArray("unconfirmed").add("CPI");
        calendar.putNull("earnings").put("earningsNote", "한국 실적 발표 일정 출처 없음").putNull("consensus")
                .put("consensusNote", "한국 컨센서스 출처 없음");
        snapshot(Datasets.SNAP_KR_CALENDAR, calendar, kst(day + "T22:01"));

        ObjectNode status = MAPPER.createObjectNode();
        ObjectNode feeds = status.putObject("feeds");
        feeds.putObject("bok_press").put("status", "ok").put("lastOkAt", session + "T13:20:00+00:00");
        feeds.putObject("mods_press").put("status", "실패").put("lastOkAt", session.minusDays(2) + "T13:00:00+00:00");
        feeds.putObject("mofe_press").put("status", "ok").put("lastOkAt", session + "T13:20:00+00:00");
        feeds.putObject("yna_market").put("status", "ok").put("lastOkAt", session + "T13:20:00+00:00");
        when(reader.readStored(eq(Datasets.SNAP_KR_NEWS_STATUS)))
                .thenReturn(Optional.of(KrFixtures.snapshot(Datasets.SNAP_KR_NEWS_STATUS, status, kst(day + "T22:20"))));
    }

    private void snapshot(String name, JsonNode payload, Instant collectedAt) {
        Snapshot snap = KrFixtures.snapshot(name, payload, collectedAt);
        snapshots.put(name, snap);
        KrFixtures.stub(reader, name, snap);
    }

    private static void card(ArrayNode items, String key, String name, double price, double prev, String lastTs,
                             String source) {
        items.addObject().put("key", key).put("name", name).put("status", "ok").put("price", price)
                .put("prevValue", prev).put("pct", (price / prev - 1) * 100).put("lastTs", lastTs).put("isStale", false)
                .put("source", source);
    }

    private static void fxSeries(ObjectNode series, String key, String name, double base) {
        ObjectNode entry = series.putObject(key);
        entry.put("name", name);
        ArrayNode dates = entry.putArray("dates");
        ArrayNode close = entry.putArray("close");
        int i = 0;
        for (LocalDate date : tradingDays(LocalDate.of(2026, 11, 4), 30)) {
            dates.add(date.toString());
            close.add(base + i * 0.5);
            i++;
        }
    }

    /** 사건 저장본 — 기준 세션의 창 (직전 KR 거래일 22:30, 그날 22:30]에 맞춘 시험 제목(지은 문장). */
    private void stubNews(LocalDate session) {
        news.clear();
        LocalDate prev = KrRulesFixtures.CALENDAR.previousTradingDay(session);
        String d = session.toString();
        headline("n-old", "지난주 시장 정리", "yna_market", "연합뉴스", prev.minusDays(3) + "T10:00", prev.minusDays(3) + "T10:05",
                "second");
        headline("n-fresh", "어제 장 마감 정리", "yna_market", "연합뉴스", prev + "T16:00", d + "T22:20", "second");
        headline("n1", "한은, 기준금리 동결 시사", "bok_press", "한국은행", d + "T10:00", d + "T10:05", "second");
        headline("n2", "삼성전자가 장중 신고가", "yna_market", "연합뉴스", d + "T15:40", d + "T15:57", "second");
        headline("n3", "유가증권시장 공모주 청약 마감", "yna_market", "연합뉴스", d + "T16:10", d + "T16:57", "second");
        headline("n4", "세법 개정안 설명자료", "mofe_press", "재정경제부", d + "T13:00", d + "T13:00", "date");
        headline("n5", "환율 급등 마감", "yna_market", "연합뉴스", d + "T22:40", d + "T22:45", "second");     // 결정 순간 뒤
        headline("n6", "외국인 순매수 확대", "yna_market", "연합뉴스", d + "T21:00", d + "T22:35", "second");  // 읽은 순간 뒤에 받음
        headline("n7", "날씨가 맑음", "yna_market", "연합뉴스", d + "T12:00", d + "T12:05", "second");
        when(repository.readObservationsBetween(eq(Datasets.OBS_KR_NEWS_HEADLINE), any(LocalDate.class), isNull()))
                .thenAnswer(invocation -> {
                    List<JsonNode> out = new ArrayList<>();
                    news.forEach(row -> out.add(row.deepCopy()));
                    return out;
                });
    }

    private void headline(String entity, String title, String feed, String source, String knownAtKst, String fetchedKst,
                          String precision) {
        Instant known = kst(knownAtKst);
        ObjectNode row = MAPPER.createObjectNode();
        row.put("entity", entity).put("title", title).put("link", "https://example.test/" + entity).put("source", source)
                .put("feed", feed);
        row.putArray("feeds").add(feed);
        if ("date".equals(precision)) {
            row.putNull("publishedAt");
        } else {
            row.put("publishedAt", known.toString());
        }
        row.put("publishedDate", knownAtKst.substring(0, 10)).put("timePrecision", precision).put("knownAt", known.toString())
                .put("fetchedAt", kst(fetchedKst).toString()).put("obsDate", knownAtKst.substring(0, 10));
        news.add(row);
    }

    /** 운용 중인 한국 Claude 계좌 — 보유 셋(하나는 미처리 기업행위), 재진입 금지 하나, 대기 매도 하나, 앞선 결정 둘, 한국·미국 메모. */
    private void activeClaude() {
        store.dbNow = kst("2026-10-29T22:40");
        store.updateBookStatus(PaperBooks.KR_CLAUDE, PaperBooks.ACTIVE);
        store.updateBookStartedOn(PaperBooks.KR_CLAUDE, S);
        store.states.put(PaperBooks.KR_CLAUDE, new BookState(PaperBooks.KR_CLAUDE, 50_000_000, 100_500_000, 50_500_000,
                50.25, kst("2026-11-03T21:57"), kst("2026-11-03T21:57"), D, kst("2026-11-03T22:10")));
        position("005930", 2_000, 9_900, 10_200, 10_100);
        position("153130", 200, 108_000, 108_020, 108_020);
        position("207940", 100, 10_000, 10_100, 10_050);
        store.holdForCorpAction(PaperBooks.KR_CLAUDE, "207940", "가격제한폭 밖 변동 — 시험");
        store.upsertLockout(new Lockout(PaperBooks.KR_CLAUDE, "000660", LocalDate.of(2026, 11, 20), "트레일링 스탑 −8%"));
        ObjectNode initialResponse = MAPPER.createObjectNode();
        initialResponse.put("schemaVersion", 2).put("summary", "출발 — 반도체 비중").put("stance", "중립");
        initialResponse.putArray("watchlist").addObject().put("ticker", "000660");
        long initialId = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.KR_CLAUDE, S, RuleBookService.INITIAL,
                null, "OK", "claude-test", 1, store.settings.version(), null, 60.0, null, null, null, initialResponse,
                null, null, null, false, null, 0)).orElseThrow();
        store.dbNow = kst("2026-11-02T22:40");
        ObjectNode response = MAPPER.createObjectNode();
        response.put("schemaVersion", 2).put("summary", "수급 유지 — 일부 차익 실현").put("stance", "중립");
        response.putArray("watchlist");
        long scheduledId = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.KR_CLAUDE, D1, RuleBookService.SCHEDULED,
                null, "OK", "claude-test", 1, store.settings.version(), null, 50.0, null, null, null, response, null, null,
                null, false, null, 0)).orElseThrow();
        long filledInitial = store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE, initialId, "005930", PaperBooks.BUY, null,
                20.0, null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, PaperBooks.ORDER_PENDING, null,
                MAPPER.createObjectNode().put("targetWeightPct", 20.0), S, kst("2026-10-29T22:40"),
                LocalDate.of(2026, 11, 3), null));
        store.markOrderFilled(filledInitial, kst("2026-10-30T22:00"));
        ObjectNode reason = MAPPER.createObjectNode().put("targetWeightPct", 0);
        store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE, scheduledId, "005930", PaperBooks.SELL, null, null, 0.5,
                PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, PaperBooks.ORDER_PENDING, null, reason, D1,
                kst("2026-11-02T22:40"), LocalDate.of(2026, 11, 5), null));
        store.dbNow = kst("2026-11-02T09:00");
        store.insertNote(new Note(0, NoteService.MARKET, D1, LocalDate.of(2026, 11, 5), "반도체 수급", "외국인 순매수가 이어지는지 본다",
                false, null, Book.MARKET_KR));
        store.insertNote(new Note(0, NoteService.MARKET, D1, LocalDate.of(2026, 11, 5), "미국 메모", "미국 책 메모 — 한국 패킷에 없어야 함",
                false, null, "US"));
    }

    private void position(String code, int qty, double avg, double watermark, double last) {
        store.upsertPosition(new Position(PaperBooks.KR_CLAUDE, code, qty, avg, LocalDate.of(2026, 10, 30),
                kst("2026-10-30T22:00"), watermark, kst("2026-11-03T22:00"), last, kst("2026-11-03T22:00"), false,
                LocalDate.of(2026, 10, 30), avg, null));
    }

    /**
     * 정기 결정 D의 관측치 — 373220 거래정지(KRX 표시), 000270 항목 없음, 005930에는 기준일 뒤(D+1 = 11-04) 봉도 있음(종가 20,000 — 패킷이 D 이하
     * 봉만 쓰는지 봄: 잠정 종가·수정 비율 이력 점).
     */
    private Optional<PaperMarketData.Quotes> quotesD() {
        return quotesD(true);
    }

    /** {@link #quotesD()} — {@code afterSession}이 거짓이면 005930의 D+1 봉 없이(대조용). */
    private Optional<PaperMarketData.Quotes> quotesD(boolean afterSession) {
        Snapshot snapshot = KrRulesFixtures.quotes(D);
        KrRulesFixtures.suspend(snapshot, "373220", true);
        ((ObjectNode) snapshot.payload().path("codes")).remove("000270");
        if (afterSession) {
            ArrayNode bars = (ArrayNode) snapshot.payload().path("codes").path("005930").path("bars");
            ObjectNode after = (ObjectNode) bars.get(bars.size() - 1).deepCopy();
            after.put("date", D_PLUS_1.toString()).put("open", 19_000).put("high", 20_500).put("low", 18_900)
                    .put("close", 20_000).put("adjClose", 20_000).put("volume", 150_000);
            bars.add(after);
        }
        return KrPaperMarket.INSTANCE.parse(snapshot);
    }

    /** 정기 결정 D 다음 거래일(관측치의 '기준일 뒤' 봉 날짜). */
    static final LocalDate D_PLUS_1 = LocalDate.of(2026, 11, 4);

    private Packet scheduled() {
        clock.set(READ_D);
        activeClaude();
        return builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, quotesD(), READ_D);
    }

    private Packet initial() {
        clock.set(READ_S);
        stubSnapshots(S);
        stubNews(S);
        when(regimeLog.recent(anyInt())).thenReturn(List.of(regime(S), regime(LocalDate.of(2026, 10, 28))));
        return builder.build(run(), S, RuleBookService.INITIAL, true, 3,
                KrPaperMarket.INSTANCE.parse(KrRulesFixtures.quotes(S)), READ_S);
    }

    // ------------------------------------------------------------------ 시험
    @Test
    @DisplayName("섹션 — 한국 번호 체계(3_kr_macro, 미국의 2·3_fred·4·5·6·6b·7 없음), 판 6·KR·KRW·kr_claude")
    void sectionsAndBasis() {
        JsonNode body = scheduled().body();
        List<String> keys = new ArrayList<>();
        body.propertyNames().forEach(keys::add);
        assertThat(keys).containsExactlyElementsOf(KrPacketBuilder.SECTION_KEYS);
        assertThat(keys).doesNotContain("2_macroCards", "3_fred", "4_regime", "5_gate", "6_trackRecord",
                "6b_institutionProfiles", "7_13fChanges");
        JsonNode basis = body.path("1_basis");
        assertThat(basis.path("packetVersion").asInt()).isEqualTo(6);
        assertThat(basis.path("market").asString()).isEqualTo("KR");
        assertThat(basis.path("currency").asString()).isEqualTo("KRW");
        assertThat(basis.path("book").asString()).isEqualTo("kr_claude");
        assertThat(basis.path("nextSession").asString()).isEqualTo("2026-11-04");
        assertThat(basis.path("pricesFinal").asBoolean()).isFalse();
        assertThat(basis.path("universeAsOf").asString()).isEqualTo("2026-11-02");
        assertThat(basis.path("settingsVersion").asInt()).isEqualTo(store.settings.version());
    }

    @Test
    @DisplayName("국면은 전날 판정(K39) — 기준일 그날 판정이 있어도 D 앞 날짜의 가장 최근 판정과 verdictDate·'전날 판정'")
    void regimeIsThePreviousNightsVerdict() {
        JsonNode regime = scheduled().body().path("1_basis").path("regime");
        assertThat(regime.path("verdictDate").asString()).isEqualTo("2026-11-02");
        assertThat(regime.path("relation").asString()).isEqualTo("전날 판정");
        assertThat(regime.path("note").asString()).contains("전날 밤");
    }

    @Test
    @DisplayName("국면(K39) — 전날 판정이 빠진 밤(서버가 23시 기록 전에 꺼짐 등)은 D 앞 날짜의 가장 최근 판정에 'n일 전 판정'(3일 전 10-31), D 판정만 있으면 available false와 사유")
    void regimeOlderVerdictAndNoEarlierVerdict() {
        when(regimeLog.recent(anyInt())).thenReturn(List.of(regime(D), regime(LocalDate.of(2026, 10, 31))));
        JsonNode older = scheduled().body().path("1_basis").path("regime");
        assertThat(older.path("available").asBoolean()).isTrue();
        assertThat(older.path("verdictDate").asString()).isEqualTo("2026-10-31");
        assertThat(older.path("relation").asString()).isEqualTo("3일 전 판정");

        when(regimeLog.recent(anyInt())).thenReturn(List.of(regime(D)));
        clock.set(READ_D);
        JsonNode none = builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, quotesD(), READ_D).body()
                .path("1_basis").path("regime");
        assertThat(none.path("available").asBoolean()).isFalse();
        assertThat(none.path("note").asString()).isEqualTo("기준 거래일 앞 날짜의 국면 판정 기록이 없습니다");
        assertThat(none.has("verdictDate")).isFalse();
    }

    @Test
    @DisplayName("1_basis 시장 — 코스피·야간선물·원/달러·엔/원 카드(asOfMismatch false), 코스닥 지수 null + 금융위 합계(isProxy), 선물 일봉·투자주체는 기준일 이하")
    void basisMarkets() {
        JsonNode basis = scheduled().body().path("1_basis");
        JsonNode cards = basis.path("markets").path("cards");
        assertThat(cards).extracting(c -> c.path("key").asString())
                .containsExactly("kospi", "kospi200_night_scraped", "usdkrw", "jpykrw");
        cards.forEach(c -> assertThat(c.path("asOfMismatch").asBoolean()).as(c.path("key").asString()).isFalse());
        assertThat(basis.path("markets").path("kosdaq").path("index").isNull()).isTrue();
        JsonNode totals = basis.path("markets").path("totals");
        assertThat(totals.path("isProxy").asBoolean()).isTrue();
        assertThat(totals.path("rows").get(0).path("date").asString()).isEqualTo("2026-11-03");
        assertThat(basis.path("futures").path("daily").path("date").asString()).isEqualTo("2026-11-03");
        assertThat(basis.path("futures").path("investors").path("dataDate").asString()).isEqualTo("2026-11-03");
        assertThat(basis.path("futures").path("investors").path("columns")).hasSize(4);
    }

    @Test
    @DisplayName("1b 한국 일정 — 창(11-04~11-17) 안 발표만, 일정 미확인 발표는 따로, 금통위 상수 ok, 실적·컨센서스 null + 사유")
    void calendar() {
        JsonNode section = scheduled().body().path("1b_calendar");
        assertThat(section.path("window").path("from").asString()).isEqualTo("2026-11-04");
        assertThat(section.path("window").path("to").asString()).isEqualTo("2026-11-17");
        assertThat(section.path("macro").path("rows")).hasSize(1);
        assertThat(section.path("macro").path("rows").get(0).get(2).asString()).isEqualTo("고용동향(시험)");
        assertThat(section.path("unconfirmed")).extracting(r -> r.path("key").asString()).containsExactly("CPI");
        assertThat(section.path("bok").path("status").asString()).isEqualTo("ok");
        assertThat(section.path("earnings").isNull()).isTrue();
        assertThat(section.path("earningsNote").asString()).isEqualTo("한국 실적 발표 일정 출처 없음");
        assertThat(section.path("consensus").isNull()).isTrue();
        assertThat(section.path("consensusNote").asString()).isEqualTo("한국 컨센서스 출처 없음");
    }

    @Test
    @DisplayName("8_prices — 보유 → ETF → U(점수 순), 잠정 종가·출처, 수급은 기준일까지(11-04·05 기록 빠짐), 체결할 수 없는 사유")
    void prices() {
        JsonNode section = scheduled().body().path("8_prices");
        List<String> columns = new ArrayList<>();
        section.path("columns").forEach(c -> columns.add(c.asString()));
        assertThat(columns).isEqualTo(KrPacketBuilder.PRICE_COLUMNS);
        List<String> codes = new ArrayList<>();
        Map<String, JsonNode> rows = new LinkedHashMap<>();
        section.path("rows").forEach(r -> {
            codes.add(r.get(0).asString());
            rows.put(r.get(0).asString(), r);
        });
        // 보유(코드 순) → ETF → U 점수 순: 000660 0.2 · (005930 0.1·207940 0.0562 보유) · 005380·068270·105560 0.05(같으면 U 순위) ·
        // 373220 −0.128 · 000270 null(창이 덜 참).
        assertThat(codes).containsExactly("005930", "153130", "207940", "069500", "000660", "005380", "068270", "105560",
                "373220", "000270");
        int close = columns.indexOf("close");
        int source = columns.indexOf("priceSource");
        int unfillable = columns.indexOf("unfillable");
        int foreign20 = columns.indexOf("foreign20");
        int score = columns.indexOf("flowScore");
        assertThat(rows.get("005930").get(close).asLong()).as("관측치 D 이하 마지막 봉 — D+1 봉(20,000)은 쓰지 않음")
                .isEqualTo(10_100);
        assertThat(rows.get("005930").get(columns.indexOf("date")).asString()).isEqualTo(D.toString());
        assertThat(rows.get("005930").get(source).asString()).isEqualTo("TOSS_INTEGRATED");
        clock.set(READ_D);
        JsonNode without = builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, quotesD(false), READ_D).body()
                .path("8_prices");
        JsonNode same = null;
        for (JsonNode r : without.path("rows")) {
            if ("005930".equals(r.get(0).asString())) {
                same = r;
            }
        }
        assertThat(rows.get("005930")).as("005930 줄 전체(날짜·잠정 종가·수익률·200일 평균·52주 고점 대비)가 D+1 봉이 없을 때와 같음")
                .isEqualTo(same);
        assertThat(rows.get("069500").get(source).asString()).isEqualTo("TOSS_DAILY");
        // 20일 창(10-06~11-03) 합 — 11-04·11-05 기록(기준일 뒤)은 빠짐: 005930 하루 100,000주 × 20 = 2,000,000.
        assertThat(rows.get("005930").get(foreign20).asLong()).isEqualTo(2_000_000);
        assertThat(rows.get("000660").get(score).asDouble()).isEqualTo(0.2);
        assertThat(rows.get("373220").get(unfillable).asString()).contains("거래정지");
        assertThat(rows.get("000270").get(unfillable).asString()).isEqualTo("이번 관측치에 그 종목 봉이 없음");
        assertThat(rows.get("207940").get(unfillable).asString()).contains("미처리 기업행위 보유");
        assertThat(rows.get("005930").get(unfillable).isNull()).isTrue();
        assertThat(section.has("omitted")).isFalse();
        assertThat(section.path("flowsExcluded").path("afterSession").asInt()).isPositive();
    }

    @Test
    @DisplayName("QA-146: 가격 설명 — 토스 잠정 종가에는 20:00까지의 장 마감 뒤 체결이 섞일 수 있다고 적고(NXT 미지원 표시 주식도 일봉 종가 = 20:00 봉), "
            + "TOSS_DAILY 설명은 시가와 종가를 나눔 — 정기·출발 패킷의 8_prices·1_basis·0_instructions")
    void priceNotesDoNotCallTheTossCloseAKrxClose() {
        Packet scheduled = scheduled();
        setUp();
        Packet initial = initial();
        for (Packet packet : List.of(scheduled, initial)) {
            JsonNode body = packet.body();
            String closeSentence = sentenceWith(body.path("8_prices").path("note").asString(), "close =");
            String daily = clauseOf(closeSentence, KrQuotes.SOURCE_DAILY);
            assertThat(daily).as("8_prices의 TOSS_DAILY 설명이 시가와 종가를 나눔").contains("시가").contains("종가");
            assertThat(daily).as("8_prices의 TOSS_DAILY 종가에 20:00까지의 체결이 섞일 수 있음").contains("20:00");
            String instruction = null;
            for (JsonNode line : body.path("0_instructions").path("lines")) {
                if (line.asString().contains("8_prices·9_portfolio")) {
                    instruction = line.asString();
                }
            }
            assertThat(instruction).as("0_instructions의 가격 줄").isNotNull();
            for (String text : List.of(body.path("1_basis").path("pricesNote").asString(), instruction)) {
                assertThat(text).as("토스 잠정 종가에 20:00까지의 장 마감 뒤 체결이 섞일 수 있음").contains("20:00");
                assertThat(text).as("토스 종가를 KRX 종가 단일가라고 하지 않음").doesNotContainPattern("KRX[^()]*종가 단일가");
            }
        }
    }

    /** {@code text}를 '. '로 나눈 문장 중 {@code marker}가 든 첫 문장. */
    private static String sentenceWith(String text, String marker) {
        for (String sentence : text.split("\\. ")) {
            if (sentence.contains(marker)) {
                return sentence;
            }
        }
        throw new AssertionError("'" + marker + "' 문장이 없음: " + text);
    }

    /** {@code text}에서 {@code source}부터 다음 출처 이름(TOSS_INTEGRATED·TOSS_DAILY) 앞까지 — 그 출처 하나의 설명. */
    private static String clauseOf(String text, String source) {
        int start = text.indexOf(source);
        assertThat(start).as(source + " 설명이 있음: " + text).isNotNegative();
        int end = text.length();
        for (String other : List.of(KrQuotes.SOURCE_INTEGRATED, KrQuotes.SOURCE_DAILY)) {
            int at = text.indexOf(other, start + source.length());
            if (at >= 0 && at < end) {
                end = at;
            }
        }
        return text.substring(start, end);
    }

    @Test
    @DisplayName("8b DART — 접수일 ≤ 기준일만(11-04 접수는 값 없이 사유), 접수번호 모름·DART 없음 사유, ETF 제외, 금융업 코드 표")
    void fundamentals() {
        JsonNode section = scheduled().body().path("8b_fundamentals");
        Map<String, JsonNode> rows = new LinkedHashMap<>();
        section.path("rows").forEach(r -> rows.put(r.get(0).asString(), r));
        int status = KrPacketBuilder.FUNDAMENTAL_COLUMNS.indexOf("status");
        int roe = KrPacketBuilder.FUNDAMENTAL_COLUMNS.indexOf("roePct");
        int financial = KrPacketBuilder.FUNDAMENTAL_COLUMNS.indexOf("financialSector");
        assertThat(rows.keySet()).doesNotContain("069500", "153130");
        assertThat(section.path("excluded")).extracting(JsonNode::asString).containsExactly("153130", "069500");
        assertThat(rows.get("005380").get(status).asString()).isEqualTo("접수일이 기준일 뒤");
        assertThat(rows.get("005380").get(roe).isNull()).isTrue();
        assertThat(rows.get("068270").get(status).asString()).isEqualTo("접수일 모름");
        assertThat(rows.get("207940").get(status).asString()).isEqualTo("DART 없음");
        assertThat(rows.get("005930").get(roe).asDouble()).isEqualTo(10.0);
        assertThat(rows.get("005930").get(status).isNull()).isTrue();
        assertThat(rows.get("105560").get(financial).asBoolean()).isTrue();
    }

    @Test
    @DisplayName("9_portfolio·10 — 원 단위 장부, 미처리 기업행위 표시, 재진입 금지, 대기 매도, 이달 재량 주문(11월 — 10월 출발 주문은 셈 밖), 최근 결정")
    void portfolioAndDecisions() {
        JsonNode body = scheduled().body();
        JsonNode portfolio = body.path("9_portfolio");
        assertThat(portfolio.path("currency").asString()).isEqualTo("KRW");
        assertThat(portfolio.path("nav").asLong()).isEqualTo(100_500_000);
        JsonNode hold = portfolio.path("positions").get(2);
        assertThat(hold.path("ticker").asString()).isEqualTo("207940");
        assertThat(hold.path("corpActionHold").asString()).contains("시험");
        assertThat(portfolio.path("positions").get(1).path("cashLike").asBoolean()).isTrue();
        assertThat(portfolio.path("lockouts").get(0).path("ticker").asString()).isEqualTo("000660");
        assertThat(portfolio.path("monthlyDiscretionaryOrders").path("used").asInt()).isZero();
        assertThat(portfolio.path("pendingOrders").path("rows")).hasSize(1);
        assertThat(body.path("12_hardRules").path("lockedOut")).extracting(JsonNode::asString).containsExactly("000660");
        assertThat(body.path("10_recentDecisions").path("decisions")).extracting(d -> d.path("kind").asString())
                .containsExactly("SCHEDULED", "INITIAL");
    }

    @Test
    @DisplayName("이달 재량 주문 — 출발 결정(INITIAL)의 체결 주문은 세지 않고 정기 결정의 체결 주문만(미국 BACKFILL 제외와 같은 원칙)")
    void monthlyCountLeavesOutTheStartAllocation() {
        store.dbNow = kst("2026-11-02T22:40");
        long initialId = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.KR_CLAUDE, LocalDate.of(2026, 11, 2),
                RuleBookService.INITIAL, null, "OK", null, null, 1, null, null, null, null, null,
                MAPPER.createObjectNode(), null, null, null, false, null, 0)).orElseThrow();
        long scheduledId = store.insertDecisionIfAbsent(new Decision(0, PaperBooks.KR_CLAUDE, LocalDate.of(2026, 11, 3),
                RuleBookService.SCHEDULED, null, "OK", null, null, 1, null, null, null, null, null,
                MAPPER.createObjectNode(), null, null, null, false, null, 0)).orElseThrow();
        for (long decision : List.of(initialId, initialId, scheduledId)) {
            long id = store.insertOrder(new Order(0, PaperBooks.KR_CLAUDE, decision, "005930", PaperBooks.BUY, null, 5.0,
                    null, PaperBooks.NEXT_OPEN, PacketBuilder.SOURCE_CLAUDE, PaperBooks.ORDER_PENDING, null, null,
                    decision == initialId ? LocalDate.of(2026, 11, 2) : LocalDate.of(2026, 11, 3), null,
                    LocalDate.of(2026, 11, 6), null));
            store.markOrderFilled(id, kst("2026-11-04T22:00"));
        }
        assertThat(KrPacketBuilder.monthlyDiscretionaryOrders(store, LocalDate.of(2026, 11, 4))).isEqualTo(1);
    }

    @Test
    @DisplayName("11_notes — 한국 메모만(미국 메모 없음), 글자 상한은 두 책 공통 키 notesMaxCharsInPacket(사용자 결정 v6)")
    void notes() {
        JsonNode section = scheduled().body().path("11_notes");
        assertThat(section.path("market").asString()).isEqualTo("KR");
        assertThat(section.path("notes")).extracting(n -> n.path("title").asString()).containsExactly("반도체 수급");
        assertThat(section.path("text").asString()).doesNotContain("미국 책 메모");
        ((ObjectNode) store.settings.body()).put("notesMaxCharsInPacket", 0);
        clock.set(READ_D);
        JsonNode capped = builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, quotesD(), READ_D).body()
                .path("11_notes");
        assertThat(capped.path("maxChars").asInt()).isZero();
        assertThat(capped.path("omitted").asInt()).isEqualTo(1);
    }

    @Test
    @DisplayName("11b 한국 사건 — 피드 넷(연합뉴스 포함, G12 사용자 결정), 창 안·읽은 순간까지 받은 것만, '유가증권' 가림, 실패 중인 피드 메모")
    void events() {
        Packet packet = scheduled();
        JsonNode section = packet.body().path("11b_events");
        assertThat(section.path("window").path("from").asString()).isEqualTo("2026-11-02T22:30:00+09:00");
        assertThat(section.path("window").path("to").asString()).isEqualTo("2026-11-03T22:30:00+09:00");
        assertThat(section.path("items")).extracting(i -> i.path("entity").asString()).containsExactly("n2", "n4", "n1");
        assertThat(section.path("text").asString()).contains("[재정경제부 · 2026-11-03(날짜만)] 세법 개정안 설명자료")
                .doesNotContain("유가증권").doesNotContain("환율 급등").doesNotContain("외국인 순매수 확대");
        assertThat(section.path("items").get(0).path("matched")).extracting(JsonNode::asString)
                .containsExactly("name 삼성전자 (005930)");
        assertThat(section.path("feedNote").asString()).contains("mods_press");
        assertThat(packet.measure().hasEvents()).isEqualTo(3);
        assertThat(packet.measure().eventIds()).containsExactly("n2", "n4", "n1");
        assertThat(packet.measure().hasCalendar()).isTrue();
        assertThat(packet.measure().hasEarnings()).isNull();
    }

    @Test
    @DisplayName("11b 끔 — kr.news.enabled=false면 저장본을 읽지 않고 꺼짐만")
    void eventsDisabled() {
        ((ObjectNode) store.settings.body().path("kr").path("news")).put("enabled", false);
        JsonNode section = scheduled().body().path("11b_events");
        assertThat(section.path("text").asString()).isEqualTo("꺼짐(설정) — kr.news.enabled=false라 싣지 않음(수집은 계속)");
        verify(repository, never()).readObservationsBetween(eq(Datasets.OBS_KR_NEWS_HEADLINE), any(), any());
    }

    @Test
    @DisplayName("11b 읽는 범위(묶음 E 2차 리뷰) — 저장본은 발행 KST 날짜(obs_date)가 창 시작 하루 앞(11-01) 이후인 행만: 11-01 발행·창 안에서 처음 받은 제목은 알게 된 시각대로 싣고, 10-31 발행은 처음 받은 시각이 창 안이어도 싣지 않음(수집 회복·첫 수집의 묵은 항목)")
    void eventsReadOnlyFromTheDayBeforeTheWindow() {
        headline("n-recovered", "한은 총재 주말 간담회", "bok_press", "한국은행", "2026-11-01T10:00", D + "T22:20", "second");
        headline("n-stale", "한은 지난주 보도자료", "bok_press", "한국은행", "2026-10-31T10:00", D + "T22:20", "second");
        // 저장소와 같은 범위(obs_date >= from — StoreRepository.readObservationsBetween).
        when(repository.readObservationsBetween(eq(Datasets.OBS_KR_NEWS_HEADLINE), any(LocalDate.class), isNull()))
                .thenAnswer(invocation -> {
                    LocalDate from = invocation.getArgument(1);
                    List<JsonNode> out = new ArrayList<>();
                    news.stream().filter(row -> !LocalDate.parse(row.path("obsDate").asString()).isBefore(from))
                            .forEach(row -> out.add(row.deepCopy()));
                    return out;
                });

        JsonNode section = scheduled().body().path("11b_events");

        verify(repository).readObservationsBetween(Datasets.OBS_KR_NEWS_HEADLINE, LocalDate.of(2026, 11, 1), null);
        assertThat(section.path("items")).extracting(i -> i.path("entity").asString()).contains("n-recovered", "n1")
                .doesNotContain("n-stale");
        assertThat(section.path("text").asString()).contains("한은 총재 주말 간담회").doesNotContain("한은 지난주 보도자료");
    }

    @Test
    @DisplayName("12 한국 하드 규칙 — NEXT_OPEN뿐·최소 500,000원·정수 주·호가표·비용·체결할 수 없는 종목, 미국 문구($·SHY·NEXT_OBSERVATION·13F) 없음")
    void hardRules() {
        Packet packet = scheduled();
        JsonNode rules = packet.body().path("12_hardRules");
        assertThat(rules.path("timings")).extracting(JsonNode::asString).containsExactly("NEXT_OPEN");
        assertThat(rules.path("minOrderNotional").asLong()).isEqualTo(500_000);
        assertThat(rules.path("cashLikeTickers")).extracting(JsonNode::asString).containsExactly("153130");
        assertThat(rules.path("etfTickers")).extracting(JsonNode::asString).containsExactly("069500", "153130");
        assertThat(rules.path("unfillableTickers").path("373220").asString()).contains("거래정지");
        String lines = rules.path("lines").toString();
        assertThat(lines).contains("BUY_BELOW_ONE_SHARE").contains("500,000원").contains("주식 2,000원 미만 1원")
                .contains("코스피 거래세 5bp + 농특세 15bp").contains("매수는 UNFILLABLE로 거절").contains("매도는 받아 대기로 두고")
                .as("체결할 수 없는 보유의 매도는 같은 시가 매수의 자리를 만들지 못함(검증기와 같음 — 묶음 E 리뷰)")
                .contains("단 unfillableTickers 종목의 매도는 그 시가에 체결되지 않으므로 현금(OVER_ALLOCATED)·종목 자리"
                        + "(MAX_POSITIONS)를 만들지 못한다");
        assertThat(packet.text()).doesNotContain("$").doesNotContain("SHY").doesNotContain("NEXT_OBSERVATION")
                .doesNotContain("13F").doesNotContain("5_gate").doesNotContain("6_trackRecord");
        assertThat(rules.path("universe").asString()).isEqualTo(
                "000270,000660,005380,005930,068270,069500,105560,153130,207940,373220");
    }

    @Test
    @DisplayName("한국 검증기 칸(E2a)은 이 패킷이 보인 하드 규칙 그대로 — 유니버스·ETF·재진입 금지·체결할 수 없는 종목(사유까지)·이달 재량 주문 수, 정수 주 기준 가격 = 8_prices 잠정 종가")
    void validatorChecksAreThePacketHardRules() {
        Packet packet = scheduled();
        JsonNode rules = packet.body().path("12_hardRules");
        MarketRun run = run();
        ClaudeDecisionPipeline.MarketChecks checks = KrClaudeValidation.checks(run, store, D, false, packet.body(),
                run.settings(), quotesD(), Set.of(), READ_D);

        assertThat(String.join(",", checks.universe())).isEqualTo(rules.path("universe").asString());
        assertThat(checks.etfs()).containsExactlyElementsOf(
                rules.path("etfTickers").valueStream().map(JsonNode::asString).toList());
        assertThat(checks.lockedOut()).containsExactlyElementsOf(
                rules.path("lockedOut").valueStream().map(JsonNode::asString).toList()).contains("000660");
        Map<String, String> shown = new LinkedHashMap<>();
        rules.path("unfillableTickers").properties().forEach(e -> shown.put(e.getKey(), e.getValue().asString()));
        assertThat(checks.unfillable()).isEqualTo(shown).containsOnlyKeys("000270", "207940", "373220");
        assertThat(checks.monthly()).isEqualTo(packet.body().path("9_portfolio").path("monthlyDiscretionaryOrders")
                .path("used").asInt());

        List<String> columns = new ArrayList<>();
        packet.body().path("8_prices").path("columns").forEach(c -> columns.add(c.asString()));
        int close = columns.indexOf("close");
        int source = columns.indexOf("priceSource");
        int compared = 0;
        for (JsonNode row : packet.body().path("8_prices").path("rows")) {
            String code = row.get(0).asString();
            if (row.get(source).asString("").startsWith("TOSS_")) {
                assertThat(checks.wholeShares().prices().get(code)).as(code)
                        .isEqualByComparingTo(row.get(close).decimalValue());
                compared++;
            } else {
                assertThat(checks.wholeShares().prices()).as(code + " — 관측치에 없는 종목은 기준 가격 없음")
                        .doesNotContainKey(code);
            }
        }
        assertThat(compared).isPositive();
    }

    @Test
    @DisplayName("한국판 initialPacketHasNothingAfterAsOf — 출발 패킷의 모든 날짜·시각이 기준일·읽은 순간 이하(일정·규칙이 정한 미래 날짜 빼고)")
    void initialPacketHasNothingAfterTheReadInstant() {
        Packet packet = initial();
        assertNothingAfter(packet.body(), S, READ_S);
        JsonNode basis = packet.body().path("1_basis");
        assertThat(basis.path("initial").asBoolean()).isTrue();
        assertThat(basis.path("regime").path("verdictDate").asString()).isEqualTo("2026-10-28");
        basis.path("markets").path("cards").forEach(c -> assertThat(c.path("asOfMismatch").asBoolean()).isFalse());
        assertThat(packet.body().path("9_portfolio").path("note").asString()).startsWith("출발 결정");
        assertThat(packet.body().path("9_portfolio").path("positions")).isEmpty();
        assertThat(packet.body().path("10_recentDecisions").path("decisions")).isEmpty();
        assertThat(packet.body().path("0_instructions").path("lines").toString()).contains("이번은 출발 결정이다(기준일 2026-10-29)");
    }

    @Test
    @DisplayName("정기 패킷도 같은 시점 규칙 — 기준일·읽은 순간 뒤 값 없음")
    void scheduledPacketHasNothingAfterTheReadInstant() {
        assertNothingAfter(scheduled().body(), D, READ_D);
    }

    @Test
    @DisplayName("읽은 순간 뒤에 수집된 저장본은 없는 것 — 카드·환율·DART·관측치·선물 일봉·선물 투자주체·시장 매매대금·사건 피드 상태는 사유와 함께 빠짐")
    void snapshotsCollectedAfterTheReadInstantAreLeftOut() {
        Snapshot late = snapshots.get(Datasets.SNAP_MACRO_COLLECTED);
        KrFixtures.stub(reader, Datasets.SNAP_MACRO_COLLECTED,
                KrFixtures.snapshot(Datasets.SNAP_MACRO_COLLECTED, late.payload(), kst("2026-11-03T22:35")));
        KrFixtures.stub(reader, Datasets.SNAP_FX_HISTORY, KrFixtures.snapshot(Datasets.SNAP_FX_HISTORY,
                snapshots.get(Datasets.SNAP_FX_HISTORY).payload(), kst("2026-11-03T22:40")));
        KrFixtures.stub(reader, Datasets.SNAP_DART_FUNDAMENTALS,
                KrFixtures.snapshot(Datasets.SNAP_DART_FUNDAMENTALS, data.dart, kst("2026-11-03T22:45")));
        for (String name : List.of(Datasets.SNAP_KRX_FUTURES, Datasets.daumFuturesTrend(Datasets.DAUM_TREND_LOOKBACK),
                Datasets.SNAP_TOSS_MARKET_FLOWS)) {
            KrFixtures.stub(reader, name, KrFixtures.snapshot(name, snapshots.get(name).payload(), kst("2026-11-03T22:36")));
        }
        Snapshot status = reader.readStored(Datasets.SNAP_KR_NEWS_STATUS).orElseThrow();
        when(reader.readStored(eq(Datasets.SNAP_KR_NEWS_STATUS))).thenReturn(Optional.of(
                KrFixtures.snapshot(Datasets.SNAP_KR_NEWS_STATUS, status.payload(), kst("2026-11-03T22:36"))));
        clock.set(READ_D);
        activeClaude();
        Snapshot quotes = KrRulesFixtures.recollected(KrRulesFixtures.quotes(D), kst("2026-11-03T22:33"));
        JsonNode body = builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, KrPaperMarket.INSTANCE.parse(quotes),
                READ_D).body();
        assertThat(body.path("1_basis").path("markets").path("missing").asString()).startsWith(KrPacketBuilder.LATE_SNAPSHOT);
        assertThat(body.path("3_kr_macro").path("fx").path("missing").asString()).startsWith(KrPacketBuilder.LATE_SNAPSHOT);
        assertThat(body.path("8b_fundamentals").path("missing").asString()).startsWith(KrPacketBuilder.LATE_SNAPSHOT);
        assertThat(body.path("8b_fundamentals").has("rows")).isFalse();
        assertThat(body.path("1_basis").path("notes").toString()).contains("paper.kr.quotes");
        assertThat(body.path("1_basis").path("quotesSession").isNull()).isTrue();
        JsonNode futures = body.path("1_basis").path("futures");
        assertThat(futures.path("daily").path("missing").asString()).startsWith(KrPacketBuilder.LATE_SNAPSHOT);
        assertThat(futures.path("daily").has("date")).isFalse();
        assertThat(futures.path("investors").path("missing").asString()).startsWith(KrPacketBuilder.LATE_SNAPSHOT);
        assertThat(futures.path("investors").has("rows")).isFalse();
        JsonNode flows = body.path("3_kr_macro").path("investorFlows");
        assertThat(flows.path("missing").asString()).startsWith(KrPacketBuilder.LATE_SNAPSHOT);
        assertThat(flows.has("rows")).isFalse();
        assertThat(body.path("11b_events").has("feedNote")).as("읽은 순간 뒤의 피드 상태는 쓰지 않음(실패 중 mods_press도 적지 않음)")
                .isFalse();
        // 관측치 없이도 가격은 수정 종가 이력의 마지막 값(출처 kr_close_adj)으로.
        JsonNode first = body.path("8_prices").path("rows").get(0);
        assertThat(first.get(KrPacketBuilder.PRICE_COLUMNS.indexOf("priceSource")).asString()).isEqualTo("kr_close_adj");
        assertThat(first.get(KrPacketBuilder.PRICE_COLUMNS.indexOf("date")).asString()).isEqualTo("2026-11-03");
    }

    @Test
    @DisplayName("결정적 — 같은 저장 상태·같은 읽은 순간이면 같은 글자·해시")
    void deterministic() {
        Packet first = scheduled();
        clock.set(READ_D);
        Packet second = builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, quotesD(), READ_D);
        assertThat(second.text()).isEqualTo(first.text());
        assertThat(second.sha256()).isEqualTo(first.sha256());
    }

    @Test
    @DisplayName("판 6은 늘 — 두 책 공통 스위치 calendar.consensus를 켜도 꺼도 한국 패킷은 같은 글자, 1b 컨센서스는 null + '한국 컨센서스 출처 없음'(K20·K22, E1b)")
    void krPacketIsVersion6RegardlessOfTheConsensusSwitch() {
        ObjectNode body = (ObjectNode) store.settings.body();
        body.putObject("calendar").put("consensus", false);
        Packet off = scheduled();
        body.putObject("calendar").put("consensus", true);
        clock.set(READ_D);
        Packet on = builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, quotesD(), READ_D);

        assertThat(on.text()).isEqualTo(off.text());
        assertThat(on.sha256()).isEqualTo(off.sha256());
        assertThat(on.body().path("1_basis").path("packetVersion").asInt()).isEqualTo(KrPacketBuilder.PACKET_VERSION)
                .isEqualTo(PacketBuilder.PACKET_VERSION_CONSENSUS).isEqualTo(6);
        JsonNode calendar = on.body().path("1b_calendar");
        assertThat(calendar.has("consensus")).isTrue();
        assertThat(calendar.path("consensus").isNull()).isTrue();
        assertThat(calendar.path("consensusNote").asString()).isEqualTo(KrCalendarSection.NO_CONSENSUS);
        // 미국 컨센서스 저장본(Nasdaq — 한국 0행)은 한국 패킷이 읽지 않습니다.
        verify(reader, never()).read(eq(Datasets.SNAP_US_CONSENSUS), org.mockito.ArgumentMatchers.anyLong(), any());
        verify(reader, never()).readStored(Datasets.SNAP_US_CONSENSUS);
    }

    @Test
    @DisplayName("크기 예산 — 넘으면 U 줄을 점수 낮은 쪽부터 8_prices·8b에서 함께 자르고(가장 적게) 잘린 수를 적음, 보유·ETF는 남음")
    void trimsUniverseRowsToTheTokenBudget() {
        Packet full = scheduled();
        int fullTokens = PacketBuilder.estimateTokens(full.text());
        int target = fullTokens - 150;
        builder = builder(target);
        clock.set(READ_D);
        Packet trimmed = builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, quotesD(), READ_D);
        assertThat(PacketBuilder.estimateTokens(trimmed.text())).isLessThanOrEqualTo(target);
        JsonNode prices = trimmed.body().path("8_prices");
        int cut = prices.path("omitted").asInt();
        assertThat(cut).isPositive();
        assertThat(prices.path("rows")).hasSize(10 - cut);
        assertThat(trimmed.body().path("8b_fundamentals").path("omitted").asInt()).isEqualTo(cut);
        List<String> codes = new ArrayList<>();
        prices.path("rows").forEach(r -> codes.add(r.get(0).asString()));
        assertThat(codes).startsWith("005930", "153130", "207940", "069500", "000660");
        assertThat(cut).isLessThan(6);
        // 점수 낮은 쪽부터 — 남은 U 줄은 점수 순의 앞부분 그대로.
        assertThat(codes.subList(4, codes.size())).isEqualTo(List.of("000660", "005380", "068270", "105560", "373220",
                "000270").subList(0, 6 - cut));
        // 가장 적게 자른 수 — 하나 덜 자르면 예산을 넘음.
        builder = builder(PacketBuilder.estimateTokens(trimmed.text()));
        clock.set(READ_D);
        Packet tight = builder.build(run(), D, RuleBookService.SCHEDULED, false, 3, quotesD(), READ_D);
        assertThat(tight.body().path("8_prices").path("omitted").asInt()).isEqualTo(cut);
        assertThat(trimmed.body().path("12_hardRules").path("universeSize").asInt()).isEqualTo(10);
    }

    @Test
    @DisplayName("한국 실행만 — 미국 실행·모르는 종류는 거절")
    void rejectsNonKoreanRuns() {
        MarketRun us = MarketRun.of(UsPaperMarket.INSTANCE, store);
        assertThatThrownBy(() -> builder.build(us, D, RuleBookService.SCHEDULED, false, 3, Optional.empty(), READ_D))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("한국 실행이 아닙니다");
        assertThatThrownBy(() -> builder.build(run(), D, "BOGUS", false, 3, Optional.empty(), READ_D))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("고정본 — 한국 정기·출발 패킷 글자와 해시·크기(packet-kr-*.json)")
    void goldenKrPackets() {
        Packet scheduled = scheduled();
        String scheduledMeta = meta("scheduled", scheduled);
        setUp();
        Packet initial = initial();
        Golden.assertMatches("packet-kr-scheduled.json", scheduled.text());
        Golden.assertMatches("packet-kr-initial.json", initial.text());
        Golden.assertMatches("packet-kr-meta.txt", String.join("\n", meta("initial", initial), scheduledMeta));
        assertThat(PacketBuilder.estimateTokens(scheduled.text())).isLessThan(KrPacketBuilder.TARGET_TOKENS);
    }

    private static String meta(String name, Packet packet) {
        return name + " sha256=" + packet.sha256() + " chars=" + packet.text().length() + " tokens="
                + PacketBuilder.estimateTokens(packet.text()) + " noteIds=" + packet.noteIds() + " measure="
                + MAPPER.valueToTree(packet.measure().toMap());
    }

    /**
     * 패킷의 모든 날짜가 기준일 이하이고(일정 1b·달력·규칙이 정한 미래 날짜 키 빼고) 모든 시각(ISO·"… KST")이 읽은 순간 이하인지.
     */
    private static void assertNothingAfter(JsonNode body, LocalDate asOf, Instant readAt) {
        assertThat(problemsAfter(body, asOf, readAt)).as("기준일·읽은 순간 뒤 값").isEmpty();
    }

    /** {@link #assertNothingAfter}가 찾은 자리(경로 = 글) — 비어 있으면 없음. */
    private static List<String> problemsAfter(JsonNode body, LocalDate asOf, Instant readAt) {
        List<String> problems = new ArrayList<>();
        Iterator<String> names = body.propertyNames().iterator();
        while (names.hasNext()) {
            String section = names.next();
            if (PacketBuilder.CALENDAR.equals(section)) {
                continue;   // 앞날 일정(창 = 기준일 다음 세션부터) — 자료가 아니라 일정표
            }
            walk(section, null, body.get(section), asOf, readAt, problems);
        }
        return problems;
    }

    @Test
    @DisplayName("assertNothingAfter 도우미 자체 — 소수 초가 붙은 시각(토스 sessionUpdatedAt 모양)·시간대 없는 시각(KST로 읽음)·초 없는 시각도 읽은 순간 뒤면 잡음, 앞이면 통과")
    void nothingAfterCatchesEveryIsoShape() {
        ObjectNode body = MAPPER.createObjectNode();
        ObjectNode section = body.putObject("3_kr_macro");
        section.put("fraction", "2026-11-03T22:40:03.000+09:00");
        section.put("local", "2026-11-03T22:40");
        section.put("localSeconds", "2026-11-03T22:40:03.5");
        section.put("utc", "2026-11-03T13:40:00Z");
        section.put("before", "2026-11-03T20:06:03.000+09:00");
        section.put("beforeLocal", "2026-11-03T22:31");

        assertThat(problemsAfter(body, D, READ_D)).containsExactly(
                "3_kr_macro.fraction = 2026-11-03T22:40:03.000+09:00", "3_kr_macro.local = 2026-11-03T22:40",
                "3_kr_macro.localSeconds = 2026-11-03T22:40:03.5", "3_kr_macro.utc = 2026-11-03T13:40:00Z");
    }

    /** ISO 시각 — 초·소수 초·시간대는 있을 수도 없을 수도(시간대가 없으면 KST로 읽음). */
    private static final Pattern ISO = Pattern.compile(
            "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?([+-]\\d{2}:\\d{2}|Z)?");
    private static final Pattern KST_STAMP = Pattern.compile("(\\d{4}-\\d{2}-\\d{2}) (\\d{2}:\\d{2}) KST");

    private static void walk(String path, String key, JsonNode node, LocalDate asOf, Instant readAt, List<String> problems) {
        if (node == null) {
            return;
        }
        if (node.isObject()) {
            node.properties().forEach(e -> walk(path + "." + e.getKey(), e.getKey(), e.getValue(), asOf, readAt, problems));
            return;
        }
        if (node.isArray()) {
            for (int i = 0; i < node.size(); i++) {
                walk(path + "[" + i + "]", key, node.get(i), asOf, readAt, problems);
            }
            return;
        }
        if (!node.isString() || CALENDAR_KEYS.contains(key)) {
            return;
        }
        String text = node.asString();
        if (path.contains("pendingOrders.rows") || path.endsWith("11_notes.text")) {
            return;   // 대기 주문 줄의 마지막 칸·메모 구분자의 '만료 …'는 만료일(규칙·사용자가 정한 미래 날짜)
        }
        Matcher iso = ISO.matcher(text);
        while (iso.find()) {
            Instant at = iso.group(3) == null
                    ? LocalDateTime.parse(iso.group()).atZone(KrxCalendar.SEOUL).toInstant()
                    : OffsetDateTime.parse(iso.group()).toInstant();
            if (at.isAfter(readAt)) {
                problems.add(path + " = " + text);
            }
        }
        Matcher stamp = KST_STAMP.matcher(text);
        while (stamp.find()) {
            if (kst(stamp.group(1) + "T" + stamp.group(2)).isAfter(readAt)) {
                problems.add(path + " = " + text);
            }
        }
        Matcher date = DATE.matcher(text);
        while (date.find()) {
            if (LocalDate.parse(date.group()).isAfter(asOf) && !path.endsWith("window.to")) {
                problems.add(path + " = " + text);
            }
        }
    }
}
