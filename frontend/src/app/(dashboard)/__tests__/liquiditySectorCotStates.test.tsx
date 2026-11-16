/**
 * 순유동성(/liquidity)·섹터(/sector)·COT(/cot) 화면의 조작·정직한 상태 시험 — 두 공유 시험 파일에서 세 화면 사례만 옮겨 왔습니다(P5a 패턴 단계, 내용 그대로).
 *
 * 원래 파일·describe 이름 그대로 옮김:
 *  - controlsStay.test.tsx: 'QA-047 조건을 바꿔도 컨트롤이 남는다'(사례 배열의 섹터·순유동성)
 *  - honestStates.test.tsx: "QA-050 실패·로딩을 '없음'으로 보이지 않는다"(COT 개요 조회 실패)
 * 도우미 함수는 원래 파일의 것을 글자 그대로 복사했습니다. 세 화면 갈래(매크로 · 순유동성·섹터·COT · 상관·국면)가 화면을 바꿀 때 서로의 시험 파일을
 * 고치지 않게 갈래마다 파일을 나눈 것입니다(나머지 사례는 원래 파일에 남음).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), apiPost: vi.fn(), apiGetShared: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
// 매번 같은 함수를 돌려줘야 합니다 — 새 함수면 그것을 의존성으로 쓰는 effect가 끝없이 다시 돕니다.
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import CotPage from "../cot/page";
import LiquidityPage from "../liquidity/page";
import SectorPage from "../sector/page";

/** 첫 경로만 응답하고, 바꾼 뒤의 경로는 끝나지 않는 요청(로딩 중). */
function answerOnly(firstPath: string, body: unknown) {
  api.apiGetShared.mockImplementation((path: string) =>
    path === firstPath ? Promise.resolve(body) : new Promise(() => {}));
}

/** 경로 앞부분 → 응답(함수면 거절할 수도 있음). 없는 경로는 끝나지 않는 요청. */
let reads: Record<string, () => Promise<unknown>> = {};

// honestStates의 beforeEach 그대로입니다 — controlsStay의 beforeEach(조회 목 초기화)를 담고, controlsStay에서 옮긴 시험은 조회 목을
// 스스로 정합니다(answerOnly).
beforeEach(() => {
  reads = {};
  api.apiPost.mockReset();
  api.apiGetShared.mockReset();
  api.apiGetShared.mockImplementation((path: string) => {
    const key = Object.keys(reads).find((prefix) => path.startsWith(prefix));
    return key ? reads[key]() : new Promise(() => {});
  });
});

afterEach(() => cleanup());

describe("QA-047 조건을 바꿔도 컨트롤이 남는다", () => {
  const cases = [
    { name: "섹터", Page: SectorPage, path: "/api/sector/rotation?period=1M", label: "조회 기간", next: "3M",
      body: { available: true, sectors: [], assetClasses: [], periods: ["1M", "3M"] } },
    { name: "순유동성", Page: LiquidityPage, path: "/api/liquidity?years=3", label: "조회 기간", next: "5",
      body: { available: true, rows: [] } },
  ];

  for (const { name, Page, path, label, next, body } of cases) {
    // 수정 전에는 로딩 중 페이지 전체를 바꿔 선택 상자가 사라졌다.
    it(`${name}: 기간을 바꾼 뒤 새 응답을 기다리는 동안에도 '${label}' 선택 상자가 그대로`, async () => {
      answerOnly(path, body);
      render(<Page />);
      const select = (await screen.findByLabelText(label)) as HTMLSelectElement;

      fireEvent.change(select, { target: { value: next } });

      expect(select.isConnected).toBe(true);
      expect((screen.getByLabelText(label) as HTMLSelectElement).value).toBe(next);
    });
  }
});

describe("QA-050 실패·로딩을 '없음'으로 보이지 않는다", () => {
  // 수정 전에는 COT 개요 조회의 오류를 받지 않아 카드가 빈 채로 남았다.
  it("COT 개요 조회가 실패하면 오류를 보인다", async () => {
    reads["/api/cot/overview"] = () => Promise.reject(new Error("요청 실패 (HTTP 503)"));

    render(<CotPage />);

    expect(await screen.findByText(/요청 실패 \(HTTP 503\)/)).toBeTruthy();
  });
});
