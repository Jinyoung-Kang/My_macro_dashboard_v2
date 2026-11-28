package com.macrodash.feature.security;

import com.macrodash.store.SecurityAckStore;
import com.macrodash.store.SecurityStore;
import com.macrodash.web.ApiExceptionHandler;
import com.macrodash.support.InvalidRequestException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.server.ResponseStatusException;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 보안 공지의 '확인함' 표시(ADR 0046 덧붙임 2026-11-28) — 판정 위에 얹는 기록입니다. 확인 필요 공지만 확인할 수 있고, 확인할 때의 판정·사유가 지금과
 * 같을 때만 유효하며, 건수·거르기가 남은 것과 확인한 것을 나눕니다. 저장소 둘은 대역이고 값은 모두 가짜입니다(버전 목록 없음 → 제품이 맞는 공지는
 * 확인 필요·NO_INVENTORY, 제품이 맞지 않는 공지는 무관).
 */
class SecurityAckTest {

    private static final Instant NOW = SecurityServiceTest.NOW;

    private final Map<Long, SecurityAckStore.Ack> saved = new LinkedHashMap<>();
    private SecurityService service;

    @BeforeEach
    void setUp() {
        SecurityStore store = mock(SecurityStore.class);
        when(store.ready()).thenReturn(true);
        when(store.inventoryReady()).thenReturn(true);
        when(store.inventory()).thenReturn(Optional.empty());
        SecurityStore.Notice pg = SecurityServiceTest.notice(9001, "가짜 PostgreSQL 보안 업데이트 권고", "2026-11-20", "ok",
                "product_table", List.of(), "가짜 개요");
        SecurityStore.Notice other = SecurityServiceTest.notice(9002, "가짜 장비 보안 업데이트 권고", "2026-11-19", "ok",
                "product_table", List.of(), "가짜 개요");
        SecurityStore.NoticeRow pgRow = SecurityServiceTest.row(9001, 0, "CVE-2099-1001", "PostgreSQL", "16 이상 16.50 미만", "16.50 이상");
        SecurityStore.NoticeRow otherRow = SecurityServiceTest.row(9002, 0, "CVE-2099-1002", "FakeGate OS", "1.0 미만", "1.0 이상");
        when(store.notices()).thenReturn(List.of(pg, other));
        when(store.rows()).thenReturn(List.of(pgRow, otherRow));
        when(store.notice(anyLong())).thenAnswer(call -> {
            long id = call.getArgument(0);
            return id == 9001L ? Optional.of(pg) : id == 9002L ? Optional.of(other) : Optional.empty();
        });
        when(store.rows(anyLong())).thenAnswer(call -> (long) call.getArgument(0) == 9001L ? List.of(pgRow) : List.of(otherRow));
        when(store.sourceState(any())).thenReturn(Optional.empty());

        SecurityAckStore acks = mock(SecurityAckStore.class);
        when(acks.ready()).thenReturn(true);
        when(acks.all()).thenAnswer(call -> new LinkedHashMap<>(saved));
        doAnswer(call -> {
            SecurityAckStore.Ack ack = call.getArgument(0);
            saved.put(ack.nttId(), ack);
            return null;
        }).when(acks).save(any());
        when(acks.delete(anyLong())).thenAnswer(call -> saved.remove((Long) call.getArgument(0)) != null);
        service = new SecurityService(store, acks, ProductAliases.defaults(), Clock.fixed(NOW, ZoneOffset.UTC));
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> items(Map<String, Object> response) {
        return (List<Map<String, Object>>) response.get("items");
    }

    @Test
    @DisplayName("확인 전에는 ack가 null이고 확인 필요 1건이 모두 남은 것 — 확인하면 그때의 판정·사유와 메모가 남고 건수가 확인한 것으로 옮겨진다")
    void ackMovesCount() {
        Map<String, Object> before = service.notices(null, null, null, null, null, null);
        assertThat(map(before.get("counts"))).containsEntry("check", 1L).containsEntry("checkOpen", 1L).containsEntry("checkAcked", 0L);
        assertThat(items(before)).allSatisfy(item -> assertThat(item.get("ack")).isNull());

        Map<String, Object> detail = map(service.ack(9001, "  가짜 근거 한 줄  ").get("notice"));
        Map<String, Object> ack = map(detail.get("ack"));
        assertThat(ack).containsEntry("ackedAt", "2026-11-21T03:00:00Z").containsEntry("note", "가짜 근거 한 줄")
                .containsEntry("valid", true).containsEntry("verdict", "check").containsEntry("reasons", List.of("NO_INVENTORY"));
        assertThat(detail).as("판정은 그대로").containsEntry("verdict", "check");

        Map<String, Object> after = service.notices(null, null, null, null, null, null);
        assertThat(map(after.get("counts"))).containsEntry("check", 1L).containsEntry("checkOpen", 0L).containsEntry("checkAcked", 1L);
    }

    @Test
    @DisplayName("거르기 ack=open은 유효한 확인이 없는 것만, ack=acked는 있는 것만 — 판정 거르기와 함께 걸리고 허용 밖 값은 400")
    void filterByAck() {
        service.ack(9001, null);
        assertThat(items(service.notices("check", null, "open", null, null, null))).isEmpty();
        assertThat(items(service.notices("check", null, "acked", null, null, null))).extracting(item -> item.get("nttId")).containsExactly(9001L);
        assertThat(items(service.notices(null, null, "open", null, null, null))).extracting(item -> item.get("nttId")).containsExactly(9002L);
        assertThat(map(items(service.notices(null, null, "acked", null, null, null)).get(0).get("ack"))).containsEntry("note", null);
        assertThatThrownBy(() -> service.notices(null, null, "done", null, null, null)).isInstanceOf(InvalidRequestException.class);
    }

    @Test
    @DisplayName("확인한 뒤 사유가 달라지면 그 확인은 무효 — 다시 남은 것으로 세고, 예전 메모와 그때의 사유는 그대로 보인다")
    void staleAckReopens() {
        saved.put(9001L, new SecurityAckStore.Ack(9001, NOW.minusSeconds(86_400), "예전 가짜 메모", "check", "NAME_MATCH"));
        Map<String, Object> list = service.notices("check", null, "open", null, null, null);
        assertThat(map(list.get("counts"))).containsEntry("checkOpen", 1L).containsEntry("checkAcked", 0L);
        Map<String, Object> ack = map(items(list).get(0).get("ack"));
        assertThat(ack).containsEntry("valid", false).containsEntry("note", "예전 가짜 메모").containsEntry("reasons", List.of("NAME_MATCH"));

        // 다시 확인하면 지금의 사유로 새로 적혀 유효해집니다.
        assertThat(map(map(service.ack(9001, null).get("notice")).get("ack"))).containsEntry("valid", true)
                .containsEntry("note", null).containsEntry("reasons", List.of("NO_INVENTORY"));
    }

    @Test
    @DisplayName("확인 필요가 아닌 공지는 확인할 수 없다(409) — 없는 번호 404, 메모 501자는 400이고 아무것도 적지 않는다")
    void rejects() {
        assertThatThrownBy(() -> service.ack(9002, null)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(409));
        assertThatThrownBy(() -> service.ack(1234, null)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
        assertThatThrownBy(() -> service.ack(9001, "가".repeat(501))).isInstanceOf(InvalidRequestException.class);
        assertThat(saved).isEmpty();
        service.ack(9001, "가".repeat(500));
        assertThat(saved).containsKey(9001L);
    }

    @Test
    @DisplayName("확인 취소는 기록을 지우고 다시 남은 것으로 — 기록이 없어도 통과한다")
    void unack() {
        service.ack(9001, "가짜 메모");
        assertThat(map(service.unack(9001).get("notice")).get("ack")).isNull();
        assertThat(map(service.notices(null, null, null, null, null, null).get("counts"))).containsEntry("checkOpen", 1L);
        assertThat(map(service.unack(9001).get("notice")).get("ack")).isNull();
        assertThatThrownBy(() -> service.unack(1234)).isInstanceOfSatisfying(ResponseStatusException.class,
                e -> assertThat(e.getStatusCode().value()).isEqualTo(404));
    }

    @Test
    @DisplayName("경로: 본문 없는 POST도 확인으로 받고, 메모가 있으면 적으며, DELETE는 지운다")
    void routes() throws Exception {
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new SecurityController(service)).setControllerAdvice(new ApiExceptionHandler()).build();
        mvc.perform(post("/api/security/notices/9001/ack")).andExpect(status().isOk())
                .andExpect(jsonPath("$.notice.ack.valid").value(true)).andExpect(jsonPath("$.notice.ack.note").doesNotExist());
        mvc.perform(post("/api/security/notices/9001/ack").contentType(MediaType.APPLICATION_JSON).content("{\"note\":\"가짜 메모\"}"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.notice.ack.note").value("가짜 메모"));
        mvc.perform(post("/api/security/notices/9002/ack")).andExpect(status().isConflict());
        mvc.perform(delete("/api/security/notices/9001/ack")).andExpect(status().isOk()).andExpect(jsonPath("$.notice.ack").doesNotExist());
        mvc.perform(post("/api/security/notices/abc/ack")).andExpect(status().isBadRequest());
    }
}
