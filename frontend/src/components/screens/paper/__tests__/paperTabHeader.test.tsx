/**
 * 모의매매 머리 칸 계약(PaperTabHeader — 작업대 P6)과 공용 배지(PaperBadge).
 *
 *  - 공급자 안: 섹션의 계좌 고르기·동작이 머리 칸으로 그려진다(포털 — 섹션 DOM 밖), 칸이 아직 null이면 아무것도 그리지 않는다(서버 그리기도 같음)
 *  - 공급자 밖: 제자리에 그린다(섹션만 그린 시험)
 *  - 계좌 고르기: 이름 '계좌 고르기'(aria-label), 보이는 '계좌'는 읽기에서 뺌, 고르면 onChange(값), 선택지가 없으면 그리지 않음
 *  - 동작: ActionBar(빈 목록이면 그리지 않음)
 *  - PaperBadge: lib 배지 색 → 태그 톤(정상·주의·중립), 글은 안쪽 span(글로 찾음), 마우스 설명은 바깥 span title
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toneClass } from "@/lib/paper";

import { PaperBadge } from "../PaperBadge";
import { PaperHeaderSlotsProvider, PaperTabAccount, PaperTabActions } from "../PaperTabHeader";

afterEach(() => cleanup());

const OPTIONS = [
  { value: "rules", label: "규칙 계좌 · 운용 중" },
  { value: "claude", label: "Claude 계좌1 · 운용 중" },
];

function Section({ onChange = () => {}, onPause = () => {} }: { onChange?: (value: string) => void; onPause?: () => void }) {
  return (
    <section aria-label="보유·체결">
      <PaperTabAccount value="rules" options={OPTIONS} onChange={onChange} />
      <PaperTabActions label="보유·체결 동작" actions={[{ id: "pause", label: "일시정지", onSelect: onPause }]} />
      <p>보유 표</p>
    </section>
  );
}

/** 머리 — 칸 둘을 콜백 ref로 받아 공급자에 넘깁니다(PaperScreen과 같은 꼴). */
function Host({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  return (
    <PaperHeaderSlotsProvider account={account} actions={actions}>
      <header aria-label="머리">
        <div ref={setAccount} className="contents" />
        <div ref={setActions} className="contents" />
      </header>
      {children}
    </PaperHeaderSlotsProvider>
  );
}

describe("PaperTabHeader — 머리 칸", () => {
  it("공급자 안: 계좌 고르기·동작이 머리 칸으로 그려진다(섹션 DOM 밖) — 고르기·누르기는 섹션의 처리기로", () => {
    const onChange = vi.fn();
    const onPause = vi.fn();
    render(
      <Host>
        <Section onChange={onChange} onPause={onPause} />
      </Host>,
    );
    const header = screen.getByRole("banner", { name: "머리" });
    const section = screen.getByRole("region", { name: "보유·체결" });
    const select = screen.getByLabelText("계좌 고르기");
    expect(header.contains(select)).toBe(true);
    expect(section.contains(select)).toBe(false);
    const group = screen.getByRole("group", { name: "보유·체결 동작" });
    expect(header.contains(group)).toBe(true);
    expect(within(section).getByText("보유 표")).toBeTruthy();
    fireEvent.change(select, { target: { value: "claude" } });
    expect(onChange).toHaveBeenCalledWith("claude");
    fireEvent.click(within(group).getByRole("button", { name: "일시정지" }));
    expect(onPause).toHaveBeenCalledTimes(1);
  });

  it("공급자 안이고 칸이 아직 null이면 아무것도 그리지 않는다 — 서버 그리기도 같음", () => {
    render(
      <PaperHeaderSlotsProvider account={null} actions={null}>
        <Section />
      </PaperHeaderSlotsProvider>,
    );
    expect(screen.queryByLabelText("계좌 고르기")).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.getByText("보유 표")).toBeTruthy();
    cleanup();
    const html = renderToString(
      <PaperHeaderSlotsProvider account={null} actions={null}>
        <Section />
      </PaperHeaderSlotsProvider>,
    );
    expect(html).not.toContain("<select");
    expect(html).not.toContain("일시정지");
    expect(html).toContain("보유 표");
  });

  it("공급자 밖: 제자리에 그린다 — 이름 '계좌 고르기', 보이는 '계좌'는 읽기에서 뺌, 선택지 그대로", () => {
    render(<Section />);
    const section = screen.getByRole("region", { name: "보유·체결" });
    const select = within(section).getByLabelText("계좌 고르기") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("rules");
    expect([...select.options].map((option) => option.textContent)).toEqual(["규칙 계좌 · 운용 중", "Claude 계좌1 · 운용 중"]);
    const visible = within(section).getByText("계좌");
    expect(visible.getAttribute("aria-hidden")).toBe("true");
    expect(within(section).getByRole("group", { name: "보유·체결 동작" })).toBeTruthy();
  });

  it("선택지가 없으면 계좌 고르기를, 빈 동작 목록이면 동작을 그리지 않는다(실제 계좌·ISA 탭)", () => {
    render(
      <section aria-label="실제 계좌">
        <PaperTabAccount value="" options={[]} onChange={() => {}} />
        <PaperTabActions label="실제 계좌 동작" actions={[]} />
      </section>,
    );
    const section = screen.getByRole("region", { name: "실제 계좌" });
    expect(section.innerHTML).toBe("");
  });

  it("label을 주면 그 이름", () => {
    render(<PaperTabAccount label="순자산을 볼 계좌" value="rules" options={OPTIONS} onChange={() => {}} />);
    expect(screen.getByLabelText("순자산을 볼 계좌")).toBeTruthy();
  });
});

describe("PaperBadge — 공용 태그(20px)", () => {
  it("정상 — 정상 태그(체크 아이콘), 글은 안쪽 span으로 찾는다", () => {
    render(<PaperBadge badge={{ label: "운용 중", className: toneClass("ok") }} />);
    const label = screen.getByText("운용 중");
    expect(label.tagName).toBe("SPAN");
    const tag = label.parentElement as HTMLElement;
    expect(tag.className.split(/\s+/)).toEqual(expect.arrayContaining(["text-ok", "bg-ok-tint", "text-xs", "leading-4"]));
    expect(tag.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(tag.parentElement?.hasAttribute("title")).toBe(false);
  });

  it("주의 — 주의 태그(경고 아이콘 + 낭독기 '주의: '), 마우스 설명은 바깥 span title", () => {
    render(<PaperBadge badge={{ label: "일시정지", className: toneClass("warn"), title: "새 체결·스탑을 멈춤" }} />);
    const label = screen.getByText("일시정지");
    const tag = label.parentElement as HTMLElement;
    expect(tag.className.split(/\s+/)).toContain("text-warn");
    expect(tag.textContent).toBe("주의: 일시정지");
    expect(tag.parentElement?.getAttribute("title")).toBe("새 체결·스탑을 멈춤");
    // 좁은 표 칸에서도 글자 사이로 접히지 않게(예전 화면 배지와 같은 whitespace-nowrap).
    expect(tag.parentElement?.className).toContain("whitespace-nowrap");
  });

  it("안내·흐림·모르는 색은 중립 태그(아이콘 없음, 강조 파랑 없음)", () => {
    for (const className of [toneClass("info"), toneClass("muted"), "text-text-3"]) {
      render(<PaperBadge badge={{ label: "사후 체결", className }} />);
      const tag = screen.getByText("사후 체결").parentElement as HTMLElement;
      expect(tag.className.split(/\s+/)).toEqual(expect.arrayContaining(["bg-surface-2", "text-text-2"]));
      expect(tag.querySelector("svg")).toBeNull();
      expect(tag.className).not.toContain("accent");
      cleanup();
    }
  });
});
