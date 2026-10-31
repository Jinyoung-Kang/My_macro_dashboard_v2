/**
 * 입력칸 모양(components/ui/classes.ts의 inputClasses·FOCUS_RING, ui Select) — 명세 docs/specs/2026-10-31-v2-coinbase-ui.md D9.
 *  - 입력칸 테두리는 border-strong(3:1), 포커스는 2px 바깥선 — 테두리 색만 바꾸는 예전 표시(1.9:1)로 돌아가지 않는다
 *  - 공용 Select는 라벨과 이어지고, 화살표는 장식 아이콘(aria-hidden)이다
 *  - 화면 소스에 예전 모양(outline-hidden + focus:border-accent)이 다시 들어오지 않는다
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FOCUS_RING, inputClasses, Select } from "@/components/ui";

afterEach(() => cleanup());

describe("inputClasses", () => {
  it("테두리 border-strong·바탕 surface·2px 포커스 링, 좁은 화면은 두 크기 모두 44px", () => {
    for (const size of ["md", "sm"] as const) {
      const classes = inputClasses(size).split(/\s+/);
      expect(classes).toContain("border-border-strong");
      expect(classes).toContain("bg-surface");
      expect(classes).toContain("min-h-11");
      for (const ring of FOCUS_RING.split(/\s+/)) expect(classes).toContain(ring);
      expect(classes).not.toContain("outline-hidden");
    }
    expect(FOCUS_RING).toContain("focus-visible:outline-2");
  });
});

describe("Select", () => {
  it("라벨로 찾을 수 있고, 고르면 값이 넘어가며, 화살표는 장식이다", () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select
        label="엔진"
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "자동 탐색" },
          { value: "b", label: "Claude" },
        ]}
      />,
    );
    const select = screen.getByLabelText("엔진") as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.className).toContain("appearance-none");
    expect(select.className).toContain("border-border-strong");
    fireEvent.change(select, { target: { value: "b" } });
    expect(onChange).toHaveBeenCalledWith("b");
    const arrow = container.querySelector("svg") as SVGSVGElement;
    expect(arrow.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("화면 소스", () => {
  it("예전 입력칸 모양(outline-hidden + focus:border-accent)을 쓰는 곳이 없다", () => {
    const root = resolve(__dirname, "../../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "__checks__") walk(path);
        } else if (/\.tsx?$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((path) => !path.endsWith("classes.ts"))
      .filter((path) => /outline-hidden[^"`]*focus:border-accent/.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
  });
});
