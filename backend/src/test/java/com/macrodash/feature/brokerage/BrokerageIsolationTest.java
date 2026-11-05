package com.macrodash.feature.brokerage;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * 실제 계좌(ADR 0025, 명세 docs/specs/2026-11-05-toss-account-readonly.md §6)의 소스 검사 — 1단계는 읽기 전용이고 다른 기능과 섞이지 않습니다.
 *
 * <ul>
 *   <li>{@code feature/brokerage}에는 쓰기 매핑(POST·PUT·DELETE·PATCH)이 없습니다. 쓰기를 여는 일은 새 ADR과 승인이 필요하고, 그때 이 시험을
 *       일부러 고칩니다.</li>
 *   <li>수집기 계좌 경로를 부르는 글자({@code tossAccount}·{@code /toss/account})는 {@code CollectorClient}와 {@code feature/brokerage}에만
 *       있습니다 — 모의 장부·패킷·알림 쪽이 계좌 응답을 따로 받아 가지 못하게.</li>
 * </ul>
 */
class BrokerageIsolationTest {

    private static final Path MAIN = Path.of("src", "main", "java", "com", "macrodash");
    private static final String BROKERAGE = "feature/brokerage/";
    private static final String CLIENT = "collector/CollectorClient.java";

    private static final List<String> WRITE_MAPPINGS = List.of("@PostMapping", "@PutMapping", "@DeleteMapping",
            "@PatchMapping", "RequestMethod.POST", "RequestMethod.PUT", "RequestMethod.DELETE", "RequestMethod.PATCH");

    /** main 소스(com/macrodash 아래 상대 경로) → 본문. */
    private static Map<String, String> sources() throws IOException {
        Map<String, String> out = new LinkedHashMap<>();
        try (Stream<Path> files = Files.walk(MAIN)) {
            for (Path file : files.filter(path -> path.toString().endsWith(".java")).sorted().toList()) {
                out.put(MAIN.relativize(file).toString().replace('\\', '/'), Files.readString(file));
            }
        }
        assertThat(out).as("소스를 찾지 못했습니다(작업 디렉터리가 backend여야 합니다)").isNotEmpty();
        return out;
    }

    @Test
    @DisplayName("feature/brokerage에는 쓰기 매핑(POST·PUT·DELETE·PATCH)이 없다 — 1단계는 읽기 전용")
    void brokerageHasNoWriteMappings() throws IOException {
        Map<String, String> brokerage = new LinkedHashMap<>();
        sources().forEach((file, text) -> {
            if (file.startsWith(BROKERAGE)) {
                brokerage.put(file, text);
            }
        });
        assertThat(brokerage).as("검사가 실제로 소스를 읽음").containsKey(BROKERAGE + "BrokerageController.java");
        assertThat(brokerage.get(BROKERAGE + "BrokerageController.java")).contains("@GetMapping");
        brokerage.forEach((file, text) -> WRITE_MAPPINGS.forEach(mapping ->
                assertThat(text).as(file + "의 " + mapping).doesNotContain(mapping)));
    }

    @Test
    @DisplayName("수집기 계좌 경로를 부르는 글자(tossAccount·/toss/account)는 CollectorClient와 feature/brokerage에만 있다")
    void accountCallStaysInBrokerage() throws IOException {
        Map<String, Set<String>> found = new LinkedHashMap<>();
        for (String token : List.of("tossAccount", "/toss/account")) {
            found.put(token, new TreeSet<>());
        }
        sources().forEach((file, text) -> found.forEach((token, files) -> {
            if (text.contains(token)) {
                files.add(file);
            }
        }));
        found.forEach((token, files) -> {
            assertThat(files).as(token + " — 검사가 실제로 소스를 읽음").contains(CLIENT);
            assertThat(files).as(token + "을 담은 main 소스")
                    .allMatch(file -> file.equals(CLIENT) || file.startsWith(BROKERAGE));
        });
        assertThat(found.get("tossAccount")).as("계좌 호출을 부르는 서비스").contains(BROKERAGE + "BrokerageService.java");
    }
}
