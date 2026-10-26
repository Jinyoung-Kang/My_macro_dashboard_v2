/**
 * 토스트(ToastProvider·useToast) — Radix Toast.
 *
 *  - show(문구)는 알림 영역에 문구를 띄우고, 숨은 role="status" 영역이 읽어 준다
 *  - warn은 경고 테두리 + "주의:"(화면 읽기용) — 색만으로 알리지 않는다
 *  - 5초 뒤 사라지고, 닫기 단추로도 닫힌다. 한꺼번에 셋까지
 *  - Provider 밖에서는 아무 일도 하지 않는다(페이지만 그리는 테스트가 깨지지 않게)
 *  - 자리: 좁은 화면은 하단 탭 바 위(80px), lg 이상은 오른쪽 아래. 움직임은 motion-safe: 안에만
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToastProvider, useToast, type ToastTone } from "../Toast";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Shower({ message, tone }: { message: string; tone?: ToastTone }) {
  const { show } = useToast();
  return <button type="button" onClick={() => show(message, tone)}>띄우기</button>;
}

function renderToast(message = "설정을 저장했습니다", tone?: ToastTone) {
  render(
    <ToastProvider>
      <Shower message={message} tone={tone} />
    </ToastProvider>,
  );
  return screen.getByRole("button", { name: "띄우기" });
}

const region = () => screen.getByRole("region", { name: "안내 메시지 (F8)" });

describe("띄우기", () => {
  it("show(문구)는 알림 영역에 문구를 띄우고 role=status로 읽어 준다", async () => {
    const button = renderToast();
    expect(within(region()).queryAllByRole("listitem")).toHaveLength(0);

    fireEvent.click(button);
    expect(await within(region()).findByText("설정을 저장했습니다")).toBeTruthy();
    const status = await screen.findByRole("status");
    await waitFor(() => expect(status.textContent).toContain("설정을 저장했습니다"));
    // info는 정중하게(polite) 읽는다
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("warn은 경고 테두리와 '주의:' — 급하게(assertive) 읽는다", async () => {
    fireEvent.click(renderToast("저장하지 못했습니다", "warn"));
    const text = await within(region()).findByText("저장하지 못했습니다", { exact: false });
    expect(text.textContent).toContain("주의: 저장하지 못했습니다");
    expect(text.closest("li")?.className).toContain("border-warn");
    const status = await screen.findByRole("status");
    expect(status.getAttribute("aria-live")).toBe("assertive");
  });

  it("닫기 단추로 닫힌다", async () => {
    fireEvent.click(renderToast());
    const item = await within(region()).findByText("설정을 저장했습니다");
    fireEvent.click(within(item.closest("li") as HTMLElement).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(within(region()).queryByText("설정을 저장했습니다")).toBeNull());
  });

  it("한꺼번에 셋까지 — 넘치면 오래된 것부터 뺀다", async () => {
    function Many() {
      const { show } = useToast();
      return <button type="button" onClick={() => ["하나", "둘", "셋", "넷"].forEach((m) => show(m))}>여럿</button>;
    }
    render(<ToastProvider><Many /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "여럿" }));
    expect(await within(region()).findByText("넷")).toBeTruthy();
    expect(within(region()).queryByText("하나")).toBeNull();
    expect(within(region()).getAllByRole("listitem")).toHaveLength(3);
  });
});

describe("5초", () => {
  it("5초 전에는 남아 있고, 5초가 지나면 사라진다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    fireEvent.click(renderToast());
    await within(region()).findByText("설정을 저장했습니다");

    act(() => vi.advanceTimersByTime(4800));
    expect(within(region()).queryByText("설정을 저장했습니다")).toBeTruthy();
    act(() => vi.advanceTimersByTime(400));
    await waitFor(() => expect(within(region()).queryByText("설정을 저장했습니다")).toBeNull());
  });
});

describe("Provider 밖", () => {
  it("show를 불러도 아무 일도 없다(오류 없음)", () => {
    render(<Shower message="아무도 못 봄" />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "띄우기" }))).not.toThrow();
    expect(screen.queryByText("아무도 못 봄")).toBeNull();
  });
});

describe("자리와 움직임", () => {
  it("좁은 화면은 하단 탭 바 위(80px + 안전 영역), lg 이상은 오른쪽 아래", () => {
    renderToast();
    const list = region().querySelector("ol") as HTMLElement;
    const classes = list.className.split(/\s+/);
    expect(classes).toContain("bottom-[calc(5rem+env(safe-area-inset-bottom))]");
    expect(classes).toContain("lg:bottom-4");
    expect(classes).toContain("right-4");
  });

  it("전환 클래스는 전부 motion-safe: 안에만 있다", async () => {
    fireEvent.click(renderToast());
    const item = (await within(region()).findByText("설정을 저장했습니다")).closest("li") as HTMLElement;
    const moving = item.className.split(/\s+/).filter((name) => /(^|:)(transition|duration-|animate-|starting:)/.test(name));
    expect(moving.length).toBeGreaterThan(0);
    expect(moving.filter((name) => !name.startsWith("motion-safe:"))).toEqual([]);
  });
});
