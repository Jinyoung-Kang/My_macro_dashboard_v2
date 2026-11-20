/**
 * 로그 상자 기본 줄바꿈(anywhere)의 한국어 낱말 — QA-872(작업대 P7 검토에서 찾음).
 *
 * LogPanel 기본 줄바꿈 'anywhere'는 wrap-anywhere만 붙이고 break-keep이 없어, 저장소 상태의 수집 오류·경고 로그(백엔드 글은 한국어 — '■ 지금 실패 중인
 * 태스크 (최근 결과 기준)')처럼 한국어 글을 낱말 가운데(음절 사이)에서 꺾었습니다 — word-break: normal에서는 한글 음절 사이가 모두 줄바꿈 기회라, 패턴 설명의
 * '짧은 낱말은 그대로 둠'은 라틴 글자에만 맞았습니다.
 *
 * 기대: anywhere도 break-keep(한국어 낱말은 낱말 사이에서만) + wrap-anywhere(공백 없는 긴 경로·키·URL은 칸 안에서 아무 데서나). word 꼴은 그대로.
 * 수정 전(재현 커밋에서는 it.fails — 고친 커밋에서 it): "expected [ 'max-h-[30rem]', …(15) ] to include 'break-keep'".
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LogPanel } from "../LogPanel";

afterEach(() => cleanup());

const tokens = (element: HTMLElement) => (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

describe("로그 상자 anywhere 줄바꿈의 한국어 낱말(QA-872)", () => {
  it("anywhere(기본)는 break-keep + wrap-anywhere — 예전 break-all은 쓰지 않음", () => {
    render(<LogPanel label="수집 오류·경고 로그" text={"■ 지금 실패 중인 태스크 (최근 결과 기준)\n  krx_flows: 연결 시간 초과"} />);
    const box = screen.getByRole("region", { name: "수집 오류·경고 로그 (스크롤)" });
    expect(tokens(box)).toContain("break-keep");
    expect(tokens(box)).toContain("wrap-anywhere");
    expect(tokens(box)).not.toContain("break-all");
  });
});
