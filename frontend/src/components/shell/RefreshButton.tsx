"use client";

import { buttonClasses } from "@/components/ui";
import { RefreshIcon, SpinnerIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { useRefreshSignal } from "@/hooks/useRefreshSignal";
import { useWideShell } from "@/hooks/useWideShell";
import { isOwner } from "@/lib/access";
import type { SessionUser } from "@/lib/types";
import { FailureNotice } from "./FailureNotice";

/** 단추의 이름 — 아이콘 단추에서는 접근 이름(aria-label)이자 툴팁 글입니다. */
const NAME = "데이터 수동 새로고침";
const NAME_COLLECTING = "수집 중… 끝나면 자동 갱신";

/*
 * 넓은 화면 상단바의 아이콘 단추 — 최소(minimal) 모양: 투명 바탕, 가리키면 조작 바탕(bg-control-fill), 보조 글색 아이콘 16px, 30px 정사각, 4px.
 * 도구 줄의 단추라 주 단추(강조 파랑)가 아닙니다(명세 §3-4 — 단추 네 종류). 이 단추는 넓은 화면에서만 보여(감싼 줄이 hidden lg:flex) 좁은 화면 44px
 * 누름 자리를 두지 않습니다 — 좁은 화면은 더보기의 '데이터 읽기' 묶음(block)이 대신합니다.
 * 수집 중에는 aria-disabled로 흐리게 막습니다(진짜 disabled가 아님 — 아래 RefreshButton 설명, QA-553). hover 바탕은 막히지 않았을 때만(QA-493과 같은 뜻).
 */
const ICON_BUTTON =
  "inline-flex size-[30px] shrink-0 items-center justify-center rounded-control border border-transparent text-text-2 motion-safe:transition-colors motion-safe:duration-150 not-aria-disabled:hover:bg-control-fill not-aria-disabled:hover:text-text aria-disabled:cursor-not-allowed aria-disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/*
 * 상단바 안내를 감싼 상자의 폭(QA-547) — 안내가 떠 있는 동안 상단바에서 모자란 폭을 가장 먼저 내주되(축소 비중 100000 — 빵부스러기 nav는 1이라 그
 * 몫이 배치 단위 아래), 안내 글 내용의 하한까지만 내줍니다: 실패 글은 아이콘 + 결과 낱말 '새로고침 실패'(FailureNotice), 성공 글은 4rem(안내 p의
 * grid minmax — 글은 안쪽 말줄임). 정한 하한(min-w)을 두지 않아 그 내용의 하한이 상자의 하한입니다. 그다음에 빵부스러기가 줄어듭니다(Breadcrumbs).
 * 처음 고칠 때는 상자 하한이 정한 38px(단추 + 사이)뿐이라 안내가 결과 낱말까지 말줄임됐고('새로고…'), nav가 글 폭을 주장하지 못해 대상 칸이 먼저
 * 사라졌습니다(검토).
 * 같은 상단바에 로그아웃 실패 글(role=alert — AccountMenu, 같은 꼴의 하한)이 함께 뜨면 이 안내는 하한을 내려놓습니다 — 실패면 경고 아이콘(12px)만,
 * 성공 글이면 0까지(상자 50·38px, 안내 p는 overflow-hidden으로 자름). 둘 다 하한을 지키면 1280에서 상단바가 넘쳤습니다(정적 하네스 — 둘 다 뜨는 것은
 * 쿠키 세션 운영자에게서만). 안내가 없으면 상자는 단추 폭 그대로입니다(shrink-0 — 늘 하한을 두면 단추가 8px 왼쪽으로 밀림).
 */
const NOTICE_BOX = {
  none: "shrink-0",
  ok: "shrink-100000 in-[header:has([role=alert])]:min-w-[38px]",
  failed: "shrink-100000 in-[header:has([role=alert])]:min-w-[50px]",
} as const;

/**
 * 운영자의 데이터 수동 새로고침 — 수집 요청 → 끝날 때까지 대기 → 화면 전체 갱신까지 한 번에(useRefreshSignal).
 *
 * 수집을 일으키므로 운영자만 단추를 봅니다(백엔드도 403). 결과 안내 문구(role=status)는 단추 곁에 남깁니다 — 알림(토스트)은 몇 초 뒤
 * 사라지지만 이 문구는 다음 새로고침까지 그대로라, 무엇이 갱신됐는지 나중에도 읽을 수 있습니다. 명령 팔레트에는 넣지 않습니다(쓰기 동작 — ADR 0042 결정 5).
 *
 * - `block`(기본 — 더보기 '데이터 읽기' 묶음, 좁은 화면): 폭 전체 주 단추(기본 크기 — 홀로 선 주 동작) 아래에 안내 문구.
 * 수집 중에는 두 변형 모두 aria-disabled·aria-busy로 막고 누름을 무시합니다 — 진짜 disabled는 누른 단추에서 포커스를 문서(body)로 떨어뜨려(브라우저의
 * 포커스 정리) 키보드 사용자가 자리를 잃고 바뀐 이름('수집 중…')도 읽히지 않았습니다(QA-553 — QA-444와 같은 방식). 안내 글이 아직 없으면(요청이 오가는 동안)
 * 안내 영역(sr-only)에 '수집 중…'을 둬 읽히게 합니다. 연타는 훅도 막습니다(inFlight).
 *
 * - `icon`(넓은 화면 상단바 — 작업대 실행 명세 §5): 이름 있는 아이콘 단추(aria-label = 지금 글, 툴팁 = 이름), 수집 중에는 막고 도는 아이콘.
 *   안내 문구는 단추 왼쪽 한 줄(말줄임 — 전체 글은 title). 운영자가 아니면 아무것도 그리지 않습니다. 상단바에서의 폭은 아래 NOTICE_BOX(QA-547).
 *
 * 실패(훅의 failed — 요청 실패·수집기에 닿지 못함)면 두 변형 모두 안내를 경고 톤 + 아이콘(sr-only '주의: ')으로 그립니다 — 같은 상단바의 로그아웃 실패
 * (AccountMenu)·더보기의 로그아웃 실패(AccountBox)와 같은 꼴이고, 글은 짧은 결과 낱말이 먼저입니다('새로고침 실패 — 사유', QA-552). 성공 글은
 * 회색(text-3) 그대로입니다.
 */
export function RefreshButton({ user, variant = "block" }: { user?: SessionUser; variant?: "block" | "icon" }) {
  const { requestRefresh, collecting, message, failed } = useRefreshSignal();
  // 아이콘 단추의 이름 툴팁은 넓은 화면에서만 — 단추가 CSS로 숨어도 열린 툴팁이 좁은 화면 왼쪽 위에 남았습니다(QA-554, 알림 벨과 같은 방식).
  const wide = useWideShell();
  const name = collecting ? NAME_COLLECTING : NAME;
  // 안내 영역의 글 — 안내가 없으면 수집 중에는 진행 글(보이게 하는 클래스는 안내가 있을 때만, 없으면 sr-only).
  const statusText = message ?? (collecting ? NAME_COLLECTING : "");
  const onClick = () => {
    if (collecting) return;
    void requestRefresh();
  };

  if (variant === "icon") {
    if (!isOwner(user)) return null;
    return (
      <div className={`hidden items-center gap-2 lg:flex ${NOTICE_BOX[message ? (failed ? "failed" : "ok") : "none"]}`}>
        {/* 안내 영역은 늘 그려 두고 글만 바꿉니다(block과 같은 까닭). 비어 있으면 보이지 않게(sr-only). */}
        <p
          role="status"
          title={message ?? undefined}
          className={
            message
              ? failed
                ? "flex max-w-40 overflow-hidden text-xs leading-5 xl:max-w-72"
                : "grid max-w-40 grid-cols-[minmax(4rem,1fr)] overflow-hidden text-xs leading-5 text-text-3 xl:max-w-72"
              : "sr-only"
          }
        >
          {!message ? statusText : failed ? <FailureNotice message={message} oneLine /> : <span className="truncate">{message}</span>}
        </p>
        <Tooltip content={name} labelOnly disabled={!wide}>
          <button
            type="button"
            aria-label={name}
            onClick={onClick}
            aria-disabled={collecting || undefined}
            aria-busy={collecting || undefined}
            className={ICON_BUTTON}
          >
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
          onClick={onClick}
          aria-disabled={collecting || undefined}
          aria-busy={collecting || undefined}
          className={`${buttonClasses("primary", "md")} w-full aria-disabled:cursor-not-allowed aria-disabled:opacity-50`}
        >
          {name}
        </button>
      )}
      {/* 안내 영역은 늘 그려 두고 글만 바꿉니다 — 새로고침마다 지웠다 내용과 함께 다시 넣으면 낭독기가 새 영역의 글을 읽지 않기도
          합니다. 비어 있으면 보이지 않게(sr-only — 자리·간격을 차지하지 않음). */}
      <p role="status" className={message ? (failed ? "text-xs leading-5 text-warn" : "text-xs leading-5 text-text-3") : "sr-only"}>
        {message && failed ? <FailureNotice message={message} oneLine={false} /> : statusText}
      </p>
    </div>
  );
}
