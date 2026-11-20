/**
 * QA-940(작업대 D6 전 QA — QA-884 측정의 '좁은 화면 대화상자는 이 고침 밖', /alerts): 공용 MasterDetail에서 다시 읽기(자동 갱신·탭 복귀)로 대화상자·검사 칸의
 * 줄이 목록에서 빠지면 포커스가 <body>로 떨어집니다.
 *  - 좁은 화면(대화상자): 그 줄의 대화상자 안에 포커스가 있다가 줄이 빠지면 대화상자가 닫히고, 되돌아갈 줄 단추(여는 단추)가 없어 공용 대화상자의 되돌리기가
 *    하지 못합니다. 대화상자 키는 그대로 남아, 같은 줄이 다시 오면 대화상자가 저절로 다시 열렸습니다.
 *  - 넓은 화면(옆 검사 칸): 고른 줄이 빠지면 검사 칸 내용이 바뀌어 그 안의 포커스 요소가 사라집니다(알림함은 화면 쪽 QA-884가 막지만 다른 목록은 그대로).
 *
 * 기대: 포커스가 이 목록(줄 단추·검사 칸·대화상자) 안에 있다가 그 요소가 사라져 <body>로 떨어지면 목록으로 — 옆 검사 칸이면 지금 고른 줄, 아니면 빠진 줄의
 * 다음 줄(없으면 앞 줄), 줄이 하나도 없으면 목록 머리(빈 안내 글 — 스크립트 포커스 자리). 포커스가 이 목록 밖에 있었으면 옮기지 않습니다. 부르는 쪽이 같은 차례에
 * 옮기면(알림함 QA-866·QA-884) 그쪽이 먼저입니다. 빠진 줄의 대화상자는 닫은 것으로 칩니다(다시 와도 저절로 열지 않음).
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): 포커스 사례 넷 모두 activeElement가 BODY — 'expected <body>…</body> to be <button …>',
 * 다시 열림 사례는 'expected <div role="dialog" …> to be null'.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WIDE_SHELL_MEDIA } from "@/lib/shellCommands";

import { MasterDetail } from "../MasterDetail";

type Item = { key: string; name: string };

const ITEMS: Item[] = [
  { key: "a", name: "가상 첫째" },
  { key: "b", name: "가상 둘째" },
  { key: "c", name: "가상 셋째" },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubWide() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({ matches: query === WIDE_SHELL_MEDIA, media: query, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList,
  );
}

function view(items: readonly Item[], extra: { autoSelectFirst?: boolean } = {}) {
  return (
    <>
      <button type="button">목록 밖 단추</button>
      <MasterDetail<Item>
        label="합성 목록"
        items={items}
        itemKey={(item) => item.key}
        itemLabel={(item) => item.name}
        renderItem={(item) => item.name}
        // 검사 내용은 줄마다 새로 그립니다(알림함 InboxDetail의 key와 같은 꼴) — 줄이 바뀌면 그 안의 단추가 사라짐.
        renderDetail={(item) => (
          <div key={item.key}>
            <button type="button">{`${item.name} 처리`}</button>
          </div>
        )}
        emptyText="합성 목록이 비었습니다."
        {...extra}
      />
    </>
  );
}

const rowButton = (key: string) => document.querySelector<HTMLButtonElement>(`[data-item-key="${key}"]`);

/** 다시 읽기 뒤의 포커스 옮김은 다음 차례(타이머)에 일어납니다 — 옮기는 사례는 waitFor로 기다립니다(부하 때 10ms 안에 두 차례가 돌지 않을 수 있음). */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

describe("QA-940 다시 읽기로 줄이 빠지면 포커스를 목록으로", () => {
  it("좁은 화면: 대화상자 안에 포커스가 있다가 그 줄이 빠지면 대화상자가 닫히고 다음 줄 단추로", async () => {
    const { rerender } = render(view(ITEMS));
    fireEvent.click(rowButton("b") as HTMLButtonElement);
    const inner = within(screen.getByRole("dialog", { name: "가상 둘째" })).getByRole("button", { name: "가상 둘째 처리" });
    act(() => inner.focus());
    rerender(view([ITEMS[0], ITEMS[2]]));
    await waitFor(() => expect(document.activeElement).toBe(rowButton("c")));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("좁은 화면: 빠진 줄이 마지막이면 앞 줄, 줄이 하나도 남지 않으면 목록 머리(빈 안내 글)로", async () => {
    const { rerender } = render(view(ITEMS));
    fireEvent.click(rowButton("c") as HTMLButtonElement);
    act(() => within(screen.getByRole("dialog")).getByRole("button", { name: "가상 셋째 처리" }).focus());
    rerender(view(ITEMS.slice(0, 2)));
    await waitFor(() => expect(document.activeElement).toBe(rowButton("b")));

    fireEvent.click(rowButton("b") as HTMLButtonElement);
    act(() => within(screen.getByRole("dialog")).getByRole("button", { name: "가상 둘째 처리" }).focus());
    rerender(view([]));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("합성 목록이 비었습니다.")));
  });

  it("좁은 화면: 빠진 줄이 다시 와도 대화상자가 저절로 다시 열리지 않는다", async () => {
    const { rerender } = render(view(ITEMS));
    fireEvent.click(rowButton("b") as HTMLButtonElement);
    rerender(view([ITEMS[0], ITEMS[2]]));
    await settle();
    rerender(view(ITEMS));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("넓은 화면: 고른 줄이 빠져 검사 칸의 포커스 요소가 사라지면 다음 줄 단추로", async () => {
    stubWide();
    const { rerender } = render(view(ITEMS));
    fireEvent.click(rowButton("b") as HTMLButtonElement);
    act(() => screen.getByRole("button", { name: "가상 둘째 처리" }).focus());
    rerender(view([ITEMS[0], ITEMS[2]]));
    await waitFor(() => expect(document.activeElement).toBe(rowButton("c")));
  });

  it("넓은 화면 autoSelectFirst: 새 줄이 맨 위에 와 저절로 고른 줄이 바뀌면 지금 고른 줄(새 줄) 단추로", async () => {
    stubWide();
    const { rerender } = render(view(ITEMS, { autoSelectFirst: true }));
    act(() => screen.getByRole("button", { name: "가상 첫째 처리" }).focus());
    rerender(view([{ key: "z", name: "가상 새 줄" }, ...ITEMS], { autoSelectFirst: true }));
    await waitFor(() => expect(document.activeElement).toBe(rowButton("z")));
    expect(rowButton("z")?.getAttribute("aria-current")).toBe("true");
  });

  it("포커스가 목록 밖에 있었으면 줄이 빠져도 옮기지 않는다", async () => {
    stubWide();
    const { rerender } = render(view(ITEMS));
    fireEvent.click(rowButton("b") as HTMLButtonElement);
    const outside = screen.getByRole("button", { name: "목록 밖 단추" });
    act(() => outside.focus());
    rerender(view([ITEMS[0], ITEMS[2]]));
    await settle();
    expect(document.activeElement).toBe(outside);
  });

  it("빈 곳을 눌러 검사 칸을 떠난 뒤(포커스 <body>, 요소는 그대로)에는 줄이 빠져도 옮기지 않는다", async () => {
    stubWide();
    const { rerender } = render(view(ITEMS));
    fireEvent.click(rowButton("b") as HTMLButtonElement);
    const inner = screen.getByRole("button", { name: "가상 둘째 처리" });
    act(() => inner.focus());
    act(() => inner.blur());
    await settle();
    rerender(view([ITEMS[0], ITEMS[2]]));
    await settle();
    expect(document.activeElement).toBe(document.body);
  });
});
