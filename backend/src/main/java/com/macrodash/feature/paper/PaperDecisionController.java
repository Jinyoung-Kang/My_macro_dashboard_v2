package com.macrodash.feature.paper;

import com.macrodash.support.InvalidRequestException;
import com.macrodash.support.Params;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 🧪 모의 매매 결정(운영자 전용) — 결정 기록 조회와 수동 결정·시작 버튼. 장부 조회·관리는 {@link PaperController}입니다
 * (한 컨트롤러가 서비스를 다섯 개 넘게 받지 않게 나눔).
 *
 * <pre>
 *  GET  /api/paper/decisions?book=rules&amp;limit=50  결정 목록(최근 순, 1–500)
 *  GET  /api/paper/decisions/{id}                    결정 한 건(선정·신호·주문·게이트 참고)과 그 주문
 *  POST /api/paper/run/decision?market=US            {"book"} 수동 결정(MANUAL — 미국은 시각 조건 없이 한 번, 한국은 kr_claude만·결정 창·자료 게이트 안에서)
 *  POST /api/paper/run/initial-decision?market=US    {"book", "preview"?} 시작(초기 결정 + 출발일 사후 체결) — 한국은 본문 없이 네 계좌 함께
 *                                                    출발(정기 출발과 같은 창·게이트, 이미 출발했으면 그 기록)
 * </pre>
 *
 * <p>Claude 책({@code book:"claude"})의 수동 결정·미리보기·시작은 Claude를 한 번 부릅니다(하루 호출 상한에 셈, 설정
 * {@code apiDailyCallCap} — 수동 호출이라 정기 작업 몫 {@code apiScheduledReserve}를 남긴 문턱까지). 미리보기는 장부·결정 기록을 바꾸지 않습니다.
 *
 * <p>{@code market}(2단계 명세 §4-16, F1)이 없거나 US면 미국 응답 그대로, KR이면 그 시장 판(응답 머리에 {@code market} —
 * {@link PaperMarkets#requested}), 그 밖 값은 400입니다.
 *
 * <p>테이블이 없으면 500이 아니라 {@code available:false}(+ POST는 {@code ok:false})입니다.
 */
@RestController
@RequestMapping("/api/paper")
public class PaperDecisionController {

    private final PaperQueryService query;
    private final PaperDecisionJob job;
    private final RuleBookService rules;
    private final ClaudeBookService claude;
    private final PaperMarkets markets;

    public PaperDecisionController(PaperQueryService query, PaperDecisionJob job, RuleBookService rules,
                                   ClaudeBookService claude, PaperMarkets markets) {
        this.query = query;
        this.job = job;
        this.rules = rules;
        this.claude = claude;
        this.markets = markets;
    }

    public record DecisionRequest(String book) {
    }

    /** {@code preview}가 true면 장부를 바꾸지 않고 낼 주문만 보입니다. */
    public record InitialDecisionRequest(String book, Boolean preview) {
    }

    @GetMapping("/decisions")
    public Map<String, Object> decisions(@RequestParam(defaultValue = "rules") String book,
                                         @RequestParam(defaultValue = "50") int limit) {
        return query.decisions(book, limit);
    }

    @GetMapping("/decisions/{id}")
    public Map<String, Object> decision(@PathVariable long id) {
        return query.decision(id);
    }

    /**
     * {@code market}이 KR이면 한국 수동 결정({@link PaperDecisionJob#runNow(PaperMarket, String)} — {@code book}은 {@code kr_claude}만, 그 세션의 결정 창
     * 밖·자료 게이트 ①~⑥ 미달·쉬는 한국은 400, Claude 호출은 수동 문턱 상한 − 예약), 없거나 US면 미국 응답 그대로.
     */
    @PostMapping("/run/decision")
    public Map<String, Object> runDecision(@RequestParam(required = false) String market,
                                           @RequestBody(required = false) DecisionRequest body) {
        PaperMarket requested = markets.requested(market);
        if (!query.ready()) {
            return notReady();
        }
        String book = body == null ? null : body.book();
        boolean us = requested == UsPaperMarket.INSTANCE;
        // 결정 레코드의 타입은 저장소 계층이라 이름을 쓰지 않습니다(컨트롤러는 자기 서비스와 support·config만 — ADR 0001).
        var decision = us ? job.runNow(book) : job.runNow(requested, book);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        if (!us) {
            out.put("market", requested.code());
        }
        out.put("decision", query.decisionSummary(decision));
        return out;
    }

    /**
     * {@code market}이 KR이면 한국 수동 출발 단추({@link #krStart} — 네 계좌 함께, 본문 없이), 없거나 US면 미국 응답 그대로(계좌별 시작·미리보기).
     */
    @PostMapping("/run/initial-decision")
    public Map<String, Object> runInitialDecision(@RequestParam(required = false) String market,
                                                  @RequestBody(required = false) InitialDecisionRequest body) {
        PaperMarket requested = markets.requested(market);
        if (!query.ready()) {
            return notReady();
        }
        if (requested != UsPaperMarket.INSTANCE) {
            return krStart(requested, body);
        }
        String book = Params.oneOf("book", body == null ? null : body.book(),
                List.of(PaperBooks.RULES, PaperBooks.CLAUDE));
        boolean preview = body.preview() != null && body.preview();
        if (PaperBooks.CLAUDE.equals(book)) {
            return preview ? claude.preview() : claudeStart();
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        if (preview) {
            out.put("preview", true);
            out.put("decision", null);
            out.put("plan", rules.preview());
            out.put("fills", List.of());
            return out;
        }
        RuleBookService.StartResult result = rules.start();
        out.put("preview", false);
        out.put("decision", query.decisionSummary(result.decision()));
        out.put("fills", query.fillRows(result.fills()));
        out.put("book", query.bookSummary(PaperBooks.RULES));
        return out;
    }

    /**
     * 한국 수동 출발(2단계 명세 §4-8, F1 — {@link PaperDecisionJob#startNow}) → {@code {ok, market, outcome, tradingDate, message, decisions:[목록 한 줄],
     * books:[BookSummary], record}}. 정기 출발과 같은 창·게이트·기한 안에서 네 계좌를 함께 출발시키고, 이미 출발했으면 그 출발 기록
     * ({@code ALREADY_STARTED})을 돌려줍니다. {@code ok}는 출발함·이미 출발함이면 참, 그 세션을 미룸·쓰기 오류면 거짓. 미국 시작의 {@code book}·
     * {@code preview}는 받지 않습니다(400 — 네 계좌가 함께 출발하고 한국 미리보기는 없음). 창 밖·이미 미룸·게이트 미달·쉬는 한국도 400.
     */
    private Map<String, Object> krStart(PaperMarket market, InitialDecisionRequest body) {
        if (body != null && (body.book() != null || body.preview() != null)) {
            throw new InvalidRequestException(market.code() + " 출발은 네 계좌가 함께 냅니다 — book·preview 없이 보내세요(미리보기 없음)");
        }
        var started = job.startNow(market);
        boolean ok = PaperDecisionJob.STARTED.equals(started.outcome())
                || PaperDecisionJob.ALREADY_STARTED.equals(started.outcome());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", ok);
        out.put("market", market.code());
        out.put("outcome", started.outcome());
        out.put("tradingDate", started.tradingDate() == null ? null : started.tradingDate().toString());
        out.put("message", started.message());
        out.put("decisions", started.decisions().stream().map(query::decisionSummary).toList());
        out.put("books", started.books().stream().map(query::bookSummary).toList());
        out.put("record", started.record());
        return out;
    }

    /** Claude 책 시작 — 규칙 책 시작과 같은 모양({@code decision}·{@code fills}·{@code book}). */
    private Map<String, Object> claudeStart() {
        var result = claude.start();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("preview", false);
        out.put("decision", query.decisionSummary(result.decision()));
        out.put("fills", query.fillRows(result.fills()));
        out.put("book", query.bookSummary(PaperBooks.CLAUDE));
        return out;
    }

    private Map<String, Object> notReady() {
        Map<String, Object> out = query.notReady();
        out.put("ok", false);
        return out;
    }
}
