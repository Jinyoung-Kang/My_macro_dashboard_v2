package com.macrodash.feature.paper;

import com.macrodash.analytics.TradingCalendar;
import com.macrodash.read.StoreReader;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.SettingsRow;
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
 * 상수로 만들 수 없습니다 — 목록이 그 재료를 읽는 자리를 갖고, 실행 하나의 문맥을 엽니다({@link #open} — 그 실행의 설정 행을 한 번
 * 읽고, 그 판과 조용히 읽은 저장본으로 달력을 한 번 만듦). 운영 목록은 {@link #PRODUCTION}(지금 미국 하나)이고, 시험은 시장 목록을
 * 받는 생성자로 시험용 한국 묶음을 넣습니다.
 */
@Component
final class PaperMarkets {

    /** 운영에서 정기 작업이 도는 시장, 도는 순서. 한국 시장 묶음은 C1b에서 더합니다. */
    static final List<PaperMarket> PRODUCTION = List.of(UsPaperMarket.INSTANCE);

    private final PaperStore store;
    private final StoreReader reader;
    private final List<PaperMarket> markets;

    /** 운영 목록({@link #PRODUCTION}). */
    @Autowired
    PaperMarkets(PaperStore store, StoreReader reader) {
        this(store, reader, PRODUCTION);
    }

    /**
     * 시장 목록을 바꿉니다(시험이 시험용 한국 시장을 넣음).
     *
     * @throws IllegalArgumentException 목록이 비었거나 같은 시장 코드가 둘이거나 실행({@link MarketRun})이 섞임
     */
    PaperMarkets(PaperStore store, StoreReader reader, List<PaperMarket> markets) {
        this.store = store;
        this.reader = reader;
        if (markets == null || markets.isEmpty()) {
            throw new IllegalArgumentException("시장 목록이 비었습니다");
        }
        Set<String> codes = new HashSet<>();
        for (PaperMarket market : markets) {
            if (market instanceof MarketRun) {
                throw new IllegalArgumentException("시장 목록에는 시장 묶음만 둡니다(실행 아님): " + market);
            }
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

    /**
     * 실행 하나의 시장 문맥을 엽니다(클래스 설명) — 정기 작업 한 번·조회 한 번이 시작할 때 한 번 부르고, 그 실행을 장부·결정 파이프라인·
     * 조회에 넘깁니다. 설정 행을 한 번 읽고(테이블이 없으면 행 없이), 그 본문과 저장본 읽기({@link StoreReader#quietly} — 수집을 깨우지
     * 않음)로 시장 묶음이 달력을 한 번 만듭니다({@link PaperMarket#openCalendar}). 이미 연 실행을 받으면 그대로 돌려줍니다(한 실행이
     * 달력을 두 번 만들지 않게). 목록에 없는 시장 묶음도 엽니다(시험이 목록과 따로 부르는 시장).
     */
    MarketRun open(PaperMarket market) {
        if (market instanceof MarketRun run) {
            return run;
        }
        SettingsRow row = store.ready() ? store.settings().orElse(null) : null;
        MarketRun.Inputs inputs = new MarketRun.Inputs(row == null ? null : row.body(),
                (dataset, maxAgeSeconds, task) -> reader.quietly(() -> reader.read(dataset, maxAgeSeconds, task)));
        TradingCalendar calendar = market.openCalendar(inputs);
        return new MarketRun(market, calendar, row);
    }
}
