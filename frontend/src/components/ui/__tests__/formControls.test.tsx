/**
 * 입력칸 모양(components/ui/classes.ts의 inputClasses·FOCUS_RING, ui Select) — 명세 docs/specs/2026-10-31-v2-coinbase-ui.md D9.
 *  - 입력칸 테두리는 border-strong(3:1), 포커스는 2px 바깥선 — 테두리 색만 바꾸는 예전 표시(1.9:1)로 돌아가지 않는다
 *  - 공용 Select는 라벨과 이어지고, 화살표는 장식 아이콘(aria-hidden)이다
 *  - 날 고르기 상자(NativeSelect)도 같은 모양 — 화면 소스의 select는 이 둘을 거친다(브라우저 기본 화살표가 섞이지 않음)
 *  - 화면 소스에 예전 모양(outline-hidden + focus:border-accent)이 다시 들어오지 않는다
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FOCUS_RING, inputClasses, NativeSelect, Select } from "@/components/ui";

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
    // 넓은 화면 높이 = 줄 높이 + 여백 + 경계라 줄 높이를 글자 단계로 고정한다 — sm은 caption(13/18 → 24px, sm 단추와 같음). 임의 크기
    // text-[13px]는 부모 줄 높이(19.5px)를 물려받아 25.5px가 됐다.
    expect(inputClasses("sm").split(/\s+/)).toEqual(expect.arrayContaining(["text-caption", "lg:min-h-6", "lg:py-0.5"]));
    expect(inputClasses("sm")).not.toContain("text-[13px]");
    expect(inputClasses("md").split(/\s+/)).toEqual(expect.arrayContaining(["text-sm", "lg:min-h-[30px]", "lg:py-1"]));
    // 인증 화면 입력칸(lg) — 같은 테두리·포커스 링, 좁은 화면 44px·넓은 화면 큰 조작 40px(작업대 실행 명세 §3-7)
    const large = inputClasses("lg").split(/\s+/);
    expect(large).toEqual(expect.arrayContaining(["border-border-strong", "bg-surface", "min-h-11", "lg:min-h-10", ...FOCUS_RING.split(/\s+/)]));
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
    // 묶음을 주지 않으면 optgroup 없이 받은 차례 그대로.
    expect(select.querySelector("optgroup")).toBeNull();
    expect(Array.from(select.options).map((option) => option.text)).toEqual(["자동 탐색", "Claude"]);
  });

  it("선택지에 묶음(group)을 주면 optgroup — 묶음 없는 항목이 맨 앞, 묶음은 처음 나온 차례, 고른 값의 글은 이름만", () => {
    render(
      <Select
        label="지표 X"
        value="etf:EEM"
        onChange={() => {}}
        options={[
          { value: "all", label: "전체" },
          { value: "fred:DGS10", label: "미국채 10년물", group: "금리" },
          { value: "etf:SPY", label: "S&P 500 (SPY)", group: "주식" },
          { value: "etf:TLT", label: "미국 장기국채 (TLT)", group: "채권" },
          { value: "etf:EEM", label: "신흥국 주식 (EEM)", group: "주식" },
        ]}
      />,
    );
    const select = screen.getByLabelText("지표 X") as HTMLSelectElement;
    expect(Array.from(select.querySelectorAll("optgroup")).map((group) => [group.label, Array.from(group.querySelectorAll("option")).map((option) => option.value)])).toEqual([
      ["금리", ["fred:DGS10"]],
      ["주식", ["etf:SPY", "etf:EEM"]],
      ["채권", ["etf:TLT"]],
    ]);
    expect(select.options[0].value).toBe("all");
    expect(select.options[0].parentElement).toBe(select);
    expect(select.value).toBe("etf:EEM");
    expect(select.options[select.selectedIndex].text).toBe("신흥국 주식 (EEM)");
  });
});

describe("NativeSelect", () => {
  it("이름은 부르는 쪽(aria-label)이 붙이고, 입력칸 모양·브라우저 화살표 없음·장식 화살표 아이콘", () => {
    const onChange = vi.fn();
    const { container } = render(
      <NativeSelect aria-label="자동 갱신 간격" value="60" onChange={(event) => onChange(event.target.value)} inputSize="sm">
        <option value="0">수동</option>
        <option value="60">1분</option>
      </NativeSelect>,
    );
    const select = screen.getByRole("combobox", { name: "자동 갱신 간격" }) as HTMLSelectElement;
    expect(select.className).toContain("appearance-none");
    expect(select.className.split(/\s+/)).toEqual(expect.arrayContaining(inputClasses("sm").split(/\s+/)));
    fireEvent.change(select, { target: { value: "0" } });
    expect(onChange).toHaveBeenCalledWith("0");
    expect((container.querySelector("svg") as SVGSVGElement).getAttribute("aria-hidden")).toBe("true");
    // 감싼 칸은 기본 inline-flex — inline-block이면 칸 안의 줄 상자 때문에 sm(24px) 고르기의 칸이 25px로 늘었습니다(놓인 글의 줄 높이에 따라).
    expect((select.parentElement as HTMLElement).className.split(/\s+/)).toEqual(expect.arrayContaining(["relative", "inline-flex"]));
  });

  // QA-463: 입력칸 모양(inputClasses)이 넓은 화면 가로 여백을 lg 변형(lg:px-*)으로 따로 두면, Tailwind는 변형 규칙을 변형 없는 규칙보다
  // 뒤(미디어 쿼리 안)에 내보내므로 화살표 자리로 비운 pr-8(32px)이 lg부터 lg:px-*(10·8px)에 덮여 고른 글 끝이 화살표 아이콘 밑으로 들어갑니다.
  // 같은 변형 안에서는 padding-right가 padding-inline 뒤에 나오므로(@tailwindcss/node 4.3.5 컴파일로 확인), 가로 여백을 두는 폭 변형마다
  // 같은 변형의 pr-8이 있어야 모든 폭에서 오른쪽 32px이 남습니다. 수정 전(재현 커밋에서는 it.fails)에는 md·sm의 lg: 변형에 pr-8이 없었습니다.
  it("모든 폭에서 화살표 자리(오른쪽 32px)를 비운다 — 가로 여백(px)을 두는 폭 변형마다 같은 변형의 pr-8 (QA-463)", () => {
    for (const inputSize of ["md", "sm", "lg"] as const) {
      render(
        <NativeSelect aria-label={`크기 ${inputSize}`} inputSize={inputSize}>
          <option value="a">Claude Opus 4.1 (기본 엔진)</option>
        </NativeSelect>,
      );
      const classes = screen.getByRole("combobox", { name: `크기 ${inputSize}` }).className.split(/\s+/);
      const prefixes = new Set(
        classes.filter((name) => /^(?:[a-z0-9]+:)*px-/.test(name)).map((name) => name.slice(0, name.lastIndexOf("px-"))),
      );
      expect(prefixes.size).toBeGreaterThan(0);
      for (const prefix of prefixes) expect(classes, `${inputSize} ${prefix || "(변형 없음)"}`).toContain(`${prefix}pr-8`);
    }
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

  it("날 <select>는 공용 조각(ui/index.tsx의 Select·NativeSelect) 안에만", () => {
    const root = resolve(__dirname, "../../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__" && name !== "__checks__") walk(path);
        } else if (/\.tsx$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(root);
    const raw = files.filter((path) => /<select\b/.test(readFileSync(path, "utf8"))).map((path) => relative(root, path)).sort();
    expect(raw).toEqual(["components/ui/index.tsx"]);
  });
});
