package com.macrodash.feature.paper;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * 미국 유니버스의 티커 → 종목명 표(텔레그램 알림 — 사용자 요청 2026-11-08). 유니버스가 코드에 고정되어 있어 이름표도 파일 하나({@value #RESOURCE},
 * scripts/gen_us_ticker_names.py가 만듦)입니다. 표에 없거나 파일을 못 읽으면 빈 이름이고 알림에는 티커만 나갑니다.
 */
final class UsTickerNames {

    static final String RESOURCE = "paper/us-ticker-names.json";

    private static final Logger log = LoggerFactory.getLogger(UsTickerNames.class);

    private UsTickerNames() {
    }

    static Map<String, String> load(ObjectMapper mapper) {
        try (InputStream in = new ClassPathResource(RESOURCE).getInputStream()) {
            JsonNode root = mapper.readTree(in);
            Map<String, String> out = new HashMap<>();
            root.properties().forEach(e -> out.put(e.getKey(), e.getValue().asString()));
            return Map.copyOf(out);
        } catch (Exception e) {
            log.warn("미국 종목 이름표를 읽지 못했습니다 — 알림에 티커만 나갑니다: {}", e.toString());
            return Map.of();
        }
    }
}
