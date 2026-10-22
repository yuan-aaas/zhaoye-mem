import path from 'node:path';
import { realpath } from 'node:fs/promises';

export type ResolvedProject = { projectId: string | null; cwd: string };

export function projectForCwd(cwd: string | undefined, projectMap: Record<string, string>): string | null {
  if (!cwd) return null;
  const resolved = path.resolve(cwd);
  let best: { id: string; length: number } | null = null;
  for (const [id, root] of Object.entries(projectMap)) {
    const base = path.resolve(root);
    if (resolved === base || resolved.startsWith(`${base}${path.sep}`)) {
      if (!best || base.length > best.length) best = { id, length: base.length };
    }
  }
  return best?.id ?? null;
}

export async function resolveWorkerDirectory(
  requestedProjectId: string | null | undefined,
  projectMap: Record<string, string>,
  sessionCwd: string | undefined,
): Promise<ResolvedProject> {
  if (requestedProjectId) {
    const mapped = projectMap[requestedProjectId];
    if (!mapped) throw new Error(`项目 ${requestedProjectId} 未在插件配置 projectMap 中登记。`);
    return { projectId: requestedProjectId, cwd: await realpath(mapped) };
  }
  if (!sessionCwd) throw new Error('当前会话没有工作目录，无法委托。');
  const cwd = await realpath(sessionCwd);
  return { projectId: projectForCwd(cwd, projectMap), cwd };
}
