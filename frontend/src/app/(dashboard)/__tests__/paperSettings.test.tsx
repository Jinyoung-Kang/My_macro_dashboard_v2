/**
 * 🧪 모의 매매 — 설정 탭(명세 S1~S3). 서버 값을 그대로 보이고, 형·범위는 서버가 검사한다.
 *
 *  - GET /api/paper/settings의 keys 순서대로 키마다 지금 값·기본값·범위·설명·규칙 책 영향 배지, GET /api/paper/settings/history는 표
 *  - 값을 바꾸면 "바꿀 값"에 모이고, 저장은 POST /api/paper/settings에 바꾼 키만(`{"키": 값}`, 키는 점 경로)
 *  - 규칙 책 영향 키가 있으면 저장 전에 확인 창(ConfirmDialog)에서 경고와 함께 한 번 더 묻고, 저장 뒤 서버 warning을 경고로 그대로 —
 *    창은 저장이 끝난 뒤(성공·실패 모두) 닫히고, 실패면 서버 400 문구가 경고로 남는다
 *  - 숫자가 아니면 저장 버튼이 막히고, 서버 400 문구는 경고로 그대로. 성공하면 설정·이력을 다시 읽고 입력을 비운다
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 객체를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));
vi.mock("@/components/charts", () => ({
  SERIES_COLORS: { blue: "#3987e5", orange: "#d95926", green: "#199e70" },
  MultiLineSeries: () => null,
}));

import PaperPage from "@/components/screens/paper/PaperScreen";

const WARNING = "규칙 계좌는 동결된 대조군입니다 — 이 변경은 실험 조건을 바꿉니다";
const KR_WARNING = "한국 규칙 계좌(kr_rules)는 동결된 대조군입니다 — 이 변경은 한국 책의 실험 조건을 바꿉니다";

const SETTINGS = {
  available: true,
  version: 3,
  body: {
    model: "claude-sonnet-5-5",
    slippageBp: 5,
    parkCashInShy: true,
    cashLikeTickers: ["SHY"],
    trackRecord: { windowYears: 5 },
  },
  defaults: {
    model: "claude-sonnet-5-5",
    slippageBp: 5,
    parkCashInShy: true,
    cashLikeTickers: ["SHY"],
    trackRecord: { windowYears: 7 },
  },
  keys: [
    {
      key: "model", type: "string", min: null, max: null, affectsRules: false, description: "Claude 계좌·제안 모델",
      options: ["claude-sonnet-5-5", "claude-haiku-5-5"],
    },
    { key: "slippageBp", type: "number", min: 0, max: 100, affectsRules: false, description: "체결가에 얹는 슬리피지(bp)" },
    { key: "parkCashInShy", type: "boolean", min: null, max: null, affectsRules: true, description: "남는 현금을 SHY에" },
    { key: "cashLikeTickers", type: "list", min: null, max: null, affectsRules: false, description: null },
    { key: "trackRecord.windowYears", type: "integer", min: 3, max: 10, affectsRules: true, description: "트랙레코드 창(년)" },
  ],
};

const HISTORY = {
  available: true,
  history: [
    { version: 3, changedKeys: ["trackRecord.windowYears"], createdAtKst: "2026-10-25 10:02", body: { trackRecord: { windowYears: 5 } } },
    { version: 2, changedKeys: ["slippageBp"], createdAtKst: "2026-10-24 21:00" },
    { version: 1, changedKeys: [], createdAtKst: "2026-10-24 09:00" },
  ],
};

const OVERVIEW = {
  available: true, initialized: true, startDate: "2026-10-23", limits: [], jobs: [], pendingBackfill: [], books: [],
  navSeries: { dates: [], books: {} }, quotes: null, selection: null, gate: null,
};

/** 경로 앞부분 → 응답. 없는 경로는 끝나지 않는 요청. 긴 경로부터 맞춥니다. */
let reads: Record<string, () => Promise<unknown>> = {};
let settingsReads = 0;
let historyReads = 0;

beforeEach(() => {
  settingsReads = 0;
  historyReads = 0;
  reads = {
    "/api/paper/overview": () => Promise.resolve(OVERVIEW),
    "/api/paper/settings": () => {
      settingsReads += 1;
      return Promise.resolve(SETTINGS);
    },
    "/api/paper/settings/history": () => {
      historyReads += 1;
      return Promise.resolve(HISTORY);
    },
  };
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).sort((a, b) => b.length - a.length).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

async function openSettingsTab() {
  render(<PaperPage />);
  fireEvent.click(await screen.findByRole("tab", { name: "설정" }));
  await screen.findByLabelText("slippageBp");
}

const changes = () => within(screen.getByRole("region", { name: "바꿀 값" })).queryAllByRole("listitem").map((li) => li.textContent);
const saveButton = () => screen.getByRole("button", { name: "설정 저장" }) as HTMLButtonElement;

describe("설정 탭", () => {
  it("회귀(B-SET-UI-1): 설정 행에 없는 news.* 키는 기본값으로 그린다 — 켜진 체크 상자, 기본 사전이 든 입력, '설정 행에 없음' 표기", async () => {
    reads["/api/paper/settings"] = () => Promise.resolve({
      ...SETTINGS,
      defaults: { ...SETTINGS.defaults, news: { enabled: true, keywords: ["Fed", "rate decision"] } },
      keys: [
        ...SETTINGS.keys,
        { key: "news.enabled", type: "boolean", min: null, max: null, affectsRules: false, description: "사건 섹션" },
        { key: "news.keywords", type: "phrases", min: null, max: null, affectsRules: false, description: "키워드" },
      ],
    });
    await openSettingsTab();

    const enabled = screen.getByLabelText("news.enabled") as HTMLInputElement;
    expect(enabled.checked).toBe(true);
    const field = enabled.closest("div.grid") as HTMLElement;
    expect(within(field).getByText("설정 행에 없음 — 기본값으로 읽음 · 기본 예")).toBeTruthy();
    expect(within(field).queryByText(/기본값과 다름/)).toBeNull();
    expect((screen.getByLabelText("news.keywords") as HTMLTextAreaElement).value).toBe("Fed, rate decision");
    expect(saveButton().disabled).toBe(true);

    // 끄려고 한 번 누르면 false가 바뀐 값으로 잡힙니다(예전에는 체크가 풀린 채로 보여 오히려 true가 저장됨).
    fireEvent.click(enabled);
    expect(changes()).toEqual(["news.enabled: 예 (설정 행에 없음 — 기본값으로 읽음) → 아니오"]);
  });

  it("한국 키(2단계 C1b) — 날짜는 yyyy-MM-dd 글자 상자, 장 시간 변경일은 한 줄에 한 날짜인 여러 줄 상자, 한국 규칙 계좌 배지·확인 문구는 한국 문장", async () => {
    const kr = { slippageBp: 5, tax: { effectiveFrom: "2026-01-01" }, calendar: { openTimeOverrides: {} } };
    reads["/api/paper/settings"] = () => Promise.resolve({
      ...SETTINGS,
      body: { ...SETTINGS.body, kr },
      defaults: { ...SETTINGS.defaults, kr },
      keys: [
        ...SETTINGS.keys,
        { key: "kr.slippageBp", type: "number", min: 0, max: 100, affectsRules: true, market: "KR", description: "한국 슬리피지(bp)" },
        { key: "kr.tax.effectiveFrom", type: "date", min: null, max: null, affectsRules: true, market: "KR", description: "세율 시행일" },
        {
          key: "kr.calendar.openTimeOverrides", type: "dateTimeMap", min: null, max: null, affectsRules: false, market: "KR",
          description: "장 시간 변경일",
        },
      ],
    });
    api.apiPost.mockResolvedValue({ version: 4, changedKeys: ["kr.slippageBp", "kr.calendar.openTimeOverrides"], warning: KR_WARNING });
    await openSettingsTab();

    expect(screen.getByText("한국 책 — 비용 · 장부 · 검증기 · 규칙 계좌 · 결정 시각(kr.*)")).toBeTruthy();
    expect(screen.getByText("한국 책 — 거래일 달력(임시휴장 · 장 시간 변경일)")).toBeTruthy();
    const date = screen.getByLabelText("kr.tax.effectiveFrom") as HTMLInputElement;
    expect(date.value).toBe("2026-01-01");
    expect(date.placeholder).toBe("yyyy-MM-dd");
    const overrides = screen.getByLabelText("kr.calendar.openTimeOverrides") as HTMLTextAreaElement;
    expect(overrides.tagName).toBe("TEXTAREA");
    expect(overrides.value).toBe("");
    expect(within(overrides.closest("div.grid") as HTMLElement).getByText(/한 줄에 날짜 하나/)).toBeTruthy();
    const slippage = screen.getByLabelText("kr.slippageBp") as HTMLInputElement;
    expect(within(slippage.closest("div.grid") as HTMLElement).getByText("한국 규칙 계좌 영향")).toBeTruthy();

    fireEvent.change(slippage, { target: { value: "7" } });
    fireEvent.change(overrides, { target: { value: "2026-11-19 10:00~16:30" } });
    expect(changes()).toEqual([
      "kr.slippageBp: 5 → 7한국 규칙 계좌 영향",
      "kr.calendar.openTimeOverrides: (없음) → 2026-11-19 10:00~16:30",
    ]);

    fireEvent.click(saveButton());
    expect(api.apiPost).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "규칙 계좌 영향 설정 저장" });
    const confirm = within(dialog).getByText(/바꾸는 규칙 계좌 영향 키: kr\.slippageBp\./);
    expect(confirm.textContent).toContain(KR_WARNING);
    expect(confirm.textContent).not.toContain(WARNING);
    fireEvent.click(within(dialog).getByRole("button", { name: "저장 확인" }));

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/settings", {
      "kr.slippageBp": 7, "kr.calendar.openTimeOverrides": { "2026-11-19": { open: "10:00", close: "16:30" } },
    });
    expect((await screen.findByText(KR_WARNING)).className).toContain("text-warn");
  });

  it("키마다 지금 값·기본값·범위·설명·규칙 책 영향 배지, 바꾼 기록 표 — 자리 문구는 없다", async () => {
    await openSettingsTab();

    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/settings", 0);
    expect(api.apiGetShared).toHaveBeenCalledWith("/api/paper/settings/history", 0);
    expect(screen.queryByText(/탭은 다음 단계에서 엽니다/)).toBeNull();
    expect(screen.getByText(/지금 설정 v3/)).toBeTruthy();

    const window = screen.getByLabelText("trackRecord.windowYears") as HTMLInputElement;
    expect(window.value).toBe("5");
    const field = window.closest("div.grid") as HTMLElement;
    expect(within(field).getByText("규칙 계좌 영향")).toBeTruthy();
    expect(within(field).getByText("트랙레코드 창(년)")).toBeTruthy();
    expect(within(field).getByText("기본 7 · 범위 3~10 · 기본값과 다름")).toBeTruthy();

    expect((screen.getByLabelText("model") as HTMLSelectElement).value).toBe("claude-sonnet-5-5");
    expect((screen.getByLabelText("parkCashInShy") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("cashLikeTickers") as HTMLTextAreaElement).value).toBe("SHY");
    // 바꾼 값이 없으면 저장할 수 없습니다.
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByText(/아직 바꾼 값이 없습니다/)).toBeTruthy();

    // 이력 — 서버 순서 그대로, 그 버전의 값과 함께, 처음 버전은 '처음 값'
    const history = (await screen.findByText("v3")).closest("table") as HTMLElement;
    const rows = within(history).getAllByRole("row").slice(1).map((tr) => within(tr).getAllByRole("cell").map((td) => td.textContent));
    expect(rows).toEqual([
      ["v3", "2026-10-25 10:02", "trackRecord.windowYears = 5", "규칙 계좌 영향"],
      ["v2", "2026-10-24 21:00", "slippageBp", "—"],
      ["v1", "2026-10-24 09:00", "처음 값(초기화)", "—"],
    ]);
  });

  it("규칙 책에 영향 없는 키는 바로 저장 — 바꾼 키만 POST, 결과, 설정·이력 다시 읽고 입력을 비운다", async () => {
    api.apiPost.mockResolvedValue({ version: 4, changedKeys: ["slippageBp", "model"], warning: null });
    await openSettingsTab();

    fireEvent.change(screen.getByLabelText("slippageBp"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("model"), { target: { value: "claude-haiku-5-5" } });
    expect(changes()).toEqual(["model: claude-sonnet-5-5 → claude-haiku-5-5", "slippageBp: 5 → 10"]);
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/settings", { model: "claude-haiku-5-5", slippageBp: 10 });
    expect(await screen.findByText(
      "설정 v4(으)로 저장했습니다 — 바뀐 키 slippageBp, model. 재기동 없이 다음 작업부터 씁니다.",
    )).toBeTruthy();
    await waitFor(() => expect(settingsReads).toBeGreaterThanOrEqual(2));
    expect(historyReads).toBeGreaterThanOrEqual(2);
    // 입력을 비워 다시 읽은 지금 값을 보입니다.
    expect((screen.getByLabelText("slippageBp") as HTMLInputElement).value).toBe("5");
    expect(changes()).toEqual([]);
  });

  it("규칙 책 영향 키는 저장 전에 경고와 함께 한 번 더 묻고, 저장 뒤 서버 경고를 그대로 보인다", async () => {
    api.apiPost.mockResolvedValue({ version: 4, changedKeys: ["trackRecord.windowYears", "parkCashInShy"], warning: WARNING });
    await openSettingsTab();

    fireEvent.change(screen.getByLabelText("trackRecord.windowYears"), { target: { value: "6" } });
    fireEvent.click(screen.getByLabelText("parkCashInShy"));
    expect(changes()).toEqual(["parkCashInShy: 예 → 아니오규칙 계좌 영향", "trackRecord.windowYears: 5 → 6규칙 계좌 영향"]);

    // 첫 누름은 확인 창만 엽니다 — 아직 서버를 부르지 않습니다.
    fireEvent.click(saveButton());
    expect(api.apiPost).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "규칙 계좌 영향 설정 저장" });
    const confirm = within(dialog).getByText(/바꾸는 규칙 계좌 영향 키: parkCashInShy, trackRecord\.windowYears/);
    expect(confirm.textContent).toContain(WARNING);
    expect(confirm.className).toContain("text-warn");

    // 취소하면 처음으로, 값은 그대로
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.queryByText(/바꾸는 규칙 계좌 영향 키/)).toBeNull();
    expect(changes()).toHaveLength(2);

    fireEvent.click(saveButton());
    fireEvent.click(screen.getByRole("button", { name: "저장 확인" }));

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/settings", { parkCashInShy: false, "trackRecord.windowYears": 6 });
    const warning = await screen.findByText(WARNING);
    expect(warning.className).toContain("text-warn");
    expect(screen.getByText(/설정 v4\(으\)로 저장했습니다/)).toBeTruthy();
    // 저장이 끝나면 확인 창은 닫힙니다.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("확인 창에서 저장에 성공하면 초점은 저장 결과로 — 막힌 '설정 저장' 단추로 돌아가지 못해 문서 처음(body)으로 떨어지지 않는다", async () => {
    api.apiPost.mockResolvedValue({ version: 4, changedKeys: ["trackRecord.windowYears"], warning: WARNING });
    await openSettingsTab();

    fireEvent.change(screen.getByLabelText("trackRecord.windowYears"), { target: { value: "6" } });
    // 키보드로 '설정 저장'에 간 사람 — 확인 창은 닫힌 뒤 이 단추로 초점을 돌려주려 합니다.
    saveButton().focus();
    fireEvent.click(saveButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "저장 확인" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 바꿀 값이 비어 단추는 막혔습니다 — 그래서 초점은 결과(성공 문구 + 서버 경고)로 옮깁니다.
    expect(saveButton().disabled).toBe(true);
    await waitFor(() => expect(document.activeElement?.textContent).toContain("설정 v4(으)로 저장했습니다"));
    // 확인 창이 늦게(다음 틱) 초점을 돌려주는 처리가 지나간 뒤에도 그대로입니다.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.textContent).toContain(WARNING);
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
  });

  it("규칙 책 영향 키 저장이 실패하면(서버 400) 확인 창을 닫고 서버 문구를 경고로, 입력은 그대로", async () => {
    const message = "trackRecord.windowYears: 범위 3~10 밖입니다(받은 값 12)";
    api.apiPost.mockRejectedValue(new Error(message));
    await openSettingsTab();

    fireEvent.change(screen.getByLabelText("trackRecord.windowYears"), { target: { value: "12" } });
    saveButton().focus();
    fireEvent.click(saveButton());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "저장 확인" }));

    const warning = await screen.findByText(message);
    expect(warning.className).toContain("text-warn");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 실패하면 단추가 살아 있어 확인 창이 연 단추로 초점을 돌려줍니다.
    await waitFor(() => expect(document.activeElement).toBe(saveButton()));
    expect((screen.getByLabelText("trackRecord.windowYears") as HTMLInputElement).value).toBe("12");
    // 다시 저장하려면 확인을 한 번 더 거칩니다.
    fireEvent.click(saveButton());
    expect(screen.getByRole("dialog", { name: "규칙 계좌 영향 설정 저장" })).toBeTruthy();
    expect(api.apiPost).toHaveBeenCalledTimes(1);
  });

  it("확인을 연 뒤 값을 또 바꾸면 확인을 닫는다 — 확인한 내용과 저장할 내용이 달라지지 않게", async () => {
    await openSettingsTab();
    fireEvent.change(screen.getByLabelText("trackRecord.windowYears"), { target: { value: "6" } });
    fireEvent.click(saveButton());
    expect(screen.getByRole("button", { name: "저장 확인" })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("trackRecord.windowYears"), { target: { value: "8" } });
    expect(screen.queryByRole("button", { name: "저장 확인" })).toBeNull();
    expect(changes()).toEqual(["trackRecord.windowYears: 5 → 8규칙 계좌 영향"]);
  });

  it("숫자가 아니면 그 키 아래 문구와 함께 저장이 막히고, 서버 400 문구는 경고로 그대로", async () => {
    const message = "slippageBp: 범위 0~100 밖입니다(받은 값 500)";
    api.apiPost.mockRejectedValue(new Error(message));
    await openSettingsTab();

    fireEvent.change(screen.getByLabelText("slippageBp"), { target: { value: "다섯" } });
    expect(screen.getByText("숫자가 아닙니다.")).toBeTruthy();
    expect(screen.getByText(/형으로 읽지 못한 값이 1개 있습니다/)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);

    // 범위는 화면이 검사하지 않습니다 — 서버가 거절하면 그 문구를 그대로.
    fireEvent.change(screen.getByLabelText("slippageBp"), { target: { value: "500" } });
    expect(screen.queryByText("숫자가 아닙니다.")).toBeNull();
    fireEvent.click(saveButton());

    expect(api.apiPost).toHaveBeenCalledWith("/api/paper/settings", { slippageBp: 500 });
    const warning = await screen.findByText(message);
    expect(warning.className).toContain("text-warn");
    // 실패하면 입력은 그대로 남습니다.
    expect((screen.getByLabelText("slippageBp") as HTMLInputElement).value).toBe("500");
  });

  it("되돌리기는 손댄 값을 모두 비운다", async () => {
    await openSettingsTab();
    fireEvent.change(screen.getByLabelText("cashLikeTickers"), { target: { value: "SHY, TLT" } });
    expect(changes()).toEqual(["cashLikeTickers: SHY → SHY, TLT"]);

    fireEvent.click(screen.getByRole("button", { name: "바꾼 값 되돌리기" }));
    expect(changes()).toEqual([]);
    expect((screen.getByLabelText("cashLikeTickers") as HTMLTextAreaElement).value).toBe("SHY");
  });

  it("테이블이 없으면(available:false) 서버 문구 그대로, 설정 행이 없으면 기본값이라고", async () => {
    const message = "모의 매매 테이블이 아직 없습니다. 수집기가 스키마(V8)를 적용하면 생깁니다.";
    reads["/api/paper/settings"] = () => Promise.resolve({ available: false, message });
    render(<PaperPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "설정" }));
    expect(await screen.findByText(message)).toBeTruthy();

    cleanup();
    reads["/api/paper/settings"] = () => Promise.resolve({ ...SETTINGS, version: null });
    await openSettingsTab();
    expect(screen.getByText(/설정 행이 아직 없습니다\(초기화 전\) — 아래 값은 기본값입니다/)).toBeTruthy();
  });
});
