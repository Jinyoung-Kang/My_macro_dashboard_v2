package com.macrodash.feature.auth;

import com.macrodash.Kst;
import com.macrodash.store.UsageStore;
import com.macrodash.support.CurrentUser;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Clock;
import java.time.LocalDate;

/**
 * 사용자별 하루 사용량 한도(명세 B7) — 지금은 AI 리포트 하나. 유료 API 비용이 사용자 수만큼 늘지 않게 막습니다.
 *
 * <p>운영자는 한도가 없고(세기는 함), 유료 회원은 하루(KST) {@code dashboard.ai.daily-limit}건, 무료 회원은 쓸 수
 * 없습니다(접근 정책이 이미 막지만 여기서도 0건으로 봅니다).
 *
 * <p>데모 열람(ADR 0013)은 계정이 없어 {@code usage_counters}(users FK)에 쓸 수 없습니다. 대신 방문자 전체가 메모리의
 * 하루(KST) 한도 {@code dashboard.ai.demo-daily-limit}건을 함께 씁니다(ADR 0014) — 백엔드를 다시 띄우면 0부터 셉니다.
 */
@Service
public class UsageService {

    public static final String AI_REPORT = "ai.report";
    /** 검색 상세 화면의 AI 요약(feature.detail) — 하루 한도는 AI 리포트와 같은 값을 따로 셉니다(데모 공용 한도는 쓰지 않음). */
    public static final String AI_DETAIL = "ai.detail";

    /**
     * 이번 요청의 결과. {@code limit}이 null이면 한도 없음.
     *
     * @param shared 데모 열람 방문자 전체가 함께 쓰는 한도인가(사용자 한 명의 한도가 아님)
     */
    public record Quota(boolean allowed, int used, Integer limit, boolean shared) {

        public Quota(boolean allowed, int used, Integer limit) {
            this(allowed, used, limit, false);
        }

        /** 쓰지 못한 호출을 되돌린 뒤의 모습(한 건 덜 씀). */
        public Quota refunded() {
            return new Quota(true, Math.max(0, used - 1), limit, shared);
        }
    }

    private final UsageStore usage;
    private final int aiDailyLimit;
    private final SharedDailyPool demoPool;

    @Autowired
    public UsageService(UsageStore usage,
                        @Value("${dashboard.ai.daily-limit:20}") int aiDailyLimit,
                        @Value("${dashboard.ai.demo-daily-limit:20}") int demoDailyLimit) {
        this(usage, aiDailyLimit, demoDailyLimit, Clock.systemUTC());
    }

    /** 테스트가 시계를 움직여 날짜가 바뀌는 순간을 확인할 때 씁니다. */
    UsageService(UsageStore usage, int aiDailyLimit, int demoDailyLimit, Clock clock) {
        this.usage = usage;
        this.aiDailyLimit = Math.max(0, aiDailyLimit);
        this.demoPool = new SharedDailyPool(Math.max(0, demoDailyLimit), clock);
    }

    /** 한 건을 씁니다. 한도를 넘으면 세지 않고 allowed=false. */
    public Quota consume(CurrentUser user, String kind) {
        if (user.demo()) {
            // 데모 열람은 DB에 쓰지 않습니다(사용자 FK). 공용 한도는 AI 리포트에만 있습니다.
            return AI_REPORT.equals(kind) ? demoPool.consume() : new Quota(false, 0, 0, true);
        }
        LocalDate today = Kst.today();
        if (user.isOwner()) {
            usage.tryIncrement(user.id(), today, kind, Integer.MAX_VALUE);
            return new Quota(true, usage.count(user.id(), today, kind), null);
        }
        int limit = user.isPro() ? aiDailyLimit : 0;
        boolean allowed = limit > 0 && usage.tryIncrement(user.id(), today, kind, limit);
        return new Quota(allowed, usage.count(user.id(), today, kind), limit);
    }

    /** 쓰지 못한 호출(엔진이 모두 실패)은 되돌립니다. */
    public void refund(CurrentUser user, String kind) {
        if (user.demo()) {
            if (AI_REPORT.equals(kind)) {
                demoPool.refund();
            }
            return;
        }
        usage.decrement(user.id(), Kst.today(), kind);
    }

    /** 데모 열람의 오늘 공용 AI 리포트 사용량(쓰지 않고 보기만). 화면이 "하루 N건을 함께 씁니다"를 적을 때 씁니다. */
    public Quota demoQuota() {
        return demoPool.current();
    }

    /**
     * 오늘 사용량을 쓰지 않고 보기만 합니다({@link #consume}과 같은 한도·모양). 엔진을 못 써 한 건도 쓰지 않고 끝난
     * AI 리포트 응답에 붙입니다(QA-133).
     */
    public Quota peek(CurrentUser user, String kind) {
        if (user.demo()) {
            return AI_REPORT.equals(kind) ? demoPool.current() : new Quota(false, 0, 0, true);
        }
        int used = usage.count(user.id(), Kst.today(), kind);
        if (user.isOwner()) {
            return new Quota(true, used, null);
        }
        int limit = user.isPro() ? aiDailyLimit : 0;
        return new Quota(used < limit, used, limit);
    }

    /**
     * 여러 방문자가 함께 쓰는 하루(KST) 한도 — 메모리에만 있습니다.
     *
     * <p>한 프로세스 안에서만 맞습니다(백엔드가 한 대인 데모 배포 전제, ADR 0014). 다시 띄우면 그날 쓴 양을 잊고 0부터
     * 셉니다 — 하루에 최대 한도만큼 더 쓸 수 있다는 뜻이고, 데모의 비용 상한으로는 받아들입니다.
     */
    static final class SharedDailyPool {

        private final int limit;
        private final Clock clock;
        private LocalDate day;
        private int used;

        SharedDailyPool(int limit, Clock clock) {
            this.limit = limit;
            this.clock = clock;
        }

        synchronized Quota consume() {
            roll();
            if (used >= limit) {
                return new Quota(false, used, limit, true);
            }
            used++;
            return new Quota(true, used, limit, true);
        }

        /** 사용자별 한도와 같은 규칙 — 오늘(KST) 센 것을 하나 줄이고, 0 밑으로는 내려가지 않습니다. */
        synchronized void refund() {
            roll();
            if (used > 0) {
                used--;
            }
        }

        synchronized Quota current() {
            roll();
            return new Quota(used < limit, used, limit, true);
        }

        /** 한국 날짜가 바뀌었으면 새로 셉니다. */
        private void roll() {
            LocalDate today = Kst.today(clock);
            if (!today.equals(day)) {
                day = today;
                used = 0;
            }
        }
    }
}
