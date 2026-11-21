import { NoticeScreen } from "../NoticeScreen";

/**
 * 보안 공지 상세(/security/<번호> — ADR 0046, 운영자 전용·읽기만) — 목록 요약 칸의 '자세히 보기'가 오는 곳. 라우트는 얇게, 그리기는 같은 폴더 위의
 * NoticeScreen. 번호 형식이 틀린 주소도 404로 보내지 않고 화면이 그 사실과 '목록으로'를 적습니다(목록으로 돌아가는 길을 같은 자리에 둠). 번호가 바뀌면
 * 화면을 새로 그립니다(key — 앞 공지의 표 범위 고름이 남지 않게).
 */
export default async function SecurityNoticePage({ params }: { params: Promise<{ nttId: string }> }) {
  const { nttId } = await params;
  return <NoticeScreen key={nttId} raw={nttId} />;
}
