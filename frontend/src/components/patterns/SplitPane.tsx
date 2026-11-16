"use client";

import { useId, useState, type JSX, type ReactNode } from "react";

// 칸 틀 클래스(ENTITY_FRAME·ENTITY_FRAME_LEFT)는 정보 검색 대상 화면과 함께 쓰므로 순수 모듈 components/ui/classes.ts에 있습니다 — 정보 검색이
// 이 배럴을 거치지 않고 가져가게(겉모습 고정 — components/screens/search/__tests__/entityGridPin.test.ts).
import { ENTITY_FRAME, ENTITY_FRAME_LEFT, FOCUS_RING } from "@/components/ui/classes";
import { ChevronDownIcon } from "@/components/ui/icons";

/** 칸 하나 — 안의 패널을 위에서 아래로 12px(lg 16px) 사이로 쌓습니다(명세 §3-7 패널 사이 8~12px — 칸 틀의 칸 사이와 같은 값). */
const COLUMN = "flex min-w-0 flex-col gap-3 lg:gap-4";

/**
 * 왼쪽 칸 펼치기 단추(lg 미만에서만 — lg 이상은 display:none이라 격자 칸을 차지하지 않음): 칸 폭 전체·높이 44px(좁은 화면 누르는 자리), 기본 단추 모양
 * (조작 바탕·1px 경계 — 고대비에서도 경계가 남음, hover는 경계를 진하게). 글은 왼쪽, 방향 표시(장식 화살표)는 오른쪽 — 펼치면 위를 봅니다.
 * 클래스 이름은 통째로 적습니다(Tailwind는 소스의 글자 그대로를 훑음).
 */
const TOGGLE = `flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-control border border-border bg-control-fill px-3 py-2 text-left text-sm font-medium text-text hover:border-border-strong motion-safe:transition-colors motion-safe:duration-150 lg:hidden ${FOCUS_RING}`;

/**
 * 칸 틀(작업대 실행 명세 §6 SplitPane, P4 — 상세 화면 셋): 왼쪽 속성 · 가운데 탭 · 오른쪽 연결·출처.
 *
 * - 넓은 화면은 정보 검색 대상 화면과 같은 틀입니다(ENTITY_FRAME — 바꾸면 정보 검색 겉모습이 바뀌므로 entityGridPin.test가 막음): xl(1280) 이상 세 칸
 *   (13rem · 나머지 · 18rem), lg(1024~1279)는 두 칸이고 오른쪽 칸이 가운데 아래로 갑니다(왼쪽 칸이 두 줄을 차지). lg 미만은 한 칸으로 위에서 아래로
 *   왼쪽 → 가운데 → 오른쪽입니다.
 * - 읽는 차례·Tab 차례는 늘 왼쪽 → 가운데 → 오른쪽이고 자리만 바뀝니다. 새 랜드마크를 만들지 않습니다 — 칸 안 패널 제목(h2)이 구조입니다.
 * - 칸 사이와 칸 안 패널 사이는 12px(lg 16px).
 * - `collapseLeft`(상세 화면 셋이 씀 — 2026-11-16 결정 2): lg 미만에서 왼쪽 칸을 처음에 접고 그 자리에 펼치기 단추 하나(44px — '{이름} 펼치기'·
 *   '{이름} 접기', aria-expanded·aria-controls)를 둡니다. 휴대폰 첫 화면에 속성 대신 가운데 탭·차트가 오게 하려는 것이고, 차례는 그대로입니다(단추 →
 *   왼쪽 칸 → 가운데 → 오른쪽 — DOM·Tab·읽기 차례가 보이는 차례와 같음). 접은 칸은 display:none일 뿐 마운트된 채라 요청 시점·횟수가 같습니다.
 *   lg 이상은 상태와 상관없이 늘 칸을 보이고 단추를 숨깁니다(넓은 화면 겉모습·정보 검색 틀 그대로). 주지 않으면 지금처럼 세 칸만.
 */
export function SplitPane({
  left,
  children,
  right,
  collapseLeft,
}: {
  left: ReactNode;
  children: ReactNode;
  right: ReactNode;
  /** lg 미만에서 왼쪽 칸을 접는 단추의 대상 이름(예 '핵심 지표·회사 개요') — 단추 글은 '{이름} 펼치기'·'{이름} 접기'. */
  collapseLeft?: string;
}): JSX.Element {
  const leftId = useId();
  const [open, setOpen] = useState(false);
  const collapsed = Boolean(collapseLeft) && !open;
  return (
    <div className={`${COLUMN} ${ENTITY_FRAME}`}>
      {collapseLeft ? (
        <button type="button" aria-expanded={open} aria-controls={leftId} onClick={() => setOpen((value) => !value)} className={TOGGLE}>
          <span className="min-w-0 break-keep wrap-anywhere">
            {collapseLeft} {open ? "접기" : "펼치기"}
          </span>
          <ChevronDownIcon size={16} className={`text-text-2 ${open ? "rotate-180" : ""}`} />
        </button>
      ) : null}
      <div id={collapseLeft ? leftId : undefined} className={`${COLUMN} ${ENTITY_FRAME_LEFT}${collapsed ? " max-lg:hidden" : ""}`}>
        {left}
      </div>
      <div className={COLUMN}>{children}</div>
      <div className={COLUMN}>{right}</div>
    </div>
  );
}
