/**
 * 모든 화면 테스트 앞에 한 번 도는 준비(vitest.config.mts의 setupFiles).
 *
 * jsdom 29에 없는 브라우저 API 네 가지의 최소 스텁만 둡니다 — Radix(Dialog·Toast 등)와 테마 훅이 그릴 때 부르기 때문입니다.
 * 이미 있으면 덮지 않고, 동작은 "아무 일도 하지 않음"뿐입니다. 동작을 확인해야 하는 테스트는 지금처럼 그 테스트 안에서
 * vi.stubGlobal·Element.prototype 대입으로 덮어씁니다(그쪽이 이깁니다).
 */

if (typeof window.matchMedia !== "function") {
  // 어떤 미디어 쿼리도 맞지 않는다고 답합니다(움직임 줄이기·다크 모드 꺼짐 = 기본 화면).
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (typeof globalThis.ResizeObserver === "undefined") {
  // 관찰만 받고 크기를 알려 주지 않습니다. 크기가 필요한 차트 테스트는 직접 가짜를 겁니다(DonutChart.test.tsx).
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const elementProto = Element.prototype as Partial<Pick<Element, "scrollIntoView" | "hasPointerCapture" | "releasePointerCapture">>;
if (typeof elementProto.scrollIntoView !== "function") elementProto.scrollIntoView = () => {};
if (typeof elementProto.hasPointerCapture !== "function") elementProto.hasPointerCapture = () => false;
if (typeof elementProto.releasePointerCapture !== "function") elementProto.releasePointerCapture = () => {};

// 모듈로 둡니다(isolatedModules — 전역 스크립트로 읽히면 위 이름이 전역에 놓임).
export {};
