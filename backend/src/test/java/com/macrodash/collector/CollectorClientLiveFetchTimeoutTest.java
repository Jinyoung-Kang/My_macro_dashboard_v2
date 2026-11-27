package com.macrodash.collector;

import com.macrodash.config.AppProperties;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

/**
 * 화면이 열 때 수집기가 외부를 부르는 조회는 수집기 예산(10초) + 여유만 기다린다 — 일반 호출의 90초가 아니다.
 *
 * <p>QA-1039: 차트 시계열({@code liveTicker})과 종목 찾기({@code liveSymbols})가 일반 클라이언트(읽기 90초)를 써, 수집기가 응답하지 않으면 요청
 * 스레드가 그만큼 묶였습니다(시세·뉴스·KRX 장중은 QA-993에서 15초). 연결만 받고 아무것도 쓰지 않는 소켓으로 그 상황을 만들고, 화면 조회 한도를 1초로 줄여 끼워
 * 어느 호출이 그 한도를 쓰는지 가립니다. 운영 값(15초 = 수집기 예산 10초 + 여유 5초)은 {@code CollectorClientSearchLogTest}가 봅니다.
 */
class CollectorClientLiveFetchTimeoutTest {

    private static final Duration SHORT = Duration.ofSeconds(1);

    private ServerSocket server;
    private final List<Socket> accepted = new ArrayList<>();

    @BeforeEach
    void startHangingServer() throws IOException {
        server = new ServerSocket(0);
        Thread acceptor = new Thread(() -> {
            try {
                while (!server.isClosed()) {
                    accepted.add(server.accept());   // 받기만 하고 응답하지 않습니다
                }
            } catch (IOException ignored) {
                // 서버를 닫으면 끝납니다
            }
        });
        acceptor.setDaemon(true);
        acceptor.start();
    }

    @AfterEach
    void stop() throws IOException {
        for (Socket socket : accepted) {
            socket.close();
        }
        server.close();
    }

    private CollectorClient client() {
        AppProperties properties = new AppProperties();
        properties.setCollectorUrl("http://127.0.0.1:" + server.getLocalPort());
        properties.setCollectorTimeoutSeconds(90);
        return new CollectorClient(properties, SHORT);
    }

    @Test
    @DisplayName("QA-1039: 차트 시계열 조회는 화면 조회 읽기 한도 안에 포기한다 — 일반 호출의 90초를 기다리지 않는다")
    void liveTickerGivesUpAtLiveFetchTimeout() {
        CollectorClient client = client();
        assertTimeoutPreemptively(Duration.ofSeconds(8), () -> assertThat(client.liveTicker("^TNX", "1y")).isEmpty());
    }

    @Test
    @DisplayName("QA-1039: 종목 찾기도 같은 한도를 쓴다")
    void liveSymbolsGivesUpAtLiveFetchTimeout() {
        CollectorClient client = client();
        assertTimeoutPreemptively(Duration.ofSeconds(8), () -> assertThat(client.liveSymbols("NVDA")).isEmpty());
    }

    @Test
    @DisplayName("QA-993: 시세·뉴스·KRX 장중도 같은 한도를 쓴다")
    void otherLiveFetchesShareTheLimit() {
        CollectorClient client = client();
        assertTimeoutPreemptively(Duration.ofSeconds(12), () -> {
            assertThat(client.liveQuote("us", "NVDA")).isEmpty();
            assertThat(client.liveNews("us", "NVDA", null)).isEmpty();
            assertThat(client.daumIntraday(30)).isEmpty();
        });
    }
}
