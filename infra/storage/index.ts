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
    return this.isInsideZone(targetPath, ['app/(user)', 'user']);
  }

  private canRead(targetPath: string): boolean {
    return this.isInsideZone(targetPath, ['app/(user)', 'user', 'docs', 'system/guidelines', 'system/modules', 'system/services']);
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
}
