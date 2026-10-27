package com.macrodash.feature.paper;

import com.macrodash.analytics.KrxCalendar;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.StoreRepository;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.when;

/**
 * 한국 규칙 계좌 시험의 저장본 재료 — 유니버스({@code kr_paper_universe}, 기준일 → 행)·수급({@code kr_paper_flow}, 종목 → 날짜 행)·DART 주요계정
 * ({@code kr.dart_fundamentals})을 수집기 저장 모양 그대로 들고, 가짜 저장소 읽기(Mockito {@link StoreRepository}·{@link StoreReader})에
 * 넣습니다. 외부 호출·수집기 표 쓰기 없음.
 */
final class KrRulesFixtures {

    /** 공휴일 시험 자료(천문연 2026·2027)로 만든 KRX 달력 — 실행이 만드는 달력과 같은 규칙. */
    static final TradingCalendar CALENDAR = new KrxCalendar(
            KrPaperMarket.holidaysByYear(KrFixtures.holidaysPayload(2026, 2027)), List.of(), Map.of());

    /** 기준일 → U 행(순위 순). */
    final TreeMap<LocalDate, List<ObjectNode>> universe = new TreeMap<>();
    /** 종목 → 날짜 → 수급 행. */
    final Map<String, TreeMap<LocalDate, ObjectNode>> flows = new TreeMap<>();
    /** DART 저장본 본문 — {@code {source, companies: {code: {...}}}}. */
    final ObjectNode dart = PaperFixtures.MAPPER.createObjectNode();
    Instant dartCollectedAt = Instant.parse("2026-10-20T13:00:00Z");

    KrRulesFixtures() {
        dart.put("source", "시험용 DART 주요계정");
        dart.putObject("companies");
    }

    /** 표준 U의 마지막 수급 날(그날까지 30 KR 거래일 기록). */
    static final LocalDate FLOWS_THROUGH = LocalDate.of(2026, 11, 5);

    /**
     * 손계산 고정본의 표준 재료 — U 여덟 종목(기준일마다 같은 구성), 30 KR 거래일 수급(11-05까지), DART. D = 11-03이면(창 10-06~11-03):
     * <pre>
     *  순위 코드    20일 외국인    기관     상장주식수      점수      판정
     *   1  005930  +2,000,000 +1,000,000  3,000,000,000  0.1      후보
     *   2  000660    +400,000   +200,000    300,000,000  0.2      후보
     *   3  373220    −200,000   −100,000    234,000,000  −0.1282… 수급 미달(둘 다 순매도 — 보유면 매일 매도 신호)
     *   4  207940     +20,000    +20,000     71,174,000  0.0562…  자료 없음(DART 없음)
     *   5  005380     +60,000    +40,000    200,000,000  0.05     자료 없음(접수일 2026-11-04 > 기준일)
     *   6  068270     +60,000    +40,000    200,000,000  0.05     자료 없음(접수일 모름 — 접수번호가 14자리 숫자가 아님)
     *   7  105560    +100,000   +100,000    400,000,000  0.05     후보(금융업 코드 표 — 부채비율 2,000%여도 통과)
     *   8  000270  (10-22 기록 없음)          400,000,000  null     자료 부족(20거래일 중 19일)
     * </pre>
     * 후보 = 000660(0.2) · 005930(0.1) · 105560(0.05, U 순위 7), 동일비중이면 종목마다 100 ÷ 15 = 6.6667%(상한 10% 안), 주식 20%·153130 80%.
     */
    static KrRulesFixtures standard(LocalDate... bases) {
        return standardThrough(FLOWS_THROUGH, bases);
    }

    /**
     * {@link #standard}과 같은 구성원·DART에 수급만 {@code through}까지 30 KR 거래일(출발 시험 — S = 11-30이면 창에 10-22가 없어 000270도,
     * 접수일 11-04 ≤ S라 005380도 후보가 됨).
     */
    static KrRulesFixtures standardThrough(LocalDate through, LocalDate... bases) {
        KrRulesFixtures data = new KrRulesFixtures();
        LocalDate first = bases[0];
        data.member(first, 1, "005930", "삼성전자", 3_000_000_000L)
                .member(first, 2, "000660", "SK하이닉스", 300_000_000L)
                .member(first, 3, "373220", "LG에너지솔루션", 234_000_000L)
                .member(first, 4, "207940", "삼성바이오로직스", 71_174_000L)
                .member(first, 5, "005380", "현대차", 200_000_000L)
                .member(first, 6, "068270", "셀트리온", 200_000_000L)
                .member(first, 7, "105560", "KB금융", 400_000_000L)
                .member(first, 8, "000270", "기아", 400_000_000L);
        data.sameUniverse(first, java.util.Arrays.copyOfRange(bases, 1, bases.length));
        data.flows("005930", through, 30, 100_000, 50_000)
                .flows("000660", through, 30, 20_000, 10_000)
                .flows("373220", through, 30, -10_000, -5_000)
                .flows("207940", through, 30, 1_000, 1_000)
                .flows("005380", through, 30, 3_000, 2_000)
                .flows("068270", through, 30, 3_000, 2_000)
                .flows("105560", through, 30, 5_000, 5_000)
                .flows("000270", through, 30, 5_000, 5_000);
        if (data.flows.get("000270") != null) {
            data.flows.get("000270").remove(LocalDate.of(2026, 10, 22));
        }
        data.dart("005930", "2025", "20260310002820", 300e12, 30e12, 300e12, 100e12)
                .dart("000660", "2025", "20260312000111", 60e12, 10e12, 100e12, 50e12)
                .dart("373220", "2025", "20260311000222", 25e12, 1e12, 100e12, 100e12)
                .dart("005380", "2025", "20261104000001", 160e12, 12e12, 90e12, 120e12)
                .dart("068270", "2025", "R2026031400", 3e12, 0.5e12, 20e12, 5e12)
                .dart("105560", "2025", "20260619000333", null, 5e12, 50e12, 1_000e12)
                .dart("000270", "2025", "20260313000444", 100e12, 9e12, 60e12, 40e12);
        return data;
    }

    /**
     * 후보가 없는 U — 두 종목 모두 20일 외국인·기관 둘 다 순매도(수급 미달). 규칙 계좌 출발은 주식 없이 남는 현금 99.5%를 153130에 둡니다
     * (벤치마크 생애 시험 — 규칙 계좌가 함께 출발해도 ETF 둘만 봄).
     */
    static KrRulesFixtures noCandidates(LocalDate through, LocalDate... bases) {
        KrRulesFixtures data = new KrRulesFixtures();
        data.member(bases[0], 1, "005930", "삼성전자", 3_000_000_000L).member(bases[0], 2, "000660", "SK하이닉스", 300_000_000L);
        data.sameUniverse(bases[0], java.util.Arrays.copyOfRange(bases, 1, bases.length));
        data.flows("005930", through, 30, -100_000, -50_000).flows("000660", through, 30, -20_000, -10_000);
        data.dart("005930", "2025", "20260310002820", 300e12, 30e12, 300e12, 100e12)
                .dart("000660", "2025", "20260312000111", 60e12, 10e12, 100e12, 50e12);
        return data;
    }

    /**
     * 그 세션의 {@code paper.kr.quotes} — 표준 U 여덟 종목 + 069500·153130, 봉 둘(직전 거래일·그날, 시가 10,000·종가 10,100, 거래량 > 0, 1분봉
     * 없음 — 토스 일봉 시가 사다리), 그날 21:56 KST에 받고 21:57에 저장.
     */
    static com.macrodash.store.Snapshot quotes(LocalDate session) {
        return quotes(session, java.util.Set.of());
    }

    /**
     * {@link #quotes(LocalDate)}에서 {@code noSessionBar} 종목만 그날 봉이 없는(토스가 아직 직전 거래일 봉까지만 준) 저장본 — 결정 게이트 ②·⑤
     * 시험(머리 {@code session}은 그날 그대로).
     */
    static com.macrodash.store.Snapshot quotes(LocalDate session, java.util.Set<String> noSessionBar) {
        LocalDate previous = CALENDAR.previousTradingDay(session);
        KrFixtures.Payload payload = new KrFixtures.Payload(session);
        Instant fetched = kst(session, "21:56");
        for (String code : List.of("005930", "000660", "373220", "207940", "005380", "068270", "105560", "000270")) {
            KrFixtures.Entry entry = payload.code(code, fetched).bar(previous, 10_000, 10_050, 100_000);
            if (!noSessionBar.contains(code)) {
                entry.bar(session, 10_000, 10_100, 120_000);
            }
        }
        KrFixtures.Entry kodex = payload.etf("069500", fetched).bar(previous, 95_000, 95_100, 3_000_000);
        if (!noSessionBar.contains("069500")) {
            kodex.bar(session, 95_200, 95_300, 3_100_000);
        }
        KrFixtures.Entry bond = payload.etf("153130", fetched).bar(previous, 108_000, 108_010, 40_000);
        if (!noSessionBar.contains("153130")) {
            bond.bar(session, 108_000, 108_020, 41_000);
        }
        return payload.snapshot(kst(session, "21:57"));
    }

    /**
     * 그 저장본의 {@code code} 종목을 그날 거래정지로 — 마지막 봉(그날) 거래량 0(토스 정지일 봉, toss.md 6), {@code krxFlag}면 토스
     * {@code krxTradingSuspended}도 참. 같은 저장본을 고쳐 돌려줍니다.
     */
    static com.macrodash.store.Snapshot suspend(com.macrodash.store.Snapshot snapshot, String code, boolean krxFlag) {
        ObjectNode entry = (ObjectNode) snapshot.payload().path("codes").path(code);
        JsonNode bars = entry.path("bars");
        ((ObjectNode) bars.get(bars.size() - 1)).put("volume", 0);
        if (krxFlag) {
            entry.put("krxTradingSuspended", true);
        }
        return snapshot;
    }

    /**
     * 그 저장본 {@code code} 종목의 {@code date} 봉을 정지일 봉(거래량 0)으로 — 정지가 풀린 뒤의 저장본에 남은 지난 정지일(수집기는 최근 봉을
     * 다시 받음). 같은 저장본을 고쳐 돌려줍니다.
     */
    static com.macrodash.store.Snapshot suspendedOn(com.macrodash.store.Snapshot snapshot, String code, LocalDate date) {
        for (JsonNode bar : snapshot.payload().path("codes").path(code).path("bars")) {
            if (date.toString().equals(bar.path("date").asString())) {
                ((ObjectNode) bar).put("volume", 0);
                return snapshot;
            }
        }
        throw new IllegalArgumentException(code + "에 " + date + " 봉이 없습니다");
    }

    /**
     * 그 저장본 {@code code} 종목 {@code date} 봉의 시가(고가)·종가(저가)·거래량·수정 비율({@code adjRatio} — 수정 종가도 함께)을 바꿉니다 — 분할 재상장·
     * 큰 변동 시험. 같은 저장본을 고쳐 돌려줍니다.
     */
    static com.macrodash.store.Snapshot rebar(com.macrodash.store.Snapshot snapshot, String code, LocalDate date, long open,
                                              long close, long volume, double adjRatio) {
        for (JsonNode bar : snapshot.payload().path("codes").path(code).path("bars")) {
            if (date.toString().equals(bar.path("date").asString())) {
                ((ObjectNode) bar).put("open", open).put("high", open).put("low", close).put("close", close)
                        .put("volume", volume).put("adjRatio", adjRatio).put("adjClose", close * adjRatio);
                return snapshot;
            }
        }
        throw new IllegalArgumentException(code + "에 " + date + " 봉이 없습니다");
    }

    /**
     * 그 저장본 {@code code} 종목 마지막 봉(그날)의 1분봉 개장 봉을 {@code FAILED}로 — 수집기가 같은 밤 다시 묻는 중이라 장부가 그 시가 주문을
     * 기다림(결정 d11, 관측 봉은 있음). 같은 저장본을 고쳐 돌려줍니다.
     */
    static com.macrodash.store.Snapshot minuteFailed(com.macrodash.store.Snapshot snapshot, String code) {
        JsonNode bars = snapshot.payload().path("codes").path(code).path("bars");
        ObjectNode minute = ((ObjectNode) bars.get(bars.size() - 1)).putObject("minute");
        minute.put("status", "FAILED");
        minute.put("priceSource", "TOSS_1M_OPEN");
        minute.put("reason", "아직 묻지 못함 — 호출 예산·시간 상한");
        return snapshot;
    }

    /**
     * 그 저장본 {@code code} 종목 항목을 이어받은 항목으로({@code isStale} — 수집기가 이번에 받지 못해 직전 값을 이음, 봉은 그대로). 같은 저장본을
     * 고쳐 돌려줍니다.
     */
    static com.macrodash.store.Snapshot stale(com.macrodash.store.Snapshot snapshot, String code) {
        ObjectNode entry = (ObjectNode) snapshot.payload().path("codes").path(code);
        entry.put("isStale", true);
        entry.put("staleReason", "시험용 호출 실패");
        return snapshot;
    }

    /** 같은 본문을 다른 수집 시각에 저장한 저장본(그 밤 다음 slow가 다시 쓴 판 — 장부가 새 관측치로 다시 처리). */
    static com.macrodash.store.Snapshot recollected(com.macrodash.store.Snapshot snapshot, Instant collectedAt) {
        return KrFixtures.snapshot(Datasets.SNAP_KR_PAPER_QUOTES, snapshot.payload(), collectedAt);
    }

    /** 그 기준일 U 한 종목(수집기 select_universe 모양). */
    KrRulesFixtures member(LocalDate base, int rank, String code, String name, long listedShares) {
        ObjectNode row = PaperFixtures.MAPPER.createObjectNode();
        row.put("code", code);
        row.put("name", name);
        row.put("rank", rank);
        row.put("marketCap", listedShares * 10_000.0);
        row.put("listedShares", (double) listedShares);
        row.put("close", 10_000.0);
        row.put("rule", "kospi-mcap-top100-common/v3");
        universe.computeIfAbsent(base, day -> new ArrayList<>()).add(row);
        return this;
    }

    /** 같은 구성원을 여러 기준일에 — 앞서 넣은 기준일의 행을 그대로 복사합니다. */
    KrRulesFixtures sameUniverse(LocalDate from, LocalDate... bases) {
        for (LocalDate base : bases) {
            List<ObjectNode> copy = new ArrayList<>();
            universe.get(from).forEach(row -> copy.add(row.deepCopy()));
            universe.put(base, copy);
        }
        return this;
    }

    /**
     * 한 종목·한 날 수급(토스 모양 — investors.foreigner/institution의 net, 기관 세부 칸, updatedAt, 우리가 받은 fetchedAt). null이면 그 칸이
     * 비어 있음.
     */
    KrRulesFixtures flow(String code, LocalDate date, Long foreign, Long institution, String updatedAt, Instant fetchedAt) {
        ObjectNode row = PaperFixtures.MAPPER.createObjectNode();
        row.put("code", code);
        row.put("date", date.toString());
        ObjectNode investors = row.putObject("investors");
        net(investors, "foreigner", foreign);
        net(investors, "institution", institution);
        net(investors, "individual", foreign == null || institution == null ? null : -(foreign + institution));
        ObjectNode breakdown = row.putObject("breakdown");
        net(breakdown, "pensionFund", institution);
        row.put("updatedAt", updatedAt);
        if (fetchedAt != null) {
            row.put("fetchedAt", fetchedAt.toString());
        }
        flows.computeIfAbsent(code, c -> new TreeMap<>()).put(date, row);
        return this;
    }

    /**
     * {@code end}로 끝나는 KR 거래일 {@code days}일 동안 매일 같은 순매수 — 그날 기록은 그날 20:21 판({@code updatedAt}), 그날 21:18 KST에 받음.
     */
    KrRulesFixtures flows(String code, LocalDate end, int days, long foreign, long institution) {
        LocalDate day = end;
        for (int i = 0; i < days; i++) {
            flow(code, day, foreign, institution, day + "T20:21:26.000+09:00", kst(day, "21:18"));
            day = CALENDAR.previousTradingDay(day);
        }
        return this;
    }

    /**
     * DART 회사 하나(사업보고서 주요계정 — 매출액 null이면 금융업식 재무상태표: 매출액·유동자산 계정 없음. 부채비율 상한을 볼지는 계정이
     * 아니라 금융업 코드 표({@code KrFinancialSector})가 정함).
     *
     * @param rceptNo 접수번호(앞 8자리 = 접수일)
     */
    KrRulesFixtures dart(String code, String bsnsYear, String rceptNo, Double revenue, double netIncome, double equity,
                         double debt) {
        ObjectNode company = ((ObjectNode) dart.get("companies")).putObject(code);
        company.put("name", code);
        company.put("bsnsYear", bsnsYear);
        company.put("fsDiv", "CFS");
        company.put("rceptNo", rceptNo);
        ObjectNode accounts = company.putObject("accounts");
        if (revenue != null) {
            accounts.putObject("매출액").put("current", revenue);
            accounts.putObject("유동자산").put("current", equity / 2);
        }
        accounts.putObject("당기순이익").put("current", netIncome);
        accounts.putObject("자본총계").put("current", equity);
        accounts.putObject("부채총계").put("current", debt);
        return this;
    }

    /** 가짜 저장소 읽기에 넣습니다(유니버스·수급은 저장소, DART는 저장본 읽기). */
    void install(StoreRepository repository, StoreReader reader) {
        when(repository.latestObservationDateBefore(eq(Datasets.OBS_KR_PAPER_UNIVERSE), any(LocalDate.class)))
                .thenAnswer(invocation -> {
                    LocalDate before = invocation.getArgument(1);
                    return universe.lowerKey(before);
                });
        when(repository.readObservations(eq(Datasets.OBS_KR_PAPER_UNIVERSE), any(LocalDate.class), isNull(), isNull()))
                .thenAnswer(invocation -> {
                    LocalDate base = invocation.getArgument(1);
                    List<JsonNode> out = new ArrayList<>();
                    for (ObjectNode row : universe.getOrDefault(base, List.of())) {
                        out.add(row.deepCopy().put("obsDate", base.toString()));
                    }
                    return out;
                });
        when(repository.readObservationSeries(eq(Datasets.OBS_KR_PAPER_FLOW), anyCollection(), any(LocalDate.class)))
                .thenAnswer(invocation -> {
                    Collection<String> codes = invocation.getArgument(1);
                    LocalDate since = invocation.getArgument(2);
                    Map<String, List<JsonNode>> out = new LinkedHashMap<>();
                    for (String code : codes) {
                        List<JsonNode> rows = new ArrayList<>();
                        flows.getOrDefault(code, new TreeMap<>()).descendingMap().forEach((date, row) -> {
                            if (!date.isBefore(since)) {
                                rows.add(row.deepCopy().put("obsDate", date.toString()));
                            }
                        });
                        if (!rows.isEmpty()) {
                            out.put(code, rows);
                        }
                    }
                    return out;
                });
        KrFixtures.stub(reader, Datasets.SNAP_DART_FUNDAMENTALS,
                KrFixtures.snapshot(Datasets.SNAP_DART_FUNDAMENTALS, dart, dartCollectedAt));
    }

    static Instant kst(LocalDate day, String time) {
        return java.time.ZonedDateTime.of(day, java.time.LocalTime.parse(time), KrxCalendar.SEOUL).toInstant();
    }

    private static void net(ObjectNode node, String key, Long net) {
        ObjectNode volumes = node.putObject(key);
        if (net == null) {
            volumes.putNull("net");
        } else {
            volumes.put("net", net);
            volumes.put("buy", Math.max(net, 0) + 1_000);
            volumes.put("sell", Math.max(-net, 0) + 1_000);
        }
    }
}
