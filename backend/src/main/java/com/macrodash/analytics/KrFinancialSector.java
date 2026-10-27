package com.macrodash.analytics;

import java.util.Collections;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

/**
 * 🧪 한국 규칙 계좌의 금융업 코드 표 — 이 표의 회사는 부채비율 상한({@code kr.rules.debtRatioMaxPct})을 보지 않습니다(ROE &gt; 0은 그대로).
 * 2단계 명세 2026-10-26-v2-kr-paper-spec.md §4-6 'D2a', 사용자 결정 2026-10-28(u1 — '매출액 계정 없음'·'유동자산 계정 없음' 대신 코드 표).
 *
 * <p><b>출처</b>: 금융감독원 Open DART 기업개황({@code company.json})의 {@code induty_code}(한국표준산업분류 코드) — 2026-10-28 05:34 KST에
 * 읽기 전용으로 147회 조회. 조회 대상 = 수집기 {@code kr_paper_universe} 이력의 모든 코드(기준일 2026-10-26 한 판, 100) ∪ 금융위 주식시세
 * 2026-10-26 코스피 시가총액 상위 150(합집합 150 — DART 고유번호 표에 없는 우선주 005385·005387·005935 셋은 조회하지 않음).
 *
 * <p><b>기준</b>: 표준산업분류 대분류 K(금융 및 보험업 — {@code induty_code} 앞 두 자리 64·65·66). 단 <b>64992(지주회사)는 금융지주회사만</b> 넣습니다 —
 * [확인] DART는 비금융 지주회사도 64992로 줍니다(LG·SK·GS·CJ·LS·HD현대·HD한국조선해양·한진칼·SK스퀘어·한미사이언스·OCI홀딩스 11곳 —
 * 산업분류 70이 아님). 64992 가운데 DART 회사명에 '금융지주'가 있는 9곳만 넣었고, 9곳 모두 DART 주요계정에 '유동자산' 계정이 없습니다
 * (금융업식 재무상태표 — 비금융 지주 11곳 중 저장본에 있는 10곳은 모두 있음).
 *
 * <p><b>표 밖 금융사</b>: 조회 범위(U 이력 ∪ 2026-10-26 코스피 시총 상위 150) 밖에 있던 이미 상장된 금융사(예: 케이뱅크 279570·신영증권
 * 001720·대신증권 003540 — 2026-10-26 코스피 시총 156·162·218위)와 그 뒤 상장·업종이 바뀐 금융사는 표를 고칠 때까지 비금융으로 보고
 * 상한을 적용합니다. {@link KrRules}가 부채비율로 빼는 표 밖 회사에 '유동자산' 계정이 없으면 빠진 사유에
 * {@link KrRules#FINANCIAL_TABLE_CHECK}를 붙입니다 — 2026-10-28 로컬 DART 저장본에서 '유동자산' 계정이 없는 19곳은 모두 표 안입니다.
 * 표를 고치면 {@link #VERSION}을 바꿉니다(결정 행 동결에 남음).
 */
public final class KrFinancialSector {

    /** 표의 판 — 결정 행 입력 동결({@code input.financialSectorTable})에 남깁니다. */
    public static final String VERSION = "dart-ksic-K/2026-10-28";

    /** 표 밖 회사의 경고에 쓰는 DART 주요계정 이름(금융업식 재무상태표에는 없음). */
    public static final String CURRENT_ASSETS = "유동자산";

    /**
     * 표의 한 회사.
     *
     * @param name DART 기업개황 {@code stock_name}
     * @param ksic DART 기업개황 {@code induty_code}
     */
    public record Company(String name, String ksic) {
    }

    private static final Map<String, Company> TABLE = Collections.unmodifiableMap(new TreeMap<>(Map.ofEntries(
            // 64 금융업 — 은행
            Map.entry("024110", new Company("기업은행", "64121")),
            Map.entry("323410", new Company("카카오뱅크", "64121")),
            // 64 금융업 — 투융자회사(수집기 유니버스 제외 코드 표에 있어 U에 들지 않음 — 기준대로 넣음)
            Map.entry("088980", new Company("맥쿼리인프라", "64201")),
            // 64 금융업 — 신용카드
            Map.entry("029780", new Company("삼성카드", "64913")),
            // 64 금융업 — 금융지주회사(64992 중 DART 회사명 '금융지주')
            Map.entry("055550", new Company("신한지주", "64992")),
            Map.entry("071050", new Company("한국금융지주", "64992")),
            Map.entry("086790", new Company("하나금융지주", "64992")),
            Map.entry("105560", new Company("KB금융", "64992")),
            Map.entry("138040", new Company("메리츠금융지주", "64992")),
            Map.entry("138930", new Company("BNK금융지주", "64992")),
            Map.entry("139130", new Company("iM금융지주", "64992")),
            Map.entry("175330", new Company("JB금융지주", "64992")),
            Map.entry("316140", new Company("우리금융지주", "64992")),
            // 65 보험업
            Map.entry("032830", new Company("삼성생명", "65110")),
            Map.entry("085620", new Company("미래에셋생명", "65110")),
            Map.entry("088350", new Company("한화생명", "65110")),
            Map.entry("000810", new Company("삼성화재해상보험", "65121")),
            Map.entry("001450", new Company("현대해상", "65121")),
            Map.entry("005830", new Company("DB손해보험", "65121")),
            Map.entry("031210", new Company("서울보증보험", "65122")),
            Map.entry("003690", new Company("코리안리", "65200")),
            // 66 금융 및 보험 관련 서비스업 — 증권·지급결제
            Map.entry("005940", new Company("NH투자증권", "66121")),
            Map.entry("006800", new Company("미래에셋증권", "66121")),
            Map.entry("016360", new Company("삼성증권", "66121")),
            Map.entry("039490", new Company("키움증권", "66121")),
            Map.entry("377300", new Company("카카오페이", "66199")))));

    private KrFinancialSector() {
    }

    /** 표의 회사인가(부채비율 상한을 보지 않음). */
    public static boolean contains(String code) {
        return code != null && TABLE.containsKey(code);
    }

    /** 표의 그 회사. */
    public static Optional<Company> get(String code) {
        return code == null ? Optional.empty() : Optional.ofNullable(TABLE.get(code));
    }

    /** 표 전체(코드 순, 읽기 전용). */
    public static Map<String, Company> table() {
        return TABLE;
    }
}
