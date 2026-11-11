"use client";

import { useState } from "react";
import { Banner, ErrorState, Loading, buttonClasses } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useApi } from "@/hooks/useApi";
import { apiPost } from "@/lib/api";
import { endpoints } from "@/lib/endpoints";
import { type InfoItemResponse, type ReaderEntry, type TranslateResponse, offersTranslate, translatedBy } from "@/lib/info";

/**
 * 원문 팝업(ADR 0037) — 정보 수집의 글·속보·사건 뉴스를 누르면 받아 둔 원문(본문, 없으면 요약)을 그대로 보이고, 번역 단추를 누르면 한국어로
 * 바꿔 보입니다(원문·번역을 오갈 수 있음). 번역은 서버가 저장해 두어 다시 열어도 모델을 다시 부르지 않습니다. 팝업을 열어도 수집은 일어나지
 * 않습니다 — 없는 본문은 받으러 가지 않고 원문 링크를 안내합니다.
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

function Reader({ entry }: { entry: ReaderEntry }) {
  // 수집 글의 본문은 열 때 id로 읽습니다(목록 응답에는 본문이 없음). 사건 뉴스는 목록이 준 요약이 전부입니다.
  const stored = useApi<InfoItemResponse>(entry.itemId && entry.hasBody ? endpoints.info.item(entry.itemId) : null);
  const original = entry.itemId ? (stored.data?.item?.body ?? stored.data?.item?.summary ?? null) : entry.text;
  const [translated, setTranslated] = useState<TranslateResponse | null>(null);
  const [showKorean, setShowKorean] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const translate = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<TranslateResponse>(
        endpoints.info.translate,
        entry.itemId ? { itemId: entry.itemId } : { title: entry.titleKo ? undefined : entry.title, text: entry.text ?? undefined },
      );
      if (!result.ok) {
        setError(result.error ?? "번역하지 못했습니다.");
      }
      if (result.textKo || result.titleKo || result.alreadyKorean) {
        setTranslated(result);
        setShowKorean(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "번역하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const loading = !!entry.itemId && entry.hasBody && stored.loading && !stored.data;
  const koreanTitle = translated?.titleKo ?? entry.titleKo;
  const shown = showKorean && translated?.textKo ? translated.textKo : original;
  // 일부만 번역된 응답(제목만 옮기고 본문은 실패) 뒤에도 단추를 남깁니다 — 다시 누르면 서버가 남은 부분만 옮깁니다(QA-409).
  const offerTranslate = !loading && offersTranslate(entry, original, translated);
  const retry = translated !== null || error !== null;

  return (
    <div className="mt-3 space-y-3">
      {koreanTitle && (
        <p lang="ko" className="text-[14px] font-semibold leading-snug text-text-2">
          {koreanTitle}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {offerTranslate && (
          <button type="button" onClick={translate} disabled={busy} className={buttonClasses("primary", "sm")}>
            {busy ? "번역 중…" : retry ? "다시 번역" : "한국어로 번역"}
          </button>
        )}
        {translated?.textKo && (
          <button type="button" onClick={() => setShowKorean((value) => !value)} className={buttonClasses("secondary", "sm")} aria-pressed={showKorean}>
            {showKorean ? "원문 보기" : "번역 보기"}
          </button>
        )}
        {entry.url && (
          <a href={entry.url} target="_blank" rel="noopener noreferrer" className={buttonClasses("ghost", "sm")}>
            원문 열기(새 창)
          </a>
        )}
      </div>
      {busy && <p className="text-xs text-text-3">긴 글은 1분쯤 걸립니다. 한 번 번역한 글은 저장되어 다음에는 바로 뜹니다.</p>}
      {error && <Banner tone="danger">{error}</Banner>}
      {translated?.alreadyKorean && !translated.textKo && <p className="text-xs text-text-3">이미 한국어 글이라 번역하지 않았습니다.</p>}
      {translated?.truncated && <p className="text-xs text-text-3">글이 길어 앞부분(40,000자)만 번역했습니다.</p>}
      {loading && <Loading />}
      {stored.error && <ErrorState message={stored.error} onRetry={stored.reload} />}
      {shown ? (
        <div
          lang={showKorean && translated?.textKo ? "ko" : undefined}
          className="max-h-[60dvh] overflow-y-auto whitespace-pre-wrap rounded-control bg-surface-2/60 p-3 text-[13px] leading-6 text-text"
        >
          {shown}
        </div>
      ) : (
        !loading && !stored.error && <p className="text-sm text-text-2">받아 둔 본문이 없습니다.</p>
      )}
      <p className="text-xs leading-5 text-text-3">
        {entry.note}
        {showKorean && translated?.textKo ? ` 번역은 ${translatedBy(translated)}이(가) 옮긴 것이라 숫자·고유명사는 원문과 대조하세요.` : ""}
      </p>
    </div>
  );
}
