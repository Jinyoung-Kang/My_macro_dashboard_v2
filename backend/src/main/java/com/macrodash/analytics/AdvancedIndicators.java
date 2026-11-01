package com.macrodash.analytics;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 심화 매크로 지표 6종의 정의와 해석 임계치.
 *
 * <p>왜 이 6개인가 — 기존 지표(명목금리·하이일드·STLFSI4)에는 세 가지 사각지대가
 * 있습니다.
 * <ol>
 *   <li>명목금리만으로는 "인플레 기대가 오른 것"과 "실질 긴축이 강해진 것"을
 *       구분할 수 없습니다 → DFII10(실질금리) + T10YIE(기대인플레)로 분해</li>
 *   <li>장단기 금리차를 10Y-2Y로만 봅니다. 뉴욕 연준 침체확률 모델이 실제로
 *       쓰는 것은 10Y-3M입니다 → T10Y3M 추가</li>
 *   <li>신용 스트레스를 하이일드로만 봅니다. 경색은 보통 투자등급에서 먼저
 *       번집니다 → BAMLC0A0CM(IG 스프레드) 추가</li>
 *   <li>10Y-3M은 역전에서 먼저 벗어납니다. 만기 축을 30년까지 넓히면 장기
 *       기대가 실제로 돌아왔는지 따로 확인할 수 있습니다 → T30Y3M 추가</li>
 * </ol>
 * NFCI는 STLFSI4와 구성이 달라, 두 지수가 갈라지는 것 자체가 신호입니다.
 *
 * <p>주의: 임계치는 역사적 분포에 근거한 <b>참고치</b>이며 투자 판단의 근거가 아닙니다.
 */
public final class AdvancedIndicators {

    private AdvancedIndicators() {
    }

    /** 화면 카드 배치 순서. 가나다순이 아니라 중요도 순입니다(머리기사는 10Y-3M). */
    public static final List<String> DISPLAY_ORDER =
            List.of("T10Y3M", "T30Y3M", "DFII10", "T10YIE", "BAMLC0A0CM", "NFCI");

    public record Meta(String id, String label, String unit, int digits,
                       String group, String why, String source) {
    }

    public static final Map<String, Meta> SERIES = buildSeries();

    private static Map<String, Meta> buildSeries() {
        Map<String, Meta> map = new LinkedHashMap<>();
        map.put("T10Y3M", new Meta("T10Y3M", "장단기 금리차 10Y-3M", "%p", 3, "금리 구조",
                "뉴욕 연준 침체확률 모델이 쓰는 스프레드입니다. 10Y-2Y보다 침체 예측력이 "
                        + "높다는 것이 연준 리서치의 정설입니다.",
                "FRED T10Y3M (일간)"));
        // FRED에 T30Y3M이라는 시리즈는 없습니다. DGS30 − DGS3MO로 우리가 계산합니다
        // (계산 규칙은 MacroService.DERIVED_SPREADS).
        map.put("T30Y3M", new Meta("T30Y3M", "장단기 금리차 30Y-3M", "%p", 3, "금리 구조",
                "10Y-3M보다 만기 축이 훨씬 넓어, 장기 기대(성장·인플레·기간 프리미엄)와 "
                        + "현재 통화정책의 격차를 더 크게 보여 줍니다. 10Y-3M이 역전에서 "
                        + "벗어난 뒤에도 30Y-3M이 눌려 있으면 장기 기대가 아직 돌아오지 "
                        + "않았다는 뜻입니다.",
                "FRED DGS30 − DGS3MO (일간, 우리가 계산)"));
        map.put("DFII10", new Meta("DFII10", "10년 실질금리 (TIPS)", "%", 3, "금리 구조",
                "명목금리에서 인플레 기대를 걷어낸 값입니다. 금·장기 성장주 밸류에이션에 "
                        + "가장 직접적으로 작용합니다.",
                "FRED DFII10 (일간)"));
        map.put("T10YIE", new Meta("T10YIE", "10년 기대인플레이션 (BEI)", "%", 3, "금리 구조",
                "명목 = 실질 + 기대인플레. 금리 상승의 원인이 성장/긴축인지 인플레 "
                        + "기대인지 분해해 줍니다.",
                "FRED T10YIE (일간)"));
        map.put("BAMLC0A0CM", new Meta("BAMLC0A0CM", "투자등급(IG) 회사채 스프레드", "%", 2, "신용",
                "신용 경색은 보통 IG에서 먼저 번집니다. 하이일드만 보면 초기 단계를 "
                        + "놓칩니다.",
                "FRED BAMLC0A0CM (일간 · ICE BofA 시리즈라 FRED는 최근 3년만 제공)"));
        map.put("NFCI", new Meta("NFCI", "시카고 연준 금융상황지수", "", 3, "금융상황",
                "STLFSI4와 구성 지표가 다릅니다. 두 지수가 갈라지는 것 자체가 신호이며, "
                        + "0보다 크면 평균보다 긴축적입니다.",
                "FRED NFCI (주간)"));
        return Map.copyOf(map);
    }

    public record Interpretation(String status, String color, String note) {
    }

    /** 지표별 해석. 해석 규칙이 없는 지표는 null. */
    public static Interpretation interpret(String seriesId, double value) {
        return switch (seriesId) {
            case "T10Y3M" -> interpretT10Y3M(value);
            // 30Y-3M도 부호의 의미는 같습니다(역전=긴축이 장기 기대를 넘어섬).
            // 다만 만기 축이 넓어 평상시 값 자체가 더 크므로 '평탄' 기준만 넓힙니다.
            case "T30Y3M" -> interpretT30Y3M(value);
            case "DFII10" -> interpretRealRate(value);
            case "BAMLC0A0CM" -> interpretIgSpread(value);
            case "NFCI" -> interpretNfci(value);
            default -> null;
        };
    }

    static Interpretation interpretT10Y3M(double value) {
        if (value < -0.5) {
            return new Interpretation("깊은 역전", "red",
                    "역사적으로 1~2년 내 침체가 뒤따른 구간입니다. 뉴욕 연준 모델의 "
                            + "침체확률이 크게 높아집니다.");
        }
        if (value < 0) {
            return new Interpretation("역전", "orange",
                    "단기금리가 장기금리를 넘었습니다. 시장이 향후 금리 인하(=경기 둔화)를 "
                            + "가격에 반영하고 있습니다.");
        }
        if (value < 0.5) {
            return new Interpretation("평탄", "blue",
                    "역전에서 벗어났거나 진입 직전입니다. 역전 해소 직후가 오히려 침체 "
                            + "시작과 겹친 사례가 많습니다.");
        }
        return new Interpretation("정상", "green",
                "장기금리가 단기금리보다 높은 정상 구조입니다.");
    }

    static Interpretation interpretT30Y3M(double value) {
        if (value < -0.5) {
            return new Interpretation("깊은 역전", "red",
                    "30년물이 3개월물보다 크게 낮습니다. 장기 성장·인플레 기대가 현재 "
                            + "정책금리 수준을 한참 밑돈다는 뜻입니다.");
        }
        if (value < 0) {
            return new Interpretation("역전", "orange",
                    "만기 축 전체가 눌려 있습니다. 10Y-3M보다 늦게 역전되고 늦게 풀립니다.");
        }
        if (value < 1.0) {
            return new Interpretation("평탄", "blue",
                    "장기 프리미엄이 거의 없습니다. 역전 해소 직후이거나 진입 직전입니다.");
        }
        return new Interpretation("정상", "green",
                "장기물이 단기물보다 충분히 높은 정상 구조입니다.");
    }

    static Interpretation interpretRealRate(double value) {
        if (value < 0) {
            return new Interpretation("마이너스", "green",
                    "실질금리가 음수입니다. 현금 보유의 실질 가치가 줄어들어 금·실물자산에 "
                            + "우호적입니다.");
        }
        if (value < 1.0) {
            return new Interpretation("완화적", "blue",
                    "실질금리가 낮아 위험자산에 부담이 적습니다.");
        }
        if (value < 2.0) {
            return new Interpretation("중립", "orange",
                    "실질금리가 역사적 중립 구간 상단입니다. 고밸류 성장주에 부담이 "
                            + "시작됩니다.");
        }
        return new Interpretation("긴축적", "red",
                "실질금리가 높습니다. 장기 성장주·금에 구조적 역풍입니다.");
    }

    static Interpretation interpretIgSpread(double value) {
        if (value < 1.0) {
            return new Interpretation("과열", "orange",
                    "IG 스프레드가 매우 좁습니다. 신용 위험 대비 보상이 적어 되돌림에 "
                            + "취약합니다.");
        }
        if (value < 1.5) {
            return new Interpretation("정상", "green", "투자등급 신용시장이 안정적입니다.");
        }
        if (value < 2.0) {
            return new Interpretation("경계", "orange",
                    "IG까지 스프레드가 벌어지고 있습니다. 신용 스트레스가 고위험 등급을 "
                            + "넘어 번지는 단계입니다.");
        }
        return new Interpretation("위기", "red",
                "투자등급에서도 자금조달 비용이 급등했습니다. 본격적인 신용경색 신호입니다.");
    }

    static Interpretation interpretNfci(double value) {
        if (value < -0.5) {
            return new Interpretation("매우 완화", "green",
                    "금융상황이 역사적 평균보다 크게 완화적입니다.");
        }
        if (value < 0) {
            return new Interpretation("완화", "blue", "평균보다 완화적인 금융상황입니다.");
        }
        if (value < 0.5) {
            return new Interpretation("긴축", "orange",
                    "평균보다 긴축적입니다. 0을 넘은 구간은 위험자산에 역풍입니다.");
        }
        return new Interpretation("심한 긴축", "red",
                "금융상황이 크게 긴축적입니다. 과거 위기 국면과 겹치는 수준입니다.");
    }
}
