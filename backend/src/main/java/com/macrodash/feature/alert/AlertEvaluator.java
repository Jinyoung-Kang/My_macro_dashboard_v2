package com.macrodash.feature.alert;

import com.macrodash.Kst;
import com.macrodash.analytics.AlertRules;
import com.macrodash.analytics.FlowRecord;
import com.macrodash.analytics.Holding;
import com.macrodash.feature.institution.InstitutionCatalog;
import com.macrodash.feature.institution.InstitutionHistory;
import com.macrodash.read.StoreReader;
import com.macrodash.store.AlertStore;
import com.macrodash.store.Datasets;
import com.macrodash.store.RegimeLogStore;
import com.macrodash.store.Snapshot;
import com.macrodash.store.StoreRepository;
import com.macrodash.support.FlowJson;
import com.macrodash.support.HoldingsJson;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Supplier;

/**
 * 알림 평가 — 5분마다 세 트리거를 <b>전부</b> 평가해 사건을 만들고, 규칙이 맞는 사용자의 알림함에 넣습니다(설계 §4).
 *
 * <ul>
 *   <li>새 데이터를 "알아내지" 않습니다. 평가가 멱등이라(사건 키·알림함 유일 제약) 같은 데이터를 다시 평가해도
 *       새 사건이 생기지 않습니다. 수집기 실행 번호를 이어 처리하는 방식은 놓치는 건이 있어 버렸습니다(ADR 0011).</li>
 *   <li>저장본은 {@link StoreReader#quietly}로 읽어 수집을 일으키지 않습니다(ADR 0008).</li>
 *   <li>규칙을 만든 날보다 앞선 사건은 그 규칙으로 보내지 않습니다(과거 사건을 몰아 보내지 않음). 사건 발생 3일 뒤에야
 *       알림함에 들어가는 것(백엔드가 꺼져 있었던 경우)은 '지난 사건'으로 표시하고 읽지 않은 수에 세지 않습니다.</li>
 *   <li>잠정치는 쓰지 않습니다. 투자자 매매는 오늘(KST) 기록을 빼고, 종목 기록은 저녁 확정 칸이 모두 찬 경우만 씁니다.</li>
 * </ul>
 */
@Service
public class AlertEvaluator {

    static final int LATE_DAYS = 3;
    static final int REFAN_DAYS = 7;
    static final int INBOX_KEEP_DAYS = 90;

    private static final Logger log = LoggerFactory.getLogger(AlertEvaluator.class);
    private static final ZoneId KST = Kst.ZONE;
    private static final String STEP_FAILED = "알림 평가 '{}' 단계 실패 — 다른 단계는 계속하고 다음 주기에 다시 시도합니다: {}";

    private final AlertStore alerts;
    private final RegimeLogStore regimeLog;
    private final StoreReader store;
    private final StoreRepository repository;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 13F 신규 편입의 대상 기관(기본 12곳 + 즐겨찾기)과 그 이력 읽기. */
    private final InstitutionHistory institutions;

    @Autowired
    public AlertEvaluator(AlertStore alerts, RegimeLogStore regimeLog, StoreReader store, StoreRepository repository,
                          ObjectMapper mapper, InstitutionCatalog catalog) {
        this(alerts, regimeLog, store, repository, mapper, Clock.systemUTC(), catalog);
    }

    /** 즐겨찾기를 보지 않는 평가기(13F 신규 편입은 기본 12곳만) — 시험용. */
    public AlertEvaluator(AlertStore alerts, RegimeLogStore regimeLog, StoreReader store, StoreRepository repository,
                          ObjectMapper mapper) {
        this(alerts, regimeLog, store, repository, mapper, Clock.systemUTC(), InstitutionCatalog.defaultsOnly());
    }

    AlertEvaluator(AlertStore alerts, RegimeLogStore regimeLog, StoreReader store, StoreRepository repository,
                   ObjectMapper mapper, Clock clock) {
        this(alerts, regimeLog, store, repository, mapper, clock, InstitutionCatalog.defaultsOnly());
    }

    AlertEvaluator(AlertStore alerts, RegimeLogStore regimeLog, StoreReader store, StoreRepository repository,
                   ObjectMapper mapper, Clock clock, InstitutionCatalog catalog) {
        this.institutions = new InstitutionHistory(store, catalog);
        this.alerts = alerts;
        this.regimeLog = regimeLog;
        this.store = store;
        this.repository = repository;
        this.mapper = mapper;
        this.clock = clock;
    }

    @Scheduled(initialDelayString = "${dashboard.scheduler.alert-initial-delay-ms:90000}",
            fixedDelayString = "${dashboard.scheduler.alert-interval-ms:300000}")
    public void scheduledEvaluate() {
        try {
            int delivered = evaluate();
            if (delivered > 0) {
                log.info("알림함에 {}건을 넣었습니다.", delivered);
            }
        } catch (RuntimeException e) {
            log.warn("알림 평가 실패 — 다음 주기에 다시 시도합니다: {}", e.toString());
        }
    }

    /**
     * 한 번 평가합니다. 트리거·종류별 배달·알림함 정리는 단계마다 따로 실패합니다 — 한 단계의 예외가 다른 트리거와
     * 모든 사용자의 배달을 멈추지 않게(QA-129). 평가가 멱등이라 일부만 된 주기도 다음 주기에 맞춰집니다.
     *
     * @return 이번에 알림함에 새로 넣은 건수
     */
    public int evaluate() {
        if (!alerts.ready()) {
            return 0;
        }
        LocalDate today = LocalDate.now(clock.withZone(KST));
        store.quietly(() -> {
            guarded("REGIME_CHANGE 사건", this::regimeEvents);
            guarded("FOREIGN_STREAK 사건", () -> streakEvents(today));
            guarded("INSTITUTION_NEW 사건", this::institutionEvents);
            return null;
        });
        int delivered = guarded("REGIME_CHANGE 배달", () -> fanOut("REGIME_CHANGE", today), 0)
                + guarded("FOREIGN_STREAK 배달", () -> fanOut("FOREIGN_STREAK", today), 0)
                + guarded("INSTITUTION_NEW 배달", () -> fanOut("INSTITUTION_NEW", today), 0);
        guarded("알림함 정리", () -> alerts.purgeDeliveries(INBOX_KEEP_DAYS));
        return delivered;
    }

    private static void guarded(String step, Runnable work) {
        guarded(step, () -> {
            work.run();
            return null;
        }, null);
    }

    /**
     * 한 단계를 돌리고, 예외면 단계 이름과 함께 경고를 남긴 뒤 {@code fallback}을 돌려줍니다.
     *
     * <p>DB에 닿지 못하는 실패({@link DataAccessResourceFailureException}, 연결을 얻지 못함 등)는 그대로 던집니다 —
     * 나머지 단계도 같은 이유로 실패하므로, 단계마다 연결을 기다리며 같은 경고를 되풀이하지 않고 그 주기를 한 번에
     * 멈춥니다(바깥 {@link #scheduledEvaluate}가 한 줄 남김).
     *
     * <p>경고에 스택 트레이스는 코드 결함(NPE 등)일 때만 붙입니다 — 단계 하나가 여러 클래스를 거쳐 한 줄로는 어느
     * 파일·줄인지 알 수 없습니다. 다른 DB 오류(SQL 문법·제약 위반 등)는 원인이 메시지에 있고 고칠 때까지 5분마다
     * 되풀이되므로 한 줄만 남깁니다.
     */
    private static <T> T guarded(String step, Supplier<T> work, T fallback) {
        try {
            return work.get();
        } catch (DataAccessResourceFailureException e) {
            throw e;
        } catch (DataAccessException e) {
            log.warn(STEP_FAILED, step, e.toString());
            return fallback;
        } catch (RuntimeException e) {
            log.warn(STEP_FAILED, step, e.toString(), e);   // 마지막 인자가 예외라 스택 트레이스가 붙습니다
            return fallback;
        }
    }

    // ------------------------------------------------------------------ 국면 전환
    void regimeEvents() {
        if (!regimeLog.ready() || alerts.enabledRules("REGIME_CHANGE").isEmpty()) {
            return;
        }
        List<RegimeLogStore.Entry> entries = new ArrayList<>(regimeLog.recent(800));
        Collections.reverse(entries);
        List<AlertRules.RegimeDay> days = new ArrayList<>();
        Map<LocalDate, JsonNode> inputsByDay = new LinkedHashMap<>();
        for (RegimeLogStore.Entry entry : entries) {
            days.add(new AlertRules.RegimeDay(entry.verdictDate(), entry.code(), entry.label(),
                    inputStamp(entry.inputs())));
            inputsByDay.put(entry.verdictDate(), entry.inputs());
        }
        List<AlertRules.RegimeChange> changes = AlertRules.confirmedChanges(days, AlertRules.REGIME_CONFIRM_DAYS);
        for (AlertRules.RegimeChange change : changes) {
            long recent = changes.stream()
                    .filter(other -> !other.confirmedOn().isAfter(change.confirmedOn())
                            && other.confirmedOn().isAfter(change.confirmedOn().minusDays(90)))
                    .count();
            AlertText.Text text = AlertText.regime(change,
                    AlertText.regimeInputs(inputsByDay.get(change.confirmedOn())), (int) recent);
            ObjectNode payload = mapper.createObjectNode();
            payload.put("from", change.fromCode()).put("to", change.toCode())
                    .put("startedOn", change.startedOn().toString());
            alerts.insertEvent("REGIME_CHANGE", "regime:%s:%s>%s".formatted(change.confirmedOn(), change.fromCode(),
                    change.toCode()), change.confirmedOn(), text.title(), text.body(), payload);
        }
    }

    /** 입력들의 기준일을 이름 순으로 이은 문자열(예: "hy=2026-10-08;nfci=2026-10-03"). 하나도 없으면 null. */
    static String inputStamp(JsonNode inputs) {
        if (inputs == null || !inputs.isObject()) {
            return null;
        }
        java.util.TreeMap<String, String> asOf = new java.util.TreeMap<>();
        inputs.properties().forEach(entry -> {
            String date = Json.asText(entry.getValue(), "asOf");
            if (date != null) {
                asOf.put(entry.getKey(), date);
            }
        });
        if (asOf.isEmpty()) {
            return null;
        }
        StringBuilder out = new StringBuilder();
        asOf.forEach((key, date) -> out.append(key).append('=').append(date).append(';'));
        return out.toString();
    }

    // ------------------------------------------------------------------ 외국인 연속 순매수
    void streakEvents(LocalDate today) {
        Set<String> combos = new LinkedHashSet<>();
        for (AlertStore.Rule rule : alerts.enabledRules("FOREIGN_STREAK")) {
            combos.add(target(rule.params()) + "|" + rule.params().path("n").asInt());
        }
        if (combos.isEmpty()) {
            return;
        }
        Optional<Snapshot> market = store.read(Datasets.SNAP_TOSS_MARKET_FLOWS, Datasets.MAX_AGE_DAILY, "toss_market_flows");
        Set<String> codes = new LinkedHashSet<>();
        combos.forEach(combo -> {
            if (combo.startsWith("STOCK:")) {
                codes.add(combo.substring(6, combo.indexOf('|')));
            }
        });
        Map<String, List<JsonNode>> stockSeries = codes.isEmpty() ? Map.of()
                : repository.readObservationSeries(Datasets.OBS_TOSS_STOCK_FLOW, codes, today.minusDays(60));

        for (String combo : combos) {
            String target = combo.substring(0, combo.indexOf('|'));
            int n = Integer.parseInt(combo.substring(combo.indexOf('|') + 1));
            boolean stock = target.startsWith("STOCK:");
            List<FlowRecord> records = stock
                    ? FlowJson.records(stockSeries.getOrDefault(target.substring(6), List.of()))
                    : market.filter(s -> s.payload() != null)
                            .map(s -> FlowJson.records(Json.array(s.payload().path("markets").path(target), "records")))
                            .orElse(List.of());
            // 시장은 그 시장을 받은 날로 확정을 봅니다 — 한 시장만 실패해 이어받은 시장에 저장본 수집 시각(방금 받은 다른
            // 시장의 시각)을 쓰면 장중 기록이 다음 날 확정으로 세졌습니다(QA-076). 예전 저장본은 저장본 수집 시각.
            LocalDate collectedOn = stock ? null : market.filter(s -> s.payload() != null)
                    .map(s -> FlowJson.marketFetchedOn(s.payload().path("markets").path(target), s.collectedAt()))
                    .orElse(null);
            List<AlertRules.DayNet> finalized = finalizedForeignNet(records, today, stock, collectedOn);
            for (AlertRules.StreakHit hit : AlertRules.streakReached(finalized, n)) {
                Long sum = sumNet(finalized, hit);
                String label = stock ? "종목 " + target.substring(6) : ("KOSPI".equals(target) ? "코스피" : "코스닥");
                AlertText.Text text = AlertText.foreignStreak(label, stock, hit, sum);
                ObjectNode payload = mapper.createObjectNode().put("target", target).put("n", n);
                alerts.insertEvent("FOREIGN_STREAK", "streak:%s:%s:%d".formatted(target, hit.date(), n),
                        hit.date(), text.title(), text.body(), payload);
            }
        }
    }

    /**
     * 확정 기록만 오름차순으로. 오늘(KST) 기록은 잠정치라 빼고, 종목 기록은 저녁 확정 칸(개인·기타법인·기관 세부·
     * 외국인 보유율)이 모두 찬 경우만 오늘 기록도 씁니다. 시장 기록은 하루 늦게(다음 날부터) 확정으로 보되, 그날이 지난
     * 뒤에 다시 받은 저장본일 때만입니다 — 장중에 마지막으로 받고 그 뒤 수집이 모두 실패하면 장중 값이 그대로 남아,
     * 다음 날 확정치로 연속을 셌습니다(QA-040).
     *
     * <p>종목의 지난 기록도 확정 칸이 비었으면 장중 잠정치입니다 — 장중에 레이더 대상이었다가 빠져 다시 받지 않은 종목.
     * 그날은 빼지 않고 '모름'(null)으로 둬 연속을 끊습니다. 빼면 앞뒤 날이 이어져 연속이 하루 길게 잡힙니다(QA-064).
     *
     * @param marketCollectedOn 그 시장 기록을 받은 날(KST, {@link FlowJson#marketFetchedOn}). 모르면 null(시장 기록은
     *                          확정으로 보지 않음)
     */
    static List<AlertRules.DayNet> finalizedForeignNet(List<FlowRecord> records, LocalDate today, boolean stock,
                                                       LocalDate marketCollectedOn) {
        List<AlertRules.DayNet> out = new ArrayList<>();
        for (FlowRecord record : records) {
            LocalDate date = Json.parseDate(record.date());
            if (date == null) {
                continue;
            }
            boolean finalized = stock
                    ? date.isBefore(today) || complete(record)
                    : date.isBefore(today) && marketCollectedOn != null && date.isBefore(marketCollectedOn);
            if (!finalized) {
                continue;
            }
            FlowRecord.Amounts foreigner = record.investors().get("foreigner");
            boolean provisional = stock && !complete(record);
            out.add(new AlertRules.DayNet(date, foreigner == null || provisional ? null : foreigner.net()));
        }
        out.sort((a, b) -> a.date().compareTo(b.date()));
        return out;
    }

    private static boolean complete(FlowRecord record) {
        FlowRecord.Amounts individual = record.investors().get("individual");
        FlowRecord.Amounts other = record.investors().get("otherCorporation");
        return individual != null && individual.net() != null && other != null && other.net() != null
                && !record.breakdown().isEmpty() && record.foreignerHoldingRate() != null;
    }

    private static Long sumNet(List<AlertRules.DayNet> days, AlertRules.StreakHit hit) {
        long sum = 0;
        int counted = 0;
        for (int i = days.size() - 1; i >= 0 && counted < hit.days(); i--) {
            AlertRules.DayNet day = days.get(i);
            if (day.date().isAfter(hit.date())) {
                continue;
            }
            if (day.net() == null) {
                return null;
            }
            sum += day.net();
            counted++;
        }
        return counted == hit.days() ? sum : null;
    }

    private static String target(JsonNode params) {
        String target = params.path("target").asText();
        return "STOCK".equals(target) ? "STOCK:" + params.path("code").asText() : target;
    }

    // ------------------------------------------------------------------ 13F 신규 편입
    void institutionEvents() {
        Set<String> ciks = new LinkedHashSet<>();
        alerts.enabledRules("INSTITUTION_NEW").forEach(rule -> ciks.add(rule.params().path("cik").asText()));
        for (String cik : ciks) {
            // 기본 12곳은 지금 그대로(q8 — 없거나 오래면 수집), 즐겨찾기는 q30 앞 8분기 또는 q8을 수집 없이(ADR 0048 단계 3), 그 밖은 읽지 않음.
            Optional<Snapshot> snapshot = institutions.read(cik);
            if (snapshot.isEmpty() || snapshot.get().payload() == null) {
                continue;
            }
            List<JsonNode> quarters = distinctQuarters(Json.array(snapshot.get().payload(), "quarters"));
            if (quarters.isEmpty()) {
                continue;
            }
            JsonNode latest = quarters.get(0);
            String filingDate = Json.asText(latest, "filingDate");
            LocalDate filed = Json.parseDate(filingDate);
            if (filed == null) {
                continue;
            }
            // 직전 분기는 바로 앞 분기 말일의 공시입니다. 분기가 빠진 기관을 6개월 전과 비교해 '직전 분기에 없던
            // 종목'이라고 알리지 않습니다(QA-085).
            JsonNode previous = HoldingsJson.previousQuarter(quarters, latest);
            List<Holding> added = previous == null ? List.of()
                    : AlertRules.newPositions(HoldingsJson.holdings(latest), HoldingsJson.holdings(previous));
            if (added.isEmpty()) {
                continue;   // 비교할 직전 분기가 없거나 신규 편입이 없으면 알릴 것이 없습니다
            }
            String name = institutions.name(cik);
            AlertText.Text text = AlertText.institutionNew(name, Json.asText(latest, "reportDate"), filingDate, added);
            ObjectNode payload = mapper.createObjectNode().put("cik", cik).put("newCount", added.size());
            alerts.insertEvent("INSTITUTION_NEW", "13f:%s:%s".formatted(cik, filingDate), filed,
                    text.title(), text.body(), payload);
        }
    }

    /** 같은 보고 분기가 두 번(정정) 나오면 먼저 나온(최근 제출) 것만 — 13F 화면과 같은 규칙. */
    static List<JsonNode> distinctQuarters(List<JsonNode> quarters) {
        Map<String, JsonNode> byDate = new LinkedHashMap<>();
        for (JsonNode quarter : quarters) {
            String reportDate = Json.asText(quarter, "reportDate");
            if (reportDate != null) {
                byDate.putIfAbsent(reportDate, quarter);
            }
        }
        return new ArrayList<>(byDate.values());
    }

    // ------------------------------------------------------------------ 알림함에 넣기
    /** 최근 사건을 규칙과 맞춰 알림함에 넣습니다(이미 있으면 그대로). 규칙을 만든 날보다 앞선 사건은 넣지 않습니다. */
    int fanOut(String kind, LocalDate today) {
        List<AlertStore.Rule> rules = alerts.enabledRules(kind);
        if (rules.isEmpty()) {
            return 0;
        }
        int delivered = 0;
        for (AlertStore.Event event : alerts.recentEvents(kind, REFAN_DAYS)) {
            for (AlertStore.Rule rule : rules) {
                if (!matches(rule, event)) {
                    continue;
                }
                LocalDate created = rule.createdAt().atZone(KST).toLocalDate();
                if (event.occurredOn().isBefore(created)) {
                    continue;
                }
                boolean late = event.occurredOn().isBefore(today.minusDays(LATE_DAYS));
                if (alerts.deliver(event.id(), rule.userId(), rule.id(), late)) {
                    delivered++;
                }
            }
        }
        return delivered;
    }

    /** 사건 키에 담긴 대상이 규칙과 맞는가. */
    static boolean matches(AlertStore.Rule rule, AlertStore.Event event) {
        String key = event.eventKey();
        return switch (rule.kind()) {
            case "REGIME_CHANGE" -> key.startsWith("regime:");
            case "FOREIGN_STREAK" -> key.startsWith("streak:" + target(rule.params()) + ":")
                    && key.endsWith(":" + rule.params().path("n").asInt());
            case "INSTITUTION_NEW" -> key.startsWith("13f:" + rule.params().path("cik").asText() + ":");
            default -> false;
        };
    }
}
