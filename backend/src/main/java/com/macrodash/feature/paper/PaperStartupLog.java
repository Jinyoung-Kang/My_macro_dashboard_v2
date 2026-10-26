package com.macrodash.feature.paper;

import com.macrodash.config.AppProperties;
import com.macrodash.config.SchedulingConfig;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

/**
 * 기동할 때 🧪 모의 매매 정기 작업이 이 스택에서 도는지 한 줄로 남깁니다(ADR 0020 결과 — 계획서 §6 위험 표).
 *
 * <p>장부는 한 곳(AWS 서버)에만 둡니다(ADR 0019·0020). {@code PAPER_ENABLED}는 compose·application.yml·{@link PaperConfig}
 * 세 층 모두 기본값이 켜짐이라, {@code .env}에서 그 줄이 빠지면 로컬 스택도 정기 작업(리스크 점검·결정·체결)을 돌립니다.
 * 두 곳이 동시에 돌면 같은 일을 두 장부에서 따로 하게 되므로 {@code make logs S=backend}에서 바로 알아보게 합니다.
 *
 * <p>스케줄러 상태는 프로퍼티를 다시 읽지 않고 {@link SchedulingConfig} 빈이 있는지로 봅니다 — {@code @ConditionalOnProperty}는
 * "true"만 켜짐으로 보는데 {@code Environment}는 "yes"·"on"도 참으로 읽어, 다시 읽으면 실제와 다르게 찍힐 수 있습니다.
 * 로그에는 불린·정수·날짜만 넣습니다(비밀번호·토큰·이메일·주소 없음 — 공개 저장소이고 로그는 컨테이너에 남음).
 */
@Component
public class PaperStartupLog {

    private static final Logger log = LoggerFactory.getLogger(PaperStartupLog.class);

    private final PaperConfig config;
    private final AppProperties properties;
    private final boolean schedulerOn;

    @Autowired
    public PaperStartupLog(PaperConfig config, AppProperties properties, ObjectProvider<SchedulingConfig> scheduling) {
        this(config, properties, scheduling.getIfAvailable() != null);
    }

    PaperStartupLog(PaperConfig config, AppProperties properties, boolean schedulerOn) {
        this.config = config;
        this.properties = properties;
        this.schedulerOn = schedulerOn;
    }

    /** 값만 찍는 일이라 실패해도 기동은 막지 않습니다. */
    @EventListener(ApplicationReadyEvent.class)
    public void logOnStartup() {
        try {
            boolean runs = config.enabled() && schedulerOn;
            boolean localNoLogin = properties.isLocalNoLogin();
            log.info("모의 매매 정기 작업 {} — PAPER_ENABLED={} · 스케줄러(dashboard.scheduler.enabled)={} · LOCAL_NO_LOGIN={}"
                            + " · 화면 포트 {} · 출발일 {} (정기 작업은 한 곳에서만, ADR 0019·0020)",
                    runs ? "켜짐" : "꺼짐", config.enabled(), schedulerOn ? "켜짐" : "꺼짐", localNoLogin,
                    properties.getFrontendPort(), config.startDate());
            // 로그인 없는 스택은 이 맥의 로컬 스택입니다(AWS·QA 덧붙임은 false 고정, ADR 0016). 거기서 정기 작업이 돌면
            // 서버와 두 곳에서 같은 장부 일을 하게 되므로 따로 경고합니다(ADR 0019·0020). 스케줄러가 꺼져 있으면 돌지 않으니 경고하지 않습니다.
            if (runs && localNoLogin) {
                log.warn("모의 매매 정기 작업이 로그인 없는 로컬 스택(LOCAL_NO_LOGIN=true)에서 켜져 있습니다 — 장부는 AWS 서버 한 곳에만 둡니다"
                        + "(ADR 0019·0020). .env에 PAPER_ENABLED=false를 적고 make up 하세요");
            }
        } catch (RuntimeException e) {
            log.warn("모의 매매 기동 설정 로그 실패 — 기동은 계속합니다: {}", e.toString());
        }
    }
}
