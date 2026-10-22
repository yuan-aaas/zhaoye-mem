import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { codePoints } from './prompt.js';

export type EvidenceRef = {
  path: string;
  start_line: number;
  end_line: number;
  sha256: string;
  quote?: string;
};

export type WorkerReceipt = {
  summary: string;
  evidence_refs: EvidenceRef[];
  artifact_refs: string[];
  pending_questions: string[];
  /** True when the Worker answered in prose and this receipt is a fallback summary. */
  degraded?: boolean;
};

function fail(message: string): never {
  throw new Error(`回执无效：${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next shape
    }
  }
  fail('没有找到 JSON 对象');
}

function safeRelative(cwd: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) fail(`证据路径必须是相对路径：${relative}`);
  const parts = relative.split(/[\\/]+/);
  if (parts.some((part) => part === '..' || part === '' || part === '.')) fail(`证据路径不能包含 .. 或空段：${relative}`);
  const absolute = path.resolve(cwd, relative);
  const base = path.resolve(cwd);
  if (absolute !== base && !absolute.startsWith(`${base}${path.sep}`)) fail(`证据路径越出工作目录：${relative}`);
  return absolute;
}

export async function parseWorkerReceipt(text: string, cwd: string): Promise<WorkerReceipt> {
  const raw = extractJson(text);
  if (!isRecord(raw)) fail('顶层必须是对象');
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) fail('summary 不能为空');
  if (codePoints(summary) > 600) fail('summary 超过 600 个 Unicode 码点');
  const pending = Array.isArray(raw.pending_questions)
    ? raw.pending_questions.filter((item): item is string => typeof item === 'string' && item.trim() !== '').slice(0, 5)
    : [];
  if (Array.isArray(raw.pending_questions) && raw.pending_questions.length > 5) fail('pending_questions 最多 5 条');
  const rawRefs = Array.isArray(raw.evidence_refs) ? raw.evidence_refs : [];
  if (rawRefs.length > 5) fail('evidence_refs 最多 5 条');
  const base = await realpath(cwd).catch(() => path.resolve(cwd));
  const rawArtifacts = Array.isArray(raw.artifact_refs) ? raw.artifact_refs : [];
  if (rawArtifacts.length > 10) fail('artifact_refs 最多 10 条');
  const artifacts: string[] = [];
  for (const item of rawArtifacts) {
    if (typeof item !== 'string' || item.trim() === '') fail('artifact_refs 必须是相对路径字符串');
    const relative = item.trim();
    safeRelative(base, relative);
    artifacts.push(relative);
  }
  const refs: EvidenceRef[] = [];
  for (const [index, item] of rawRefs.entries()) {
    if (!isRecord(item)) fail(`第 ${index + 1} 条证据不是对象`);
    const relative = typeof item.path === 'string' ? item.path.trim() : '';
    const start = Number(item.start_line);
    const end = Number(item.end_line);
    const quote = typeof item.quote === 'string' ? item.quote.trim() : undefined;
    if (!relative) fail(`第 ${index + 1} 条证据缺少 path`);
    if (!Number.isInteger(start) || start < 1) fail(`第 ${index + 1} 条证据 start_line 无效`);
    if (!Number.isInteger(end) || end < start) fail(`第 ${index + 1} 条证据 end_line 无效`);
    const absolute = safeRelative(base, relative);
    const actual = await realpath(absolute).catch(() => null);
    if (!actual || !actual.startsWith(`${base}${path.sep}`)) fail(`第 ${index + 1} 条证据文件不存在或越界：${relative}`);
    const body = await readFile(actual, 'utf8');
    const lines = body.split(/\r?\n/);
    if (end > lines.length) fail(`第 ${index + 1} 条证据行号 ${end} 超过文件行数 ${lines.length}`);
    if (quote && !lines.slice(start - 1, end).join('\n').includes(quote)) fail(`第 ${index + 1} 条证据 quote 与引用的行范围不匹配`);
    refs.push({ path: relative, start_line: start, end_line: end, sha256: createHash('sha256').update(body).digest('hex'), ...(quote ? { quote } : {}) });
  }
  return { summary, evidence_refs: refs, artifact_refs: artifacts, pending_questions: pending };
}
