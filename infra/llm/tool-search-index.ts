/**
 * Tool Search Index — 벡터 임베딩 기반 도구 검색
 *
 * 목적: Gemini/Vertex처럼 hosted MCP가 없는 프로바이더는 매 요청마다 전체 도구 정의를
 * 프롬프트에 넣어야 하는데, 도구 수가 늘어나면 토큰·응답속도·정확도 모두 악화.
 * 사용자 메시지로 관련 도구만 골라 AI에게 주는 라우팅 레이어.
 *
 * 설계:
 * - @xenova/transformers + paraphrase-multilingual-MiniLM-L12-v2 (한국어 semantic OK)
 * - 부팅 시 모든 도구(name + description + capability)를 임베딩
 * - 디스크 캐시: data/tool-embeddings.json에 {contentHash, vector} 저장 → 변경된 도구만 재임베딩
 * - 쿼리 시 사용자 메시지를 임베딩해 cosine similarity로 top-K 반환
 * - 모듈 on/off 시 invalidate() → 메모리 필터만 재구성 (임베딩 재사용)
 */
import type { ToolDefinition } from '../../core/ports';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_FILE = path.join(process.cwd(), 'data', 'tool-embeddings.json');
const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

let pipelinePromise: Promise<any> | null = null;
let cachedEntries: IndexEntry[] | null = null;
let buildPromise: Promise<IndexEntry[]> | null = null;

interface IndexEntry {
  name: string;
  hash: string;       // content SHA-1 (라벨 포맷 포함) — 변경 감지용
  vector: Float32Array;
}

interface DiskCacheEntry {
  hash: string;
  vector: number[];   // JSON 직렬화 위해 number[]
}

async function getEmbedder() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      env.cacheDir = '.cache/transformers';
      env.allowLocalModels = true;
      return await pipeline('feature-extraction', MODEL_NAME);
    })();
  }
  return pipelinePromise;
}

async function embed(text: string): Promise<Float32Array> {
  const extractor = await getEmbedder();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return output.data as Float32Array;
}

function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * 임베딩 입력 텍스트 — 라벨 포맷으로 모델이 구조 인지 (이름·설명·capability 구분)
 */
function toolToText(tool: ToolDefinition, capability?: string): string {
  const lines: string[] = [];
  lines.push(`Tool: ${tool.name}`);
  if (tool.description) lines.push(`Desc: ${tool.description}`);
  if (capability) lines.push(`Cap: ${capability}`);
  return lines.join('\n');
}

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// ── 디스크 캐시 I/O ────────────────────────────────────────────────────────
function loadDiskCache(): Record<string, DiskCacheEntry> {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return {}; }
}

function saveDiskCache(cache: Record<string, DiskCacheEntry>): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch { /* 쓰기 실패 무시 — 다음 부팅 시 재생성 */ }
}

/**
 * 도구 목록으로 인덱스 구축 — 디스크 캐시와 해시 비교, 변경된 것만 재임베딩
 */
async function buildIndex(tools: ToolDefinition[], capabilityOf?: (name: string) => string | undefined): Promise<IndexEntry[]> {
  const diskCache = loadDiskCache();
  const entries: IndexEntry[] = [];
  const newCache: Record<string, DiskCacheEntry> = {};
  let reused = 0;
  let embedded = 0;

  for (const t of tools) {
    const text = toolToText(t, capabilityOf?.(t.name));
    const hash = sha1(text);

    const hit = diskCache[t.name];
    if (hit && hit.hash === hash && Array.isArray(hit.vector)) {
      // 캐시 재사용
      entries.push({ name: t.name, hash, vector: new Float32Array(hit.vector) });
      newCache[t.name] = hit;
      reused++;
      continue;
    }

    try {
      const vec = await embed(text);
      entries.push({ name: t.name, hash, vector: vec });
      newCache[t.name] = { hash, vector: Array.from(vec) };
      embedded++;
    } catch {
      // 임베딩 실패 도구는 인덱스 누락 (검색에 안 나옴)
    }
  }

  // 디스크 캐시 업데이트 (제거된 도구는 자연 삭제됨)
  saveDiskCache(newCache);
  // 빌드 요약 로그 (stderr — Core/Infra 환경 모두 동작)
  process.stderr.write(`[ToolSearch] 인덱스 빌드: ${tools.length}개 (재사용 ${reused}, 임베딩 ${embedded})\n`);
  return entries;
}

export class ToolSearchIndex {
  /**
   * 인덱스 무효화 — 도구 목록 변경 시 호출. 다음 query에서 재구축.
   * 디스크 캐시는 해시로 관리되므로 재사용 가능한 것은 그대로 씀.
   */
  static invalidate() {
    cachedEntries = null;
    buildPromise = null;
  }

  /** 준비된 인덱스 반환 (최초/invalidate 후엔 빌드, 그 외엔 캐시) */
  static async ensureIndex(tools: ToolDefinition[], capabilityOf?: (name: string) => string | undefined): Promise<IndexEntry[]> {
    if (cachedEntries) return cachedEntries;
    if (!buildPromise) {
      buildPromise = buildIndex(tools, capabilityOf).then(e => {
        cachedEntries = e;
        return e;
      });
    }
    return buildPromise;
  }

  /**
   * 쿼리와 유사한 도구 top-K 반환 + 점수 분포 로깅 (캘리브레이션용)
   */
  static async query(
    query: string,
    tools: ToolDefinition[],
    opts: { topK?: number; threshold?: number; capabilityOf?: (name: string) => string | undefined } = {},
  ): Promise<{ name: string; score: number }[]> {
    const { topK = 10, threshold = 0.35, capabilityOf } = opts;
    if (!query.trim()) return [];

    const entries = await this.ensureIndex(tools, capabilityOf);
    if (entries.length === 0) return [];

    const q = await embed(query);
    const scored = entries.map(e => ({ name: e.name, score: cosine(q, e.vector) }));
    scored.sort((a, b) => b.score - a.score);

    // 캘리브레이션 로그 — top-8 점수 분포 (threshold 튜닝 자료)
    const top8 = scored.slice(0, 8).map(s => `${s.name}:${s.score.toFixed(3)}`).join(' ');
    const qPreview = query.length > 40 ? query.slice(0, 40) + '…' : query;
    process.stderr.write(`[ToolSearch] query="${qPreview}" top8=[${top8}] threshold=${threshold}\n`);

    return scored.filter(s => s.score >= threshold).slice(0, topK);
  }
}
