/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: [],
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
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
  /** 사이트 소유권 인증 파일 — CMS verifications 배열로 통합 처리.
   *  /{filename}.txt|.html|.xml 패턴을 /api/verifications/[file] 로 rewrite.
   *  정적 routes (/robots.txt, /sitemap*.xml, /feed.xml) 는 Next.js 가 우선 매칭하므로 영향 0.
   *  user route catch-all 의 page slug 는 보통 확장자 없어 충돌 0. */
  async rewrites() {
    return [
      {
        source: '/:file(.+\\.(?:txt|html|xml))',
        destination: '/api/verifications/:file',
      },
    ];
  },
};

export default nextConfig;
