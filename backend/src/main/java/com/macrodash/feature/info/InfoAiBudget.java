package com.macrodash.feature.info;

import com.macrodash.Kst;
import com.macrodash.store.TranslationStore;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;

/**
 * 정보 화면 AI 호출의 KST 하루 글자 상한 — 번역(ADR 0037)과 정보 검색 AI 요약(계약 §9-6)이 같은 상한({@code dashboard.info.translate.daily-chars})을
 * 함께 씁니다.
 *
 * <ul>
 *   <li>오늘 쓴 양 = 번역 표({@code info_translations})에 오늘 남은 원문 글자 수 + 표에 남지 않는 몫(요약과 저장하지 않는 본문 번역 —
 *       {@link InfoTranslator#bodyUnsaved})이 오늘 보낸 글자 수(이 프로세스 메모리).</li>
 *   <li>요약은 결과를 표에 두지 않습니다(6시간 메모리 캐시) — 그래서 보낸 글자 수를 여기서 셉니다. 재기동하면 요약 몫은 0부터입니다(번역 몫은 표라 그대로) —
 *       알고 남긴 한계(요약 한 번이 약 3만 자이고 6시간 캐시·한 번에 하나라, 재기동 한 번에 더 나갈 수 있는 양은 그날 요약이 쓴 양까지).</li>
 *   <li>두 방향 모두 이 셈을 씁니다 — 요약도 번역({@link InfoTranslator})도 부르기 전에 {@link #reserve}로 검사와 세기를 한 번에 합니다(QA-1021).
 *       저장하는 번역은 번역 표에 남은 글자만큼을 {@link #release}로 돌려주고(표가 세므로 두 번 세지 않게), 모델에 보냈지만 표에 남지 않은 몫
 *       (형식 밖 응답·시간 초과·응답에서 빠진 제목)은 여기 남습니다 — 재기동하면 0부터인 것은 요약 몫과 같습니다. 정보 화면의 오늘 쓴 양은
 *       {@link #usedToday()}.</li>
 * </ul>
 */
@Component
public class InfoAiBudget {

    private final TranslationStore store;
    private final long dailyChars;
    private final Clock clock;
    /** 표에 남지 않는 사용량(요약·저장하지 않는 본문 번역)의 날과 글자 수 — {@code this}로 잠가 고칩니다. */
    private LocalDate untrackedDay;
    private long untrackedChars;

    @Autowired
    public InfoAiBudget(TranslationStore store, @Value("${dashboard.info.translate.daily-chars:1500000}") long dailyChars) {
        this(store, dailyChars, Clock.systemUTC());
    }

    public InfoAiBudget(TranslationStore store, long dailyChars, Clock clock) {
        this.store = store;
        this.dailyChars = dailyChars;
        this.clock = clock;
    }

    public long dailyChars() {
        return dailyChars;
    }

    /** 오늘(KST) 쓴 글자 수 — 번역 표(표가 없으면 0) + 요약. */
    public long usedToday() {
        Instant dayStart = Kst.today(clock).atStartOfDay(Kst.ZONE).toInstant();
        long translated = store.ready() ? store.charsSince(dayStart) : 0L;
        return translated + untrackedToday();
    }

    /**
     * 표에 남지 않는 호출(요약)이 {@code chars}자를 쓰려 합니다 — 오늘 쓴 양에 더해 상한을 넘으면 안내 글을 돌려주고 세지 않으며, 넘지 않으면 null을
     * 돌려주고 바로 셉니다(검사와 세기를 한 번에 — 요약끼리 함께 넘지 않게). 모델을 하나도 부르지 않았으면 {@link #release}로 돌려줍니다.
     * 안내 글은 사유 본문만입니다 — 화면이 앞에 '요약하지 못했습니다 — '를 붙임(QA-428).
     */
    public String reserve(int chars) {
        return reserve(chars, used -> "오늘 AI 글자 상한(번역과 함께 원문 %,d자)에 닿았습니다(오늘 %,d자 씀) — 내일(KST) 다시 됩니다"
                .formatted(dailyChars, used));
    }

    /**
     * {@link #reserve(int)}와 같되 상한을 넘었을 때의 안내 글을 부르는 쪽이 정합니다({@code refusal} — 오늘 쓴 글자 수를 받음). 저장하는 번역
     * ({@link InfoTranslator#titles}·{@link InfoTranslator#body})이 예전 문구를 그대로 쓰려고 둡니다(QA-1021).
     */
    public synchronized String reserve(int chars, java.util.function.LongFunction<String> refusal) {
        long used = usedToday();
        if (used + chars > dailyChars) {
            return refusal.apply(used);
        }
        untrackedChars = untrackedToday() + chars;
        untrackedDay = Kst.today(clock);
        return null;
    }

    /** {@link #reserve}로 센 글자를 돌려줍니다(모델에 보내지 않았거나, 번역 표에 남아 표가 세게 됐을 때). 날이 바뀌었으면 할 일이 없습니다. */
    public synchronized void release(int chars) {
        if (Kst.today(clock).equals(untrackedDay)) {
            untrackedChars = Math.max(0L, untrackedChars - chars);
        }
    }

    /** 상한이 다시 차는 때(다음 KST 자정)까지. */
    public Duration untilReset() {
        Instant next = Kst.today(clock).plusDays(1).atStartOfDay(Kst.ZONE).toInstant();
        return Duration.between(clock.instant(), next);
    }

    private synchronized long untrackedToday() {
        return Kst.today(clock).equals(untrackedDay) ? untrackedChars : 0L;
    }
}
