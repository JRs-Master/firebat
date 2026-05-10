/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [],
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // Standalone build — `.next/standalone/` 에 self-contained server.js + 최소 node_modules.
  // 운영 디렉토리 (/opt/firebat/frontend/) 에 cp 만 하면 끝, source 동봉 불필요.
  // Phase C Docker 시점에도 이 산출물만 사용 → 작은 image (~250MB).
  output: 'standalone',
  // TypeScript 체크는 별도 step (npm run typecheck) — `next build` 시 skip.
  // 이유: 작은 VPS (1~2GB RAM) 에서 build worker 가 tsc + Next bundling 동시 메모리 폭주 → OOM kill.
  // 안전성: 로컬·CI 에서 tsc --noEmit 매 커밋 전 검증. IDE 도 실시간 타입 체크. 빌드만 분리.
  typescript: {
    ignoreBuildErrors: true,
  },
  experimental: {
    serverActions: {
      allowedOrigins: ["localhost:3000", "127.0.0.1:3000"]
    }
  },
  /** Rewrites — 평가 순서 중요 (위에서 아래).
   *  1. /{project}/feed.xml → /feed.xml?project={project} (프로젝트별 RSS 분리)
   *     verification rewrite 보다 먼저 — 그렇지 않으면 /api/verifications/{project}/feed.xml 로 라우팅됨.
   *  2. 사이트 소유권 인증 파일 — CMS verifications 배열로 통합 처리.
   *     정적 routes (/robots.txt, /sitemap*.xml, /feed.xml) 는 Next.js 가 우선 매칭하므로 영향 0.
   *     user route catch-all 의 page slug 는 보통 확장자 없어 충돌 0. */
  async rewrites() {
    return [
      {
        source: '/:project/feed.xml',
        destination: '/feed.xml?project=:project',
      },
      {
        source: '/:file(.+\\.(?:txt|html|xml))',
        destination: '/api/verifications/:file',
      },
    ];
  },
  /** Headers — /admin 경로의 ETag·304 응답 차단 + clickjacking 방어.
   *  Cache-Control: 빌드마다 RSC payload 안의 server action ID 가 새로 발행됨. 사용자 브라우저가
   *    옛 RSC payload 를 disk cache 에 들고 있으면 새 build 후에도 ETag 비교 시 304 (Not Modified)
   *    돌아와 옛 payload 그대로 사용 → 옛 server action ID 호출 → 새 build 가 못 찾음 → throw → 500.
   *    no-store 적용 시 매 요청마다 fresh fetch → server action ID 자동 sync.
   *  X-Frame-Options + CSP frame-ancestors: clickjacking 방어 — 어떤 외부 사이트도 admin/login
   *    페이지를 iframe 으로 임베드 할 수 없게 차단. 사용자 쿠키 자동 첨부로 인한 위장 클릭 사건 차단.
   *  /login 도 같이 적용 — SetupWizard 단계에서도 동일 위험. */
  async headers() {
    const securityHeaders = [
      { key: 'Cache-Control', value: 'no-store, must-revalidate' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
    ];
    return [
      { source: '/admin/:path*', headers: securityHeaders },
      { source: '/admin', headers: securityHeaders },
      { source: '/login', headers: securityHeaders },
    ];
  },
};

export default nextConfig;
