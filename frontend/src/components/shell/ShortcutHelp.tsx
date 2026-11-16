"use client";

import { Dialog } from "@/components/ui/Dialog";
import { isWideShell } from "@/lib/shellCommands";
import { findScreenFilter, visibleShortcuts, type ShortcutConditions } from "@/lib/shortcuts";

/** 키 글 조각(kbd) — 덮개(surface-2) 위라 글은 text-2, 경계는 border-strong(3:1). */
const KBD = "rounded-sm border border-border-strong px-1.5 font-mono text-xs text-text-2";

/**
 * 지금 조건 — 넓은 화면(왼쪽 메뉴가 보이는 폭)인가, 본문(main#main)에 거르기 칸(data-shell-filter)이 있는가. 도움말 창을 열 때 한 번 셉니다
 * (화면을 옮기면 다음에 열 때 다시 셈).
 */
export function shortcutConditionsNow(): ShortcutConditions {
  return {
    wide: isWideShell(),
    filter: typeof document !== "undefined" && findScreenFilter(document.getElementById("main")) !== null,
  };
}

/**
 * 단축키 도움말 창(작업대 실행 명세 §5 '단축키', P3) — `?`, 계정 메뉴의 '단축키 도움말', 명령 팔레트의 '단축키 도움말' 명령이 엽니다.
 * 줄은 lib/shortcuts의 표에서 가져오고, 지금 쓸 수 없는 줄(좁은 화면의 메뉴 접기, 거르기 칸이 없는 화면의 '/')은 빼고 보입니다. 끝 문장(입력칸에서는
 * 글자로 들어가는 키)도 보이는 줄 가운데 typesInInput 표지가 있는 줄의 키만 표 순서대로 적습니다(QA-563 — 표에서 뺀 키를 다시 꺼내지 않음).
 * 이 창은 보기만 합니다 — 단축키를 바꾸는 설정은 없습니다.
 */
export function ShortcutHelp({
  open,
  onOpenChange,
  isMac,
  conditions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isMac: boolean;
  conditions: ShortcutConditions;
}) {
  const rows = visibleShortcuts(conditions);
  const typedKeys = rows.filter((row) => row.typesInInput).flatMap((row) => (isMac ? row.keys.mac : row.keys.other));
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="단축키" size="md">
      <table className="mt-3 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-text-2">
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              키
            </th>
            <th scope="col" className="py-1.5 font-semibold">
              하는 일
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pieces = isMac ? row.keys.mac : row.keys.other;
            return (
              <tr key={row.id} className="border-b border-border last:border-b-0">
                <td className="whitespace-nowrap py-2 pr-3 align-top">
                  {/* 기호 조각(화살표)은 화면 읽기 프로그램에 이름(spoken)으로 읽어 줍니다. */}
                  <span aria-hidden={row.spoken ? true : undefined} className="inline-flex flex-wrap gap-1">
                    {pieces.map((piece) => (
                      <kbd key={piece} className={KBD}>
                        {piece}
                      </kbd>
                    ))}
                  </span>
                  {row.spoken && <span className="sr-only">{row.spoken}</span>}
                </td>
                <td className="py-2 text-text">{row.action}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {typedKeys.length > 0 && (
        <p className="mt-3 text-sm text-text-2">
          입력칸에 글을 쓰는 중이거나 한글을 조합하는 중에는 {typedKeys.join("·")}가 글자로 들어갑니다.
        </p>
      )}
    </Dialog>
  );
}
