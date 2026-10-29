package com.macrodash.feature.paper;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 🧪 모의 매매 장중 평가(운영자 전용, 표시 전용 추정).
 *
 * <pre>
 *  GET  /api/paper/live?market=US   계좌·종목의 장중 평가(정규장이면 최신 1분봉, 아니면 장부의 마지막 관측치)·장 상태·시세 기준 시각
 * </pre>
 *
 * <p>정규장에 부르면 시세가 60초보다 오래됐을 때 수집기에 장중 시세를 요청하고({@code quotes.refreshRequested}) 기존 값을 먼저 돌려줍니다.
 * 장부는 이 값을 쓰지 않습니다({@link PaperLiveService}). {@code market}이 없으면 미국, 모르는 값은 400.
 */
@RestController
@RequestMapping("/api/paper")
public class PaperLiveController {

    private final PaperLiveService live;

    public PaperLiveController(PaperLiveService live) {
        this.live = live;
    }

    @GetMapping("/live")
    public Map<String, Object> live(@RequestParam(required = false) String market) {
        return live.live(market);
    }
}
