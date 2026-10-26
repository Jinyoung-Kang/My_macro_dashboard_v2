"use client";

import { createContext, useContext } from "react";

/**
 * 읽기 모드(세션 응답의 readMode — auto·store_only). 대시보드 레이아웃이 셸에 넘기고, 셸이 본문 화면에도 내려 줍니다.
 *
 * 좁은 화면에는 왼쪽 내비가 없어 더보기 화면(/more)이 같은 줄을 그립니다 — 옛 사이드바는 좁은 화면의 메뉴 안에서도 이 줄을
 * 보였습니다. 셸 밖(화면만 그리는 테스트)에서는 undefined입니다.
 */
const ReadModeContext = createContext<string | undefined>(undefined);

export function ReadModeProvider({ readMode, children }: { readMode: string | undefined; children: React.ReactNode }) {
  return <ReadModeContext.Provider value={readMode}>{children}</ReadModeContext.Provider>;
}

/** 읽기 모드 한 줄 — store_only면 저장본만 쓴다는 안내를 함께(왼쪽 내비 아래·더보기 화면). */
export function ReadModeNote() {
  const readMode = useContext(ReadModeContext);
  return (
    <div className="text-xs leading-5 text-text-3">
      읽기 모드: <span className="font-semibold text-text-2">{readMode ?? "auto"}</span>
      {readMode === "store_only" && <p className="mt-1">저장본만 사용합니다. 화면이 외부 수집을 기다리지 않습니다.</p>}
    </div>
  );
}
