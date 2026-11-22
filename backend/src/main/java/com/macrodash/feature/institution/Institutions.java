package com.macrodash.feature.institution;

import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Params;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 추적하는 13F 기관 목록 — 상수.
 *
 * <p>13F 서비스·구루 서비스·원본 텍스트·컨트롤러가 모두 이 목록을 봅니다. 예전에는
 * Sec13FService의 정적 멤버였는데, 목록 하나 때문에 다른 기능이 13F 서비스 전체에
 * 의존했습니다.
 */
public final class Institutions {

    /** {@code key, name, cik, desc}. 순서는 화면 목록 순서입니다. */
    public static final List<Map<String, String>> ALL = build();

    private Institutions() {
    }

    public static Map<String, Object> list() {
        return Map.of("institutions", ALL);
    }

    public static List<String> ciks() {
        return ALL.stream().map(entry -> entry.get("cik")).toList();
    }

    public static Map<String, String> byCik(String cik) {
        return ALL.stream()
                .filter(entry -> cik.equals(entry.get("cik")))
                .findFirst()
                .orElse(Map.of("cik", cik, "name", cik, "desc", ""));
    }

    /** 13F 메뉴(이 목록)의 기관 CIK인가. */
    public static boolean isKnownCik(String cik) {
        return cik != null && ALL.stream().anyMatch(entry -> entry.get("cik").equals(cik));
    }

    /**
     * 추적하는 기관의 CIK인지 확인합니다.
     *
     * <p>모르는 CIK는 저장본이 있을 수 없는데, 예전에는 그대로 저장본을 찾다가 "없음" →
     * 13F 전체 수집을 동기로 기다렸습니다(재현: CIK 하나에 수집 2회, 세 개면 6회·30초).
     *
     * @throws InvalidRequestException 목록에 없는 CIK
     */
    public static void requireKnownCik(String cik) {
        if (!isKnownCik(cik)) {
            throw new InvalidRequestException("추적하지 않는 기관 CIK입니다: " + Params.echo(cik)
                    + " (/api/sec13f/institutions 목록의 cik를 쓰세요)");
        }
    }

    private static List<Map<String, String>> build() {
        List<Map<String, String>> list = new ArrayList<>();
        list.add(inst("nps", "🇰🇷 국민연금 (National Pension Service)", "0001608046",
                "글로벌 자산배분 및 미국 대형 우량주 중심 장기 투자"));
        list.add(inst("norges", "🇳🇴 노르웨이 국부펀드 (Norges Bank / GPFG)", "0001374170",
                "세계 최대 규모의 글로벌 국부펀드, 인덱스형 거인"));
        list.add(inst("cppib", "🇨🇦 캐나다 연금투자위원회 (CPPIB)", "0001283718",
                "캐나다 연금을 운용하는 대형 연기금, 글로벌 자산배분 중심"));
        list.add(inst("apg", "🇳🇱 네덜란드 연금자산운용 (APG Asset Management)", "0001434819",
                "네덜란드 최대 연기금 자산운용사, 글로벌 분산투자"));
        list.add(inst("pif", "🇸🇦 사우디 국부펀드 (Public Investment Fund - PIF)", "0001767640",
                "대규모 글로벌 전략적 투자, 공격적 성장 베팅"));
        list.add(inst("blackrock", "🇺🇸 블랙록 (BlackRock)", "0002012383",
                "세계 최대 자산운용사, 광범위한 글로벌 자산군"));
        list.add(inst("vanguard", "🇺🇸 뱅가드 (Vanguard Group)", "0000102909",
                "글로벌 인덱스 펀드의 거두, 시장 전체를 아우르는 포트폴리오 (2026년부터 자회사 둘의 공시 합산)"));
        list.add(inst("berkshire", "🇺🇸 버크셔 해서웨이 (Berkshire Hathaway)", "0001067983",
                "가치투자 포트폴리오, 핵심 우량주 집중"));
        list.add(inst("duquesne", "🇺🇸 듀케인 패밀리 오피스 (Duquesne Family Office)", "0001536411",
                "스탠리 드러켄밀러, 테크 트렌드 포착형 매크로 운용"));
        list.add(inst("fisher", "🇺🇸 피셔 자산운용 (Fisher Asset Management)", "0000850529",
                "켄 피셔의 글로벌 성장주·빅테크 중심 탑다운 롱온리 전략"));
        list.add(inst("bridgewater", "🇺🇸 브리지워터 어소시에이츠 (Bridgewater)", "0001350694",
                "레이 달리오 설립, 올웨더 및 글로벌 매크로 헤지펀드"));
        list.add(inst("scion", "🇺🇸 사이언 자산운용 (Scion Asset Management)", "0001649339",
                "마이클 버리의 역발상 딥밸류 및 숏/롱 전략"));
        return List.copyOf(list);
    }

    private static Map<String, String> inst(String key, String name, String cik, String desc) {
        return Map.of("key", key, "name", name, "cik", cik, "desc", desc);
    }
}
