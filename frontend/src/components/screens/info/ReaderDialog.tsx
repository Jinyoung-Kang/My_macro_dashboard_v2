"use client";

import { Dialog } from "@/components/ui/Dialog";
import type { ReaderEntry } from "@/lib/info";
import { Reader } from "./Reader";

/**
 * 원문 팝업(ADR 0037) — 글을 누르면 받아 둔 원문(본문, 없으면 요약)을 그대로 보이고, 번역 단추를 누르면 한국어로 바꿔 보입니다(원문·번역을 오갈 수
 * 있음). 번역은 서버가 저장해 두어 다시 열어도 모델을 다시 부르지 않습니다. 팝업을 열어도 수집은 일어나지 않습니다 — 없는 본문은 받으러 가지 않고 원문
 * 링크를 안내합니다. 지금 쓰는 곳은 정보 검색 피드(FeedPanel)뿐입니다 — 정보 수집 뉴스·글은 작업대 P7부터 목록 + 원문 검사 칸(NewsSection — 공용
 * InspectorFrame, 좁은 배치는 같은 꼴의 대화상자)이 같은 원문 읽기(Reader)를 씁니다.
 */
export function ReaderDialog({ entry, onClose }: { entry: ReaderEntry | null; onClose: () => void }) {
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={entry ? entry.title : "원문"}
      description={entry ? `${entry.sourceLabel} · ${entry.time}` : undefined}
      size="lg"
      placement="top"
    >
      {entry && <Reader key={entry.key} entry={entry} />}
    </Dialog>
  );
}
