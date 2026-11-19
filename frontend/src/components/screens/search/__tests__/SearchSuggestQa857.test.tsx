/**
 * 정보 검색 입력 후보 — 좁은 화면에서 후보 이름이 거의 다 잘림(QA-857, D1 결정 거리 `search-suggest-name-clipped-390`).
 *
 * 후보 줄은 [종류 아이콘 · 이름 · 보조 글(종류 · 시장·설명)]인데, 보조 글이 줄지 않는 칸(shrink-0)이라 390에서 보조 글이 길면 이름 칸이 몇 글자만 남고
 * 한 줄 말줄임(truncate)으로 잘렸습니다(D1 QA 스택 측정 — 이름이 거의 다 잘림). 고른 뒤에야 무엇을 골랐는지 알 수 있었습니다.
 * 기대: 보조 글이 먼저 줄고(줄어드는 칸 + 폭 상한, 한 줄 말줄임), 이름은 줄지 않는 몫을 받아 두 줄까지 보입니다(그 뒤에만 말줄임).
 * jsdom은 배치를 재지 않으므로 칸의 클래스로 봅니다(브라우저 확인은 갈래 끝 390 캡처). 요청·고르기 동작은 그대로입니다.
 * 수정 전(재현 커밋에서는 첫 사례 it.fails): "expected [ 'shrink-0', 'truncate', …(2) ] to not include 'shrink-0'".
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => {
  class UnauthorizedError extends Error {}
  return { apiGet: vi.fn(), UnauthorizedError };
});
vi.mock("@/lib/api", () => api);
const signal = vi.hoisted(() => ({ token: 0, reloadAll: () => {}, notifyUnauthorized: () => {} }));
vi.mock("@/hooks/useRefreshSignal", () => ({ useRefreshSignal: () => signal }));

import { endpoints } from "@/lib/endpoints";
import { SearchBox } from "../SearchBox";

const LONG_SUB = "Wikidata · 대한민국 · 반도체 장비 유통과 데이터센터 부품을 다루는 합성 설명";

beforeEach(() => {
  vi.useFakeTimers();
  api.apiGet.mockReset();
  api.apiGet.mockImplementation((path: string) =>
    path === endpoints.search.suggest("엔비")
      ? Promise.resolve({ available: true, items: [{ key: "wd:Q999", kind: "company", name: "엔비디아 코리아 합성 유한회사 반도체 사업부", sub: LONG_SUB, source: "wikidata" }] })
      : new Promise(() => {}),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function openSuggest() {
  const onChoose = vi.fn();
  render(<SearchBox initial={null} onSubmit={() => {}} onChoose={onChoose} />);
  const input = screen.getByRole("combobox", { name: "대상 검색" });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "엔비" } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
  const option = screen.getByRole("option", { name: /엔비디아 코리아/ });
  return { option, onChoose };
}

const classesOf = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/);

describe("입력 후보 줄 — 이름이 보조 글에 밀려 잘리지 않음(QA-857)", () => {
  it("보조 글은 줄어드는 칸(shrink-0 아님)에 폭 상한·한 줄 말줄임, 이름은 두 줄까지(한 줄 말줄임 아님)", async () => {
    const { option } = await openSuggest();
    const name = within(option).getByText("엔비디아 코리아 합성 유한회사 반도체 사업부");
    const sub = within(option).getByText(`기업 · ${LONG_SUB}`);
    expect(classesOf(sub)).not.toContain("shrink-0");
    expect(classesOf(sub)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
    expect(classesOf(sub).some((token) => /^max-w-/.test(token))).toBe(true);
    expect(classesOf(name)).not.toContain("truncate");
    expect(classesOf(name)).toEqual(expect.arrayContaining(["min-w-0", "flex-1", "line-clamp-2"]));
  });

  it("고르기는 그대로 — 누르면 그 후보", async () => {
    const { option, onChoose } = await openSuggest();
    fireEvent.click(option);
    expect(onChoose).toHaveBeenCalledWith(expect.objectContaining({ key: "wd:Q999" }));
  });
});
