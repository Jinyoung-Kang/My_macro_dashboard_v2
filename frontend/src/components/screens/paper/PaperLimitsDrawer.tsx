"use client";

import { useState, type JSX } from "react";

import { buttonClasses, SourceLine } from "@/components/ui";
import { Drawer } from "@/components/ui/Drawer";
import { CLAUDE2_LIMITS } from "@/lib/paper";

/**
 * '이 장부의 한계' 서랍(작업대 P6 — 실행 명세 §7-1 '한계 카드는 모든 탭에 되풀이하지 않고 머리 링크 + 서랍'). 머리의 단추 '이 장부의 한계 (n줄)'
 * (aria-haspopup="dialog")가 오른쪽 서랍(공용 ui/Drawer)을 엽니다. 처음에는 닫혀 있습니다(사용자 요청 2026-11-02 — 예전 카드도 접힌 채 시작).
 *
 * 글은 예전 카드 그대로입니다 — 서버가 보낸 한계 목록(번호 목록), 미국 Claude 계좌2가 있으면 그 계좌에만 해당하는 한계(계좌2 명세 §13-3 — 이름 있는
 * 영역 'Claude 계좌2의 한계'), 출처 줄. 닫혀 있으면 내용이 DOM에 없습니다(서랍 규칙) — 줄 수는 단추 이름에 늘 보입니다.
 */
export function PaperLimitsDrawer({
  limits,
  source,
  book2Label,
}: {
  /** 서버 한계 문구(개요 `limits`) — 빈 목록이면 단추를 그리지 않습니다. */
  limits: readonly string[];
  source: string;
  /** 미국 Claude 계좌2의 이름 — 있으면 계좌2 한계 영역을 덧붙입니다(한국 화면·계좌2 없는 개요는 없음). */
  book2Label?: string | null;
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (limits.length === 0) return null;
  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      title="이 장부의 한계"
      width="md"
      trigger={
        <button type="button" className={buttonClasses("minimal", "md")}>
          이 장부의 한계 ({limits.length}줄)
        </button>
      }
    >
      <div id="paper-ledger-limits" className="mt-3 flex flex-col gap-3">
        <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed text-text-2">
          {limits.map((limit) => (
            <li key={limit}>{limit}</li>
          ))}
        </ol>
        {/* 미국 Claude 계좌2가 있으면 그 계좌에만 해당하는 한계(계좌2 명세 §13-3) — 위 목록(계좌1·벤치마크)은 서버 문구 그대로입니다. */}
        {book2Label ? (
          <section aria-label="Claude 계좌2의 한계" className="border-t border-border pt-2">
            <h3 className="text-xs font-semibold text-text">{book2Label}(체결 시점 실험)</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs leading-relaxed text-text-2">
              {CLAUDE2_LIMITS.map((limit) => (
                <li key={limit}>{limit}</li>
              ))}
            </ul>
          </section>
        ) : null}
        <SourceLine>{source}</SourceLine>
      </div>
    </Drawer>
  );
}
