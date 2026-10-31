"use client";

import { useState } from "react";
import { CopyButton } from "@/components/CopyButton";
import { Button, Card, ErrorState, Loading, SourceBadge } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { apiGet } from "@/lib/api";
import { formatKst } from "@/lib/format";
import type { SnapshotText } from "@/lib/types";
import { endpoints } from "@/lib/endpoints";

const PATH = endpoints.snapshot.text;

/**
 * 📋 전체 대시보드 원본 데이터 보기 / 복사.
 *
 * <p>AI를 거치지 않은 <b>수집 원본</b>입니다. AI 리포트가 요약하면서 무엇을
 * 빠뜨렸는지 확인하거나, 다른 도구(챗봇·스프레드시트)에 그대로 붙여 넣을 때
 * 씁니다. AI 키가 없어도 동작합니다.
 *
 * <p>펼치기 전에는 불러오지 않습니다. 이 텍스트 한 장을 만들려면 백엔드가
 * 열 개가 넘는 저장본을 읽어야 해서, 매크로 화면을 열 때마다 받아 오면
 * 쓰지도 않을 조회가 계속 늘어납니다. 복사 버튼은 펼치지 않아도 되도록
 * 필요할 때 스스로 받아 옵니다.
 */
export function RawSnapshotCard() {
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
    <Card
      title="전체 대시보드 원본 데이터 보기 / 복사"
      subtitle="AI 분석 없이 수집한 전체 대시보드 최신 원본 데이터 — 거시·리스크·유동성·섹터·자산군·COT·KRX·SEC 13F 데이터를 수집 시각 및 데이터 출처 성격과 함께 표시합니다."
      actions={
        snapshot.data ? (
          <SourceBadge>
            {formatKst(snapshot.data.generatedAtKst)} · {snapshot.data.chars.toLocaleString("ko-KR")}자
          </SourceBadge>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => setOpen((value) => !value)}>
          {open ? "원본 데이터 닫기" : "원본 데이터 보기"}
        </Button>
        <CopyButton text={fetchText} label="원본 데이터 복사" />
        {open && (
          <Button onClick={snapshot.reload} disabled={snapshot.loading}>
            {snapshot.loading ? "다시 읽는 중…" : "다시 읽기"}
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-4">
          {snapshot.loading && !snapshot.data && <Loading label="원본 데이터를 모으는 중…" />}
          {snapshot.error && <ErrorState message={snapshot.error} onRetry={snapshot.reload} />}
          {snapshot.data && (
            <>
              <p className="mb-2 text-xs text-muted">
                수집 실패 항목은 숫자를 만들어내지 않고 &apos;수집 실패&apos;로 적습니다.
                &apos;추정치&apos;로 표시된 값은 공식 확정치가 아닙니다.
              </p>
              <pre tabIndex={0} className="max-h-[560px] overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-canvas p-3 text-xs leading-relaxed text-muted">
                {snapshot.data.text}
              </pre>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
