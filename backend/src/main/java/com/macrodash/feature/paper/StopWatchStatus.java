package com.macrodash.feature.paper;

import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.LocalDate;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 장중 스탑 감시 작업({@link PaperStopWatchJob})의 지금 상태 — 이 프로세스 메모리에만 있는 시장별 값(DB에 쓰지 않음). 작업 기록은 주문·'걸렸을 것'·
 * 갭 가드·오류·늦음일 때만 남아 조용한 날과 '돌지 않음'이 구분되지 않던 것을, 상태 응답({@code GET /api/paper/status} 의 {@code stopWatch})이 이 값으로
 * 보입니다(감시 작업 살아 있음 신호). 쓰는 쪽은 감시 작업 하나(한 줄 잠금 안), 읽는 쪽은 상태 조회라 시장마다 불변 값({@link View})을 통째로 바꿉니다.
 * 재기동하면 비어 있습니다(그 세션 감시를 다시 보기 전까지 값 없음 — 0으로 채우지 않음).
 */
@Component
public class StopWatchStatus {

    /**
     * 한 시장의 지금 상태.
     *
     * @param mode                작업이 마지막으로 읽은 스위치(SHADOW·ON)
     * @param session             세는 값이 속한 세션(그 시장 날짜) — 작업이 그 세션 상태를 열기 전이면 null
     * @param sessionOpenedAt     이 프로세스가 그 세션 상태를 연 시각(첫 판정 격자 뒤면 재기동 등으로 세션 일부만 셈)
     * @param lastCycleAt         작업이 이 시장을 마지막으로 본 시각
     * @param lastSkipped         마지막 회차가 판정하지 않은 사유(판정했으면 null — 창 밖·새 저장본 없음·오류 …)
     * @param lastJudgedGrid      마지막으로 판정한 격자
     * @param lastJudgedAt        그 격자를 판정한 시각
     * @param snapshotCollectedAt 작업이 마지막으로 읽은 감시 저장본의 수집 시각(판정 창 안에서만 읽음)
     * @param cyclesJudged        그 세션에 격자를 판정한 회차 수
     * @param gridsJudged         그 세션에 판정한 격자 수
     * @param tickersJudged       그 세션에 판정한 계좌·종목 수(서로 다른 것)
     * @param stops               그 세션에 낸 STOP 수(ON)
     * @param wouldStops          그 세션의 '걸렸을 것' 수(SHADOW — 종목마다 한 번)
     * @param guarded             그 세션에 갭 가드로 뺀 계좌·종목 수(처음 본 것만)
     */
    public record View(String mode, LocalDate session, Instant sessionOpenedAt, Instant lastCycleAt, String lastSkipped,
                       Instant lastJudgedGrid, Instant lastJudgedAt, Instant snapshotCollectedAt, int cyclesJudged, int gridsJudged,
                       int tickersJudged, int stops, int wouldStops, int guarded) {

        /** 마지막 회차의 시각·사유만 바꾼 값. */
        View cycled(Instant at, String skipped) {
            return new View(mode, session, sessionOpenedAt, at, skipped, lastJudgedGrid, lastJudgedAt, snapshotCollectedAt, cyclesJudged,
                    gridsJudged, tickersJudged, stops, wouldStops, guarded);
        }
    }

    private final Map<String, View> views = new ConcurrentHashMap<>();

    /** 그 시장의 지금 상태(작업이 이 프로세스에서 그 시장을 본 적이 없거나 스위치가 꺼졌으면 empty). */
    public Optional<View> view(String market) {
        return Optional.ofNullable(views.get(market));
    }

    void put(String market, View view) {
        views.put(market, view);
    }

    /** 마지막 회차의 시각·사유만 — 상태가 없으면 아무것도 하지 않습니다(꺼진 시장·처음 회차의 오류는 칸을 만들지 않음). */
    void cycled(String market, Instant at, String skipped) {
        views.computeIfPresent(market, (k, v) -> v.cycled(at, skipped));
    }

    void clear(String market) {
        views.remove(market);
    }
}
