/**
 * 화면 아이콘(components/ui/icons.tsx) — 이모지 대신 쓰는 인라인 SVG.
 *  - 내보내는 이름 목록이 고정이다(새 아이콘은 이 목록과 함께 넣는다)
 *  - 모든 아이콘은 기본이 장식: aria-hidden svg, 색은 글자색(currentColor), <title> 없음
 *  - label을 주면 이름 있는 그림(role="img" + 그 이름) — <title>은 여전히 없어 감싼 링크의 글에 섞이지 않는다
 *  - 상태 점은 테두리로 칠한 장식, 상태 글은 아이콘·sr-only 머리말·글을 따로 둔다
 *  - 셸의 아이콘(shell/icons.tsx)은 같은 아이콘을 다시 내보낸다(두 벌 아님)
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import * as shellIcons from "@/components/shell/icons";
import * as icons from "../icons";
import { StatusDot, StatusIcon, StatusText, type IconProps } from "../icons";

afterEach(() => cleanup());

const ICONS = [
  "AlertTriangleIcon",
  "BellIcon",
  "BellOffIcon",
  "BuildingIcon",
  "CheckCircleIcon",
  "CheckIcon",
  "ChevronDownIcon",
  "ChevronRightIcon",
  "ChevronUpIcon",
  "CircleDashedIcon",
  "ClockIcon",
  "ExternalLinkIcon",
  "InfoIcon",
  "LandmarkIcon",
  "LockIcon",
  "MinusIcon",
  "PersonIcon",
  "PlusIcon",
  "RefreshIcon",
  "SearchIcon",
  "SkipIcon",
  "SpinnerIcon",
  "StarIcon",
  "TagIcon",
  "XCircleIcon",
  "XIcon",
] as const;

type IconComponent = (props: IconProps) => React.ReactNode;
const iconOf = (name: (typeof ICONS)[number]) => (icons as unknown as Record<string, IconComponent>)[name];

describe("내보내는 이름", () => {
  it("아이콘 목록과 바탕 SVG·상태 점·상태 글·첫 줄 아이콘 칸이 전부다", () => {
    expect(Object.keys(icons).sort()).toEqual([...ICONS, "IconBase", "LineIcon", "StatusDot", "StatusIcon", "StatusText"].sort());
  });

  it("셸의 아이콘 모듈은 탭 아이콘 말고는 ui 아이콘을 그대로 다시 내보낸다", () => {
    expect(shellIcons.SearchIcon).toBe(icons.SearchIcon);
    expect(shellIcons.BellIcon).toBe(icons.BellIcon);
    expect(shellIcons.ChevronRightIcon).toBe(icons.ChevronRightIcon);
    expect(typeof shellIcons.TabIcon).toBe("function");
  });
});

describe("장식 아이콘", () => {
  it.each(ICONS)("%s — aria-hidden svg, 글자색, 제목 없음", (name) => {
    const Icon = iconOf(name);
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.querySelector("title")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("크기를 주면 그 크기, 없으면 아이콘마다의 기본 크기", () => {
    const { container } = render(
      <>
        <icons.AlertTriangleIcon size={12} />
        <icons.InfoIcon />
        <icons.BellIcon />
      </>,
    );
    const [small, normal, bell] = [...container.querySelectorAll("svg")];
    expect(small.getAttribute("width")).toBe("12");
    expect(normal.getAttribute("width")).toBe("16");
    expect(bell.getAttribute("width")).toBe("18");
  });

  it("종(알림) — 기본은 선만(상단바와 같음), filled면 종을 글자색으로 채움, 끈 종은 사선이 그어진 모양(사용자 요청 2026-11-15)", () => {
    const { container } = render(
      <>
        <icons.BellIcon />
        <icons.BellIcon filled />
        <icons.BellOffIcon />
      </>,
    );
    const [plain, filled, off] = [...container.querySelectorAll("svg")];
    expect(plain.querySelector("path")?.getAttribute("fill")).toBeNull();
    expect(filled.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
    expect(off.querySelector('[data-part="slash"]')).toBeTruthy();
    expect(plain.querySelector('[data-part="slash"]')).toBeNull();
  });

  it("별(관심 대상) — 등록 전은 선만, filled면 별을 글자색으로 채움(SVG 바탕은 그대로 fill=none)", () => {
    const { container } = render(
      <>
        <icons.StarIcon />
        <icons.StarIcon filled />
      </>,
    );
    const [empty, filled] = [...container.querySelectorAll("svg")];
    expect(empty.getAttribute("fill")).toBe("none");
    expect(empty.querySelector("path")?.getAttribute("fill")).toBeNull();
    expect(filled.getAttribute("fill")).toBe("none");
    expect(filled.querySelector("path")?.getAttribute("fill")).toBe("currentColor");
  });
});

describe("이름 있는 아이콘(label)", () => {
  it("role=img와 그 이름 — aria-hidden도 <title>도 없다", () => {
    render(
      <a href="/ai/report">
        AI 종합 분석
        <icons.LockIcon label="유료 등급 기능" size={14} />
      </a>,
    );
    const img = screen.getByRole("img", { name: "유료 등급 기능" });
    expect(img.getAttribute("aria-hidden")).toBeNull();
    expect(img.querySelector("title")).toBeNull();
    // 감싼 링크의 글에 아이콘 이름이 섞이지 않는다(글로 메뉴를 비교하는 곳이 그대로 통과)
    expect(screen.getByRole("link").textContent).toBe("AI 종합 분석");
  });
});

describe("상태 점·상태 글", () => {
  it("상태 점은 장식 — 테두리를 글자색으로 칠하고 톤 글자색을 쓴다", () => {
    const { container } = render(<StatusDot tone="ok" />);
    const dot = container.firstElementChild as HTMLElement;
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.className).toContain("border-current");
    expect(dot.className).toContain("text-ok");
  });

  it("상태 글은 글 span을 따로 두고, 주의·오류에는 sr-only 머리말이 붙는다", () => {
    render(
      <>
        <StatusText tone="warn">이전 값</StatusText>
        <StatusText tone="danger">실패</StatusText>
        <StatusText tone="ok">정상</StatusText>
      </>,
    );
    const warn = screen.getByText("이전 값");
    expect(warn.tagName).toBe("SPAN");
    expect(warn.parentElement?.className).toContain("text-warn");
    expect(warn.parentElement?.textContent).toBe("주의: 이전 값");
    expect(warn.parentElement?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByText("실패").parentElement?.textContent).toBe("오류: 실패");
    expect(screen.getByText("정상").parentElement?.textContent).toBe("정상");
  });

  it("colorText={false}면 글은 놓인 자리의 색, 아이콘만 톤 색 — iconSize로 아이콘 크기", () => {
    render(
      <p className="text-text-3">
        <StatusText tone="warn" colorText={false} iconSize={12}>표본이 적습니다</StatusText>
      </p>,
    );
    const status = screen.getByText("표본이 적습니다").parentElement as HTMLElement;
    expect(status.className).not.toContain("text-warn");
    const icon = status.querySelector("svg") as SVGSVGElement;
    expect(icon.getAttribute("width")).toBe("12");
    expect(icon.closest(".text-warn")).not.toBeNull();
    expect(status.textContent).toBe("주의: 표본이 적습니다");
  });

  it("상태 아이콘 — 톤 색 아이콘(장식) + sr-only 뜻 글 + 마우스 설명, 아이콘을 바꿀 수 있다", () => {
    const { container } = render(
      <>
        <StatusIcon tone="danger" label="오류" />
        <StatusIcon tone="ok" label="인증됨" icon={<icons.CheckIcon size={16} />} />
      </>,
    );
    const [error, verified] = [...container.children] as HTMLElement[];
    expect(error.className).toContain("text-danger");
    expect(error.getAttribute("title")).toBe("오류");
    expect(error.textContent).toBe("오류");
    expect(screen.getByText("오류").className).toContain("sr-only");
    expect(error.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(verified.className).toContain("text-ok");
    expect(verified.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByText("인증됨").className).toContain("sr-only");
  });

  it("icon={false}면 아이콘 없이 글만, 다른 아이콘·머리말로 바꿀 수 있다", () => {
    render(
      <>
        <StatusText tone="neutral" icon={false}>키 없음</StatusText>
        <StatusText tone="neutral" icon={<icons.SkipIcon size={14} />} srPrefix="건너뜀: ">비교 안 함</StatusText>
      </>,
    );
    expect(screen.getByText("키 없음").parentElement?.querySelector("svg")).toBeNull();
    const skipped = screen.getByText("비교 안 함").parentElement as HTMLElement;
    expect(skipped.querySelectorAll("svg")).toHaveLength(1);
    expect(skipped.textContent).toBe("건너뜀: 비교 안 함");
  });
});
