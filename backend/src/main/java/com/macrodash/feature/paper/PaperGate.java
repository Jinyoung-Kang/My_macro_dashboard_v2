package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.GateIndicator;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.store.Datasets;
import com.macrodash.store.PaperStore.GateRow;
import com.macrodash.store.Snapshot;
import com.macrodash.support.Json;
import tools.jackson.databind.JsonNode;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * OS 게이트 <b>지표</b>(참고 — 구속하지 않음, 명세 D7·D19)의 입력 읽기와 기록·화면 모양.
 *
 * <p>계산은 {@link GateIndicator}, 거래일마다 한 번 남기는 것은 {@link PaperDecisionJob}입니다. 규칙 책은 이 값을 주문에 쓰지
 * 않고(매크로 게이트 없음, D19) 결정 기록에 참고로만 싣습니다.
 *
 * <p>입력은 매크로 화면 카드 저장본({@code macro.collected})의 지금 값입니다 — 10년물·브렌트·WTI·달러/엔. 결정 작업은 미국 장
 * 마감 몇 시간 뒤(다음 날 07:30 KST)에 돌므로 그 거래일 마감 무렵의 값입니다. 카드가 없거나 수집 실패면 그 입력은 null이고
 * 단계는 UNKNOWN입니다(L0로 읽히지 않게).
 *
 * <p><b>그날 값이 아닌 입력은 연속 일수에 넣지 않습니다</b>({@link #counted}): 수집기가 직전 값을 이어 쓴 카드({@code isStale})와
 * 카드 시각({@code lastTs})이 그 거래일(미국 동부)보다 앞인 카드 — 화~목 수집이 실패해 월요일 값을 이어 쓰면 하루치 값이 매일
 * +1 돼 '3일 연속 확인'이 됩니다. 그런 입력은 계산에서 없는 값(그 조건 null, 단계 UNKNOWN)으로 보고, 기록에는 값·표시를 그대로
 * 남깁니다({@code counted:false}).
 */
final class PaperGate {

    private PaperGate() {
    }

    /** 카드 키 = {@link GateIndicator.Inputs}의 순서. */
    static final List<String> KEYS = List.of("us10y", "brent", "wti", "usdjpy");
    static final String NOTE = "과거 OS가 쓴 트리거 수준 — 구속하지 않음";

    /** 카드 하나의 입력. 값이 없으면 null. */
    record Input(Double value, String lastTs, boolean stale) {
    }

    /** 저장본 → 키별 입력(KEYS 순). 저장본이 없으면 모두 null. */
    static Map<String, Input> read(Snapshot snapshot) {
        Map<String, Input> out = new LinkedHashMap<>();
        KEYS.forEach(key -> out.put(key, new Input(null, null, false)));
        if (snapshot == null || snapshot.payload() == null) {
            return out;
        }
        for (JsonNode category : Json.array(snapshot.payload(), "categories")) {
            for (JsonNode item : Json.array(category, "items")) {
                String key = Json.asText(item, "key");
                if (key == null || !out.containsKey(key) || out.get(key).value() != null) {
                    continue;
                }
                Double price = Json.asDouble(item, "price");
                boolean usable = price != null && Double.isFinite(price) && !"fail".equals(Json.asText(item, "status"));
                out.put(key, new Input(usable ? price : null, Json.asText(item, "lastTs"),
                        Json.asBoolean(item, "isStale")));
            }
        }
        return out;
    }

    /**
     * 계산에 넣는 입력 — {@link #counted}가 아닌 입력은 null(모르는 값)입니다.
     *
     * @param tradingDate 게이트를 남기는 거래일
     */
    static GateIndicator.Inputs inputs(Map<String, Input> read, LocalDate tradingDate) {
        return new GateIndicator.Inputs(countedValue(read.get("us10y"), tradingDate),
                countedValue(read.get("brent"), tradingDate), countedValue(read.get("wti"), tradingDate),
                countedValue(read.get("usdjpy"), tradingDate));
    }

    private static Double countedValue(Input input, LocalDate tradingDate) {
        return counted(input, tradingDate) ? input.value() : null;
    }

    /**
     * 그 거래일의 값으로 셀 수 있는 입력인가 — 값이 있고, 이어 쓴 값이 아니고, 카드 시각이 그 거래일보다 앞이 아님. 카드 시각을
     * 읽지 못하면(수집기 표기가 바뀜 등) 시각으로는 빼지 않습니다(이어 쓴 표시는 그대로 봄).
     */
    static boolean counted(Input input, LocalDate tradingDate) {
        if (input == null || input.value() == null || input.stale()) {
            return false;
        }
        LocalDate observed = observedDate(input.lastTs());
        return observed == null || !observed.isBefore(tradingDate);
    }

    /** "2026-10-24 05:00"(KST 시각) 꼴의 앞머리. 뒤에 붙는 출처 설명("(TradingView 수집 시각)" 등)은 무시합니다. */
    private static final Pattern STAMP = Pattern.compile("^(\\d{4}-\\d{2}-\\d{2})(?:[ T](\\d{2}:\\d{2}))?");

    /**
     * 카드 시각({@code lastTs})이 가리키는 미국 동부 날짜. 수집기 표기는 두 가지입니다 — 시각이 있으면 KST 시각(분봉·수집 시각)이라
     * 미국 동부 날짜로 바꾸고, "2026-10-23 일봉 기준"·"… 거래일 기준"처럼 날짜만 있으면 그 시장의 거래일이라 그대로 씁니다.
     *
     * @return 읽지 못하면 null
     */
    static LocalDate observedDate(String lastTs) {
        if (lastTs == null) {
            return null;
        }
        Matcher m = STAMP.matcher(lastTs.strip());
        if (!m.find()) {
            return null;
        }
        try {
            LocalDate date = LocalDate.parse(m.group(1));
            if (m.group(2) == null) {
                return date;
            }
            return LocalDateTime.of(date, LocalTime.parse(m.group(2))).atZone(Kst.ZONE)
                    .withZoneSameInstant(UsMarketCalendar.NEW_YORK).toLocalDate();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /**
     * {@code paper_gate_log.inputs}에 남기는 모양 — 입력마다 {@code {value, source, lastTs, isStale, counted}}(counted = 그날
     * 계산에 넣었나, {@link #counted}), 그리고 그날의 조건 참·거짓·없는 입력·임계치·저장본 수집 시각. 임계치는 설정으로 바뀔 수
     * 있어 그날 쓴 값을 함께 둡니다(조건을 다시 계산하지 않아도 되게).
     */
    static Map<String, Object> inputsBody(Map<String, Input> read, LocalDate tradingDate, GateIndicator.Result result,
                                          GateIndicator.Thresholds thresholds, Snapshot snapshot) {
        Map<String, Object> out = new LinkedHashMap<>();
        read.forEach((key, input) -> {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("value", input.value());
            entry.put("source", Datasets.SNAP_MACRO_COLLECTED);
            entry.put("lastTs", input.lastTs());
            entry.put("isStale", input.stale());
            entry.put("counted", counted(input, tradingDate));
            out.put(key, entry);
        });
        out.put("conditions", result.conditions());
        out.put("missing", result.missing());
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("us10yStage1", thresholds.us10yStage1());
        t.put("us10yFull", thresholds.us10yFull());
        t.put("brentMax", thresholds.brentMax());
        t.put("wtiMax", thresholds.wtiMax());
        t.put("usdjpyMin", thresholds.usdjpyMin());
        t.put("confirmDays", thresholds.confirmDays());
        out.put("thresholds", t);
        out.put("snapshotCollectedAtKst", snapshot == null || snapshot.collectedAt() == null ? null
                : Kst.stamp(snapshot.collectedAt()));
        return out;
    }

    /** 저장한 streaks JSON → 맵(숫자가 아닌 값은 빠짐 — {@link GateIndicator#evaluate}가 0으로 봄). */
    static Map<String, Integer> streaks(JsonNode node) {
        Map<String, Integer> out = new LinkedHashMap<>();
        if (node == null || !node.isObject()) {
            return out;
        }
        for (Map.Entry<String, JsonNode> entry : node.properties()) {
            if (entry.getValue() != null && entry.getValue().isNumber()) {
                out.put(entry.getKey(), entry.getValue().asInt());
            }
        }
        return out;
    }

    /**
     * 화면·결정 기록용 {@code {tradingDate, level, conditions, streaks, inputs:{us10y:{value, source, lastTs, isStale}, …},
     * missing, thresholds, note}}. 기록이 없으면 null.
     */
    static Map<String, Object> view(GateRow row) {
        if (row == null) {
            return null;
        }
        Map<String, Object> inputs = new LinkedHashMap<>();
        for (String key : KEYS) {
            inputs.put(key, Json.child(row.inputs(), key));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tradingDate", row.tradingDate().toString());
        out.put("level", row.level());
        out.put("conditions", Json.child(row.inputs(), "conditions"));
        out.put("streaks", row.streaks());
        out.put("inputs", inputs);
        out.put("missing", Json.child(row.inputs(), "missing"));
        out.put("thresholds", Json.child(row.inputs(), "thresholds"));
        out.put("note", NOTE);
        return out;
    }
}
