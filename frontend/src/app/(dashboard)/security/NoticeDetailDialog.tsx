"use client";

import { type ReactElement, useState } from "react";
import { buttonClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { ExternalLinkIcon } from "@/components/ui/icons";
import { EMPTY, formatKst } from "@/lib/format";
import { detailStatusLabel, layoutLabel, reasonsText, safeExternalUrl } from "@/lib/security";
import type { SecurityNoticeResponse } from "@/lib/types";
import { NoticeDetailSections } from "./NoticeScreen";
import { VerdictText } from "./VerdictText";

/**
 * 보안 공지 '자세히 보기' 팝업(사용자 요청 2026-11-22 — 목록의 요약 칸에서 화면을 떠나지 않고). 요약 칸이 이미 읽은 응답(GET /api/security/notices/{번호})을
 * 그대로 받아 따로 읽지 않고, 상세 페이지와 같은 구역 ①~⑤(NoticeDetailSections)를 넓은 대화상자(xl, 위쪽 고정 — 접기를 펼쳐도 위 끝이 그대로)에 그립니다.
 * 창 첫머리는 글 번호·게시일·표 틀·상세 받기 상태, 판정·사유, '원문 열기(새 창)'. 상세 페이지 주소(/security/<번호>)는 그대로 열립니다.
 */
export function NoticeDetailDialog({ data, trigger }: { data: SecurityNoticeResponse; trigger: ReactElement }) {
  const [open, setOpen] = useState(false);
  const detail = data.notice;
  const title = detail.title || `보안 공지 ${detail.nttId}`;
  const url = safeExternalUrl(detail.url);
  const fetched = detail.detailFetchedAt ? ` ${formatKst(detail.detailFetchedAt)}` : "";
  return (
    <Dialog open={open} onOpenChange={setOpen} title={title} trigger={trigger} size="xl" placement="top">
      {open && (
        <div className="flex min-w-0 flex-col gap-3">
          <p className="break-keep text-xs tabular-nums text-text-2">
            글 {detail.nttId} · 게시 {detail.postedOn ?? EMPTY} · {layoutLabel(detail.layout)} · 상세 {detailStatusLabel(detail.detailStatus)}
            {fetched}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <VerdictText code={detail.verdict} />
            {detail.reasons.length > 0 ? <span className="break-keep text-sm text-text-2">{reasonsText(detail.reasons)}</span> : null}
            {url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className={`${buttonClasses("default", "md")} ml-auto`}>
                원문 열기(새 창)
                <ExternalLinkIcon size={14} />
              </a>
            ) : null}
          </div>
          <NoticeDetailSections data={data} />
        </div>
      )}
    </Dialog>
  );
}
