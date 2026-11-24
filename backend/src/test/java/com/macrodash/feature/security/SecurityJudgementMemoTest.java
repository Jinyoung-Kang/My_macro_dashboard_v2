package com.macrodash.feature.security;

import com.macrodash.store.SecurityStore;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 판정 기억(QA-991, ADR 0049) — 입력 판({@link SecurityStore#inputVersion})이 그대로면 공지 전부를 다시 읽고 판정하지 않고, 응답은 새로 계산한 것과
 * 한 글자도 다르지 않으며, 판이 바뀌거나 시간 상한이 지나면 다음 호출이 바로 다시 계산합니다. 저장소는 대역이고 공지·버전은 모두 가짜입니다
 * ({@link SecurityServiceTest}의 도우미).
 */
class SecurityJudgementMemoTest {

    private static final SecurityStore.InputVersion V1 = new SecurityStore.InputVersion(true, true, 5, Instant.parse("2026-11-21T01:00:00Z"), 4,
            SecurityServiceTest.COLLECTED.plusSeconds(5), 0L, null);
    private static final SecurityStore.InputVersion V2 = new SecurityStore.InputVersion(true, true, 5, Instant.parse("2026-11-21T02:00:00Z"), 4,
            SecurityServiceTest.COLLECTED.plusSeconds(5), 0L, null);

    private final List<SecurityStore.Notice> notices = new ArrayList<>();
    private final List<SecurityStore.NoticeRow> rows = new ArrayList<>();
    private final AtomicReference<Instant> now = new AtomicReference<>(SecurityServiceTest.NOW);
    private SecurityStore store;

    /** 움직이는 시계 — 시간 상한을 넘겨 봅니다. */
    private final Clock clock = new Clock() {
        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now.get();
        }
    };

    @BeforeEach
    void setUp() {
        notices.add(SecurityServiceTest.notice(9001, "가짜 PostgreSQL 보안 업데이트 권고", "2026-11-20", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(SecurityServiceTest.row(9001, 0, "CVE-2099-1001", "PostgreSQL", "16 이상 16.50 미만", "16.50 이상"));
        rows.add(SecurityServiceTest.row(9001, 1, "CVE-2099-1002, CVE-2099-1003", "PostgreSQL", "15 이상 15.70 미만", "15.70 이상"));
        notices.add(SecurityServiceTest.notice(9002, "가짜 Node.js 보안 업데이트 권고", "2026-11-19", "ok", "product_table",
                List.of("※ 가짜 확장을 켠 설치에서만 영향(가짜 조건 문장)"), "가짜 개요"));
        rows.add(SecurityServiceTest.row(9002, 0, "CVE-2099-2001", "Node.js", "22 이상 22.30 미만", "22.30 이상"));
        notices.add(SecurityServiceTest.notice(9003, "가짜 사무용 제품 보안 업데이트 권고", "2026-11-18", "ok", "product_table", List.of(), "가짜 개요"));
        rows.add(SecurityServiceTest.row(9003, 0, "CVE-2099-3001", "가짜 사무용 제품", "1.0 이상 1.5 미만", "1.5 이상"));
        notices.add(SecurityServiceTest.notice(9004, "가짜 안내 — PostgreSQL 사용자 주의", "2026-11-17", "ok", "no_table", List.of(), "가짜 안내 본문"));
        notices.add(SecurityServiceTest.notice(9005, "가짜 Node.js 취약점 안내", "2026-11-16", "pending", null, List.of(), null));

        store = mock(SecurityStore.class);
        when(store.ready()).thenReturn(true);
        when(store.notices()).thenAnswer(call -> List.copyOf(notices));
        when(store.rows()).thenAnswer(call -> List.copyOf(rows));
        when(store.rows(anyLong())).thenAnswer(call -> rows.stream().filter(r -> r.nttId() == (long) call.getArgument(0)).toList());
        when(store.notice(anyLong())).thenAnswer(call -> notices.stream().filter(n -> n.nttId() == (long) call.getArgument(0)).findFirst());
        when(store.sourceState("kisa_security_notices")).thenReturn(Optional.empty());
        SecurityServiceTest.fakeInventory(store, SecurityServiceTest.COLLECTED);
        when(store.inputVersion()).thenReturn(V1);
    }

    private SecurityService service() {
        return new SecurityService(store, ProductAliases.defaults(), clock);
    }

    @Test
    @DisplayName("판이 그대로면 거르기·쪽·상세가 여럿이어도 공지 전부는 한 번만 읽고, 응답은 매번 새로 계산한 것과 같다")
    void memoMatchesFreshComputation() {
        SecurityService memo = service();
        List<Function<SecurityService, Object>> calls = List.of(
                s -> s.notices(null, null, null, null, null),
                s -> s.notices("affected", null, null, null, null),
                s -> s.notices("check", "CONDITION_NOTE", null, null, null),
                s -> s.notices(null, null, "node", null, null),
                s -> s.notices(null, null, "cve-2099-1002", null, null),
                s -> s.notices(null, null, null, 2, 2),
                s -> s.notices("unrelated", null, null, 1, 100),
                s -> s.notice(9001),
                s -> s.notice(9002),
                s -> s.notice(9004),
                SecurityService::inventory);

        for (Function<SecurityService, Object> call : calls) {
            Object remembered = call.apply(memo);
            Object fresh = call.apply(service());
            assertThat(remembered).isEqualTo(fresh);
        }
        // 기억하는 서비스는 처음 한 번만 읽음 — 나머지 횟수는 새로 만든 서비스들(목록 일곱 번과 상세 셋)의 것.
        verify(store, times(1 + 10)).notices();
    }

    @Test
    @DisplayName("판이 바뀌면 다음 호출이 바로 다시 계산한다 — 공지 제목을 고친 것이 보인다")
    void versionChangeRecomputes() {
        SecurityService memo = service();
        memo.notices(null, null, null, null, null);
        notices.set(2, SecurityServiceTest.notice(9003, "가짜 사무용 제품 보안 업데이트 권고(고침)", "2026-11-18", "ok", "product_table", List.of(),
                "가짜 개요"));

        assertThat(title(memo.notices(null, null, null, null, null), 2)).as("판이 그대로면 기억한 것").doesNotContain("(고침)");
        when(store.inputVersion()).thenReturn(V2);
        assertThat(title(memo.notices(null, null, null, null, null), 2)).endsWith("(고침)");
        verify(store, times(2)).notices();
    }

    @Test
    @DisplayName("판을 모르면(null) 기억하지 않고, 판이 그대로여도 시간 상한이 지나면 다시 계산한다")
    void unknownVersionAndMaxAge() {
        when(store.inputVersion()).thenReturn(null);
        SecurityService memo = service();
        memo.notices(null, null, null, null, null);
        memo.notices(null, null, null, null, null);
        verify(store, times(2)).notices();

        when(store.inputVersion()).thenReturn(V1);
        memo.notices(null, null, null, null, null);
        memo.notices(null, null, null, null, null);
        verify(store, times(3)).notices();
        now.set(SecurityServiceTest.NOW.plus(SecurityService.JUDGEMENT_MAX_AGE));
        memo.notices(null, null, null, null, null);
        verify(store, times(4)).notices();
    }

    @Test
    @DisplayName("알림 작업이 쓰는 판정 한 벌도 같은 기억 — 판을 매번 확인하고, 버전 목록이 없으면 판정 입력은 null")
    void judgementForAlerts() {
        SecurityService memo = service();
        SecurityService.Judgement first = memo.judgement();
        assertThat(memo.judgement()).isSameAs(first);
        verify(store, times(2)).inputVersion();
        assertThat(first.inventory()).isNotNull();
        assertThat(first.judged()).hasSize(5);

        when(store.inventoryReady()).thenReturn(false);
        when(store.inputVersion()).thenReturn(V2);
        assertThat(memo.judgement().inventory()).isNull();
    }

    @SuppressWarnings("unchecked")
    private static String title(Map<String, Object> out, int index) {
        return (String) ((List<Map<String, Object>>) out.get("items")).get(index).get("title");
    }
}
