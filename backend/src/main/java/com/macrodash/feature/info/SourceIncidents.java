package com.macrodash.feature.info;

import com.macrodash.store.InfoStore.SourceState;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * 수집 출처 끊김 판정(ADR 0035 결정 6) — 순수 계산입니다(저장소를 모름). 입력은 polite 태스크마다의 마지막 판정, 출력은 지금 끊긴 출처.
 *
 * <ul>
 *   <li>차단(blocked) — 출처가 거부해 그 출처만 잠시 멈춤(물러남·사람 확인·포기). 바로 알립니다.</li>
 *   <li>형식 바뀜(format) — 연속 {@value #FORMAT_STREAK}회. 한 번은 출처의 일시적인 빈 응답일 수 있습니다.</li>
 *   <li>받지 못함(failed) — 404·5xx·전송 실패가 연속 {@value #FAILED_STREAK}회.</li>
 *   <li>오래 못 받음(stale) — 마지막 성공(없으면 처음 기록)이 그 출처 간격 상한의 세 배({@code stale_after_minutes})보다 오래됨.</li>
 * </ul>
 * 한 출처에는 사건 하나만 둡니다(차단 &gt; 형식 바뀜 &gt; 받지 못함 &gt; 오래 못 받음).
 */
public final class SourceIncidents {

    static final int FORMAT_STREAK = 2;
    static final int FAILED_STREAK = 3;

    private SourceIncidents() {
    }

    /** 끊긴 출처 하나. {@code key}는 '태스크|종류'(알림 기록의 키). */
    public record Incident(String key, String task, String label, String kind, String kindLabel, String reason, Instant since) {
    }

    public static String kindLabel(String kind) {
        return switch (kind) {
            case "blocked" -> "차단됨 — 그 출처만 잠시 멈춤";
            case "format" -> "형식 바뀜";
            case "failed" -> "받지 못함";
            case "stale" -> "오래 못 받음";
            default -> kind;
        };
    }

    public static List<Incident> build(List<SourceState> states, Instant now) {
        List<Incident> out = new ArrayList<>();
        for (SourceState state : states) {
            String kind = null;
            String reason = state.reason();
            Instant since = state.lastRunAt();
            if ("blocked".equals(state.status())) {
                kind = "blocked";
            } else if ("format".equals(state.status()) && state.streak() >= FORMAT_STREAK) {
                kind = "format";
            } else if ("failed".equals(state.status()) && state.streak() >= FAILED_STREAK) {
                kind = "failed";
            } else {
                Instant base = state.lastOkAt() != null ? state.lastOkAt() : state.createdAt();
                if (base != null && Duration.between(base, now).toMinutes() > state.staleAfterMinutes()) {
                    kind = "stale";
                    since = base;
                    reason = state.lastOkAt() == null
                            ? "아직 한 번도 받지 못함"
                            : "마지막 성공 뒤 " + Duration.between(base, now).toHours() + "시간 — 간격 상한의 세 배를 넘음";
                }
            }
            if (kind != null) {
                out.add(new Incident(state.task() + "|" + kind, state.task(), InfoSources.label(state.task()), kind,
                        kindLabel(kind), reason, since));
            }
        }
        return out;
    }
}
