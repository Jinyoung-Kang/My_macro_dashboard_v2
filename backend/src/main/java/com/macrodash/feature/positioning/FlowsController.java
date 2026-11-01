package com.macrodash.feature.positioning;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 투자자별 매매 (토스증권 공식 Open API).
 *
 * <p>메뉴별 컨트롤러(PositioningController 등)와 나눈 이유 — 출처(토스 키 하나)가 같은 것끼리 묶어 두면,
 * 키가 없을 때 어떤 화면이 비는지가 이 파일 하나로 보입니다(PublicDataController와 같은 원칙).
 * 모든 경로는 저장본만 읽습니다. 화면이 토스를 직접 부르지 않습니다.
 */
@RestController
@RequestMapping("/api")
public class FlowsController {

    private final KrFlowsService flows;

    public FlowsController(KrFlowsService flows) {
        this.flows = flows;
    }

    /** 코스피·코스닥 시장 전체 투자자별 매매대금 (원) — 수급 레이더. */
    @GetMapping("/kr/investor-flows")
    public Map<String, Object> marketFlows() {
        return flows.marketFlows();
    }

    /**
     * 종목별 투자자 매매동향 (주, 최근 20거래일) — 수급 레이더.
     *
     * @param codes 쉼표로 구분한 6자리 종목코드 (최대 60개, 형식이 틀린 코드는 무시)
     */
    @GetMapping("/kr/stock-flows")
    public Map<String, Object> stockFlows(@RequestParam(defaultValue = "") String codes) {
        return flows.stockFlows(codes);
    }

    /** 코스피 현물(토스) × KOSPI200 선물(Daum) 투자자별 방향 비교 — 국내 파생. */
    @GetMapping("/krx/spot-futures")
    public Map<String, Object> spotFutures() {
        return flows.spotFutures();
    }
}
