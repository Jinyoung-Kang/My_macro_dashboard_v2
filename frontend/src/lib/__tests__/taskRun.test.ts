/**
 * 태스크 결과 표시(lib/taskRun) — 기호 글자 대신 톤과 글. 모르는 상태는 '알 수 없음'(중립)으로, 지어내지 않는다.
 * (끝난 실행 가리기·기다리기는 src/lib/__checks__/taskRun.check.mts가 고정)
 */
import { describe, expect, it } from "vitest";

import { taskDoneMessage, taskStatusView } from "@/lib/taskRun";

describe("taskStatusView", () => {
  it("정상·데이터 없음·오류는 각자의 톤과 글", () => {
    expect(taskStatusView("ok")).toEqual({ tone: "ok", label: "정상" });
    expect(taskStatusView("empty")).toEqual({ tone: "warn", label: "데이터 없음" });
    expect(taskStatusView("error")).toEqual({ tone: "danger", label: "오류" });
  });

  it("모르는 상태(interrupted 같은 새 상태)·없음·객체 기본 키는 '알 수 없음'(중립) — 정상으로 지어내지 않는다", () => {
    for (const status of ["interrupted", "", null, undefined, "constructor", "toString"]) {
      expect(taskStatusView(status)).toEqual({ tone: "neutral", label: "알 수 없음" });
    }
  });
});

describe("taskDoneMessage", () => {
  it("'<태스크> 완료 — <결과 설명>'과 결과의 톤 — 기호 글자를 넣지 않는다", () => {
    expect(taskDoneMessage("macro_collected", { status: "ok", detail: "12건 저장" }))
      .toEqual({ text: "macro_collected 완료 — 12건 저장", tone: "ok" });
    expect(taskDoneMessage("sec_13f", { status: "error", detail: null })).toEqual({ text: "sec_13f 완료", tone: "danger" });
    // 타입에 없는 상태가 와도(수집기가 먼저 바뀐 경우) 중립
    expect(taskDoneMessage("x", { status: "weird" as never, detail: "" })).toEqual({ text: "x 완료", tone: "neutral" });
  });
});
