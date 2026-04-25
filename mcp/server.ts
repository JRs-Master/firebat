/**
 * Firebat MCP Server — 도구 정의
 *
 * 외부 AI(Claude Code, Cursor 등)가 파이어뱃 user 영역을 조작할 수 있도록
 * Core 메서드를 MCP 도구로 노출한다.
 *
 * Primary Adapter: MCP 프로토콜 → Core 메서드 호출
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FirebatCore } from '../core/index';

// fs/path는 Turbopack NFT 추적 방지를 위해 함수 내부에서 동적 로드
let _fs: typeof import('fs') | null = null;
let _path: typeof import('path') | null = null;
function getFs() { if (!_fs) _fs = require('fs'); return _fs!; }
function getPath() { if (!_path) _path = require('path'); return _path!; }

export function createFirebatMcpServer(core: FirebatCore): McpServer {
  const fs = getFs();
  const path = getPath();
  const server = new McpServer({
    name: 'firebat',
    version: '0.1.0',
  });

  // ── 페이지 관리 ──────────────────────────────────────────────────────────

  server.tool(
    'list_pages',
    `등록된 모든 페이지 메타데이터 목록을 반환한다.
반환: [{slug, title, status: 'published'|'draft', project?, visibility?: 'public'|'password'|'private', createdAt?, updatedAt?}]
사용 시점: 페이지 전체 목록 확인, 특정 프로젝트 소속 페이지 파악, slug 존재 여부 확인 전에.`,
    {},
    async () => {
      const result = await core.listPages();
      return {
        content: [{ type: 'text', text: JSON.stringify(result.success ? result.data : { error: result.error }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_page',
    `특정 slug의 전체 PageSpec JSON을 조회한다.
반환: {slug, head?: {title, description, keywords[], og?}, body: [{type, props}], project?, _visibility?}
사용 시점: 기존 페이지 수정 전 현재 구조 확인, 템플릿으로 활용, 디버깅.
실패: 페이지가 없으면 error 반환.`,
    { slug: z.string().describe('페이지 slug (kebab-case, 한글 허용). list_pages로 확인 가능') },
    async ({ slug }) => {
      const result = await core.getPage(slug);
      return {
        content: [{ type: 'text', text: JSON.stringify(result.success ? result.data : { error: result.error }, null, 2) }],
      };
    },
  );

  server.tool(
    'save_page',
    `페이지 저장 (upsert). 반드시 아래 PageSpec 형식을 따라야 합니다:
{
  "slug": "kebab-case-url",
  "status": "published",
  "project": "project-name",
  "head": {
    "title": "페이지 제목",
    "description": "페이지 설명",
    "keywords": ["키워드"]
  },
  "body": [
    { "type": "Html", "props": { "content": "<전체 HTML 코드>" } }
  ]
}
- body는 컴포넌트 배열. Html 컴포넌트의 props.content에 HTML+CSS+JS를 넣으세요.
- 절대로 { title, html } 같은 자체 형식을 사용하지 마세요.
- Html content는 iframe sandbox 안에서 실행됩니다.
- body에 쓸 수 있는 컴포넌트: Header, Text, Image, Form, Button, Divider, Table, Metric, KeyValue, Progress, Chart, StockChart, Timeline, Compare, Alert, Callout, Badge, StatusBadge, Countdown, List, Carousel, Tabs, Accordion, Card, Grid, Html, Slider, AdSlot (전체 27종). 상세 스키마는 firebat://guides/pagespec 리소스 참조.`,
    {
      slug: z.string().describe('페이지 slug (kebab-case)'),
      spec: z.string().describe('PageSpec JSON 문자열 — 반드시 위 형식 준수. body[].type은 "Html", body[].props.content에 HTML 코드'),
    },
    async ({ slug, spec }) => {
      const result = await core.savePage(slug, spec);
      return {
        content: [{ type: 'text', text: result.success ? '페이지 저장 완료' : `실패: ${result.error}` }],
      };
    },
  );

  server.tool(
    'delete_page',
    `페이지를 영구 삭제한다. 사용자 확인 없이 즉시 삭제되므로 신중하게 사용하라.
사용 시점: 사용자가 명시적으로 삭제 요청한 페이지만.
주의: 복구 불가. 프로젝트 전체 삭제는 delete_project 사용.`,
    { slug: z.string().describe('삭제할 페이지 slug') },
    async ({ slug }) => {
      const result = await core.deletePage(slug);
      return {
        content: [{ type: 'text', text: result.success ? '페이지 삭제 완료' : `실패: ${result.error}` }],
      };
    },
  );

  // ── 파일 시스템 (user/ 영역만) ──────────────────────────────────────────

  server.tool(
    'read_file',
    `파일 텍스트 내용 읽기.
허용 구역: user/, docs/, system/modules/
금지 구역: core/, infra/, app/, data/, system/services/ 등 시스템 영역
사용 시점: 기존 모듈 코드 검토, 문서 참조, 디버깅.
반환: 파일 내용 문자열. 경로 없거나 권한 없으면 error.`,
    { path: z.string().describe('읽을 파일 경로. 예: user/modules/weather-app/main.py, docs/FIREBAT_BIBLE.md') },
    async ({ path }) => {
      const result = await core.readFile(path);
      return {
        content: [{ type: 'text', text: result.success ? result.data! : `실패: ${result.error}` }],
      };
    },
  );

  server.tool(
    'write_file',
    `파일 쓰기 (user/ 영역만). 부모 디렉토리 자동 생성.
모듈 작성 시 반드시 준수:
- 경로: user/modules/{모듈명}/main.py 또는 index.js
- config.json 필수: { "name", "type": "utility", "runtime": "python", "project": "모듈명", "packages": [], "input": {}, "output": {} }
- I/O: stdin으로 JSON 읽기, stdout 마지막 줄에 { "success": true, "data": {...} } 출력
- Python: True/False/None 사용 (true/false/null 아님)
- 프로젝트명 = 모듈 폴더명 = 페이지 slug 통일

Reusable 5 규칙 (user/modules — reuse 모토 보호, AI 자율 신규 작성 default · 사용자 명시 우회 시 따름):
1. 외부 API 호출 = sysmod_* 만 (fetch/axios 외부 도메인 default 금지)
2. 시크릿 직접 사용 금지 (sysmod 가 Vault 자동 주입)
3. UI 렌더링 = render_* 도구만 (HTML 직접 생성 X)
4. 조건 분기 = 모듈 내부 코드 OR pipeline CONDITION step
5. 모듈 간 직접 호출 금지 (require/import X). 다른 모듈 사용은 TaskManager 경유 OK (격리 라인 보호 + reuse 활성화)`,
    {
      path: z.string().describe('쓸 파일 경로 (예: user/modules/weather-app/main.py)'),
      content: z.string().describe('파일 내용'),
    },
    async ({ path, content }) => {
      const result = await core.writeFile(path, content);
      return {
        content: [{ type: 'text', text: result.success ? '파일 저장 완료' : `실패: ${result.error}` }],
      };
    },
  );

  server.tool(
    'delete_file',
    `파일 또는 디렉토리 영구 삭제 (user/ 영역만).
허용 구역: user/modules/* 만
사용 시점: 사용자가 명시적으로 삭제 요청한 경우.
주의: 디렉토리 삭제 시 하위 전체 영구 삭제. 복구 불가.`,
    { path: z.string().describe('삭제할 경로. 예: user/modules/old-app') },
    async ({ path }) => {
      const result = await core.deleteFile(path);
      return {
        content: [{ type: 'text', text: result.success ? '삭제 완료' : `실패: ${result.error}` }],
      };
    },
  );

  server.tool(
    'list_dir',
    `디렉토리 내 항목 목록 조회.
반환: [{name: 파일명, isDirectory: boolean}]
사용 시점: 프로젝트 구조 파악, 특정 파일 존재 여부 확인.
허용: user/, docs/, system/modules/`,
    { path: z.string().describe('조회할 디렉토리 경로. 예: user/modules, user/modules/weather-app') },
    async ({ path }) => {
      const result = await core.getFileTree(path);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // ── 모듈 실행 ──────────────────────────────────────────────────────────

  server.tool(
    'run_module',
    `사용자 모듈(user/modules/) 샌드박스 실행. 모듈의 config.json input 스키마에 따라 입력 전달.
I/O: stdin으로 {correlationId, data: input} JSON → 모듈이 stdout 마지막 줄에 {success: true, data: {...}} 반환.
사용 시점: 모듈 테스트, 사용자가 모듈 실행 요청.
실패: 모듈 없음, 타임아웃(30초), stdout JSON 형식 오류, 모듈 내부 error throw.`,
    {
      module_name: z.string().describe('user/modules/ 내 모듈 폴더명 (예: weather-app)'),
      input: z.record(z.string(), z.any()).optional().describe('config.json input.properties 스키마에 맞는 값. 예: {query:"서울", days:3}'),
    },
    async ({ module_name, input }) => {
      const result = await core.runModule(module_name, input ?? {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result.success ? result.data : { error: result.error }, null, 2) }],
      };
    },
  );

  // ── 프로젝트 관리 ──────────────────────────────────────────────────────

  server.tool(
    'list_projects',
    `전체 프로젝트 목록 스캔. 프로젝트 = 모듈 + 페이지 그룹.
반환: [{name, pages: [...], modules: [...]}]
사용 시점: 전체 앱 구조 파악, 프로젝트 존재 여부 확인.
네이밍 규칙: 프로젝트명 = 모듈 폴더명 = 페이지 slug 통일.`,
    {},
    async () => {
      const projects = await core.scanProjects();
      return {
        content: [{ type: 'text', text: JSON.stringify(projects, null, 2) }],
      };
    },
  );

  server.tool(
    'delete_project',
    `프로젝트 전체(모듈 폴더 + 소속 페이지 모두)를 일괄 영구 삭제.
사용 시점: 사용자가 명시적으로 프로젝트 전체 삭제 요청.
주의: 복구 불가. 단일 페이지만 지우려면 delete_page 사용.`,
    { project: z.string().describe('삭제할 프로젝트명 (= 모듈 폴더명 = 페이지 slug)') },
    async ({ project }) => {
      const result = await core.deleteProject(project);
      return {
        content: [{ type: 'text', text: result.success ? JSON.stringify(result.data, null, 2) : `실패: ${result.error}` }],
      };
    },
  );

  // ── 크론/스케줄링 ──────────────────────────────────────────────────────

  server.tool(
    'list_cron_jobs',
    `등록된 크론/예약 작업 전체 목록.
반환: [{jobId, targetPath, title?, mode: 'cron'|'once'|'delay', cronTime?, runAt?, delaySec?, inputData?, pipeline?, createdAt}]
사용 시점: 예약 작업 현황 확인, cancel_cron_job의 jobId 얻기 전.
모드: cron(반복), once(특정 시각 1회), delay(N초 후 1회).`,
    {},
    async () => {
      const jobs = core.listCronJobs();
      return {
        content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }],
      };
    },
  );

  server.tool(
    'cancel_cron_job',
    `크론/예약 작업 영구 해제. 실행 중이면 다음 발화 전에 중단.
사용 시점: 사용자가 명시적으로 예약 해제 요청한 경우.
주의: 해제 후 복구 불가. 재등록 필요.`,
    { job_id: z.string().describe('해제할 잡 ID (list_cron_jobs로 확인)') },
    async ({ job_id }) => {
      const result = await core.cancelCronJob(job_id);
      return {
        content: [{ type: 'text', text: result.success ? '잡 해제 완료' : `실패: ${result.error}` }],
      };
    },
  );

  // ── 시스템 조회 ────────────────────────────────────────────────────────

  server.tool(
    'list_system_modules',
    `Firebat 내장 시스템 모듈(system/modules/) 목록.
반환: [{name, description, capability, providerType, input, output, secrets[]}]
사용 시점: 어떤 기능 사용 가능한지 확인 (kiwoom 주식, naver_search 검색, kakao_talk 메시지 등).
중요: 각 모듈은 sysmod_{name} 전용 도구로도 호출 가능 (예: sysmod_kiwoom).`,
    {},
    async () => {
      const modules = await core.getSystemModules();
      return {
        content: [{ type: 'text', text: JSON.stringify(modules, null, 2) }],
      };
    },
  );

  server.tool(
    'search_history',
    `파이어뱃 어드민 채팅의 과거 대화를 벡터 검색.
반환: [{convId, convTitle, role, preview, score, createdAt}]
사용 시점: 유저가 파이어뱃에서 과거에 나눈 대화·결론·요청을 참조할 때.
주의: 이 서버 소유자(admin)의 Firebat 어드민 채팅 DB 대상이지, 외부 AI 자체 대화 기록은 아님.`,
    {
      query: z.string().describe('검색 쿼리 — 의미 기반 매칭 (예: "삼성전자 분석 결론")'),
      limit: z.number().int().optional().describe('반환할 최대 결과 수 (기본 5)'),
    },
    async ({ query, limit }) => {
      const result = await core.searchConversationHistory('admin', query, {
        limit: typeof limit === 'number' ? limit : 5,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.success ? result.data : { error: result.error }, null, 2) }],
      };
    },
  );

  server.tool(
    'get_timezone',
    `현재 시스템 타임존 IANA 문자열 반환 (예: "Asia/Seoul", "UTC").
사용 시점: 스케줄 등록 전 현재 타임존 확인, 시각 표시 포맷팅.`,
    {},
    async () => {
      return {
        content: [{ type: 'text', text: core.getTimezone() }],
      };
    },
  );

  // ── MCP 클라이언트 (외부 MCP 서버 관리) ──────────────────────────────

  server.tool(
    'list_mcp_servers',
    `Firebat이 연결된 외부 MCP 서버 설정 목록.
반환: [{name, transport: 'stdio'|'sse', command?, args?, url?, enabled}]
사용 시점: Gmail/Slack 등 외부 MCP 서버 연결 상태 확인.
Firebat MCP 서버 자체가 아니라 Firebat이 클라이언트로 접속한 외부 서버들임.`,
    {},
    async () => {
      const servers = core.listMcpServers();
      return {
        content: [{ type: 'text', text: JSON.stringify(servers, null, 2) }],
      };
    },
  );

  server.tool(
    'list_mcp_tools',
    `활성화된 모든 외부 MCP 서버의 사용 가능한 도구 목록.
반환: [{server, name, description, inputSchema?}]
사용 시점: call_mcp_tool 호출 전 tool_name 확인, 어떤 외부 기능 가능한지 파악.`,
    {},
    async () => {
      const result = await core.listAllMcpTools();
      return {
        content: [{ type: 'text', text: JSON.stringify(result.success ? result.data : { error: result.error }, null, 2) }],
      };
    },
  );

  server.tool(
    'call_mcp_tool',
    `외부 MCP 서버의 도구를 호출. Firebat MCP 클라이언트가 대상 서버에 JSON-RPC로 호출.
사용 시점: 외부 서비스(Gmail, Slack 등) 기능 사용 — list_mcp_tools로 도구명 확인 후 실행.
arguments는 해당 도구의 inputSchema 준수 필요.
실패: 서버 연결 끊김, 도구 없음, 인자 스키마 불일치.`,
    {
      server_name: z.string().describe('MCP 서버 이름 (list_mcp_servers로 확인)'),
      tool_name: z.string().describe('실행할 도구 이름 (list_mcp_tools로 확인)'),
      arguments: z.record(z.string(), z.any()).optional().describe('도구 inputSchema 준수한 인자 JSON'),
    },
    async ({ server_name, tool_name, arguments: args }) => {
      const result = await core.callMcpTool(server_name, tool_name, args ?? {});
      return {
        content: [{ type: 'text', text: result.success ? JSON.stringify(result.data, null, 2) : `실패: ${result.error}` }],
      };
    },
  );

  // ── 시스템 모듈 → 개별 MCP 도구 자동 등록 ────────────────────────────────

  const sysModulesDir = path.resolve(process.cwd(), 'system/modules');
  if (fs.existsSync(sysModulesDir)) {
    const modDirs = fs.readdirSync(sysModulesDir, { withFileTypes: true })
      .filter(d => d.isDirectory());

    for (const dir of modDirs) {
      const configPath = path.join(sysModulesDir, dir.name, 'config.json');
      if (!fs.existsSync(configPath)) continue;

      try {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (cfg.type !== 'module' || !cfg.input?.properties) continue;

        const rt = cfg.runtime === 'node' ? 'index.mjs' : cfg.runtime === 'python' ? 'main.py' : 'index.mjs';
        const modulePath = `system/modules/${dir.name}/${rt}`;
        const toolName = `sysmod_${dir.name}`;
        const requiredFields: string[] = cfg.input.required || [];

        // JSON Schema properties → Zod schema
        const zodProps: Record<string, z.ZodTypeAny> = {};
        for (const [key, prop] of Object.entries(cfg.input.properties as Record<string, any>)) {
          let zType: z.ZodTypeAny;
          switch (prop.type) {
            case 'string':
              zType = prop.enum?.length > 0
                ? z.enum(prop.enum as [string, ...string[]])
                : z.string();
              break;
            case 'integer':
              zType = z.number().int();
              break;
            case 'number':
              zType = z.number();
              break;
            case 'boolean':
              zType = z.boolean();
              break;
            case 'array':
              zType = z.array(z.any());
              break;
            case 'object':
              zType = z.record(z.string(), z.any());
              break;
            default:
              zType = z.any();
          }
          if (prop.description) zType = zType.describe(prop.description);
          if (!requiredFields.includes(key)) zType = zType.optional();
          zodProps[key] = zType;
        }

        // config.json 상세 정보를 설명에 포함 (input/output 스키마 힌트)
        const inputHint = cfg.input?.properties
          ? '\n입력 필드: ' + Object.entries(cfg.input.properties as Record<string, { type?: string; description?: string; enum?: unknown[] }>)
              .map(([k, v]) => `${k}${cfg.input.required?.includes(k) ? '*' : ''}: ${v.type || 'any'}${v.enum ? ` (enum: ${v.enum.slice(0, 8).join('/')}${v.enum.length > 8 ? '...' : ''})` : ''}${v.description ? ` — ${v.description}` : ''}`)
              .slice(0, 10).join('; ')
          : '';
        const outputHint = cfg.output?.properties
          ? '\n반환 필드: ' + Object.keys(cfg.output.properties).slice(0, 8).join(', ')
          : '';
        const capHint = cfg.capability ? `\ncapability: ${cfg.capability} (${cfg.providerType || '?'})` : '';
        const secretHint = cfg.secrets?.length ? `\n필요 시크릿: ${cfg.secrets.join(', ')} (미설정 시 request_secret)` : '';
        const description = `[시스템 모듈] ${cfg.description || dir.name}${capHint}${inputHint}${outputHint}${secretHint}`;

        server.tool(
          toolName,
          description,
          zodProps,
          async (args) => {
            const result = await core.sandboxExecute(modulePath, args);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(result.success ? result.data : { error: result.error }, null, 2),
              }],
            };
          },
        );
      } catch { /* config 파싱 실패 — 무시 */ }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  리소스 — 파이어뱃 규칙/스펙 문서 (Claude Code가 참조)
  // ══════════════════════════════════════════════════════════════════════════

  const docsDir = path.resolve(process.cwd(), 'docs');

  // 바이블 문서 리소스
  const bibles = [
    { name: 'firebat-bible', file: 'FIREBAT_BIBLE.md', desc: '파이어뱃 전체 아키텍처 원칙' },
    { name: 'core-bible', file: 'CORE_BIBLE.md', desc: 'Core 계층 설계 규칙' },
    { name: 'infra-bible', file: 'INFRA_BIBLE.md', desc: 'Infra 계층 설계 규칙' },
    { name: 'module-bible', file: 'MODULE_BIBLE.md', desc: '모듈 작성 수칙 (I/O 프로토콜, config.json 규약)' },
  ];

  for (const bible of bibles) {
    server.resource(
      bible.name,
      `firebat://docs/${bible.name}`,
      { description: bible.desc, mimeType: 'text/markdown' },
      async () => {
        const filePath = path.join(docsDir, bible.file);
        const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '문서를 찾을 수 없습니다.';
        return {
          contents: [{ uri: `firebat://docs/${bible.name}`, text: content, mimeType: 'text/markdown' }],
        };
      },
    );
  }

  // PageSpec 구조 리소스
  server.resource(
    'pagespec-guide',
    'firebat://guides/pagespec',
    { description: 'PageSpec JSON 구조 가이드 — 페이지 생성 시 필수 참조', mimeType: 'text/markdown' },
    async () => ({
      contents: [{
        uri: 'firebat://guides/pagespec',
        mimeType: 'text/markdown',
        text: `# PageSpec 구조 가이드

페이지 생성 시 \`save_page\` 도구에 전달하는 JSON 형식입니다.

\`\`\`json
{
  "slug": "kebab-case-url",
  "status": "published",
  "project": "project-name",
  "head": {
    "title": "페이지 제목",
    "description": "페이지 설명",
    "keywords": ["키워드"],
    "og": { "title": "...", "description": "...", "image": "", "type": "website" }
  },
  "body": [
    { "type": "Html", "props": { "content": "<div>...</div>" } }
  ]
}
\`\`\`

## 규칙
- **slug**: 영문 kebab-case. 프로젝트명과 통일 권장
- **project**: 모듈의 config.json project와 동일 값 → 프로젝트 단위 일괄 삭제 가능
- **body**: 컴포넌트 배열. Html 컴포넌트를 메인으로 사용 (iframe sandbox 안에서 실행)

## 사용 가능한 컴포넌트
**레이아웃**: Card, Grid, Divider, Tabs, Accordion, Carousel
**텍스트·이미지**: Header, Text, Image
**데이터**: Table, Metric, KeyValue, Progress, Chart, StockChart, Timeline, Compare
**상태·알림**: Alert, Callout, Badge, StatusBadge, Countdown
**인터랙티브**: Form, Button, Slider
**자유 HTML**: Html (iframe sandbox — CDN·차트·애니메이션 자유)
**광고**: AdSlot

## Html 컴포넌트
- iframe sandbox="allow-scripts" 안에서 실행
- HTML + CSS + JavaScript 자유롭게 사용 가능
- 외부 CDN 사용 가능 (Google Fonts, Chart.js, Three.js 등)
- \`<style>\` 태그로 CSS, \`<script>\` 태그로 JS 작성

## Form bindModule
Form 컴포넌트에서 \`bindModule\`로 백엔드 모듈 연결:
\`\`\`json
{ "type": "Form", "props": { "bindModule": "module-name", "fields": [...] } }
\`\`\`
모듈은 \`user/modules/module-name/\`에 위치해야 합니다.
`,
      }],
    }),
  );

  // config.json 규약 리소스
  server.resource(
    'module-guide',
    'firebat://guides/module',
    { description: '모듈 작성 가이드 — config.json 구조, I/O 프로토콜', mimeType: 'text/markdown' },
    async () => ({
      contents: [{
        uri: 'firebat://guides/module',
        mimeType: 'text/markdown',
        text: `# 모듈 작성 가이드

## 파일 구조
\`\`\`
user/modules/my-module/
  ├── config.json    (필수)
  ├── main.py        (Python) 또는
  ├── index.js       (Node.js) 또는
  └── main.php       (PHP)
\`\`\`

## config.json 필수 필드
\`\`\`json
{
  "name": "my-module",
  "type": "utility",
  "version": "1.0.0",
  "description": "모듈 설명",
  "runtime": "python",
  "project": "my-module",
  "packages": ["requests"],
  "secrets": ["API_KEY"],
  "input": { "query": "string (required)" },
  "output": { "result": "string" }
}
\`\`\`

## I/O 프로토콜

### 입력 (stdin)
\`\`\`json
{ "correlationId": "req-12345", "data": { "query": "검색어" } }
\`\`\`

### 출력 (stdout 마지막 줄)
\`\`\`json
{ "success": true, "data": { "result": "결과" } }
\`\`\`
또는
\`\`\`json
{ "success": false, "error": "에러 메시지" }
\`\`\`

## 주의사항
- stdin에서 JSON 한 줄 읽기 (sys.argv/process.argv 절대 금지)
- stdout 마지막 줄에만 결과 JSON 출력
- 디버그 로그는 stderr로 출력
- Python: True/False/None 사용 (JSON의 true/false/null 아님)
- 시크릿은 환경변수로 접근: \`os.environ["API_KEY"]\` (Python), \`process.env["API_KEY"]\` (Node)
- packages 필드에 선언하면 Sandbox가 자동 설치
`,
      }],
    }),
  );

  // 네이밍 규칙 리소스
  server.resource(
    'naming-rules',
    'firebat://guides/naming',
    { description: '네이밍 규칙 — 프로젝트명, 슬러그, 모듈 폴더명 통일 규칙', mimeType: 'text/markdown' },
    async () => ({
      contents: [{
        uri: 'firebat://guides/naming',
        mimeType: 'text/markdown',
        text: `# 파이어뱃 네이밍 규칙

## 핵심 원칙: 프로젝트명 = 모듈 폴더명 = 페이지 slug 통일

| 항목 | 형식 | 예시 |
|---|---|---|
| 프로젝트명 | kebab-case | weather-app |
| 모듈 폴더 | user/modules/{프로젝트명}/ | user/modules/weather-app/ |
| 페이지 slug | {프로젝트명} | weather-app |
| config.json project | {프로젝트명} | "project": "weather-app" |
| PageSpec project | {프로젝트명} | "project": "weather-app" |

## 한 프로젝트에 페이지가 여러 개일 경우
slug에 접미사: weather-app, weather-app-settings, weather-app-history

## 허용 쓰기 구역
- user/modules/{module-name}/ 만
- 절대 금지: core/, infra/, system/, app/admin/, app/api/

## UI 텍스트
- 한국어 사용
- 모듈/파일명은 영어 kebab-case
`,
      }],
    }),
  );

  // ══════════════════════════════════════════════════════════════════════════
  //  프롬프트 — 파이어뱃 앱 생성 가이드
  // ══════════════════════════════════════════════════════════════════════════

  server.prompt(
    'create-app',
    '파이어뱃 앱 생성 가이드 — 페이지 + 모듈 생성 절차를 안내',
    { app_name: z.string().describe('만들 앱 이름 (kebab-case)') },
    ({ app_name }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `파이어뱃에 "${app_name}" 앱을 만들어주세요.

다음 순서로 진행하세요:
1. firebat://guides/pagespec 리소스를 읽고 PageSpec 구조를 확인
2. firebat://guides/module 리소스를 읽고 모듈 구조를 확인
3. firebat://guides/naming 리소스를 읽고 네이밍 규칙을 확인
4. save_page 도구로 PageSpec JSON을 저장 (slug: "${app_name}")
5. 백엔드가 필요하면 write_file 도구로 config.json + main.py/index.js 생성
6. run_module 도구로 모듈 테스트

모든 코드는 프로덕션 수준의 디자인으로 작성하세요 (그라디언트, 애니메이션, 반응형).`,
        },
      }],
    }),
  );

  return server;
}
