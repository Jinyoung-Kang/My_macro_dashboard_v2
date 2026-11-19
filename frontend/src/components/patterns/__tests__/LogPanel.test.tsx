/**
 * LogPanel — 로그·원문 글 상자(작업대 P7 패턴 단계 — 저장소 상태 로그·AI 리포트 원문·AI 입력 원본·토스 조회 JSON). 네 상태:
 *  - 값 있음: 받은 글 그대로(공백·줄바꿈 유지), 이름 있는 영역 '{label} (스크롤)'·Tab 정지점(tabIndex 0)·고정폭 12/20·화면 바탕 상자·포커스 링
 *  - 빈 글('' 또는 공백만): 상자 없이 emptyText(기본 '내용이 없습니다.') — 영역·빈 상자 없음
 *  - 모름(null·undefined): 상자 없이 공용 '—'(읽기 '값 없음') + 사유(기본 '받지 못함') — 0·빈 상자를 만들지 않음
 *  - 긴 글: 높이 한도(sm 20rem·md 30rem·lg 40rem) 안에서 상자 스크롤, 줄바꿈 꼴(anywhere — 긴 낱말을 아무 데서나, word — 낱말 사이)
 * 추정·대리·이전 값 배지는 이 패턴에 해당 없습니다 — 글 원문을 그대로 보이는 상자라 꼬리표가 붙을 숫자가 없고, 배지는 부르는 쪽 패널 머리가 붙입니다.
 * 강조 파랑 없음(데이터 칸 강조색 금지 목록 — lib/__tests__/accentInData.test.ts가 파일 전체를 봄).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LogPanel } from "../LogPanel";

afterEach(() => cleanup());

const tokens = (element: Element) => (element.getAttribute("class") ?? "").split(/\s+/);

const LOG = "[2026-11-15 09:00 KST] ERROR global_synthetic: 403 Forbidden\n  재시도 2회 — 다음 실행 09:30\n\n[2026-11-15 09:05 KST] WARN kr_synthetic: 0행";

describe("LogPanel", () => {
  it("값 있음 — 글 그대로, 이름 있는 영역 '{label} (스크롤)'·Tab 정지점·고정폭 12/20·화면 바탕 상자·포커스 링, 강조 파랑 없음", () => {
    render(<LogPanel label="수집 오류·경고 로그" text={LOG} />);
    const box = screen.getByRole("region", { name: "수집 오류·경고 로그 (스크롤)" });
    expect(box.tagName).toBe("PRE");
    // 공백·줄바꿈까지 받은 글 그대로(다듬지 않음).
    expect(box.textContent).toBe(LOG);
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(tokens(box)).toEqual(
      expect.arrayContaining([
        "whitespace-pre-wrap", "overflow-auto", "font-mono", "text-micro", "leading-5",
        "rounded-control", "border", "border-border", "bg-bg", "p-3", "text-text-2",
        "focus-visible:outline-2", "focus-visible:outline-focus",
      ]),
    );
    expect(box.className).not.toMatch(/accent/);
    // 12px 하한 — text-xs·임의 글자 크기를 쓰지 않음.
    expect(box.className).not.toMatch(/text-xs|text-\[\d+px\]/);
    // 복사 단추는 부르는 쪽 패널 머리 — 상자 안에 단추·링크가 없음.
    expect(box.querySelector("button, a")).toBeNull();
  });

  it("tone='muted'면 한 단계 옅은 글(text-3), 기본은 text-2", () => {
    render(<LogPanel label="AI 입력 원본" text="입력" tone="muted" />);
    const box = screen.getByRole("region", { name: "AI 입력 원본 (스크롤)" });
    expect(tokens(box)).toContain("text-text-3");
    expect(tokens(box)).not.toContain("text-text-2");
  });

  it("빈 글 — 상자·영역 없이 emptyText 한 줄(기본 '내용이 없습니다.', 공백만인 글도 빈 글)", () => {
    const { container, unmount } = render(<LogPanel label="수집 오류·경고 로그" text="" />);
    expect(screen.getByText("내용이 없습니다.")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelector("[tabindex]")).toBeNull();
    unmount();
    const custom = render(<LogPanel label="수집 오류·경고 로그" text={"  \n\t"} emptyText="최근 24시간 동안 오류·경고가 없습니다." />);
    expect(screen.getByText("최근 24시간 동안 오류·경고가 없습니다.")).toBeTruthy();
    expect(custom.container.querySelector("pre")).toBeNull();
    expect(screen.queryByText("내용이 없습니다.")).toBeNull();
  });

  it("모름(null·undefined) — '—'(읽기 '값 없음') + 사유, 0이나 빈 상자를 만들지 않음", () => {
    const { container, unmount } = render(<LogPanel label="토스 조회 결과" text={null} />);
    expect(screen.getByText("—").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByText("값 없음")).toBeTruthy();
    expect(screen.getByText("받지 못함")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.textContent).not.toContain("0");
    expect(container.textContent).not.toContain("내용이 없습니다.");
    unmount();
    const reason = render(<LogPanel label="토스 조회 결과" text={undefined} emptyReason="수집기에 닿지 못함" />);
    expect(screen.getByText("수집기에 닿지 못함")).toBeTruthy();
    expect(screen.queryByText("받지 못함")).toBeNull();
    expect(reason.container.querySelector("pre")).toBeNull();
  });

  it("긴 글 — 높이 한도(sm 20rem·md 30rem 기본·lg 40rem) 안에서 상자 스크롤, 줄바꿈 anywhere(기본)·word(낱말 사이 — 한국어도)", () => {
    const long = Array.from({ length: 200 }, (_, i) => `${i + 1}행 https://source.example/very/long/path/without/spaces/${"x".repeat(80)}`).join("\n");
    const heights: [("sm" | "md" | "lg" | undefined), string][] = [
      [undefined, "max-h-[30rem]"],
      ["sm", "max-h-[20rem]"],
      ["md", "max-h-[30rem]"],
      ["lg", "max-h-[40rem]"],
    ];
    for (const [maxHeight, cls] of heights) {
      const { unmount } = render(<LogPanel label="AI 리포트 원문" text={long} maxHeight={maxHeight} />);
      const box = screen.getByRole("region", { name: "AI 리포트 원문 (스크롤)" });
      expect(tokens(box)).toContain(cls);
      expect(tokens(box).filter((token) => token.startsWith("max-h-"))).toHaveLength(1);
      expect(tokens(box)).toContain("overflow-auto");
      expect(box.textContent).toBe(long);
      unmount();
    }
    const anywhere = render(<LogPanel label="수집 오류·경고 로그" text={long} />);
    const box = screen.getByRole("region", { name: "수집 오류·경고 로그 (스크롤)" });
    expect(tokens(box)).toContain("wrap-anywhere");
    // 예전 break-all(짧은 낱말까지 아무 데서나 꺾음)은 쓰지 않습니다.
    expect(tokens(box)).not.toContain("break-all");
    expect(tokens(box)).not.toContain("break-keep");
    anywhere.unmount();
    render(<LogPanel label="AI 리포트 원문" text="한국어 문단은 낱말 사이에서 꺾습니다." wrap="word" />);
    const word = screen.getByRole("region", { name: "AI 리포트 원문 (스크롤)" });
    expect(tokens(word)).toEqual(expect.arrayContaining(["break-keep", "wrap-break-word"]));
    expect(tokens(word)).not.toContain("wrap-anywhere");
  });
});
