package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.DailySeries;
import com.macrodash.analytics.Signal13F;
import com.macrodash.analytics.TrackRecord13F;
import com.macrodash.analytics.TrackRecord13F.Filing;
import com.macrodash.analytics.TrackRecord13F.Holding13F;
import com.macrodash.analytics.TrackRecord13F.Period;
import com.macrodash.analytics.TrackRecord13F.Ranked;
import com.macrodash.analytics.TrackRecord13F.Result;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.feature.institution.Institutions;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.Selection;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.store.PaperStore.TrackRecordRow;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import com.macrodash.support.TooManyRequestsException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZonedDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.DoublePredicate;
import java.util.stream.Stream;

/**
 * 기관 선정 — 후보 기관의 13F 트랙레코드를 계산해 순위를 매기고, 재선정일에 상위 N곳을 선정으로 남깁니다(명세 R1·R5·R7~R10,
 * 설계 §4-0 ⑤). 설계의 {@code TrackRecordService}입니다 — 국면 판정 성과의 {@code feature/insight/TrackRecordService}와 빈
 * 이름이 겹쳐 이름을 바꿨습니다(단계 0).
 *
 * <p><b>입력은 수집기 저장본뿐</b>입니다. 후보 목록·진행률은 {@code sec.13f.track_record_index}, 기관마다의 공시는
 * {@code sec.13f.{cik}.q30}(보유마다 {@code ticker}·{@code value}), 가격은 10년 종가 이력({@code equity_close})입니다. 스냅샷은
 * 언제나 {@link StoreReader#quietly}로 읽습니다 — 버튼(수동 재계산)이나 화면 조회가 SEC 수백 건짜리 수집을 깨우지 않게.
 * 가격은 창 안 모든 공시의 티커와 SPY를 <b>한 번에</b> 읽습니다(종목 약 550개 × 7년 — 티커마다 따로 읽으면 왕복이 수백 번).
 *
 * <p><b>룩어헤드</b>: 기준일 뒤 공시·가격을 쓰지 않습니다 — 공시는 {@link TrackRecord13F#compute}가 공시일로 거르고, 가격은
 * 읽는 범위를 기준일까지로 자릅니다. 최신 분기 공시 여부(R5)도 기준일까지 낸 공시로만 봅니다.
 *
 * <p><b>자격</b>은 {@link TrackRecord13F}의 기준(구간 수·커버리지)에 두 가지를 더합니다. ① 30분기 수집이 아직 끝나지 않은 기관
 * ({@code complete=false})은 "수집 중" — 창의 앞쪽 공시가 비어 구간 수·수익률이 실제보다 짧은 기간의 값이라 순위에 올리지
 * 않습니다(설계 §6-4). ② 그 기준일에 공시 기한이 지난 최신 분기를 공시하지 않은 기관은 그 분기 선정에서 빠집니다(R5, 사이언).
 * 다만 최신 분기가 없는 저장본을 그 분기 기한 EDGAR 마감 전에 받았으면 공시했는지 모르므로 R5가 아니라 "수집 대기"로 두고
 * 선정을 미룹니다({@link #select} ③, QA-175). 수치는 모두 그대로 계산해 화면이 보이게 합니다.
 *
 * <p><b>선정은 한 번</b>: {@link #select}는 그 기준일에 선정이 이미 있으면 바꾸지 않고, {@link #rerank}(수동 재계산)는
 * 트랙레코드만 다시 계산합니다 — 그 선정으로 낸 주문 기록과 어긋나지 않게(설계 §4-0 ⑤).
 *
 * <p><b>두 그룹(D27, 설계 §4-0 ⑥)</b>: 그룹 A는 위의 후보 27곳(7년 창, 상위 {@code trackRecord.topN}), 그룹 B는 이미 지켜보던
 * '기관 13F 포트폴리오 분석' 메뉴 12곳({@link Institutions#ALL})을 <b>같은 방법</b>(공시일 다음 거래일 복제)·같은 커버리지 자격·R5로
 * 최근 {@code blend.groupB.windowYears}(2)년 창에서 잰 상위 {@code blend.groupB.topN}(4)곳입니다. 그룹 B 기관의 공시는
 * {@code q30}이 있으면(후보 27곳과 겹치는 기관 — CUSIP 매핑 티커) 그것, 없으면 기존 메뉴 저장본 {@code q8}(이름 매핑 티커)입니다 —
 * q8은 8분기라 2년 창이 두 저장본이 공통으로 덮는 길이입니다. 그룹 B에는 "수집 중" 자격 규칙이 없습니다(q8에는 완료 표시가
 * 없고, 짧은 저장본은 구간 수 기준이 거름). 인덱스·연기금은 덮인 대형주만 보여 복제 수익률이 부풀지만 커버리지 기준에서 빠집니다.
 * 선정 행 하나에 두 그룹과 <b>신호 풀</b>(A ∪ B, 겹치면 한 번 — {@link Signal13F#blendWeights}의 기관 가중과 함께)을 남기고,
 * 규칙 책은 그 풀과 가중을 다시 계산하지 않고 읽습니다({@link #signalPool}).
 */
@Service
public class PaperSelectionService {

    private static final Logger log = LoggerFactory.getLogger(PaperSelectionService.class);

    /** 수집기 태스크 이름(registry) — quietly로만 읽으니 요청은 나가지 않고, 읽기 경로의 이름표입니다. */
    static final String TRACK_RECORD_TASK = "sec_13f_track_record";
    static final String SPY = "SPY";
    /**
     * 가격을 창 시작보다 이만큼 앞에서부터 읽습니다. 첫 구간 시작 가격은 그날 이하 마지막 종가가 7일 안이어야 하므로
     * ({@code TrackRecord13F.MAX_START_PRICE_AGE_DAYS}) 연휴·거래 정지를 넉넉히 덮습니다.
     */
    static final int PRICE_MARGIN_DAYS = 14;
    /** "수집 중" 사유의 앞머리 — 조회 응답의 {@code collecting}을 저장된 사유에서 다시 읽습니다(열이 따로 없음). */
    static final String COLLECTING_PREFIX = "수집 중(";
    static final String NO_INDEX_REASON = "후보 목록(sec.13f.track_record_index)이 아직 없습니다 — 수집기가 13F 트랙레코드 "
            + "태스크(sec_13f_track_record)를 돌린 뒤 다시 계산하세요.";
    static final String NO_CANDIDATE_REASON = "후보가 없습니다 — 설정 trackRecord.candidateCiks가 수집 목록의 기관과 "
            + "겹치지 않습니다.";
    /** 선정을 남기지 않은 이유 — 자격 기관 0곳인데 수집 중인 후보가 있음. %d = 수집 중 기관 수, 후보 수. */
    static final String COLLECTING_SKIP_REASON = "수집 중 %d곳(후보 %d곳) — 자격 있는 기관이 아직 없어 선정을 남기지 "
            + "않습니다. 수집이 덜 끝나서인지 기준 미달인지 몰라 '자격 기관 없음'으로 굳히지 않습니다 — 수집이 끝난 뒤 다시 "
            + "선정합니다.";
    /**
     * 13F 공시 기한일에 EDGAR가 공시를 받는 마지막 시각(동부). 이 뒤에 받은 저장본에 그 분기가 없으면 '공시하지 않음'(R5), 앞이면
     * '아직 받지 못함'입니다(QA-175).
     */
    static final LocalTime EDGAR_CLOSE = LocalTime.of(22, 0);
    /**
     * 최신 분기를 아직 받지 못한 기관을 기다리는 거래일 수(사용자 결정 6, QA-175) — 그 분기 재선정일 r에서 이만큼 지난 세션(r+5)의
     * 결정부터는 기다리지 않고 받지 못한 기관을 '수집 실패로 제외'한 채 선정합니다. 영구 실패 기관 하나가 그 분기 선정을 끝까지
     * 막지 않게.
     */
    static final int PENDING_WAIT_TRADING_DAYS = 5;
    /**
     * 선정을 남기지 않은 이유 — 최신 분기를 아직 받지 못한 기관이 있음(QA-175). %s = 최신 분기, %d = 기관 수, %s = 기관 이름,
     * %s = 공시 기한, %s = 기다리는 마지막 세션.
     */
    static final String PENDING_SKIP_REASON = "최신 분기(%s) 13F 수집 대기 %d곳(%s) — 그 분기 공시 기한(%s) EDGAR 마감 "
            + "전에 받은 저장본이라 공시했는지 모릅니다. '최신 분기 공시 없음'으로 빼고 선정을 굳히지 않고, 수집기가 받은 뒤 다시 "
            + "선정합니다(%s 결정까지 받지 못하면 그 기관을 '수집 실패로 제외'하고 선정).";
    /** 수동 재계산이 겹쳤을 때 다시 누를 때까지의 안내 시간. 27곳 계산은 보통 몇 초입니다. */
    static final Duration BUSY_RETRY = Duration.ofSeconds(15);

    /** 트랙레코드의 한계(명세 §6 5·6번을 이 탭에 맞게 나눔) — 순서대로 복제 수익률·생존 편향·커버리지. */
    static final List<String> LIMITS = List.of(
            "트랙레코드는 13F 공시일 다음 거래일 종가에 사서 다음 공시의 다음 거래일 종가까지 들었다고 복제한 값입니다 — "
                    + "실제 기관 수익률이 아닙니다(분기 중 매매·공매도·채권·옵션은 13F에 보이지 않습니다). 수정주가라 배당이 들어갑니다.",
            "후보 기관 목록은 오늘 알려진 운용사라 생존 편향이 있습니다 — 사라진 운용사는 처음부터 후보에 없습니다.",
            "커버리지(티커와 가격이 있는 평가액 비중)가 100% 미만이면 수익률은 '커버 보유분 기준'입니다. 커버리지가 낮은 "
                    + "기관은 자격에서 뺍니다.");

    private final PaperStore store;
    private final StoreReader reader;
    private final PaperMarketData marketData;
    private final PaperSettingsService settings;
    private final ObjectMapper mapper;
    private final Clock clock;
    /**
     * 계산은 한 번에 하나 — 저장본 27개·가격 수십만 점을 읽는 일이라 버튼을 두 번 누르면 같은 일을 두 번 합니다. 정기 작업
     * ({@link #select})은 기다리고, 수동 재계산은 기다리지 않고 429로 돌려보냅니다.
     */
    private final ReentrantLock computing = new ReentrantLock();

    @Autowired
    public PaperSelectionService(PaperStore store, StoreReader reader, PaperMarketData marketData,
                                 PaperSettingsService settings, ObjectMapper mapper) {
        this(store, reader, marketData, settings, mapper, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 움직입니다(수동 재계산의 기본 기준일 = 마지막 완료 세션). */
    PaperSelectionService(PaperStore store, StoreReader reader, PaperMarketData marketData,
                          PaperSettingsService settings, ObjectMapper mapper, Clock clock) {
        this.store = store;
        this.reader = reader;
        this.marketData = marketData;
        this.settings = settings;
        this.mapper = mapper;
        this.clock = clock;
    }

    // ------------------------------------------------------------------ 설정
    /**
     * 설정 {@code trackRecord.*}(설계 §4-4) 중 계산이 읽는 값. 키가 없거나 범위 밖이면 그 키만 기본값으로 읽고
     * {@link #fallbacks}에 남깁니다({@link PaperSettings}와 같은 방식 — 설정 쓰기 API(단계 3a)가 검사하기 전의 행이 있어도
     * 계산이 멈추지 않게).
     *
     * @param candidateCiks null이면 수집 목록의 기관 전부, 아니면 그 목록만(명세 D21)
     */
    public record TrackRecordSettings(TrackRecord13F.Criteria criteria, TrackRecord13F.Metric metric, int topN,
                                      List<String> candidateCiks, List<String> fallbacks) {

        public static final int DEFAULT_TOP_N = 5;

        public TrackRecordSettings {
            candidateCiks = candidateCiks == null ? null : List.copyOf(candidateCiks);
            fallbacks = List.copyOf(fallbacks);
        }

        public static TrackRecordSettings defaults() {
            return new TrackRecordSettings(TrackRecord13F.Criteria.defaults(), TrackRecord13F.Metric.CAGR,
                    DEFAULT_TOP_N, null, List.of());
        }

        /** 설정 본문 전체에서 {@code trackRecord}를 읽습니다. null이면 기본값. */
        static TrackRecordSettings from(JsonNode body) {
            JsonNode node = Json.child(body, "trackRecord");
            if (node == null || !node.isObject()) {
                return new TrackRecordSettings(TrackRecord13F.Criteria.defaults(), TrackRecord13F.Metric.CAGR,
                        DEFAULT_TOP_N, null, body == null ? List.of() : List.of("trackRecord"));
            }
            TrackRecord13F.Criteria base = TrackRecord13F.Criteria.defaults();
            List<String> fallbacks = new ArrayList<>();
            // 창은 10년 이력(equity_close)과 30분기 저장본이 덮는 범위 안에서만 — 더 길면 앞쪽이 비어 짧은 기간의 값이 됩니다.
            int window = (int) number(node, "windowYears", base.windowYears(),
                    v -> v >= 1 && v <= 7 && v == Math.rint(v), fallbacks);
            int minPeriods = (int) number(node, "minPeriods", base.minPeriods(),
                    v -> v >= 0 && v <= 200 && v == Math.rint(v), fallbacks);
            double minCoverage = number(node, "minCoverage", base.minCoverage(), v -> v >= 0 && v <= 1, fallbacks);
            double avgCoverage = number(node, "avgCoverage", base.avgCoverage(), v -> v >= 0 && v <= 1, fallbacks);
            int topN = (int) number(node, "topN", DEFAULT_TOP_N, v -> v >= 1 && v <= 50 && v == Math.rint(v),
                    fallbacks);
            TrackRecord13F.Metric metric = TrackRecord13F.Metric.CAGR;
            String metricText = Json.asText(node, "metric");
            try {
                metric = TrackRecord13F.Metric.valueOf(metricText == null ? "" : metricText.trim()
                        .toUpperCase(Locale.ROOT));
            } catch (IllegalArgumentException e) {
                fallbacks.add("metric");
            }
            List<String> ciks = null;
            JsonNode list = Json.child(node, "candidateCiks");
            if (list != null) {
                if (list.isArray()) {
                    LinkedHashSet<String> unique = new LinkedHashSet<>();
                    for (JsonNode item : list) {
                        String cik = normalizeCik(item.isString() ? item.asString("") : null);
                        if (cik != null) {
                            unique.add(cik);
                        }
                    }
                    ciks = List.copyOf(unique);
                } else {
                    fallbacks.add("candidateCiks");
                }
            }
            return new TrackRecordSettings(new TrackRecord13F.Criteria(window, minPeriods, minCoverage, avgCoverage),
                    metric, topN, ciks, fallbacks.stream().map(key -> "trackRecord." + key).toList());
        }

        private static double number(JsonNode node, String key, double fallback, DoublePredicate valid,
                                     List<String> fallbacks) {
            Double value = Json.asDouble(node, key);
            if (value == null || !Double.isFinite(value) || !valid.test(value)) {
                fallbacks.add(key);
                return fallback;
            }
            return value;
        }
    }

    /** CIK를 저장본과 같은 10자리(앞 0 채움)로. 숫자가 아니거나 비면 null. */
    static String normalizeCik(String text) {
        if (text == null) {
            return null;
        }
        String digits = text.trim();
        if (digits.isEmpty() || digits.length() > 10 || !digits.chars().allMatch(Character::isDigit)) {
            return null;
        }
        return "0".repeat(10 - digits.length()) + digits;
    }

    // ------------------------------------------------------------------ 수집 저장본
    /** 후보 목록 저장본 한 줄. 저장 분기 수를 모르면 0. */
    record Filer(String cik, String name, String style, int storedQuarters, boolean complete) {
    }

    /** 후보 목록 저장본. 기관 순서는 수집기 목록 순(스타일별)입니다. */
    record CollectionIndex(Instant collectedAt, List<Filer> filers, int targetQuarters) {
    }

    /**
     * 기관 하나의 13F 저장본을 계산이 받는 모양으로. 저장본이 없으면 공시 없음·수집 중이고 source·collectedAt은 null.
     *
     * @param source      읽은 저장본(TrackRecordRow.SOURCE_Q30·SOURCE_Q8)
     * @param collectedAt 그 저장본을 마지막으로 받은 시각 — 수집기는 실패하면 저장본을 덮지 않으므로 이 시각 뒤의 공시는
     *                    모릅니다(QA-175)
     */
    record StoredFilings(List<Filing> filings, int storedQuarters, boolean complete, String source,
                         Instant collectedAt) {
    }

    /** 그룹 B 후보 한 곳(D27) — 기존 13F 메뉴 목록({@link Institutions#ALL})의 이름·설명 그대로. */
    record MenuFiler(String cik, String name, String desc) {
    }

    /** 그룹 B 후보 — 기존 메뉴 12곳, 메뉴 순서. CIK는 저장본과 같은 10자리. */
    static List<MenuFiler> groupBCandidates() {
        List<MenuFiler> out = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Map<String, String> entry : Institutions.ALL) {
            String cik = normalizeCik(entry.get("cik"));
            if (cik != null && seen.add(cik)) {
                out.add(new MenuFiler(cik, entry.get("name"), entry.get("desc")));
            }
        }
        return out;
    }

    Optional<CollectionIndex> index() {
        return reader.quietly(() -> reader.read(Datasets.SNAP_TRACK_RECORD_INDEX, Datasets.MAX_AGE_WEEKLY,
                TRACK_RECORD_TASK)).flatMap(PaperSelectionService::parseIndex);
    }

    static Optional<CollectionIndex> parseIndex(Snapshot snapshot) {
        JsonNode payload = snapshot.payload();
        List<Filer> filers = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (JsonNode node : Json.array(payload, "filers")) {
            String cik = normalizeCik(Json.asText(node, "cik"));
            if (cik == null || !seen.add(cik)) {
                continue;
            }
            Double stored = Json.asDouble(node, "storedQuarters");
            filers.add(new Filer(cik, Json.asText(node, "name"), Json.asText(node, "style"),
                    stored == null ? 0 : stored.intValue(), Json.asBoolean(node, "complete")));
        }
        if (filers.isEmpty()) {
            return Optional.empty();
        }
        Double target = Json.asDouble(payload, "targetQuarters");
        return Optional.of(new CollectionIndex(snapshot.collectedAt(), filers,
                target == null || target < 1 ? Datasets.TRACK_RECORD_QUARTERS : target.intValue()));
    }

    /** 그룹 A 기관의 공시 — 후보 수집 저장본 q30만. */
    private StoredFilings stored(String cik, Map<String, String> pool) {
        return stored(Datasets.sec13f(cik, Datasets.TRACK_RECORD_QUARTERS), TrackRecordRow.SOURCE_Q30, pool);
    }

    /**
     * 그룹 B 기관의 공시(D27) — q30이 있으면(메타의 complete와 상관없이) 그것, 없으면 기존 메뉴 저장본 q8. q30은 CUSIP 매핑
     * 티커라 같은 기관이면 커버리지가 높고, 그룹 A와 같은 공시를 쓰게 됩니다. 둘 다 없으면 공시 없음(source null).
     *
     * <p>q30이 최신 분기를 아직 받지 못한 저장본({@link #awaitingLatest})이어도 q8로 바꾸지 않습니다 — 규칙 책 신호·패킷 6b가
     * 같은 규칙(q30이 있으면 q30)으로 그 기관의 13F를 읽으므로, q8로 뽑은 기관은 신호를 내지 못합니다. 그 기관은 그룹 A와 같이
     * "수집 대기"입니다(QA-175).
     */
    private StoredFilings storedGroupB(String cik, Map<String, String> pool) {
        StoredFilings q30 = stored(cik, pool);
        if (q30.source() != null) {
            return q30;
        }
        return stored(Datasets.sec13f(cik, Datasets.MAX_TRACKED_QUARTERS), TrackRecordRow.SOURCE_Q8, pool);
    }

    /**
     * 13F 저장본 하나 → 공시 목록. 공시일을 모르는 분기는 구간을 정할 수 없어 빼고, 평가액이 없는 보유 줄은 총평가액에도
     * 넣지 않습니다(모르는 값을 0으로 세지 않음). 티커 문자열은 {@code pool}로 같은 객체를 씁니다(30분기 × 보유 수천 줄).
     *
     * <p>저장본을 JSON 트리로 읽지 않고, 메타(완료 여부)와 보유 열만 DB에서 풀어 읽습니다 — 27곳 × 30분기 트리를 저장소 파싱
     * 캐시에 남기면 백엔드 힙을 위협합니다({@link StoreReader#readStoredHoldings}). 수집을 깨우지 않는 읽기입니다.
     */
    private StoredFilings stored(String name, String source, Map<String, String> pool) {
        Optional<Snapshot> meta = reader.readStoredMeta(name, "quarters");
        if (meta.isEmpty()) {
            return new StoredFilings(List.of(), 0, false, null, null);
        }
        List<StoreRepository.HoldingRow> rows = reader.readStoredHoldings(name);
        Map<Integer, List<StoreRepository.HoldingRow>> byQuarter = new LinkedHashMap<>();
        for (StoreRepository.HoldingRow row : rows) {
            byQuarter.computeIfAbsent(row.quarterIndex(), key -> new ArrayList<>()).add(row);
        }
        List<Filing> filings = new ArrayList<>(byQuarter.size());
        for (List<StoreRepository.HoldingRow> quarter : byQuarter.values()) {
            StoreRepository.HoldingRow first = quarter.get(0);
            LocalDate filingDate = Json.parseDate(first.filingDate());
            if (filingDate == null) {
                continue;
            }
            List<Holding13F> holdings = new ArrayList<>(quarter.size());
            for (StoreRepository.HoldingRow holding : quarter) {
                if (holding.value() == null) {
                    continue;
                }
                String ticker = holding.ticker();
                ticker = ticker == null || ticker.isBlank() ? null : pool.computeIfAbsent(ticker.strip(), key -> key);
                holdings.add(new Holding13F(ticker, holding.value()));
            }
            filings.add(new Filing(filingDate, Json.parseDate(first.reportDate()), holdings));
        }
        return new StoredFilings(filings, byQuarter.size(), Json.asBoolean(meta.get().payload(), "complete"), source,
                meta.get().collectedAt());
    }

    /**
     * 창 안 구간에 들어갈 공시의 티커 — 가격을 한 번에 읽을 목록. {@link TrackRecord13F#compute}가 구간으로 세는 공시의
     * 상위 집합입니다(다음 공시의 다음 거래일이 창 시작 뒤인 공시와, 기준일까지의 마지막 공시). 기준일 뒤 공시는 넣지 않습니다.
     * "다음 공시"는 계산과 같은 순서({@link TrackRecord13F#FILING_ORDER} — 같은 날이면 보고일 순)로 정합니다. 저장본은 보고일
     * 내림차순이라 공시일로만 정렬하면 같은 날 낸 두 공시가 [뒤 분기, 앞 분기]로 남아, 계산이 뒤 분기로 만드는 구간의 티커를 빠뜨립니다.
     */
    static Set<String> windowTickers(List<Filing> filings, LocalDate asOf, LocalDate windowStart) {
        List<Filing> seen = filings.stream().filter(f -> !f.filingDate().isAfter(asOf))
                .sorted(TrackRecord13F.FILING_ORDER).toList();
        Set<String> out = new TreeSet<>();
        for (int i = 0; i < seen.size(); i++) {
            boolean last = i == seen.size() - 1;
            if (!last && !UsMarketCalendar.nextTradingDay(seen.get(i + 1).filingDate()).isAfter(windowStart)) {
                continue;
            }
            for (Holding13F holding : seen.get(i).holdings()) {
                if (holding.ticker() != null) {
                    out.add(holding.ticker());
                }
            }
        }
        return out;
    }

    /**
     * 기준일까지 그 분기(또는 더 뒤 분기)를 공시했는가(R5). 보고일을 모르는 공시는 어느 분기인지 알 수 없어 세지 않습니다.
     */
    static boolean filedQuarter(List<Filing> filings, LocalDate quarterEnd, LocalDate asOf) {
        return filings.stream().anyMatch(f -> !f.filingDate().isAfter(asOf) && f.reportDate() != null
                && !f.reportDate().isBefore(quarterEnd));
    }

    /** 그 분기 13F 공시 기한일의 EDGAR 마감 순간(22:00 동부) — 기한 안에 낸 공시가 모두 EDGAR에 올라온 뒤(QA-175). */
    static Instant filingCutoff(LocalDate quarterEnd) {
        return ZonedDateTime.of(UsMarketCalendar.thirteenFDeadline(quarterEnd), EDGAR_CLOSE, UsMarketCalendar.NEW_YORK)
                .toInstant();
    }

    /**
     * 최신 분기를 아직 받지 못한 저장본인가(QA-175) — 그 분기 공시가 없는데 저장본을 그 분기 기한 EDGAR 마감 전에 받았음.
     * 수집기는 실패·예산 소진이면 저장본을 덮지 않으므로, 그 뒤에 낸 공시는 '공시하지 않음'(R5)과 구별되지 않습니다.
     * 수집 시각을 모르면(저장본 없음) 거짓입니다.
     */
    static boolean awaitingLatest(StoredFilings stored, LocalDate latestQuarter, LocalDate asOf) {
        return stored.collectedAt() != null && stored.collectedAt().isBefore(filingCutoff(latestQuarter))
                && !filedQuarter(stored.filings(), latestQuarter, asOf);
    }

    // ------------------------------------------------------------------ 계산
    /**
     * 후보 한 곳의 최종 결과.
     *
     * @param result        자격·사유는 "수집 중"·"최신 분기 공시 없음"까지 반영한 값(수치는 {@link TrackRecord13F} 그대로)
     * @param rank          자격 있는 기관의 순위(1부터), 없으면 null
     * @param collecting    30분기 수집이 끝나지 않아 자격에서 뺌(그룹 A만 — 그룹 B는 늘 false)
     * @param missingLatest 기준일에 공시 기한이 지난 최신 분기를 공시하지 않아 자격에서 뺌(R5)
     * @param pending       최신 분기를 아직 받지 못해 자격에서 뺌({@link PaperSelectionService#awaitingLatest} — 공시했는지
     *                      모름, QA-175). missingLatest와 함께 참이 되지 않습니다
     * @param source        계산에 쓴 저장본(q30·q8). 저장본이 없으면 null
     */
    public record Scored(String cik, String name, String style, Result result, Integer rank, boolean collecting,
                         boolean missingLatest, boolean pending, int storedQuarters, boolean complete, String source) {
    }

    /**
     * 기준일 하나의 계산.
     *
     * @param settingsVersion 계산에 쓴 설정 버전(건너뛰었으면 null)
     * @param latestQuarter   그 기준일에 공시 기한이 지난 최신 분기 말(R5)
     * @param candidates      그룹 A 후보, 후보 목록 순서(수집기 목록 순)
     * @param skippedReason   계산하지 못한 이유(후보 목록 없음 등). 계산했으면 null — 이때만 저장합니다
     * @param blend           두 그룹 섞기 설정(D27) — 그룹 B 기준·선정 수·기관 가중의 g
     * @param groupB          그룹 B 후보(D27), 기존 메뉴 순서. 건너뛰었으면 빈 목록
     * @param waitUntil       최신 분기를 받지 못한 기관을 기다리는 끝 세션(재선정일 +
     *                        {@value PaperSelectionService#PENDING_WAIT_TRADING_DAYS}거래일, QA-175) — 이 세션의 결정부터는
     *                        기다리지 않음
     * @param waitOver        계산한 때(마지막 완료 세션)가 waitUntil 이상 — 받지 못한 기관을 '수집 실패로 제외'하고 선정
     */
    public record Computation(LocalDate asOf, Integer settingsVersion, TrackRecordSettings settings,
                              LocalDate latestQuarter, List<Scored> candidates, String skippedReason,
                              PaperSettings.Blend blend, List<Scored> groupB, LocalDate waitUntil, boolean waitOver) {

        public Computation {
            candidates = List.copyOf(candidates);
            groupB = List.copyOf(groupB);
        }

        /** 그룹 A의 자격 있는 기관, 순위 순. */
        public List<Scored> ranked() {
            return ranked(candidates);
        }

        /** 그룹 B의 자격 있는 기관, 순위 순. */
        public List<Scored> rankedB() {
            return ranked(groupB);
        }

        /** 그룹 B 자격 기준 — 창·구간 수는 blend.groupB, 커버리지는 그룹 A와 같은 값(D27 "같은 커버리지 자격"). */
        public TrackRecord13F.Criteria groupBCriteria() {
            return PaperSelectionService.groupBCriteria(settings, blend);
        }

        private static List<Scored> ranked(List<Scored> scored) {
            return scored.stream().filter(s -> s.rank() != null)
                    .sorted(Comparator.comparingInt(Scored::rank)).toList();
        }
    }

    static TrackRecord13F.Criteria groupBCriteria(TrackRecordSettings track, PaperSettings.Blend blend) {
        return new TrackRecord13F.Criteria(blend.groupBWindowYears(), blend.groupBMinPeriods(),
                track.criteria().minCoverage(), track.criteria().avgCoverage());
    }

    /**
     * 그 기준일의 트랙레코드를 계산해 {@code paper_track_record}에 저장합니다(같은 기준일의 행은 지우고 다시 넣음 — 후보 목록이
     * 줄었으면 빠진 기관의 옛 행이 남지 않게). 후보 목록 저장본이 없으면 아무것도 쓰지 않고 {@code skippedReason}만 돌려줍니다.
     * 다른 계산이 돌고 있으면 끝날 때까지 기다립니다.
     *
     * @throws IllegalStateException 모의 매매 테이블이 없음
     */
    public Computation compute(LocalDate asOf) {
        computing.lock();
        try {
            return computeLocked(asOf);
        } finally {
            computing.unlock();
        }
    }

    private Computation computeLocked(LocalDate asOf) {
        if (asOf == null) {
            throw new IllegalArgumentException("기준일이 없습니다");
        }
        requireReady();
        LocalDate latestQuarter = UsMarketCalendar.latestQuarterEndReselectedBy(asOf);
        // 최신 분기를 받지 못한 기관을 기다리는 끝(QA-175) — 그 분기 재선정일에서 센 세션. 결정 작업은 기준일이 r(따라잡기여도)이라
        // 지금(마지막 완료 세션 = 결정하는 세션)으로 셉니다.
        LocalDate waitUntil = UsMarketCalendar.addTradingDays(UsMarketCalendar.reselectionDay(latestQuarter),
                PENDING_WAIT_TRADING_DAYS);
        boolean waitOver = !UsMarketCalendar.lastCompletedSession(clock.instant()).isBefore(waitUntil);
        Optional<CollectionIndex> index = index();
        // 후보 목록이 없으면 그룹 B도 계산하지 않습니다 — 선정은 그룹 A 없이 남기지 않으므로(그룹 B만으로 선정하지 않음)
        // 그룹 B 행만 남기면 "계산했는데 선정이 없는" 기준일이 생깁니다.
        if (index.isEmpty()) {
            return new Computation(asOf, null, currentSettings(), latestQuarter, List.of(), NO_INDEX_REASON,
                    currentBlend(), List.of(), waitUntil, waitOver);
        }
        // 저장할 행에는 설정 버전이 필요합니다. 초기화 전이면 기본값으로 설정 행을 만듭니다(초기화가 만드는 것과 같은 값).
        SettingsRow row = settingsRow();
        TrackRecordSettings trackSettings = TrackRecordSettings.from(row.body());
        PaperSettings.Blend blend = PaperSettings.Blend.from(row.body());
        if (!trackSettings.fallbacks().isEmpty() || !blend.fallbacks().isEmpty()) {
            List<String> fallbacks = new ArrayList<>(trackSettings.fallbacks());
            fallbacks.addAll(blend.fallbacks());
            log.warn("모의 매매 설정 v{}의 키 {}가 없거나 범위 밖이라 기본값으로 계산합니다", row.version(), fallbacks);
        }
        List<Filer> candidates = index.get().filers().stream()
                .filter(f -> trackSettings.candidateCiks() == null || trackSettings.candidateCiks().contains(f.cik()))
                .toList();
        if (candidates.isEmpty()) {
            return new Computation(asOf, row.version(), trackSettings, latestQuarter, List.of(), NO_CANDIDATE_REASON,
                    blend, List.of(), waitUntil, waitOver);
        }

        // 그룹마다 따로 계산합니다 — 창이 달라 가격 범위가 다르고, 한 그룹의 저장본·가격을 다 쓴 뒤 다음 그룹을 읽어 힙에
        // 두 그룹을 한꺼번에 들지 않게.
        Map<String, String> pool = new HashMap<>();
        List<GroupInput> inputsA = new ArrayList<>();
        for (Filer filer : candidates) {
            inputsA.add(new GroupInput(filer.cik(), filer.name(), filer.style(), stored(filer.cik(), pool)));
        }
        List<Scored> scoredA = score(inputsA, trackSettings.criteria(), trackSettings.metric(), asOf, latestQuarter,
                true, waitOver);
        inputsA.clear();
        List<GroupInput> inputsB = new ArrayList<>();
        for (MenuFiler filer : groupBCandidates()) {
            inputsB.add(new GroupInput(filer.cik(), filer.name(), null, storedGroupB(filer.cik(), pool)));
        }
        TrackRecord13F.Criteria criteriaB = groupBCriteria(trackSettings, blend);
        List<Scored> scoredB = score(inputsB, criteriaB, trackSettings.metric(), asOf, latestQuarter, false,
                waitOver);
        inputsB.clear();

        List<TrackRecordRow> rows = new ArrayList<>();
        for (Scored s : scoredA) {
            rows.add(row(asOf, s, TrackRecordRow.GROUP_A, trackSettings.criteria().windowYears(),
                    trackSettings.metric(), row.version()));
        }
        for (Scored s : scoredB) {
            rows.add(row(asOf, s, TrackRecordRow.GROUP_B, criteriaB.windowYears(), trackSettings.metric(),
                    row.version()));
        }
        store.atomically(() -> {
            store.deleteTrackRecords(asOf, TrackRecordRow.GROUP_A);
            store.deleteTrackRecords(asOf, TrackRecordRow.GROUP_B);
            rows.forEach(store::upsertTrackRecord);
            return null;
        });
        log.info("13F 트랙레코드 계산: 기준일 {}, 그룹 A 후보 {}곳·자격 {}곳, 그룹 B 후보 {}곳·자격 {}곳", asOf, scoredA.size(),
                scoredA.stream().filter(x -> x.rank() != null).count(), scoredB.size(),
                scoredB.stream().filter(x -> x.rank() != null).count());
        return new Computation(asOf, row.version(), trackSettings, latestQuarter, scoredA, null, blend, scoredB,
                waitUntil, waitOver);
    }

    /** 한 그룹의 계산 입력 — 후보 한 곳과 그 저장본. */
    private record GroupInput(String cik, String name, String style, StoredFilings stored) {
    }

    /**
     * 한 그룹의 트랙레코드와 순위. 가격은 그 그룹 창 안 공시의 티커와 SPY를 <b>한 번에</b>, 기준일까지만 읽습니다(룩어헤드 방지).
     * 그룹의 어느 기관에도 공시가 없으면(그룹 B 저장본이 아직 없음 등) 가격을 읽지 않습니다 — 계산할 구간이 없습니다.
     *
     * @param collectingRule 30분기 수집이 끝나지 않은 기관을 "수집 중"으로 자격에서 뺌(그룹 A). 그룹 B는 q8에 완료 표시가 없어
     *                       false — 짧은 저장본은 구간 수 기준이 거릅니다
     * @param waitOver       최신 분기를 받지 못한 기관을 기다리는 끝이 지남 — 사유를 '수집 대기' 대신 '수집 실패로 제외'로(QA-175)
     */
    private List<Scored> score(List<GroupInput> inputs, TrackRecord13F.Criteria criteria, TrackRecord13F.Metric metric,
                               LocalDate asOf, LocalDate latestQuarter, boolean collectingRule, boolean waitOver) {
        LocalDate windowStart = asOf.minusYears(criteria.windowYears());
        Set<String> tickers = new TreeSet<>();
        tickers.add(SPY);
        boolean anyFiling = false;
        for (GroupInput input : inputs) {
            anyFiling |= !input.stored().filings().isEmpty();
            tickers.addAll(windowTickers(input.stored().filings(), asOf, windowStart));
        }
        Map<String, DailySeries> prices = anyFiling
                ? marketData.history(tickers, windowStart.minusDays(PRICE_MARGIN_DAYS), asOf)
                : Map.of();
        DailySeries spy = prices.get(SPY);

        List<Scored> unranked = new ArrayList<>();
        for (GroupInput input : inputs) {
            StoredFilings stored = input.stored();
            Result raw = TrackRecord13F.compute(input.cik(), stored.filings(), prices::get, spy, asOf, criteria);
            boolean collecting = collectingRule && !stored.complete();
            // 공시가 하나도 없으면 사유 "공시 없음"이 이미 모든 것을 말합니다. 최신 분기가 없어도 기한 마감 전에 받은 저장본이면
            // 공시하지 않았는지 아직 받지 못했는지 모릅니다 — R5가 아니라 "수집 대기"(QA-175).
            boolean latestAbsent = raw.lastFilingDate() != null
                    && !filedQuarter(stored.filings(), latestQuarter, asOf);
            boolean pending = latestAbsent && awaitingLatest(stored, latestQuarter, asOf);
            boolean missingLatest = latestAbsent && !pending;
            List<String> reasons = new ArrayList<>();
            if (collecting) {
                reasons.add(COLLECTING_PREFIX + "저장 분기 " + stored.storedQuarters() + "/"
                        + Datasets.TRACK_RECORD_QUARTERS + ")");
            }
            if (missingLatest) {
                reasons.add("최신 분기(" + latestQuarter + ") 공시 없음");
            }
            if (pending) {
                reasons.add("최신 분기(" + latestQuarter + ") " + (waitOver ? "수집 실패로 제외" : "수집 대기")
                        + "(마지막 수집 " + Kst.stamp(stored.collectedAt()) + " — 공시 기한 "
                        + UsMarketCalendar.thirteenFDeadline(latestQuarter) + " EDGAR 마감 전)");
            }
            if (!raw.eligible() && raw.ineligibleReason() != null) {
                reasons.add(raw.ineligibleReason());
            }
            Result result = finite(raw, reasons.isEmpty() && raw.eligible(), String.join("; ", reasons));
            unranked.add(new Scored(input.cik(), input.name(), input.style(), result, null, collecting, missingLatest,
                    pending, stored.storedQuarters(), stored.complete(), stored.source()));
        }

        Map<String, Integer> rankByCik = new HashMap<>();
        for (Ranked ranked : TrackRecord13F.rank(unranked.stream().map(Scored::result).toList(), metric)) {
            rankByCik.put(ranked.result().cik(), ranked.rank());
        }
        return unranked.stream().map(s -> new Scored(s.cik(), s.name(), s.style(), s.result(),
                rankByCik.get(s.cik()), s.collecting(), s.missingLatest(), s.pending(), s.storedQuarters(),
                s.complete(), s.source())).toList();
    }

    /**
     * 자격·사유를 최종값으로 바꾸고, 유한하지 않은 수치는 null로 — 극단적인 짧은 기간의 연율(CAGR)이 넘칠 수 있는데, 그 값을
     * 저장하면 DB가 거절하고(PaperStore) 순위가 무한대에 끌려갑니다.
     */
    private static Result finite(Result r, boolean eligible, String reason) {
        return new Result(r.cik(), r.periodsUsed(), r.periodsTotal(), r.firstFilingDate(), r.lastFilingDate(),
                finite(r.cumReturnPct()), finite(r.cagrPct()), finite(r.volPct()), finite(r.mddPct()),
                finite(r.sharpe()), finite(r.spyCumReturnPct()), finite(r.excessVsSpyPct()), finite(r.coverageMin()),
                finite(r.coverageAvg()), eligible, eligible ? null : reason, r.periods());
    }

    private static Double finite(Double value) {
        return value == null || !Double.isFinite(value) ? null : value;
    }

    private TrackRecordRow row(LocalDate asOf, Scored s, String group, int windowYears, TrackRecord13F.Metric metric,
                               int version) {
        Result r = s.result();
        List<Map<String, Object>> periods = new ArrayList<>();
        for (Period p : r.periods()) {
            Map<String, Object> period = new LinkedHashMap<>();
            period.put("filingDate", text(p.filingDate()));
            period.put("reportDate", text(p.reportDate()));
            period.put("start", text(p.start()));
            period.put("end", text(p.end()));
            period.put("returnPct", finite(p.returnPct()));
            period.put("spyReturnPct", finite(p.spyReturnPct()));
            period.put("coverage", Double.isFinite(p.coverage()) ? p.coverage() : null);
            period.put("coveredTickers", p.coveredTickers());
            period.put("holdings", p.holdings());
            periods.add(period);
        }
        return new TrackRecordRow(asOf, s.cik(), windowYears, metric.name(), r.periodsUsed(), r.periodsTotal(),
                r.firstFilingDate(), r.lastFilingDate(), r.cumReturnPct(), r.cagrPct(), r.volPct(), r.mddPct(),
                r.sharpe(), r.excessVsSpyPct(), r.coverageMin(), r.coverageAvg(), r.eligible(), r.ineligibleReason(),
                s.rank(), mapper.valueToTree(periods), version, null, group, s.source());
    }

    // ------------------------------------------------------------------ 선정
    /**
     * 선정 결과.
     *
     * @param created       이번에 선정을 새로 남겼는가(이미 있었으면 false — 기존 선정 그대로)
     * @param selection     그 기준일의 선정. 계산하지 못했으면 null
     * @param computation   이번에 한 계산. 선정이 이미 있어 계산하지 않았으면 null
     * @param skippedReason 계산하지 못한 이유
     */
    public record SelectionOutcome(LocalDate asOf, boolean created, Selection selection, Computation computation,
                                   String skippedReason) {
    }

    /**
     * 재선정일·초기 선정(설계 §4-3·§6-2): 그 기준일에 선정이 <b>이미 있으면 계산하지 않고 그대로</b> 돌려줍니다(10분마다 도는
     * 결정 작업이 같은 날 다시 불러도 한 번). 없으면 계산하고 그룹 A 자격 상위 {@code trackRecord.topN}곳·그룹 B 자격 상위
     * {@code blend.groupB.topN}곳과 그 신호 풀을 한 행에 남깁니다({@link #draftSelection}) — 자격 기관이 N곳보다 적으면 있는
     * 만큼, 두 그룹 모두 0곳이면 빈 선정(규칙 책은 SHY만). 수집 중인 후보는 자격에서 빠진 채로 선정합니다
     * (설계 §6-4 — 재선정일에 새로 더한 기관 하나가 덜 모였다고 선정을 멈추지 않게).
     *
     * <p>선정을 남기지 않는 경우(모르는 것을 '자격 기관 없음'으로 굳히지 않게 — 같은 기준일은 다시 계산하지 않으므로 한 번 남긴
     * 빈 선정은 다음 재선정일까지 갑니다): ① 후보 목록 저장본이 없음, ② 자격 기관이 0곳인데 수집 중인 후보가 있음 — 처음 기동한
     * 뒤 30분기를 채우는 동안(실행 몇 번)에 불리면 0곳이 기준 미달 때문인지 수집이 덜 끝나서인지 알 수 없습니다. 이때 그룹 B만으로
     * 선정하지도 않습니다 — 그룹 B만의 풀이 다음 재선정일까지 굳습니다. ③ 두 그룹 어디든 최신 분기를 아직 받지 못한 기관
     * ({@link Scored#pending}, 수집 중인 그룹 A 후보는 빼고 셈 — 그 후보는 ②의 규칙대로 빠짐)이 있고 기다리는 끝
     * ({@link Computation#waitUntil}) 전 — SEC 장애·수집 실패가 기한과 재선정일 사이에 겹치면 공시한 기관을 R5로 빼고 석 달을
     * 굳히게 됩니다(QA-175). 끝이 지나면 그 기관을 '수집 실패로 제외'한 채 선정합니다. 트랙레코드 계산은 ②·③에도 저장합니다.
     */
    public SelectionOutcome select(LocalDate asOf) {
        if (asOf == null) {
            throw new IllegalArgumentException("기준일이 없습니다");
        }
        computing.lock();
        try {
            requireReady();
            Optional<Selection> existing = selectionAt(asOf);
            if (existing.isPresent()) {
                return new SelectionOutcome(asOf, false, existing.get(), null, null);
            }
            Computation computation = computeLocked(asOf);
            if (computation.skippedReason() != null) {
                return new SelectionOutcome(asOf, false, null, computation, computation.skippedReason());
            }
            // 두 그룹에 모두 있는 기관(q30을 함께 씀)은 한 번만 셉니다.
            Map<String, Scored> waiting = new LinkedHashMap<>();
            Stream.concat(computation.candidates().stream(), computation.groupB().stream())
                    .filter(s -> s.pending() && !s.collecting()).forEach(s -> waiting.putIfAbsent(s.cik(), s));
            List<Scored> pending = List.copyOf(waiting.values());
            if (!pending.isEmpty() && !computation.waitOver()) {
                String names = pending.stream().limit(5).map(s -> s.name() == null ? s.cik() : s.name())
                        .reduce((a, b) -> a + ", " + b).orElse("") + (pending.size() > 5 ? " …" : "");
                String reason = String.format(Locale.ROOT, PENDING_SKIP_REASON, computation.latestQuarter(),
                        pending.size(), names, UsMarketCalendar.thirteenFDeadline(computation.latestQuarter()),
                        computation.waitUntil());
                log.info("기관 선정 건너뜀: 기준일 {}, {}", asOf, reason);
                return new SelectionOutcome(asOf, false, null, computation, reason);
            }
            if (!pending.isEmpty()) {
                log.warn("기관 선정: 기준일 {}, 최신 분기({})를 {}까지 받지 못한 기관 {}곳을 수집 실패로 빼고 선정합니다", asOf,
                        computation.latestQuarter(), computation.waitUntil(), pending.size());
            }
            List<Scored> ranked = computation.ranked();
            long collecting = computation.candidates().stream().filter(Scored::collecting).count();
            if (ranked.isEmpty() && collecting > 0) {
                String reason = String.format(Locale.ROOT, COLLECTING_SKIP_REASON, collecting,
                        computation.candidates().size());
                log.info("기관 선정 건너뜀: 기준일 {}, {}", asOf, reason);
                return new SelectionOutcome(asOf, false, null, computation, reason);
            }
            boolean created = store.insertSelectionIfAbsent(draftSelection(computation));
            Selection saved = selectionAt(asOf).orElseThrow(() -> new IllegalStateException(
                    "선정을 남겼는데 다시 읽지 못했습니다: " + asOf));
            log.info("기관 선정 {}: 기준일 {}, 신호 풀 {}", created ? "기록" : "이미 있음", asOf, saved.selectedCiks());
            return new SelectionOutcome(asOf, created, saved, computation, null);
        } finally {
            computing.unlock();
        }
    }

    /**
     * 계산 하나로 만든 선정 행(저장하지 않음) — {@link #select}가 남기는 것과 같은 모양이라 "시작" 미리보기도 이것을 씁니다.
     *
     * <p>{@code selected_ciks} = 신호 풀(그룹 A 순서 뒤에 그룹 B에만 있는 기관 — {@link Signal13F#blendWeights}의 순서),
     * {@code ranking} = {@code {groupA:[…], groupB:[…], pool:[{cik, name, groups, rankA, rankB, weight}], groupWeightA}}.
     * groupA·groupB는 그 그룹의 자격 기관 전부(순위 순, {@code selected}가 그 그룹 선정)이고, pool의 weight는 기관 가중(합 1)을
     * 반올림하지 않은 값입니다 — 규칙 책이 다시 계산하지 않고 이 값으로 점수를 냅니다(설정이 바뀌어도 그 선정의 가중은 그대로).
     *
     * @throws IllegalArgumentException 계산을 건너뛴 결과(skippedReason)
     */
    public Selection draftSelection(Computation computation) {
        if (computation.skippedReason() != null) {
            throw new IllegalArgumentException("계산하지 못한 결과로는 선정을 만들 수 없습니다: " + computation.skippedReason());
        }
        List<Scored> rankedA = computation.ranked();
        List<Scored> rankedB = computation.rankedB();
        List<Scored> topA = rankedA.stream().limit(computation.settings().topN()).toList();
        List<Scored> topB = rankedB.stream().limit(computation.blend().groupBTopN()).toList();
        List<String> ciksA = topA.stream().map(Scored::cik).toList();
        List<String> ciksB = topB.stream().map(Scored::cik).toList();
        double g = computation.blend().groupWeightA();
        Map<String, Double> weights = Signal13F.blendWeights(ciksA, ciksB, g);

        String metric = computation.settings().metric().name();
        Map<String, String> names = new HashMap<>();
        topB.forEach(s -> names.put(s.cik(), s.name()));
        topA.forEach(s -> names.put(s.cik(), s.name()));   // 두 그룹에 모두 있으면 그룹 A(후보 목록)의 이름
        List<Map<String, Object>> pool = new ArrayList<>();
        for (Map.Entry<String, Double> entry : weights.entrySet()) {
            int a = ciksA.indexOf(entry.getKey());
            int b = ciksB.indexOf(entry.getKey());
            List<String> groups = new ArrayList<>(2);
            if (a >= 0) {
                groups.add(TrackRecordRow.GROUP_A);
            }
            if (b >= 0) {
                groups.add(TrackRecordRow.GROUP_B);
            }
            Map<String, Object> member = new LinkedHashMap<>();
            member.put("cik", entry.getKey());
            member.put("name", names.get(entry.getKey()));
            member.put("groups", groups);
            member.put("rankA", a >= 0 ? topA.get(a).rank() : null);
            member.put("rankB", b >= 0 ? topB.get(b).rank() : null);
            member.put("weight", entry.getValue());
            pool.add(member);
        }
        Map<String, Object> ranking = new LinkedHashMap<>();
        ranking.put("groupA", rankingRows(rankedA, ciksA, metric, false));
        ranking.put("groupB", rankingRows(rankedB, ciksB, metric, true));
        ranking.put("pool", pool);
        ranking.put("groupWeightA", g);
        return new Selection(computation.asOf(), List.copyOf(weights.keySet()), mapper.valueToTree(ranking),
                computation.settingsVersion(), null);
    }

    private static List<Map<String, Object>> rankingRows(List<Scored> ranked, List<String> selected, String metric,
                                                         boolean withSource) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Scored s : ranked) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("cik", s.cik());
            entry.put("name", s.name());
            entry.put("rank", s.rank());
            entry.put("metric", metric);
            entry.put("metricValue", metricValue(s.result(), metric));
            entry.put("cagrPct", s.result().cagrPct());
            entry.put("excessVsSpyPct", s.result().excessVsSpyPct());
            entry.put("sharpe", s.result().sharpe());
            if (withSource) {
                entry.put("source", s.source());
            }
            entry.put("selected", selected.contains(s.cik()));
            out.add(entry);
        }
        return out;
    }

    private static Double metricValue(Result r, String metric) {
        return switch (TrackRecord13F.Metric.valueOf(metric)) {
            case CAGR -> r.cagrPct();
            case EXCESS_VS_SPY -> r.excessVsSpyPct();
            case SHARPE -> r.sharpe();
        };
    }

    // ------------------------------------------------------------------ 신호 풀 읽기
    /** 선정 순위표 한 줄(그룹 하나). 이름·순위를 모르면 null. */
    public record RankedFiler(String cik, String name, Integer rank, boolean selected) {
    }

    /**
     * 신호 풀 기관 하나(D27).
     *
     * @param groups 든 그룹("A"·"B", 둘 다면 둘)
     * @param rankA  그룹 A 순위(없으면 null)
     * @param rankB  그룹 B 순위(없으면 null)
     * @param weight 기관 가중(풀 합 1, 0 이상)
     */
    public record PoolMember(String cik, String name, List<String> groups, Integer rankA, Integer rankB,
                             double weight) {
        public PoolMember {
            groups = List.copyOf(groups);
        }
    }

    /**
     * 선정 한 행을 읽은 것 — 두 그룹의 순위표와 신호 풀(풀 순서).
     *
     * @param groupWeightA 선정 때의 g. 섞기 전 선정이면 null
     * @param legacy       D27 이전 모양(순위표가 배열 — 그룹 A만)
     * @param notes        읽다가 뺀 것(가중을 모르는 풀 기관 등)
     */
    public record SignalPool(List<RankedFiler> groupA, List<RankedFiler> groupB, List<PoolMember> members,
                             Double groupWeightA, boolean legacy, List<String> notes) {
        public SignalPool {
            groupA = List.copyOf(groupA);
            groupB = List.copyOf(groupB);
            members = List.copyOf(members);
            notes = List.copyOf(notes);
        }

        public List<RankedFiler> selectedA() {
            return groupA.stream().filter(RankedFiler::selected).toList();
        }

        public List<RankedFiler> selectedB() {
            return groupB.stream().filter(RankedFiler::selected).toList();
        }
    }

    /**
     * 선정 행 → 두 그룹과 신호 풀(규칙 책·개요·조회가 같은 해석을 쓰게 한 곳에). 가중은 행에 남은 값 그대로입니다(다시 계산하지
     * 않음 — 설계 §4-1, 단계 2 계약 E).
     *
     * <p>D27 이전에 남긴 행(순위표가 배열, 선정 = 그룹 A)은 그룹 A만의 풀로 읽고, 가중은 선정 순서의 그룹 A 순위 가중
     * ({@link Signal13F#blendWeights}에 그룹 B 없음)으로 매깁니다 — 그 행에는 가중이 없고, 그룹 A만이면 섞기 규칙의 답이 그것입니다.
     * 풀의 가중이 숫자가 아니거나 음수인 기관은 신호에서 빼고 notes에 남깁니다(모르는 가중을 0이나 임의 값으로 넣지 않음).
     */
    public static SignalPool signalPool(Selection selection) {
        JsonNode ranking = selection.ranking();
        List<String> notes = new ArrayList<>();
        if (ranking != null && ranking.isObject() && Json.child(ranking, "pool") != null) {
            List<PoolMember> members = new ArrayList<>();
            Set<String> seen = new LinkedHashSet<>();
            for (JsonNode node : Json.array(ranking, "pool")) {
                String cik = Json.asText(node, "cik");
                Double weight = Json.asDouble(node, "weight");
                if (cik == null || cik.isBlank() || !seen.add(cik)) {
                    continue;
                }
                if (weight == null || !Double.isFinite(weight) || weight < 0) {
                    notes.add(cik + ": 선정 행에 기관 가중이 없어 신호에서 뺌");
                    continue;
                }
                List<String> groups = new ArrayList<>();
                for (JsonNode group : Json.array(node, "groups")) {
                    if (group.isString()) {
                        groups.add(group.asString(""));
                    }
                }
                members.add(new PoolMember(cik, Json.asText(node, "name"), groups, integer(node, "rankA"),
                        integer(node, "rankB"), weight));
            }
            return new SignalPool(rankedFilers(Json.array(ranking, "groupA")),
                    rankedFilers(Json.array(ranking, "groupB")), members, Json.asDouble(ranking, "groupWeightA"),
                    false, notes);
        }
        // D27 이전 모양 — 순위표 배열(또는 없음), 선정 = 그룹 A.
        Map<String, JsonNode> byCik = new HashMap<>();
        List<JsonNode> entries = new ArrayList<>();
        if (ranking != null && ranking.isArray()) {
            ranking.forEach(entries::add);
        }
        for (JsonNode entry : entries) {
            String cik = Json.asText(entry, "cik");
            if (cik != null) {
                byCik.putIfAbsent(cik, entry);
            }
        }
        List<RankedFiler> groupA = new ArrayList<>();
        for (JsonNode entry : entries) {
            String cik = Json.asText(entry, "cik");
            if (cik != null) {
                groupA.add(new RankedFiler(cik, Json.asText(entry, "name"), integer(entry, "rank"),
                        selection.selectedCiks().contains(cik)));
            }
        }
        // 가중은 선정 순서(= 그 행의 순위 순)로 매기고, 순위표에 없는 CIK의 이름·순위는 지어내지 않고 null로 둡니다.
        Map<String, Double> weights = Signal13F.blendWeights(selection.selectedCiks(), List.of(), 1.0);
        List<PoolMember> members = new ArrayList<>();
        for (Map.Entry<String, Double> entry : weights.entrySet()) {
            JsonNode known = byCik.get(entry.getKey());
            Integer rank = known == null ? null : integer(known, "rank");
            if (known == null) {
                groupA.add(new RankedFiler(entry.getKey(), null, null, true));
            }
            members.add(new PoolMember(entry.getKey(), known == null ? null : Json.asText(known, "name"),
                    List.of(TrackRecordRow.GROUP_A), rank, null, entry.getValue()));
        }
        if (!members.isEmpty()) {
            notes.add("그룹 섞기(D27) 전에 남긴 선정 — 그룹 B 없이 그룹 A 순위 가중으로 읽음");
        }
        return new SignalPool(groupA, List.of(), members, null, true, notes);
    }

    private static List<RankedFiler> rankedFilers(List<JsonNode> entries) {
        List<RankedFiler> out = new ArrayList<>();
        for (JsonNode entry : entries) {
            String cik = Json.asText(entry, "cik");
            if (cik != null) {
                out.add(new RankedFiler(cik, Json.asText(entry, "name"), integer(entry, "rank"),
                        Json.asBoolean(entry, "selected")));
            }
        }
        return out;
    }

    private static Integer integer(JsonNode node, String field) {
        Double value = Json.asDouble(node, field);
        return value == null ? null : value.intValue();
    }

    /** 가장 최근 선정. 없으면 empty. */
    public Optional<Selection> latestSelection() {
        if (!store.ready()) {
            return Optional.empty();
        }
        return store.selections().stream().findFirst();
    }

    /** 그날 유효한 선정(그날 이하 가장 최근 선정). 없으면 empty. */
    public Optional<Selection> selectionOn(LocalDate date) {
        if (date == null || !store.ready()) {
            return Optional.empty();
        }
        return store.selectionOnOrBefore(date);
    }

    private Optional<Selection> selectionAt(LocalDate asOf) {
        return store.selectionOnOrBefore(asOf).filter(s -> s.asOfDate().equals(asOf));
    }

    // ------------------------------------------------------------------ HTTP
    /**
     * POST /api/paper/run/rerank — 수동 재계산. 그 기준일의 트랙레코드를 두 그룹 모두 덮어쓰고 <b>선정은 바꾸지 않습니다</b>
     * (기록용, 설계 §6-4). 기준일이 없으면 마지막 완료 세션. 끝나지 않은 세션(장중의 오늘·미래)은 그날 종가가 아직 없거나 장중
     * 값이라 400. {@code computed}·{@code eligible}·{@code collecting}은 그룹 A, 그룹 B는 {@code groupB:{computed, eligible}}.
     *
     * @throws TooManyRequestsException 다른 계산이 돌고 있음(429)
     */
    public Map<String, Object> rerank(String asOfText) {
        if (!store.ready()) {
            Map<String, Object> out = notReady();
            out.put("ok", false);
            return out;
        }
        LocalDate session = UsMarketCalendar.lastCompletedSession(clock.instant());
        LocalDate asOf = Params.optionalDate("asOf", asOfText);
        if (asOf == null) {
            asOf = session;
        }
        LocalDate lastTradingDay = UsMarketCalendar.isTradingDay(asOf) ? asOf
                : UsMarketCalendar.previousTradingDay(asOf);
        if (lastTradingDay.isAfter(session)) {
            throw new InvalidRequestException("asOf는 끝난 세션까지만 됩니다(마지막 완료 세션 " + session + "): "
                    + Params.echo(asOfText));
        }
        if (!computing.tryLock()) {
            throw new TooManyRequestsException("트랙레코드를 이미 계산하고 있습니다 — 끝난 뒤 다시 누르세요.", BUSY_RETRY);
        }
        Computation computation;
        try {
            computation = computeLocked(asOf);
        } finally {
            computing.unlock();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("asOfDate", asOf.toString());
        out.put("computed", computation.candidates().size());
        out.put("eligible", computation.ranked().size());
        out.put("collecting", (int) computation.candidates().stream().filter(Scored::collecting).count());
        Map<String, Object> groupB = new LinkedHashMap<>();
        groupB.put("computed", computation.groupB().size());
        groupB.put("eligible", computation.rankedB().size());
        out.put("groupB", groupB);
        out.put("selectedUnchanged", true);
        out.put("skippedReason", computation.skippedReason());
        return out;
    }

    /**
     * GET /api/paper/track-record?asOf= — 그 기준일(없으면 그룹 A를 가장 최근에 계산한 기준일)의 트랙레코드·순위·선정·수집
     * 진행률. 계산이 없으면 {@code computed:false}와 수집 진행률. 계산하지 않고 저장된 결과만 읽습니다.
     *
     * <p>위쪽 {@code candidates}·{@code selected}는 그룹 A, {@code groupB}는 그룹 B(D27 — 같은 모양 + 출처 {@code source}·메뉴 설명
     * {@code desc}), {@code pool}은 그 기준일에 유효한 선정의 신호 풀(가중 포함)입니다.
     */
    public Map<String, Object> trackRecord(String asOfText) {
        if (!store.ready()) {
            return notReady();
        }
        LocalDate requested = Params.optionalDate("asOf", asOfText);
        Optional<CollectionIndex> index = index();
        LocalDate asOf = requested != null ? requested : store.latestTrackRecordAsOf().orElse(null);
        List<TrackRecordRow> rows = asOf == null ? List.of() : store.trackRecords(asOf);
        List<TrackRecordRow> rowsB = asOf == null ? List.of() : store.trackRecords(asOf, TrackRecordRow.GROUP_B);
        Optional<Selection> effective = asOf == null ? Optional.empty() : store.selectionOnOrBefore(asOf);
        Optional<SignalPool> pool = effective.map(PaperSelectionService::signalPool);
        List<String> selected = pool.map(p -> p.selectedA().stream().map(RankedFiler::cik).toList()).orElse(List.of());
        List<String> selectedB = pool.map(p -> p.selectedB().stream().map(RankedFiler::cik).toList())
                .orElse(List.of());

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        out.put("computed", !rows.isEmpty());
        out.put("asOfDate", text(asOf));
        // 계산했으면 그때의 창·기준·설정, 아직이면 지금 설정(다음 계산이 쓸 값).
        TrackRecordSettings used = rows.isEmpty() ? currentSettings() : settingsOf(rows.get(0).settingsVersion());
        out.put("windowYears", rows.isEmpty() ? used.criteria().windowYears() : rows.get(0).windowYears());
        out.put("metric", rows.isEmpty() ? used.metric().name() : rows.get(0).metric());
        out.put("criteria", criteria(used.criteria()));
        out.put("settingsVersion", rows.isEmpty() ? null : rows.get(0).settingsVersion());
        out.put("computedAtKst", rows.isEmpty() ? null : stamp(rows.get(0).computedAt()));
        out.put("candidates", candidates(rows, index, selected));
        out.put("selected", selected);
        out.put("selectedAsOfDate", effective.map(s -> s.asOfDate().toString()).orElse(null));

        // 그룹 B — 기준은 계산 때 설정(행이 없으면 지금 설정), 이름·설명은 지금 메뉴 목록 값.
        Integer versionB = rowsB.isEmpty() ? null : rowsB.get(0).settingsVersion();
        TrackRecordSettings usedB = versionB == null ? currentSettings() : settingsOf(versionB);
        PaperSettings.Blend blendB = versionB == null ? currentBlend() : blendOf(versionB);
        TrackRecord13F.Criteria criteriaB = groupBCriteria(usedB, blendB);
        Map<String, Object> groupB = new LinkedHashMap<>();
        groupB.put("computed", !rowsB.isEmpty());
        groupB.put("windowYears", rowsB.isEmpty() ? criteriaB.windowYears() : rowsB.get(0).windowYears());
        groupB.put("minPeriods", criteriaB.minPeriods());
        groupB.put("metric", rowsB.isEmpty() ? usedB.metric().name() : rowsB.get(0).metric());
        groupB.put("criteria", criteria(criteriaB));
        groupB.put("topN", blendB.groupBTopN());
        groupB.put("candidates", groupBCandidates(rowsB, index, selectedB));
        groupB.put("selected", selectedB);
        out.put("groupB", groupB);
        out.put("pool", pool.map(p -> poolView(p.members())).orElse(List.of()));
        out.put("groupWeightA", pool.map(SignalPool::groupWeightA).orElse(null));

        List<Map<String, Object>> history = new ArrayList<>();
        for (Selection selection : store.selections()) {
            SignalPool past = signalPool(selection);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("asOfDate", selection.asOfDate().toString());
            entry.put("selectedCiks", selection.selectedCiks());
            entry.put("groupA", past.selectedA().stream().map(RankedFiler::cik).toList());
            entry.put("groupB", past.selectedB().stream().map(RankedFiler::cik).toList());
            history.add(entry);
        }
        out.put("selectionHistory", history);
        out.put("collection", collection(index));
        out.put("limits", LIMITS);
        return out;
    }

    /**
     * 후보 행. 순위가 있는 기관을 순위 순으로, 나머지는 수집 목록 순(스타일별)으로. 이름·스타일·저장 분기·완료 여부는 지금의
     * 수집 목록 값입니다(진행률은 계산 뒤에도 움직이므로) — 목록에서 빠진 기관이면 null·false.
     */
    private List<Map<String, Object>> candidates(List<TrackRecordRow> rows, Optional<CollectionIndex> index,
                                                 List<String> selected) {
        Map<String, Filer> filers = new LinkedHashMap<>();
        index.ifPresent(i -> i.filers().forEach(f -> filers.put(f.cik(), f)));
        List<String> order = new ArrayList<>(filers.keySet());
        List<TrackRecordRow> sorted = new ArrayList<>(rows);
        sorted.sort(Comparator.comparing(TrackRecordRow::rank, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparingInt(r -> order.contains(r.cik()) ? order.indexOf(r.cik()) : Integer.MAX_VALUE)
                .thenComparing(TrackRecordRow::cik));
        List<Map<String, Object>> out = new ArrayList<>();
        for (TrackRecordRow r : sorted) {
            Filer filer = filers.get(r.cik());
            Map<String, Object> row = candidateRow(r, selected);
            row.put("name", filer == null ? null : filer.name());
            row.put("style", filer == null ? null : filer.style());
            row.put("storedQuarters", filer == null ? null : filer.storedQuarters());
            row.put("complete", filer != null && filer.complete());
            out.add(row);
        }
        return out;
    }

    /** 후보 행의 공통 칸(두 그룹 같은 모양). 이름·스타일·저장 분기·완료 여부는 그룹마다 부르는 쪽이 채웁니다(자리만 잡음). */
    private static Map<String, Object> candidateRow(TrackRecordRow r, List<String> selected) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("cik", r.cik());
        row.put("name", null);
        row.put("style", null);
        row.put("rank", r.rank());
        row.put("eligible", r.eligible());
        row.put("ineligibleReason", r.ineligibleReason());
        row.put("collecting", r.ineligibleReason() != null && r.ineligibleReason().startsWith(COLLECTING_PREFIX));
        row.put("cagrPct", PaperQueryService.round2(r.cagrPct()));
        row.put("cumReturnPct", PaperQueryService.round2(r.cumReturnPct()));
        // SPY 누적은 열이 없어 초과(= 누적 − SPY 누적)에서 되돌립니다. 둘 중 하나라도 없으면 null.
        row.put("spyCumReturnPct", r.cumReturnPct() == null || r.excessVsSpyPct() == null ? null
                : PaperQueryService.round2(r.cumReturnPct() - r.excessVsSpyPct()));
        row.put("excessVsSpyPct", PaperQueryService.round2(r.excessVsSpyPct()));
        row.put("volPct", PaperQueryService.round2(r.volPct()));
        row.put("mddPct", PaperQueryService.round2(r.mddPct()));
        row.put("sharpe", PaperQueryService.round2(r.sharpe()));
        row.put("periodsUsed", r.periodsUsed());
        row.put("periodsTotal", r.periodsTotal());
        row.put("coverageMin", PaperQueryService.round4(r.coverageMin()));
        row.put("coverageAvg", PaperQueryService.round4(r.coverageAvg()));
        row.put("firstFilingDate", text(r.firstFilingDate()));
        row.put("lastFilingDate", text(r.lastFilingDate()));
        row.put("storedQuarters", null);
        row.put("complete", false);
        row.put("selected", selected.contains(r.cik()));
        row.put("periods", periods(r.periods()));
        return row;
    }

    /**
     * 그룹 B 후보 행 — 그룹 A 행과 같은 모양에 출처({@code source}, 계산 때 쓴 저장본)·메뉴 설명({@code desc})을 더합니다.
     * 순위 순, 나머지는 메뉴 순. 이름·설명은 지금 메뉴 목록 값, 저장 분기·완료 여부는 q30 기관만 지금 수집 목록 값(q8은 null·false —
     * 기존 메뉴 수집에는 완료 표시가 없음). 그룹 B에는 "수집 중" 규칙이 없어 {@code collecting}은 늘 false입니다.
     */
    private List<Map<String, Object>> groupBCandidates(List<TrackRecordRow> rows, Optional<CollectionIndex> index,
                                                       List<String> selected) {
        Map<String, Filer> filers = new LinkedHashMap<>();
        index.ifPresent(i -> i.filers().forEach(f -> filers.put(f.cik(), f)));
        Map<String, MenuFiler> menu = new LinkedHashMap<>();
        groupBCandidates().forEach(f -> menu.put(f.cik(), f));
        List<String> order = new ArrayList<>(menu.keySet());
        List<TrackRecordRow> sorted = new ArrayList<>(rows);
        sorted.sort(Comparator.comparing(TrackRecordRow::rank, Comparator.nullsLast(Comparator.naturalOrder()))
                .thenComparingInt(r -> order.contains(r.cik()) ? order.indexOf(r.cik()) : Integer.MAX_VALUE)
                .thenComparing(TrackRecordRow::cik));
        List<Map<String, Object>> out = new ArrayList<>();
        for (TrackRecordRow r : sorted) {
            Map<String, Object> row = candidateRow(r, selected);
            MenuFiler entry = menu.get(r.cik());
            Filer collected = TrackRecordRow.SOURCE_Q30.equals(r.dataSource()) ? filers.get(r.cik()) : null;
            row.put("name", entry == null ? null : entry.name());
            row.put("style", null);
            row.put("collecting", false);
            row.put("storedQuarters", collected == null ? null : collected.storedQuarters());
            row.put("complete", collected != null && collected.complete());
            row.put("source", r.dataSource());
            row.put("desc", entry == null ? null : entry.desc());
            out.add(row);
        }
        return out;
    }

    /** 신호 풀 응답 — 가중은 반올림하지 않은 값(0~1, 합 1). */
    static List<Map<String, Object>> poolView(List<PoolMember> members) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (PoolMember m : members) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("cik", m.cik());
            row.put("name", m.name());
            row.put("groups", m.groups());
            row.put("rankA", m.rankA());
            row.put("rankB", m.rankB());
            row.put("weight", m.weight());
            out.add(row);
        }
        return out;
    }

    /** 저장한 구간 JSON → 응답(수익률 2자리, 커버리지 4자리 — 0~1 비율). */
    private static List<Map<String, Object>> periods(JsonNode stored) {
        List<Map<String, Object>> out = new ArrayList<>();
        if (stored == null || !stored.isArray()) {
            return out;
        }
        for (JsonNode p : stored) {
            Map<String, Object> period = new LinkedHashMap<>();
            period.put("filingDate", Json.asText(p, "filingDate"));
            period.put("reportDate", Json.asText(p, "reportDate"));
            period.put("start", Json.asText(p, "start"));
            period.put("end", Json.asText(p, "end"));
            period.put("returnPct", PaperQueryService.round2(Json.asDouble(p, "returnPct")));
            period.put("spyReturnPct", PaperQueryService.round2(Json.asDouble(p, "spyReturnPct")));
            period.put("coverage", PaperQueryService.round4(Json.asDouble(p, "coverage")));
            Double covered = Json.asDouble(p, "coveredTickers");
            Double holdings = Json.asDouble(p, "holdings");
            period.put("coveredTickers", covered == null ? null : covered.intValue());
            period.put("holdings", holdings == null ? null : holdings.intValue());
            out.add(period);
        }
        return out;
    }

    /** 수집 진행률. 후보 목록 저장본이 없으면 null. */
    private static Map<String, Object> collection(Optional<CollectionIndex> index) {
        if (index.isEmpty()) {
            return null;
        }
        CollectionIndex i = index.get();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("filers", i.filers().size());
        out.put("completeCount", (int) i.filers().stream().filter(Filer::complete).count());
        out.put("storedFilings", i.filers().stream().mapToInt(Filer::storedQuarters).sum());
        out.put("targetFilings", i.filers().size() * i.targetQuarters());
        out.put("targetQuarters", i.targetQuarters());
        out.put("updatedAtKst", stamp(i.collectedAt()));
        return out;
    }

    private static Map<String, Object> criteria(TrackRecord13F.Criteria c) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("windowYears", c.windowYears());
        out.put("minPeriods", c.minPeriods());
        out.put("minCoverage", c.minCoverage());
        out.put("avgCoverage", c.avgCoverage());
        return out;
    }

    // ------------------------------------------------------------------ 조각
    private void requireReady() {
        if (!store.ready()) {
            throw new IllegalStateException(PaperQueryService.NOT_READY_MESSAGE);
        }
    }

    private Map<String, Object> notReady() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", false);
        out.put("message", PaperQueryService.NOT_READY_MESSAGE);
        return out;
    }

    /** 설정 행(없으면 기본값으로 만듦 — {@link PaperSettingsService#ensureInitialized}). */
    private SettingsRow settingsRow() {
        Optional<SettingsRow> row = store.settings();
        if (row.isPresent()) {
            return row.get();
        }
        settings.ensureInitialized();
        return store.settings().orElseThrow(() -> new IllegalStateException("모의 매매 설정 행을 만들지 못했습니다"));
    }

    /** 지금 설정의 트랙레코드 값(쓰지 않음 — 행이 없으면 기본값). */
    private TrackRecordSettings currentSettings() {
        return store.settings().map(row -> TrackRecordSettings.from(row.body()))
                .orElseGet(() -> TrackRecordSettings.from(settings.defaultsJson()));
    }

    /** 그 버전의 설정(이력). 이력에 없으면 지금 설정. */
    private TrackRecordSettings settingsOf(int version) {
        return store.settingsAt(version).map(row -> TrackRecordSettings.from(row.body()))
                .orElseGet(this::currentSettings);
    }

    /** 지금 설정의 섞기 값(쓰지 않음 — 행이 없으면 기본값). */
    private PaperSettings.Blend currentBlend() {
        return store.settings().map(row -> PaperSettings.Blend.from(row.body()))
                .orElseGet(PaperSettings.Blend::defaults);
    }

    /** 그 버전의 섞기 값(이력). 이력에 없으면 지금 설정. */
    private PaperSettings.Blend blendOf(int version) {
        return store.settingsAt(version).map(row -> PaperSettings.Blend.from(row.body()))
                .orElseGet(this::currentBlend);
    }

    private static String text(LocalDate date) {
        return date == null ? null : date.toString();
    }

    private static String stamp(Instant moment) {
        return moment == null ? null : Kst.stamp(moment);
    }
}
