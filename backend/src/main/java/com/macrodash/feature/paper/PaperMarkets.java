package com.macrodash.feature.paper;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * 🧪 모의 매매 시장 목록(주입 빈 — 2단계 명세 §9 묶음 A 리뷰 메모 'C1 — 시장 목록과 실행마다 달력 한 벌') — 리스크 점검(A5)·결정·주간
 * 복기(A6) 정기 실행이 {@link #all}의 순서로 시장마다 한 번씩 돌고, 계좌 행의 시장 코드로 시장 묶음을 찾을 때도({@link #of}) 이 목록을
 * 봅니다. 새 {@code @Scheduled}를 만들지 않고 기존 작업이 시장을 차례로 돕니다(스케줄러 풀 4에 작업 11개).
 *
 * <p>정적 목록이 아니라 빈인 까닭: 한국 시장 묶음(C1b의 {@code KrPaperMarket})의 달력은 저장본({@code kr_holidays})과 설정 판에 기대므로
 * 상수로 만들 수 없습니다 — 목록이 그 재료를 읽는 자리를 갖습니다. 운영 목록은 {@link #PRODUCTION}(지금 미국 하나)이고, 시험은
 * 시장 목록을 받는 생성자로 시험용 한국 묶음을 넣습니다.
 */
@Component
final class PaperMarkets {

    /** 운영에서 정기 작업이 도는 시장, 도는 순서. 한국 시장 묶음은 C1b에서 더합니다. */
    static final List<PaperMarket> PRODUCTION = List.of(UsPaperMarket.INSTANCE);

    private final List<PaperMarket> markets;

    /** 운영 목록({@link #PRODUCTION}). */
    @Autowired
    PaperMarkets() {
        this(PRODUCTION);
    }

    /**
     * 시장 목록을 바꿉니다(시험이 시험용 한국 시장을 넣음).
     *
     * @throws IllegalArgumentException 목록이 비었거나 같은 시장 코드가 둘
     */
    PaperMarkets(List<PaperMarket> markets) {
        if (markets == null || markets.isEmpty()) {
            throw new IllegalArgumentException("시장 목록이 비었습니다");
        }
        Set<String> codes = new HashSet<>();
        for (PaperMarket market : markets) {
            if (!codes.add(market.code())) {
                throw new IllegalArgumentException("같은 시장 코드가 둘입니다: " + market.code());
            }
        }
        this.markets = List.copyOf(markets);
    }

    /** 정기 작업이 도는 시장, 도는 순서. */
    List<PaperMarket> all() {
        return markets;
    }

    /** 시장 코드({@code paper_books.market})의 시장 묶음 — 목록에 없으면 empty. */
    Optional<PaperMarket> of(String code) {
        return markets.stream().filter(market -> market.code().equals(code)).findFirst();
    }
}
