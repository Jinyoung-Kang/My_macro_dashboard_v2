"use client";

import { useId, useState } from "react";
import { Banner, Button, FIELD_LABEL, inputClasses } from "@/components/ui";
import { StatusText } from "@/components/ui/icons";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiDelete, apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { formatKst } from "@/lib/format";
import { MAX_ACK_NOTE, ackState, reasonsText, verdictView } from "@/lib/security";
import type { SecurityAck, SecurityNoticeItem, SecurityNoticeResponse } from "@/lib/types";

/** 무효가 된 확인의 설명 한 줄 — 확인한 시각(KST)·그때의 판정과 사유·메모. */
function staleText(ack: SecurityAck): string {
  const reasons = reasonsText(ack.reasons);
  const then = `${verdictView(ack.verdict).label}${reasons ? `(${reasons})` : ""}`;
  return `${formatKst(ack.ackedAt)}에 확인할 때는 ${then}였습니다.${ack.note ? ` 그때 메모: ${ack.note}` : ""}`;
}

/**
 * 보안 공지의 '확인함' 표시(ADR 0046 덧붙임 2026-11-28) — 운영자가 확인 필요 공지를 손으로 확인했다고 적습니다. 판정은 바꾸지 않습니다(목록의 '확인 필요'
 * 건수에서 빠져 '확인함'으로 옮겨질 뿐). 요약 칸(NoticeSummary)과 상세 화면(NoticeScreen)이 같이 씁니다.
 *
 * - 확인 필요이고 유효한 확인이 없을 때: 선택 메모(500자까지) + '확인함으로 표시'. 확인한 뒤 판정·사유가 바뀐 것이면 그 사실과 그때의 사유·메모를 먼저 보입니다.
 * - 유효한 확인이 있을 때: 확인한 시각(KST)·메모 + '확인 취소'.
 * - 해당인데 예전 확인이 있을 때: 그 사실만(해당은 업데이트로 풀 것이라 확인함으로 덮지 않음) + '기록 지우기'.
 * - 그 밖(패치됨·무관, 기록 없는 해당): 아무것도 그리지 않습니다.
 *
 * 쓰기는 누를 때만 나갑니다(POST·DELETE /api/security/notices/{번호}/ack). 성공하면 onChange로 부른 쪽이 다시 읽습니다. 메모에는 서버의 실제 버전을 적을 수 있어
 * DB와 이 화면에만 둡니다.
 *
 * @param framed 상세 화면에서 패널 꼴의 테두리 상자로 그립니다(요약 칸은 테두리 없이).
 */
export function AckPanel({
  nttId,
  notice,
  onChange,
  framed = false,
}: {
  nttId: string;
  notice: Pick<SecurityNoticeItem, "verdict" | "reasons" | "ack">;
  onChange: () => void;
  framed?: boolean;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const save = useAsyncAction(
    (memo: string) => apiPost<SecurityNoticeResponse>(endpoints.security.noticeAck(nttId), memo ? { note: memo } : {}),
    "확인함으로 표시하지 못했습니다.",
  );
  const remove = useAsyncAction(() => apiDelete<SecurityNoticeResponse>(endpoints.security.noticeAck(nttId)), "확인 표시를 지우지 못했습니다.");

  const state = ackState(notice);
  const ack = notice.ack ?? null;
  const canAck = notice.verdict === "check" && state !== "valid";
  if (!canAck && state === "none") return null;

  const submit = async () => {
    if (await save.run(note.trim())) {
      setNote("");
      onChange();
    }
  };
  const clear = async () => {
    if (await remove.run()) onChange();
  };
  const error = save.error ?? remove.error;
  const box = framed ? "rounded-card border border-border bg-surface p-3" : "";

  return (
    <section aria-label="확인함 표시" className={`flex min-w-0 flex-col gap-2 ${box}`}>
      {state === "valid" && ack ? (
        <>
          <p className="text-sm">
            <StatusText tone="ok" colorText={false} className="break-keep">
              확인함 · {formatKst(ack.ackedAt)}
            </StatusText>
          </p>
          {ack.note ? <p className="wrap-anywhere whitespace-pre-wrap text-sm text-text-2">메모: {ack.note}</p> : null}
          <p className="break-keep text-caption text-text-2">판정이나 사유가 바뀌면 이 확인은 무효가 되어 다시 확인 필요로 셉니다.</p>
          <div>
            <Button onClick={clear} busy={remove.busy}>
              확인 취소
            </Button>
          </div>
        </>
      ) : null}

      {state === "stale" && ack ? (
        <Banner tone="warn" title="확인한 뒤 판정이나 사유가 바뀌었습니다">
          {staleText(ack)}
        </Banner>
      ) : null}

      {canAck ? (
        <>
          <label className={FIELD_LABEL} htmlFor={noteId}>
            확인 메모(선택)
            <textarea
              id={noteId}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={MAX_ACK_NOTE}
              className={`w-full ${inputClasses()}`}
              placeholder="확인한 근거를 한 줄로"
            />
          </label>
          <div>
            <Button variant="primary" onClick={submit} busy={save.busy}>
              확인함으로 표시
            </Button>
          </div>
        </>
      ) : null}

      {!canAck && state === "stale" ? (
        <div>
          <Button onClick={clear} busy={remove.busy}>
            기록 지우기
          </Button>
        </div>
      ) : null}

      {error ? <Banner tone="warn">{error}</Banner> : null}
    </section>
  );
}
