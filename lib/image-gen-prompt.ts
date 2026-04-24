/**
 * image_gen 도구 설명 — MCP 서버 + AiManager buildToolDefinitions 공통 source.
 *
 * 왜 공용 파일?
 *  - 같은 도구 description 이 두 군데 (MCP internal-server.ts, AiManager) 에 등장
 *  - 한쪽만 수정하면 CLI·API 모드에서 AI 행동이 엇갈림
 *  - 프롬프트 엔지니어링 가이드를 여기 중앙집중
 *
 * 철학: Firebat 은 범용 에이전트라 "블로그 헤더·유튜브 썸네일" 같은 고정 preset
 *   박지 않음. 대신 AI 에게 **어떻게 프롬프트 쓸지** 가이드 주입 → AI 가 상황 판단.
 */

export const IMAGE_GEN_DESCRIPTION = `AI 이미지 생성 + 서버 자동 저장. 반환 URL 을 render_image 의 src 에 바로 넣거나 블로그 포스팅에 첨부.

**사용 시점**:
- 사용자가 '이미지/그림/사진/썸네일/일러스트/로고' 명시 요청
- 블로그·기사·리포트에 시각 자산 필요
- 콘텐츠에 헤더 이미지 효과적일 때

**쓰지 마라 (render_* 가 더 적합)**:
- 데이터 차트 → render_chart (인터랙티브·정확)
- 표 → render_table
- 수치 카드 → render_metric

---

**프롬프트 작성 원칙** (이미지 품질이 여기서 갈림):

1. **영어로 상세 묘사** (OpenAI gpt-image / Google Gemini 모두 영문 품질 최대).
2. **스타일 명시 필수** — 무턱대고 'photorealistic' 쓰지 말고 용도별 구분:
   - 보도·리포트 헤더: \`editorial photography, cinematic lighting, shallow depth of field\`
   - 블로그·SNS 콘텐츠: \`clean modern composition, vibrant but not gaudy\`
   - 인포그래픽·다이어그램: \`flat design, geometric shapes, limited palette, vector style\`
   - 제품 사진: \`studio photography, soft lighting, white background, commercial quality\`
   - 로고·아이콘: \`minimalist logo, iconographic, isolated subject, simple shapes\`
   - 만화·일러스트: \`hand-drawn illustration, warm colors, painterly\` (photoreal 금지)
3. **구도·비율 힌트** (중요 — Gemini 는 size 파라미터 없어서 프롬프트 힌트로만 제어 가능):
   - \`16:9 landscape composition\`, \`portrait 9:16\`, \`square composition\`, \`centered\`, \`rule of thirds\`, \`symmetric\` 등.
4. **색감 제어**: \`dark navy + gold accent\`, \`pastel palette\`, \`monochrome\` 식으로 명시.
5. **텍스트 삽입 시 따옴표**: 예 \`title text: "Samsung 2026"\`. 다국어 텍스트 렌더링은 gpt-image-2 가 최고 (99% 정확), Gemini 는 중상, gpt-image-1 은 보통.
6. **금지어 활용**: \`no logos, no text, no watermark\` 같이 원하지 않는 요소 차단.

---

**size / quality 파라미터** (모델에 따라 지원 다름):

**OpenAI (gpt-image-1 / gpt-image-2)** — 명시적 파라미터 있음:
- size: \`1024x1024\` (정사각) / \`1536x1024\` (3:2 가로) / \`1024x1536\` (2:3 세로) / \`auto\`
- quality: \`low\` (\$0.011/장) / \`medium\` (\$0.042) / \`high\` (\$0.17) / \`standard\`
- 블로그 헤더: 1536x1024 + high · 본문 삽화: 1024x1024 + medium · 썸네일: 1024x1024 + medium

**Google Gemini (2.5/3.1 Flash Image)** — 파라미터 없음:
- size/quality 값 넘겨도 무시됨. 모델이 프롬프트 기반 자동 판단.
- 비율 제어는 **프롬프트에 'aspect ratio: 16:9' 같은 힌트** 로만 가능.
- 고정 품질 단일 티어, \$0.039/장.

**요약**: size/quality 는 OpenAI 선택 시만 유효. 모델이 뭐든 프롬프트에 비율·구도 힌트 병기하면 안전. 사용자가 구체적 스타일·구도 지정하면 그대로 존중 (창의성 해치지 말 것).`;
