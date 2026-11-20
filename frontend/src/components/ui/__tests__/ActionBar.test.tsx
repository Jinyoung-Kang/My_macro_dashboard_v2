/**
 * 화면 머리의 동작 영역(ui/ActionBar — 작업대 P6 모의매매 머리).
 *
 *  - 빈 목록이면 그리지 않는다(null — 실제 계좌·ISA 탭)
 *  - 이름 있는 묶음(role=group) 안에 앞의 maxInline(기본 3)개는 단추(이름 = 글, data-action), 넘는 것은 '동작' 메뉴 항목 — pin은 넘쳐도 단추
 *  - 단추는 공용 단추 클래스(의도별 — 위험은 bg-danger, 좁은 화면 44px), 대화상자를 여는 동작은 aria-haspopup="dialog", 확인 상자는 aria-expanded·aria-controls
 *  - 메뉴 항목: 글자 찾기 별칭(textValue)·막힌 항목(aria-disabled — 건너뜀)·위험 표지(data-tone·경고 삼각형)
 *  - 메뉴 항목을 고르면 메뉴가 닫히고 포커스가 '동작' 단추로 돌아간 뒤에 그 동작이 불린다 — 그 동작이 연 대화상자를 닫으면 '동작' 단추로 돌아옴
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ActionBar, type ActionBarItem } from "../ActionBar";
import { Dialog } from "../Dialog";

afterEach(() => cleanup());

const item = (id: string, label: string, over: Partial<ActionBarItem> = {}): ActionBarItem => ({ id, label, onSelect: vi.fn(), ...over });

const group = () => screen.getByRole("group", { name: "보유·체결 동작" });

function openMenu(): HTMLElement {
  fireEvent.keyDown(within(group()).getByRole("button", { name: "동작" }), { key: "Enter" });
  return screen.getByRole("menu", { name: "동작" });
}

describe("ActionBar", () => {
  it("빈 목록이면 아무것도 그리지 않는다", () => {
    const { container } = render(<ActionBar label="실제 계좌 동작" actions={[]} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("maxInline 안의 동작은 이름 있는 묶음 안의 단추 — 이름 = 글, data-action, 메뉴는 없다", () => {
    const pause = item("pause", "일시정지");
    render(<ActionBar label="보유·체결 동작" actions={[pause, item("reset", "계좌 초기화", { intent: "danger", opensDialog: true })]} />);
    const buttons = within(group()).getAllByRole("button");
    expect(buttons.map((button) => [button.textContent, button.getAttribute("data-action"), button.getAttribute("type")])).toEqual([
      ["일시정지", "pause", "button"],
      ["계좌 초기화", "reset", "button"],
    ]);
    expect(within(group()).queryByRole("button", { name: "동작" })).toBeNull();
    fireEvent.click(buttons[0]);
    expect(pause.onSelect).toHaveBeenCalledTimes(1);
  });

  it("단추는 공용 단추 클래스 — 좁은 화면 44px(min-h-11), 위험 의도는 위험 바탕, 주 의도는 강조 바탕", () => {
    render(
      <ActionBar
        label="보유·체결 동작"
        actions={[item("a", "기본"), item("b", "주", { intent: "primary" }), item("c", "위험", { intent: "danger" })]}
      />,
    );
    const [plain, primary, danger] = within(group()).getAllByRole("button").map((button) => button.className.split(/\s+/));
    for (const classes of [plain, primary, danger]) expect(classes).toEqual(expect.arrayContaining(["min-h-11", "lg:min-h-[30px]"]));
    expect(plain).toContain("bg-control-fill");
    expect(primary).toContain("bg-accent");
    expect(danger).toEqual(expect.arrayContaining(["bg-danger", "text-danger-fg"]));
  });

  it("대화상자를 여는 동작은 aria-haspopup=dialog, 확인 상자를 여닫는 동작은 aria-expanded·aria-controls — 주지 않으면 붙이지 않는다", () => {
    render(
      <ActionBar
        label="보유·체결 동작"
        actions={[
          item("reset", "계좌 초기화", { opensDialog: true }),
          item("run", "지금 결정 실행", { expanded: true, controls: "decision-confirm", describedBy: "decision-note" }),
          item("plain", "그냥", { disabled: true }),
        ]}
      />,
    );
    const [reset, run, plain] = within(group()).getAllByRole("button");
    expect(reset.getAttribute("aria-haspopup")).toBe("dialog");
    // 설명 글 id(describedBy)는 aria-describedby로 — 주지 않으면 붙이지 않음(작업대 P6 검토).
    expect(run.getAttribute("aria-describedby")).toBe("decision-note");
    expect(reset.hasAttribute("aria-describedby")).toBe(false);
    expect(run.getAttribute("aria-expanded")).toBe("true");
    expect(run.getAttribute("aria-controls")).toBe("decision-confirm");
    expect(plain.hasAttribute("aria-haspopup")).toBe(false);
    expect(plain.hasAttribute("aria-expanded")).toBe(false);
    expect(plain.hasAttribute("aria-controls")).toBe(false);
    expect((plain as HTMLButtonElement).disabled).toBe(true);
  });

  it("maxInline을 넘는 동작은 '동작' 메뉴 항목 — 막힌 항목은 aria-disabled, 위험 의도는 위험 표지, pin은 넘쳐도 단추", () => {
    render(
      <ActionBar
        label="보유·체결 동작"
        maxInline={2}
        actions={[
          item("a", "하나"),
          item("b", "둘"),
          item("c", "셋", { disabled: true }),
          item("d", "계좌 초기화", { intent: "danger" }),
          item("e", "실행 끄기", { pin: true }),
        ]}
      />,
    );
    expect(within(group()).getAllByRole("button").map((button) => button.getAttribute("data-action") ?? button.textContent)).toEqual([
      "a",
      "b",
      "e",
      "동작",
    ]);
    const trigger = within(group()).getByRole("button", { name: "동작" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.className.split(/\s+/)).toContain("min-h-11");
    const menu = openMenu();
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((entry) => entry.textContent)).toEqual(["셋", "계좌 초기화"]);
    expect(items[0].getAttribute("aria-disabled")).toBe("true");
    expect(items[1].getAttribute("data-tone")).toBe("danger");
    expect(items[1].querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("메뉴는 글자 찾기 별칭(textValue)으로 한글 항목을 찾는다", async () => {
    render(
      <ActionBar
        label="보유·체결 동작"
        maxInline={0}
        actions={[item("pause", "일시정지", { textValue: "ilsi" }), item("reset", "계좌 초기화", { textValue: "gyejwa" })]}
      />,
    );
    const menu = openMenu();
    const [pause, reset] = within(menu).getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(pause));
    fireEvent.keyDown(pause, { key: "g" });
    await waitFor(() => expect(document.activeElement).toBe(reset));
  });

  it("메뉴 항목의 동작은 메뉴가 닫히고 포커스가 '동작' 단추로 돌아간 뒤에 불린다 — 그 동작이 연 대화상자를 닫으면 '동작' 단추로", async () => {
    const seen: { menuOpen: boolean; focus: Element | null }[] = [];
    function WithDialog() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <ActionBar
            label="보유·체결 동작"
            maxInline={0}
            actions={[
              item("reset", "계좌 초기화", {
                intent: "danger",
                opensDialog: true,
                onSelect: () => {
                  seen.push({ menuOpen: screen.queryByRole("menu") !== null, focus: document.activeElement });
                  setOpen(true);
                },
              }),
            ]}
          />
          <Dialog open={open} onOpenChange={setOpen} title="계좌 초기화 확인">
            <button type="button">초기화 확인</button>
          </Dialog>
        </>
      );
    }
    render(<WithDialog />);
    const trigger = within(group()).getByRole("button", { name: "동작" });
    fireEvent.click(within(openMenu()).getByRole("menuitem", { name: "계좌 초기화" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toEqual({ menuOpen: false, focus: trigger });

    const dialog = await screen.findByRole("dialog", { name: "계좌 초기화 확인" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
