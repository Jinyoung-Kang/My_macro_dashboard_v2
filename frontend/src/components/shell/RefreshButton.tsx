"use client";

import { buttonClasses } from "@/components/ui";
import { RefreshIcon, SpinnerIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { isOwner } from "@/lib/access";
import type { SessionUser } from "@/lib/types";

/** 단추의 이름 — 아이콘 단추에서는 접근 이름(aria-label)이자 툴팁 글입니다. */
const NAME = "데이터 수동 새로고침";
const NAME_COLLECTING = "수집 중… 끝나면 자동 갱신";

/*
 * 넓은 화면 상단바의 아이콘 단추 — 최소(minimal) 모양: 투명 바탕, 가리키면 조작 바탕(bg-control-fill), 보조 글색 아이콘 16px, 30px 정사각, 4px.
 * 도구 줄의 단추라 주 단추(강조 파랑)가 아닙니다(명세 §3-4 — 단추 네 종류). 이 단추는 넓은 화면에서만 보여(감싼 줄이 hidden lg:flex) 좁은 화면 44px
 * 누름 자리를 두지 않습니다 — 좁은 화면은 더보기의 '데이터 읽기' 묶음(block)이 대신합니다.
 */
const ICON_BUTTON =
  "inline-flex size-[30px] shrink-0 items-center justify-center rounded-control border border-transparent text-text-2 motion-safe:transition-colors motion-safe:duration-150 not-disabled:hover:bg-control-fill not-disabled:hover:text-text disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/**
 * 운영자의 데이터 수동 새로고침 — 수집 요청 → 끝날 때까지 대기 → 화면 전체 갱신까지 한 번에(useRefreshSignal).
 *
 * 수집을 일으키므로 운영자만 단추를 봅니다(백엔드도 403). 결과 안내 문구(role=status)는 단추 곁에 남깁니다 — 알림(토스트)은 몇 초 뒤
 * 사라지지만 이 문구는 다음 새로고침까지 그대로라, 무엇이 갱신됐는지 나중에도 읽을 수 있습니다. 명령 팔레트에는 넣지 않습니다(쓰기 동작 — ADR 0042 결정 5).
 *
 * - `block`(기본 — 더보기 '데이터 읽기' 묶음, 좁은 화면): 폭 전체 주 단추(기본 크기 — 홀로 선 주 동작) 아래에 안내 문구.
 * - `icon`(넓은 화면 상단바 — 작업대 실행 명세 §5): 이름 있는 아이콘 단추(aria-label = 지금 글, 툴팁 = 이름), 수집 중에는 막고 도는 아이콘.
 *   안내 문구는 단추 왼쪽 한 줄(말줄임 — 전체 글은 title). 운영자가 아니면 아무것도 그리지 않습니다.
 *   안내가 떠 있는 동안 감싼 상자는 상단바에서 모자란 폭을 먼저 내줍니다(shrink-[100] — 빵부스러기 하한 160px을 지킴, 단추 30px + 사이 8px 아래로는
 *   줄지 않음, QA-547). 안내가 없으면 상자는 단추 폭 그대로입니다(shrink-0 — 늘 38px 하한을 두면 단추가 8px 왼쪽으로 밀림).
 */
export function RefreshButton({ user, variant = "block" }: { user?: SessionUser; variant?: "block" | "icon" }) {
  const { requestRefresh, collecting, message } = useRefreshSignal();
  const name = collecting ? NAME_COLLECTING : NAME;

  if (variant === "icon") {
    if (!isOwner(user)) return null;
    return (
      <div className={`hidden items-center gap-2 lg:flex ${message ? "min-w-[38px] shrink-[100]" : "shrink-0"}`}>
        {/* 안내 영역은 늘 그려 두고 글만 바꿉니다(block과 같은 까닭). 비어 있으면 보이지 않게(sr-only). */}
        <p
          role="status"
          title={message ?? undefined}
          className={message ? "max-w-40 truncate text-xs leading-5 text-text-3 xl:max-w-72" : "sr-only"}
        >
          {message ?? ""}
        </p>
        <Tooltip content={name} labelOnly>
          <button type="button" aria-label={name} onClick={() => void requestRefresh()} disabled={collecting} className={ICON_BUTTON}>
            {collecting ? <SpinnerIcon size={16} className="motion-safe:animate-spin" /> : <RefreshIcon size={16} />}
          </button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {isOwner(user) && (
        <button
          type="button"
          onClick={() => void requestRefresh()}
          disabled={collecting}
          className={`${buttonClasses("primary", "md")} w-full`}
        >
          {name}
        </button>
      )}
      {/* 안내 영역은 늘 그려 두고 글만 바꿉니다 — 새로고침마다 지웠다 내용과 함께 다시 넣으면 낭독기가 새 영역의 글을 읽지 않기도
          합니다. 비어 있으면 보이지 않게(sr-only — 자리·간격을 차지하지 않음). */}
      <p role="status" className={message ? "text-xs leading-5 text-text-3" : "sr-only"}>
        {message ?? ""}
      </p>
    </div>
  );
}
