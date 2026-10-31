package com.macrodash.feature.ai;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.anthropic.core.JsonValue;
import com.anthropic.core.RequestOptions;
import com.anthropic.errors.AnthropicInvalidDataException;
import com.anthropic.errors.AnthropicServiceException;
import com.anthropic.errors.NotFoundException;
import com.anthropic.errors.PermissionDeniedException;
import com.anthropic.errors.RateLimitException;
import com.anthropic.errors.UnauthorizedException;
import com.anthropic.models.messages.CacheControlEphemeral;
import com.anthropic.models.messages.JsonOutputFormat;
import com.anthropic.models.messages.Message;
import com.anthropic.models.messages.MessageCreateParams;
import com.anthropic.models.messages.OutputConfig;
import com.anthropic.models.messages.StopReason;
import com.anthropic.models.messages.TextBlockParam;
import com.anthropic.models.messages.Usage;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.client.ClientHttpResponse;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.LongSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 🤖 AI 엔진 라우팅 (Anthropic Claude / NVIDIA / Cerebras / Cloudflare).
 *
 * <p>구버전 services/ai_service.py의 구조를 유지합니다.
 * <ul>
 *   <li>엔진 레지스트리 + 자동 폴오버(한 엔진이 실패하면 다음 엔진)</li>
 *   <li>응답이 한국어가 아니면 번역 전용 모델로 한 번 더 호출</li>
 *   <li>키가 없는 엔진은 <b>조용히 건너뛰지 않고</b> 이유를 남깁니다</li>
 *   <li>배포마다 쓸 엔진을 허용 목록({@code AI_ENGINES})으로 좁힐 수 있습니다(비면 전부 — 기본·로컬, ADR 0014)</li>
 *   <li>모의 매매 Claude 책은 위 경로와 따로 {@link #structured}(스키마로 모양을 강제한 Claude 호출 한 번)를 씁니다 — 허용 목록은
 *       모델 단위로 따릅니다(목록 안 Anthropic 엔진의 모델만)</li>
 * </ul>
 *
 * <p>AI는 <b>수집된 데이터만</b> 근거로 삼습니다. 리포트 프롬프트에는 대시보드
 * 원본 텍스트가 그대로 들어가고, 추정치·대용 지표에는 경고 문구가 함께
 * 들어갑니다({@code feature.snapshot.SnapshotTextService}).
 */
@Service
public class AiService {

    private static final Logger log = LoggerFactory.getLogger(AiService.class);

    private static final String NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
    private static final String CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
    private static final Pattern HANGUL = Pattern.compile("[가-힣]");
    private static final Pattern ALPHABETIC = Pattern.compile("[A-Za-z가-힣]");

    public record Engine(String id, String label, String provider, String model, String description) {
    }

    /** 분석 엔진 레지스트리 (번역 전용 모델은 선택지에서 제외). */
    public static final List<Engine> ENGINES = List.of(
            new Engine("auto", "자동 탐색 — 권장 (Failover)", "auto", null,
                    "사용 가능한 엔진을 우선순위대로 자동 호출합니다."),
            new Engine("anthropic_haiku", "Anthropic — Claude Haiku 5.5", "anthropic",
                    "claude-haiku-5-5", "빠른 장문 분석·한국어 리포트 (유료 — 리포트 1건 약 1센트 미만)"),
            new Engine("nvidia_nemotron", "NVIDIA — Nemotron-3 Super 120B", "nvidia",
                    "nvidia/nemotron-3-super-120b-a12b", "장문 투자 분석 및 구조화된 리포트"),
            new Engine("nvidia_gpt_oss_120b", "NVIDIA — OpenAI GPT-OSS 120B", "nvidia",
                    "openai/gpt-oss-120b", "고난도 추론·장문 종합 분석"),
            new Engine("nvidia_gpt_oss_20b", "NVIDIA — OpenAI GPT-OSS 20B", "nvidia",
                    "openai/gpt-oss-20b", "비교적 빠른 보조 분석"),
            new Engine("nvidia_llama_33_70b", "NVIDIA — Meta Llama 3.3 70B Instruct", "nvidia",
                    "meta/llama-3.3-70b-instruct", "범용 지시 이행·다국어 분석"),
            new Engine("cloudflare_deepseek", "Cloudflare — DeepSeek-R1 (32B)", "cloudflare",
                    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b", "추론형 분석 보조"),
            new Engine("cloudflare_llama", "Cloudflare — Llama 3.3 70B FP8 Fast", "cloudflare",
                    "@cf/meta/llama-3.3-70b-instruct-fp8-fast", "장문 매크로·투자 분석용 고속 모델"),
            new Engine("cerebras_llama", "Cerebras — Llama 3.3 70B", "cerebras",
                    "llama-3.3-70b", "초고속 장문 생성"));

    /**
     * 자동 탐색 순서 — <b>빠른 엔진부터</b>.
     *
     * <p>예전 순서는 추론형 대형 모델(Nemotron 120B → gpt-oss 120B)이 앞에 있었습니다.
     * 이 모델들은 답을 쓰기 전에 긴 추론 단계를 거쳐 한 번 호출에 수 분이 걸리고,
     * 실패하면 그 시간을 그대로 버린 뒤 다음 엔진으로 넘어갔습니다. 리포트 한 장에
     * 10분이 넘게 걸린 이유가 이것입니다.
     *
     * <p>지금은 같은 70B급이라도 <b>추론 단계가 없는</b> 고속 엔진을 먼저 부릅니다
     * (Cerebras는 초당 토큰 수가 압도적이고, Cloudflare fp8-fast도 수 초대입니다).
     * 추론형 모델은 뒤로 물러나되 <b>목록에는 남겨</b> 둡니다 — 앞의 엔진이 전부
     * 실패했을 때 답이 없는 것보다는 느린 답이 낫기 때문입니다.
     *
     * <p>깊은 추론이 필요하면 화면에서 엔진을 직접 고르면 됩니다. 그때는 이 순서를
     * 타지 않고 고른 엔진만 부릅니다.
     *
     * <p>Claude Haiku 5.5가 맨 앞입니다. 유료지만 리포트 한 건이 1센트 미만이고, 지시를 가장 잘 따라
     * 한국어 리포트를 한 번에 씁니다(번역 단계가 필요 없음). 키가 없으면 "키 없음"으로 건너뜁니다.
     *
     * <p>이 순서가 곧 응답 속도라, 같은 패키지의 테스트가 확인할 수 있도록
     * package-private입니다.
     */
    static final List<String> FAILOVER_ORDER = List.of(
            "anthropic_haiku",
            "cerebras_llama", "cloudflare_llama", "nvidia_llama_33_70b",
            "nvidia_gpt_oss_20b", "nvidia_gpt_oss_120b", "nvidia_nemotron",
            "cloudflare_deepseek");

    /**
     * 엔진별 예상 응답 속도 — 화면이 "왜 이 엔진이 느린지"를 미리 알려 줍니다.
     *
     * <p>여기 없는 엔진은 "보통"으로 봅니다.
     */
    private static final Map<String, String> SPEED_HINTS = Map.of(
            "auto", "빠름 — 빠른 엔진부터 시도합니다",
            "anthropic_haiku", "보통 (약 1분 내외)",
            "cerebras_llama", "매우 빠름 (수 초)",
            "cloudflare_llama", "빠름 (수 초)",
            "nvidia_llama_33_70b", "보통 (십수 초)",
            "nvidia_gpt_oss_20b", "느림 — 추론형 (수십 초~수 분)",
            "nvidia_gpt_oss_120b", "매우 느림 — 추론형 (수 분)",
            "nvidia_nemotron", "매우 느림 — 추론형 (수 분)",
            "cloudflare_deepseek", "매우 느림 — 추론형 (수 분)");

    /** 번역 전용 모델 (분석 선택지에서 제외). */
    private static final Map<String, String> TRANSLATORS = Map.of(
            "cloudflare", "@cf/google/gemma-4-26b-a4b-it",
            "nvidia", "google/gemma-4-31b-it");

    private static final String TRANSLATION_PROMPT = """
            당신은 금융·투자 리포트 전문 한국어 번역가입니다.

            아래 원문을 자연스럽고 정확한 한국어로 번역하십시오.

            반드시 지켜야 할 규칙:
            1. 원문의 숫자, 통화 단위, 백분율, 종목 코드, 날짜, 티커를 변경하지 마십시오.
            2. Markdown 제목, 목록, 표, 코드 블록, 굵게 표시를 유지하십시오.
            3. Markdown 표의 파이프(|), 행 구분, 줄바꿈 구조를 보존하십시오.
            4. 원문의 분석·투자 의견을 추가하거나 삭제하지 마십시오.
            5. 번역문만 출력하고, "번역:" 같은 서문은 쓰지 마십시오.
            """;

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 엔진을 못 쓰는 이유(화면이 라벨을 고름) — 이 배포의 허용 목록 밖. */
    static final String NOT_ALLOWED = "not_allowed";
    /** 결과 키: 이 호출이 모델에 닿아 과금됐을 수 있는가(실패여도 true일 수 있음). 사용량 되돌림이 봅니다. */
    public static final String CHARGED = "charged";

    /** 엔진을 못 쓰는 이유 — 허용됐지만 키가 없음. */
    static final String NO_KEY = "no_key";

    /** 오류 문구에 그대로 적어도 되는 값의 모양. 키를 잘못 넣었을 때 그 값이 기동 로그에 찍히지 않게 합니다. */
    private static final Pattern PRINTABLE_ID = Pattern.compile("[A-Za-z0-9_.-]{1,40}");

    /**
     * Claude 응답 한도(토큰). Haiku 5.5는 사고(thinking)가 기본으로 켜져 있고 사고도 이 한도에 들어갑니다 —
     * 다른 엔진처럼 4096으로 두면 사고만 하다 답을 못 쓰고 끝날 수 있습니다. 출력 단가가 100만 토큰당
     * $0.50이라 한도까지 써도 0.8센트입니다.
     */
    static final long ANTHROPIC_MAX_TOKENS = 16_000L;

    /**
     * 구조화 출력(모의 매매 Claude 책)의 응답 한도(토큰). 리포트 한도와 지금은 같지만 정한 이유가 달라 따로 둡니다 — 이 값은
     * 명세 C2가 정한 실험 조건이고, 리포트 한도는 Haiku의 사고 분량에 맞춘 값이라 그쪽을 바꿔도 따라 움직이면 안 됩니다.
     */
    static final long STRUCTURED_MAX_TOKENS = 16_000L;

    /**
     * 남은 예산이 이보다 적으면 다음 엔진을 부르지 않습니다(초). 번역도 같습니다 — 원문을 그대로 보여 줍니다(QA-094).
     *
     * <p>5초를 남겨 두고 호출해 봐야 타임아웃만 한 번 더 겪습니다.
     */
    private static final int MIN_ATTEMPT_SECONDS = 15;

    /** 대기 한도별 RestClient. 한도가 다르면 팩토리도 달라야 해서 나눠 둡니다. */
    private final Map<Integer, RestClient> clients = new ConcurrentHashMap<>();

    /**
     * Claude 클라이언트(공식 SDK) — 하나만 만들어 씁니다. 키·주소는 기동 때 정해지고, 시도마다 다른 대기 한도는 요청
     * 옵션으로 넘깁니다. 예전에는 한도마다 클라이언트를 만들어 두었는데, 클라이언트마다 SDK의 타이머 스레드와 OkHttp 연결
     * 풀이 생기고, 번역이 남은 초(15..한도)를 받으면서 재시작 전까지 최대 (한도−14)개가 쌓였습니다(QA-119).
     * 처음 부를 때 만듭니다 — 키는 생성 뒤에 주입됩니다.
     */
    private volatile AnthropicClient anthropicClient;
    private final Object anthropicClientLock = new Object();

    /**
     * Claude API 키. 단위 테스트에서는 주입이 없어 빈 문자열로 시작합니다(null이면 키 확인이 터집니다).
     * 값은 로그·화면·오류 문구 어디에도 내보내지 않습니다.
     */
    @Value("${dashboard.ai.anthropic-api-key:}")
    private String anthropicKey = "";

    /** 테스트가 가짜 서버로 보낼 때만 씁니다. null이면 SDK 기본 주소(api.anthropic.com). */
    String anthropicBaseUrl;

    /**
     * 지금 시각(밀리초) — 대기 마감과 남은 예산 계산에만 씁니다. 테스트가 시간을 움직여 남은 예산에 따른 동작을 실제로
     * 기다리지 않고 확인할 때 바꿔 끼웁니다. 호출마다 걸린 시간(latencyMs)은 실제 시계로 잽니다.
     */
    LongSupplier clockMillis = System::currentTimeMillis;

    /** NVIDIA·Cerebras 호출 주소. 테스트가 자동 탐색을 가짜 서버로만 돌릴 때(실제 호출 없이) 바꿉니다. */
    String nvidiaUrl = NVIDIA_URL;
    String cerebrasUrl = CEREBRAS_URL;

    @Value("${dashboard.ai.nvidia-api-key:}")
    private String nvidiaKey;

    @Value("${dashboard.ai.cerebras-api-key:}")
    private String cerebrasKey;

    @Value("${dashboard.ai.cloudflare-account-id:}")
    private String cloudflareAccountId;

    @Value("${dashboard.ai.cloudflare-api-token:}")
    private String cloudflareToken;

    /**
     * 응답 대기 한도(초). 엔진을 직접 고른 경우 <b>번역까지 포함한</b> 생성 전체의 한도입니다(QA-094).
     *
     * <p>추론형 모델(gpt-oss, DeepSeek-R1 등)은 생성 전에 긴 추론 단계를 거쳐
     * 몇 분이 걸릴 수 있습니다. 실제로 150초에서 이렇게 끊겼습니다.
     * <pre>AI 호출 실패 (NVIDIA — OpenAI GPT-OSS 20B): Read timed out</pre>
     */
    private final int timeoutSeconds;

    /**
     * 자동 탐색에서 <b>엔진 하나</b>에 주는 대기 한도(초).
     *
     * <p>자동 탐색의 목적은 "되는 엔진을 빨리 찾는 것"입니다. 그런데 예전에는
     * 모든 시도가 전체 한도(기본 240초)를 그대로 썼습니다. 앞의 엔진이 조용히
     * 멈춰 있으면 4분을 기다린 뒤에야 다음 엔진으로 넘어갔고, 그런 엔진이 둘만
     * 있어도 사용자는 8분을 기다렸습니다. 빨리 포기하고 넘어가는 편이 낫습니다.
     */
    private final int autoAttemptSeconds;

    /**
     * 자동 탐색 <b>전체</b>에 주는 시간 예산(초).
     *
     * <p>폴오버는 실패할수록 시간이 쌓입니다. 예산을 넘기면 남은 엔진을
     * 시도하지 않고 멈춰서, 사용자가 언제 끝날지 모르는 대기를 하지 않게 합니다.
     * 그때는 "무엇을 왜 시도하지 않았는지"를 폴오버 경로에 남깁니다.
     */
    private final int autoBudgetSeconds;

    /**
     * 이 배포에서 쓸 수 있는 엔진 ID(AI_ENGINES, ADR 0014). null이면 제한 없음 — 키가 있는 엔진은 모두 씁니다(기본·로컬).
     *
     * <p>AWS 공개 데모는 운영자의 Anthropic 계정으로 방문자가 리포트를 만들므로, 비용을 아는 엔진 하나(Haiku)로 묶습니다.
     * 허용 목록 밖의 엔진은 키가 있어도 부르지 않고, 화면에는 "이 배포에서 사용 안 함"으로 보입니다.
     */
    private final Set<String> allowed;

    /** 테스트용 기본값. Spring은 아래 @Autowired 생성자를 씁니다. */
    public AiService() {
        this(240);
    }

    /** 테스트용 — 전체 한도만 지정하고 자동 탐색 설정은 기본값을 씁니다. */
    public AiService(int timeoutSeconds) {
        this(timeoutSeconds, 60, 180);
    }

    /** 테스트용 — 허용 목록 없음(모든 엔진). */
    public AiService(int timeoutSeconds, int autoAttemptSeconds, int autoBudgetSeconds) {
        this(timeoutSeconds, autoAttemptSeconds, autoBudgetSeconds, "");
    }

    // ⚠️ 생성자가 여럿이고 아무것도 표시하지 않으면 Spring은 무인자 생성자를 골라
    //    설정값을 조용히 무시합니다. 어느 쪽을 쓸지 명시해야 합니다.
    @Autowired
    public AiService(@Value("${dashboard.ai.timeout-seconds:240}") int timeoutSeconds,
                     @Value("${dashboard.ai.auto-attempt-seconds:60}") int autoAttemptSeconds,
                     @Value("${dashboard.ai.auto-budget-seconds:180}") int autoBudgetSeconds,
                     @Value("${dashboard.ai.engines:}") String allowedEngines) {
        this.timeoutSeconds = Math.max(30, timeoutSeconds);
        // 시도 한도가 전체 한도보다 길면 의미가 없고, 너무 짧으면 멀쩡한 엔진도
        // 끊깁니다. 예산은 최소한 한 번은 시도할 수 있어야 합니다.
        this.autoAttemptSeconds = Math.min(this.timeoutSeconds, Math.max(20, autoAttemptSeconds));
        this.autoBudgetSeconds = Math.max(this.autoAttemptSeconds, autoBudgetSeconds);
        this.allowed = allowList(allowedEngines);
        if (allowed != null) {
            log.info("AI 엔진 허용 목록(AI_ENGINES): {} — 목록 밖의 엔진은 키가 있어도 부르지 않습니다(ADR 0014).", allowed);
        }
    }

    /**
     * {@code AI_ENGINES} 값(쉼표로 구분한 엔진 ID)을 읽습니다. 비었으면 null(제한 없음).
     *
     * <p>모르는 ID나 {@code auto}가 있으면 기동을 멈춥니다 — 오타 하나로 엔진이 모두 조용히 꺼지거나, 의도와 다른
     * 엔진이 열리지 않게 합니다. {@code auto}는 넣지 않습니다: 허용한 엔진 중 키가 있는 것이 둘 이상이면 저절로 켜집니다.
     *
     * @throws IllegalStateException 쓸 수 없는 ID가 있을 때. ID 모양이 아닌 값(키를 잘못 넣은 경우 등)은 문구에 적지 않습니다.
     */
    static Set<String> allowList(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        Set<String> known = new LinkedHashSet<>();
        ENGINES.stream().map(Engine::id).filter(id -> !"auto".equals(id)).forEach(known::add);

        Set<String> out = new LinkedHashSet<>();
        List<String> rejected = new ArrayList<>();
        int unprintable = 0;
        for (String part : raw.split(",")) {
            String id = part.strip();
            if (id.isEmpty()) {
                continue;
            }
            if (known.contains(id)) {
                out.add(id);
            } else if (PRINTABLE_ID.matcher(id).matches()) {
                rejected.add(id);
            } else {
                unprintable++;
            }
        }
        if (!rejected.isEmpty() || unprintable > 0) {
            String what = String.join(", ", rejected)
                    + (unprintable > 0 ? (rejected.isEmpty() ? "" : ", ") + "엔진 ID 모양이 아닌 값 %d개(값은 적지 않음)"
                    .formatted(unprintable) : "");
            throw new IllegalStateException(("AI_ENGINES에 쓸 수 없는 엔진 ID가 있습니다: %s — 쓸 수 있는 값: %s. "
                    + "auto는 넣지 않습니다(허용한 엔진 중 키가 있는 것이 둘 이상이면 자동 탐색이 켜짐). "
                    + "비우면 모든 엔진을 씁니다(ADR 0014).").formatted(what, String.join(", ", known)));
        }
        return out.isEmpty() ? null : Set.copyOf(out);
    }

    /** 실제로 적용된 대기 한도(초). 설정이 먹었는지 확인하는 용도. */
    public int timeoutSeconds() {
        return timeoutSeconds;
    }

    /** 자동 탐색에서 엔진 하나에 주는 대기 한도(초). */
    public int autoAttemptSeconds() {
        return autoAttemptSeconds;
    }

    /** 자동 탐색 전체 시간 예산(초). */
    public int autoBudgetSeconds() {
        return autoBudgetSeconds;
    }

    /**
     * 대기 한도별 RestClient.
     *
     * <p>{@link SimpleClientHttpRequestFactory}의 읽기 한도는 만들 때 정해지므로,
     * 시도마다 한도가 다르면 클라이언트도 달라야 합니다. 매번 새로 만들면 연결
     * 설정이 낭비되니 한도별로 하나씩 만들어 재사용합니다.
     */
    private RestClient client(int seconds) {
        return clients.computeIfAbsent(seconds, limit -> {
            SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
            factory.setConnectTimeout(Duration.ofSeconds(10));
            factory.setReadTimeout(Duration.ofSeconds(limit));
            return RestClient.builder().requestFactory(factory).build();
        });
    }

    /**
     * 화면이 선택지를 그릴 때 쓰는 목록 + 키 보유 여부.
     *
     * <p>{@code available}은 "이 배포에서 허용됐고 키도 있다"입니다. 못 쓰면 {@code unavailableReason}이 이유를 줍니다
     * ({@value #NOT_ALLOWED}·{@value #NO_KEY}, 쓸 수 있으면 null). {@code keys}는 허용 목록과 상관없이 키가 있는지입니다.
     */
    public Map<String, Object> engines() {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Engine engine : ENGINES) {
            String reason = unavailableReason(engine);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("id", engine.id());
            entry.put("label", engine.label());
            entry.put("provider", engine.provider());
            entry.put("model", engine.model());
            entry.put("description", engine.description());
            entry.put("speedHint", SPEED_HINTS.getOrDefault(engine.id(), "보통"));
            entry.put("available", reason == null);
            entry.put("unavailableReason", reason);
            list.add(entry);
        }

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("engines", list);
        out.put("keys", Map.of(
                "anthropic", !anthropicKey.isBlank(),
                "nvidia", !nvidiaKey.isBlank(),
                "cerebras", !cerebrasKey.isBlank(),
                "cloudflare", !cloudflareAccountId.isBlank() && !cloudflareToken.isBlank()));
        out.put("enabled", enabled());
        // 화면이 "얼마나 기다리면 되는지"를 미리 말할 수 있도록 함께 내려보냅니다.
        out.put("timeoutSeconds", timeoutSeconds);
        out.put("autoAttemptSeconds", autoAttemptSeconds);
        out.put("autoBudgetSeconds", autoBudgetSeconds);
        return out;
    }

    public boolean anyKeyPresent() {
        return !anthropicKey.isBlank() || !nvidiaKey.isBlank() || !cerebrasKey.isBlank()
                || (!cloudflareAccountId.isBlank() && !cloudflareToken.isBlank());
    }

    /** AI 메뉴를 켤지 — 이 배포에서 허용된 엔진 중 키가 있는 것이 하나라도 있는가. 허용 목록이 없으면 {@link #anyKeyPresent}와 같습니다. */
    public boolean enabled() {
        return usableEngineCount() > 0;
    }

    /** 허용됐고 키도 있는 엔진 수(auto 제외). */
    private long usableEngineCount() {
        return ENGINES.stream()
                .filter(engine -> !"auto".equals(engine.id()))
                .filter(engine -> isAllowed(engine.id()) && hasKey(engine.provider()))
                .count();
    }

    /** 허용 목록에 있는가(목록이 없으면 늘 true). auto는 {@link #unavailableReason}이 따로 판정합니다. */
    private boolean isAllowed(String engineId) {
        return allowed == null || allowed.contains(engineId);
    }

    /**
     * 이 엔진을 못 쓰는 이유. 쓸 수 있으면 null.
     *
     * <ul>
     *   <li>허용 목록 밖 → {@value #NOT_ALLOWED}(키가 없어도 이쪽이 먼저 — 화면이 "이 배포에서 사용 안 함"을 보임)</li>
     *   <li>허용됐지만 키 없음 → {@value #NO_KEY}</li>
     *   <li>auto — 허용 목록이 없으면 지금처럼 키가 하나라도 있으면 씀. 목록이 있으면 키가 있는 허용 엔진이 둘 이상일 때만
     *       (하나뿐이면 고를 것이 없는 자동 탐색이라 엔진을 직접 고르게 함). 허용 엔진이 하나뿐이면 {@value #NOT_ALLOWED},
     *       둘 이상인데 키가 모자라면 {@value #NO_KEY}.</li>
     * </ul>
     */
    String unavailableReason(Engine engine) {
        if ("auto".equals(engine.id())) {
            if (allowed == null) {
                return anyKeyPresent() ? null : NO_KEY;
            }
            if (allowed.size() < 2) {
                return NOT_ALLOWED;
            }
            return usableEngineCount() >= 2 ? null : NO_KEY;
        }
        if (!isAllowed(engine.id())) {
            return NOT_ALLOWED;
        }
        return hasKey(engine.provider()) ? null : NO_KEY;
    }

    /** 엔진 1개 호출 (auto면 폴오버). */
    public Map<String, Object> generate(String engineId, String prompt, String systemPrompt) {
        Optional<Map<String, Object>> unusable = unusable(engineId);
        if (unusable.isPresent()) {
            return unusable.get();
        }
        if (isAuto(engineId)) {
            return withFailover(prompt, systemPrompt);
        }
        Engine engine = findEngine(engineId);
        // 사용자가 엔진을 직접 골랐다면 그 엔진을 한도 끝까지 기다립니다.
        // 추론형 모델이 느린 것은 선택의 결과이지 고장이 아닙니다.
        // 한도는 번역까지 포함한 전체입니다 — 번역에는 남은 시간만 줍니다(QA-094). 예전에는 번역이 한도를 처음부터
        // 다시 받아, 앞단(CloudFront 120초)보다 먼저 포기하려고 고른 AWS의 110초가 최악 220초가 됐습니다.
        long deadline = clockMillis.getAsLong() + timeoutSeconds * 1000L;
        Map<String, Object> result = call(engine, prompt, systemPrompt, timeoutSeconds);
        return translateIfNeeded(result, engine.provider(), deadline, timeoutSeconds,
                "대기 한도 %d초".formatted(timeoutSeconds));
    }

    /**
     * 네트워크에 나가지 않고 정해지는 "이 엔진은 지금 못 씀" — 못 쓰면 {@link #generate}가 돌려줄 실패({@code charged: false}),
     * 쓸 수 있으면 비어 있음.
     *
     * <p>AI 꺼짐(키 없음)·모르는 엔진 ID·허용 목록 밖·못 쓰는 자동 탐색·허용됐지만 키가 없는 엔진. AI 리포트는 이것을 하루
     * 한도를 쓰기 전, 대시보드 전체 원본 텍스트를 만들기 전에 봅니다 — 예전에는 둘 다 한 뒤에야 여기서 실패해, 되돌려지는
     * 실패를 한도 없이 되풀이할 수 있었습니다(QA-133).
     */
    Optional<Map<String, Object>> unusable(String engineId) {
        if (!enabled()) {
            return Optional.of(failure("설정 없음", allowed == null
                    ? "AI 키가 하나도 설정되지 않았습니다. Anthropic / NVIDIA / Cerebras / Cloudflare 중 "
                            + "하나 이상을 설정하세요."
                    : "이 배포에서 쓰는 AI 엔진(%s)의 키가 설정되지 않았습니다."
                            .formatted(String.join(", ", new TreeSet<>(allowed)))));
        }

        boolean auto = isAuto(engineId);
        Engine engine = findEngine(auto ? "auto" : engineId);

        if (engine == null) {
            return Optional.of(failure(engineId, "지원하지 않는 AI 엔진입니다: " + engineId));
        }
        // 허용 목록 밖이면(자동 탐색은 쓸 수 없을 때) 키 없음과 같은 실패 모양입니다.
        String reason = unavailableReason(engine);
        if (NOT_ALLOWED.equals(reason) || (auto && reason != null)) {
            return Optional.of(failure(engine.label(), "이 배포에서는 쓸 수 없는 엔진입니다: " + engine.label()
                    + (auto ? " — 엔진을 직접 고르세요." : "")));
        }
        return NO_KEY.equals(reason) ? Optional.of(missingKey(engine)) : Optional.empty();
    }

    /** 엔진을 고르지 않았거나 auto면 자동 탐색. */
    private static boolean isAuto(String engineId) {
        return engineId == null || engineId.isBlank() || "auto".equals(engineId);
    }

    /**
     * 허용됐지만 키가 없는 엔진의 실패. 예전에는 제공자 호출(callAnthropic·callOpenAiFormat·callCloudflare)이 키를
     * 확인하며 이 문구로 끝냈습니다 — 화면이 보던 문구를 그대로 둡니다(QA-133). 문구는 AiServiceAllowListTest가 고정합니다.
     * 같은 문구가 제공자 호출(번역 경로에서 아직 씀)에도 남아 있어, 바꿀 때는 두 곳을 함께 고칩니다.
     */
    private Map<String, Object> missingKey(Engine engine) {
        String label = engine.label();
        return failure(label, switch (engine.provider()) {
            case "anthropic" -> label + " API Key 누락 — .env에 ANTHROPIC_API_KEY를 넣고 make up 하세요.";
            case "cloudflare" -> "Cloudflare 인증 정보 누락";
            default -> label + " API Key 누락";
        });
    }

    private Engine findEngine(String engineId) {
        return ENGINES.stream()
                .filter(e -> e.id().equals(engineId))
                .findFirst()
                .orElse(null);
    }

    /**
     * 자동 폴오버: 앞 엔진이 실패하면 다음 엔진을 시도하고 경로를 남깁니다.
     *
     * <p>두 가지 한도를 함께 겁니다 — 시도 하나에 {@code autoAttemptSeconds},
     * 전체에 {@code autoBudgetSeconds}. 예전에는 둘 다 없어서 최악의 경우
     * "엔진 수 × 전체 한도"만큼 기다릴 수 있었습니다(기본값으로 24분).
     */
    private Map<String, Object> withFailover(String prompt, String systemPrompt) {
        List<String> attempts = new ArrayList<>();
        boolean charged = false;
        long deadline = clockMillis.getAsLong() + autoBudgetSeconds * 1000L;

        for (String engineId : FAILOVER_ORDER) {
            if (!isAllowed(engineId)) {
                // 허용 목록 밖은 이 배포의 설정이라(키가 빠진 사고가 아님) 경로에 적지 않고 건너뜁니다.
                continue;
            }
            Engine engine = findEngine(engineId);
            if (engine == null || !hasKey(engine.provider())) {
                attempts.add(engineId + ": 키 없음");
                continue;
            }

            int attemptSeconds = attemptBudget(deadline, clockMillis.getAsLong());
            if (attemptSeconds < 0) {
                attempts.add("남은 엔진은 시도하지 않았습니다 — 자동 탐색 시간 예산 %d초를 다 썼습니다"
                        .formatted(autoBudgetSeconds));
                break;
            }

            Map<String, Object> result = call(engine, prompt, systemPrompt, attemptSeconds);
            charged |= Boolean.TRUE.equals(result.get(CHARGED));
            attempts.add("%s (%.1fs): %s".formatted(
                    engineId,
                    millisOf(result) / 1000.0,
                    Boolean.TRUE.equals(result.get("status"))
                            ? "성공" : String.valueOf(result.get("error"))));

            if (Boolean.TRUE.equals(result.get("status"))) {
                result.put("failoverPath", attempts);
                return translateIfNeeded(result, engine.provider(), deadline, autoAttemptSeconds,
                        "자동 탐색 예산 %d초".formatted(autoBudgetSeconds));
            }
        }

        Map<String, Object> failed = failure("auto",
                "모든 AI 엔진 호출에 실패했습니다. 아래 경로에서 실패 사유를 확인하세요 "
                        + "(자동 탐색 예산 %d초 · 엔진당 %d초)."
                                .formatted(autoBudgetSeconds, autoAttemptSeconds));
        failed.put("failoverPath", attempts);
        failed.put(CHARGED, charged);
        return failed;
    }

    /**
     * 이번 엔진에 줄 대기 한도(초). 예산이 모자라면 -1 — 더 시도하지 않습니다.
     *
     * <p>남은 시간이 시도 한도보다 짧으면 그만큼만 줍니다. 예산을 넘겨 가며
     * 기다리면 "전체 N초"라는 약속이 의미를 잃습니다.
     */
    int attemptBudget(long deadlineMs, long nowMs) {
        return attemptBudget(deadlineMs, nowMs, autoAttemptSeconds);
    }

    /** {@link #attemptBudget(long, long)}와 같은 규칙, 시도 하나의 한도만 따로 — 직접 경로의 번역은 전체 한도까지 받습니다. */
    private static int attemptBudget(long deadlineMs, long nowMs, int capSeconds) {
        int remaining = (int) ((deadlineMs - nowMs) / 1000);
        if (remaining < MIN_ATTEMPT_SECONDS) {
            return -1;
        }
        return Math.min(capSeconds, remaining);
    }

    private static long millisOf(Map<String, Object> result) {
        return result.get("latencyMs") instanceof Number number ? number.longValue() : 0L;
    }

    private Map<String, Object> call(Engine engine, String prompt, String systemPrompt,
                                     int attemptSeconds) {
        return switch (engine.provider()) {
            case "anthropic" -> callAnthropic(engine.label(), engine.model(),
                    prompt, systemPrompt, attemptSeconds);
            case "nvidia" -> callOpenAiFormat(engine.label(), nvidiaUrl, nvidiaKey,
                    engine.model(), prompt, systemPrompt, attemptSeconds);
            case "cerebras" -> callOpenAiFormat(engine.label(), cerebrasUrl, cerebrasKey,
                    engine.model(), prompt, systemPrompt, attemptSeconds);
            case "cloudflare" -> callCloudflare(engine.label(), engine.model(),
                    prompt, systemPrompt, attemptSeconds);
            default -> failure(engine.label(), "알 수 없는 제공자: " + engine.provider());
        };
    }

    // 테스트가 임의 엔드포인트로 호출할 수 있도록 package-private입니다.
    Map<String, Object> callOpenAiFormat(String label, String endpoint, String apiKey,
                                         String model, String prompt, String systemPrompt) {
        return callOpenAiFormat(label, endpoint, apiKey, model, prompt, systemPrompt, timeoutSeconds);
    }

    private Map<String, Object> callOpenAiFormat(String label, String endpoint, String apiKey,
                                                 String model, String prompt, String systemPrompt,
                                                 int attemptSeconds) {
        if (apiKey == null || apiKey.isBlank()) {
            return failure(label, label + " API Key 누락");
        }

        List<Map<String, String>> messages = new ArrayList<>();
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            messages.add(Map.of("role", "system", "content", systemPrompt));
        }
        messages.add(Map.of("role", "user", "content", prompt));

        Map<String, Object> body = Map.of(
                "model", model,
                "messages", messages,
                "temperature", 0.3,
                "max_tokens", 4096);

        long started = System.currentTimeMillis();
        try {
            JsonNode response = postJson(endpoint, apiKey, body, attemptSeconds);

            long elapsed = System.currentTimeMillis() - started;
            String text = extractOpenAiText(response);

            if (text == null || text.isBlank()) {
                return chargedFailure(label, "응답 텍스트 추출 실패", elapsed);
            }
            return success(label, model, text.trim(), elapsed);
        } catch (Exception e) {
            long elapsed = System.currentTimeMillis() - started;
            log.warn("AI 호출 실패 ({}, 한도 {}초): {}", label, attemptSeconds, withoutUrls(e.getMessage()));
            return failureAfter(e, label, describe(e, attemptSeconds), elapsed);
        }
    }

    /**
     * AI 제공자에 POST하고 응답을 JSON으로 읽습니다.
     *
     * <p><b>메시지 컨버터를 쓰지 않고 본문 스트림을 직접 읽는 이유</b> —
     * NVIDIA는 같은 엔드포인트인데도 모델에 따라
     * {@code Content-Type: application/octet-stream}을 붙여 보냅니다. 본문은
     * 멀쩡한 JSON인데 {@code retrieve().body(...)} 경로가 이렇게 터졌습니다.
     *
     * <pre>
     * Error while extracting response for type [...] and content type
     *   [application/octet-stream]
     * </pre>
     *
     * <p>이 오류는 요청 타입을 JsonNode에서 byte[]로 바꿔도 그대로 재현됐습니다.
     * 즉 "읽을 컨버터가 없다"가 아니라 <b>협상 단계 자체가 문제</b>였습니다.
     * {@code exchange()}로 {@link org.springframework.http.client.ClientHttpResponse}를
     * 직접 받아 스트림을 읽으면 Content-Type 협상이 아예 개입하지 않습니다.
     *
     * <p>바이트 그대로 Jackson에 넘기는 것도 의도입니다. String으로 받으면
     * charset 없는 응답이 ISO-8859-1로 해석돼 한국어가 깨집니다
     * ("분석 결과입니다." → "ë¶„ì„..." — 테스트로 고정해 둔 실제 증상).
     * JSON 규격은 UTF-8/16/32 자동 판별을 정의하고 Jackson이 이를 구현합니다.
     *
     * <p>실패하면 <b>서버가 실제로 보낸 본문 앞부분</b>을 예외 메시지에 담습니다.
     * 다음에 또 막혔을 때 추측하지 않고 바로 원인을 볼 수 있어야 합니다.
     */
    private JsonNode postJson(String endpoint, String bearerToken, Object body, int attemptSeconds) {
        return client(attemptSeconds).post()
                .uri(endpoint)
                .header("Authorization", "Bearer " + bearerToken)
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.APPLICATION_JSON)
                .body(body)
                .exchange((request, response) -> {
                    HttpStatusCode status = response.getStatusCode();
                    byte[] raw = readAll(response);

                    if (status.isError()) {
                        throw new ProviderRejected(
                                "HTTP %s — %s".formatted(status.value(), preview(raw)));
                    }
                    if (raw.length == 0) {
                        throw new IllegalStateException("응답 본문이 비어 있습니다 (HTTP %s)"
                                .formatted(status.value()));
                    }
                    try {
                        return MAPPER.readTree(raw);
                    } catch (JacksonException e) {
                        throw new IllegalStateException(
                                "응답을 JSON으로 읽지 못했습니다 — 받은 본문: " + preview(raw), e);
                    }
                }, false);   // false = 4xx/5xx에 기본 예외를 던지지 않고 위에서 직접 처리
    }

    private static byte[] readAll(ClientHttpResponse response) {
        try (InputStream in = response.getBody()) {
            return in.readAllBytes();
        } catch (IOException e) {
            throw new IllegalStateException("응답 본문을 읽지 못했습니다: " + e.getMessage(), e);
        }
    }

    /** 오류 메시지에 넣을 본문 앞부분. 길면 자릅니다. */
    private static String preview(byte[] raw) {
        if (raw == null || raw.length == 0) {
            return "(본문 없음)";
        }
        String text = new String(raw, StandardCharsets.UTF_8).replaceAll("\\s+", " ").trim();
        return text.length() > 300 ? text.substring(0, 300) + "…" : text;
    }

    /**
     * 예외를 "다음에 뭘 하면 되는지"가 보이는 문장으로 바꿉니다.
     *
     * <p>"Read timed out"만 보여 주면 사용자가 할 수 있는 일이 없습니다.
     */
    String describe(Exception e) {
        return describe(e, timeoutSeconds);
    }

    /** @param waitedSeconds 이번 호출에 실제로 걸었던 대기 한도 */
    String describe(Exception e, int waitedSeconds) {
        // 스프링의 I/O 예외 문구에는 요청 URL 전체가 들어갑니다. Cloudflare 주소에는 계정 ID가
        // 경로에 있어, DNS 실패·연결 거부 때 그 ID가 화면과 로그로 나갔습니다. 주소는 지웁니다.
        String raw = withoutUrls(e.getMessage());
        String lowered = raw.toLowerCase();

        if (lowered.contains("timed out") || lowered.contains("timeout")) {
            return ("%d초 안에 응답하지 않았습니다. 추론형 모델은 오래 걸릴 수 있습니다 — "
                    + "'자동 탐색'을 고르면 응답이 빠른 엔진으로 넘어가고, "
                    + "더 기다리려면 .env에 AI_TIMEOUT_SECONDS를 늘리세요.")
                    .formatted(waitedSeconds);
        }
        if (raw.contains("401") || lowered.contains("unauthorized")) {
            return "인증이 거절됐습니다(401). .env의 API 키를 확인하세요 — " + raw;
        }
        if (raw.contains("404")) {
            return "모델을 찾지 못했습니다(404). 제공자가 모델 이름을 바꿨을 수 있습니다 — " + raw;
        }
        if (raw.contains("429")) {
            return "호출 한도에 걸렸습니다(429). 잠시 후 다시 시도하거나 다른 엔진을 고르세요.";
        }
        return raw;
    }

    /**
     * 예외 문구에서 요청 주소를 지웁니다. 스프링의 I/O 예외 문구에는 요청 URL 전체가 들어가고, Cloudflare 주소에는 경로에
     * 계정 ID가 있습니다. 화면에 보이는 문구(describe)와 서버 로그 모두 이 함수를 거칩니다(QA-025).
     */
    static String withoutUrls(String message) {
        return String.valueOf(message).replaceAll("https?://\\S+", "<url>");
    }

    private String extractOpenAiText(JsonNode response) {
        if (response == null) {
            return null;
        }
        JsonNode choices = response.get("choices");
        if (choices == null || !choices.isArray() || choices.isEmpty()) {
            return null;
        }
        JsonNode message = choices.get(0).get("message");
        if (message == null) {
            return null;
        }
        String content = message.path("content").asText("");
        if (content.isBlank()) {
            // 추론형 모델은 reasoning_content에만 담아 주는 경우가 있습니다.
            content = message.path("reasoning_content").asText("");
        }
        return content;
    }

    /**
     * Claude 호출(공식 Java SDK).
     *
     * <p>Haiku 5.5에 맞춘 요청입니다 — {@code temperature}를 보내지 않고(기본값이 아니면 400),
     * 사고는 기본(adaptive)으로 두며 effort를 명시합니다(이 모델의 기본은 medium이지만 바뀌어도
     * 리포트 품질이 흔들리지 않게 적어 둡니다). 응답 앞에 사고 블록이 올 수 있어 <b>텍스트 블록만</b>
     * 이어 붙입니다 — 첫 블록을 답으로 읽으면 빈 문자열이 됩니다.
     *
     * <p>SDK의 자동 재시도는 끕니다. 대기 한도는 이 서비스가 시도마다 정하고, 실패하면 자동 탐색이
     * 다음 엔진으로 넘어가는 것이 재시도 정책입니다. SDK가 몰래 다시 보내면 "엔진당 N초"가 깨집니다.
     */
    Map<String, Object> callAnthropic(String label, String model, String prompt, String systemPrompt,
                                      int attemptSeconds) {
        if (anthropicKey == null || anthropicKey.isBlank()) {
            return failure(label, label + " API Key 누락 — .env에 ANTHROPIC_API_KEY를 넣고 make up 하세요.");
        }

        MessageCreateParams.Builder params = MessageCreateParams.builder()
                .model(model)
                .maxTokens(ANTHROPIC_MAX_TOKENS)
                .outputConfig(OutputConfig.builder().effort(OutputConfig.Effort.MEDIUM).build())
                .addUserMessage(prompt);
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            params.system(systemPrompt);
        }

        long started = System.currentTimeMillis();
        try {
            // 대기 한도는 이 호출에만 겁니다. SDK가 그 한도로 연결 풀을 같이 쓰는 호출을 만듭니다.
            Message message = anthropicClient().messages().create(params.build(),
                    RequestOptions.builder().timeout(Duration.ofSeconds(attemptSeconds)).build());
            long elapsed = System.currentTimeMillis() - started;

            StopReason stop = message.stopReason().orElse(null);
            if (StopReason.REFUSAL.equals(stop)) {
                // 안전 분류기가 거절한 경우(HTTP 200). Haiku 5.5에는 서버 쪽 대체 모델이 없어,
                // 이유를 적고 자동 탐색이 다음 엔진으로 넘어가게 합니다.
                return chargedFailure(label, "Claude가 이 요청을 거절했습니다(refusal): " + refusalReason(message), elapsed);
            }

            String text = textOf(message);
            if (text.isBlank()) {
                String why = StopReason.MAX_TOKENS.equals(stop)
                        ? "출력 한도(%d 토큰)에 걸려 답을 쓰기 전에 끝났습니다".formatted(ANTHROPIC_MAX_TOKENS)
                        : "응답 텍스트 추출 실패 (stop_reason=" + stop + ")";
                return chargedFailure(label, why, elapsed);
            }

            Map<String, Object> out = success(label, model, text.trim(), elapsed);
            Map<String, Object> usage = new LinkedHashMap<>();
            usage.put("inputTokens", message.usage().inputTokens());
            usage.put("outputTokens", message.usage().outputTokens());
            out.put("usage", usage);
            return out;
        } catch (RuntimeException e) {
            AnthropicError error = classifyAnthropic(e, model, attemptSeconds);
            return anthropicFailure(label, started, error.message(), e, error.charged());
        }
    }

    /**
     * Claude 호출 예외를 나눈 결과 — 종류({@link StructuredResult#errorKind}와 같은 이름), 화면 문구, 과금 여부.
     * 리포트({@link #callAnthropic})와 구조화 출력({@link #structured})이 같은 표를 써서, SDK를 올릴 때 한 곳만 고칩니다.
     */
    private record AnthropicError(String kind, String message, boolean charged) {
    }

    /**
     * SDK 예외 → {@link AnthropicError}. 401·403·404·429·그 밖의 HTTP 오류 상태는 제공자가 요청을 받지 않았으므로 과금되지
     * 않았고({@code charged=false}), 연결·시간 초과 등은 {@link #reachedModel}로 판단합니다(QA-021).
     *
     * <p>하위 예외(401·403·404·429)를 먼저 봅니다 — 모두 {@link AnthropicServiceException}의 하위 클래스입니다.
     * 응답은 왔는데 모양을 읽지 못한 경우({@link AnthropicInvalidDataException})는 모델이 이미 답한 것이라 {@code EMPTY}입니다.
     */
    private AnthropicError classifyAnthropic(RuntimeException e, String model, int attemptSeconds) {
        if (e instanceof UnauthorizedException) {
            return new AnthropicError("UNAUTHORIZED", "인증이 거절됐습니다(401). .env의 ANTHROPIC_API_KEY를 확인하세요.", false);
        }
        if (e instanceof PermissionDeniedException) {
            return new AnthropicError("FORBIDDEN", "권한이 없습니다(403). 키의 워크스페이스·모델 접근 권한을 확인하세요.", false);
        }
        if (e instanceof NotFoundException) {
            return new AnthropicError("NOT_FOUND", "모델을 찾지 못했습니다(404): " + model, false);
        }
        if (e instanceof RateLimitException) {
            return new AnthropicError("RATE_LIMIT", "호출 한도에 걸렸습니다(429). 잠시 후 다시 시도하거나 다른 엔진을 고르세요.", false);
        }
        if (e instanceof AnthropicServiceException service) {
            String type = service.errorType().map(String::valueOf).orElse("알 수 없음");
            String hint = service.statusCode() == 402
                    ? " — 크레딧이 부족합니다. platform.claude.com의 Billing을 확인하세요."
                    : service.statusCode() == 529 ? " — Anthropic 서버가 과부하입니다. 잠시 후 다시 시도하세요." : "";
            return new AnthropicError("HTTP", "HTTP %d (%s)%s".formatted(service.statusCode(), type, hint), false);
        }
        String kind = e instanceof AnthropicInvalidDataException ? "EMPTY" : isTimeout(e) ? "TIMEOUT" : "IO";
        return new AnthropicError(kind, describe(e, attemptSeconds), reachedModel(e));
    }

    /**
     * 대기 한도에 걸린 실패인가. {@link #describe}와 같은 문구 기준에, 문구가 비어 있는 경우를 위해 원인 사슬의
     * {@link java.io.InterruptedIOException}(OkHttp의 호출 한도·{@link java.net.SocketTimeoutException}의 부모)도 봅니다.
     */
    private static boolean isTimeout(Throwable e) {
        for (Throwable cause = e; cause != null; cause = cause.getCause()) {
            String text = String.valueOf(cause.getMessage()).toLowerCase(java.util.Locale.ROOT);
            if (cause instanceof java.io.InterruptedIOException || cause instanceof java.util.concurrent.TimeoutException
                    || text.contains("timed out") || text.contains("timeout")) {
                return true;
            }
            if (cause.getCause() == cause) {
                break;
            }
        }
        return false;
    }

    /** 안전 분류기 거절(refusal)의 분류·설명 — 리포트와 구조화 출력이 같은 문구를 씁니다. */
    private static String refusalReason(Message message) {
        return message.stopDetails()
                .map(details -> details.category().map(String::valueOf).orElse("분류 없음")
                        + details.explanation().map(text -> " — " + text).orElse(""))
                .orElse("사유 없음");
    }

    /**
     * 모의 매매 Claude 책의 결과 한 건(설계 §5-1, 명세 C2·C3·C7).
     *
     * @param ok               응답 텍스트를 받았고 거절·잘림이 아님. 텍스트가 스키마에 맞는지는 부른 쪽이 검사합니다(D26)
     * @param text             응답의 텍스트 블록을 이어 붙인 것(사고 블록 제외). 받은 것이 없으면 null — 실패여도 받은 텍스트는
     *                         남깁니다(출력 한도로 잘린 JSON 등, 결정 기록의 원문용)
     * @param stopReason       API의 {@code stop_reason} 원문(예: end_turn·refusal·max_tokens). 응답이 없으면 null
     * @param errorKind        NOT_ALLOWED · NO_KEY · UNAUTHORIZED · FORBIDDEN · NOT_FOUND · RATE_LIMIT · HTTP · IO · TIMEOUT ·
     *                         REFUSAL · EMPTY · MAX_TOKENS. 성공이면 null. NOT_ALLOWED·NO_KEY는 요청을 보내지 않은 것
     * @param error            사람이 읽는 실패 사유(한국어, 키·요청 주소 없음). 성공이면 null
     * @param charged          모델에 닿아 과금됐을 수 있는가(실패여도 true일 수 있음, QA-021)
     * @param inputTokens      입력 토큰. 응답이 없으면 null(0으로 채우지 않음)
     * @param outputTokens     출력 토큰(사고 포함). 응답이 없으면 null
     * @param cacheReadTokens  캐시에서 읽은 입력 토큰. API가 값을 주지 않으면 null
     * @param cacheWriteTokens 캐시에 새로 쓴 입력 토큰. API가 값을 주지 않으면 null
     * @param latencyMs        호출에 걸린 시간(실제 시계, 밀리초). 네트워크에 나가지 않았으면 0
     */
    public record StructuredResult(boolean ok, String text, String stopReason, String errorKind, String error,
                                   boolean charged, Long inputTokens, Long outputTokens, Long cacheReadTokens,
                                   Long cacheWriteTokens, long latencyMs) {
    }

    /**
     * 구조화 출력이 이 모델을 불러도 되는가 — 허용 목록이 없으면 늘 그렇고, 있으면 목록 안 Anthropic 엔진의 모델과 같을 때만
     * (예: {@code AI_ENGINES=anthropic_haiku}면 Haiku만, Sonnet은 안 됨).
     */
    boolean structuredModelAllowed(String model) {
        return allowed == null || ENGINES.stream().anyMatch(engine -> allowed.contains(engine.id())
                && "anthropic".equals(engine.provider()) && model.equals(engine.model()));
    }

    /**
     * 구조화 출력 호출 — 스키마로 응답 모양을 강제하는 Claude 호출 한 번(설계 §0-4·§5-1).
     *
     * <p>리포트 경로와 따로입니다: 엔진 레지스트리·자동 탐색(폴오버)·번역을 타지 않고, 부른 쪽이 고른 모델만
     * <b>한 번</b> 부릅니다. 허용 목록({@code AI_ENGINES})이 있는 배포에서는 목록 안 Anthropic 엔진의 모델일 때만 부르고, 아니면
     * 나가지 않고 {@code NOT_ALLOWED}입니다(키 검사보다 먼저 — 엔진 목록 화면과 같은 순서). 목록이 비면 제한 없음(기본·로컬). 거절·오류 때 다른 모델로 넘어가지 않습니다(D5) — 서버 쪽 대체 모델({@code fallbacks})도
     * 보내지 않고 SDK 재시도도 꺼져 있어, 재시도 정책(같은 거래일 한 번, C7)은 부른 쪽이 정합니다.
     * 클라이언트·키·오류 분류·로그(키·요청 주소 가림)는 리포트와 같은 것을 씁니다.
     *
     * <p>요청: {@code temperature}·{@code thinking} 없음(사고는 기본 adaptive, C2), 출력 한도 {@value #STRUCTURED_MAX_TOKENS}토큰,
     * effort 명시, 시스템 프롬프트는 캐시 블록(ephemeral) — 하루 한 번 바뀌는 프레임이 앞에, 매일 다른 패킷이 사용자
     * 메시지에 있어 같은 프레임 판의 재호출(재시도·미리보기)이 캐시를 읽습니다.
     *
     * <p>출력 한도로 끝났으면({@code max_tokens}) 텍스트가 있어도 실패({@code MAX_TOKENS})입니다 — 잘린 JSON은 스키마를
     * 지킬 수 없습니다. 받은 텍스트는 {@code text}에 남깁니다.
     *
     * @param model          모델 ID(설정에서 고른 것 — 검사는 설정 쪽, S1~S3)
     * @param system         시스템 프롬프트(프레임 렌더링). 비었으면 보내지 않습니다
     * @param user           사용자 메시지(패킷 텍스트)
     * @param apiSchema      API에 보낼 JSON 스키마({@code StructuredSchema.forApi()} — API가 받지 않는 키를 걷어 낸 것, D26)
     * @param effort         low·medium·high·xhigh·max(대소문자 무시). null·빈 값이면 high(C2 기본)
     * @param timeoutSeconds 이 호출의 대기 한도(초, 1 이상)
     * @throws IllegalArgumentException 모델·사용자 메시지·스키마가 비었거나 effort·대기 한도가 틀렸을 때 — 설정 검사를 지나
     *                                  여기 닿았다면 코드 오류라, 과금되는 호출을 보내지 않고 바로 멈춥니다
     */
    public StructuredResult structured(String model, String system, String user, Map<String, Object> apiSchema,
                                       String effort, int timeoutSeconds) {
        if (model == null || model.isBlank()) {
            throw new IllegalArgumentException("모델 ID가 비었습니다");
        }
        if (user == null || user.isBlank()) {
            throw new IllegalArgumentException("사용자 메시지가 비었습니다");
        }
        if (apiSchema == null || apiSchema.isEmpty()) {
            throw new IllegalArgumentException("응답 스키마가 비었습니다");
        }
        if (timeoutSeconds < 1) {
            throw new IllegalArgumentException("대기 한도는 1초 이상이어야 합니다: " + timeoutSeconds);
        }
        OutputConfig.Effort level = effortOf(effort);

        if (!structuredModelAllowed(model)) {
            return new StructuredResult(false, null, null, "NOT_ALLOWED",
                    ("이 배포의 AI_ENGINES 허용 목록에 %s 모델이 없어 부르지 않았습니다 — 목록을 비우거나 이 모델의 엔진을 넣고 "
                            + "make up 하세요(ADR 0014·0018).").formatted(model), false, null, null, null, null, 0L);
        }
        if (anthropicKey == null || anthropicKey.isBlank()) {
            return new StructuredResult(false, null, null, "NO_KEY",
                    "Claude API Key 누락 — .env에 ANTHROPIC_API_KEY를 넣고 make up 하세요.", false,
                    null, null, null, null, 0L);
        }

        // 스키마는 키마다 JsonValue로 넣습니다(단계 0 확인 — Jackson 3로 읽은 Map·List·원시값을 SDK가 그대로 받음).
        JsonOutputFormat.Schema.Builder schema = JsonOutputFormat.Schema.builder();
        apiSchema.forEach((key, value) -> schema.putAdditionalProperty(key, JsonValue.from(value)));

        MessageCreateParams.Builder params = MessageCreateParams.builder()
                .model(model)
                .maxTokens(STRUCTURED_MAX_TOKENS)
                .outputConfig(OutputConfig.builder()
                        .effort(level)
                        .format(JsonOutputFormat.builder().schema(schema.build()).build())
                        .build())
                .addUserMessage(user);
        if (system != null && !system.isBlank()) {
            // 문자열 system(String)으로는 캐시 표시를 달 수 없어 블록 목록으로 보냅니다.
            params.systemOfTextBlockParams(List.of(TextBlockParam.builder()
                    .text(system)
                    .cacheControl(CacheControlEphemeral.builder().build())
                    .build()));
        }

        long started = System.currentTimeMillis();
        try {
            Message message = anthropicClient().messages().create(params.build(),
                    RequestOptions.builder().timeout(Duration.ofSeconds(timeoutSeconds)).build());
            long elapsed = System.currentTimeMillis() - started;

            StopReason stop = message.stopReason().orElse(null);
            String stopText = stop == null ? null : stop.asString();
            String text = textOf(message);
            String kept = text.isBlank() ? null : text;
            Long[] usage = usageOf(message);

            String kind = null;
            String error = null;
            if (StopReason.REFUSAL.equals(stop)) {
                // 안전 분류기 거절(HTTP 200). 다른 모델로 넘기지 않고(D5) 사유만 남깁니다.
                kind = "REFUSAL";
                error = "Claude가 이 요청을 거절했습니다(refusal): " + refusalReason(message);
            } else if (StopReason.MAX_TOKENS.equals(stop)) {
                kind = "MAX_TOKENS";
                error = kept == null
                        ? "출력 한도(%d 토큰)에 걸려 답을 쓰기 전에 끝났습니다".formatted(STRUCTURED_MAX_TOKENS)
                        : "출력 한도(%d 토큰)에 걸려 응답이 중간에 잘렸습니다".formatted(STRUCTURED_MAX_TOKENS);
            } else if (kept == null) {
                kind = "EMPTY";
                error = "응답 텍스트 추출 실패 (stop_reason=" + stopText + ")";
            }
            if (kind != null) {
                log.warn("Claude 구조화 출력 실패 ({}): {} — {}", model, kind, error);
            }
            return new StructuredResult(kind == null, kept, stopText, kind, error, true,
                    usage[0], usage[1], usage[2], usage[3], elapsed);
        } catch (RuntimeException e) {
            long elapsed = System.currentTimeMillis() - started;
            AnthropicError failure = classifyAnthropic(e, model, timeoutSeconds);
            // 리포트용 문구 중 "다른 엔진을 고르세요"·"자동 탐색" 안내는 이 경로에 맞지 않아(엔진 선택 없음, D5) 바꿉니다.
            String message = switch (failure.kind()) {
                case "RATE_LIMIT" -> "호출 한도에 걸렸습니다(429).";
                case "TIMEOUT" -> "%d초 안에 응답하지 않았습니다(대기 한도 초과).".formatted(timeoutSeconds);
                default -> failure.message();
            };
            // 예외 문구에는 키가 들어가지 않지만, 요청 주소는 지웁니다(describe와 같은 규칙, QA-025).
            log.warn("Claude 구조화 출력 호출 실패 ({}): {} — {}", model, failure.kind(), withoutUrls(e.getMessage()));
            return new StructuredResult(false, null, null, failure.kind(), message, failure.charged(),
                    null, null, null, null, elapsed);
        }
    }

    /** effort 문자열 → SDK 값. null·빈 값은 high(C2 기본). 모르는 값은 보내 보고 400을 받는 대신 바로 멈춥니다. */
    static OutputConfig.Effort effortOf(String effort) {
        if (effort == null || effort.isBlank()) {
            return OutputConfig.Effort.HIGH;
        }
        return switch (effort.strip().toLowerCase(java.util.Locale.ROOT)) {
            case "low" -> OutputConfig.Effort.LOW;
            case "medium" -> OutputConfig.Effort.MEDIUM;
            case "high" -> OutputConfig.Effort.HIGH;
            case "xhigh" -> OutputConfig.Effort.XHIGH;
            case "max" -> OutputConfig.Effort.MAX;
            default -> throw new IllegalArgumentException(
                    "effort는 low·medium·high·xhigh·max 중 하나여야 합니다: " + effort);
        };
    }

    /**
     * 토큰 사용량 {입력, 출력, 캐시 읽기, 캐시 쓰기}. 응답에 usage가 없거나 모양이 틀리면 null로 둡니다 — 사용량 기록이
     * 0으로 채워져 "공짜 호출"로 보이지 않게 합니다.
     */
    private static Long[] usageOf(Message message) {
        Long[] out = new Long[4];
        try {
            Usage usage = message.usage();
            out[0] = usage.inputTokens();
            out[1] = usage.outputTokens();
            out[2] = usage.cacheReadInputTokens().orElse(null);
            out[3] = usage.cacheCreationInputTokens().orElse(null);
        } catch (AnthropicInvalidDataException e) {
            log.warn("Claude 응답의 토큰 사용량을 읽지 못했습니다: {}", withoutUrls(e.getMessage()));
        }
        return out;
    }

    private Map<String, Object> anthropicFailure(String label, long started, String message, Exception e,
                                                 boolean charged) {
        long elapsed = System.currentTimeMillis() - started;
        // 예외 문구에는 키가 들어가지 않지만, 요청 주소는 지웁니다(describe와 같은 규칙).
        log.warn("Claude 호출 실패 ({}): {}", label, withoutUrls(e.getMessage()));
        Map<String, Object> out = failure(label, message, elapsed);
        out.put(CHARGED, charged);
        return out;
    }

    /** 응답의 텍스트 블록만 순서대로 이어 붙입니다(사고 블록은 건너뜀). */
    private static String textOf(Message message) {
        StringBuilder text = new StringBuilder();
        message.content().forEach(block -> block.text().ifPresent(t -> text.append(t.text())));
        return text.toString();
    }

    /** 하나뿐인 Claude 클라이언트. 기본 대기 한도는 설정값(timeoutSeconds)이고, 호출마다 요청 옵션의 한도가 덮어씁니다. */
    private AnthropicClient anthropicClient() {
        AnthropicClient client = anthropicClient;
        if (client == null) {
            synchronized (anthropicClientLock) {
                client = anthropicClient;
                if (client == null) {
                    client = newAnthropicClient(timeoutSeconds);
                    anthropicClient = client;
                }
            }
        }
        return client;
    }

    /**
     * Claude 클라이언트를 새로 만듭니다({@code seconds}는 요청 옵션이 없을 때의 기본 대기 한도). 키는 생성자에 명시해
     * 넘깁니다 — 넘기지 않으면 SDK가 환경 변수·로컬 프로필에서 자격 증명을 찾아, 설정하지 않은 키로 조용히 호출할 수
     * 있습니다. 테스트가 만든 수를 셀 때 바꿔 끼웁니다.
     */
    AnthropicClient newAnthropicClient(int seconds) {
        AnthropicOkHttpClient.Builder builder = AnthropicOkHttpClient.builder()
                .apiKey(anthropicKey)
                .timeout(Duration.ofSeconds(seconds))
                .maxRetries(0);
        if (anthropicBaseUrl != null) {
            builder.baseUrl(anthropicBaseUrl);
        }
        return builder.build();
    }

    private Map<String, Object> callCloudflare(String label, String model,
                                               String prompt, String systemPrompt,
                                               int attemptSeconds) {
        if (cloudflareAccountId.isBlank() || cloudflareToken.isBlank()) {
            return failure(label, "Cloudflare 인증 정보 누락");
        }

        List<Map<String, String>> messages = new ArrayList<>();
        if (systemPrompt != null && !systemPrompt.isBlank()) {
            messages.add(Map.of("role", "system", "content", systemPrompt));
        }
        messages.add(Map.of("role", "user", "content", prompt));

        long started = System.currentTimeMillis();
        try {
            JsonNode response = postJson(
                    "https://api.cloudflare.com/client/v4/accounts/%s/ai/run/%s"
                            .formatted(cloudflareAccountId, model),
                    cloudflareToken,
                    Map.of("messages", messages),
                    attemptSeconds);

            long elapsed = System.currentTimeMillis() - started;
            if (response != null && response.path("success").asBoolean(false)) {
                String text = response.path("result").path("response").asText("");
                if (!text.isBlank()) {
                    return success(label, model, text.trim(), elapsed);
                }
            }
            return chargedFailure(label, "응답 실패: "
                    + (response == null ? "null" : response.path("errors").toString()), elapsed);
        } catch (Exception e) {
            long elapsed = System.currentTimeMillis() - started;
            log.warn("Cloudflare AI 호출 실패 (한도 {}초): {}", attemptSeconds, withoutUrls(e.getMessage()));
            return failureAfter(e, label, describe(e, attemptSeconds), elapsed);
        }
    }

    /**
     * 응답이 한국어가 아니면 제공자별 번역기로 한 번 더 호출합니다.
     *
     * <p>번역도 한 번의 AI 호출이지만 <b>호출한 쪽의 마감</b> 안에서만 합니다(QA-094). 남은 시간만 주고(시도 한도
     * {@code capSeconds} 이하), {@value #MIN_ATTEMPT_SECONDS}초보다 적게 남았으면 번역하지 않고 원문과 그 이유를
     * 돌려줍니다. 예전에는 직접 고른 엔진의 번역이 한도를 처음부터 다시 받아 전체 대기가 두 배까지 됐고, 자동 탐색도
     * 최소 15초를 줘 예산을 넘겼습니다 — 화면의 "최대 N초"·"전체 N초" 약속과 AWS 앞단 한도가 깨졌습니다.
     *
     * @param deadlineMs 이 생성의 마감 시각({@link #clockMillis} 기준)
     * @param limitLabel 건너뛸 때 이유에 적을 한도 이름(예: "대기 한도 110초")
     */
    private Map<String, Object> translateIfNeeded(Map<String, Object> result, String provider,
                                                  long deadlineMs, int capSeconds, String limitLabel) {
        if (!Boolean.TRUE.equals(result.get("status"))) {
            return result;
        }
        String text = String.valueOf(result.get("response"));
        if (isKorean(text)) {
            result.put("translationInfo", "번역 불필요 — 한국어 응답");
            return result;
        }

        // 번역기는 제공자별로 따로입니다(Claude → Claude, NVIDIA → NVIDIA, 나머지 → Cloudflare). 허용 목록이 그 제공자의
        // 엔진을 하나도 두지 않았으면 번역하지 않습니다 — 예: Cerebras만 허용했는데 Cloudflare 번역기를 부르면 안 됩니다.
        String translator = switch (provider) {
            case "anthropic", "nvidia" -> provider;
            default -> "cloudflare";
        };
        if (!providerAllowed(translator)) {
            result.put("translationInfo", "자동 번역 건너뜀 — 이 배포에서 쓰지 않는 번역기(%s)입니다. 분석 원문을 그대로 표시합니다."
                    .formatted(translator));
            return result;
        }
        int attemptSeconds = attemptBudget(deadlineMs, clockMillis.getAsLong(), capSeconds);
        if (attemptSeconds < 0) {
            result.put("translationInfo", ("자동 번역 건너뜀 — %s 안에 번역할 시간이 남지 않았습니다(%d초 미만). "
                    + "분석 원문을 그대로 표시합니다.").formatted(limitLabel, MIN_ATTEMPT_SECONDS));
            return result;
        }

        Map<String, Object> translated = switch (provider) {
            case "anthropic" -> callAnthropic("Claude 번역기", "claude-haiku-5-5",
                    text, TRANSLATION_PROMPT, attemptSeconds);
            case "nvidia" -> callOpenAiFormat("NVIDIA 번역기", nvidiaUrl, nvidiaKey,
                    TRANSLATORS.get("nvidia"), text, TRANSLATION_PROMPT, attemptSeconds);
            default -> callCloudflare("Cloudflare 번역기", TRANSLATORS.get("cloudflare"),
                    text, TRANSLATION_PROMPT, attemptSeconds);
        };

        if (Boolean.TRUE.equals(translated.get("status"))) {
            result.put("originalResponse", text);
            result.put("response", translated.get("response"));
            result.put("translationInfo", "자동 한국어 번역 완료 — " + translated.get("provider"));
        } else {
            result.put("translationInfo", "자동 번역 실패 — 분석 원문을 그대로 표시합니다.");
            result.put("translationError", translated.get("error"));
        }
        return result;
    }

    /** 한글 비중으로 한국어 응답인지 간단히 판별합니다. */
    static boolean isKorean(String text) {
        if (text == null || text.isBlank()) {
            return false;
        }
        int korean = count(HANGUL, text);
        int alphabetic = Math.max(1, count(ALPHABETIC, text));
        return korean >= 8 && (double) korean / alphabetic >= 0.05;
    }

    private static int count(Pattern pattern, String text) {
        Matcher matcher = pattern.matcher(text);
        int count = 0;
        while (matcher.find()) {
            count++;
        }
        return count;
    }

    /** 이 제공자의 엔진이 허용 목록에 하나라도 있는가(목록이 없으면 늘 true) — 번역기를 부를지 정합니다. */
    private boolean providerAllowed(String provider) {
        return allowed == null || ENGINES.stream()
                .anyMatch(engine -> provider.equals(engine.provider()) && allowed.contains(engine.id()));
    }

    private boolean hasKey(String provider) {
        return switch (provider) {
            case "anthropic" -> !anthropicKey.isBlank();
            case "nvidia" -> !nvidiaKey.isBlank();
            case "cerebras" -> !cerebrasKey.isBlank();
            case "cloudflare" -> !cloudflareAccountId.isBlank() && !cloudflareToken.isBlank();
            case "auto" -> anyKeyPresent();
            default -> false;
        };
    }

    private Map<String, Object> success(String provider, String model, String text, long elapsedMs) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", true);
        out.put(CHARGED, true);
        out.put("provider", provider);
        out.put("model", model);
        out.put("response", text);
        out.put("error", null);
        out.put("latencyMs", elapsedMs);
        out.put("pipelineStep", provider + " 성공");
        return out;
    }

    private Map<String, Object> failure(String provider, String error) {
        return failure(provider, error, 0);
    }

    /** 모델이 응답한 뒤의 실패(거절·빈 응답·출력 한도) — 입력 토큰은 이미 과금됐습니다. */
    private Map<String, Object> chargedFailure(String provider, String error, long elapsedMs) {
        Map<String, Object> out = failure(provider, error, elapsedMs);
        out.put(CHARGED, true);
        return out;
    }

    /** 예외로 끝난 호출 — 연결 단계에서 끝났거나 제공자가 HTTP 오류로 거절했으면 과금되지 않았습니다. */
    private Map<String, Object> failureAfter(Exception e, String provider, String error, long elapsedMs) {
        Map<String, Object> out = failure(provider, error, elapsedMs);
        out.put(CHARGED, reachedModel(e));
        return out;
    }

    /**
     * 이 예외로 끝난 호출이 모델에 닿았을(과금됐을) 수 있는가. 연결을 맺지 못했거나(DNS·연결 거부·연결 시간 초과)
     * 제공자가 HTTP 오류 상태로 거절했으면 아니고, 그 밖(응답을 기다리다 시간 초과 등)은 알 수 없어 <b>닿은 것으로</b>
     * 봅니다 — 되돌리지 않는 쪽이 비용 상한을 지킵니다(QA-021).
     */
    static boolean reachedModel(Throwable e) {
        for (Throwable cause = e; cause != null; cause = cause.getCause()) {
            if (cause instanceof ProviderRejected
                    || cause instanceof java.net.ConnectException
                    || cause instanceof java.net.UnknownHostException
                    || cause instanceof java.net.NoRouteToHostException
                    || cause instanceof java.net.http.HttpConnectTimeoutException) {
                return false;
            }
            if (cause instanceof java.net.SocketTimeoutException
                    && String.valueOf(cause.getMessage()).toLowerCase(java.util.Locale.ROOT).contains("connect")) {
                return false;
            }
            if (cause.getCause() == cause) {
                break;
            }
        }
        return true;
    }

    /** 제공자가 HTTP 오류 상태로 답한 호출. */
    static final class ProviderRejected extends IllegalStateException {
        ProviderRejected(String message) {
            super(message);
        }
    }

    /**
     * 모델에 닿기 전에 끝난 실패(설정 없음·허용 목록 밖·키 없음·제공자가 거절한 요청) — {@code charged: false}.
     * 사용량 한도는 이런 실패만 되돌립니다(QA-021).
     */
    private Map<String, Object> failure(String provider, String error, long elapsedMs) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", false);
        out.put(CHARGED, false);
        out.put("provider", provider);
        out.put("response", "");
        out.put("error", error);
        out.put("latencyMs", elapsedMs);
        out.put("pipelineStep", provider + " 실패");
        return out;
    }
}
