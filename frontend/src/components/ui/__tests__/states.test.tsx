/**
 * 배너·상태 조각(ui/index.tsx의 Banner·Loading·EmptyState·ErrorState) — 명세 docs/specs/2026-10-31-v2-coinbase-ui.md §3.
 *  - 배너 네 톤은 모두 불투명 틴트 바탕(놓인 자리와 섞이지 않음)과 톤 글자색 — 안내(info)만 글이 본문색(강조 파랑 글자 아님, 원칙 A1)
 *  - 배너 앞의 톤 아이콘은 장식(aria-hidden), 주의·심각에는 낭독기용 '주의: ', 글은 톤 글자색 div로 감쌈(글로 찾은 요소가 톤 색을 가짐, 명세 D8 b)
 *  - 신선도: '새로 읽지 못함'·'오래된 저장본'은 경고 알약 + 아이콘(이모지 아님), 평상시는 알약 없이 시계 아이콘 + '수집' + 시각
 *  - 불러오는 중은 도는 아이콘(움직임 줄이기면 멈춤 — motion-safe에서만) + 글, 강조색 점이 아니다
 *  - 오류는 danger 틴트·장식 아이콘·글, 다시 시도는 공용 단추
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Banner, EmptyState, ErrorState, Freshness, Loading } from "@/components/ui";
import { LockIcon } from "@/components/ui/icons";

afterEach(() => cleanup());

describe("Banner", () => {
  it.each([
    ["warn", "bg-warn-tint", "text-warn"],
    ["danger", "bg-danger-tint", "text-danger"],
    ["info", "bg-accent-tint", "text-text"],
    ["ok", "bg-ok-tint", "text-ok"],
  ] as const)("%s — 불투명 틴트 %s와 글자색 %s", (tone, tint, text) => {
    const { container } = render(<Banner tone={tone}>값의 성격 안내</Banner>);
    expect(screen.getByText("값의 성격 안내")).toBeTruthy();
    const classes = (container.firstElementChild as HTMLElement).className.split(/\s+/);
    expect(classes).toContain(tint);
    expect(classes).toContain(text);
    expect(classes.some((name) => /\/10$/.test(name) && name.startsWith("bg-"))).toBe(false);
  });

  it("기본 톤은 주의(warn)이고, 안내 톤은 강조 파랑 글자를 쓰지 않는다", () => {
    const { container } = render(
      <>
        <Banner>기본</Banner>
        <Banner tone="info">안내</Banner>
      </>,
    );
    const [basic, info] = [...container.children] as HTMLElement[];
    expect(basic.className).toContain("text-warn");
    expect(info.className).not.toContain("text-accent");
    expect(info.querySelector(".text-accent")?.textContent ?? "").not.toContain("안내");
  });
});

describe("Banner 톤 아이콘과 감쌈", () => {
  it.each([
    ["warn", "text-warn", "주의: "],
    ["danger", "text-danger", "주의: "],
    ["info", "text-text", ""],
    ["ok", "text-ok", ""],
  ] as const)("%s — 앞에 장식 아이콘 하나, 글을 감싼 div도 %s, 머리말 '%s'", (tone, text, prefix) => {
    const { container } = render(
      <Banner tone={tone}>
        <p>첫 줄</p>
        둘째 줄
      </Banner>,
    );
    const box = container.firstElementChild as HTMLElement;
    const icons = box.querySelectorAll("svg");
    expect(icons).toHaveLength(1);
    expect(icons[0].getAttribute("aria-hidden")).toBe("true");
    // 글로 찾은 요소(그 자체 또는 closest div)가 톤 글자색을 가진다
    expect(screen.getByText("둘째 줄").className).toContain(text);
    expect((screen.getByText("첫 줄").closest("div") as HTMLElement).className).toContain(text);
    expect(box.textContent).toBe(`${prefix}첫 줄둘째 줄`);
  });

  it("안내 톤은 아이콘만 강조색 — 글은 본문색", () => {
    const { container } = render(<Banner tone="info">안내</Banner>);
    const icon = (container.firstElementChild as HTMLElement).querySelector("svg") as SVGSVGElement;
    expect(icon.closest(".text-accent")).not.toBeNull();
    expect(screen.getByText("안내").closest(".text-accent")).toBeNull();
  });

  it("icon={false}면 아이콘 없이, icon을 주면 그 아이콘으로(잠금 같은 이름 있는 그림)", () => {
    const { container } = render(
      <>
        <Banner tone="warn" icon={false}>아이콘 없음</Banner>
        <Banner tone="info" icon={<LockIcon size={16} label="유료 등급 기능" />}>잠긴 기능</Banner>
      </>,
    );
    const [bare, locked] = [...container.children] as HTMLElement[];
    expect(bare.querySelector("svg")).toBeNull();
    expect(bare.textContent).toBe("주의: 아이콘 없음");
    expect(locked.querySelectorAll("svg")).toHaveLength(1);
    expect(screen.getByRole("img", { name: "유료 등급 기능" })).toBeTruthy();
  });
});

describe("Freshness — 이모지 대신 아이콘", () => {
  it("새로 읽지 못함 — 경고 알약(title·role=status는 그 알약), 장식 아이콘, 낭독기용 '주의: '", () => {
    render(<Freshness refreshError="백엔드 API에 연결하지 못했습니다" />);
    const pill = screen.getByText("새로 읽지 못함");
    expect(pill.getAttribute("role")).toBe("status");
    expect(pill.getAttribute("title")).toContain("백엔드 API에 연결하지 못했습니다");
    expect(pill.className).toContain("rounded-full");
    expect(pill.className).toContain("bg-warn-tint");
    expect(pill.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(pill.textContent).toBe("주의: 새로 읽지 못함");
  });

  it("오래된 저장본 — 경고 알약 + 시각, 평상시는 알약 없이 시계 아이콘 + '수집' + 시각", () => {
    const { container, rerender } = render(<Freshness collectedAt="2026-10-11 09:00 KST" stale />);
    const stale = screen.getByText("오래된 저장본");
    expect(stale.className).toContain("bg-warn-tint");
    expect(stale.textContent).toContain("주의: 오래된 저장본");
    rerender(<Freshness collectedAt="2026-10-11 09:00 KST" />);
    const fresh = screen.getByText("수집");
    expect(fresh.className).not.toMatch(/\bbg-|\bborder\b|rounded/);
    expect(fresh.className).toContain("text-text-3");
    expect(fresh.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("상태 조각", () => {
  it("불러오는 중 — 글과 도는 장식 아이콘(motion-safe에서만 돎), 강조색 점 없음", () => {
    const { container } = render(<Loading label="순자산을 불러오는 중…" />);
    expect(screen.getByText("순자산을 불러오는 중…")).toBeTruthy();
    const spinner = container.querySelector("svg") as SVGSVGElement;
    expect(spinner.getAttribute("aria-hidden")).toBe("true");
    expect(spinner.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(container.querySelector(".bg-accent")).toBeNull();
  });

  it("빈 상태 — 점선 상자가 아니라 옅은 바탕의 가운데 글", () => {
    render(<EmptyState message="표시할 데이터가 없습니다." />);
    const box = screen.getByText("표시할 데이터가 없습니다.");
    expect(box.className).not.toContain("border-dashed");
    expect(box.className).toContain("text-center");
  });

  it("오류 — danger 틴트·장식 아이콘·글, 다시 시도를 누르면 onRetry", () => {
    const onRetry = vi.fn();
    const { container } = render(<ErrorState message="읽지 못했습니다." onRetry={onRetry} />);
    expect(screen.getByText("읽지 못했습니다.")).toBeTruthy();
    expect((container.firstElementChild as HTMLElement).className).toContain("bg-danger-tint");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("다시 시도가 없으면 단추도 없다", () => {
    render(<ErrorState message="읽지 못했습니다." />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
