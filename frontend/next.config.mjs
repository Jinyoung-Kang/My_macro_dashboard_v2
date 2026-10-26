/**
 * 화면 응답에 붙이는 보안 헤더.
 *
 * - X-Frame-Options / frame-ancestors: 다른 사이트가 이 화면을 iframe에 넣어
 *   클릭을 가로채지(clickjacking) 못하게 합니다.
 * - nosniff: 응답을 선언한 형식 그대로만 해석하게 합니다.
 * - Referrer-Policy: 다른 사이트로 나갈 때 대시보드 주소(경로)를 넘기지 않습니다.
 *
 * 주의사항 — script-src까지 막는 전체 CSP는 넣지 않았습니다. Next.js가 인라인
 * 스크립트를 쓰므로 nonce 설정 없이 막으면 화면이 뜨지 않습니다.
 */
const SECURITY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // "X-Powered-By: Next.js"로 프레임워크를 광고하지 않습니다.
  poweredByHeader: false,
  // 백엔드 주소는 실행 시점에 화면을 연 호스트 + 백엔드 포트로 정합니다(lib/api.ts). 아래 두 값은
  // **빌드할 때** 번들에 들어갑니다(NEXT_PUBLIC_ 접두사) — 바꾼 뒤에는 다시 빌드하세요(make up).
  env: {
    NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE ?? "",
    NEXT_PUBLIC_BACKEND_PORT: process.env.NEXT_PUBLIC_BACKEND_PORT ?? "8080",
  },
  // 합쳐진 메뉴의 옛 주소. 즐겨찾기·공유 링크가 404가 되지 않게 새 화면으로 보냅니다.
  async redirects() {
    return [
      { source: "/ai/test", destination: "/connections", permanent: true },
      { source: "/toss", destination: "/connections", permanent: true },
      // 🧬 구루 포트폴리오 분석 → 🧬 기관 13F 스타일·위험 (메뉴 이름에 맞춰 주소도 변경)
      { source: "/guru", destination: "/style", permanent: true },
      // 🧪 모의매매 7탭 화면(/paper) → 미국 책(/paper/us). 임시(307)인 까닭 — 2단계에 /paper/kr이 생기면 /paper를 시장 고르는
      // 화면으로 쓸 수 있어, 브라우저가 영구(308) 리디렉션을 기억하면 그때 /paper로 갈 수 없습니다. source는 /paper 하나만
      // (/paper/:path*로 넓히면 /paper/us까지 맞아 끝없이 되돌아갑니다).
      { source: "/paper", destination: "/paper/us", permanent: false },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
