package com.macrodash.feature.paper;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.macrodash.config.AppProperties;
import com.macrodash.config.SchedulingConfig;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;

/** 기동 로그 한 줄로 모의 매매 정기 작업이 이 스택에서 도는지 알아본다(ADR 0020 결과). 비밀값은 찍지 않는다. */
class PaperStartupLogTest {

    private final Logger logger = (Logger) LoggerFactory.getLogger(PaperStartupLog.class);
    private final ListAppender<ILoggingEvent> appender = new ListAppender<>();

    @BeforeEach
    void attach() {
        appender.start();
        logger.addAppender(appender);
    }

    @AfterEach
    void detach() {
        logger.detachAppender(appender);
    }

    private static PaperConfig paper(boolean enabled) {
        return new PaperConfig(enabled, PaperFixtures.FRI, 100_000);
    }

    private static AppProperties properties(boolean localNoLogin) {
        AppProperties properties = new AppProperties();
        properties.setLocalNoLogin(localNoLogin);
        properties.setFrontendPort(3002);
        return properties;
    }

    private List<String> messages(Level level) {
        return appender.list.stream().filter(event -> event.getLevel() == level).map(ILoggingEvent::getFormattedMessage).toList();
    }

    @Test
    @DisplayName("로컬 v2(PAPER_ENABLED=false·로그인 없음): 정기 작업 꺼짐 한 줄, 경고 없음")
    void localStackWithPaperOff() {
        new PaperStartupLog(paper(false), properties(true), true).logOnStartup();

        assertThat(messages(Level.INFO)).singleElement().satisfies(line -> assertThat(line).contains(
                "모의 매매 정기 작업 꺼짐", "PAPER_ENABLED=false", "스케줄러(dashboard.scheduler.enabled)=켜짐",
                "LOCAL_NO_LOGIN=true", "화면 포트 3002", "출발일 2026-10-23"));
        assertThat(messages(Level.WARN)).isEmpty();
    }

    @Test
    @DisplayName("서버(PAPER_ENABLED=true·스케줄러 켜짐·로그인 있음): 정기 작업 켜짐, 경고 없음")
    void serverStackWithPaperOn() {
        new PaperStartupLog(paper(true), properties(false), true).logOnStartup();

        assertThat(messages(Level.INFO)).singleElement().satisfies(line -> assertThat(line).contains(
                "모의 매매 정기 작업 켜짐", "PAPER_ENABLED=true", "스케줄러(dashboard.scheduler.enabled)=켜짐", "LOCAL_NO_LOGIN=false"));
        assertThat(messages(Level.WARN)).isEmpty();
    }

    @Test
    @DisplayName("PAPER_ENABLED=true여도 스케줄러가 꺼져 있으면(통합 테스트 설정) 정기 작업 꺼짐 — 돌지 않으니 경고도 없음")
    void schedulerOffMeansNoJobs() {
        new PaperStartupLog(paper(true), properties(true), false).logOnStartup();

        assertThat(messages(Level.INFO)).singleElement().satisfies(line -> assertThat(line).contains(
                "모의 매매 정기 작업 꺼짐", "PAPER_ENABLED=true", "스케줄러(dashboard.scheduler.enabled)=꺼짐"));
        assertThat(messages(Level.WARN)).isEmpty();
    }

    @Test
    @DisplayName("로그인 없는 로컬 스택에서 정기 작업이 켜져 있으면 경고 한 줄 — 두 곳이 동시에 돌면 안 된다(ADR 0019·0020)")
    void warnsWhenLocalStackRunsJobs() {
        new PaperStartupLog(paper(true), properties(true), true).logOnStartup();

        assertThat(messages(Level.INFO)).singleElement().satisfies(line -> assertThat(line).contains("모의 매매 정기 작업 켜짐"));
        assertThat(messages(Level.WARN)).singleElement().satisfies(line -> assertThat(line).contains(
                "LOCAL_NO_LOGIN=true", "AWS 서버 한 곳에만", "PAPER_ENABLED=false를 적고"));
    }

    @Test
    @DisplayName("스케줄러 상태는 SchedulingConfig 빈이 있는지로 본다(프로퍼티를 다시 읽지 않음)")
    void schedulerStateComesFromBeanPresence() {
        DefaultListableBeanFactory without = new DefaultListableBeanFactory();
        new PaperStartupLog(paper(true), properties(false), without.getBeanProvider(SchedulingConfig.class)).logOnStartup();

        DefaultListableBeanFactory with = new DefaultListableBeanFactory();
        with.registerSingleton("schedulingConfig", new SchedulingConfig());
        new PaperStartupLog(paper(true), properties(false), with.getBeanProvider(SchedulingConfig.class)).logOnStartup();

        assertThat(messages(Level.INFO)).hasSize(2);
        assertThat(messages(Level.INFO).get(0)).contains("정기 작업 꺼짐", "스케줄러(dashboard.scheduler.enabled)=꺼짐");
        assertThat(messages(Level.INFO).get(1)).contains("정기 작업 켜짐", "스케줄러(dashboard.scheduler.enabled)=켜짐");
    }

    @Test
    @DisplayName("비밀번호·토큰·이메일·주소는 어느 줄에도 남기지 않는다(공개 저장소, 로그는 컨테이너에 남음)")
    void noSecretsInAnyLine() {
        AppProperties properties = properties(true);
        properties.setPassword("pw-SENTINEL-7f3a");
        properties.setOwnerEmail("owner-sentinel@qa.invalid");
        properties.setCollectorToken("tok-SENTINEL-91bd");
        properties.setDemoViewerToken("demo-SENTINEL-0123456789abcdef0123456789abcdef");
        properties.setMailFrom("mail-sentinel@qa.invalid");
        properties.setPublicUrl("https://public-sentinel.invalid");
        properties.setCollectorUrl("http://collector-sentinel.invalid:8000");
        properties.setFrontendOrigin("http://origin-sentinel.invalid:3002");

        // 경고까지 찍히는 조합으로 두 줄을 모두 본다.
        new PaperStartupLog(paper(true), properties, true).logOnStartup();

        assertThat(appender.list).hasSize(2);
        assertThat(appender.list).allSatisfy(event -> assertThat(event.getFormattedMessage().toLowerCase())
                .doesNotContain("sentinel", "pw-", "tok-", "demo-", "@", "http"));
    }

    @Test
    @DisplayName("값을 읽다 실패해도 기동을 막지 않는다 — 예외 대신 경고 한 줄")
    void neverThrows() {
        PaperStartupLog broken = new PaperStartupLog(paper(true), null, true);

        assertThatCode(broken::logOnStartup).doesNotThrowAnyException();
        assertThat(messages(Level.WARN)).singleElement().satisfies(line -> assertThat(line).contains("기동은 계속합니다"));
    }
}
