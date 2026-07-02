/**
 * MCP External Endpoint — Rust MCP HTTP server reverse proxy.
 *
 * Phase E full cutover (2026-05-12). 옛 Node @modelcontextprotocol/sdk 폐기.
 * 외부 사용자 (Claude desktop / Cursor) 의 Bearer (API token) 검증도 Rust 안에서 처리 —
 * mcp_server::verify_token 이 internal token (Vault) + API token (AuthManager) 둘 다 받음.
 *
 * Frontend route 는 단순 proxy. FIREBAT_MCP_BASE_URL + FIREBAT_MCP_PATH env override.
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
  // Forward the incoming query string (e.g. ?token=<API token>). Claude.ai's web custom-connector
  // UI has no static-token/header field — only a URL + optional OAuth — so the token must ride in
  // the URL. The Rust verify_token reads ?token= as a fallback when no Authorization header is set.
  const target = TARGET + req.nextUrl.search;
  try {
    const upstream = await fetch(target, init);
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
      }),  // note: TARGET shown without query to avoid logging the token
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    );
  }
}

export const POST = proxy;
export const GET = proxy;
export const DELETE = proxy;
