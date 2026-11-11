package com.macrodash.feature.info;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.store.InfoStore;
import com.macrodash.store.SourceAlertStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * 수집 출처 끊김 알림(ADR 0035 결정 7, ADR 0026 결정 4·5의 닫힘 알림을 넓힘) — 차단 통과 수집 계층(polite)의 출처가 끊기면 운영 봇으로 텔레그램 한 통,
 * 풀리면 한 통을 보냅니다. 화면의 안내 띠는 같은 판정({@link SourceIncidents})을 {@code GET /api/info/sources}로 읽습니다.
 *
 * <ul>
 *   <li><b>한 사건에 한 통</b>: 사건(태스크 + 종류)마다 처음 볼 때 한 번. 보낸 것·못 보낸 것은 표 {@code source_alerts}에 있어 배포로 다시 떠도
 *       같은 사건을 다시 알리지 않고, 보내지 못한 것은 다음 주기에 다시 보냅니다.</li>
 *   <li><b>읽기만</b>: 수집기 표({@code fetch_source_state})는 읽기만 하고 수집을 일으키지 않습니다(ADR 0008).</li>
 *   <li><b>켜짐</b>: 텔레그램 값이 둘 다 있을 때만(서버). 모의 매매 정기 작업({@code PAPER_ENABLED})과 무관합니다.</li>
 *   <li>글에는 출처 이름·종류·사유 한 줄만 싣습니다(주소·본문 없음).</li>
 * </ul>
 */
@Service
public class SourceAlertJob {

    /** 수집기가 포기로 닫을 때 사유 줄에 적는 글(collector/app/fetch/state.py Closed.message — 시험이 그 파일과 대조합니다). */
    static final String GIVE_UP_MARK = "포기";

    private static final Logger log = LoggerFactory.getLogger(SourceAlertJob.class);

    private final InfoStore info;
    private final SourceAlertStore alerts;
    private final PaperTelegram telegram;
    private final Clock clock;

    @Autowired
    public SourceAlertJob(InfoStore info, SourceAlertStore alerts, PaperTelegram telegram) {
        this(info, alerts, telegram, Clock.systemUTC());
    }

    SourceAlertJob(InfoStore info, SourceAlertStore alerts, PaperTelegram telegram, Clock clock) {
        this.info = info;
        this.alerts = alerts;
        this.telegram = telegram;
        this.clock = clock;
    }

    /** 정기 실행 — 텔레그램 값이 있을 때만. 예외는 로그로만. */
    @Scheduled(initialDelayString = "${dashboard.info.alert-initial-delay-ms:210000}",
            fixedDelayString = "${dashboard.info.alert-interval-ms:300000}")
    public void scheduledRun() {
        if (!telegram.configured()) {
            return;
        }
        try {
            run();
        } catch (RuntimeException e) {
            log.warn("수집 출처 끊김 알림 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** @return 이번에 보낸 통 수(끊김·회복) */
    synchronized int run() {
        if (!info.ready() || !alerts.ready()) {
            return 0;
        }
        Instant now = clock.instant();
        List<SourceIncidents.Incident> incidents = SourceIncidents.build(info.states(), now);
        Map<String, SourceAlertStore.Open> open = alerts.open().stream()
                .collect(Collectors.toMap(SourceAlertStore.Open::key, Function.identity()));
        int sent = 0;
        for (SourceIncidents.Incident incident : incidents) {
            SourceAlertStore.Open known = open.remove(incident.key());
            if (known == null) {
                alerts.open(incident.key(), incident.task(), incident.kind(), incident.reason(), now);
            } else if (known.notifiedAt() != null) {
                continue;
            }
            String error = telegram.send(downText(incident));
            if (error != null) {
                log.warn("수집 출처 끊김 알림을 보내지 못함 — 다음 주기에 다시: {}", error);
                return sent;
            }
            alerts.notified(incident.key(), now);
            sent++;
        }
        for (SourceAlertStore.Open gone : open.values()) {
            alerts.recovered(gone.key(), now);
            if (gone.notifiedAt() == null) {
                continue;                       // 알리지 못한 채 풀린 사건은 회복도 알리지 않습니다
            }
            String error = telegram.send(upText(gone, now));
            if (error != null) {
                log.warn("수집 출처 회복 알림을 보내지 못함(다시 보내지 않음): {}", error);
                continue;
            }
            sent++;
        }
        return sent;
    }

    /** 끊김 알림 글(텔레그램 HTML 서식). */
    static String downText(SourceIncidents.Incident incident) {
        StringBuilder out = new StringBuilder();
        out.append(PaperTelegram.bold("수집 끊김")).append("\n\n");
        out.append(PaperTelegram.bold("출처")).append(' ').append(PaperTelegram.esc(incident.label())).append('\n');
        out.append(PaperTelegram.bold("종류")).append(' ').append(PaperTelegram.esc(incident.kindLabel())).append('\n');
        if (incident.reason() != null && !incident.reason().isBlank()) {
            out.append(PaperTelegram.bold("사유")).append(' ').append(PaperTelegram.esc(incident.reason())).append('\n');
        }
        String next = switch (incident.kind()) {
            case "blocked" -> incident.reason() != null && incident.reason().contains(GIVE_UP_MARK)
                    ? "서버 IP가 계속 막혀 이 출처를 포기했습니다 — 운영자가 풀 때까지 다시 시도하지 않습니다."
                    : "서버 IP가 막혀 이 출처만 잠시 멈췄습니다. 정해진 시각 뒤 스스로 다시 시도합니다(개인 IP로 돌리지 않음).";
            case "format" -> "출처의 화면·피드 형식이 바뀐 것 같습니다. 수집기 파서를 고쳐야 할 수 있습니다.";
            case "failed" -> "출처가 연속으로 응답하지 않았습니다. 스스로 다시 시도합니다.";
            default -> "마지막 성공이 오래됐습니다. 상태 화면의 그 태스크 기록을 보세요.";
        };
        out.append('\n').append(PaperTelegram.esc(next + " 직전 저장본은 그대로이고, 화면: 모의매매 > 정보 수집."));
        return out.toString();
    }

    /** 회복 알림 글. */
    static String upText(SourceAlertStore.Open gone, Instant now) {
        return PaperTelegram.bold("수집 회복") + "\n\n"
                + PaperTelegram.bold("출처") + ' ' + PaperTelegram.esc(InfoSources.label(gone.task())) + '\n'
                + PaperTelegram.bold("끊겼던 종류") + ' ' + PaperTelegram.esc(SourceIncidents.kindLabel(gone.kind())) + '\n'
                + PaperTelegram.bold("기간") + ' ' + PaperTelegram.esc(Kst.stamp(gone.openedAt()) + " ~ " + Kst.stamp(now));
    }
}
