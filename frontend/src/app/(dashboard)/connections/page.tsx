"use client";

import { PageHeader } from "@/components/ui";
import { AiEngineSection } from "./AiEngineSection";
import { TossSection } from "./TossSection";

/**
 * 외부 API 연결 테스트 — AI 엔진과 토스증권을 한곳에서.
 *
 * 예전에는 두 메뉴(AI API 연결 테스트 · 토스증권 API 테스트)였습니다. 둘 다
 * "키를 넣은 뒤 외부 서비스가 응답하는지" 확인하는 같은 성격이라 합쳤습니다.
 * 옛 주소(/ai/test, /toss)는 next.config의 redirects가 이 화면으로 보냅니다.
 *
 * 국내 공공 API(공공데이터포털·DART) 진단은 수집 데이터의 출처라 데이터 저장소
 * 상태에 있습니다.
 */
export default function ConnectionsPage() {
  return (
    <div className="flex flex-col gap-6 lg:gap-8">
      <PageHeader
        title="외부 API 연결 테스트"
        description="AI 엔진과 토스증권 연결을 확인합니다. 모든 테스트는 버튼을 눌렀을 때만 외부를 호출합니다."
      />
      <AiEngineSection />
      <TossSection />
    </div>
  );
}
