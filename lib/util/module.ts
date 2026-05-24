/**
 * Module entry / sysmod utility — Phase 9 정공 (2026-05-13).
 *
 * 옛 Sidebar.tsx 안에 있던 module entry 자동 탐색 로직 통합.
 * 같은 패턴이 Rust ModuleService.Run, AI runModule 도구, sysmod loader 등 여러 곳에서 필요.
 *
 * 사용:
 *   import { ENTRY_FILES, findModuleEntry } from '@/lib/util/module';
 *
 *   const entry = findModuleEntry(['main.py', 'index.js']);
 *   if (entry) await runModule(`${path}/${entry}`);
 */

/**
 * Module entry file 후보 — 우선순위 순.
 * Rust sandbox.rs 의 entry 탐색 로직 (`infra/src/adapters/sandbox.rs`) 과 일관.
 * Python 우선 (sysmod 다수), Node 다음, PHP / shell fallback.
 */
export const ENTRY_FILES = [
  'main.py',
  'index.js',
  'index.mjs',
  'main.mjs',
  'main.php',
  'main.sh',
] as const;

/**
 * 파일 목록에서 entry 파일 자동 탐색. 우선순위 = ENTRY_FILES 순서.
 *
 * @param files 디렉토리 안 파일명 list
 * @returns entry 파일명 또는 null (cf. fallback 은 호출자가 결정)
 */
export function findModuleEntry(files: readonly string[]): string | null {
  const set = new Set(files);
  for (const candidate of ENTRY_FILES) {
    if (set.has(candidate)) return candidate;
  }
  return null;
}

/**
 * entry + fallback chain — Sidebar 등의 옛 패턴 보존.
 * 1) ENTRY_FILES 매칭 / 2) config.json 외 첫 파일 / 3) config.json.
 */
export function findModuleEntryWithFallback(files: readonly string[]): string {
  const entry = findModuleEntry(files);
  if (entry) return entry;
  return files.find(f => f !== 'config.json') ?? 'config.json';
}
