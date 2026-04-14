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
import fs from 'fs';
import path from 'path';

export function createFirebatMcpServer(core: FirebatCore): McpServer {
  const server = new McpServer({
    name: 'firebat',
    version: '0.1.0',
  });

  // ── 페이지 관리 ──────────────────────────────────────────────────────────

  server.tool(
    'list_pages',
    '등록된 페이지 목록 조회 (slug, status, title, updatedAt)',
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
    '특정 slug의 PageSpec JSON 조회',
    { slug: z.string().describe('페이지 slug (예: weather-app)') },
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
- Html content는 iframe sandbox 안에서 실행됩니다.`,
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
    '페이지 삭제',
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
    '파일 읽기 (user/, docs/, system/guidelines/, system/modules/ 영역)',
    { path: z.string().describe('읽을 파일 경로 (예: user/modules/weather-app/main.py)') },
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
- 프로젝트명 = 모듈 폴더명 = 페이지 slug 통일`,
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
    '파일/디렉토리 삭제 (user/ 영역만)',
    { path: z.string().describe('삭제할 경로') },
    async ({ path }) => {
      const result = await core.deleteFile(path);
      return {
        content: [{ type: 'text', text: result.success ? '삭제 완료' : `실패: ${result.error}` }],
      };
    },
  );

  server.tool(
    'list_dir',
    '디렉토리 내 항목 목록 조회 (이름 + 디렉토리 여부)',
    { path: z.string().describe('조회할 디렉토리 경로 (예: user/modules)') },
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
    '사용자 모듈 실행 (user/modules/ 안의 모듈)',
    {
      module_name: z.string().describe('모듈 이름 (예: weather-app)'),
      input: z.record(z.string(), z.any()).optional().describe('모듈에 전달할 입력 데이터'),
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
    '프로젝트 목록 스캔 (모듈 + 페이지 통합)',
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
    '프로젝트 일괄 삭제 (모듈 + 페이지)',
    { project: z.string().describe('삭제할 프로젝트 이름') },
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
    '등록된 크론 잡 목록 조회',
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
    '크론 잡 해제',
    { job_id: z.string().describe('해제할 잡 ID') },
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
    '시스템 모듈 목록 조회 (system/modules/)',
    {},
    async () => {
      const modules = await core.getSystemModules();
      return {
        content: [{ type: 'text', text: JSON.stringify(modules, null, 2) }],
      };
    },
  );

  server.tool(
    'get_timezone',
    '현재 설정된 타임존 조회',
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
    '등록된 외부 MCP 서버 설정 목록 조회',
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
    '모든 활성 외부 MCP 서버의 사용 가능한 도구 목록',
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
    '외부 MCP 서버의 도구 실행',
    {
      server_name: z.string().describe('MCP 서버 이름'),
      tool_name: z.string().describe('실행할 도구 이름'),
      arguments: z.record(z.string(), z.any()).optional().describe('도구에 전달할 인자'),
    },
    async ({ server_name, tool_name, arguments: args }) => {
      const result = await core.callMcpTool(server_name, tool_name, args ?? {});
      return {
        content: [{ type: 'text', text: result.success ? JSON.stringify(result.data, null, 2) : `실패: ${result.error}` }],
      };
    },
  );

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
Header, Text, Image, Form, ResultDisplay, Button, Divider, Table, Card, Grid, Html, AdSlot, Slider, Tabs, Accordion, Progress, Badge, Alert, List, Carousel, Countdown, Chart

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
