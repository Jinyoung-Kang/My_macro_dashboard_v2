package com.macrodash.feature.insight;

import com.macrodash.Kst;
import com.macrodash.analytics.Regime;
import com.macrodash.read.StoreReader;
import com.macrodash.store.RegimeLogStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

import java.time.Clock;
import java.time.LocalDate;
import java.time.ZonedDateTime;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 국면 판정 라이브 기록 — 하루 한 번, 그날 화면에 보인 판정을 근거와 함께 남깁니다.
 *
 * <p>판정 성과를 공개할 때 과거 재현(백테스트)만으로는 "나중에 맞춰 고친 것 아니냐"에 답할 수 없습니다.
 * 이 기록은 <b>그날 실제로 낸 판정</b>이고, 추가만 하고 고치지 않습니다. 시작한 날부터만 쌓이므로
 * 가장 먼저 돌기 시작해야 하는 기능입니다(명세 A1).
 *
 * <p>규칙
 * <ul>
 *   <li>기록 시각(KST, 설정 {@code dashboard.scheduler.regime-record-hour-kst}, 기본 {@value #DEFAULT_RECORD_HOUR_KST}시) 이후
 *       하루 한 건. 아침에는 밤사이 수집이 아직 안 돌았을 수 있습니다. 백엔드가 그 시각 뒤에 켜져 있어야 기록되므로,
 *       평일 08:50–18:00만 켜 두던 v3 AWS 데모는 17시로 뒀습니다(QA-093). 이 저장소의 서버는 23시로 둡니다
 *       ({@code compose.vultr.yml}) — 밤에만 켜던 AWS 개인용 서버(ADR 0019, KST 21:55–08:00)에서 기동 뒤 수집이 한 바퀴 돈 시각으로
 *       정했고, 24시간 켜 두는 Vultr(ADR 0023)도 기록 시점을 바꾸지 않았습니다.</li>
 *   <li>화면과 같은 계산({@link AnalyticsService#regimeNow()})을 쓰되, 수집을 일으키지 않고 저장본만 읽습니다.</li>
 *   <li>입력이 오래됐으면(일별 {@value #DAILY_MAX_AGE_DAYS}일, NFCI {@value #WEEKLY_MAX_AGE_DAYS}일 초과)
 *       "판정 불가"로 남깁니다 — 건너뛰면 빈 날이 보이지 않고, 오래된 값으로 판정하면 그날의 판정이 아닙니다.</li>
 * </ul>
 */
@Service
public class RegimeLogService {

    /** 기록 시각(KST 시)의 기본값. 배포마다 {@code dashboard.scheduler.regime-record-hour-kst}로 바꿉니다. */
    static final int DEFAULT_RECORD_HOUR_KST = 18;
    /** 일별 입력(금리차·하이일드·순유동성)의 허용 지연 — 영업일 4일 + 주말. */
    static final int DAILY_MAX_AGE_DAYS = 6;
    /** NFCI(주간, 다음 주 수요일 발표)의 허용 지연. */
    static final int WEEKLY_MAX_AGE_DAYS = 12;
    static final int MAX_LIMIT = 3650;
    /** 무료 회원이 보는 최근 기록 수(D5 등급표). 유료·운영자는 전체. */
    static final int FREE_LIMIT = 30;

    private static final Logger log = LoggerFactory.getLogger(RegimeLogService.class);

    private static final Map<String, String> INPUT_LABELS = Map.of(
            "curve10y3m", "10Y-3M 금리차", "nfci", "NFCI", "hyOas", "하이일드 스프레드",
            "liquidity4w", "순유동성 4주 변화");

    public enum Outcome { RECORDED, ALREADY_RECORDED, TOO_EARLY, SCHEMA_NOT_READY }

    private final AnalyticsService analytics;
    private final StoreReader store;
    private final RegimeLogStore regimeLog;
    private final ObjectMapper mapper;
    private final Clock clock;
    /** 이 시각(KST, 0–23) 이후 첫 정기 실행이 그날의 판정을 남깁니다. */
    private final int recordHourKst;

    @Autowired
    public RegimeLogService(AnalyticsService analytics, StoreReader store, RegimeLogStore regimeLog,
                            ObjectMapper mapper,
                            @Value("${dashboard.scheduler.regime-record-hour-kst:" + DEFAULT_RECORD_HOUR_KST + "}")
                            int recordHourKst) {
        this(analytics, store, regimeLog, mapper, Clock.systemUTC(), recordHourKst);
    }

    /** 테스트용 — 기본 기록 시각. */
    RegimeLogService(AnalyticsService analytics, StoreReader store, RegimeLogStore regimeLog,
                     ObjectMapper mapper, Clock clock) {
        this(analytics, store, regimeLog, mapper, clock, DEFAULT_RECORD_HOUR_KST);
    }

    /**
     * @throws IllegalStateException 기록 시각이 0–23 밖일 때 — 24 같은 값이면 하루도 기록하지 않고 조용히 지나가므로
     *                               기동할 때 멈춥니다
     */
    RegimeLogService(AnalyticsService analytics, StoreReader store, RegimeLogStore regimeLog,
                     ObjectMapper mapper, Clock clock, int recordHourKst) {
        if (recordHourKst < 0 || recordHourKst > 23) {
            throw new IllegalStateException("dashboard.scheduler.regime-record-hour-kst는 0–23이어야 합니다: "
                    + recordHourKst);
        }
        this.analytics = analytics;
        this.store = store;
        this.regimeLog = regimeLog;
        this.mapper = mapper;
        this.clock = clock;
        this.recordHourKst = recordHourKst;
    }

    /**
     * 정기 실행. 실패해도 다음 주기에 다시 시도합니다(같은 날 두 번 기록되지는 않음). 첫 실행은 기동 15분 뒤입니다 — 겨울 밤 창은 23:20에
     * 켜져, 기동 직후 실행이 수집기의 기동 수집 전 저장본(낮 창 값)으로 기록하므로(ADR 0019 결정 14, 2026-11-02).
     */
    @Scheduled(initialDelayString = "${dashboard.scheduler.regime-initial-delay-ms:900000}",
            fixedDelayString = "${dashboard.scheduler.regime-interval-ms:1800000}")
    public void scheduledRecord() {
        try {
            Outcome outcome = recordToday();
            if (outcome == Outcome.RECORDED) {
                log.info("국면 판정 기록: {}", Kst.now(clock).toLocalDate());
            }
        } catch (RuntimeException e) {
            log.warn("국면 판정 기록 실패 — 다음 주기에 다시 시도합니다: {}", e.toString());
        }
    }

    public Outcome recordToday() {
        if (!regimeLog.ready()) {
            return Outcome.SCHEMA_NOT_READY;
        }
        ZonedDateTime now = Kst.now(clock);
        if (now.getHour() < recordHourKst) {
            return Outcome.TOO_EARLY;
        }
        LocalDate today = now.toLocalDate();
        if (regimeLog.exists(today)) {
            return Outcome.ALREADY_RECORDED;
        }
        AnalyticsService.RegimeReading reading = store.quietly(analytics::regimeNow);
        boolean inserted = regimeLog.insertIfAbsent(toEntry(today, reading));
        return inserted ? Outcome.RECORDED : Outcome.ALREADY_RECORDED;
    }

    /** 판정과 입력을 기록 한 건으로. 오래된 입력이 있으면 "판정 불가"로 바꿉니다. */
    RegimeLogStore.Entry toEntry(LocalDate today, AnalyticsService.RegimeReading reading) {
        Regime.Verdict verdict = reading.verdict();
        List<String> missing = new ArrayList<>(verdict.missing());
        for (Map.Entry<String, Map<String, Object>> input : reading.inputs().entrySet()) {
            Object asOf = input.getValue().get("asOf");
            if (asOf == null || input.getValue().get("value") == null) {
                continue;   // 값이 없는 입력은 판정이 이미 missing에 담았습니다
            }
            int limit = "nfci".equals(input.getKey()) ? WEEKLY_MAX_AGE_DAYS : DAILY_MAX_AGE_DAYS;
            long age = ChronoUnit.DAYS.between(LocalDate.parse(asOf.toString()), today);
            if (age > limit) {
                missing.add("입력 오래됨: %s (%s, %d일 전)"
                        .formatted(INPUT_LABELS.getOrDefault(input.getKey(), input.getKey()), asOf, age));
            }
        }
        boolean stale = missing.size() > verdict.missing().size();
        String code = stale ? "UNKNOWN" : verdict.code();
        String label = stale ? "판정 불가" : verdict.label();
        return new RegimeLogStore.Entry(today, code, label, mapper.valueToTree(reading.inputs()),
                missing, Regime.RULE_VERSION);
    }

    /** 최근 기록. 테이블이 아직 없으면 그 사실을 알립니다. */
    public Map<String, Object> recent(int limit, boolean pro) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (!regimeLog.ready()) {
            out.put("available", false);
            out.put("message", "판정 기록 테이블이 아직 없습니다. 수집기가 기동하면서 스키마(V3)를 적용하면 "
                    + "생깁니다 — make up 후 다시 보세요.");
            return out;
        }
        int bounded = Math.max(1, Math.min(limit, pro ? MAX_LIMIT : FREE_LIMIT));
        List<Map<String, Object>> entries = new ArrayList<>();
        for (RegimeLogStore.Entry entry : regimeLog.recent(bounded)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("date", entry.verdictDate().toString());
            row.put("code", entry.code());
            row.put("label", entry.label());
            row.put("inputs", entry.inputs());
            row.put("missing", entry.missing());
            row.put("ruleVersion", entry.ruleVersion());
            entries.add(row);
        }
        out.put("available", true);
        out.put("startedOn", regimeLog.firstDate().map(LocalDate::toString).orElse(null));
        out.put("count", regimeLog.count());
        out.put("recordHourKst", recordHourKst);
        if (!pro && limit > FREE_LIMIT) {
            out.put("limitedTo", FREE_LIMIT);   // 화면이 "유료 등급은 전체" 안내를 띄웁니다
        }
        out.put("entries", entries);
        out.put("note", "하루 한 번(KST %d시 이후) 그날 화면에 보인 판정을 근거와 함께 남깁니다. "
                .formatted(recordHourKst)
                + "기록은 추가만 하고 고치지 않습니다. 입력이 오래됐거나 빠진 날은 '판정 불가'로 남깁니다.");
        return out;
    }
}
