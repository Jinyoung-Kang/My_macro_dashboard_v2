package com.macrodash.analytics;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 외국인·기관이 <b>같은 방향</b>으로 움직인 종목.
 *
 * <p>한쪽만 사는 종목과, 둘이 함께 사는 종목은 뜻이 다릅니다. 외국인 상위
 * 목록과 기관 상위 목록을 따로 보면 겹치는 종목을 눈으로 대조해야 하고,
 * 30개씩 두 표를 오가며 맞춰 보는 일은 실제로 잘 안 됩니다.
 *
 * <p><b>이 계산이 볼 수 없는 것</b> — 두 <b>상위 N개 목록의 교집합</b>입니다.
 * 외국인 상위 30위 밖에서 조용히 사들인 종목은 기관이 1위로 샀더라도 여기
 * 나오지 않습니다. 소스(Daum·Naver)가 상위 목록만 주고 전체 종목의 수급을
 * 주지 않기 때문입니다. 화면은 이 한계를 반드시 함께 적습니다.
 */
public final class SupplyConsensus {

    private SupplyConsensus() {
    }

    /**
     * 수급 상위 목록의 한 행. 값을 모르면 null.
     *
     * @param code         종목코드 (맞추는 키)
     * @param name         종목명
     * @param price        현재가
     * @param changePct    등락률(%)
     * @param netAmountEok 순매수 금액(억 원)
     * @param rank         순위
     */
    public record Row(String code, String name, Double price, Double changePct,
                      Double netAmountEok, Double rank) {
    }

    /**
     * 두 목록에 모두 있는 종목을 한 줄로 합칩니다.
     *
     * @param foreign     외국인 수급 상위 목록 (code·name·netAmountEok·rank 필드 사용)
     * @param institution 기관 수급 상위 목록. 같은 매매 구분이어야 합니다
     * @return 겹치는 종목만, <b>합계 금액의 크기</b> 순. 순매도는 값이 음수라
     *         크기로 정렬해야 "가장 많이 판 종목"이 위로 옵니다.
     *
     * <p>맞추는 키는 <b>종목코드</b>입니다. 종목명은 소스마다 표기가 갈리고
     * ("삼성전자우" / "삼성전자 우"), 이름으로 추측해 맞추면 엉뚱한 종목이 한 줄에
     * 섞입니다. 코드가 없는 행은 버립니다.
     *
     * <p>한쪽 금액이 없으면 {@code totalEok}가 null입니다 — 0으로 채우면 "기관은
     * 안 샀다"가 아니라 "기관이 0억 샀다"로 읽힙니다.
     */
    public static List<Map<String, Object>> intersect(List<Row> foreign, List<Row> institution) {
        Map<String, Row> byCode = new LinkedHashMap<>();
        for (Row row : institution) {
            String code = row.code();
            if (code != null && !code.isBlank()) {
                byCode.putIfAbsent(code, row);
            }
        }

        List<Map<String, Object>> out = new ArrayList<>();
        for (Row row : foreign) {
            String code = row.code();
            if (code == null || code.isBlank()) {
                continue;
            }
            Row other = byCode.get(code);
            if (other == null) {
                continue;
            }

            Double foreignEok = row.netAmountEok();
            Double institutionEok = other.netAmountEok();

            Map<String, Object> merged = new LinkedHashMap<>();
            merged.put("code", code);
            merged.put("name", row.name());
            merged.put("price", row.price());
            merged.put("changePct", row.changePct());
            merged.put("foreignEok", foreignEok);
            merged.put("institutionEok", institutionEok);
            // 한쪽 금액이 없으면 합계를 만들지 않습니다. 없는 값을 0으로 두면
            // "기관은 안 샀다"가 아니라 "기관이 0억 샀다"로 읽힙니다.
            merged.put("totalEok",
                    (foreignEok == null || institutionEok == null)
                            ? null : foreignEok + institutionEok);
            merged.put("foreignRank", intOrNull(row));
            merged.put("institutionRank", intOrNull(other));
            out.add(merged);
        }

        out.sort(Comparator.comparingDouble(SupplyConsensus::magnitude).reversed());
        return out;
    }

    private static double magnitude(Map<String, Object> row) {
        Object total = row.get("totalEok");
        return total instanceof Number number ? Math.abs(number.doubleValue()) : 0.0;
    }

    private static Integer intOrNull(Row row) {
        Double rank = row.rank();
        return rank == null ? null : (int) Math.round(rank);
    }
}
