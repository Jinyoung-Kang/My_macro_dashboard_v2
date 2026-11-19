/**
 * 연결 테스트 '등록된 엔진' 표의 열 — QA-875(작업대 P7 검토에서 찾음, 브라우저 측정).
 *
 * P7이 표를 공용 조밀 표로 옮기며 모델 칸을 `whitespace-nowrap` 고정폭(가장 긴 '@cf/meta/llama-3.3-70b-instruct-fp8-fast'가 368px)으로, 용도 칸을
 * `min-w-[14rem]`으로 두어 줄어들 수 있는 칸이 엔진 이름뿐이었습니다. 1024(상자 706px)에서 표가 758px로 상자를 넘쳐 핵심 칸 '키'가 가로 스크롤 뒤로 밀리고
 * 엔진 이름 칸은 94px로 눌려 3~5줄로 접혔습니다(기준 빌드는 상자에 맞고 엔진 칸 180px, 행 53px). jsdom은 배치를 재지 않아 열 클래스로 봅니다
 * (브라우저 확인은 진행 기록 §P7 '검토 반영').
 *
 * 기대: 모델 칸은 식별자 안 아무 데서나 꺾일 수 있고(wrap-anywhere — 줄바꿈 금지 없음), 엔진 이름 칸은 최소 폭(10rem)을 가져 눌리지 않음.
 * 수정 전(재현 커밋에서는 it.fails): "expected [ 'px-3', 'py-3', 'lg:py-1', …(4) ] to include 'wrap-anywhere'"(모델 칸 whitespace-nowrap).
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { AiEngineSection } from "../connections/AiEngineSection";

const ENGINES = {
  enabled: true,
  keys: {},
  engines: [
    { id: "cf_llama", label: "Cloudflare — Llama 3.3 70B", provider: "cloudflare", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", description: "빠른 무료 엔진", available: true, unavailableReason: null },
  ],
};

beforeEach(() => {
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => (path === "/api/ai/engines" ? Promise.resolve(ENGINES) : new Promise(() => {})));
});
afterEach(() => cleanup());

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("등록된 엔진 표의 열(QA-875)", () => {
  it.fails("모델 칸은 식별자 안에서 꺾일 수 있고(줄바꿈 금지 없음), 엔진 이름 칸은 최소 폭 10rem", async () => {
    render(<AiEngineSection />);
    const table = await screen.findByRole("region", { name: "등록된 엔진 (좌우 스크롤)" });
    const modelCell = within(table).getByText("@cf/meta/llama-3.3-70b-instruct-fp8-fast").closest("td") as HTMLElement;
    expect(tokens(modelCell)).toContain("wrap-anywhere");
    expect(tokens(modelCell)).not.toContain("whitespace-nowrap");
    const engineCell = within(table).getByText("Cloudflare — Llama 3.3 70B").closest("th") as HTMLElement;
    expect(tokens(engineCell)).toContain("min-w-[10rem]");
  });
});
