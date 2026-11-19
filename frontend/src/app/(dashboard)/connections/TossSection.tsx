"use client";

import { useState } from "react";
import { LogPanel } from "@/components/patterns";
import { Button, Callout, ErrorState, Loading, Panel, Tag } from "@/components/ui";
import { useApi } from "@/hooks/useApi";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { apiGet } from "@/lib/api";
import { SOURCES } from "@/lib/sources";
import { endpoints } from "@/lib/endpoints";

/**
 * 토스증권 — 연결 진단·조회 테스트.
 *
 * 이 프로젝트에서 토스는 <b>연결 진단 전용</b>입니다. 대시보드 수치는 토스에서
 * 가져오지 않습니다. 키가 없으면 이 영역만 비활성화됩니다.
 *
 * 주의사항 — 진단은 토스 서버를 실제로 부릅니다. 메뉴를 열 때마다 자동으로 부르면
 * 보지도 않는 호출이 쌓이므로 버튼을 눌렀을 때만 실행합니다.
 */
export function TossSection() {
  const [runId, setRunId] = useState<number | null>(null);
  const diagnostics = useApi<{ ok: boolean; stage?: string; message?: string; sample?: unknown }>(
    runId === null ? null : endpoints.toss.diagnostics(runId),
  );
  const { run: call, busy, result, error } = useAsyncAction(
    (path: string) => apiGet<unknown>(path),
    "호출에 실패했습니다.",
  );

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-base font-semibold text-text">토스증권</h2>

      <Panel
        title="연결 상태" source={SOURCES.toss}
        subtitle="연결 진단·조회 테스트입니다. 수급 레이더(시장 전체·수급 지속성·폴백 순위)와 국내 파생(현물·선물 수급 동조)도 토스 공식 데이터를 씁니다"
        actions={
          <Button onClick={() => setRunId(Date.now())} disabled={diagnostics.loading}>
            {diagnostics.loading ? "검사 중…" : "진단 실행"}
          </Button>
        }
      >
        {runId === null && <p className="text-sm text-text-3">버튼을 누르면 토스 서버에 한 번 연결해 봅니다.</p>}
        {diagnostics.loading && !diagnostics.data && <Loading />}
        {/* 진단 요청 자체가 실패하면(백엔드 5xx·연결 끊김·운영자 아님 403) 빈 카드가 아니라 이유를 보입니다(QA-103).
            수집기에 닿지 못한 것은 백엔드가 200 {ok:false}로 감싸 아래에서 '연결 실패'로 그립니다. */}
        {diagnostics.error && <ErrorState message={diagnostics.error} onRetry={diagnostics.reload} />}
        {/* 진단 결과는 결과 안내 상자(성공 정상·실패 주의 — 아이콘 + 제목) + 단계 태그 + 서버 글. */}
        {diagnostics.data && (
          <Callout tone={diagnostics.data.ok ? "ok" : "warn"} title={diagnostics.data.ok ? "연결 성공" : "연결 실패"}>
            {diagnostics.data.stage && (
              <p className="mt-1">
                <Tag>{diagnostics.data.stage}</Tag>
              </p>
            )}
            {diagnostics.data.message && <p className="mt-1 text-text-2">{diagnostics.data.message}</p>}
          </Callout>
        )}
      </Panel>

      <Panel title="실제 데이터 조회 테스트" source={SOURCES.toss}>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => call(endpoints.toss.exchangeRate("USD", "KRW"))}
            disabled={busy}
          >
            환율 조회 (USD → KRW)
          </Button>
          <Button
            onClick={() => call(endpoints.toss.indices("KOSPI,KOSDAQ"))}
            disabled={busy}
          >
            지수 시세 조회
          </Button>
        </div>

        {error && (
          <div className="mt-4">
            <Callout tone="danger">{error}</Callout>
          </div>
        )}

        {/* 받은 JSON 그대로 — 공용 로그 상자(고정폭, 30rem에서 상자 안 스크롤, 옅은 글). */}
        {result !== null && (
          <div className="mt-4">
            <LogPanel label="토스 조회 결과" text={JSON.stringify(result, null, 2)} maxHeight="md" tone="muted" />
          </div>
        )}
      </Panel>

      <Callout title="참고">
        <ul className="mt-1 list-disc pl-5 text-xs leading-relaxed text-text-2">
          <li>토스 Open API는 허용 IP 목록을 사용합니다. HTTP 403이면 IP 등록을 확인하세요.</li>
          <li>키는 수집기 쪽에만 설정합니다(백엔드·프런트는 키를 보관하지 않습니다).</li>
          <li>키가 없으면 이 영역만 비활성화되고 다른 메뉴는 정상 동작합니다.</li>
        </ul>
      </Callout>
    </section>
  );
}
