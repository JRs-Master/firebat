/**
 * MCP Internal Endpoint — Rust MCP HTTP server reverse proxy.
 *
 * Phase E cutover (2026-05-12) — 옛 Node @modelcontextprotocol/sdk 폐기.
 * 모든 도구 (sysmod / render_* / page / file / schedule / entity / episodic / search_history /
 * image_gen / network_request 등 60+) 가 Rust firebat-core binary 의 axum endpoint
 * (default 127.0.0.1:50052) 에 박혀있음. 본 route 는 frontend 의 `/api/mcp-internal`
 * 경로 호출을 그 endpoint 으로 그대로 전달 — 옛 호출자 (CLI 어댑터 / OpenAI Responses) 호환.
 *
 * FIREBAT_MCP_BASE_URL env (default http://127.0.0.1:50052) + FIREBAT_MCP_PATH env (default /mcp).
 */
import { NextRequest } from 'next/server';

const TARGET_BASE = process.env.FIREBAT_MCP_BASE_URL || 'http://127.0.0.1:50052';
const TARGET_PATH = process.env.FIREBAT_MCP_PATH || '/mcp';
const TARGET = `${TARGET_BASE}${TARGET_PATH}`;

async function proxy(req: NextRequest): Promise<Response> {
  const headers = new Headers(req.headers);
  headers.delete('host');
  headers.delete('connection');
  const init: RequestInit = {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
  };
  try {
    const upstream = await fetch(TARGET, init);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: 'Rust MCP server 연결 실패. FIREBAT_MCP_ENABLED=true + restart 확인.',
        target: TARGET,
        detail: String(err),
      }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

export const POST = proxy;
export const GET = proxy;
export const DELETE = proxy;
