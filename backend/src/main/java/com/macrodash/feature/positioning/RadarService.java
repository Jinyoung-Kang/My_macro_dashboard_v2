package com.macrodash.feature.positioning;

import com.macrodash.Kst;
import com.macrodash.analytics.SupplyConsensus;
import com.macrodash.collector.CollectorClient;
import com.macrodash.config.AppProperties;
import com.macrodash.read.StoreReader;
import com.macrodash.store.Datasets;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.FlowJson;
import com.macrodash.support.Json;
import com.macrodash.support.Params;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * 외국인/기관 수급 레이더.
 *
 * <p>수집 순서는 수집기가 관리합니다(KIS → Daum → Naver → KRX 확정 저장본 → 토스 → 누적 이력 — PyKrx·LS는 2026-11-11에 뺌, ADR 0035·0036).
 * 백엔드는 저장본을 읽고, 필요하면 수집을 요청하며, <b>어느 출처가 실제로
 * 성공했는지</b>와 <b>이력 대체 여부</b>를 화면에 그대로 전달합니다.
 *
 * <p>이력 대체(isHistorical=true)는 "지금 시점의 수급이 아니다"라는 뜻이라
 * 화면이 반드시 날짜와 함께 경고해야 합니다.
 */
@Service
public class RadarService {

    public static final List<String> MARKETS = List.of("KOSPI", "KOSDAQ");
    public static final List<String> INVESTORS =
            List.of("외국인", "기관", "개인", "연기금", "금융투자", "투신");

    /**
     * 지금 실제로 받을 수 있는 투자주체.
     *
     * <p>Daum API는 {@code investorType=FOREIGN|INSTITUTION} 두 가지만 받습니다.
     * 나머지 넷(개인·연기금·금융투자·투신)은 Naver가 담당했는데, Naver가 그
     * 페이지를 폐지했습니다(HTTP 410). 새 화면의 API(stock.naver.com)도 외국인·기관만 주고(ADR 0035),
     * 그 밖의 경로였던 LS·KRX(pykrx)는 2026-11-11에 뺐습니다.
     *
     * <p>목록에서 아예 빼지 않는 이유 — 원래 있던 기능이고 소스가 복구되면
     * 다시 됩니다. 고를 수만 없게 하고 <b>왜 안 되는지</b>를 함께 보여 줍니다.
     * 고르게 두면 "수급 데이터를 얻지 못했습니다"만 보게 됩니다.
     */
    public static final List<String> SUPPORTED_INVESTORS = List.of("외국인", "기관");

    /** KRX 확정 순위가 있을 때의 안내 — 장중에는 앞 거래일, 거래일 저녁(18:30 뒤)에 그날 것이 들어옵니다. */
    static final String KRX_INVESTOR_NOTE = "개인·연기금·금융투자·투신은 KRX 정보데이터시스템의 전 종목 확정 순위입니다 — 장중에는 앞 거래일 값이고 "
            + "거래일 저녁에 그날 것이 들어옵니다(외국인·기관은 Daum 장중 값이 먼저).";

    /** 지원하지 않는 투자주체를 고르려 할 때 화면에 적을 이유. */
    public static final String UNSUPPORTED_INVESTOR_NOTE =
            "Daum이 제공하지 않는 투자주체입니다. 이 넷을 담당하던 Naver가 페이지를 "
                    + "폐지해(HTTP 410) 현재 받을 수 있는 소스가 없습니다.";
    /** 토스 폴백이 준비됐을 때 — 넷은 토스 공식 데이터로만 받습니다. 한계를 함께 적습니다. */
    public static final String TOSS_ONLY_INVESTOR_NOTE =
            "개인·연기금·금융투자·투신은 토스증권 공식 데이터로 만든 순위입니다 — 시장 전체가 아니라 "
                    + "거래대금 상위 100종목 안의 순위이고, 금액은 순매수 주식 수 × 현재가로 추정합니다. "
                    + "당일 잠정치에는 이 넷이 없어 전 거래일 확정치를 씁니다(1시간마다 갱신).";
    /** 토스 폴백 저장본을 쓸 수 있는 최대 경과 시간 (수집기 radar.TOSS_UNIVERSE_MAX_AGE_HOURS와 같게). */
    static final long TOSS_UNIVERSE_MAX_AGE_SECONDS = 26 * 60 * 60L;
    public static final List<String> TRADE_TYPES = List.of("순매수", "순매도");
    public static final List<String> INTERVALS = List.of("TODAY", "DAYS_5", "DAYS_20");
    /**
     * 누적 이력 전 기간 모드(latest=false)가 한 번에 주는 최대 행 수 (QA-133).
     *
     * <p>이력은 거래일마다 약 100행씩 끝없이 늘어, 상한이 없으면 응답도 저장된 기간만큼 커집니다
     * (2026-10-19 QA 스택: 13거래일 1,350행·492KB). 화면은 latest=true만 쓰고 전 기간은 내려받아 살펴보는 용도라 최신 5,000행
     * (약 50거래일)이면 됩니다. 더 오래된 날은 {@code obsDate}(또는 {@code latest=true&obsDate=})로 하루씩 받습니다.
     * 행 단위로 자르므로 잘린 응답({@code truncated})의 가장 오래된 날은 일부 행만 담겼을 수 있습니다 — 그날도 obsDate로 다시 받습니다.
     */
    static final int HISTORY_ROW_LIMIT = 5_000;

    /**
     * 수집기 {@code radar_rankings} 태스크가 주기적으로 다시 받는 조합(시장·투자주체·방향·기간) — 수집기
     * {@code app/tasks/base.py}의 {@code RADAR_COMBINATIONS}와 같아야 합니다({@code RadarScheduledCombinationsParityTest}가 대조).
     *
     * <p>이 밖의 조합은 저장본을 다시 쓰는 태스크가 없습니다. 저장본을 먼저 돌려주면 처음 한 번 받은 값이 그대로 남으므로(QA-395)
     * 조회할 때마다 지금 받고, 저장본은 지금 받기가 실패했을 때만 씁니다.
     */
    static final List<List<String>> SCHEDULED_COMBINATIONS = List.of(
            List.of("KOSPI", "외국인", "순매수", "TODAY"),
            List.of("KOSPI", "기관", "순매수", "TODAY"),
            List.of("KOSPI", "외국인", "순매도", "TODAY"));

    private final StoreReader store;
    private final StoreRepository repository;
    private final CollectorClient collector;

    public RadarService(StoreReader store, StoreRepository repository, CollectorClient collector) {
        this.store = store;
        this.repository = repository;
        this.collector = collector;
    }

    /**
     * 레이더 선택지.
     *
     * <p>고를 수 있는 투자주체는 <b>실제로 받을 수 있는지</b>에 따라 달라집니다. 토스 폴백
     * 저장본(거래대금 상위 100종목의 투자자 매매)이 있으면 여섯 모두, 없으면 Daum이 주는 둘만.
     */
    public Map<String, Object> options() {
        boolean tossReady = store.readStored(Datasets.SNAP_TOSS_RADAR_UNIVERSE)
                .filter(snapshot -> snapshot.payload() != null)
                .filter(snapshot -> snapshot.isFresh(TOSS_UNIVERSE_MAX_AGE_SECONDS))
                .isPresent();
        boolean krxReady = krxRecent();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("markets", MARKETS);
        out.put("investors", INVESTORS);
        // 화면이 "지원 안 함"을 표시할 수 있도록 함께 내려보냅니다.
        out.put("supportedInvestors", tossReady || krxReady ? INVESTORS : SUPPORTED_INVESTORS);
        out.put("unsupportedInvestorNote", krxReady ? KRX_INVESTOR_NOTE : tossReady ? TOSS_ONLY_INVESTOR_NOTE
                : UNSUPPORTED_INVESTOR_NOTE + " 토스증권 키(TOSS_CLIENT_ID/SECRET)가 있으면 토스 공식 데이터로 "
                        + "거래대금 상위 100종목 안의 순위를 받을 수 있습니다(toss_radar_universe 태스크).");
        out.put("fallbackChain", List.of("KIS(장중)", "Daum", "Naver", "KRX(확정 저장본)", "토스(공식)", "누적 이력"));
        out.put("tradeTypes", TRADE_TYPES);
        out.put("intervals", INTERVALS);
        return out;
    }

    /** KRX 정보데이터시스템 확정 순위(ADR 0036)가 앞 7일 안에 들어와 있는가 — 있으면 여섯 투자주체 모두 전 종목 확정 순위로 고를 수 있습니다. */
    private boolean krxRecent() {
        try {
            String since = Kst.today().minusDays(7).toString();
            return repository.listObservationDates(Datasets.OBS_KRX_INVESTOR_RANK).stream().anyMatch(day -> day.compareTo(since) >= 0);
        } catch (RuntimeException e) {
            return false;
        }
    }

    public Map<String, Object> ranking(String market, String investor, String tradeType,
                                       int topN, String intervalType, String targetDate) {
        String snapshotName = Datasets.radarScanner(market, investor, tradeType, intervalType);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("market", market);
        out.put("investor", investor);
        out.put("tradeType", tradeType);
        out.put("intervalType", intervalType);
        out.put("readMode", store.readMode().name().toLowerCase());

        // 과거 날짜나 기본 조합이 아닌 조회는 저장본이 없을 수 있습니다.
        // store_only 모드가 아니면 수집기에 직접 물어봅니다.
        boolean custom = targetDate != null
                || !MARKETS.get(0).equals(market)
                || topN != 30;

        // 스케줄 조합의 저장본이 있으면 **기다리지 않습니다.** 오래됐으면 StoreReader가 수집기에
        // 비동기로 요청하고 저장본을 돌려줍니다("화면은 수집을 기다리지 않습니다").
        // 예전에는 15분 지난 저장본에서 수집기를 동기로 불러(읽기 타임아웃 90초), 수집기가
        // 응답을 못 하면 랭킹 90초·교집합 180초·AI 리포트 270초가 멈췄습니다.
        //
        // 저장본이 **없으면** StoreReader.read를 거치지 않습니다. 그 경로는 radar_rankings
        // 태스크가 끝날 때까지 기다리는데(최대 90초), 그 태스크는 스케줄 조합 3개만 수집하므로
        // 다른 조합(개인·연기금·순매도×기관·5일/20일 …)은 기다려 봐야 결과가 없습니다.
        // 그런 조합은 아래에서 바로 지금 받습니다.
        //
        // 스케줄 밖 조합은 저장본이 **있어도** 그 길을 타지 않습니다(QA-395). 수집기가 지금 받은 결과를 그 조합 이름으로 저장해
        // 두지만 다시 받는 태스크가 없어, 저장본을 먼저 돌려주면 처음 한 번 받은 값이 새로고침으로도 바뀌지 않았습니다.
        // 저장본은 들고만 있다가 지금 받기가 비었거나 실패했을 때(또는 store_only 모드에서) 씁니다.
        boolean scheduled = !custom && SCHEDULED_COMBINATIONS.contains(List.of(market, investor, tradeType, intervalType));
        Optional<Snapshot> snapshot = Optional.empty();
        Optional<Snapshot> fallback = Optional.empty();
        if (!custom) {
            Optional<Snapshot> stored = store.readStored(snapshotName);
            if (stored.isPresent() && scheduled) {
                snapshot = store.read(snapshotName, Datasets.MAX_AGE_REALTIME, "radar_rankings");
            } else {
                fallback = stored.filter(found -> found.payload() != null);
            }
        }

        if (snapshot.isPresent() && snapshot.get().payload() != null) {
            return fillFromSnapshot(out, snapshot.get());
        }
        if (store.readMode() == AppProperties.ReadMode.STORE_ONLY) {
            if (fallback.isPresent()) {
                return fillFromSnapshot(out, fallback.get());
            }
            out.put("available", false);
            out.put("rows", List.of());
            out.put("message",
                    "store_only 모드입니다. 저장본이 없어 표시할 수급이 없습니다 "
                            + "(수집은 수집기가 담당합니다).");
            return out;
        }

        // 스케줄 조합의 저장본이 없을 때와, 스케줄 밖 조회(과거 날짜·다른 시장·다른 topN·스케줄러가 안 받는 투자주체·방향·기간)는 지금 받습니다.
        Optional<JsonNode> live = collector.liveRadar(
                market, investor, tradeType, topN, intervalType, targetDate);

        List<String> liveReasons = List.of();
        if (live.isPresent()) {
            JsonNode payload = live.get();
            liveReasons = reasonsOf(payload);

            // 빈 결과로 여기서 끝내지 않습니다.
            //
            // 수집기가 200으로 답해도 rows가 비어 있을 수 있습니다(폴백 체인이
            // 전부 실패한 경우). 그때 그대로 돌려주면 화면에는 아무 설명 없이
            // "데이터 없음"만 남습니다. 아래로 내려가 저장본을 찾아보고,
            // 그것도 없으면 소스별 사유를 담아 돌려줍니다.
            if (!Json.array(payload, "rows").isEmpty()) {
                out.put("available", true);
                out.put("source", Json.asText(payload, "source"));
                out.put("sourceKind", Json.asText(payload, "sourceKind"));
                out.put("isHistorical", Json.asBoolean(payload, "isHistorical"));
                out.put("historyDate", Json.asText(payload, "historyDate"));
                out.put("dataDate", Json.asText(payload, "dataDate"));
                out.put("rows", payload.get("rows"));
                putActualInterval(out, payload, intervalType);
                if (Json.asBoolean(payload, "isHistorical")) {
                    out.put("warning", historicalWarning(Json.asText(payload, "historyDate")));
                }
                return out;
            }
        }

        if (fallback.isPresent()) {
            // 수집 실패 → 오래된 저장본이라도 보여 줍니다(화면이 비는 것보다 낫습니다).
            Map<String, Object> stored = fillFromSnapshot(out, fallback.get());
            // 이력 대체 저장본이면 그 경고('지금 시점의 수급이 아닙니다')가 더 무거우므로 덮지 않습니다.
            stored.putIfAbsent("warning",
                    "수집에 실패해 저장본을 표시합니다 (수집 시각 "
                            + fallback.get().collectedAtKst() + ").");
            return stored;
        }

        out.put("available", false);
        out.put("rows", List.of());
        // 이유를 아는 만큼 적습니다.
        //
        // 예전 문구는 "수급 데이터를 얻지 못했습니다. 수집기 상태를 확인하세요."
        // 하나였습니다. 수집기는 멀쩡한데(다른 조합은 잘 나옵니다) 그쪽을 보게
        // 만들어, 정작 원인인 소스별 제약에서 멀어졌습니다.
        out.put("message", liveReasons.isEmpty()
                ? "수급 데이터를 얻지 못했습니다. 수집기 상태를 확인하세요."
                : "이 조건으로는 수급을 받을 수 있는 소스가 없습니다.");
        out.put("reasons", liveReasons);
        return out;
    }

    /** 수집기가 알려 준 소스별 실패 사유. */
    private List<String> reasonsOf(JsonNode payload) {
        List<String> reasons = new ArrayList<>();
        for (JsonNode reason : Json.array(payload, "reasons")) {
            if (reason.isString()) {
                reasons.add(reason.asString());
            }
        }
        return reasons;
    }

    private Map<String, Object> fillFromSnapshot(Map<String, Object> out, Snapshot snapshot) {
        JsonNode payload = snapshot.payload();
        out.put("available", !Json.array(payload, "rows").isEmpty());
        snapshot.putFreshness(out);
        out.put("stale", !snapshot.isFresh(Datasets.MAX_AGE_REALTIME));
        out.put("source", Json.asText(payload, "source"));
        out.put("sourceKind", Json.asText(payload, "sourceKind"));
        out.put("isHistorical", Json.asBoolean(payload, "isHistorical"));
        out.put("historyDate", Json.asText(payload, "historyDate"));
        // 행의 기준일(QA-396). 당일 조회가 KRX 앞 거래일 확정 순위로 대체되면 '방금 수집'한 저장본이어도 값은 그 날짜 것입니다.
        // 이 칸이 생기기 전에 저장된 저장본에는 없습니다(null).
        out.put("dataDate", Json.asText(payload, "dataDate"));
        out.put("rows", payload.get("rows"));
        putActualInterval(out, payload, String.valueOf(out.get("intervalType")));
        if (Json.asBoolean(payload, "isHistorical")) {
            out.put("warning", historicalWarning(Json.asText(payload, "historyDate")));
        }
        return out;
    }

    /**
     * 응답의 {@code intervalType}을 수집기가 <b>실제로 받은</b> 기간으로 맞춥니다(QA-397).
     *
     * <p>기간(5일·20일)을 요청해도 하루치가 올 수 있습니다 — Daum이 그 투자주체의 기간 누적을 주지 않거나(기관, 개인 등 KRX 확정 순위 경로)
     * 기간 조회가 실패해 당일 경로로 넘어간 경우입니다. 수집기는 실제 기간을 밝히는데(QA-028) 요청 값을 그대로 내리면 화면이 '5거래일' 아래
     * 하루치 금액을 보입니다. 다르면 실제 값으로 바꾸고 요청 값({@code requestedIntervalType})과 경고를 함께 넣습니다. 수집기가 기간을
     * 밝히지 않은 응답(옛 저장본)은 요청 값 그대로 둡니다. 이력 대체 경고가 뒤에 붙으면 그쪽이 남습니다(더 무거운 경고).
     */
    private static void putActualInterval(Map<String, Object> out, JsonNode payload, String requested) {
        String actual = Json.asText(payload, "intervalType");
        if (actual == null || actual.isBlank() || actual.equals(requested)) {
            return;
        }
        out.put("intervalType", actual);
        out.put("requestedIntervalType", requested);
        out.put("warning", intervalWarning(requested, actual));
    }

    static String intervalLabel(String intervalType) {
        return switch (intervalType) {
            case "TODAY" -> "당일";
            case "DAYS_5" -> "5거래일";
            case "DAYS_20" -> "20거래일";
            default -> intervalType;
        };
    }

    private static String intervalWarning(String requested, String actual) {
        return "요청한 기간(" + intervalLabel(requested) + ")의 누적을 받지 못해 "
                + ("TODAY".equals(actual) ? "하루치(당일)" : intervalLabel(actual)) + " 순위입니다. "
                + "이 투자주체는 출처가 기간 누적을 주지 않거나 기간 조회가 실패했습니다 — 금액을 "
                + intervalLabel(requested) + " 누적으로 읽지 마세요.";
    }

    private String historicalWarning(String historyDate) {
        return "외부 데이터 소스가 모두 실패해 수집기가 저장해 둔 이력("
                + (historyDate == null ? "날짜 미상" : historyDate)
                + ")을 보여 주고 있습니다. 지금 시점의 수급이 아닙니다.";
    }

    /**
     * 외국인·기관이 <b>같은 방향</b>으로 움직인 종목.
     *
     * <p>두 주체의 상위 목록을 각각 받아 종목코드로 맞춥니다. 화면이 표 둘을
     * 오가며 눈으로 대조하지 않아도 되게 하는 것이 목적입니다.
     *
     * <p><b>한계를 그대로 전달합니다</b> — 이것은 두 상위 N개 목록의
     * 교집합입니다. 소스(Daum)가 상위 목록만 주고 전체 종목의 수급을 주지
     * 않기 때문에, 외국인 상위 N 밖에서 사들인 종목은 기관이 1위로 샀더라도
     * 여기 나오지 않습니다. N을 키우면 그만큼 넓게 봅니다.
     *
     * <p>한쪽이라도 수급을 받지 못하면 <b>교집합을 만들지 않습니다</b>. 받은
     * 쪽만으로 목록을 만들면 "둘이 함께 샀다"는 뜻이 아닌 것이 그 이름으로
     * 화면에 남습니다.
     */
    public Map<String, Object> consensus(String market, String tradeType,
                                         int topN, String intervalType) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("market", market);
        out.put("tradeType", tradeType);
        out.put("intervalType", intervalType);
        out.put("topN", topN);

        Map<String, Object> foreign = ranking(market, "외국인", tradeType, topN, intervalType, null);
        Map<String, Object> institution =
                ranking(market, "기관", tradeType, topN, intervalType, null);

        List<String> missing = new ArrayList<>();
        if (!Boolean.TRUE.equals(foreign.get("available"))) {
            missing.add("외국인");
        }
        if (!Boolean.TRUE.equals(institution.get("available"))) {
            missing.add("기관");
        }

        if (!missing.isEmpty()) {
            out.put("available", false);
            out.put("rows", List.of());
            out.put("message", String.join("·", missing)
                    + " 수급을 받지 못해 교집합을 만들 수 없습니다. "
                    + "한쪽만으로는 '둘이 함께 샀다'를 말할 수 없습니다.");
            out.put("reasons", mergedReasons(foreign, institution));
            return out;
        }

        // 기준일이 다르면 맞추지 않습니다(QA-396, PRINCIPLES "기준일이 다르면 비교하지 않습니다"). 한쪽만 KRX 앞 거래일 확정 순위로
        // 대체되면 오늘 값과 전날 값의 교집합이 '함께 샀다'는 이름으로 나갔습니다. 한쪽이라도 기준일을 모르면(옛 저장본·기간 누적)
        // 판단할 근거가 없어 지금처럼 맞춥니다.
        Object foreignDate = foreign.get("dataDate");
        Object institutionDate = institution.get("dataDate");
        if (foreignDate != null && institutionDate != null && !foreignDate.equals(institutionDate)) {
            out.put("available", false);
            out.put("rows", List.of());
            out.put("message", "외국인 " + foreignDate + ", 기관 " + institutionDate + " — 기준일이 달라 맞추지 않습니다. "
                    + "두 순위의 기준일이 같아지면 다시 맞춥니다.");
            out.put("reasons", mergedReasons(foreign, institution));
            return out;
        }

        List<Map<String, Object>> rows =
                SupplyConsensus.intersect(FlowJson.rankRows(rowsOf(foreign)), FlowJson.rankRows(rowsOf(institution)));

        out.put("available", !rows.isEmpty());
        out.put("rows", rows);
        if (foreignDate != null && foreignDate.equals(institutionDate)) {
            out.put("dataDate", foreignDate);
        }
        out.put("foreignCount", rowsOf(foreign).size());
        out.put("institutionCount", rowsOf(institution).size());
        // 신선도는 두 조회 중 **오래된 쪽**을 따릅니다. 새것만 적으면
        // 실제보다 최신인 것처럼 보입니다.
        putOlderFreshness(out, foreign, institution);
        out.put("sources", List.of(
                String.valueOf(foreign.getOrDefault("source", "출처 미상")),
                String.valueOf(institution.getOrDefault("source", "출처 미상"))));
        out.put("note", "각 주체의 상위 " + topN + "개 목록을 종목코드로 맞춘 결과입니다. "
                + "상위 " + topN + "위 밖에서 같은 방향으로 매매한 종목은 소스가 "
                + "주지 않아 알 수 없습니다.");
        // 한쪽이라도 요청한 기간이 아니면(예: 5거래일 요청에 기관은 Daum이 당일만 줌) 서로 다른 기간의 금액을 더한 것입니다(QA-397).
        List<String> otherInterval = new ArrayList<>();
        if (foreign.containsKey("requestedIntervalType")) {
            otherInterval.add("외국인 " + intervalLabel(String.valueOf(foreign.get("intervalType"))));
        }
        if (institution.containsKey("requestedIntervalType")) {
            otherInterval.add("기관 " + intervalLabel(String.valueOf(institution.get("intervalType"))));
        }
        if (!otherInterval.isEmpty()) {
            out.put("warning", "요청한 기간(" + intervalLabel(intervalType) + ")이 아니라 하루치로 받은 쪽이 있습니다: "
                    + String.join(", ", otherInterval) + ". 합계 금액은 서로 다른 기간을 더한 값이라 "
                    + intervalLabel(intervalType) + " 누적으로 읽지 마세요.");
        }
        if (Boolean.TRUE.equals(foreign.get("isHistorical"))
                || Boolean.TRUE.equals(institution.get("isHistorical"))) {
            out.put("warning", "한쪽 이상이 누적 이력으로 대체됐습니다. 지금 시점의 "
                    + "수급이 아닙니다.");
        }
        if (rows.isEmpty()) {
            out.put("message", "두 주체의 상위 " + topN + "개에 겹치는 종목이 없습니다. "
                    + "표시 종목 수를 늘려 보세요.");
        }
        return out;
    }

    /** ranking() 응답의 rows는 JsonNode이거나 빈 목록입니다. 둘 다 받습니다. */
    private List<JsonNode> rowsOf(Map<String, Object> response) {
        Object rows = response.get("rows");
        if (rows instanceof JsonNode node && node.isArray()) {
            List<JsonNode> out = new ArrayList<>();
            node.forEach(out::add);
            return out;
        }
        return List.of();
    }

    private List<String> mergedReasons(Map<String, Object> foreign, Map<String, Object> institution) {
        List<String> out = new ArrayList<>();
        for (Map<String, Object> side : List.of(foreign, institution)) {
            Object reasons = side.get("reasons");
            if (reasons instanceof List<?> list) {
                for (Object reason : list) {
                    String text = String.valueOf(reason);
                    if (!out.contains(text)) {
                        out.add(text);
                    }
                }
            }
        }
        return out;
    }

    private void putOlderFreshness(Map<String, Object> out, Map<String, Object> foreign,
                                   Map<String, Object> institution) {
        Object leftAge = foreign.get("ageSeconds");
        Object rightAge = institution.get("ageSeconds");
        Map<String, Object> older = institution;
        if (leftAge instanceof Number left && rightAge instanceof Number right) {
            older = left.doubleValue() >= right.doubleValue() ? foreign : institution;
        } else if (leftAge instanceof Number) {
            older = foreign;
        }
        if (older.get("collectedAtKst") != null) {
            out.put("collectedAtKst", older.get("collectedAtKst"));
        }
        if (older.get("ageSeconds") != null) {
            out.put("ageSeconds", older.get("ageSeconds"));
        }
        out.put("stale", Boolean.TRUE.equals(foreign.get("stale"))
                || Boolean.TRUE.equals(institution.get("stale")));
    }

    /**
     * 누적 이력 조회 (Naver/Daum이 제공하지 않는 과거 데이터).
     *
     * @param latest true면 <b>한 거래일만</b> 줍니다 — obsDate가 없으면 이 조건의 가장 최근
     *               거래일. 거래일 목록({@code dates})도 이 조건의 기록이 있는 날만 담고,
     *               실제로 고른 날은 {@code obsDate}로 알려 줍니다. 화면은 하루치 30행만
     *               보여 주는데 예전에는 전 기간을 받아 걸렀습니다(1년치: 7,800행·2.3MB).
     *               false면 전 기간이되 최신 {@link #HISTORY_ROW_LIMIT}행까지만 주고, 늘 {@code rowLimit}과
     *               잘렸는지({@code truncated})를 함께 줍니다 (QA-133).
     */
    public Map<String, Object> history(String market, String investor, String tradeType,
                                       String obsDate, String startDate, boolean latest) {
        Map<String, String> filters = new LinkedHashMap<>();
        if (market != null) {
            filters.put("market", market);
        }
        if (investor != null) {
            filters.put("investor", investor);
        }
        if (tradeType != null) {
            filters.put("tradeType", tradeType);
        }

        // 형식이 틀린 날짜는 400입니다(예전에는 파싱 예외 문구와 함께 500).
        LocalDate day = Params.optionalDate("obsDate", obsDate);
        LocalDate since = Params.optionalDate("startDate", startDate);

        Map<String, Object> out = new LinkedHashMap<>();
        if (latest) {
            List<String> dates = repository.listObservationDates(Datasets.OBS_RADAR, filters);
            if (day == null && !dates.isEmpty()) {
                day = LocalDate.parse(dates.get(0));
            }
            out.put("dates", dates);
            out.put("obsDate", day == null ? null : day.toString());
            out.put("rows", day == null
                    ? List.of()
                    : repository.readObservations(Datasets.OBS_RADAR, day, null, filters));
        } else {
            out.put("dates", repository.listObservationDates(Datasets.OBS_RADAR));
            // 상한 없이 모두 보내면 응답이 쌓인 기간만큼 끝없이 커집니다(QA-133). 잘려도 오래된 날은
            // obsDate로 하루씩 다시 받을 수 있어 truncated로 알리기만 합니다.
            StoreRepository.ObservationPage page = repository.readNewestObservations(
                    Datasets.OBS_RADAR, day, since, filters, HISTORY_ROW_LIMIT);
            out.put("rows", page.rows());
            out.put("rowLimit", HISTORY_ROW_LIMIT);
            out.put("truncated", page.truncated());
        }
        out.put("note",
                "Naver·Daum은 과거 날짜 조회를 지원하지 않고, KRX 확정 순위는 수집기가 저장한 날짜(2026-11-11부터)만 있습니다. "
                        + "이 이력은 수집기가 돌 때마다 쌓아 온 값이라 외부에서 다시 받을 수 없습니다 — "
                        + "데이터베이스를 백업할 가치가 있습니다.");
        return out;
    }

    /** 데이터 소스 연결 진단 — 수집기가 KIS·Daum·Naver·토스 넷을 화면이 쓰는 경로 그대로 부릅니다. */
    public Map<String, Object> diagnostics() {
        Optional<JsonNode> payload = collector.diagnostics();
        if (payload.isEmpty()) {
            return Map.of(
                    "available", false,
                    "message", "수집기에 연결하지 못했습니다. 수집기가 실행 중인지 확인하세요.");
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("available", true);
        payload.get().properties().forEach(entry -> out.put(entry.getKey(), entry.getValue()));
        return out;
    }
}
