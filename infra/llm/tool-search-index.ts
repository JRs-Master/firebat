/**
 * Tool Search Index — 벡터 임베딩 기반 카테고리 검색
 *
 * 목적: Gemini/Vertex처럼 hosted MCP가 없는 프로바이더는 매 요청마다 전체 도구 정의를
 * 프롬프트에 넣어야 하는데, 도구 수가 늘어나면 토큰·응답속도·정확도 모두 악화.
 * 사용자 메시지로 관련 카테고리만 뽑아 그 안의 도구만 AI에게 주는 라우팅 레이어.
 *
 * 설계:
 * - @xenova/transformers + paraphrase-multilingual-MiniLM-L12-v2 (한국어 semantic OK)
 * - 카테고리 ~8개에만 임베딩 (개별 도구 60개 아님) — 의미 분리 명확, 점수 범위 넓음
 * - 도구 → 카테고리 매핑: hardcoded prefix + capability 기반 자동 분류
 * - 디스크 캐시: data/tool-embeddings.json에 {contentHash, vector} 저장
 */
import type { ToolDefinition } from '../../core/ports';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const CACHE_FILE = path.join(process.cwd(), 'data', 'tool-embeddings.json');
const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

// ── 카테고리 정의 ─────────────────────────────────────────────────────────
// id, 의미 검색용 semanticText(길수록 좋음), 이 카테고리에 속한 도구 판정 규칙
interface CategoryDef {
  id: string;
  label: string;
  semanticText: string; // 벡터 임베딩 입력
  // 도구 이름으로 카테고리 판정 (우선), capability로 판정 (대체)
  matchByName?: (name: string) => boolean;
  matchByCapability?: string[];
}

const CATEGORIES: CategoryDef[] = [
  {
    id: 'stock',
    label: '주식·증권',
    semanticText: '주식 증권 시세 주가 종목 차트 캔들 OHLCV 이동평균 주문 매수 매도 체결 잔고 호가 거래량 코스피 코스닥 삼성전자 LG 현대 SK 상장 공시 재무 실적',
    matchByName: (n) => n === 'sysmod_kiwoom' || n === 'sysmod_korea_invest',
    matchByCapability: ['stock-trading'],
  },
  {
    id: 'crypto',
    label: '가상자산·암호화폐',
    semanticText: '업비트 비트코인 이더리움 가상자산 암호화폐 코인 알트코인 시세 거래 매수 매도 체인 블록체인 지갑',
    matchByName: (n) => n === 'sysmod_upbit',
    matchByCapability: ['crypto-trading'],
  },
  {
    id: 'search',
    label: '검색·뉴스·웹 스크래핑',
    semanticText: '검색 뉴스 웹 인터넷 블로그 쇼핑 카페 지식인 백과사전 네이버 구글 기사 스크랩 크롤링 웹페이지 URL 콘텐츠 키워드 트렌드 데이터랩',
    matchByName: (n) => n.includes('naver_search') || n.includes('naver_ads') || n.includes('firecrawl') || n.includes('browser_scrape'),
    matchByCapability: ['web-search', 'web-scrape', 'keyword-analytics'],
  },
  {
    id: 'messaging',
    label: '메시지·이메일 발송',
    semanticText: '메시지 알림 발송 전송 카톡 카카오톡 이메일 메일 지메일 Gmail 보내다 발송하다 푸시 알람 공지',
    matchByName: (n) => n.includes('kakao_talk') || (n.startsWith('mcp_gmail_') && (n.includes('send') || n.includes('draft'))),
    matchByCapability: ['notification'],
  },
  {
    id: 'mail-read',
    label: '이메일 읽기·검색',
    semanticText: '메일 이메일 편지 받은편지함 인박스 수신 검색 조회 읽기 확인 발신자 제목 내용 요약 Gmail Outlook',
    matchByName: (n) => n.startsWith('mcp_gmail_') && !n.includes('send') && !n.includes('draft'),
  },
  {
    id: 'law',
    label: '법률·법령·판례',
    semanticText: '법 법령 법률 판례 행정규칙 자치법규 헌법 조문 조항 판결 법원 소송 계약 형법 민법 상법 헌재 조약',
    matchByName: (n) => n.includes('law_search'),
    matchByCapability: ['law-search'],
  },
  {
    id: 'visualization',
    label: '차트·표·경고 등 UI 렌더링',
    semanticText: '차트 그래프 표 테이블 경고 알림 주의 박스 카드 배지 제목 헤더 리스트 목록 진행 프로그래스 이미지 그리드 시각화 렌더링 출력 보여주기',
    matchByName: (n) => n.startsWith('render_'),
  },
  {
    id: 'storage',
    label: '파일·페이지 저장·읽기·삭제',
    semanticText: '파일 페이지 문서 저장 읽기 쓰기 삭제 목록 디렉토리 폴더 업로드 다운로드 슬러그 PageSpec HTML 컴포넌트',
    matchByName: (n) => ['read_file', 'write_file', 'delete_file', 'list_dir', 'save_page', 'delete_page', 'list_pages'].includes(n),
  },
  {
    id: 'scheduling',
    label: '스케줄·예약·태스크',
    semanticText: '스케줄 예약 크론 정기 매일 매시간 몇시에 태스크 작업 자동화 즉시 실행 취소 해제 목록 조회 파이프라인',
    matchByName: (n) => ['schedule_task', 'run_task', 'cancel_task', 'list_tasks'].includes(n),
  },
  {
    id: 'module',
    label: '모듈 실행·외부 호출',
    semanticText: '모듈 실행 execute 사용자 정의 직접 호출 네트워크 요청 HTTP API 외부 서비스 MCP 서버 통합 커스텀',
    matchByName: (n) => n === 'execute' || n === 'network_request' || n === 'mcp_call' || (n.startsWith('mcp_') && !n.startsWith('mcp_gmail_')) || n.startsWith('sysmod_') === false && n.startsWith('render_') === false,
  },
];

// 안전망 — 어느 카테고리도 매칭 못 해도 항상 포함 (AI가 답변 최소 수단 확보)
const ALWAYS_INCLUDE = new Set(['render_alert', 'render_callout', 'suggest']);

let pipelinePromise: Promise<any> | null = null;
let cachedCategoryVectors: { id: string; vector: Float32Array }[] | null = null;
let cachedToolVectors: Map<string, { hash: string; vector: Float32Array }> | null = null;

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

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// ── 디스크 캐시 I/O ────────────────────────────────────────────────────────
interface DiskCacheEntry { hash: string; vector: number[]; }
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
  } catch { /* 쓰기 실패 무시 */ }
}

/**
 * 카테고리 벡터 인덱스 구축 — 부팅 1회 (카테고리 정의 변경 시 해시 불일치로 재임베딩)
 */
async function buildCategoryIndex(): Promise<{ id: string; vector: Float32Array }[]> {
  const diskCache = loadDiskCache();
  const result: { id: string; vector: Float32Array }[] = [];
  const newCache: Record<string, DiskCacheEntry> = {};
  let reused = 0, embedded = 0;

  for (const cat of CATEGORIES) {
    const text = `Category: ${cat.label}\nKeywords: ${cat.semanticText}`;
    const hash = sha1(text);
    const key = `__category:${cat.id}`;
    const hit = diskCache[key];
    if (hit && hit.hash === hash && Array.isArray(hit.vector)) {
      result.push({ id: cat.id, vector: new Float32Array(hit.vector) });
      newCache[key] = hit;
      reused++;
      continue;
    }
    try {
      const vec = await embed(text);
      result.push({ id: cat.id, vector: vec });
      newCache[key] = { hash, vector: Array.from(vec) };
      embedded++;
    } catch {
      // 임베딩 실패 카테고리는 검색에서 제외
    }
  }

  // 기존 디스크 캐시에 다른 키(예전 도구별 임베딩)가 남아있어도 무시, 새 캐시로 덮어씀
  saveDiskCache(newCache);
  process.stderr.write(`[ToolSearch] 카테고리 인덱스 빌드: ${CATEGORIES.length}개 (재사용 ${reused}, 임베딩 ${embedded})\n`);
  return result;
}

/**
 * 도구 → 카테고리 매핑. 매칭 안 되는 도구는 'utility' 또는 null 반환.
 */
function categorizeTool(tool: ToolDefinition, capability?: string): string | null {
  for (const cat of CATEGORIES) {
    if (cat.matchByName?.(tool.name)) return cat.id;
    if (cat.matchByCapability && capability && cat.matchByCapability.includes(capability)) return cat.id;
  }
  return null;
}

/** Tool-level 임베딩 텍스트 (stage 2용) */
function toolToText(tool: ToolDefinition, capability?: string): string {
  const lines = [`Tool: ${tool.name}`];
  if (tool.description) lines.push(`Desc: ${tool.description}`);
  if (capability) lines.push(`Cap: ${capability}`);
  return lines.join('\n');
}

/**
 * 도구 벡터 인덱스 빌드 — 디스크 캐시(해시)로 변경분만 재임베딩
 */
async function ensureToolVectors(
  tools: ToolDefinition[],
  capabilityOf?: (name: string) => string | undefined,
): Promise<Map<string, { hash: string; vector: Float32Array }>> {
  if (!cachedToolVectors) cachedToolVectors = new Map();
  const diskCache = loadDiskCache();
  let reused = 0, embedded = 0;

  for (const tool of tools) {
    const text = toolToText(tool, capabilityOf?.(tool.name));
    const hash = sha1(text);
    const memKey = `__tool:${tool.name}`;

    const memHit = cachedToolVectors.get(tool.name);
    if (memHit && memHit.hash === hash) { reused++; continue; }

    const diskHit = diskCache[memKey];
    if (diskHit && diskHit.hash === hash && Array.isArray(diskHit.vector)) {
      cachedToolVectors.set(tool.name, { hash, vector: new Float32Array(diskHit.vector) });
      reused++;
      continue;
    }

    try {
      const vec = await embed(text);
      cachedToolVectors.set(tool.name, { hash, vector: vec });
      diskCache[memKey] = { hash, vector: Array.from(vec) };
      embedded++;
    } catch { /* 실패한 도구는 stage 2에서 제외 */ }
  }

  // 이번에 전달받은 도구 목록에 없는 기존 엔트리는 메모리에서 삭제 (모듈 제거 반영)
  const names = new Set(tools.map(t => t.name));
  for (const name of Array.from(cachedToolVectors.keys())) {
    if (!names.has(name)) cachedToolVectors.delete(name);
  }

  if (embedded > 0) {
    saveDiskCache(diskCache);
    process.stderr.write(`[ToolSearch] 도구 인덱스 업데이트: 재사용 ${reused}, 임베딩 ${embedded}\n`);
  }
  return cachedToolVectors;
}

export class ToolSearchIndex {
  static invalidate() {
    cachedCategoryVectors = null;
    cachedToolVectors = null;
  }

  static async ensureIndex(): Promise<{ id: string; vector: Float32Array }[]> {
    if (!cachedCategoryVectors) {
      cachedCategoryVectors = await buildCategoryIndex();
    }
    return cachedCategoryVectors;
  }

  /**
   * 2단계 벡터 검색:
   *  Stage 1 — 카테고리 top-K 매칭
   *  Stage 2 — 해당 카테고리 소속 도구들을 개별 임베딩으로 재순위 (카테고리당 top-N, threshold 적용)
   *            카테고리 내 도구 수가 SMALL_CATEGORY 이하면 stage 2 스킵 (전부 포함)
   */
  static async query(
    query: string,
    tools: ToolDefinition[],
    opts: { topCategories?: number; categoryThreshold?: number; toolThreshold?: number; topToolsPerCategory?: number; capabilityOf?: (name: string) => string | undefined } = {},
  ): Promise<{ selectedToolNames: Set<string>; matchedCategories: { id: string; score: number }[] }> {
    const {
      topCategories = 3,
      categoryThreshold = 0.3,
      toolThreshold = 0.2,
      topToolsPerCategory = 5,
      capabilityOf,
    } = opts;
    if (!query.trim()) return { selectedToolNames: new Set(), matchedCategories: [] };

    const SMALL_CATEGORY = 2; // 도구 N개 이하 카테고리는 stage 2 스킵

    const catVectors = await this.ensureIndex();
    if (catVectors.length === 0) return { selectedToolNames: new Set(), matchedCategories: [] };

    // ── Stage 1: 쿼리 ↔ 카테고리 ─────────────────────────
    const q = await embed(query);
    const catScored = catVectors.map(c => ({ id: c.id, score: cosine(q, c.vector) }));
    catScored.sort((a, b) => b.score - a.score);

    const topCats = catScored.slice(0, 5).map(s => `${s.id}:${s.score.toFixed(3)}`).join(' ');
    const qPreview = query.length > 40 ? query.slice(0, 40) + '…' : query;
    process.stderr.write(`[ToolSearch] stage1 query="${qPreview}" cats=[${topCats}]\n`);

    let pickedCats = catScored.filter(s => s.score >= categoryThreshold).slice(0, topCategories);
    if (pickedCats.length === 0) pickedCats = catScored.slice(0, 1);
    const pickedCatIds = new Set(pickedCats.map(p => p.id));

    // 카테고리별 도구 그룹화
    const toolsByCategory = new Map<string, ToolDefinition[]>();
    for (const tool of tools) {
      const catId = categorizeTool(tool, capabilityOf?.(tool.name));
      if (!catId || !pickedCatIds.has(catId)) continue;
      if (!toolsByCategory.has(catId)) toolsByCategory.set(catId, []);
      toolsByCategory.get(catId)!.push(tool);
    }

    // ── Stage 2: 카테고리 내 도구 재순위 ─────────────────
    const selectedToolNames = new Set<string>();
    for (const [catId, catTools] of toolsByCategory) {
      // 도구 수 적으면 stage 2 스킵 (전부 포함)
      if (catTools.length <= SMALL_CATEGORY) {
        for (const t of catTools) selectedToolNames.add(t.name);
        continue;
      }

      // stage 2: 도구 임베딩 (없으면 빌드) → 쿼리 매칭
      const toolVecs = await ensureToolVectors(catTools, capabilityOf);
      const toolScored = catTools
        .map(t => {
          const v = toolVecs.get(t.name);
          return v ? { name: t.name, score: cosine(q, v.vector) } : { name: t.name, score: 0 };
        })
        .sort((a, b) => b.score - a.score);

      // stage 2 로그
      const top3 = toolScored.slice(0, 3).map(s => `${s.name}:${s.score.toFixed(3)}`).join(' ');
      process.stderr.write(`[ToolSearch] stage2 cat=${catId} top3=[${top3}]\n`);

      // threshold 통과분 중 top-N, 없으면 최상위 1개는 폴백
      let picked = toolScored.filter(s => s.score >= toolThreshold).slice(0, topToolsPerCategory);
      if (picked.length === 0) picked = toolScored.slice(0, 1);
      for (const p of picked) selectedToolNames.add(p.name);
    }

    return { selectedToolNames, matchedCategories: pickedCats };
  }

  /** UI/디버그용: 등록된 카테고리 목록 */
  static listCategories() {
    return CATEGORIES.map(c => ({ id: c.id, label: c.label }));
  }
}

export { ALWAYS_INCLUDE };
