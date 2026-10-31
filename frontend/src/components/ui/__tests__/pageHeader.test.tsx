/**
 * 화면 머리(ui/index.tsx의 PageHeader) — 명세 docs/specs/2026-10-31-v2-coinbase-ui.md §7-1.
 *  - 화면마다 h1이 하나이고 그 이름이 제목 글이다(낭독기의 제목 목록·탭 제목과 같은 글)
 *  - 설명은 제목 바로 아래 보조 글, 덧붙일 줄(children)은 설명 아래, 동작(신선도·고르기)은 제목 묶음 밖의 따로 된 칸
 *  - 설명·동작을 주지 않으면 빈 칸을 그리지 않는다
 *  - 화면 소스에 예전 h1 모양(text-xl font-bold — 화면마다 따로 적던 것)이 다시 들어오지 않는다
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PageHeader } from "@/components/ui";

afterEach(() => cleanup());

describe("PageHeader", () => {
  it("h1 하나에 제목, 아래에 설명과 덧붙인 줄, 동작은 제목 묶음 밖", () => {
    render(
      <PageHeader title="시장 국면" description="성장·신용 축 × 유동성 축" actions={<button type="button">새로고침</button>}>
        <p>덧붙인 안내</p>
      </PageHeader>,
    );
    const heading = screen.getByRole("heading", { level: 1, name: "시장 국면" });
    const header = heading.closest("header") as HTMLElement;
    expect(within(header).getAllByRole("heading")).toHaveLength(1);
    const titleBlock = heading.parentElement as HTMLElement;
    expect(within(titleBlock).getByText("성장·신용 축 × 유동성 축")).toBeTruthy();
    expect(within(titleBlock).getByText("덧붙인 안내")).toBeTruthy();
    const action = screen.getByRole("button", { name: "새로고침" });
    expect(titleBlock.contains(action)).toBe(false);
    expect(header.contains(action)).toBe(true);
    // 보조 글은 본문색이 아니라 보조색(text-2) — 제목과 위계를 나눕니다.
    expect(screen.getByText("성장·신용 축 × 유동성 축").className).toContain("text-text-2");
  });

  it("설명·동작이 없으면 제목만 — 빈 칸을 그리지 않는다", () => {
    const { container } = render(<PageHeader title="더보기" />);
    const header = container.querySelector("header") as HTMLElement;
    expect(header.children).toHaveLength(1);
    expect((header.firstElementChild as HTMLElement).children).toHaveLength(1);
  });

  it("화면 소스는 h1을 직접 꾸미지 않고 PageHeader를 쓴다(예전 text-xl font-bold h1이 다시 들어오지 않음)", () => {
    const root = join(__dirname, "..", "..", "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__") walk(path);
        } else if (/\.tsx$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files.filter((path) => /<h1 className="text-xl font-bold/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });
});
