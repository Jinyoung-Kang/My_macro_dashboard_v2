/**
 * RangeTabs(새 패턴) — 기간 탭(설계서 §6 "허용 범위를 props로 받아 그 밖은 렌더링하지 않음").
 * 그리기(tablist·aria-selected·허용 안의 탭만), 고른 값이 허용 밖(아무것도 선택 안 함·첫 탭으로 Tab 진입),
 * 클릭(다른 탭만 onChange), 키보드(←·→ 돎·Home·End, 포커스 이동 + 바로 고름), 그릴 탭이 없으면 아무것도 없음(값 없음),
 * 추정·오래됨(히어로 meta 배지와 함께 놓여도 탭은 그대로 — 탭이 배지를 가리거나 대신하지 않음).
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EstimateBadge, StaleBadge } from "../badges";
import { Hero } from "../Hero";
import { RangeTabs } from "../RangeTabs";

afterEach(() => cleanup());

const RANGES = [
  { key: "1y", label: "1년" },
  { key: "3y", label: "3년" },
  { key: "5y", label: "5년" },
  { key: "10y", label: "10년" },
] as const;
type Key = (typeof RANGES)[number]["key"];

/** 고른 값을 상태로 들고 있는 부르는 쪽 — 키보드로 고른 뒤 선택 표시까지 확인하려고 씁니다. */
function Controlled({ initial, allowed, onChange }: { initial: Key; allowed?: readonly Key[]; onChange?: (k: Key) => void }) {
  const [value, setValue] = useState<Key>(initial);
  return (
    <RangeTabs
      ranges={RANGES}
      allowed={allowed}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      label="기간"
    />
  );
}

function selectedLabels(): string[] {
  return screen
    .getAllByRole("tab")
    .filter((tab) => tab.getAttribute("aria-selected") === "true")
    .map((tab) => tab.textContent ?? "");
}

describe("RangeTabs", () => {
  it("label 이름의 tablist, 탭마다 aria-selected, 고른 탭만 Tab 키로 들어온다", () => {
    render(<RangeTabs ranges={RANGES} value="3y" onChange={() => {}} label="순자산 기간" />);
    const list = screen.getByRole("tablist", { name: "순자산 기간" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["1년", "3년", "5년", "10년"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(tabs[1].className).toContain("bg-surface-2");
    expect(tabs.every((tab) => tab.getAttribute("type") === "button")).toBe(true);
  });

  it("allowed 밖의 탭은 그리지 않는다(저장 구간 안만)", () => {
    render(<RangeTabs ranges={RANGES} allowed={["1y", "3y"]} value="1y" onChange={() => {}} label="기간" />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["1년", "3년"]);
    expect(screen.queryByRole("tab", { name: "5년" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "10년" })).toBeNull();
  });

  it("고른 값이 허용 밖이면 아무것도 선택하지 않고, 첫 탭으로 Tab 진입", () => {
    render(<RangeTabs ranges={RANGES} allowed={["1y", "3y"]} value="10y" onChange={() => {}} label="기간" />);
    expect(selectedLabels()).toEqual([]);
    expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1]);
  });

  it("클릭 — 다른 탭이면 onChange(key), 이미 고른 탭이면 부르지 않는다", () => {
    const onChange = vi.fn();
    render(<RangeTabs ranges={RANGES} value="1y" onChange={onChange} label="기간" />);
    fireEvent.click(screen.getByRole("tab", { name: "5년" }));
    expect(onChange).toHaveBeenCalledWith("5y");
    onChange.mockClear();
    fireEvent.click(screen.getByRole("tab", { name: "1년" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("키보드 → — 다음 탭으로 포커스를 옮기며 고른다, 끝에서 처음으로 돈다", () => {
    const onChange = vi.fn();
    render(<Controlled initial="5y" allowed={["1y", "3y", "5y"]} onChange={onChange} />);
    const five = screen.getByRole("tab", { name: "5년" });
    five.focus();
    fireEvent.keyDown(five, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("1y");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "1년" }));
    expect(selectedLabels()).toEqual(["1년"]);
    expect(screen.getByRole("tab", { name: "1년" }).tabIndex).toBe(0);
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("3y");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "3년" }));
  });

  it("키보드 ← 는 이전(처음에서 끝으로), Home·End는 처음·끝", () => {
    render(<Controlled initial="1y" />);
    const first = screen.getByRole("tab", { name: "1년" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(selectedLabels()).toEqual(["10년"]);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "10년" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(selectedLabels()).toEqual(["1년"]);
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(selectedLabels()).toEqual(["10년"]);
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "10년" }));
  });

  it("다른 키는 아무것도 하지 않는다", () => {
    const onChange = vi.fn();
    render(<RangeTabs ranges={RANGES} value="1y" onChange={onChange} label="기간" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: "1년" }), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("tab", { name: "1년" }), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });

  // RangeTabs는 추정·오래됨 플래그를 받지 않는다(기간을 고르는 조각) — 배지는 놓인 히어로의 meta가 그리고 Hero 테스트가 본다.
  // 여기서는 배지와 함께 놓여도 탭이 그대로 그려지고 고를 수 있는지만 본다.
  it("추정·오래됨 — 플래그를 받지 않는 탭이라 히어로의 배지와 함께 놓여도 그대로 고를 수 있다", () => {
    const onChange = vi.fn();
    render(
      <Hero
        label="순자산"
        value="1억"
        meta={
          <>
            <EstimateBadge estimated />
            <StaleBadge stale reason="이번 수집 실패" />
          </>
        }
        tabs={<RangeTabs ranges={RANGES} allowed={["1y", "3y"]} value="1y" onChange={onChange} label="순자산 기간" />}
      />,
    );
    const region = screen.getByRole("region", { name: "순자산" });
    expect(within(region).getByText("추정")).toBeTruthy();
    expect(within(region).getByText("이전 값")).toBeTruthy();
    fireEvent.click(within(region).getByRole("tab", { name: "3년" }));
    expect(onChange).toHaveBeenCalledWith("3y");
  });

  it("그릴 탭이 하나도 없으면 아무것도 그리지 않는다", () => {
    const { container } = render(<RangeTabs ranges={RANGES} allowed={[]} value="1y" onChange={() => {}} label="기간" />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("tablist")).toBeNull();
  });
});
