"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "@/components/ui/IntentLink";
import { Banner, buttonClasses } from "@/components/ui";
import { AlertTriangleIcon, XIcon } from "@/components/ui/icons";
import { Tooltip } from "@/components/ui/Tooltip";
import { useApi } from "@/hooks/useApi";
import { useDismissed } from "@/hooks/useDismissed";
import { useWideShell } from "@/hooks/useWideShell";
import { isOwner } from "@/lib/access";
import { endpoints } from "@/lib/endpoints";
import { INFO_DISMISS_KEY, type InfoSourcesResponse, bannerText, incidentDismissKey, unseenIncidents } from "@/lib/info";
import type { SessionUser } from "@/lib/types";

/**
 * 수집 출처 끊김 안내(ADR 0035 결정 7) — 운영자에게만, 홈('/')을 뺀 모든 화면의 **상단바 안**에 경고 표시(아이콘과 건수)로 뜹니다. 누르면 출처 이름과 종류를
 * 적은 한 줄·'출처 상태 보기'(정보 수집 > 출처 상태)·닫기가 본문 위에 겹쳐 펼쳐집니다. 같은 사건은 텔레그램으로도 한 통 갑니다(백엔드).
 *
 * 예전에는 셸이 본문 맨 위에 띠로 그려, `/api/info/sources` 응답 뒤 끼어든 띠가 그 아래 본문 전체를 밀었습니다(QA-994 — QA 모바일 CLS 기관 0.161·
 * 모의매매 0.143·정보 개요 0.569, 사용자 결정 2026-11-24 D-4). 이제 상단바의 빵부스러기 바로 뒤 자리에 들어가므로(넓은 화면은 빵부스러기가 자기 폭을 내줌)
 * 본문이 움직이지 않고, 펼친 안내는 겹치는 판이라 아무것도 밀지 않습니다.
 *
 * 그대로 지키는 것: 홈에서는 그리지 않고 경로도 부르지 않습니다(QA-613 — 홈의 '알림·끊긴 출처' 패널이 같은 사건을 적음). 닫으면 그 사건들은 이 브라우저에서
 * 다시 보이지 않고, 새 사건이 생기면 다시 뜹니다 — 같은 출처·같은 종류라도 회복했다가 다시 끊기면 새 사건입니다(서버가 주는 회차 `episode`까지 붙여 기억,
 * QA-408). 운영자가 아니면 요청하지 않습니다(null 경로). 펼친 판은 Escape·바깥 누르기·화면 이동으로 접힙니다(Escape는 단추로 포커스를 돌려줌).
 */
export function SourceAlertIndicator({ pathname, user }: { pathname: string; user?: SessionUser }) {
  const owner = isOwner(user);
  const home = pathname === "/";
  const { data } = useApi<InfoSourcesResponse>(owner && !home ? endpoints.info.sources : null, 300_000);
  const [dismissed, dismiss] = useDismissed(INFO_DISMISS_KEY);
  const unseen = unseenIncidents(data?.incidents ?? [], dismissed);
  const [open, setOpen] = useState(false);
  const wide = useWideShell();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // 화면을 옮기면 접습니다('출처 상태 보기'를 눌러 간 화면에 판이 남지 않게).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (!owner || home || unseen.length === 0) return null;
  const count = unseen.length;
  const name = `수집 끊김 ${count}건 — 안내 ${open ? "접기" : "펼치기"}`;
  return (
    <div ref={rootRef} className="relative shrink-0" data-testid="source-alert">
      <Tooltip content={`수집 끊김 ${count}건`} labelOnly disabled={!wide}>
        <button
          ref={toggleRef}
          type="button"
          aria-label={name}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
          className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-control px-2 text-warn hover:bg-surface-2 lg:h-[30px] lg:min-w-[30px] lg:px-1.5 motion-safe:transition-colors motion-safe:duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          <AlertTriangleIcon size={18} />
          <span aria-hidden="true" className="text-sm font-semibold tabular-nums">
            {count}
          </span>
        </button>
      </Tooltip>
      {open && (
        // 겹치는 판 — 좁은 화면은 화면 폭에서 좌우 16px(상단바 첫 줄 아래), 넓은 화면은 단추 왼쪽 끝에서 오른쪽으로(빵부스러기 뒤 자리라 넘치지 않음).
        <div
          id={panelId}
          role="region"
          aria-label="수집 끊김 안내"
          data-testid="source-alert-banner"
          className="fixed inset-x-4 top-[4.25rem] z-50 rounded-card shadow-overlay lg:absolute lg:inset-x-auto lg:left-0 lg:top-full lg:mt-2 lg:w-[26rem]"
        >
          <Banner tone="warn">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0">
                {bannerText(unseen)}. 그 출처만 멈추고 직전 저장본을 유지합니다.{" "}
                <Link href="/info/status" className="font-semibold underline underline-offset-2">
                  출처 상태 보기
                </Link>
              </p>
              <button
                type="button"
                onClick={() => {
                  dismiss(unseen.map(incidentDismissKey));
                  setOpen(false);
                }}
                className={buttonClasses("ghost", "sm")}
                aria-label="수집 끊김 안내 닫기"
              >
                <XIcon size={14} />
                닫기
              </button>
            </div>
          </Banner>
        </div>
      )}
    </div>
  );
}
