package com.macrodash.feature.paper;

import com.macrodash.analytics.OrderValidator;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.store.PaperStore;
import com.macrodash.store.PaperStore.IntradayPlan;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Set;

/**
 * 자유 시점 판의 장중 판단 계획 쓰기(ADR 0027 결정 3, 명세 docs/specs/2026-11-05-free-fill-timing.md §7) — 결정 응답의 {@code checkpoints[]}와 장중 판단
 * 응답의 {@code nextCheckpoint}를 그 세션의 계획 행({@code paper_intraday_plans} — 계좌·세션·순번)으로 옮깁니다. 끈 판의 장중 확인 계획
 * ({@code paper_checkpoints} — {@link ClaudeBookService}의 계획 쓰기)과 따로입니다.
 *
 * <p>규칙: 결정의 예약은 시각 순으로 순번 1·2가 되고, 그 세션에 남아 있던 PLANNED 행은 이번 예약으로 바뀌거나(같은 순번) 닫힙니다(예약이 줄었을 때 —
 * {@link #SUPERSEDED}). 끝난 행(DONE·EXPIRED·SKIPPED·SUPERSEDED)은 되살리지 않습니다. 장중 판단의 {@code nextCheckpoint}는 그 판단 다음 순번 하나를
 * 넣거나 바꿉니다(남은 예약을 대신함 — 없으면 남은 예약은 그대로). 그 뒤 순번의 PLANNED 행은 그대로 남으므로 {@code nextCheckpoint}는 그 시각보다
 * {@link IntradayRequest#MIN_GAP} 이상 앞이어야 합니다({@link #laterPlanned} — PLANNED 순번 순 = 시각 순과 두 판단의 간격, QA-309). 어느 길이든 한 세션의
 * 행은 {@link RuleBookService#INTRADAY_MAX}개를 넘지 않습니다(순번이 강제). 의미 검사는 {@link IntradayRequest}가 합니다 — 어긴 예약만 버리고 사유를
 * 응답 기록에 남깁니다.
 *
 * <p>계획 읽기({@link #plan}·{@link #next})는 장부 잠금 안에서, 쓰기({@link #write})는 결정 행을 쓰는 트랜잭션 안에서 부릅니다.
 */
final class IntradayPlanner {

    /** 뒤 결정이 같은 세션을 대신하면서 예약을 줄여 닫은 계획 행의 사유. */
    static final String SUPERSEDED = "뒤 결정이 대신함(장중 판단 예약이 줄거나 없음)";
    /** 세션당 횟수가 0인 설정에서 받은 예약의 사유. */
    static final String DISABLED = "CHECKPOINT_INVALID — 세션당 장중 판단 횟수가 0(설정)이라 예약을 받지 않음";

    private final PaperStore store;

    IntradayPlanner(PaperStore store) {
        this.store = store;
    }

    /**
     * 결정 하나(또는 장중 판단 하나)가 그 세션의 계획 행에 할 일.
     *
     * @param firstSlot 받은 예약이 차지할 첫 순번(결정은 1, 장중 판단의 {@code nextCheckpoint}는 그 판단의 다음 순번)
     * @param closing   받은 예약 뒤의 남은 PLANNED 순번을 닫는가(결정은 참 — 그 세션을 통째로 대신함, {@code nextCheckpoint}는 거짓)
     * @param existing  쓰기 전 그 세션의 행 전부(순번 순)
     */
    record Plan(String book, LocalDate session, String variant, int max, int firstSlot, boolean closing,
                IntradayRequest.Verdict verdict, List<IntradayPlan> existing) {

        Plan {
            existing = List.copyOf(existing);
        }

        private IntradayPlan existingAt(int slot) {
            return existing.stream().filter(p -> p.slot() == slot).findFirst().orElse(null);
        }

        /** 닫을 남은 PLANNED 행 수(결정이 예약을 줄였을 때). */
        int closed() {
            if (!closing) {
                return 0;
            }
            int from = firstSlot + verdict.accepted().size();
            return (int) existing.stream().filter(p -> p.slot() >= from && PaperBooks.CHECKPOINT_PLANNED.equals(p.status())).count();
        }

        /** 결정 응답의 {@code intradayPlan} — 세션·횟수·받은 예약(순번·시각·피드·감시 목록·상태)·버린 예약(사유)·닫은 행 수. */
        ObjectNode view(ObjectMapper mapper, String zoneField) {
            ObjectNode out = mapper.createObjectNode();
            out.put("session", session.toString());
            out.put("maxPerSession", max);
            ArrayNode planned = out.putArray("planned");
            int slot = firstSlot;
            for (IntradayRequest.Item item : verdict.accepted()) {
                IntradayPlan before = existingAt(slot);
                boolean finished = before != null && IntradayPlanner.finished(before);
                ObjectNode row = planned.addObject();
                row.put("slot", slot);
                row.put(zoneField, FreeTiming.label(item.at()));
                row.put("feed", item.feed());
                row.set("watch", mapper.valueToTree(item.watch()));
                // 이미 끝난 순번은 되살리지 않음 — 그 상태 그대로.
                row.put("status", finished ? before.status() : PaperBooks.CHECKPOINT_PLANNED);
                if (finished) {
                    row.put("note", "그 순번의 장중 판단이 이미 끝나(" + before.status() + ") 이 예약은 쓰지 않음");
                }
                slot++;
            }
            ArrayNode rejected = out.putArray("rejected");
            for (IntradayRequest.Rejected r : verdict.rejected()) {
                ObjectNode row = rejected.addObject();
                row.put(zoneField, r.at());
                row.put("reason", r.reason());
            }
            out.put("superseded", closed());
            return out;
        }
    }

    /**
     * 결정 응답의 {@code checkpoints}와 그 세션의 지금 행 — 예약도 남은 행도 없으면 null(할 일 없음).
     *
     * @param max 그 실행 설정의 세션당 장중 판단 횟수(0이면 받은 예약을 모두 버림)
     */
    Plan plan(ClaudeBookProfile profile, JsonNode parsed, LocalDate session, TradingCalendar calendar, Set<String> universe,
              int max, Instant now) {
        boolean korea = profile.market() == KrPaperMarket.INSTANCE;
        JsonNode requests = parsed == null ? null : parsed.get("checkpoints");
        List<IntradayPlan> existing = store.intradayPlans(profile.code(), session);
        boolean requested = requests != null && requests.isArray() && !requests.isEmpty();
        if (!requested && existing.isEmpty()) {
            return null;
        }
        // 끝난 판단(부름·놓침·건너뜀)의 순번과 시각은 그대로 남습니다 — 새 예약은 그 뒤 순번부터이고 그 시각들과도 간격을 지킵니다(결정이 세션
        // 도중에 다시 나는 드문 경우). 뒤 결정이 닫은 행(SUPERSEDED)은 끝난 판단이 아니라 이번 예약이 다시 쓸 수 있습니다.
        List<IntradayPlan> finished = existing.stream().filter(IntradayPlanner::finished).toList();
        List<LocalTime> taken = finished.stream().map(IntradayPlan::atLocal).toList();
        int firstSlot = 1 + finished.stream().mapToInt(IntradayPlan::slot).max().orElse(0);
        int room = Math.max(0, Math.min(max, RuleBookService.INTRADAY_MAX) - (firstSlot - 1));
        IntradayRequest.Verdict verdict = requested && max <= 0
                ? disabled(requests)
                : IntradayRequest.validate(requests, session, calendar, universe, now, room, taken, korea);
        return new Plan(profile.code(), session, variant(profile), max, firstSlot, true, verdict, existing);
    }

    /**
     * 장중 판단 응답의 {@code nextCheckpoint}와 그 세션의 지금 행 — 다음 순번이 없거나({@code slot}이 마지막) 예약이 없으면 null(남은 예약 그대로).
     * 예약은 다음 순번 하나만 대신하므로, 그 뒤 순번에 PLANNED 행이 있으면 그 시각보다 {@link IntradayRequest#MIN_GAP} 이상 앞이어야 받습니다(QA-309 —
     * 뒤나 20분 안이면 순번 순 ≠ 시각 순이 되고 두 판단의 호출 창이 겹침). 그 행은 바꾸지 않습니다.
     *
     * @param slot 지금 부른 판단의 순번
     */
    Plan next(ClaudeBookProfile profile, JsonNode parsed, LocalDate session, int slot, TradingCalendar calendar, Set<String> universe,
              int max, Instant now, ObjectMapper mapper) {
        JsonNode request = parsed == null ? null : parsed.get("nextCheckpoint");
        if (request == null || !request.isObject()) {
            return null;
        }
        boolean korea = profile.market() == KrPaperMarket.INSTANCE;
        List<IntradayPlan> existing = store.intradayPlans(profile.code(), session);
        ArrayNode requests = mapper.createArrayNode();
        requests.add(request);
        int limit = Math.min(max, RuleBookService.INTRADAY_MAX);
        List<LocalTime> taken = existing.stream().filter(p -> p.slot() <= slot).map(IntradayPlan::atLocal).toList();
        IntradayRequest.Verdict verdict = slot >= limit
                ? new IntradayRequest.Verdict(List.of(), List.of(new IntradayRequest.Rejected(text(request, "at"),
                        "CHECKPOINT_INVALID — 세션당 장중 판단 횟수(" + limit + "번)를 다 써서 다음 판단을 예약할 수 없음")))
                : beforeLater(IntradayRequest.validate(requests, session, calendar, universe, now, 1, taken, korea),
                        laterPlanned(existing, slot), korea);
        return new Plan(profile.code(), session, variant(profile), max, slot + 1, false, verdict, existing);
    }

    /**
     * {@code slot} 판단의 {@code nextCheckpoint}가 대신하지 않고 그대로 남는 뒤 예약 — {@code slot} + 1 뒤 순번의 PLANNED 행 가운데 가장 앞 순번(없으면
     * null). 장중 판단 패킷({@link CheckpointPacket.Reserved#later})도 이것을 싣습니다.
     */
    static IntradayPlan laterPlanned(List<IntradayPlan> rows, int slot) {
        return rows.stream().filter(p -> p.slot() > slot + 1 && PaperBooks.CHECKPOINT_PLANNED.equals(p.status()))
                .min(Comparator.comparingInt(IntradayPlan::slot)).orElse(null);
    }

    /** 받은 예약 가운데 그대로 남는 뒤 예약({@code later})보다 {@link IntradayRequest#MIN_GAP} 이상 앞이 아닌 것을 버립니다(사유를 남김). */
    private static IntradayRequest.Verdict beforeLater(IntradayRequest.Verdict verdict, IntradayPlan later, boolean korea) {
        if (later == null || verdict.accepted().isEmpty()) {
            return verdict;
        }
        String zone = korea ? " KST" : " ET";
        List<IntradayRequest.Item> accepted = new ArrayList<>();
        List<IntradayRequest.Rejected> rejected = new ArrayList<>(verdict.rejected());
        for (IntradayRequest.Item item : verdict.accepted()) {
            if (Duration.between(item.at(), later.atLocal()).compareTo(IntradayRequest.MIN_GAP) < 0) {
                rejected.add(new IntradayRequest.Rejected(FreeTiming.label(item.at()), OrderValidator.CHECKPOINT_INVALID + " — 확인 시각 "
                        + FreeTiming.label(item.at()) + zone + "가 그대로 남는 뒤 예약 " + FreeTiming.label(later.atLocal()) + zone + "(순번 "
                        + later.slot() + ")보다 " + IntradayRequest.MIN_GAP.toMinutes() + "분 이상 앞이어야 함(nextCheckpoint는 다음 순번 하나만 대신함)"));
            } else {
                accepted.add(item);
            }
        }
        return new IntradayRequest.Verdict(accepted, rejected);
    }

    /** 결정의 계획을 씁니다({@link #plan}) — 받은 예약을 순번대로 PLANNED로(끝난 순번은 그대로), 남은 PLANNED 순번을 닫음. */
    void write(Plan plan, long sourceDecisionId) {
        write(plan, sourceDecisionId, null);
    }

    /**
     * 계획을 씁니다 — 받은 예약을 순번대로 PLANNED로(끝난 순번은 그대로), 결정이면 남은 PLANNED 순번을 닫음.
     *
     * @param sourceDecisionId 그 세션의 결정(장중 판단 패킷이 하드 규칙·가격을 읽는 결정 — {@code nextCheckpoint}로 예약해도 그대로)
     * @param requestedBy      이 예약을 낸 장중 판단의 응답 결정({@link #next}) — 결정이 예약했으면 null
     */
    void write(Plan plan, long sourceDecisionId, Long requestedBy) {
        int slot = plan.firstSlot();
        for (IntradayRequest.Item item : plan.verdict().accepted()) {
            store.upsertPlannedIntradayPlan(IntradayPlan.planned(plan.book(), plan.session(), slot, item.at(), item.feed(),
                    item.watch(), item.question(), plan.variant(), false, sourceDecisionId, requestedBy));
            slot++;
        }
        if (plan.closing()) {
            store.supersedeIntradayPlans(plan.book(), plan.session(), slot, SUPERSEDED);
        }
    }

    /** 끝난 판단인가 — 부름(DONE)·놓침(EXPIRED)·건너뜀(SKIPPED). 예정(PLANNED)과 뒤 결정이 닫은 행(SUPERSEDED)은 아닙니다. */
    static boolean finished(IntradayPlan plan) {
        return !PaperBooks.CHECKPOINT_PLANNED.equals(plan.status()) && !PaperBooks.INTRADAY_SUPERSEDED.equals(plan.status());
    }

    /** 그 프로필이 쓰는 판 이름(패킷 {@code 1_basis.fixedRules}와 같은 글자) — 계획 행에 남겨 장중 판단이 그 판으로 부르게 합니다. */
    static String variant(ClaudeBookProfile profile) {
        return profile.market() == KrPaperMarket.INSTANCE ? KrPacketBuilder.KR_FREE_FIXED_RULES_VERSION
                : PacketBuilder.FREE_FIXED_RULES_VERSION;
    }

    private static IntradayRequest.Verdict disabled(JsonNode requests) {
        List<IntradayRequest.Rejected> rejected = new ArrayList<>();
        for (JsonNode request : requests) {
            rejected.add(new IntradayRequest.Rejected(text(request, "at"), DISABLED));
        }
        return new IntradayRequest.Verdict(List.of(), rejected);
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node == null ? null : node.get(field);
        return v == null || v.isNull() ? null : v.isString() ? v.asString() : v.toString();
    }
}
