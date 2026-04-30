import type { IStoragePort } from '../ports';
import type { InfraResult } from '../types';

interface TreeNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

/**
 * Storage Manager — 파일 시스템 CRUD + 트리 조회
 *
 * 인프라: IStoragePort
 * SSE 발행: 하지 않음 (Core 파사드에서 처리)
 */
export class StorageManager {
  constructor(private readonly storage: IStoragePort) {}

  async read(path: string): Promise<InfraResult<string>> {
    return this.storage.read(path);
  }

  async readBinary(path: string): Promise<InfraResult<{ base64: string; mimeType: string; size: number }>> {
    return this.storage.readBinary(path);
  }

  async write(path: string, content: string): Promise<InfraResult<void>> {
    return this.storage.write(path, content);
  }

  async delete(path: string): Promise<InfraResult<void>> {
    return this.storage.delete(path);
  }

  async list(path: string): Promise<InfraResult<string[]>> {
    return this.storage.list(path);
  }

  async listDir(path: string): Promise<InfraResult<Array<{ name: string; isDirectory: boolean }>>> {
    return this.storage.listDir(path);
  }

  async glob(pattern: string, opts?: { limit?: number }): Promise<InfraResult<string[]>> {
    return this.storage.glob(pattern, opts);
  }

  /** Internal cache write — Core.cacheData 만 호출. AI 도구 우회 차단. */
  async writeCache(path: string, content: string): Promise<InfraResult<void>> {
    return this.storage.writeCache(path, content);
  }

  /** Internal cache delete — Core.cacheDrop 만 호출. */
  async deleteCache(path: string): Promise<InfraResult<void>> {
    return this.storage.deleteCache(path);
  }

  async grep(
    pattern: string,
    opts?: { path?: string; fileType?: string; limit?: number; ignoreCase?: boolean },
  ): Promise<InfraResult<Array<{ file: string; line: number; text: string }>>> {
    return this.storage.grep(pattern, opts);
  }

  async getFileTree(root: string): Promise<TreeNode[]> {
    const build = async (dir: string): Promise<TreeNode[]> => {
      const result = await this.storage.listDir(dir);
      if (!result.success || !result.data) return [];

      const nodes: TreeNode[] = [];
      for (const entry of result.data) {
        if (entry.name.startsWith('.')) continue;
        if (entry.name.startsWith('[') && entry.name.endsWith(']')) continue;
        const relPath = `${dir}/${entry.name}`;
        nodes.push({
          name: entry.name,
          path: relPath,
          isDirectory: entry.isDirectory,
          children: entry.isDirectory ? await build(relPath) : [],
        });
      }
      nodes.sort((a, b) => {
        if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
        return a.isDirectory ? -1 : 1;
      });
      return nodes;
    };

    const tree: TreeNode[] = [];
    for (const r of (Array.isArray(root) ? root : [root])) {
      const children = await build(r);
      tree.push({ name: r, path: r, isDirectory: true, children });
    }
    return tree;
  }
}
