package com.macrodash.feature.paper;

import com.macrodash.analytics.NewsEvents;
import com.macrodash.analytics.TradingCalendar;
import com.macrodash.analytics.UsMarketCalendar;
import com.macrodash.store.PaperStore.SettingsRow;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.node.ObjectNode;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Map;

import static com.macrodash.feature.paper.PaperFixtures.MAPPER;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * 정기 결정을 다음 개장 기준으로 내는 판({@link DecisionTiming}, ADR 0039): 결정 순간·기한(평일·금요일·휴장·서머타임·장 시간 변경일), 꺼짐 판정,
 * 설정 검사, 뉴스 창, 패킷 머리 칸, 실행 문맥({@link MarketRun})이 켠 판에서만 그 순간을 쓰는지.
 */
class DecisionTimingTest {

    private static final TradingCalendar US = UsMarketCalendar.CALENDAR;
    private static final KrPaperMarket KR_MARKET = KrPaperMarket.INSTANCE;
    private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
    private static final ZoneId NEW_YORK = ZoneId.of("America/New_York");

    private static Instant kst(String local) {
        return LocalDateTime.parse(local).atZone(SEOUL).toInstant();
    }

    private static Instant et(String local) {
        return LocalDateTime.parse(local).atZone(NEW_YORK).toInstant();
    }

    private static TradingCalendar kr(ObjectNode body) {
        return KR_MARKET.openCalendar(KrFixtures.inputs(body, KrFixtures.holidays(2026, 2027)));
    }

    private static ObjectNode body(Integer us, Integer krMinutes) {
        ObjectNode body = MAPPER.createObjectNode();
        if (us != null) {
            body.put("decisionBeforeOpenMinutes", us);
        }
        if (krMinutes != null) {
            body.putObject("kr").put("decisionBeforeOpenMinutes", krMinutes);
        }
        return body;
    }

    @Test
    @DisplayName("미국 결정 순간 = 다음 거래일 개장 − N분: 평일(다음 날 08:45 ET), 금요일 세션은 월요일, 추수감사절 전날 세션은 금요일(조기 폐장일), "
            + "서머타임이 시작된 주는 KST로 한 시간 이름 — 기한은 결정 순간 + 15분(개장을 넘지 않음)")
    void usDecisionInstant() {
        assertThat(DecisionTiming.decisionInstant(US, LocalDate.of(2026, 11, 9), 45)).isEqualTo(et("2026-11-10T08:45"))
                .isEqualTo(kst("2026-11-10T22:45"));
        assertThat(DecisionTiming.decisionInstant(US, LocalDate.of(2026, 11, 6), 45)).as("금요일 세션 → 월요일").isEqualTo(et("2026-11-09T08:45"));
        assertThat(DecisionTiming.decisionInstant(US, LocalDate.of(2026, 11, 25), 45)).as("추수감사절 전날 → 금요일").isEqualTo(et("2026-11-27T08:45"));
        assertThat(DecisionTiming.decisionInstant(US, LocalDate.of(2026, 3, 6), 45)).as("서머타임 시작 뒤 월요일 — KST 21:45")
                .isEqualTo(et("2026-03-09T08:45")).isEqualTo(kst("2026-03-09T21:45"));
        assertThat(DecisionTiming.deadlineInstant(US, LocalDate.of(2026, 11, 9), 45, false)).isEqualTo(et("2026-11-10T09:00"));
        assertThat(DecisionTiming.deadlineInstant(US, LocalDate.of(2026, 11, 9), 10, false)).as("개장을 넘지 않음").isEqualTo(et("2026-11-10T09:30"));
    }

    @Test
    @DisplayName("한국 결정 순간: 평일은 다음 날 07:00(지금 설정 07:00과 같은 순간), 금요일 세션은 월요일 07:00, 다음 날이 장 시간 변경일(10:00 개장)이면 "
            + "08:00 — 기한은 개장 30분 전, 결정 순간보다 이르면 결정 순간")
    void krDecisionInstant() {
        TradingCalendar calendar = kr(null);
        LocalDate wed = LocalDate.of(2026, 12, 2);
        assertThat(DecisionTiming.decisionInstant(calendar, wed, 120)).isEqualTo(kst("2026-12-03T07:00"))
                .isEqualTo(KR_MARKET.decisionInstant(wed, LocalTime.of(7, 0)));
        LocalDate fri = LocalDate.of(2026, 12, 4);
        assertThat(DecisionTiming.decisionInstant(calendar, fri, 120)).as("금요일 세션 → 월요일").isEqualTo(kst("2026-12-07T07:00"));
        assertThat(KR_MARKET.decisionInstant(fri, LocalTime.of(7, 0))).as("끈 판은 토요일 아침").isEqualTo(kst("2026-12-05T07:00"));
        assertThat(DecisionTiming.deadlineInstant(calendar, fri, 120, true)).isEqualTo(kst("2026-12-07T08:30"));
        assertThat(DecisionTiming.deadlineInstant(calendar, fri, 20, true)).as("기한이 결정 순간보다 이르지 않음").isEqualTo(kst("2026-12-07T08:40"));

        ObjectNode shifted = MAPPER.createObjectNode();
        shifted.putObject("kr").putObject("calendar").putObject("openTimeOverrides").putObject("2026-11-19").put("open", "10:00").put("close", "16:30");
        assertThat(DecisionTiming.decisionInstant(kr(shifted), LocalDate.of(2026, 11, 18), 120)).as("수능일 10:00 개장").isEqualTo(kst("2026-11-19T08:00"));
    }

    @Test
    @DisplayName("꺼짐: 키가 없거나 0·음수·범위 밖(600 넘음)·정수가 아니면 null(끈 판) — 설정 검사는 켠 값이 미국 40분·한국 45분보다 작으면 막고 0은 받음")
    void minutesAndValidation() {
        assertThat(DecisionTiming.minutes(null, false)).isNull();
        assertThat(DecisionTiming.minutes(body(null, null), false)).isNull();
        assertThat(DecisionTiming.minutes(body(0, 0), false)).isNull();
        assertThat(DecisionTiming.minutes(body(0, 0), true)).isNull();
        assertThat(DecisionTiming.minutes(body(45, 120), false)).isEqualTo(45);
        assertThat(DecisionTiming.minutes(body(45, 120), true)).isEqualTo(120);
        assertThat(DecisionTiming.minutes(body(601, -5), false)).isNull();
        assertThat(DecisionTiming.minutes(body(601, -5), true)).isNull();
        ObjectNode text = MAPPER.createObjectNode().put("decisionBeforeOpenMinutes", "45");
        assertThat(DecisionTiming.minutes(text, false)).isNull();

        DecisionTiming.requireValid(body(0, 0));
        DecisionTiming.requireValid(body(40, 45));
        DecisionTiming.requireValid(body(null, null));
        assertThatThrownBy(() -> DecisionTiming.requireValid(body(39, 120))).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("decisionBeforeOpenMinutes(39)").hasMessageContaining("40분 이상");
        assertThatThrownBy(() -> DecisionTiming.requireValid(body(45, 44))).isInstanceOf(InvalidRequestException.class)
                .hasMessageContaining("kr.decisionBeforeOpenMinutes(44)").hasMessageContaining("45분 이상");
    }

    @Test
    @DisplayName("미국 사건 뉴스 창: 끈 판은 예전 그대로(세션 다음 날 decisionTimeKst), 켠 판은 (직전 세션의 결정 순간, 이 세션의 결정 순간] — 금요일 세션은 "
            + "금요일 08:45 ET ~ 월요일 08:45 ET(주말 뉴스 포함)")
    void usNewsWindow() {
        LocalDate fri = LocalDate.of(2026, 11, 6);
        ObjectNode off = MAPPER.createObjectNode().put("decisionTimeKst", "07:30");
        assertThat(DecisionTiming.usNewsWindow(fri, off)).isEqualTo(NewsEvents.window(fri, LocalTime.of(7, 30)));
        ObjectNode on = off.deepCopy().put("decisionBeforeOpenMinutes", 45);
        NewsEvents.Window window = DecisionTiming.usNewsWindow(fri, on);
        assertThat(window.from()).isEqualTo(et("2026-11-06T08:45"));
        assertThat(window.to()).isEqualTo(et("2026-11-09T08:45"));
    }

    @Test
    @DisplayName("패킷 머리의 decisionAt: 끈 판은 null(칸 없음 — 고정본 그대로), 켠 판은 방식·분·다음 개장·결정 순간(KST)·설명")
    void basisView() {
        LocalDate fri = LocalDate.of(2026, 11, 6);
        assertThat(DecisionTiming.basisView(US, fri, body(0, 0), false)).isNull();
        Map<String, Object> view = DecisionTiming.basisView(US, fri, body(45, 0), false);
        assertThat(view).containsEntry("mode", "BEFORE_NEXT_OPEN").containsEntry("minutesBeforeOpen", 45)
                .containsEntry("nextOpenKst", com.macrodash.Kst.stamp(et("2026-11-09T09:30")))
                .containsEntry("decisionAtKst", com.macrodash.Kst.stamp(et("2026-11-09T08:45")))
                .containsEntry("note", DecisionTiming.NOTE);
        assertThat(DecisionTiming.basisView(kr(null), LocalDate.of(2026, 12, 4), body(45, 120), true))
                .containsEntry("decisionAtKst", com.macrodash.Kst.stamp(kst("2026-12-07T07:00")));
    }

    @Test
    @DisplayName("실행 문맥: 끈 판은 시장 묶음의 계산 그대로(KST 시각), 켠 판은 결정 순간·기한이 다음 개장 기준 — 결정 작업·한국 결정 창이 같은 순간을 본다")
    void marketRunFollowsTheSwitch() {
        LocalDate fri = LocalDate.of(2026, 11, 6);
        LocalTime time = LocalTime.of(7, 30);
        LocalTime deadline = LocalTime.of(12, 0);
        MarketRun off = new MarketRun(UsPaperMarket.INSTANCE, US, new SettingsRow(1, body(0, 0), Instant.EPOCH));
        assertThat(off.decisionInstant(fri, time)).isEqualTo(kst("2026-11-07T07:30"));
        assertThat(off.deadlineInstant(fri, time, deadline)).isEqualTo(kst("2026-11-07T12:00"));
        MarketRun on = new MarketRun(UsPaperMarket.INSTANCE, US, new SettingsRow(2, body(45, 0), Instant.EPOCH));
        assertThat(on.decisionInstant(fri, time)).isEqualTo(et("2026-11-09T08:45"));
        assertThat(on.deadlineInstant(fri, time, deadline)).isEqualTo(et("2026-11-09T09:00"));

        LocalDate krFri = LocalDate.of(2026, 12, 4);
        ObjectNode krBody = body(45, 120);
        ((ObjectNode) krBody.get("kr")).put("decisionTimeKst", "07:00").put("decisionDeadlineKst", "07:45");
        MarketRun krOn = new MarketRun(KR_MARKET, kr(krBody), new SettingsRow(3, krBody, Instant.EPOCH));
        KrPaperMarket.DecisionWindow window = KrPaperMarket.decisionWindow(krOn, krBody, krFri);
        assertThat(window.opens()).isEqualTo(kst("2026-12-07T07:00"));
        assertThat(window.deadline()).isEqualTo(kst("2026-12-07T08:30"));
        ObjectNode krOffBody = krBody.deepCopy();
        ((ObjectNode) krOffBody.get("kr")).put("decisionBeforeOpenMinutes", 0);
        MarketRun krOff = new MarketRun(KR_MARKET, kr(krOffBody), new SettingsRow(4, krOffBody, Instant.EPOCH));
        KrPaperMarket.DecisionWindow old = KrPaperMarket.decisionWindow(krOff, krOffBody, krFri);
        assertThat(old.opens()).isEqualTo(kst("2026-12-05T07:00"));
        assertThat(old.deadline()).isEqualTo(kst("2026-12-05T07:45"));
    }
}
