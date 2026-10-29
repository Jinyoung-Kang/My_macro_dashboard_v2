package com.macrodash.feature.paper;

import com.macrodash.Kst;
import com.macrodash.analytics.CalendarUnavailableException;
import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.OrderValidator.Proposed;
import com.macrodash.analytics.OrderValidator.Verdict;
import com.macrodash.analytics.PaperLedger;
import com.macrodash.analytics.TrailingStop;
import com.macrodash.feature.ai.AiService;
import com.macrodash.feature.paper.ClaudeBookService.ClaudeSettings;
import com.macrodash.feature.paper.PacketBuilder.Packet;
import com.macrodash.feature.paper.PaperMarketData.Quotes;
import com.macrodash.feature.paper.RuleBookService.RuleSettings;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.BookState;
import com.macrodash.store.PaperStore.Decision;
import com.macrodash.store.PaperStore.Fill;
import com.macrodash.store.PaperStore.Lockout;
import com.macrodash.store.PaperStore.Order;
import com.macrodash.store.PaperStore.Position;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.support.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

import static com.macrodash.feature.paper.ClaudeBookService.ERROR_CHARS;
import static com.macrodash.feature.paper.ClaudeBookService.MISMATCH_PCT;
import static com.macrodash.feature.paper.ClaudeBookService.PAUSED_DURING_CALL;
import static com.macrodash.feature.paper.ClaudeBookService.STATUS_API_ERROR;
import static com.macrodash.feature.paper.ClaudeBookService.STATUS_FORMAT_ERROR;
import static com.macrodash.feature.paper.ClaudeBookService.STATUS_NO_TRADE;
import static com.macrodash.feature.paper.ClaudeBookService.STATUS_OK;
import static com.macrodash.feature.paper.ClaudeBookService.STATUS_REFUSED;
import static com.macrodash.feature.paper.ClaudeBookService.STATUS_SKIPPED;
import static com.macrodash.feature.paper.ClaudeBookService.VIOLATIONS_IN_ERROR;
import static com.macrodash.feature.paper.ClaudeBookService.capMessage;
import static com.macrodash.feature.paper.ClaudeBookService.clip;
import static com.macrodash.feature.paper.ClaudeBookService.inputsStale;
import static com.macrodash.feature.paper.ClaudeBookService.noPriceTickers;

/**
 * 🧪 Claude 책 결정 한 번의 파이프라인 — <b>호출</b>(프레임 판 렌더링 → 패킷 → 일일 호출 상한 → 구조화 출력 → 사용량 → 스키마 검사),
 * <b>검증</b>(검증기 문맥·판정·노출 비교·결정 응답), <b>기록</b>(주문 행·결정 행·호출 실패·응답 뒤 오류·건너뜀·호출 상한). 규칙은
 * {@link ClaudeBookService} 클래스 설명 그대로입니다.
 *
 * <p>2단계 명세 §9 A6에서 {@link ClaudeBookService}의 이 부분만 그대로 옮겨 왔습니다(떼어 내기 — 동작·문구·기록·로그 이름 그대로).
 * 언제 부르고 무엇을 지키는지(재시도 한 번·일시정지·호출 사이 초기화·시작·미리보기·잠금)는 서비스가 정하고, 이 클래스는 그 결정
 * 한 번의 일만 합니다. 서비스가 만들어 쥐는 객체라 빈이 아닙니다.
 *
 * <p><b>Claude 계좌마다 하나</b>입니다({@link MarketContext} — 계좌 프로필 {@link ClaudeBookProfile}, 계좌2 명세 §9-1). 책 코드
 * ({@link ClaudeBookProfile#code} — 시장 기본 계좌는 {@link PaperMarket#claudeBook})·거래일 달력(보유 거래일·주문 만료·재진입 금지를 보는
 * 다음 세션)·시스템 프롬프트의 시장별 부분(하드 규칙 줄은 시장 묶음, 끝의 고정 문단은 계좌 프로필 —
 * {@link FrameworkService#render(ClaudeBookProfile, JsonNode, int, JsonNode)})·패킷·응답 스키마를 그 문맥에서 가져오고, 다른 계좌 책은
 * 읽지도 쓰지도 않습니다. 프레임 판(두 시장이 함께 씀, 명세 K9)과 하루 호출
 * 상한({@link PaperApiCalls} — 두 책 합 20, K18)은 시장과 상관없이 하나입니다. 검증기의 받는 체결 시점·이른 시점·근거 문구의 시점
 * 이름과 금액 표기는 그 시장 묶음의 것이고({@link PaperMarket#orderValidation}, A7 — 시점 순위만 계좌 프로필의 것, 계좌2 명세 §10-5),
 * 검증기 한도·현금성은 그 시장의 설정 키입니다
 * (C1a — {@link PaperSettings#from(JsonNode, PaperMarket)}·{@link PacketBuilder.Limits#from(JsonNode, PaperMarket)}). 미국 문맥은 이 묶음 전의 값 그대로입니다({@link UsPaperMarket}·{@link PacketBuilder#build}·
 * {@value ClaudeBookService#SCHEMA_RESOURCE}).
 *
 * <p>서비스가 만들어 쥐는 파이프라인은 시장 묶음에 묶이고, 하루 결정은 그 실행({@link MarketRun})에 묶은 사본({@link #bind})으로 돕니다
 * — 보유 거래일·주문 만료·재진입 금지를 보는 다음 세션이 결정 작업이 연 달력 한 벌로 셉니다(C1a).
 */
final class ClaudeDecisionPipeline {

    /** 로그 이름은 옮기기 전 그대로(ClaudeBookService) — 운영 로그를 찾는 이름이 바뀌지 않게. */
    private static final Logger log = LoggerFactory.getLogger(ClaudeBookService.class);

    /** 그 시장의 결정 패킷을 만드는 함수 — 미국은 {@link PacketBuilder#build}. 인자는 결정이 읽은 판 번호와 설정 행. */
    @FunctionalInterface
    interface PacketSource {
        Packet build(LocalDate asOf, String kind, boolean initial, Integer frameworkVersion, SettingsRow row);
    }

    /**
     * 그 실행의 관측치·읽은 순간까지 받는 패킷 — 한국({@link KrPacketBuilder#build}, 2단계 명세 §4-7 'E1a 구현에서 정한 것'). 결정 게이트가 본
     * 관측치로 만들고 읽은 순간 뒤에 수집된 값은 쓰지 않습니다(그래서 결정 행의 동결본 = 보낸 패킷이 그 순간의 판입니다).
     */
    @FunctionalInterface
    interface RunPacketSource {
        Packet build(MarketRun run, LocalDate asOf, String kind, boolean initial, Integer frameworkVersion,
                     Optional<Quotes> quotes, Instant readAt);
    }

    /**
     * 그 결정이 본 그 실행의 재료(한국 — E2b): 결정 게이트가 본 관측치(장부·체결 가능 판정이 쓴 것 — 패킷 {@code 8_prices}·정수 주 기준 가격이
     * 같은 값), 읽은 순간(그 실행의 지금 — 규칙 계좌 입력 동결과 같은 순간), 결정 행 응답에 남길 자료 게이트 판정(① 그 계좌 · ②~⑥, 없으면 null).
     * 미국 결정은 이것 없이(null) 패킷·검증이 저장본을 그때 읽습니다.
     */
    record Observed(Optional<Quotes> quotes, Instant readAt, List<Map<String, Object>> gates) {

        Observed {
            quotes = quotes == null ? Optional.empty() : quotes;
            java.util.Objects.requireNonNull(readAt, "readAt");
            gates = gates == null ? null : List.copyOf(gates);
        }
    }

    /**
     * Claude 결정 한 번이 계좌마다 다르게 쓰는 것(2단계 명세 §9 A6, 계좌2 명세 §9-1) — 계좌 프로필({@link ClaudeBookProfile} — 계좌 코드·시장 묶음
     * (달력·관측치·하드 규칙 줄)·응답 스키마 파일(API용과 검사용이 같은 파일 — D26)·고정 문단·받는 체결 시점)과 패킷. 패킷은 둘 중 하나입니다: 설정
     * 행만 받는 {@code packets}(미국), 그 실행의 관측치·읽은 순간까지 받는 {@code runPackets}(한국 — 결정이 {@link Observed}를 넘겨야 함).
     */
    record MarketContext(ClaudeBookProfile profile, PacketSource packets, RunPacketSource runPackets) {

        MarketContext {
            Objects.requireNonNull(profile, "profile");
            if ((packets == null) == (runPackets == null)) {
                throw new IllegalArgumentException("결정 문맥의 패킷은 packets·runPackets 중 하나입니다: " + profile.code());
            }
        }

        /** 그 시장 기본 Claude 계좌({@link ClaudeBookProfile#marketDefault})의 문맥 — 설정 행만 받는 패킷(시험용 시장 묶음). */
        MarketContext(PaperMarket market, PacketSource packets, String schemaResource) {
            this(ClaudeBookProfile.marketDefault(market, schemaResource), packets, null);
        }

        /** 계좌의 시장 묶음({@link ClaudeBookProfile#market}). */
        PaperMarket market() {
            return profile.market();
        }

        /** 계좌의 응답 스키마 파일({@link ClaudeBookProfile#schemaResource}). */
        String schemaResource() {
            return profile.schemaResource();
        }
    }

    private final PaperMarket market;
    /** 이 파이프라인의 Claude 계좌 — 책 코드·고정 문단은 여기서, 달력·하드 규칙 줄·검증기의 시장 몫은 {@link #market}에서. */
    private final ClaudeBookProfile profile;
    private final PaperStore store;
    private final PacketSource packets;
    private final RunPacketSource runPackets;
    private final FrameworkService framework;
    private final PaperApiCalls calls;
    private final AiService ai;
    private final ObjectMapper mapper;
    private final Clock clock;
    private final int timeoutSeconds;
    private final StructuredSchema schema;

    ClaudeDecisionPipeline(MarketContext context, PaperStore store, FrameworkService framework, PaperApiCalls calls,
                           AiService ai, ObjectMapper mapper, Clock clock, int timeoutSeconds) {
        this.market = context.market();
        this.profile = context.profile();
        this.store = store;
        this.packets = context.packets();
        this.runPackets = context.runPackets();
        this.framework = framework;
        this.calls = calls;
        this.ai = ai;
        this.mapper = mapper;
        this.clock = clock;
        this.timeoutSeconds = timeoutSeconds;
        // 스키마 파일이 깨졌으면 기동하지 않습니다 — 첫 결정 날 아침에야 알게 되지 않게.
        this.schema = StructuredSchema.load(context.schemaResource());
    }

    /** {@link #bind} — 같은 문맥·협력 객체·읽어 둔 스키마에 시장 문맥만 그 실행으로. */
    private ClaudeDecisionPipeline(ClaudeDecisionPipeline base, MarketRun run) {
        this.market = run;
        this.profile = base.profile;
        this.store = base.store;
        this.packets = base.packets;
        this.runPackets = base.runPackets;
        this.framework = base.framework;
        this.calls = base.calls;
        this.ai = base.ai;
        this.mapper = base.mapper;
        this.clock = base.clock;
        this.timeoutSeconds = base.timeoutSeconds;
        this.schema = base.schema;
    }

    /**
     * 이 파이프라인을 실행 하나({@link MarketRun})에 묶은 사본 — 보유 거래일·주문 만료·재진입 금지를 보는 다음 세션이 그 실행의 달력
     * 한 벌로 셉니다(C1a). 실행의 시장 묶음이 이 파이프라인의 시장 묶음이어야 합니다.
     *
     * @throws IllegalArgumentException 다른 시장의 실행
     */
    ClaudeDecisionPipeline bind(MarketRun run) {
        if (run.definition() != market.definition()) {
            throw new IllegalArgumentException("다른 시장의 실행입니다: " + run + " — 이 파이프라인은 " + market.code());
        }
        return new ClaudeDecisionPipeline(this, run);
    }

    /** 이 파이프라인의 시장 문맥 — 서비스가 만든 것은 시장 묶음, {@link #bind}한 사본은 그 실행. */
    PaperMarket market() {
        return market;
    }

    /** 이 파이프라인의 Claude 계좌 프로필({@link #bind}한 사본도 같음). */
    ClaudeBookProfile profile() {
        return profile;
    }

    /** 이 파이프라인이 읽고 쓰는 Claude 계좌의 코드({@link ClaudeBookProfile#code}). */
    String book() {
        return profile.code();
    }

    /** 결정마다 그 실행의 재료({@link Observed})가 있어야 하는 문맥인가 — 패킷이 그 실행의 관측치·읽은 순간을 받는 시장(한국). */
    boolean needsObservation() {
        return runPackets != null;
    }

    // ------------------------------------------------------------------ 호출
    /**
     * Claude 호출 한 번의 결과. {@code status}가 null이면 성공(스키마를 지킨 응답 {@code parsed}), 아니면 실패 상태와 문구.
     * {@code frame}은 시스템 프롬프트로 쓴 프레임 판(결정 기록의 framework_version·응답의 framework).
     */
    record Attempt(Packet packet, FrameworkService.Frame frame, AiService.StructuredResult result, String status,
                   String error, JsonNode parsed, List<String> violations, String model, String effort) {

        boolean succeeded() {
            return status == null;
        }

        LocalDate selectionAsOf() {
            return Json.parseDate(Json.asText(Json.child(packet.body(), "1_basis"), "selectionAsOf"));
        }
    }

    /**
     * 지금 프레임 판을 읽고(없으면 임시 v0 시드), 패킷을 만들고, 호출 한 번을 잡고(일일 상한 — 잡지 못하면 null), 부르고, 사용량을
     * 남기고, 형식을 검사합니다. 패킷을 먼저 만드는 것은 패킷이 실패하면(자료 오류) 호출 한 번을 쓰지 않으려는 것입니다. 상한의 문턱은
     * {@code scheduled}(정기 작업 — 상한까지, 아니면 수동 호출 — 상한 − 정기 작업 몫 예약, {@link ClaudeSettings#callLimit})가 정합니다.
     *
     * <p>시스템 프롬프트는 그 판의 본문을 <b>이 결정이 읽은 설정 행</b>({@code row} — 결정 기록의 settings_version)으로 다시
     * 렌더링합니다. 판 행의 {@code rendered}(판을 만들 때의 설정)를 쓰면 그 뒤 바뀐 하드 규칙 수치가 프롬프트에 남아 검증기와
     * 어긋나고, 기록의 framework_version·settings_version으로 같은 문자열을 다시 만들 수 없습니다(계약 보충 §2). 패킷도 같은 행으로
     * 만듭니다 — 패킷이 설정을 따로 읽으면 그사이 설정 탭에서 저장한 판이 끼어, 한 호출 안에서 프롬프트의 하드 규칙과 패킷 12_hardRules·
     * 1_basis.settingsVersion이 서로 다른 판을 말합니다(FW-5).
     */
    Attempt attempt(LocalDate asOf, String kind, boolean initial, SettingsRow row, ClaudeSettings claude,
                    LocalDate today, boolean scheduled) {
        return attempt(asOf, kind, initial, row, claude, today, scheduled, null);
    }

    /**
     * {@link #attempt(LocalDate, String, boolean, SettingsRow, ClaudeSettings, LocalDate, boolean)}에 그 실행의 재료를 더한 것 — 패킷이 그 실행의
     * 관측치·읽은 순간을 받는 문맥(한국 — {@link #needsObservation})이면 {@code observed}가 있어야 합니다(실행에 묶은 사본 — {@link #bind}).
     *
     * @throws IllegalStateException 그런 문맥인데 재료가 없거나 실행에 묶지 않은 파이프라인
     */
    Attempt attempt(LocalDate asOf, String kind, boolean initial, SettingsRow row, ClaudeSettings claude,
                    LocalDate today, boolean scheduled, Observed observed) {
        return attempt(asOf, kind, initial, row, claude, today, scheduled, observed, null);
    }

    /**
     * 호출 창 — 기한({@code deadline})과 최소 대기 한도({@code minSeconds}, 초). 한국 출발의 Claude 몫이 그 세션 출발 기한 안에 호출을 끝내려고
     * 씁니다(2단계 명세 §4-8 'E2b'·사용자 결정 w12). 남은 시간은 <b>요청을 보내기 직전</b>(프레임 판 읽기·패킷 조립·호출 한 번 잡기 뒤)에 재고 —
     * 그 앞에서 재면 패킷을 만드는 동안 흐른 시간만큼 기한에 더 가까이 보내게 됩니다(묶음 E 3차 리뷰) — 대기 한도 = min(설정 대기 한도, 남은 초)
     * (초 단위 내림), 남은 초가 최소 대기 한도보다 짧으면 잡은 호출을 돌려놓고 부르지 않습니다({@link WindowClosed}).
     */
    record CallWindow(Instant deadline, long minSeconds) {

        CallWindow {
            Objects.requireNonNull(deadline, "deadline");
        }

        /** 기한까지 남은 초(초 단위 내림 — 지났으면 음수). */
        long secondsLeft(Clock clock) {
            return Duration.between(clock.instant(), deadline).getSeconds();
        }
    }

    /** 호출 창({@link CallWindow})이 요청 직전에 닫혀 부르지 않음 — 잡은 호출은 돌려놓았고, {@code secondsLeft}는 그때 잰 남은 초. */
    static final class WindowClosed extends RuntimeException {

        private final long secondsLeft;

        WindowClosed(long secondsLeft, long minSeconds) {
            super("기한까지 " + secondsLeft + "초 — 최소 대기 한도 " + minSeconds + "초보다 짧아 부르지 않음");
            this.secondsLeft = secondsLeft;
        }

        long secondsLeft() {
            return secondsLeft;
        }
    }

    /**
     * {@link #attempt(LocalDate, String, boolean, SettingsRow, ClaudeSettings, LocalDate, boolean, Observed)}에 호출 창({@link CallWindow})을 더한
     * 것 — null이면 설정 대기 한도.
     *
     * @throws WindowClosed 요청 직전에 기한까지 최소 대기 한도가 남지 않음(부르지 않았고 잡은 호출은 돌려놓음)
     */
    Attempt attempt(LocalDate asOf, String kind, boolean initial, SettingsRow row, ClaudeSettings claude,
                    LocalDate today, boolean scheduled, Observed observed, CallWindow window) {
        FrameworkService.Frame frame = framework.current();
        Packet packet = packet(asOf, kind, initial, frame.version(), row, observed);
        return send(frame, packet, row, claude, today, scheduled, window);
    }

    /**
     * 앞 호출과 <b>같은 패킷·같은 프레임 판</b>으로 한 번 더 — 한국 출발의 API 오류 재시도(같은 계획 안, 2단계 명세 §4-8 'E2b')가 첫 호출이 보낸
     * 글자를 그대로 다시 보냅니다. 패킷을 다시 만들면 첫 호출(최대 대기 한도) 동안 다시 쓰인 단일 판 저장본(매크로 카드는 5분마다)이 '읽은 순간 뒤
     * 수집본'이 되어 빠져, 읽은 순간에 있던 자료가 재시도 패킷에서 사라집니다(묶음 E 리뷰). 호출 상한·호출 창·사용량·분류는
     * {@link #attempt(LocalDate, String, boolean, SettingsRow, ClaudeSettings, LocalDate, boolean, Observed, CallWindow)}와 같습니다.
     *
     * @throws WindowClosed 요청 직전에 기한까지 최소 대기 한도가 남지 않음
     */
    Attempt again(Attempt previous, SettingsRow row, ClaudeSettings claude, LocalDate today, boolean scheduled,
                  CallWindow window) {
        return send(previous.frame(), previous.packet(), row, claude, today, scheduled, window);
    }

    /** 만든 패킷으로 호출 한 번 — 시스템 프롬프트(그 판·그 설정 행), 호출 한 번 잡기, (호출 창이면 남은 시간 재기), 부르기, 사용량, 형식 검사. */
    private Attempt send(FrameworkService.Frame frame, Packet packet, SettingsRow row, ClaudeSettings claude,
                         LocalDate today, boolean scheduled, CallWindow window) {
        String system = FrameworkService.render(profile, frame.body(), frame.version(), row.body());
        // 정기 작업은 상한까지, 수동 호출은 정기 작업 몫을 남긴 문턱까지(2단계 명세 §4-10 — 같은 SQL의 문턱만 다름).
        if (calls.reserve(today, claude.callLimit(scheduled)).isEmpty()) {
            return null;
        }
        int timeout = timeoutSeconds;
        if (window != null) {
            // 요청 직전(호출 한 번을 잡은 뒤)에 잼 — 그 앞의 조립 시간만큼 기한에 다가간 것을 빼지 않으려고(CallWindow).
            long left = window.secondsLeft(clock);
            if (left < window.minSeconds()) {
                calls.release(today);
                throw new WindowClosed(left, window.minSeconds());
            }
            timeout = (int) Math.max(1, Math.min(timeoutSeconds, left));
        }
        AiService.StructuredResult result;
        try {
            result = ai.structured(claude.model(), system, packet.text(), schema.forApi(), claude.effort(), timeout);
        } catch (RuntimeException e) {
            // 요청을 보내기 전에 멈춘 경우(인자 검사 — 코드 오류)라 잡은 호출을 돌려놓고 그대로 던집니다.
            calls.release(today);
            throw e;
        }
        // 키가 없어 보내지 않았으면 잡은 호출을 돌려놓고, 아니면 토큰·추정 비용을 더합니다(기록 실패는 로그만 — 받은 응답을 버리지 않음).
        calls.record(today, claude.model(), result);
        return classify(packet, frame, result, claude);
    }

    /** 그 문맥의 패킷 — 미국은 설정 행으로, 한국은 그 실행·관측치·읽은 순간으로({@link MarketContext}). */
    private Packet packet(LocalDate asOf, String kind, boolean initial, Integer frameworkVersion, SettingsRow row,
                          Observed observed) {
        if (runPackets == null) {
            return packets.build(asOf, kind, initial, frameworkVersion, row);
        }
        if (observed == null) {
            throw new IllegalStateException(market.code() + " Claude 결정은 그 실행의 관측치·읽은 순간이 필요합니다(결정 작업이 넘김)");
        }
        if (!(market instanceof MarketRun run)) {
            throw new IllegalStateException(market.code() + " Claude 결정 파이프라인이 실행에 묶이지 않았습니다");
        }
        return runPackets.build(run, asOf, kind, initial, frameworkVersion, observed.quotes(), observed.readAt());
    }

    /** 결과 → 상태(클래스 설명의 실패 분류). 성공이면 JSON으로 읽고 스키마 전체로 검사합니다. */
    private Attempt classify(Packet packet, FrameworkService.Frame frame, AiService.StructuredResult result,
                             ClaudeSettings claude) {
        if (!result.ok()) {
            String kind = result.errorKind() == null ? "UNKNOWN" : result.errorKind();
            String status = switch (kind) {
                case "REFUSAL" -> STATUS_REFUSED;
                case "MAX_TOKENS", "EMPTY" -> STATUS_FORMAT_ERROR;
                default -> STATUS_API_ERROR;
            };
            return new Attempt(packet, frame, result, status, clip("[" + kind + "] " + result.error(), ERROR_CHARS),
                    null, List.of(), claude.model(), claude.effort());
        }
        JsonNode parsed;
        try {
            parsed = mapper.readTree(result.text());
        } catch (RuntimeException e) {
            return new Attempt(packet, frame, result, STATUS_FORMAT_ERROR, "응답 형식 오류 — JSON으로 읽지 못했습니다",
                    null, List.of("$: JSON으로 읽지 못했습니다"), claude.model(), claude.effort());
        }
        List<String> violations = schema.validate(parsed);
        if (!violations.isEmpty()) {
            String shown = String.join("; ", violations.subList(0, Math.min(VIOLATIONS_IN_ERROR, violations.size())));
            String error = clip("응답 형식 오류 — 스키마 위반 " + violations.size() + "건: " + shown
                    + (violations.size() > VIOLATIONS_IN_ERROR ? " …" : ""), ERROR_CHARS);
            return new Attempt(packet, frame, result, STATUS_FORMAT_ERROR, error, parsed,
                    violations, claude.model(), claude.effort());
        }
        return new Attempt(packet, frame, result, null, null, parsed, List.of(), claude.model(), claude.effort());
    }

    // ------------------------------------------------------------------ 검증
    /** 주문 한 줄의 판정과 장부에 낼 값. */
    record Planned(Verdict verdict, JsonNode raw, Double orderWeightPct, Double sellFraction, ObjectNode reason) {
    }

    record Plan(List<Verdict> verdicts, List<Planned> planned, Double target, double expected,
                        boolean mismatch, int accepted, String status, ObjectNode response) {
    }

    /** 검증이 보는 장부 — 마지막 관측 가격의 평가(가격을 못 받은 보유는 평단, 장부 평가와 같음). */
    record LedgerView(double cash, double nav, double exposurePct, List<Position> positions,
                              Map<String, Double> price) {
    }

    LedgerView ledgerView(boolean initial) {
        BookState state = store.state(book()).orElseThrow(() -> new IllegalStateException(
                "Claude 계좌 상태(paper_book_state)가 없습니다 — 초기화를 다시 실행하세요"));
        if (initial) {
            return cashOnly(state.cash());
        }
        Map<String, Integer> qty = new HashMap<>();
        Map<String, Double> price = new HashMap<>();
        List<Position> positions = store.positions(book());
        for (Position p : positions) {
            qty.put(p.ticker(), p.qty());
            price.put(p.ticker(), p.lastPrice() != null ? p.lastPrice() : p.avgCost());
        }
        PaperLedger.Valuation valuation = PaperLedger.value(state.cash(), qty, price);
        return new LedgerView(state.cash(), valuation.nav(), valuation.exposurePct(), positions, price);
    }

    static LedgerView cashOnly(double cash) {
        return new LedgerView(cash, cash, 0, List.of(), Map.of());
    }

    /**
     * 검증기 문맥·판정·노출 비교·결정 응답. 초기 결정이면 보유 없이(출발 현금), 유니버스는 패킷이 보인 것({@link ClaudeBookService#initialUniverse}),
     * 가격은 출발일 종가({@code closes})로 봅니다. 정기 결정은 관측치 저장본으로 유니버스·가격 없음·신선도를 봅니다.
     *
     * <p>한국 실행(시장 묶음이 {@link KrPaperMarket#INSTANCE})이면 시장별 칸을 {@link KrClaudeValidation#checks}로 만듭니다 — 유니버스·ETF·재진입
     * 금지·지금 체결할 수 없는 종목은 그 결정이 보낸 패킷의 {@code 12_hardRules}(+ 지금 장부), 정수 주는 {@code quotes}(그 결정의 관측치)의 기준
     * 거래일 종가, 이달 재량 주문 수는 출발 결정 주문을 빼고 셉니다. 그때 {@code universe}·{@code closes}는 쓰지 않습니다(미국 칸의 인자).
     */
    Plan plan(LocalDate asOf, String kind, boolean initial, Attempt attempt, LedgerView view, SettingsRow row,
                      ClaudeSettings claude, Optional<Quotes> quotes, Set<String> universe,
                      Map<String, PaperMarketData.SourcedClose> closes) {
        JsonNode body = row.body();
        // 그 시장의 설정 읽기(접두어·현금성 기본값 — C1a): 현금성(비중 상한·종목 수에서 빠짐)과 검증기 한도가 그 시장 키.
        PaperSettings paper = PaperSettings.from(body, market);
        PacketBuilder.Limits packetLimits = PacketBuilder.Limits.from(body, market);
        OrderValidator.Limits limits = new OrderValidator.Limits(packetLimits.maxWeightStockPct(),
                packetLimits.maxWeightEtfPct(), packetLimits.maxPositions(), packetLimits.minOrderNotional(),
                packetLimits.maxDiscretionaryOrdersPerMonth(), packetLimits.minHoldTradingDaysForSell());

        List<JsonNode> rawOrders = Json.array(attempt.parsed(), "orders");
        List<Proposed> proposed = new ArrayList<>();
        for (JsonNode o : rawOrders) {
            proposed.add(new Proposed(Json.asText(o, "ticker"), Json.asText(o, "side"), Json.asDouble(o, "targetWeightPct"),
                    Json.asDouble(o, "sellFraction"), Json.asText(o, "timing")));
        }

        if (!(view.nav() > 0)) {
            throw new IllegalStateException("Claude 계좌 순자산이 0 이하라 주문을 검증할 수 없습니다: " + view.nav());
        }
        Map<String, Double> weights = new TreeMap<>();
        Map<String, Integer> heldDays = new TreeMap<>();
        Map<String, Integer> heldQty = new TreeMap<>();
        for (Position p : view.positions()) {
            double price = view.price().getOrDefault(p.ticker(), p.avgCost());
            weights.put(p.ticker(), p.qty() * price / view.nav() * 100.0);
            heldQty.put(p.ticker(), p.qty());
            if (p.openedOn() != null) {
                try {
                    heldDays.put(p.ticker(), market.calendar().tradingDaysBetween(p.openedOn(), asOf));
                } catch (CalendarUnavailableException e) {
                    // 보유를 연 해의 공휴일 목록이 없음 — 보유 거래일만 모름으로 둡니다(명세 K35). 검증기가 그 종목 재량 매도를
                    // '보유 거래일을 알 수 없음'(MIN_HOLD)으로 거절하고 결정은 이어 갑니다.
                }
            }
        }
        // 시장별 칸 — 한국 실행이면 패킷 12_hardRules·관측치·장부로(KrClaudeValidation, E2a), 그 밖은 미국 칸(이 묶음 전 그대로).
        MarketChecks checks = market.definition() == KrPaperMarket.INSTANCE
                ? KrClaudeValidation.checks(market, store, asOf, initial, attempt.packet().body(), paper, quotes,
                        lockedOut(asOf), clock.instant())
                : usChecks(asOf, initial, body, quotes, universe, closes, proposed, heldQty.keySet());
        boolean stale = checks.stale();
        int monthly = checks.monthly();
        OrderValidator.Context ctx = new OrderValidator.Context(view.nav(), view.cash(), weights, heldDays,
                checks.universe(), checks.etfs(), Set.copyOf(paper.cashLikeTickers()), checks.lockedOut(),
                checks.noPrice(), monthly, stale, heldQty, checks.unfillable(), checks.wholeShares());
        // 검증기의 시장 몫(받는 시점·이름·금액 표기)에 계좌의 시점 순위(계좌2 명세 §10-5) — 기본 계좌는 이른 시점 0·나머지 1이라 시장 묶음 값 그대로.
        List<Verdict> verdicts = OrderValidator.validate(proposed, ctx, limits,
                market.orderValidation().withRanks(profile.timingRanks()));

        // 주문을 반영한 예상 노출(클래스 설명) — 통과한 매도·매수만.
        Map<String, Double> sold = new HashMap<>();
        double bought = 0;
        List<Planned> planned = new ArrayList<>();
        int accepted = 0;
        for (int i = 0; i < verdicts.size(); i++) {
            Verdict v = verdicts.get(i);
            JsonNode raw = rawOrders.get(i);
            Double orderWeight = null;
            Double fraction = null;
            if (v.accepted()) {
                accepted++;
                if (OrderValidator.BUY.equals(v.order().side())) {
                    orderWeight = OrderValidator.buyIncrementPct(v.order(), ctx);
                    bought += orderWeight;
                } else {
                    // 비율이 없으면 전량(장부 규칙) — 목표 0%("0%까지")도 같은 뜻이라 검증기가 통과시킨 것입니다.
                    fraction = v.order().sellFraction() == null ? null : Math.min(1.0, v.order().sellFraction());
                    sold.put(v.order().ticker(), fraction == null ? 1.0 : fraction);
                }
            }
            planned.add(new Planned(v, raw, orderWeight, fraction, reason(raw, v, weights, orderWeight)));
        }
        double expected = bought;
        for (Map.Entry<String, Double> held : weights.entrySet()) {
            expected += held.getValue() * (1.0 - sold.getOrDefault(held.getKey(), 0.0));
        }
        Double target = Json.asDouble(attempt.parsed(), "targetEquityExposurePct");
        boolean mismatch = target != null && Math.abs(target - expected) > MISMATCH_PCT;
        String status = accepted > 0 ? STATUS_OK : STATUS_NO_TRADE;

        // 스키마 검사를 지난 응답이라 뿌리는 객체입니다(decision.schema.json의 type: object).
        ObjectNode response = (ObjectNode) attempt.parsed().deepCopy();
        List<Map<String, Object>> validation = new ArrayList<>();
        for (Planned p : planned) {
            validation.add(verdictView(p, weights));
        }
        response.set("validation", mapper.valueToTree(validation));
        response.put("exposureMismatch", mismatch);
        response.put("expectedExposurePct", PaperQueryService.round2(expected));
        response.put("currentExposurePct", PaperQueryService.round2(view.exposurePct()));
        response.put("inputsStale", stale);
        response.put("monthlyDiscretionaryOrders", monthly);
        response.put("book", book());
        response.put("kind", kind);
        response.put("asOfTradingDate", asOf.toString());
        response.set("framework", mapper.valueToTree(FrameworkService.decisionView(attempt.frame())));
        response.set("settings", mapper.valueToTree(settingsView(claude, limits, paper)));
        putMeasure(response, attempt);
        return new Plan(verdicts, planned, target, expected, mismatch, accepted, status, response);
    }

    /**
     * 검증기 문맥의 시장별 칸 — 살 수 있는 종목·ETF·재진입 금지·가격 없음·이달 재량 주문 수·신선도와 한국만의 칸(지금 체결할 수 없는 종목·
     * 정수 주 재료 — 미국은 null). 장부 쪽 칸(순자산·현금·비중·보유 거래일·수량)·현금성·한도는 시장과 상관없이 {@link #plan}이 채웁니다.
     */
    record MarketChecks(Set<String> universe, Set<String> etfs, Set<String> lockedOut, Set<String> noPrice,
                        int monthly, boolean stale, Map<String, String> unfillable,
                        OrderValidator.WholeShares wholeShares) {
    }

    /**
     * 미국 칸 — 초기 결정은 패킷이 보인 유니버스·얼린 출발일 종가({@code closes} — 없으면 가격 없음)·신선도 판정 없음(얼린 확정 종가로
     * 체결), 정기 결정은 관측치 저장본의 종목·이어 쓴 봉과 봉 없는 보유(가격 없음)·24시간 신선도. ETF는 규칙 책 설정의 목록, 이달 재량 주문
     * 수는 {@link PacketBuilder#monthlyDiscretionaryOrders}.
     */
    private MarketChecks usChecks(LocalDate asOf, boolean initial, JsonNode body, Optional<Quotes> quotes,
                                  Set<String> universe, Map<String, PaperMarketData.SourcedClose> closes,
                                  List<Proposed> proposed, Set<String> heldTickers) {
        Set<String> noPrice = new TreeSet<>();
        boolean stale;
        if (initial) {
            for (Proposed p : proposed) {
                if (p.ticker() != null && !closes.containsKey(p.ticker())) {
                    noPrice.add(p.ticker());
                }
            }
            stale = false;   // 초기 결정은 얼린 출발일 확정 종가로 체결합니다
        } else {
            noPrice.addAll(noPriceTickers(quotes, heldTickers));
            stale = inputsStale(quotes, clock.instant());
        }
        int monthly = initial ? 0 : PacketBuilder.monthlyDiscretionaryOrders(
                store.recentOrders(book(), PacketBuilder.MONTHLY_SCAN), asOf);
        return new MarketChecks(universe, RuleSettings.from(body).etfs(), lockedOut(asOf), noPrice, monthly, stale,
                null, null);
    }

    /**
     * 결정 기록의 측정 태그(2단계 명세 §6, {@link DecisionMeasure}) — 그 결정의 패킷에 일정(1b)·사건·서프라이즈가 있었는지. 패킷을
     * 보낸 결정이면 정기·수동·초기·미리보기·실패 모두 같은 자리({@code response.measure})에 남깁니다. 패킷을 만들지 않은 결정(일시정지·
     * 호출 상한 — {@link #recordSkipped})에는 없습니다 — "패킷이 없었다"와 "섹션이 비었다"가 섞이지 않게.
     */
    private void putMeasure(ObjectNode response, Attempt attempt) {
        DecisionMeasure measure = attempt.packet().measure();
        if (measure != null) {
            response.set(DecisionMeasure.KEY, mapper.valueToTree(measure.toMap()));
        }
    }

    private void putMeasure(Map<String, Object> response, Attempt attempt) {
        DecisionMeasure measure = attempt.packet().measure();
        if (measure != null) {
            response.put(DecisionMeasure.KEY, measure.toMap());
        }
    }

    /**
     * 주문 근거 — 모델이 쓴 {@code thesis·labels·invalidation} 그대로와 제안 값({@code proposed}), 검증할 때의 현재 비중, 장부에 낸
     * 비중(매수 증가분), 검증 문구.
     */
    private ObjectNode reason(JsonNode raw, Verdict v, Map<String, Double> weights, Double orderWeight) {
        ObjectNode reason = mapper.createObjectNode();
        reason.put("thesis", Json.asText(raw, "thesis"));
        JsonNode labels = Json.child(raw, "labels");
        reason.set("labels", labels == null ? mapper.createArrayNode() : labels.deepCopy());
        reason.put("invalidation", Json.asText(raw, "invalidation"));
        ObjectNode proposedNode = mapper.createObjectNode();
        for (String field : List.of("targetWeightPct", "sellFraction")) {
            JsonNode value = Json.child(raw, field);
            if (value == null) {
                proposedNode.putNull(field);
            } else {
                proposedNode.set(field, value.deepCopy());
            }
        }
        proposedNode.put("timing", Json.asText(raw, "timing"));
        reason.set("proposed", proposedNode);
        // 매수의 목표 비중(체결 뒤 그 종목 비중)을 규칙 책과 같은 키에도 — 주문 행의 targetWeightPct는 통과하면 살 금액(목표 − 현재)이라
        // 화면이 둘이 다를 때 "(목표 …%)"를 함께 적습니다(orderSizeText).
        if (v.order() != null && OrderValidator.BUY.equals(v.order().side()) && v.order().targetWeightPct() != null
                && Double.isFinite(v.order().targetWeightPct())) {
            reason.put("targetWeightPct", PaperQueryService.round4(v.order().targetWeightPct()));
        }
        String ticker = v.order() == null ? null : v.order().ticker();
        Double current = ticker == null ? null : weights.get(ticker);
        reason.put("currentWeightPct", PaperQueryService.round4(current));
        reason.put("orderWeightPct", PaperQueryService.round4(orderWeight));
        reason.put("validation", v.detail());
        reason.put("source", "claude");
        return reason;
    }

    private static Map<String, Object> verdictView(Planned p, Map<String, Double> weights) {
        Verdict v = p.verdict();
        Map<String, Object> row = new LinkedHashMap<>();
        Proposed o = v.order();
        row.put("ticker", o == null ? null : o.ticker());
        row.put("side", o == null ? null : o.side());
        row.put("targetWeightPct", o == null ? null : o.targetWeightPct());
        row.put("sellFraction", o == null ? null : o.sellFraction());
        row.put("timing", o == null ? null : o.timing());
        row.put("accepted", v.accepted());
        row.put("rejectReason", v.rejectReason());
        row.put("detail", v.detail());
        row.put("currentWeightPct", o == null ? null : PaperQueryService.round4(weights.get(o.ticker())));
        row.put("orderWeightPct", PaperQueryService.round4(p.orderWeightPct()));
        return row;
    }

    /**
     * 판정을 주문 행으로 남깁니다({@link #orderRows}). 통과한 주문은 {@code accepted}가 PENDING이면 대기(기준 거래일 + 3거래일까지), CANCELLED면 취소
     * ({@value #PAUSED_DURING_CALL} — 호출 중 일시정지, 집행하지 않음), null이면(초기 결정 — 사후 체결 함수가 FILLED 행을 따로 만듦)
     * 남기지 않습니다. 거절한 주문은 늘 REJECTED와 사유로 남깁니다(무엇을 왜 거절했나).
     */
    void insertOrders(long decisionId, LocalDate asOf, Plan plan, String accepted) {
        for (Order order : orderRows(decisionId, asOf, plan, accepted)) {
            store.insertOrder(order);
        }
    }

    /** {@link #insertOrders}가 남길 주문 행(번호 없음) — 같은 규칙으로 만들기만 하고 쓰지 않습니다. */
    List<Order> orderRows(long decisionId, LocalDate asOf, Plan plan, String accepted) {
        boolean pending = PaperBooks.ORDER_PENDING.equals(accepted);
        LocalDate expires = market.calendar().addTradingDays(asOf, RuleBookService.ORDER_EXPIRY_TRADING_DAYS);
        List<Order> out = new ArrayList<>();
        for (Planned p : plan.planned()) {
            Verdict v = p.verdict();
            Proposed o = v.order();
            boolean buy = OrderValidator.BUY.equals(o.side());
            if (v.accepted()) {
                if (accepted == null) {
                    continue;
                }
                out.add(new Order(0, book(), decisionId, o.ticker(), o.side(), null,
                        buy ? p.orderWeightPct() : null, buy ? null : p.sellFraction(), o.timing(),
                        PacketBuilder.SOURCE_CLAUDE, accepted, pending ? null : PAUSED_DURING_CALL, p.reason(), asOf,
                        null, pending ? expires : null, null));
            } else {
                out.add(new Order(0, book(), decisionId, o.ticker(), o.side(), null,
                        buy ? o.targetWeightPct() : null, buy ? null : o.sellFraction(), o.timing(),
                        PacketBuilder.SOURCE_CLAUDE, "REJECTED", v.rejectReason(), p.reason(), asOf, null, null, null));
            }
        }
        return out;
    }

    /** 앞선 결정이 남긴 대기 주문을 "다음 결정이 대신함"으로 취소합니다(클래스 설명). 취소한 주문 번호. */
    List<Long> supersedePending() {
        List<Long> out = new ArrayList<>();
        for (Order order : store.ordersByStatus(book(), PaperBooks.ORDER_PENDING)) {
            if (PacketBuilder.SOURCE_CLAUDE.equals(order.source())) {
                store.markOrderStatus(order.id(), PaperBooks.ORDER_CANCELLED, "다음 결정이 대신함");
                out.add(order.id());
            }
        }
        return out;
    }

    /** 정기 결정에서 살 수 있는 종목 — 관측치 저장본의 종목(패킷의 유니버스와 같은 규칙). */
    static Set<String> observedUniverse(Optional<Quotes> quotes) {
        Set<String> out = new TreeSet<>();
        quotes.ifPresent(q -> out.addAll(q.bars().keySet()));
        return out;
    }

    /** 다음 세션(주문이 체결될 날)에도 재진입 금지인 종목 — 장부가 체결 때 보는 날과 같습니다. */
    private Set<String> lockedOut(LocalDate asOf) {
        LocalDate fillDay = market.calendar().nextTradingDay(asOf);
        Set<String> out = new TreeSet<>();
        for (Lockout lockout : store.lockouts(book())) {
            if (TrailingStop.lockedOut(lockout.untilTradingDate(), fillDay)) {
                out.add(lockout.ticker());
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ 기록
    Decision decisionRow(long id, LocalDate asOf, String kind, String status, SettingsRow row,
                                 ClaudeSettings claude, Attempt attempt, Double target, JsonNode response, String error,
                                 boolean pricesFinal) {
        return decisionRow(id, asOf, kind, status, row, claude, attempt, target, response, error, pricesFinal, 0);
    }

    Decision decisionRow(long id, LocalDate asOf, String kind, String status, SettingsRow row,
                                 ClaudeSettings claude, Attempt attempt, Double target, JsonNode response, String error,
                                 boolean pricesFinal, int retryCount) {
        return new Decision(id, book(), asOf, kind, null, status, claude.model(),
                attempt.frame().version(), row.version(), attempt.selectionAsOf(), target, attempt.packet().body(),
                attempt.packet().sha256(), attempt.result().text(), response, mapper.valueToTree(usageView(attempt)), error,
                attempt.packet().noteIds(), pricesFinal, attempt.result().latencyMs(), retryCount,
                attempt.packet().text());
    }

    /** 호출이 실패한 결정 — 패킷·원문·사용량·사유는 남기고 주문은 없습니다(C3·C7). 재시도였으면 같은 행을 바꿉니다. */
    Decision recordFailure(LocalDate asOf, String kind, SettingsRow row, ClaudeSettings claude,
                                   boolean pricesFinal, Attempt attempt, Decision retrying) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("summary", statusLabel(attempt.status()) + " — 그날 재량 주문 없음(리스크 규칙은 계속)"
                + (STATUS_API_ERROR.equals(attempt.status()) && retrying == null ? ". 같은 거래일에 한 번 다시 부릅니다" : ""));
        response.put("book", book());
        response.put("kind", kind);
        response.put("asOfTradingDate", asOf.toString());
        Map<String, Object> failure = new LinkedHashMap<>();
        failure.put("status", attempt.status());
        failure.put("errorKind", attempt.result().errorKind());
        failure.put("message", attempt.error());
        failure.put("stopReason", attempt.result().stopReason());
        failure.put("charged", attempt.result().charged());
        failure.put("violations", attempt.violations());
        failure.put("retry", retrying != null);
        response.put("failure", failure);
        response.put("framework", FrameworkService.decisionView(attempt.frame()));
        response.put("settings", claudeView(claude));
        putMeasure(response, attempt);
        Decision d = decisionRow(retrying == null ? 0 : retrying.id(), asOf, kind, attempt.status(), row, claude, attempt,
                null, mapper.valueToTree(response), attempt.error(), pricesFinal);
        Decision saved = store.atomically(() -> {
            if (retrying != null) {
                store.updateDecisionRetry(d);
                return store.decision(retrying.id()).orElseThrow();
            }
            Optional<Long> id = store.insertDecisionIfAbsent(d);
            return id.flatMap(store::decision)
                    .orElseGet(() -> store.decisionFor(book(), asOf, kind).orElseThrow());
        });
        log.warn("Claude 책 결정 {} {}{}: {} — {}", asOf, kind, retrying == null ? "" : "(재시도)", attempt.status(),
                attempt.error());
        return saved;
    }

    /**
     * 받은(과금된) 응답을 검증·저장하다 예외가 난 결정 — 원문·사용량·오류를 <b>따로 한 트랜잭션</b>으로 남기고 다시 부르지 않는 행
     * ({@code API_ERROR}·{@code retry_count = 1}, {@link ClaudeBookService#retryable} 거짓)으로 둡니다. 행이 없으면 결정 작업이 다음 주기에 Claude를
     * 또 불러(유료) 같은 날 호출이 명세 C7의 "재시도 한 번"을 넘고, 예외가 되풀이되면 하루 호출 상한까지 갑니다. 상태는 V8 CHECK 안의
     * 가장 가까운 것(호출 쪽 오류)이고 {@code response.failure.stage = AFTER_RESPONSE}로 구분합니다. 이 기록까지 실패하면(DB 장애)
     * 로그만 남기고, 호출한 쪽은 원래 예외를 받습니다.
     */
    void recordAfterResponse(LocalDate asOf, String kind, SettingsRow row, ClaudeSettings claude,
                                     boolean pricesFinal, Attempt attempt, Decision retrying, RuntimeException cause) {
        String message = clip("응답을 받은 뒤 검증·저장 중 오류(과금된 응답 — 다시 부르지 않음): " + cause, ERROR_CHARS);
        try {
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("summary", "응답을 받은 뒤 검증·저장 중 오류 — 그날 재량 주문 없음(리스크 규칙은 계속). 과금된 응답이라 같은 "
                    + "거래일에 다시 부르지 않습니다");
            response.put("book", book());
            response.put("kind", kind);
            response.put("asOfTradingDate", asOf.toString());
            Map<String, Object> failure = new LinkedHashMap<>();
            failure.put("status", STATUS_API_ERROR);
            failure.put("stage", "AFTER_RESPONSE");
            failure.put("errorKind", null);
            failure.put("message", message);
            failure.put("stopReason", attempt.result().stopReason());
            failure.put("charged", attempt.result().charged());
            failure.put("violations", List.of());
            failure.put("retry", retrying != null);
            response.put("failure", failure);
            response.put("framework", FrameworkService.decisionView(attempt.frame()));
            response.put("settings", claudeView(claude));
            putMeasure(response, attempt);
            Decision d = decisionRow(retrying == null ? 0 : retrying.id(), asOf, kind, STATUS_API_ERROR, row, claude,
                    attempt, null, mapper.valueToTree(response), message, pricesFinal, 1);
            store.atomically(() -> {
                if (retrying != null) {
                    store.updateDecisionRetry(d);   // 재시도 수가 1이 됩니다(그사이 바뀐 행이면 아무것도 안 함)
                } else {
                    store.insertDecisionIfAbsent(d);   // 그사이 생긴 행이 있으면 그 행이 그날 결정입니다
                }
                return null;
            });
            log.warn("Claude 책 결정 {} {}{}: 응답을 받은 뒤 오류 — 다시 부르지 않는 API_ERROR로 남김: {}", asOf, kind,
                    retrying == null ? "" : "(재시도)", cause.toString());
        } catch (RuntimeException e) {
            cause.addSuppressed(e);
            log.error("Claude 책 결정 {} {}: 응답을 받은 뒤의 오류({})를 기록하지도 못했습니다 — 다음 결정 작업이 Claude를 다시 부를 "
                    + "수 있습니다: {}", asOf, kind, cause.toString(), e.toString());
        }
    }

    /** Claude를 부르지 않은 결정(일시정지·호출 상한) — 패킷·모델 없이 사유만. */
    Decision recordSkipped(LocalDate asOf, String kind, SettingsRow row, ClaudeSettings claude,
                                   boolean pricesFinal, String reason) {
        return recordSkipped(asOf, kind, row, claude, pricesFinal, reason, Map.of());
    }

    /** {@link #recordSkipped(LocalDate, String, SettingsRow, ClaudeSettings, boolean, String)}에 응답 칸({@code extra}, 사유 뒤·설정 앞)을 더한 것. */
    private Decision recordSkipped(LocalDate asOf, String kind, SettingsRow row, ClaudeSettings claude,
                                   boolean pricesFinal, String reason, Map<String, Object> extra) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("summary", reason);
        response.put("book", book());
        response.put("kind", kind);
        response.put("asOfTradingDate", asOf.toString());
        response.put("skipped", reason);
        response.putAll(extra);
        response.put("settings", claudeView(claude));
        return store.atomically(() -> {
            Optional<Long> id = store.insertDecisionIfAbsent(new Decision(0, book(), asOf, kind, null,
                    STATUS_SKIPPED, null, null, row.version(), null, null, null, null, null, mapper.valueToTree(response),
                    null, null, null, pricesFinal, null, 0));
            return id.flatMap(store::decision)
                    .orElseGet(() -> store.decisionFor(book(), asOf, kind).orElseThrow());
        });
    }

    /**
     * 호출 상한으로 부르지 못함. 새 결정이면 SKIPPED로 남기고, 재시도 차례였으면 그 행의 재시도를 쓴 것으로 남깁니다(상태는 API
     * 오류 그대로, 사유를 덧붙임) — 남겨 두면 결정 작업이 10분마다 다시 와서 같은 이유로 건너뜁니다.
     */
    Decision capSkipped(LocalDate asOf, String kind, SettingsRow row, ClaudeSettings claude, boolean pricesFinal,
                                Decision retrying, LocalDate today, boolean scheduled) {
        String message = capMessage(claude, today, scheduled);
        if (retrying == null) {
            log.info("Claude 책 결정 {} {}: {}", asOf, kind, message);
            return recordSkipped(asOf, kind, row, claude, pricesFinal, message + " — 그날 재량 주문 없음");
        }
        String error = clip((retrying.error() == null ? "" : retrying.error() + " · ") + "재시도 안 함: " + message,
                ERROR_CHARS);
        store.updateDecisionRetry(new Decision(retrying.id(), retrying.bookCode(), retrying.asOfTradingDate(),
                retrying.kind(), retrying.decidedAt(), retrying.status(), retrying.model(), retrying.frameworkVersion(),
                retrying.settingsVersion(), retrying.selectionAsOf(), retrying.targetExposurePct(), retrying.packet(),
                retrying.packetHash(), retrying.responseRaw(), retrying.response(), retrying.usage(), error,
                retrying.noteIds(), retrying.pricesFinal(), retrying.latencyMs(), retrying.retryCount(),
                retrying.packetText()));
        log.info("Claude 책 결정 {} {}: 재시도하지 않음 — {}", asOf, kind, message);
        return store.decision(retrying.id()).orElseThrow();
    }

    /**
     * 결정 기한이 지나 Claude를 부르지 않은 그 세션의 행(사용자 결정 v4, E2b — 기한 뒤 그 세션을 결정하지 않는 시장, 한국). 새 결정이면 호출 상한의
     * {@code SKIPPED} 행과 같은 모양(패킷·모델 없음)에 기한({@code pastDeadline}·{@code deadlineKst})·사유 구분({@code skippedReason} — 규칙 계좌 기한
     * 지남 행의 {@code noTradeReason}과 같은 판정: ⑤ 미달이면 '069500 D 봉 없음(휴장 또는 지연)', 아니면 '기한 지남')·그 판정
     * ({@code gates}·{@code waitedFor}·{@code gatesJudgedAtKst}·{@code gatesBasis})을 더해 남기고, 재시도 차례였으면 그 행의 재시도를 쓴 것으로 남깁니다
     * (호출 상한과 같음 — 상태는 API 오류 그대로, 사유를 덧붙임). 가격을 보지 않아 {@code prices_final}은 거짓입니다.
     *
     * @param judged 그 세션 Claude 계좌 몫의 기한 전 마지막 판정(없으면 기한 뒤 판정), 판정하지 못했으면 null
     */
    Decision deadlineSkipped(LocalDate asOf, String kind, SettingsRow row, ClaudeSettings claude, Decision retrying,
                             Instant deadline, KrDecisionGates.Judged judged) {
        List<KrDecisionGates.Gate> gates = judged == null ? null : judged.gates();
        boolean anchorMissing = KrDecisionGates.anchorMissing(gates);
        String reason = anchorMissing ? KrRuleBookService.ANCHOR_MISSING_REASON : KrRuleBookService.PAST_DEADLINE_REASON;
        String message = "결정 기한(" + Kst.stamp(deadline) + ")이 지나 Claude를 부르지 않았습니다"
                + (anchorMissing ? " — " + reason : "");
        if (retrying != null) {
            String error = clip((retrying.error() == null ? "" : retrying.error() + " · ") + "재시도 안 함: " + message,
                    ERROR_CHARS);
            store.updateDecisionRetry(new Decision(retrying.id(), retrying.bookCode(), retrying.asOfTradingDate(),
                    retrying.kind(), retrying.decidedAt(), retrying.status(), retrying.model(),
                    retrying.frameworkVersion(), retrying.settingsVersion(), retrying.selectionAsOf(),
                    retrying.targetExposurePct(), retrying.packet(), retrying.packetHash(), retrying.responseRaw(),
                    retrying.response(), retrying.usage(), error, retrying.noteIds(), retrying.pricesFinal(),
                    retrying.latencyMs(), retrying.retryCount(), retrying.packetText()));
            log.info("Claude 책 결정 {} {}: 재시도하지 않음 — {}", asOf, kind, message);
            return store.decision(retrying.id()).orElseThrow();
        }
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("skippedReason", reason);
        extra.put("pastDeadline", true);
        extra.put("deadlineKst", Kst.stamp(deadline));
        extra.put("gates", gates == null ? null : gates.stream().map(KrDecisionGates.Gate::view).toList());
        extra.put("waitedFor", gates == null ? null : KrDecisionGates.blocking(gates));
        extra.put("gatesJudgedAtKst", judged == null ? null : Kst.stamp(judged.at()));
        extra.put("gatesBasis", judged == null ? null : judged.basis());
        log.info("Claude 책 결정 {} {}: {}", asOf, kind, message);
        return recordSkipped(asOf, kind, row, claude, false, message + " — 그날 재량 주문 없음", extra);
    }

    /** 그날 이 호출에 남은 횟수 — 정기 작업은 상한까지, 수동 호출은 정기 작업 몫을 남긴 문턱까지({@link ClaudeSettings#callLimit}). */
    int callsLeft(LocalDate today, ClaudeSettings claude, boolean scheduled) {
        int used = store.apiUsage(today).map(PaperStore.ApiUsage::calls).orElse(0);
        return claude.callLimit(scheduled) - used;
    }

    static String statusLabel(String status) {
        return switch (status) {
            case STATUS_REFUSED -> "Claude가 거절함(refusal)";
            case STATUS_FORMAT_ERROR -> "응답 형식 오류";
            case STATUS_API_ERROR -> "API 오류";
            default -> status;
        };
    }

    /**
     * 호출 한 번의 작업 기록용 사용 — {@code status}(응답을 받았으면 {@code RESPONDED}, 아니면 실패 상태)·{@link #usageView}·{@code estCostUsd}(지금
     * 설정 단가 — {@link PaperApiCalls#estimateCostUsd}, 모르면 null). 결정 행 없이 끝난 한국 출발의 호출을 작업 기록에서 셀 수 있게 합니다(2단계 명세
     * §4-10, 묶음 E 리뷰).
     */
    Map<String, Object> callView(Attempt attempt) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", attempt.succeeded() ? "RESPONDED" : attempt.status());
        out.putAll(usageView(attempt));
        Double cost = null;
        try {
            cost = calls.estimateCostUsd(attempt.model(), attempt.result());
        } catch (RuntimeException e) {
            log.warn("출발 호출의 추정 비용을 셀 수 없습니다 — 비워 둡니다: {}", e.toString());
        }
        out.put("estCostUsd", cost);
        return out;
    }

    static Map<String, Object> usageView(Attempt attempt) {
        AiService.StructuredResult r = attempt.result();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("model", attempt.model());
        out.put("effort", attempt.effort());
        out.put("inputTokens", r.inputTokens());
        out.put("outputTokens", r.outputTokens());
        out.put("cacheReadTokens", r.cacheReadTokens());
        out.put("cacheWriteTokens", r.cacheWriteTokens());
        out.put("latencyMs", r.latencyMs());
        out.put("stopReason", r.stopReason());
        out.put("charged", r.charged());
        out.put("errorKind", r.errorKind());
        return out;
    }

    private static Map<String, Object> claudeView(ClaudeSettings claude) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("model", claude.model());
        out.put("effort", claude.effort());
        out.put("dailyCallCap", claude.dailyCallCap());
        out.put("fallbacks", claude.fallbacks());
        return out;
    }

    private static Map<String, Object> settingsView(ClaudeSettings claude, OrderValidator.Limits limits,
                                                    PaperSettings paper) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("model", claude.model());
        out.put("effort", claude.effort());
        out.put("dailyCallCap", claude.dailyCallCap());
        out.put("maxWeightStockPct", limits.maxWeightStockPct());
        out.put("maxWeightEtfPct", limits.maxWeightEtfPct());
        out.put("maxPositions", limits.maxPositions());
        out.put("minOrderNotional", limits.minOrderNotional());
        out.put("maxDiscretionaryOrdersPerMonth", limits.maxDiscretionaryOrdersPerMonth());
        out.put("minHoldTradingDaysForSell", limits.minHoldTradingDaysForSell());
        out.put("cashLikeTickers", paper.cashLikeTickers());
        out.put("mismatchPct", MISMATCH_PCT);
        out.put("fallbacks", claude.fallbacks());
        return out;
    }

    static List<Map<String, Object>> fillsView(List<Fill> fills) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Fill f : fills) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("orderId", f.orderId());
            row.put("ticker", f.ticker());
            row.put("side", f.side());
            row.put("qty", f.qty());
            row.put("price", PaperQueryService.round4(f.price()));
            row.put("rawPrice", PaperQueryService.round4(f.rawPrice()));
            row.put("gross", PaperQueryService.round2(f.gross()));
            row.put("priceSource", f.priceSource());
            out.add(row);
        }
        return out;
    }
}
