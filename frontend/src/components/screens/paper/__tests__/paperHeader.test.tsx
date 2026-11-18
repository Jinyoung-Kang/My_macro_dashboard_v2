/**
 * 모의매매 머리(PaperHeader — 작업대 P6, 실행 명세 §7-1 '머리 압축').
 *
 *  - 한 줄: 제목(h1) · 시장 세그먼트(lg만) · 계좌 칸 · 한계 서랍 단추·자세히·신선도 · 동작 칸 — DOM 차례가 어느 폭에서도 보이는 차례(order 없음 — QA-772·778)
 *  - 빈 칸(계좌·동작)은 숨김(empty:hidden), 칸 요소는 콜백 ref로 넘어감(data-paper-header-slot)
 *  - '자세히'는 aria-expanded·aria-controls 단추 — 접힌 동안에도 설명 글은 DOM에(hidden), 펼치면 보임
 *  - 한계 서랍: 단추 '이 장부의 한계 (n줄)'(aria-haspopup=dialog), 열면 서버 목록·계좌2 한계 영역·출처, Esc로 닫으면 단추로 포커스. 한계가 없으면 단추 없음
 *  - 실제 계좌·ISA 탭이면 제목 옆 주의 태그 '실제 계좌'(아이콘 + 낭독 '주의: ')
 *  - 조작은 lg 미만 44px(한계 단추 공용 단추 클래스·자세히 TEXT_TARGET·세그먼트 칸)
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PaperHeader } from "../PaperHeader";

afterEach(() => cleanup());

const LIMITS = ["모의 매매입니다 — 주문은 어디로도 나가지 않습니다.", "수익률을 서로 비교하지 않습니다."];

function renderHeader(over: Partial<Parameters<typeof PaperHeader>[0]> = {}) {
  const onAccountSlot = vi.fn();
  const onActionsSlot = vi.fn();
  const view = render(
    <PaperHeader
      title="모의 알고리즘 매매(미국)"
      market="US"
      tab="holdings"
      description={<>같은 돈·같은 날 출발한 네 계좌 — 규칙 · Claude 계좌1</>}
      limits={{ lines: LIMITS, source: "출처: 모의 장부", book2Label: null }}
      refreshError={null}
      onAccountSlot={onAccountSlot}
      onActionsSlot={onActionsSlot}
      {...over}
    />,
  );
  return { ...view, onAccountSlot, onActionsSlot };
}

describe("PaperHeader", () => {
  it("한 줄 머리 — 제목·세그먼트·계좌 칸·한계·자세히·동작 칸 DOM 차례(넓은 화면은 동작이 줄 끝), 빈 칸은 숨김, 칸 요소를 콜백으로 넘긴다", () => {
    const { container, onAccountSlot, onActionsSlot } = renderHeader();
    expect(screen.getByRole("heading", { level: 1, name: "모의 알고리즘 매매(미국)" })).toBeTruthy();
    const account = container.querySelector('[data-paper-header-slot="account"]') as HTMLElement;
    const actions = container.querySelector('[data-paper-header-slot="actions"]') as HTMLElement;
    expect(onAccountSlot).toHaveBeenCalledWith(account);
    expect(onActionsSlot).toHaveBeenCalledWith(actions);
    expect(account.className).toContain("empty:hidden");
    expect(actions.className).toContain("empty:hidden");
    // 넓은 화면은 동작이 줄 끝(ml-auto — order로 차례를 바꾸지 않음, QA-778), 계좌 칸은 고른 이름 폭 아래로 줄어들지 않음(QA-772).
    expect(actions.className).toContain("lg:ml-auto");
    expect(actions.className).not.toContain("order-");
    expect(account.className).toContain("shrink-0");
    expect(account.className).not.toContain("flex-1");
    // DOM 차례 = 어느 폭에서도 보이는 차례(제목 → 계좌 → 한계·자세히 → 동작 — QA-772·778 Tab 차례).
    const row = account.parentElement as HTMLElement;
    const order = [...row.children].map((child) =>
      child.getAttribute("data-paper-header-slot") ?? (child.querySelector("h1") ? "title" : child.querySelector("button") ? "meta" : "?"),
    );
    expect(order).toEqual(["title", "account", "meta", "actions"]);
    // 한계 묶음은 내용 폭 아래로 줄어들지 않고(들어가지 않으면 다음 줄), 차례를 바꾸지 않음.
    const meta = row.children[2] as HTMLElement;
    expect(meta.className).toContain("shrink-0");
    expect(meta.className).not.toContain("order-");
  });

  it("시장 세그먼트 — lg만, 같은 탭의 두 시장 주소(지금 시장 aria-current), 그 시장에 없는 탭이면 그 시장의 개요", () => {
    renderHeader({ market: "KR", tab: "isa" });
    const nav = screen.getByRole("navigation", { name: "모의 매매 시장" });
    expect(nav.className).toContain("hidden");
    expect(nav.className).toContain("lg:inline-flex");
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href"), link.getAttribute("aria-current")])).toEqual([
      ["미국", "/paper/us", null],
      ["한국", "/paper/kr/isa", "page"],
    ]);
  });

  it("'자세히' — 접힌 동안에도 설명은 DOM에(hidden), 누르면 펼침(aria-expanded·aria-controls), 다시 누르면 접힘", () => {
    renderHeader();
    const toggle = screen.getByRole("button", { name: "자세히" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const region = document.getElementById(toggle.getAttribute("aria-controls") ?? "") as HTMLElement;
    expect(region.hidden).toBe(true);
    expect(region.textContent).toContain("같은 돈·같은 날 출발한 네 계좌");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(region.hidden).toBe(false);
    fireEvent.click(toggle);
    expect(region.hidden).toBe(true);
    // 좁은 화면 44px(넓은 화면 글 높이).
    expect(toggle.className).toContain("min-h-11");
  });

  it("한계 서랍 — 단추 이름에 줄 수, 열면 서버 목록과 출처, Esc로 닫으면 단추로 포커스", async () => {
    renderHeader();
    const opener = screen.getByRole("button", { name: "이 장부의 한계 (2줄)" });
    expect(opener.getAttribute("aria-haspopup")).toBe("dialog");
    expect(opener.className).toContain("min-h-11");
    expect(screen.queryByText(LIMITS[0])).toBeNull();
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole("dialog", { name: "이 장부의 한계" });
    expect(within(drawer).getAllByRole("listitem").map((li) => li.textContent)).toEqual(LIMITS);
    expect(within(drawer).getByText(/출처: 모의 장부/)).toBeTruthy();
    expect(within(drawer).queryByRole("region", { name: "Claude 계좌2의 한계" })).toBeNull();
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it("계좌2가 있으면 서랍의 서버 목록 아래에 계좌2 한계 영역, 한계가 없으면 단추 없음", () => {
    const { unmount } = renderHeader({ limits: { lines: LIMITS, source: "출처", book2Label: "Claude 계좌2" } });
    fireEvent.click(screen.getByRole("button", { name: "이 장부의 한계 (2줄)" }));
    const region = within(screen.getByRole("dialog")).getByRole("region", { name: "Claude 계좌2의 한계" });
    expect(within(region).getByRole("heading", { name: "Claude 계좌2(체결 시점 실험)" })).toBeTruthy();
    expect(within(region).getAllByRole("listitem").length).toBe(5);
    unmount();
    renderHeader({ limits: null });
    expect(screen.queryByRole("button", { name: /이 장부의 한계/ })).toBeNull();
  });

  it("실제 계좌·ISA 탭이면 제목 옆 주의 태그 '실제 계좌'(아이콘 + 낭독 '주의: '), 모의 탭은 없음", () => {
    const { unmount } = renderHeader({ realMarker: true, tab: "real" });
    const heading = screen.getByRole("heading", { level: 1 });
    const tag = within(heading.parentElement as HTMLElement).getByText("실제 계좌").closest("span") as HTMLElement;
    expect(tag.className).toContain("text-warn");
    expect(tag.textContent).toBe("주의: 실제 계좌");
    expect(tag.querySelector("svg")).not.toBeNull();
    unmount();
    renderHeader();
    expect(screen.queryByText("실제 계좌")).toBeNull();
  });

  it("새로 읽지 못함 — 신선도 표지를 한계 줄에", () => {
    renderHeader({ refreshError: "502" });
    expect(screen.getByRole("status").textContent).toContain("새로 읽지 못함");
  });
});
