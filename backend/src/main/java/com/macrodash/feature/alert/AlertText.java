package com.macrodash.feature.alert;

import com.macrodash.analytics.AlertRules;
import com.macrodash.analytics.Holding;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 알림 문구 — 순수 함수(명세 §4-5). 근거·기준일·출처 성격·한계를 담고, 매수·매도 같은 행동 지시는 쓰지 않습니다
 * (금지어는 테스트가 검사). 금액은 조·억, 날짜는 KST 날짜입니다.
 */
final class AlertText {

    private AlertText() {
    }

    static final String DISCLAIMER = "투자 권유가 아닙니다. 판정 근거와 한계는 대시보드 화면에서 확인하세요.";

    record Text(String title, String body) {
    }

    static Text regime(AlertRules.RegimeChange change, Map<String, String> inputs, int changesIn90Days) {
        List<String> lines = new ArrayList<>();
        lines.add("확정 %s — 새 판정이 %s부터 기록 %d일 연속(하루 이틀 바뀌었다 돌아오는 것은 알리지 않음)"
                .formatted(change.confirmedOn(), change.startedOn(), AlertRules.REGIME_CONFIRM_DAYS));
        if (!inputs.isEmpty()) {
            lines.add("근거(%s 기록): %s".formatted(change.confirmedOn(), String.join(" · ", inputs.values())));
        }
        lines.add("최근 90일 확정 전환 %d회 · 입력: FRED 공식(금리차·NFCI·하이일드·순유동성)".formatted(changesIn90Days));
        lines.add(DISCLAIMER + " (시장 국면)");
        return new Text("[국면 전환] %s → %s".formatted(shortLabel(change.fromLabel()), shortLabel(change.toLabel())),
                String.join("\n", lines));
    }

    static Text foreignStreak(String targetLabel, boolean stock, AlertRules.StreakHit hit, Long sumNet) {
        String unit = stock ? "주" : "원";
        List<String> lines = new ArrayList<>();
        lines.add("기준일 %s · 확정 기록 기준(당일 잠정치 제외)".formatted(hit.date()));
        if (sumNet != null) {
            lines.add("최근 %d일 외국인 순매수 합계 %s".formatted(hit.days(), stock ? shares(sumNet) : won(sumNet)));
        }
        lines.add(stock ? "외국인 범위: 등록 외국인(종목별 매매동향) · 단위 " + unit
                : "외국인 범위: 등록 + 비등록 외국인(시장 전체) · 단위 " + unit);
        lines.add("출처: 토스증권 투자자별 매매(확정 기록) · " + DISCLAIMER);
        return new Text("[외국인 %d일 연속 순매수] %s".formatted(hit.days(), targetLabel), String.join("\n", lines));
    }

    static Text institutionNew(String institution, String reportDate, String filingDate, List<Holding> added) {
        List<String> lines = new ArrayList<>();
        lines.add("기준 분기 %s · 공시 %s (분기 종료 후 최대 45일 지연 공시)".formatted(reportDate, filingDate));
        List<String> top = new ArrayList<>();
        for (Holding holding : added.subList(0, Math.min(10, added.size()))) {
            top.add(holding.weight() == null ? holding.name()
                    : "%s(%.2f%%)".formatted(holding.name(), holding.weight()));
        }
        lines.add("직전 분기에 없던 종목 %d개%s".formatted(added.size(),
                top.isEmpty() ? "" : " — 평가액 상위: " + String.join(", ", top)));
        lines.add("SEC EDGAR 13F-HR 원본 공시 기준(정정 공시 미반영, 미국 상장 롱 포지션만) · " + DISCLAIMER);
        return new Text("[13F 신규 편입] %s — %d종목".formatted(institution, added.size()), String.join("\n", lines));
    }

    /** 판정 기록의 입력을 근거 문구로(화면 lib/regime.ts와 같은 단위). 값을 모르면 그 입력은 빼고 적습니다. */
    static Map<String, String> regimeInputs(tools.jackson.databind.JsonNode inputs) {
        Map<String, String> out = new java.util.LinkedHashMap<>();
        if (inputs == null) {
            return out;
        }
        Double curve = number(inputs.path("curve10y3m").path("value"));
        Double nfci = number(inputs.path("nfci").path("value"));
        Double hy = number(inputs.path("hyOas").path("value"));
        Double liquidity = number(inputs.path("liquidity4w").path("value"));
        if (curve != null) out.put("curve", "10Y-3M %+.2f%%p".formatted(curve));
        if (nfci != null) out.put("nfci", "NFCI %+.2f".formatted(nfci));
        if (hy != null) out.put("hy", "하이일드 %.2f%%p".formatted(hy));
        if (liquidity != null) out.put("liquidity", "순유동성 4주 %s".formatted(trillionDelta(liquidity)));
        return out;
    }

    private static Double number(tools.jackson.databind.JsonNode node) {
        return node == null || node.isMissingNode() || node.isNull() || !node.isNumber() ? null : node.asDouble();
    }

    /** 조 달러 변화 → "+144.2억 달러"·"-1.20조 달러". */
    static String trillionDelta(double trillions) {
        String sign = trillions < 0 ? "-" : "+";
        double abs = Math.abs(trillions);
        return abs >= 1 ? "%s%,.2f조 달러".formatted(sign, abs) : "%s%,.1f억 달러".formatted(sign, abs * 1e4);
    }

    /** "확장 (Expansion)" → "확장". */
    static String shortLabel(String label) {
        if (label == null) {
            return "—";
        }
        int paren = label.indexOf(" (");
        return paren > 0 ? label.substring(0, paren) : label;
    }

    /** 원 금액을 조·억으로(PRINCIPLES "한국식 단위"). */
    static String won(long value) {
        String sign = value < 0 ? "-" : "+";
        double abs = Math.abs((double) value);
        if (abs >= 1e12) {
            return "%s%,.2f조 원".formatted(sign, abs / 1e12);
        }
        return "%s%,.1f억 원".formatted(sign, abs / 1e8);
    }

    static String shares(long value) {
        return String.format(Locale.ROOT, "%s%,d주", value < 0 ? "-" : "+", Math.abs(value));
    }
}
