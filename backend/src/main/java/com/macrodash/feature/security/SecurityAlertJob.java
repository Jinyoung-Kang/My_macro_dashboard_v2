package com.macrodash.feature.security;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.feature.security.Verdict.Status;
import com.macrodash.store.AlertStore;
import com.macrodash.store.SecurityAlertStore;
import com.macrodash.store.SecurityTrackerStore;
import com.macrodash.store.UserStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 보안 공지 알림(ADR 0046 결정 7·9의 2) — 15분마다 판정을 계산해 처음 '해당'이 된 공지를 알림함(운영자)과 텔레그램 운영 봇으로 한 번 알립니다.
 *
 * <ul>
 *   <li><b>공지당 한 번</b>: 알린 공지는 표 {@code security_alerts}에 남아 배포로 다시 떠도 되풀이하지 않습니다. 알림함 사건(종류 {@value #KIND})·배달과
 *       기록은 한 트랜잭션입니다.</li>
 *   <li><b>텔레그램 재시도</b>: 보내지 못한 공지는 보낸 시각이 비어 있어, 그 공지가 아직 해당이면 다음 주기에 다시 보냅니다(보낸 뒤에 기록). 텔레그램 값이 없는
 *       곳(로컬·QA)은 알림함만 넣습니다.</li>
 *   <li><b>묶음</b>: 한 주기에 보낼 공지가 여럿이면(처음 90일을 메우는 동안 등) 텔레그램 한 통에 묶습니다. 알림함은 공지마다 한 줄입니다.</li>
 *   <li><b>버전 목록이 없으면 0건</b>: 판정이 모두 확인 필요라 알릴 것이 없습니다(결정 8). 수집기 표를 읽기만 하고 스냅숏을 읽지 않으니 수집을 일으키지
 *       않습니다({@code StoreReader.quietly}와 같은 뜻 — ADR 0008).</li>
 *   <li><b>글에는 제품 이름·CVE 건수·화면 자리만</b>: 설치 버전·버전 칸 원문은 텔레그램·알림함 글·로그에 넣지 않습니다(저장소가 공개라 서버의 실제 버전은 DB에만).
 *       로그에는 건수·글 번호·예외 종류만 남깁니다.</li>
 *   <li><b>배포판 추적기에 물어볼 것 맞추기</b>(ADR 0046 덧붙임 2026-11-21): 같은 주기에 판정에서 모은 '물어볼 것'
 *       ({@link SecurityService#trackerWants})으로 표 {@code security_tracker_wants}를 맞춥니다(수집기가 다음 실행에서 물음). 버전 목록이 없으면
 *       맞추지 않고(표를 비우지 않음), 실패해도 알림은 그대로 봅니다(로그에 건수·예외 종류만). 추적기로 해당이 된 공지(고친 판이 나왔는데 깔리지
 *       않음)도 같은 길로 알립니다.</li>
 * </ul>
 */
@Service
public class SecurityAlertJob {

    static final String KIND = "SECURITY_NOTICE";
    /** 화면 자리 — 메뉴 더보기 '보안 공지'. */
    static final String SCREEN = "/security";
    static final String SCREEN_LABEL = "더보기 > 보안 공지(" + SCREEN + ")";
    static final String ACTION = "화면에서 해당 행의 해결 버전을 확인하고, Claude Code에 \"보안 공지 해당 업데이트 확인해 줘\"라고 하면 됩니다.";

    private static final Logger log = LoggerFactory.getLogger(SecurityAlertJob.class);

    /** 한 번 돈 결과 — 새로 알림함에 넣은 공지 수, 텔레그램으로 알린 공지 수(묶음이면 그 안의 공지 수). */
    record Outcome(int inboxed, int telegrammed) {
        static final Outcome NONE = new Outcome(0, 0);
    }

    private final SecurityService security;
    private final SecurityAlertStore records;
    private final SecurityTrackerStore trackers;
    private final AlertStore alerts;
    private final UserStore users;
    private final PaperTelegram telegram;
    private final Clock clock;

    @Autowired
    public SecurityAlertJob(SecurityService security, SecurityAlertStore records, SecurityTrackerStore trackers, AlertStore alerts,
                            UserStore users, PaperTelegram telegram) {
        this(security, records, trackers, alerts, users, telegram, Clock.systemUTC());
    }

    SecurityAlertJob(SecurityService security, SecurityAlertStore records, SecurityTrackerStore trackers, AlertStore alerts,
                     UserStore users, PaperTelegram telegram, Clock clock) {
        this.security = security;
        this.records = records;
        this.trackers = trackers;
        this.alerts = alerts;
        this.users = users;
        this.telegram = telegram;
        this.clock = clock;
    }

    /** 정기 실행(15분, 처음엔 4분 뒤). 예외는 로그 한 줄(예외 종류만)로 — 다음 주기에 다시 봅니다. */
    @Scheduled(initialDelayString = "${dashboard.security.alert-initial-delay-ms:240000}",
            fixedDelayString = "${dashboard.security.alert-interval-ms:900000}")
    public void scheduledRun() {
        try {
            Outcome outcome = run();
            if (outcome.inboxed() > 0 || outcome.telegrammed() > 0) {
                log.info("보안 공지 알림 — 알림함 {}건, 텔레그램 {}건", outcome.inboxed(), outcome.telegrammed());
            }
        } catch (RuntimeException e) {
            log.warn("보안 공지 알림 작업 실패 — 다음 주기에 다시 봅니다: {}", e.getClass().getSimpleName());
        }
    }

    synchronized Outcome run() {
        if (!security.ready() || !records.ready() || !alerts.ready()) {
            return Outcome.NONE;            // V40 전
        }
        // 판정은 입력 판이 그대로면 화면과 같은 기억을 씁니다 — 판은 이 주기에도 새로 확인하므로 옛 판정으로 알리지 않습니다(QA-991).
        SecurityService.Judgement judgement = security.judgement();
        if (judgement.inventory() == null) {
            return Outcome.NONE;            // 버전 목록 없음 — 해당이 나올 수 없음
        }
        List<SecurityService.Judged> all = judgement.judged();
        syncTrackerWants(all);
        List<SecurityService.Judged> affected = all.stream().filter(j -> j.verdict().status() == Status.AFFECTED).toList();
        if (affected.isEmpty()) {
            return Outcome.NONE;
        }
        Map<Long, SecurityAlertStore.Alert> known = records.all().stream()
                .collect(Collectors.toMap(SecurityAlertStore.Alert::nttId, Function.identity()));
        Instant now = clock.instant().truncatedTo(ChronoUnit.SECONDS);
        List<Long> owners = owners();

        int inboxed = 0;
        List<SecurityService.Judged> unsent = new ArrayList<>();
        for (SecurityService.Judged judged : affected) {
            long id = judged.notice().nttId();
            SecurityAlertStore.Alert record = known.get(id);
            if (record != null) {
                if (record.telegramSentAt() == null) {
                    unsent.add(judged);
                }
                continue;
            }
            try {
                record(judged, owners, now);
                inboxed++;
                unsent.add(judged);
            } catch (DataAccessResourceFailureException e) {
                throw e;                     // DB에 닿지 못함 — 나머지도 같으니 이 주기를 멈춤
            } catch (RuntimeException e) {
                log.warn("보안 공지 알림 한 건 실패(글 번호 {}) — 다음 주기에 다시 봅니다: {}", id, e.getClass().getSimpleName());
            }
        }

        int telegrammed = 0;
        if (!unsent.isEmpty() && telegram.configured()) {
            String text = unsent.size() == 1 ? singleText(unsent.get(0)) : bundleText(unsent);
            String error = telegram.send(PaperTelegram.Channel.OPS, text);
            if (error != null) {
                log.warn("보안 공지 텔레그램을 보내지 못함({}건) — 다음 주기에 다시 보냅니다: {}", unsent.size(), error);
            } else {
                records.telegramSent(unsent.stream().map(j -> j.notice().nttId()).toList(), now);
                telegrammed = unsent.size();
            }
        }
        return new Outcome(inboxed, telegrammed);
    }

    /**
     * 배포판 추적기에 물어볼 것을 이번 판정으로 맞춥니다. 표가 없으면(V42 전) 건너뛰고, 실패는 로그 한 줄(건수·예외 종류)로 — 알림은 그대로 봅니다.
     */
    private void syncTrackerWants(List<SecurityService.Judged> judged) {
        int wanted = -1;
        try {
            if (!trackers.ready()) {
                return;
            }
            Set<SecurityTrackerStore.Want> wants = SecurityService.trackerWants(judged);
            wanted = wants.size();
            SecurityTrackerStore.SyncResult result = trackers.replaceAll(wants);
            if (result.inserted() > 0 || result.deleted() > 0 || result.skipped() > 0) {
                log.info("배포판 추적기 물어볼 것 — {}건(새로 {}건, 지움 {}건, 건너뜀 {}건)", wanted, result.inserted(), result.deleted(),
                        result.skipped());
            }
        } catch (RuntimeException e) {
            log.warn("배포판 추적기 물어볼 것 맞추기 실패({}건) — 알림은 그대로 봅니다: {}", Math.max(wanted, 0), e.getClass().getSimpleName());
        }
    }

    /** 알림함 사건과 운영자마다의 배달, 기록 한 행을 한 트랜잭션으로. 다른 실행이 먼저 기록했으면 되돌립니다. */
    private void record(SecurityService.Judged judged, List<Long> owners, Instant now) {
        long id = judged.notice().nttId();
        String products = String.join(", ", SecurityService.affectedLabels(judged.verdict()));
        String title = "보안 공지 해당 — " + products;
        String body = cveText(security.affectedCveCount(judged)) + " · 화면: " + SCREEN_LABEL;
        ObjectNode payload = JsonNodeFactory.instance.objectNode().put("href", SCREEN + "?ntt=" + id);
        records.atomically(() -> {
            Optional<Long> event = alerts.insertEvent(KIND, "security_notice:" + id, Kst.today(clock), title, body, payload);
            event.ifPresent(eventId -> owners.forEach(owner -> alerts.deliverInbox(eventId, owner)));
            if (!records.insert(id, now, event.orElse(null))) {
                throw new IllegalStateException("이미 기록된 공지");
            }
            return null;
        });
    }

    /** 운영자 계정 번호들(알림함을 받는 사람). */
    private List<Long> owners() {
        if (!users.ready()) {
            return List.of();
        }
        return users.all().stream().filter(u -> "OWNER".equals(u.role())).map(UserStore.User::id).toList();
    }

    // ------------------------------------------------------------------ 글 (제품 이름·CVE 건수·화면 자리만)

    /** CVE 건수 — 표 행에 CVE 번호가 없으면 셀 수 없다고 적습니다(0건으로 두지 않음). */
    static String cveCount(Integer count) {
        return count == null ? "번호 표기 없음" : count + "건";
    }

    static String cveText(Integer count) {
        return "CVE " + cveCount(count);
    }

    /** 한 공지의 텔레그램 글(MarkdownV2 — 값은 모두 {@link PaperTelegram#esc}). */
    String singleText(SecurityService.Judged judged) {
        return PaperTelegram.bold("보안 공지 해당") + "\n\n"
                + PaperTelegram.bold("제품") + ' ' + PaperTelegram.esc(String.join(", ", SecurityService.affectedLabels(judged.verdict()))) + '\n'
                + PaperTelegram.bold("CVE") + ' ' + PaperTelegram.esc(cveCount(security.affectedCveCount(judged))) + '\n'
                + PaperTelegram.bold("화면") + ' ' + PaperTelegram.esc(SCREEN_LABEL) + "\n\n"
                + PaperTelegram.bold("실행") + ' ' + PaperTelegram.esc(ACTION);
    }

    /** 여러 공지를 한 통에 묶은 글 — 공지마다 한 줄(제품 이름 — CVE 건수). */
    String bundleText(List<SecurityService.Judged> judged) {
        StringBuilder out = new StringBuilder();
        out.append(PaperTelegram.bold("보안 공지 해당 " + judged.size() + "건")).append("\n\n");
        for (SecurityService.Judged j : judged) {
            out.append(PaperTelegram.esc("· " + String.join(", ", SecurityService.affectedLabels(j.verdict())) + " — "
                    + cveText(security.affectedCveCount(j)))).append('\n');
        }
        out.append('\n').append(PaperTelegram.bold("화면")).append(' ').append(PaperTelegram.esc(SCREEN_LABEL)).append("\n\n");
        out.append(PaperTelegram.bold("실행")).append(' ').append(PaperTelegram.esc(ACTION));
        return out.toString();
    }
}
