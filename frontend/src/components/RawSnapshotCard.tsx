"use client";

import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Button, buttonClasses, ErrorState, Freshness, Loading } from "@/components/ui";
import { Dialog } from "@/components/ui/Dialog";
import { useApi } from "@/hooks/useApi";
import { apiGet } from "@/lib/api";
import { formatKst } from "@/lib/format";
import type { SnapshotText } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

const PATH = endpoints.snapshot.text;

const DESCRIPTION =
  "AI 분석 없이 수집한 전체 대시보드 최신 원본 데이터 — 거시·리스크·유동성·섹터·자산군·COT·KRX·SEC 13F 데이터를 수집 시각 및 데이터 출처 성격과 함께 표시합니다.";

/**
 * 전체 대시보드 원본 데이터 보기 / 복사 — 화면 머리의 동작 둘(작업대 화면 언어 P5a — 예전에는 매크로 화면 맨 위 카드).
 *
 * <p>AI를 거치지 않은 <b>수집 원본</b>입니다. AI 리포트가 요약하면서 무엇을 빠뜨렸는지 확인하거나, 다른 도구(챗봇·스프레드시트)에 그대로 붙여 넣을 때
 * 씁니다. AI 키가 없어도 동작합니다.
 *
 * <p>'원본 데이터 보기'는 공용 대화상자(넓은 폭·위쪽 고정)를 열고, 열 때만 원본 글을 읽습니다(GET /api/snapshot/text — 닫으면 버리고 다시 열면 다시
 * 읽음). 이 텍스트 한 장을 만들려면 백엔드가 열 개가 넘는 저장본을 읽어야 해서, 매크로 화면을 열 때마다 받아 오면 쓰지도 않을 조회가 계속 늘어납니다.
 * '원본 데이터 복사'는 열지 않아도 되도록 누를 때 스스로 한 번 받아 옵니다(이미 받은 글이 있으면 그것).
 */
export function RawSnapshotActions() {
  const [open, setOpen] = useState(false);
  const snapshot = useApi<SnapshotText>(open ? PATH : null);

  const fetchText = async () => {
    if (snapshot.data?.text) {
      return snapshot.data.text;
    }
    const fresh = await apiGet<SnapshotText>(PATH);
    return fresh.text;
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="전체 대시보드 원본 데이터"
        description={DESCRIPTION}
        size="lg"
        placement="top"
        trigger={
          <button type="button" className={buttonClasses("default")}>
            원본 데이터 보기
          </button>
        }
      >
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/* 만든 시각·글자 수 — 덮개 바탕(surface-2) 위라 배지 바탕 없이 보조 글로. */}
          {snapshot.data ? (
            <span className="text-xs tabular-nums text-text-2">
              {formatKst(snapshot.data.generatedAtKst)} 생성 · {snapshot.data.chars.toLocaleString("ko-KR")}자
            </span>
          ) : null}
          <Button onClick={snapshot.reload} disabled={snapshot.loading}>
            {snapshot.loading ? "다시 읽는 중…" : "다시 읽기"}
          </Button>
          <CopyButton text={fetchText} label="원본 데이터 복사" />
          {/* 받은 글이 있는 동안 다시 읽기가 실패하면 앞 글을 그대로 두고 그 사실을 알립니다(다른 패널의 '새로 읽지 못함'과 같음 — QA-623). */}
          <Freshness refreshError={snapshot.refreshError} />
        </div>
        <div className="mt-3">
          {snapshot.loading && !snapshot.data && <Loading label="원본 데이터를 모으는 중…" />}
          {snapshot.error && <ErrorState message={snapshot.error} onRetry={snapshot.reload} />}
          {snapshot.data && (
            <>
              <p className="mb-2 text-xs text-text-2">
                수집 실패 항목은 숫자를 만들어내지 않고 &apos;수집 실패&apos;로 적습니다.
                &apos;추정치&apos;로 표시된 값은 공식 확정치가 아닙니다.
              </p>
              {/* 원본 글은 읽는 본문이라 보조 글자색(text-2) — 캡션색(text-3)은 각주·축에만 씁니다(작업대 실행 명세 §3-2). 덮개(surface-2) 위라 바탕은
                  페이지 바탕(bg)으로 한 단계 내려 글 상자를 가릅니다. Tab으로 닿아 화살표로 넘길 수 있습니다(스크롤 상자). */}
              <pre
                tabIndex={0}
                aria-label="원본 데이터 글"
                className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-bg p-3 text-xs leading-relaxed text-text-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {snapshot.data.text}
              </pre>
            </>
          )}
        </div>
      </Dialog>
      <CopyButton text={fetchText} label="원본 데이터 복사" />
    </>
  );
}
