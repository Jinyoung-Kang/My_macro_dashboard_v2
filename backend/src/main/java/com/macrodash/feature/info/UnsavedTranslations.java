package com.macrodash.feature.info;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 저장하지 않는 번역의 메모리 캐시(정보 검색 본문 보기 — ADR 0043). 운영 서버가 누를 때 받은 기사 본문은 어느 표에도 두지 않기로 했고, 그 번역(본문을 옮긴 글)도
 * 같다고 봅니다 — 그래서 번역 표({@code info_translations}) 대신 이 프로세스 메모리에만 둡니다.
 *
 * <ul>
 *   <li>열쇠는 원문 조각의 sha-256(조각 글자는 두지 않음), 값은 한국어 번역과 옮긴 모델.</li>
 *   <li>{@link #TTL} 뒤에 잊고, {@link #LIMIT}조각을 넘으면 오래 안 쓴 것부터 뺍니다(조각 6,000자 × 400 — 한국어 번역 수 MB).</li>
 *   <li>재기동하면 비워집니다(저장하지 않는 결정의 값 — 다시 누르면 다시 번역하고 하루 글자 상한에 다시 셈).</li>
 * </ul>
 */
final class UnsavedTranslations {

    static final Duration TTL = Duration.ofHours(24);
    static final int LIMIT = 400;

    /** 번역 하나 — 한국어와 옮긴 모델, 넣은 시각. */
    record Entry(String ko, String model, Instant at) {
    }

    private final Clock clock;
    private final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>(64, 0.75f, true);

    UnsavedTranslations(Clock clock) {
        this.clock = clock;
    }

    /** 원문 조각 → 열쇠(sha-256 16진). */
    static String key(String part) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(part.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256을 쓸 수 없습니다", e);
        }
    }

    /** 살아 있는 번역 — 열쇠 → 항목(없거나 지난 것은 빠짐). */
    synchronized Map<String, Entry> find(Collection<String> keys) {
        Map<String, Entry> out = new LinkedHashMap<>();
        Instant now = clock.instant();
        for (String key : keys) {
            Entry entry = entries.get(key);
            if (entry == null) {
                continue;
            }
            if (!now.isBefore(entry.at().plus(TTL))) {
                entries.remove(key);
                continue;
            }
            out.put(key, entry);
        }
        return out;
    }

    synchronized void put(String key, String ko, String model) {
        entries.put(key, new Entry(ko, model, clock.instant()));
        while (entries.size() > LIMIT) {
            String eldest = entries.keySet().iterator().next();
            entries.remove(eldest);
        }
    }

    synchronized int size() {
        return entries.size();
    }
}
