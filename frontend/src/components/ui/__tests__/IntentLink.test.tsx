/**
 * 가리킬 때만 미리 받는 링크(ui/IntentLink — ADR 0047 결정 5, 2026-11-22 사용자 결정 D-4).
 *  - 처음에는 next/link에 prefetch=false, 마우스 올림·키보드 초점·터치 시작 가운데 하나가 오면 prefetch=null(Next 기본)
 *  - 호출한 쪽이 prefetch=false를 주면 의도를 보여도 false, true를 주면 의도 뒤 true
 *  - 넘겨받은 onMouseEnter·onFocus·onTouchStart는 그대로 불림
 *  - 화면 소스(시험 밖)는 next/link를 직접 가져오지 않음 — 이 부품만 감쌈(새 링크가 보이는 것만으로 미리 받기를 되살리지 않게)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ prefetch, children, href, ...rest }: { prefetch?: boolean | null; children: ReactNode; href: string }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

import IntentLink from "../IntentLink";

afterEach(() => cleanup());

const link = () => screen.getByRole("link", { name: "매크로" });

describe("미리 받기 속성", () => {
  it("처음에는 미리 받지 않는다(prefetch=false)", () => {
    render(<IntentLink href="/macro">매크로</IntentLink>);
    expect(link().dataset.prefetch).toBe("false");
  });

  it.each([
    ["마우스 올림", (el: HTMLElement) => fireEvent.mouseEnter(el)],
    ["키보드 초점", (el: HTMLElement) => fireEvent.focus(el)],
    ["터치 시작", (el: HTMLElement) => fireEvent.touchStart(el)],
  ])("%s 뒤에는 Next 기본 동작(prefetch=null)으로 돌아간다", (_name, intent) => {
    render(<IntentLink href="/macro">매크로</IntentLink>);
    intent(link());
    expect(link().dataset.prefetch).toBe("null");
  });

  it("호출한 쪽의 prefetch=false는 의도를 보여도 그대로, true는 의도 뒤 true", () => {
    const { rerender } = render(
      <IntentLink href="/macro" prefetch={false}>
        매크로
      </IntentLink>,
    );
    fireEvent.mouseEnter(link());
    expect(link().dataset.prefetch).toBe("false");
    rerender(
      <IntentLink href="/macro" prefetch>
        매크로
      </IntentLink>,
    );
    expect(link().dataset.prefetch).toBe("true");
  });

  it("넘겨받은 처리기를 그대로 부른다", () => {
    const onMouseEnter = vi.fn();
    const onFocus = vi.fn();
    const onTouchStart = vi.fn();
    render(
      <IntentLink href="/macro" onMouseEnter={onMouseEnter} onFocus={onFocus} onTouchStart={onTouchStart}>
        매크로
      </IntentLink>,
    );
    fireEvent.mouseEnter(link());
    fireEvent.focus(link());
    fireEvent.touchStart(link());
    expect([onMouseEnter, onFocus, onTouchStart].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });
});

describe("화면 소스의 링크", () => {
  const SRC = resolve(__dirname, "../../..");
  const files = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "__tests__" && name !== "node_modules") files(path, out);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        out.push(path);
      }
    }
    return out;
  };

  it("next/link를 직접 가져오는 곳은 IntentLink 하나뿐이다", () => {
    const direct = files(SRC)
      .filter((path) => /from\s+["']next\/link["']/.test(readFileSync(path, "utf8")))
      .map((path) => relative(SRC, path));
    expect(direct).toEqual(["components/ui/IntentLink.tsx"]);
  });
});
