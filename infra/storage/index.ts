import { IStoragePort } from '../../core/ports';
import { InfraResult } from '../../core/types';
import fs from 'fs/promises';
import path from 'path';

export class LocalStorageAdapter implements IStoragePort {
  private baseDir: string;

  constructor() {
    this.baseDir = process.cwd(); // 프로젝트 루트
  }

  /**
   * 커널 레벨 보안 방패 (Zero Trust Whitelist)
   * path.resolve 후 절대 경로가 허용 디렉토리 안인지 확인 (../ traversal 방어)
   */
  private isInsideZone(targetPath: string, zones: string[]): boolean {
    const resolved = path.resolve(this.baseDir, targetPath);
    for (const zone of zones) {
      const zoneAbs = path.resolve(this.baseDir, zone);
      if (resolved === zoneAbs || resolved.startsWith(zoneAbs + path.sep)) return true;
    }
    return false;
  }

  private canWrite(targetPath: string): boolean {
    // data/firebat-memory/ — Firebat AI 자율 메모리 (사용자 룰·선호 영속).
    // data/cache/sysmod-results/ — Phase 2 sub-query cache (sysmod 결과 JSONL).
    // 다른 data/ 영역은 read/write port 우회 — 매니저가 직접 접근.
    return this.isInsideZone(targetPath, ['app/(user)', 'user', 'data/firebat-memory', 'data/cache/sysmod-results']);
  }

  private canRead(targetPath: string): boolean {
    return this.isInsideZone(targetPath, ['app/(user)', 'user', 'docs', 'system/guidelines', 'system/modules', 'system/services', 'data/firebat-memory', 'data/cache/sysmod-results']);
  }

  /**
   * glob/grep 검색 노출 zone — read/write 와 분리.
   *
   * 차이: data/cache/sysmod-results 제외.
   * 이유: sysmod 외부 API 응답에 토큰·PII 포함 가능 → 사용자/AI 일반 검색에 노출 차단.
   * cache 는 별도 도구 (cache_read/grep/aggregate) 로만 접근 — 그 도구는 cacheKey 받아서
   * 의도된 호출 흐름만 통과.
   */
  private canSearch(targetPath: string): boolean {
    return this.isInsideZone(targetPath, ['app/(user)', 'user', 'docs', 'system/guidelines', 'system/modules', 'system/services', 'data/firebat-memory']);
  }

  async read(targetPath: string): Promise<InfraResult<string>> {
    try {
      if (!this.canRead(targetPath)) {
        return { success: false, error: `[Kernel Block] Access Denied: Unauthorized read attempt on protected system zone (${targetPath}).` };
      }
      const absolutePath = path.resolve(this.baseDir, targetPath);
      const content = await fs.readFile(absolutePath, 'utf-8');
      return { success: true, data: content };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /** 바이너리 읽기 — base64. 확장자로 MIME 타입 추정 */
  async readBinary(targetPath: string): Promise<InfraResult<{ base64: string; mimeType: string; size: number }>> {
    try {
      if (!this.canRead(targetPath)) {
        return { success: false, error: `[Kernel Block] Access Denied: ${targetPath}` };
      }
      const absolutePath = path.resolve(this.baseDir, targetPath);
      const buf = await fs.readFile(absolutePath);
      const ext = path.extname(targetPath).toLowerCase().slice(1);
      const MIME: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
        gif: 'image/gif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
        pdf: 'application/pdf', zip: 'application/zip',
      };
      return { success: true, data: { base64: buf.toString('base64'), mimeType: MIME[ext] ?? 'application/octet-stream', size: buf.length } };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async write(targetPath: string, content: string): Promise<InfraResult<void>> {
    try {
      if (!this.canWrite(targetPath)) {
        return { success: false, error: `[Kernel Block] Zero Trust Policy Violation: Attempted to write outside app/user/ or user/ (${targetPath})` };
      }
      const absolutePath = path.resolve(this.baseDir, targetPath);
      
      // 부모 디렉토리가 없다면 자동 생성
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, 'utf-8');
      
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async delete(targetPath: string): Promise<InfraResult<void>> {
    try {
      if (!this.canWrite(targetPath)) {
        return { success: false, error: `[Kernel Block] Zero Trust Policy Violation: Attempted to delete outside app/user/ or user/ (${targetPath})` };
      }
      const absolutePath = path.resolve(this.baseDir, targetPath);
      await fs.rm(absolutePath, { recursive: true, force: true });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async list(targetPath: string): Promise<InfraResult<string[]>> {
    try {
      if (!this.canRead(targetPath)) {
        return { success: false, error: `[Kernel Block] Zero Trust Policy Violation: Cannot list directory outside allowed zones (${targetPath})` };
      }
      const absolutePath = path.resolve(this.baseDir, targetPath);
      const items = await fs.readdir(absolutePath);
      return { success: true, data: items };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async listDir(targetPath: string): Promise<InfraResult<Array<{ name: string; isDirectory: boolean }>>> {
    try {
      if (!this.canRead(targetPath)) {
        return { success: false, error: `[Kernel Block] Zero Trust Policy Violation: Cannot list directory outside allowed zones (${targetPath})` };
      }
      const absolutePath = path.resolve(this.baseDir, targetPath);
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      return {
        success: true,
        data: entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() })),
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Glob 패턴 매칭 — Node 22+ 의 fs/promises.glob (내장) 활용.
   * 매칭된 파일 중 canSearch zone 통과한 것만 반환 (cache 디렉토리 제외 — 토큰·PII 노출 차단).
   * 결과: baseDir 상대 경로 (forward-slash, OS 무관 표시).
   *
   * 패턴 sanitize: 절대 경로 / .. traversal 거부 (안전망 — fs.glob 자체 cwd 안만 매칭).
   */
  async glob(pattern: string, opts?: { limit?: number }): Promise<InfraResult<string[]>> {
    if (!pattern || pattern.includes('..') || pattern.startsWith('/') || /^[a-zA-Z]:\\/.test(pattern)) {
      return { success: false, error: 'glob 패턴 거부: 절대 경로 / .. traversal 금지' };
    }
    try {
      const limit = opts?.limit ?? 500;
      const results: string[] = [];
      // Node 24 의 fs/promises.glob — AsyncIterable<string> 반환
      const iter = (fs as unknown as { glob: (p: string, opts?: { cwd?: string }) => AsyncIterable<string> })
        .glob(pattern, { cwd: this.baseDir });
      for await (const file of iter) {
        // 절대 경로화 후 검색 zone 검증 (cache 디렉토리 제외)
        const rel = file.replace(/\\/g, '/');
        if (!this.canSearch(rel)) continue;
        results.push(rel);
        if (results.length >= limit) break;
      }
      return { success: true, data: results };
    } catch (err: any) {
      return { success: false, error: `glob 실패: ${err.message}` };
    }
  }

  /**
   * 파일 내용 grep — 정규식 매칭 line 추출.
   *
   * 흐름:
   *   1. opts.path 또는 fileType 으로 파일 후보 결정 (glob 활용)
   *   2. 각 파일 read + 정규식 매칭
   *   3. 결과 line 목록 (file/line/text)
   *
   * 안전성: 모든 파일은 canRead zone 통과 필요. 큰 파일 (>1MB) 스킵.
   */
  async grep(
    pattern: string,
    opts?: { path?: string; fileType?: string; limit?: number; ignoreCase?: boolean },
  ): Promise<InfraResult<Array<{ file: string; line: number; text: string }>>> {
    try {
      const limit = opts?.limit ?? 200;
      // 검색 대상 파일 결정
      const ext = opts?.fileType ? (opts.fileType.startsWith('.') ? opts.fileType : `.${opts.fileType}`) : null;
      const baseGlob = opts?.path
        ? (opts.path.endsWith('/') ? opts.path + '**/*' : opts.path)
        : '**/*';
      const finalGlob = ext ? `${baseGlob}${ext}` : baseGlob;
      const filesRes = await this.glob(finalGlob, { limit: 2000 });
      if (!filesRes.success || !filesRes.data) return { success: false, error: filesRes.error || 'glob 실패' };

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, opts?.ignoreCase ? 'i' : '');
      } catch (e: any) {
        return { success: false, error: `정규식 오류: ${e.message}` };
      }

      const matches: Array<{ file: string; line: number; text: string }> = [];
      for (const file of filesRes.data) {
        if (matches.length >= limit) break;
        const absolutePath = path.resolve(this.baseDir, file);
        try {
          const stat = await fs.stat(absolutePath);
          if (stat.size > 1024 * 1024) continue;  // 1MB+ 스킵
          if (!stat.isFile()) continue;
          const content = await fs.readFile(absolutePath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= limit) break;
            if (regex.test(lines[i])) {
              matches.push({ file, line: i + 1, text: lines[i].slice(0, 300) });
            }
          }
        } catch { /* 개별 파일 읽기 실패 무시 */ }
      }

      return { success: true, data: matches };
    } catch (err: any) {
      return { success: false, error: `grep 실패: ${err.message}` };
    }
  }
}
