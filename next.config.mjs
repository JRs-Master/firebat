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
  }
};

export default nextConfig;
