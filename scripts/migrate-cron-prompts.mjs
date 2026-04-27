#!/usr/bin/env node
/**
 * cron 잡의 agentPrompt 일괄 마이그레이션 — CMS Phase 1 정착 후.
 *
 * 옛 표현 ("본문 1000자+ HTML — h2 섹션 4개+") 을 새 패턴 ("본문 1000자+ — render_*
 * 컴포넌트 배열 분리 사용") 으로 변환. cron-agent prelude rule 4 (단일 Html 금지) 가
 * 이미 override 하지만 일관성 차원.
 *
 * 사용:
 *   pm2 stop firebat         # 어댑터 file write race 방지
 *   node scripts/migrate-cron-prompts.mjs
 *   pm2 restart firebat
 */
import fs from 'node:fs';
import path from 'node:path';

const FILE = process.env.CRON_FILE || path.resolve('data/cron-jobs.json');
const BACKUP = `${FILE}.bak.${Date.now()}`;

const RULES = [
  // "본문 1000자+ HTML — h2 섹션 4개+" → "본문 1000자+ — render_header(h2 섹션 4개+, level=2) + render_table/render_chart/render_callout/render_text/render_metric 등 분리"
  // "1000자 이상" / "1000자+" 둘 다 매칭
  {
    pattern: /본문 (\d+자(?: 이상)?\+?) HTML — h2 섹션 (\d+개\+?)/g,
    replacement: '본문 $1 — render_header(h2 섹션 $2, level=2) + render_table/render_chart/render_callout/render_text/render_metric 등 분리',
  },
  // 일반 "HTML 작성" / "HTML —" 표현
  {
    pattern: /SEO 최적화된? (한국어 )?본문 (\d+자(?: 이상)?) HTML 작성/g,
    replacement: 'SEO 최적화된 $1본문 $2 — render_* 컴포넌트 배열 (Header/Text/Table/Chart/Callout/Metric 등) 분리 사용',
  },
  {
    pattern: /SEO 최적화 본문 (\d+자\+?) HTML/g,
    replacement: 'SEO 최적화 본문 $1 — render_* 컴포넌트 배열 분리',
  },
  {
    pattern: /SEO 본문 (\d+자\+?) HTML/g,
    replacement: 'SEO 본문 $1 — render_* 컴포넌트 배열 분리',
  },
];

const raw = fs.readFileSync(FILE, 'utf-8');
const data = JSON.parse(raw);
fs.writeFileSync(BACKUP, raw);
console.log(`Backup: ${BACKUP}`);

const jobs = Array.isArray(data) ? data : (data.jobs || []);
let changed = 0;

for (const j of jobs) {
  if (!j.agentPrompt) continue;
  let p = j.agentPrompt;
  let modified = false;
  for (const r of RULES) {
    const before = p;
    p = p.replace(r.pattern, r.replacement);
    if (p !== before) modified = true;
  }
  if (modified) {
    j.agentPrompt = p;
    changed++;
    console.log(`✓ ${j.title}`);
  }
}

if (changed > 0) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  console.log(`\nDone. ${changed} jobs updated.`);
} else {
  console.log('\nNo jobs needed update.');
  fs.unlinkSync(BACKUP);
}
