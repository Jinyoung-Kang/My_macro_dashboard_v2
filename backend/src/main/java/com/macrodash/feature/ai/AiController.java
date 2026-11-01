package com.macrodash.feature.ai;

import com.macrodash.support.CurrentUser;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.Map;

/**
 * AI 종합 리포트 · AI 연결 테스트.
 *
 * <p>같은 화면(연결 테스트)에 붙는 토스 조회는 {@code feature.toss.TossController}에 있습니다.
 */
@RestController
@RequestMapping("/api/ai")
public class AiController {

    private final AiService ai;
    private final AiReportService reports;

    public AiController(AiService ai, AiReportService reports) {
        this.ai = ai;
        this.reports = reports;
    }

    /** 엔진 목록. 데모 열람이면 공용 하루 한도의 오늘 사용량({@code quota})을 함께 줍니다(ADR 0014). */
    @GetMapping("/engines")
    public Map<String, Object> engines(jakarta.servlet.http.HttpServletRequest http) {
        Map<String, Object> out = ai.engines();
        Map<String, Object> quota = reports.sharedQuota(CurrentUser.of(http));
        if (quota != null) {
            out.put("quota", quota);
        }
        return out;
    }

    @GetMapping("/report-types")
    public Map<String, Object> reportTypes() {
        return Map.of("types", reports.reportTypes());
    }

    public record ReportRequest(String engineId, String reportType, String extraInstruction) {
    }

    /**
     * 사용자가 덧붙이는 지시·테스트 프롬프트의 최대 길이.
     *
     * <p>이 글자는 그대로 유료 AI API로 전달됩니다. 상한이 없으면 요청 하나로
     * 토큰 한도·요금을 소진시키거나 응답을 수 분씩 붙잡아 둘 수 있습니다.
     */
    static final int MAX_USER_TEXT = 2000;

    /** 길이 초과면 400. 사용자가 무엇을 줄여야 하는지 알 수 있게 한도를 알려 줍니다. */
    static void requireShort(String text, String field) {
        if (text != null && text.length() > MAX_USER_TEXT) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    field + "은(는) " + MAX_USER_TEXT + "자 이하로 입력하세요 (현재 " + text.length() + "자).");
        }
    }

    /**
     * 수집 데이터 기반 AI 리포트({@link AiReportService}).
     *
     * <p>추가 지시는 유료 AI API로 그대로 전달되므로, 길이는 여기(HTTP 경계)에서 먼저 막습니다.
     */
    @PostMapping("/report")
    public Map<String, Object> report(@RequestBody ReportRequest request, jakarta.servlet.http.HttpServletRequest http) {
        requireShort(request.extraInstruction(), "추가 지시");
        return reports.report(request.engineId(), request.reportType(), request.extraInstruction(),
                CurrentUser.of(http));
    }

    /** AI 연결 테스트 (짧은 프롬프트로 엔진 응답만 확인). */
    @PostMapping("/test")
    public Map<String, Object> test(@RequestParam(defaultValue = "auto") String engineId,
                                    @RequestParam(required = false) String prompt) {
        requireShort(prompt, "테스트 프롬프트");
        String text = (prompt == null || prompt.isBlank())
                // "연결이 정상인지 알려 달라"고 물으면 모델은 "네트워크 상태를 확인할 수 없다"고 답했습니다.
                // 응답이 왔다는 것 자체가 확인이므로, 정해진 짧은 문장을 요청합니다.
                ? "연결 확인용 요청입니다. '연결 정상입니다.'라고 한 문장으로만 답하십시오."
                : prompt;
        return ai.generate(engineId, text, "간결하게 한국어로 답하십시오.");
    }
}
