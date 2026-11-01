package com.macrodash.analytics;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 투자자별 매매 (토스증권 공식) — 누적·연속성·기관 세부·현물/선물 동조.
 *
 * <p>입력은 수집기가 정규화한 기록입니다({@code collector/app/services/toss.py}).
 * <pre>
 * { date, updatedAt,
 *   investors: { foreigner|institution|individual|otherCorporation: {buy, sell, net} | null },
 *   breakdown: { pensionFund|financialInvestment|…: {buy, sell, net} } | null,
 *   foreignerHoldingRate: 0.5089 | null }      // 종목 기록에만
 * </pre>
 * 시장 기록의 단위는 원(KRW), 종목 기록의 단위는 주(株)입니다. 이 클래스는 단위를 모릅니다.
 * 저장본은 {@code support.FlowJson}이 {@link FlowRecord}로 바꿔 넘깁니다.
 *
 * <p>주의사항
 * <ul>
 *   <li><b>null은 "모름"입니다.</b> 당일 잠정 기록은 개인·기관 세부·기타법인이 null입니다.
 *       합계에서 null을 0으로 더하지 않고 건너뛰며, 실제로 더한 일수({@code days})를 함께
 *       돌려줍니다. 화면은 일수가 모자라면 그 사실을 적습니다.</li>
 *   <li>기록은 <b>최신이 앞</b>입니다(API 순서 그대로).</li>
 * </ul>
 */
public final class InvestorFlows {

    public static final List<String> INVESTORS =
            List.of("foreigner", "institution", "individual", "otherCorporation");
    public static final List<String> BREAKDOWN = List.of(
            "pensionFund", "financialInvestment", "trust", "privateEquityFund",
            "insurance", "bank", "otherFinancialInstitution");

    private static final Map<String, String> LABELS = Map.ofEntries(
            Map.entry("foreigner", "외국인"),
            Map.entry("institution", "기관"),
            Map.entry("individual", "개인"),
            Map.entry("otherCorporation", "기타법인"),
            Map.entry("pensionFund", "연기금"),
            Map.entry("financialInvestment", "금융투자"),
            Map.entry("trust", "투신"),
            Map.entry("privateEquityFund", "사모펀드"),
            Map.entry("insurance", "보험"),
            Map.entry("bank", "은행"),
            Map.entry("otherFinancialInstitution", "기타금융"));

    private InvestorFlows() {
    }

    public static String label(String key) {
        return LABELS.getOrDefault(key, key);
    }

    /** {@code record.group.key.net}. 모르면 null. */
    static Long net(FlowRecord record, String group, String key) {
        return record == null ? null : record.value(group, key, "net");
    }

    /**
     * 최근 {@code window}개 기록의 순매수 합.
     *
     * @return {@code {sum, days, window}} — 값이 있는 기록만 더합니다. 하나도 없으면 sum은 null
     */
    static Map<String, Object> sum(List<FlowRecord> records, int window, String group, String key) {
        long total = 0;
        int days = 0;
        for (int i = 0; i < Math.min(window, records.size()); i++) {
            Long value = net(records.get(i), group, key);
            if (value != null) {
                total += value;
                days++;
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("sum", days == 0 ? null : total);
        out.put("days", days);
        out.put("window", window);
        return out;
    }

    /**
     * 연속 순매수(+)·순매도(−) 일수. 최신 기록의 부호가 몇 거래일째 이어지는지.
     *
     * <p>값이 없거나(null) 0인 날에서 멈춥니다 — 모르는 날을 이어진 것으로 세지 않습니다.
     *
     * @return +n(n일째 순매수) / −n(n일째 순매도) / 0(최신 값이 없거나 0)
     */
    static int streak(List<FlowRecord> records, String key) {
        if (records.isEmpty()) {
            return 0;
        }
        Long first = net(records.get(0), "investors", key);
        if (first == null || first == 0) {
            return 0;
        }
        int sign = Long.signum(first);
        int count = 0;
        for (FlowRecord record : records) {
            Long value = net(record, "investors", key);
            if (value == null || Long.signum(value) != sign) {
                break;
            }
            count++;
        }
        return sign * count;
    }

    /**
     * 기록 묶음 하나(시장 하나 또는 종목 하나)의 요약.
     *
     * @param records 최신이 앞인 기록
     * @param today   오늘(KST). 최신 기록이 오늘이면 장중 잠정치일 수 있다고 표시합니다
     * @param seriesDays 차트용 일별 순매수 계열 길이(0이면 넣지 않음, 오래된 날이 앞)
     */
    public static Map<String, Object> summarize(List<FlowRecord> records, LocalDate today, int seriesDays) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("records", records.size());
        if (records.isEmpty()) {
            return out;
        }
        FlowRecord latest = records.get(0);
        String latestDate = latest.date();
        out.put("latestDate", latestDate);
        out.put("latestUpdatedAt", latest.updatedAt());
        // 공식 설명: "당일 기록은 장 종료 전까지 갱신될 수 있는 잠정치"
        out.put("provisional", today != null && today.toString().equals(latestDate));

        List<Map<String, Object>> investors = new ArrayList<>();
        for (String key : INVESTORS) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", key);
            row.put("label", label(key));
            row.put("latest", net(latest, "investors", key));
            row.put("net5", sum(records, 5, "investors", key));
            row.put("net20", sum(records, 20, "investors", key));
            row.put("streak", streak(records, key));
            investors.add(row);
        }
        out.put("investors", investors);

        List<Map<String, Object>> breakdown = new ArrayList<>();
        for (String key : BREAKDOWN) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", key);
            row.put("label", label(key));
            row.put("latest", net(latest, "breakdown", key));
            row.put("net5", sum(records, 5, "breakdown", key));
            row.put("net20", sum(records, 20, "breakdown", key));
            breakdown.add(row);
        }
        out.put("breakdown", breakdown);

        Map<String, Object> holding = foreignerHolding(records, 20);
        if (holding != null) {
            out.put("foreignerHolding", holding);
        }

        if (seriesDays > 0) {
            List<Map<String, Object>> series = new ArrayList<>();
            for (int i = Math.min(seriesDays, records.size()) - 1; i >= 0; i--) {
                FlowRecord record = records.get(i);
                Map<String, Object> point = new LinkedHashMap<>();
                point.put("date", record.date());
                for (String key : List.of("foreigner", "institution", "individual")) {
                    point.put(key, net(record, "investors", key));
                }
                series.add(point);
            }
            out.put("series", series);
        }
        return out;
    }

    /**
     * 외국인 보유율 — 최신 값과 창 안에서의 변화(%p).
     *
     * @return 값이 있는 기록이 없으면 null
     */
    static Map<String, Object> foreignerHolding(List<FlowRecord> records, int window) {
        FlowRecord newest = null;
        FlowRecord oldest = null;
        for (int i = 0; i < Math.min(window, records.size()); i++) {
            FlowRecord record = records.get(i);
            if (record.foreignerHoldingRate() == null) {
                continue;
            }
            if (newest == null) {
                newest = record;
            }
            oldest = record;
        }
        if (newest == null) {
            return null;
        }
        double latestRate = newest.foreignerHoldingRate();
        double oldestRate = oldest.foreignerHoldingRate();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ratePct", latestRate * 100);
        out.put("date", newest.date());
        out.put("changePp", newest == oldest ? null : (latestRate - oldestRate) * 100);
        out.put("fromDate", newest == oldest ? null : oldest.date());
        return out;
    }

    // ------------------------------------------------------------------ 현물·선물 동조
    /**
     * Daum KOSPI200 선물 수급 행 하나(단위: 계약).
     *
     * @param investor 행 이름 (예: "외국인 (스마트머니)"). 모르면 null
     * @param netToday 당일 순매수. 모르면 null
     * @param net5d    5일 순매수. 모르면 null
     * @param net20d   20일 순매수. 모르면 null
     */
    public record FuturesRow(String investor, Double netToday, Double net5d, Double net20d) {
    }

    /**
     * 토스 현물 키 → Daum 선물 수급 행 이름의 <b>첫 단어</b>.
     *
     * <p>수집기는 "외국인 (스마트머니)"처럼 설명을 붙여 저장하고, 예전 저장본은 "외국인"뿐입니다
     * ({@code collector/app/services/krx.py} DAUM_INVESTOR_FIELDS). 설명 문구가 바뀌어도 매칭이
     * 끊기지 않게 괄호·공백 앞 첫 단어로 맞춥니다.
     */
    private static final Map<String, String> FUTURES_LABELS = Map.of(
            "foreigner", "외국인",
            "institution", "기관계",
            "individual", "개인",
            "financialInvestment", "금융투자");

    static String firstWord(String label) {
        String trimmed = label.trim();
        int cut = trimmed.length();
        for (char stop : new char[] {' ', '('}) {
            int index = trimmed.indexOf(stop);
            if (index >= 0 && index < cut) {
                cut = index;
            }
        }
        return trimmed.substring(0, cut);
    }

    /**
     * 같은 투자자가 현물(코스피 전체, 원)과 선물(계약)을 같은 방향으로 샀는지.
     *
     * <p>둘은 단위가 달라 크기를 비교하지 않습니다. <b>방향(부호)</b>만 봅니다.
     * 금융투자는 차익거래 주체라 현물·선물이 반대로 움직이는 것이 보통입니다.
     *
     * @param spotRecords  코스피 투자자별 매매대금 기록 (최신이 앞)
     * @param futuresRows  Daum 선물 수급 행 ({@code investor, netToday, net5d, net20d})
     * @param futuresDate  Daum 기준일 (YYYY-MM-DD, 모르면 null)
     * @return 투자자별 {spot, futures, verdict}. 기준일이 다르면 당일 판정은 하지 않습니다
     */
    public static Map<String, Object> spotFutures(List<FlowRecord> spotRecords, List<FuturesRow> futuresRows,
                                                  String futuresDate) {
        Map<String, FuturesRow> futuresByLabel = new LinkedHashMap<>();
        for (FuturesRow row : futuresRows) {
            String name = row.investor();
            if (name != null) {
                futuresByLabel.putIfAbsent(firstWord(name), row);
            }
        }
        String spotDate = spotRecords.isEmpty() ? null : spotRecords.get(0).date();
        boolean sameDay = spotDate != null && spotDate.equals(futuresDate);

        List<Map<String, Object>> rows = new ArrayList<>();
        for (String key : List.of("foreigner", "institution", "individual", "financialInvestment")) {
            String group = "financialInvestment".equals(key) ? "breakdown" : "investors";
            FuturesRow futures = futuresByLabel.get(FUTURES_LABELS.get(key));

            Long spotToday = spotRecords.isEmpty() ? null : net(spotRecords.get(0), group, key);
            Long spot5 = (Long) sum(spotRecords, 5, group, key).get("sum");
            Long spot20 = (Long) sum(spotRecords, 20, group, key).get("sum");
            Long futToday = futures == null ? null : rounded(futures.netToday());
            Long fut5 = futures == null ? null : rounded(futures.net5d());
            Long fut20 = futures == null ? null : rounded(futures.net20d());

            Map<String, Object> row = new LinkedHashMap<>();
            row.put("key", key);
            row.put("label", label(key));
            row.put("spotToday", spotToday);
            row.put("spot5", spot5);
            row.put("spot20", spot20);
            row.put("futuresToday", futToday);
            row.put("futures5", fut5);
            row.put("futures20", fut20);
            row.put("verdictToday", sameDay ? verdict(spotToday, futToday) : "기준일 다름");
            row.put("verdict5", verdict(spot5, fut5));
            row.put("verdict20", verdict(spot20, fut20));
            rows.add(row);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("spotDate", spotDate);
        out.put("futuresDate", futuresDate);
        out.put("sameDay", sameDay);
        out.put("rows", rows);
        return out;
    }

    /** 방향 판정. 한쪽이라도 모르면 "판단 불가", 0이면 "중립". */
    static String verdict(Long spot, Long futures) {
        if (spot == null || futures == null) {
            return "판단 불가";
        }
        if (spot == 0 || futures == 0) {
            return "중립";
        }
        if (spot > 0 && futures > 0) {
            return "동반 순매수";
        }
        if (spot < 0 && futures < 0) {
            return "동반 순매도";
        }
        return spot > 0 ? "현물 매수 · 선물 매도" : "현물 매도 · 선물 매수";
    }

    private static Long rounded(Double value) {
        return value == null ? null : Math.round(value);
    }
}
