package com.macrodash.feature.paper;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 모의 매매 장중 판단의 수동 경로(운영자 전용 — 자유 시점 판, ADR 0027 결정 3). 결정·시작 버튼은 {@link PaperDecisionController}입니다(한 컨트롤러가
 * 서비스를 다섯 개 넘게 받지 않게 나눔).
 *
 * <pre>
 *  POST /api/paper/run/intraday?market=US   {"book"} 그 계좌의 오늘 세션 장중 판단을 지금으로 당김 — 예약만 하고, Claude 호출은 장중 판단 작업이
 *                                           그 시각 + 2분 뒤 창에서 한 번(수동 문턱). 미국은 claude·claude2, 한국은 kr_claude·kr_claude2
 * </pre>
 *
 * <p>거절은 {@link IntradayManualService}의 400·409 그대로입니다. 테이블이 없으면 500이 아니라 {@code available:false} + {@code ok:false}입니다.
 */
@RestController
@RequestMapping("/api/paper")
public class PaperIntradayController {

    private final PaperQueryService query;
    private final IntradayManualService manual;
    private final PaperMarkets markets;

    public PaperIntradayController(PaperQueryService query, IntradayManualService manual, PaperMarkets markets) {
        this.query = query;
        this.manual = manual;
        this.markets = markets;
    }

    public record IntradayRunRequest(String book) {
    }

    @PostMapping("/run/intraday")
    public Map<String, Object> runIntraday(@RequestParam(required = false) String market,
                                           @RequestBody(required = false) IntradayRunRequest body) {
        PaperMarket requested = markets.requested(market);
        if (!query.ready()) {
            Map<String, Object> out = query.notReady();
            out.put("ok", false);
            return out;
        }
        IntradayManualService.Pulled pulled = manual.pull(requested, body == null ? null : body.book());
        Map<String, Object> planned = new LinkedHashMap<>();
        planned.put("book", pulled.book());
        planned.put("session", pulled.session().toString());
        planned.put("slot", pulled.slot());
        planned.put(pulled.korea() ? "atKst" : "atEt", FreeTiming.label(pulled.at()));
        planned.put("feed", pulled.feed());
        planned.put("manual", true);
        planned.put("created", pulled.created());
        planned.put("status", PaperBooks.CHECKPOINT_PLANNED);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        if (requested != UsPaperMarket.INSTANCE) {
            out.put("market", requested.code());
        }
        out.put("planned", planned);
        out.put("note", "예약됨 — 장중 판단 작업이 그 시각 + " + PaperCheckpointJob.WINDOW_START_MINUTES + "분 뒤부터 + "
                + PaperCheckpointJob.WINDOW_END_MINUTES + "분 안에 한 번 부릅니다(자료가 없거나 호출 상한에 닿으면 부르지 않고 놓침으로 남습니다).");
        return out;
    }
}
