package com.macrodash.feature.paper;

import java.util.List;
import java.util.Optional;

/**
 * 🧪 모의 매매 시장 목록 — 리스크 점검 정기 실행이 이 순서로 시장마다 한 번씩 돕니다(2단계 명세 §9 A5). 새 {@code @Scheduled}를
 * 만들지 않고 기존 작업이 시장을 차례로 돕니다(스케줄러 풀 4에 작업 11개).
 *
 * <p>지금은 미국 하나입니다 — 한국 시장 묶음은 C1에서 더합니다. 그 전까지 목록이 미국뿐이라 정기 작업의 동작은 이 묶음 전과
 * 같습니다.
 */
final class PaperMarkets {

    private PaperMarkets() {
    }

    /** 정기 작업이 도는 시장, 도는 순서. */
    static final List<PaperMarket> ALL = List.of(UsPaperMarket.INSTANCE);

    /** 시장 코드({@code paper_books.market})의 시장 묶음 — {@link #ALL}에 없으면 empty. */
    static Optional<PaperMarket> of(String code) {
        return ALL.stream().filter(market -> market.code().equals(code)).findFirst();
    }
}
