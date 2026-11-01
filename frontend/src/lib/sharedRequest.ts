/**
 * src/lib/sharedRequest.ts
 * 같은 GET이 동시에 여러 번 나가지 않게 묶습니다.
 *
 * 왜 필요한가 — 화면마다 필요한 데이터를 각 컴포넌트가 직접 읽습니다(useApi). 그래서 한 화면
 * 안에서 같은 주소를 두 컴포넌트가 동시에 부르면 요청도 두 번 나갔습니다(예: 스타일 화면의
 * /api/guru/profiles, 매크로 화면의 공휴일 목록). 진행 중인 요청이 있으면 그 결과를 함께 씁니다.
 *
 * 주의사항
 * - 묶는 것은 **진행 중인** 요청뿐입니다. 끝난 결과를 보관하지 않으므로 오래된 값이 남지 않습니다.
 * - 한 쪽이 화면을 떠나 결과가 필요 없어져도 요청은 끝까지 갑니다(다른 쪽이 기다릴 수 있음).
 *   받는 쪽이 자기 취소 여부를 보고 결과를 버립니다.
 */
export function createSharedFetcher<T = unknown>(fetcher: (key: string) => Promise<T>) {
  const inFlight = new Map<string, Promise<T>>();
  return (key: string): Promise<T> => {
    const running = inFlight.get(key);
    if (running) return running;
    const request = fetcher(key).finally(() => inFlight.delete(key));
    inFlight.set(key, request);
    return request;
  };
}
