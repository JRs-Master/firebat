/**
 * Component Search Index — registry 각 컴포넌트의 벡터 임베딩과 검색.
 *
 * ToolSearchIndex 와 동일한 패턴 (disk cache + spread 판정), 다만 평면 풀.
 * AI의 search_components(query) 호출 시 여기 결과 반환.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { embedQuery, embedPassage, cosine, EMBED_VERSION } from './embedder';
import { COMPONENTS, type ComponentDef } from './component-registry';

const CACHE_FILE = path.join(process.cwd(), 'data', 'component-embeddings.json');

function sha1(s: string): string {
  return crypto.createHash('sha1').update(`${EMBED_VERSION}:${s}`, 'utf8').digest('hex');
}

interface DiskCacheEntry { hash: string; vector: number[]; }
function loadDiskCache(): Record<string, DiskCacheEntry> {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
  } catch { return {}; }
}
function saveDiskCache(cache: Record<string, DiskCacheEntry>): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch { /* ignore */ }
}

let cachedVectors: Map<string, Float32Array> | null = null;

async function ensureIndex(): Promise<Map<string, Float32Array>> {
  if (cachedVectors) return cachedVectors;
  const disk = loadDiskCache();
  const result = new Map<string, Float32Array>();
  const fresh: Record<string, DiskCacheEntry> = {};
  let reused = 0, embedded = 0;

  for (const c of COMPONENTS) {
    const text = `Component: ${c.name}\nDesc: ${c.description}\nKeywords: ${c.semanticText}`;
    const hash = sha1(text);
    const hit = disk[c.name];
    if (hit && hit.hash === hash && Array.isArray(hit.vector)) {
      result.set(c.name, new Float32Array(hit.vector));
      fresh[c.name] = hit;
      reused++;
      continue;
    }
    try {
      const vec = await embedPassage(text);
      result.set(c.name, vec);
      fresh[c.name] = { hash, vector: Array.from(vec) };
      embedded++;
    } catch { /* skip on failure */ }
  }
  saveDiskCache(fresh);
  process.stderr.write(`[ComponentSearch] 인덱스 빌드: ${COMPONENTS.length}개 (재사용 ${reused}, 임베딩 ${embedded})\n`);
  cachedVectors = result;
  return result;
}

export interface ComponentMatch {
  name: string;
  description: string;
  propsSchema: unknown;
  score: number;
}

export class ComponentSearchIndex {
  static invalidate() { cachedVectors = null; }

  /**
   * 쿼리 기반 컴포넌트 검색. spread 판정 없이 top-K 반환.
   * (컴포넌트는 수가 작고 전부 UI 용이라 노이즈 차단보다 후보 제공이 우선)
   */
  static async query(query: string, opts: { limit?: number } = {}): Promise<ComponentMatch[]> {
    const { limit = 5 } = opts;
    if (!query.trim()) return [];

    const vectors = await ensureIndex();
    const q = await embedQuery(query);

    const scored: ComponentMatch[] = [];
    for (const c of COMPONENTS) {
      const v = vectors.get(c.name);
      if (!v) continue;
      scored.push({
        name: c.name,
        description: c.description,
        propsSchema: c.propsSchema,
        score: cosine(q, v),
      });
    }
    scored.sort((a, b) => b.score - a.score);

    const top = scored.slice(0, limit);
    const logLine = top.map(t => `${t.name}:${t.score.toFixed(3)}`).join(' ');
    const qPreview = query.length > 40 ? query.slice(0, 40) + '…' : query;
    process.stderr.write(`[ComponentSearch] query="${qPreview}" top=[${logLine}]\n`);
    return top;
  }
}
