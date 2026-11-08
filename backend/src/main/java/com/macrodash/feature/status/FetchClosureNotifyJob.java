package com.macrodash.feature.status;

import com.macrodash.Kst;
import com.macrodash.feature.paper.PaperTelegram;
import com.macrodash.store.FetchStateStore;
import com.macrodash.store.FetchStateStore.Closure;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 차단 통과 수집 계층의 닫힘 알림(ADR 0026 결정 4·5) — 출처가 <b>사람 확인</b>(CAPTCHA·체크박스)을 요구해 길게 닫혔거나 연속 거부로
 * <b>포기</b>로 넘어가면 텔레그램 한 통을 보냅니다. 보통의 거부 뒤 물러남(30분~하루)은 알리지 않습니다 — 상태 화면의 그 태스크 기록에
 * '거부됨'으로 보이고 스스로 다시 시도합니다.
 *
 * <ul>
 *   <li><b>한 통만</b>: 닫힘 하나(호스트 + 풀리는 시각, 포기는 호스트)마다 한 번. 보낸 것은 이 프로세스의 메모리에 둡니다 — 백엔드가
 *       다시 뜨면 그때 닫혀 있던 것은 '이미 알린 것'으로 치고 그 뒤에 새로 닫히는 것만 알립니다(다시 뜰 때마다 같은 알림이 되풀이되지
 *       않게). 백엔드가 꺼져 있는 동안 닫힌 것은 알림 없이 상태 화면에만 보입니다.</li>
 *   <li><b>읽기만</b>: 수집기 표({@code fetch_hosts})를 읽기만 하고 수집을 일으키지 않습니다(ADR 0008).</li>
 *   <li><b>켜짐</b>: 텔레그램 값이 둘 다 있을 때만(서버). 모의 매매 정기 작업({@code PAPER_ENABLED})과 무관합니다. 보내기는 모의 매매
 *       알림과 같은 봇({@link PaperTelegram})입니다 — 실패하면 다음 주기에 다시 봅니다.</li>
 * </ul>
 */
@Service
public class FetchClosureNotifyJob {

    /** 수집기가 사람 확인으로 닫을 때 사유에 적는 글(collector/app/fetch/ladder.py — 시험이 그 파일과 대조합니다). */
    static final String HUMAN_CHECK_MARK = "사람 확인 요구";

    private static final Logger log = LoggerFactory.getLogger(FetchClosureNotifyJob.class);

    private final FetchStateStore store;
    private final PaperTelegram telegram;
    private final Clock clock;
    private final Set<String> notified = new HashSet<>();
    private boolean primed;

    @Autowired
    public FetchClosureNotifyJob(FetchStateStore store, PaperTelegram telegram) {
        this(store, telegram, Clock.systemUTC());
    }

    /** 테스트용 — 시계를 바꿔 끼웁니다. */
    FetchClosureNotifyJob(FetchStateStore store, PaperTelegram telegram, Clock clock) {
        this.store = store;
        this.telegram = telegram;
        this.clock = clock;
    }

    /** 정기 실행 — 텔레그램 값이 있을 때만. 예외는 로그로만. */
    @Scheduled(initialDelayString = "${dashboard.fetch.notify-initial-delay-ms:210000}",
            fixedDelayString = "${dashboard.fetch.notify-interval-ms:300000}")
    public void scheduledRun() {
        if (!telegram.configured()) {
            return;
        }
        try {
            run();
        } catch (RuntimeException e) {
            log.warn("수집 출처 닫힘 알림 작업 실패 — 다음 주기에 다시 봅니다: {}", e.toString());
        }
    }

    /** @return 이번에 보낸 통 수 */
    synchronized int run() {
        if (!store.ready()) {
            return 0;
        }
        List<Closure> closed = store.closed(clock.instant()).stream().filter(FetchClosureNotifyJob::notable).toList();
        Set<String> current = new HashSet<>();
        closed.forEach(closure -> current.add(key(closure)));
        if (!primed) {
            // 처음 본 닫힘(백엔드가 뜨기 전에 닫힌 것)은 알린 것으로 칩니다.
            notified.addAll(current);
            primed = true;
            return 0;
        }
        int sent = 0;
        for (Closure closure : closed) {
            String key = key(closure);
            if (notified.contains(key)) {
                continue;
            }
            String error = telegram.send(text(closure));
            if (error != null) {
                log.warn("수집 출처 닫힘 알림을 보내지 못함 — 다음 주기에 다시: {}", error);
                break;
            }
            notified.add(key);
            sent++;
        }
        notified.retainAll(current);       // 풀린 닫힘은 잊습니다 — 다시 닫히면 새 닫힘으로 알립니다
        return sent;
    }

    /** 알릴 닫힘인가 — 포기했거나 사람 확인으로 닫힌 것만. */
    static boolean notable(Closure closure) {
        return closure.givenUp() || (closure.reason() != null && closure.reason().contains(HUMAN_CHECK_MARK));
    }

    private static String key(Closure closure) {
        return closure.host() + "|" + (closure.givenUp() ? "given-up" : String.valueOf(closure.until()));
    }

    /** 알림 글(텔레그램 HTML 서식) — 호스트와 사유만 싣고 주소는 싣지 않습니다. */
    static String text(Closure closure) {
        StringBuilder out = new StringBuilder();
        out.append(PaperTelegram.bold("수집 출처 닫힘")).append("\n\n");
        out.append(PaperTelegram.bold("출처")).append(' ').append(PaperTelegram.esc(closure.host())).append('\n');
        out.append(PaperTelegram.bold("사유")).append(' ').append(PaperTelegram.esc(closure.reason() == null ? "거부" : closure.reason())).append('\n');
        if (closure.givenUp()) {
            out.append(PaperTelegram.bold("상태")).append(' ').append(PaperTelegram.esc("포기 — 운영자가 풀 때까지 다시 시도하지 않습니다")).append('\n');
        } else {
            out.append(PaperTelegram.bold("다시 시도")).append(' ').append(PaperTelegram.esc(Kst.stamp(closure.until()) + " 뒤")).append('\n');
        }
        out.append('\n').append(PaperTelegram.esc("직전 저장본은 그대로입니다. 푸는 방법은 docs/DATA_SOURCES.md '차단 통과 수집 계층'."));
        return out.toString();
    }
}
