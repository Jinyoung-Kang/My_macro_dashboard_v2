/**
 * 버튼을 눌러 서버를 부르는 화면들의 동작 고정 (훅으로 옮기기 전에 먼저 고정).
 *
 *  - 누르면 맞는 주소로 한 번 부르고, 그동안 버튼이 "…중"으로 바뀌며 눌리지 않는다
 *  - 성공하면 결과를, 실패하면 서버가 준 문구를 보여 준다
 *  - AI 리포트는 생성 중 경과 초를 센다
 *  - 저장소 상태의 "다시 실행"은 시작 → 끝날 때까지 확인 → 결과 문구 → 화면 전체 새로고침
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);

const refresh = vi.hoisted(() => ({ reloadAll: vi.fn() }));
vi.mock("@/hooks/useRefreshSignal", () => ({
  useRefreshSignal: () => ({ token: 0, reloadAll: refresh.reloadAll }),
}));

const taskRun = vi.hoisted(() => ({ waitForTaskRun: vi.fn() }));
vi.mock("@/lib/taskRun", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/taskRun")>()),
  waitForTaskRun: taskRun.waitForTaskRun,
}));

import AiReportPage from "../ai/report/page";
import { AiEngineSection } from "../connections/AiEngineSection";
import { TossSection } from "../connections/TossSection";
import StatusPage from "../status/page";

const ENGINES = {
  enabled: true,
  engines: [
    { id: "auto", label: "자동", provider: "auto", model: null, description: "", available: true, unavailableReason: null },
  ],
};

/** useApi가 읽는 저장본(경로별). */
const READS: Record<string, unknown> = {
  "/api/ai/engines": ENGINES,
  "/api/ai/report-types": { types: ["종합 매크로 브리핑", "리스크 점검"] },
  "/api/snapshot/text": { text: "원본", generatedAtKst: "2026-09-30 10:00 KST", chars: 2 },
  "/api/status": {
    readMode: "auto",
    collectorReachable: true,
    taskSummary: [{ task: "macro_collected", speed: "fast", status: "ok", startedAt: null, durationMs: null, detail: null }],
  },
  "/api/status/issues": {
    generatedAt: "", collectorReachable: true, lookbackHours: 24,
    counts: { errors: 0, warnings: 0, recentGroups: 0, missingDatasets: 0 },
    current: [], recent: [], missing: [], text: "",
  },
};

/** 밖에서 끝낼 수 있는 응답. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.apiGet.mockReset();
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) =>
    path in READS ? Promise.resolve(READS[path]) : new Promise(() => {}),
  );
  refresh.reloadAll.mockReset();
  taskRun.waitForTaskRun.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("🤖 AI 엔진 테스트", () => {
  it("누르면 선택한 엔진·프롬프트로 부르고, 그동안 '호출 중…'", async () => {
    const reply = deferred<unknown>();
    api.apiPost.mockReturnValue(reply.promise);
    render(<AiEngineSection />);
    const button = await screen.findByRole("button", { name: "🧪 선택 모델 호출" });

    fireEvent.click(button);

    expect(api.apiPost).toHaveBeenCalledWith(
      "/api/ai/test?engineId=auto&prompt=" +
        encodeURIComponent("한국어로 한 문장만 답하십시오: 지금 연결이 정상인지 알려 주세요."),
    );
    expect((screen.getByRole("button", { name: "호출 중…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => reply.resolve({ status: true, response: "정상입니다", provider: "cerebras", latencyMs: 120, pipelineStep: "직접" }));
    expect(await screen.findByText("정상입니다")).toBeTruthy();
    expect((screen.getByRole("button", { name: "🧪 선택 모델 호출" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("실패하면 서버가 준 문구를 결과 자리에 보여 준다", async () => {
    api.apiPost.mockRejectedValue(new Error("HTTP 502 — 엔진 응답 없음"));
    render(<AiEngineSection />);

    fireEvent.click(await screen.findByRole("button", { name: "🧪 선택 모델 호출" }));

    expect(await screen.findByText("HTTP 502 — 엔진 응답 없음")).toBeTruthy();
  });
});

describe("🔌 토스 연결 테스트", () => {
  it("누른 버튼의 주소로 부르고 받은 JSON을 그대로 보여 준다", async () => {
    api.apiGet.mockResolvedValue({ ok: true, rate: 1385.2 });
    render(<TossSection />);

    fireEvent.click(screen.getByRole("button", { name: "환율 조회 (USD → KRW)" }));

    expect(api.apiGet).toHaveBeenCalledWith("/api/ai/toss/exchange-rate?base=USD&quote=KRW");
    expect(await screen.findByText(/"rate": 1385.2/)).toBeTruthy();
  });

  it("실패하면 서버가 준 문구", async () => {
    api.apiGet.mockRejectedValue(new Error("수집기에 연결하지 못했습니다."));
    render(<TossSection />);

    fireEvent.click(screen.getByRole("button", { name: "지수 시세 조회" }));

    expect(api.apiGet).toHaveBeenCalledWith("/api/ai/toss/indices?symbols=KOSPI%2CKOSDAQ");
    expect(await screen.findByText("수집기에 연결하지 못했습니다.")).toBeTruthy();
  });
});

describe("🤖 AI 리포트", () => {
  it("배포가 엔진을 좁혔으면(AI_ENGINES) 못 쓰는 엔진은 이유를 붙여 막고, 쓸 수 있는 첫 엔진으로 부른다", async () => {
    api.apiGetShared.mockImplementation((path: string) =>
      path === "/api/ai/engines"
        ? Promise.resolve({
            enabled: true,
            engines: [
              { id: "auto", label: "자동", provider: "auto", model: null, description: "", available: false,
                unavailableReason: "not_allowed" },
              { id: "anthropic_haiku", label: "Claude", provider: "anthropic", model: "claude-haiku-5-5", description: "",
                available: true, unavailableReason: null },
              { id: "nvidia_nemotron", label: "Nemotron", provider: "nvidia", model: null, description: "", available: false,
                unavailableReason: "not_allowed" },
              { id: "cerebras_llama", label: "Cerebras", provider: "cerebras", model: null, description: "", available: false,
                unavailableReason: "no_key" },
            ],
          })
        : path in READS ? Promise.resolve(READS[path]) : new Promise(() => {}),
    );
    api.apiPost.mockResolvedValue({ status: true, response: "리포트 본문", reportType: "종합 매크로 브리핑" });
    render(<AiReportPage />);

    const select = (await screen.findByLabelText("AI 엔진")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("anthropic_haiku"));
    const options = Array.from(select.options).map((option) => [option.value, option.textContent, option.disabled]);
    expect(options).toEqual([
      ["auto", "자동 (이 배포에서 사용 안 함)", true],
      ["anthropic_haiku", "Claude", false],
      ["nvidia_nemotron", "Nemotron (이 배포에서 사용 안 함)", true],
      ["cerebras_llama", "Cerebras (키 없음)", true],
    ]);

    fireEvent.click(screen.getByRole("button", { name: "🚀 리포트 생성" }));
    expect(api.apiPost).toHaveBeenCalledWith("/api/ai/report", {
      engineId: "anthropic_haiku", reportType: "종합 매크로 브리핑", extraInstruction: "",
    });
  });

  it("첫 번째 리포트 종류로 부르고, 생성 중에는 경과 초를 센다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const reply = deferred<unknown>();
    api.apiPost.mockReturnValue(reply.promise);
    render(<AiReportPage />);
    const button = await screen.findByRole("button", { name: "🚀 리포트 생성" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);

    expect(api.apiPost).toHaveBeenCalledWith("/api/ai/report", {
      engineId: "auto", reportType: "종합 매크로 브리핑", extraInstruction: "",
    });
    expect((screen.getByRole("button", { name: "생성 중… 0초 경과" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole("button", { name: /생성 중… [23]초 경과/ })).toBeTruthy();

    await act(async () => reply.resolve({ status: true, response: "리포트 본문", reportType: "종합 매크로 브리핑", provider: "cerebras", latencyMs: 1000 }));
    expect(await screen.findByText("리포트 본문")).toBeTruthy();
    expect(screen.getByRole("button", { name: "🚀 리포트 생성" })).toBeTruthy();
  });

  it("실패하면 문구를 보여 주고, 앞서 받은 리포트는 지우지 않는다", async () => {
    api.apiPost.mockResolvedValueOnce({ status: true, response: "첫 리포트", reportType: "종합 매크로 브리핑", provider: "cerebras", latencyMs: 1 });
    api.apiPost.mockRejectedValueOnce(new Error("AI 요청 시간이 지났습니다"));
    render(<AiReportPage />);
    const button = await screen.findByRole("button", { name: "🚀 리포트 생성" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(button);
    expect(await screen.findByText("첫 리포트")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "🚀 리포트 생성" }));

    expect(await screen.findByText("AI 요청 시간이 지났습니다")).toBeTruthy();
    expect(screen.getByText("첫 리포트")).toBeTruthy();
  });
});

describe("🗄️ 저장소 상태 — 태스크 다시 실행", () => {
  it("시작 → 끝날 때까지 확인 → 결과 문구 → 화면 전체 새로고침", async () => {
    api.apiPost.mockResolvedValue({ baselineStartedAt: "2026-09-30T01:00:00Z" });
    api.apiGet.mockResolvedValue({ history: [{ status: "ok" }] });
    taskRun.waitForTaskRun.mockImplementation(async (_baseline, options) => {
      await options.fetchLatest();
      return { status: "ok", detail: "12건 저장" };
    });
    render(<StatusPage />);

    fireEvent.click(await screen.findByRole("button", { name: "다시 실행" }));

    expect(api.apiPost).toHaveBeenCalledWith("/api/status/run/macro_collected");
    // 결과 기호는 글자가 아니라 톤(정상 = 경고·오류 머리말 없이 정상 색 + 장식 아이콘)
    const done = await screen.findByText("macro_collected 완료 — 12건 저장");
    expect((done.parentElement as HTMLElement).className).toContain("text-ok");
    expect((done.parentElement as HTMLElement).querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(taskRun.waitForTaskRun.mock.calls[0][0]).toBe("2026-09-30T01:00:00Z");
    expect(api.apiGet).toHaveBeenCalledWith("/api/status/history?task=macro_collected&limit=1");
    expect(refresh.reloadAll).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "다시 실행" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("데이터 없음(empty)으로 끝나면 주의 톤 — 낭독기는 '주의:'를 먼저 읽는다", async () => {
    api.apiPost.mockResolvedValue({ baselineStartedAt: null });
    taskRun.waitForTaskRun.mockResolvedValue({ status: "empty", detail: "새 행 없음" });
    render(<StatusPage />);

    fireEvent.click(await screen.findByRole("button", { name: "다시 실행" }));

    const done = await screen.findByText("macro_collected 완료 — 새 행 없음");
    expect((done.parentElement as HTMLElement).className).toContain("text-warn");
    expect(done.parentElement?.textContent).toBe("주의: macro_collected 완료 — 새 행 없음");
  });

  it("태스크 표의 결과는 상태 아이콘(이름은 sr-only 글·마우스 설명), 범례는 글 — 기호 글자가 아니다", async () => {
    render(<StatusPage />);

    const row = (await screen.findByText("macro_collected")).closest("tr") as HTMLElement;
    const icon = within(row).getByText("정상");
    expect(icon.className).toContain("sr-only");
    expect(icon.parentElement?.getAttribute("title")).toBe("정상");
    expect(icon.parentElement?.className).toContain("text-ok");
    expect(screen.getByText("데이터 없음(기존 저장본 유지)")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it("확인 시간 안에 안 끝나면 진행 중이라고 알린다", async () => {
    api.apiPost.mockResolvedValue({ baselineStartedAt: null });
    taskRun.waitForTaskRun.mockResolvedValue(null);
    render(<StatusPage />);

    fireEvent.click(await screen.findByRole("button", { name: "다시 실행" }));

    expect(await screen.findByText(/macro_collected이\(가\) 아직 진행 중입니다/)).toBeTruthy();
    expect(taskRun.waitForTaskRun.mock.calls[0][0]).toBeNull();
  });

  it("시작하지 못하면 서버가 준 문구, 새로고침하지 않는다", async () => {
    api.apiPost.mockRejectedValue(new Error("수집기에 닿지 못했습니다"));
    render(<StatusPage />);

    fireEvent.click(await screen.findByRole("button", { name: "다시 실행" }));

    const failed = await screen.findByText("수집기에 닿지 못했습니다");
    expect((failed.parentElement as HTMLElement).className).toContain("text-danger");
    expect(refresh.reloadAll).not.toHaveBeenCalled();
  });
});

describe("🔍 교차 검증", () => {
  it("결과가 없으면(장 시간 등) 서버 안내를, 실패하면 오류 문구를 보여 준다", async () => {
    api.apiPost.mockResolvedValueOnce({ available: false, message: "확인할 수 있는 항목이 없습니다" });
    api.apiPost.mockRejectedValueOnce(new Error("검증 요청 실패 (HTTP 500)"));
    render(<StatusPage />);
    const button = await screen.findByRole("button", { name: "지금 교차 검증 실행" });

    fireEvent.click(button);
    expect(api.apiPost).toHaveBeenCalledWith("/api/verification");
    expect(await screen.findByText("확인할 수 있는 항목이 없습니다")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "지금 교차 검증 실행" }));
    expect(await screen.findByText("검증 요청 실패 (HTTP 500)")).toBeTruthy();
  });
});
