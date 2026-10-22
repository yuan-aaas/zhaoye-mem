import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkerReceipt } from './receipt.js';

export type TaskStatus = 'created' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';

export type TaskRecord = {
  task_id: string;
  attempt_id: string;
  parent_session_id: string | null;
  child_session_id: string | null;
  objective: string;
  acceptance: string;
  necessary_context: string;
  project_id: string | null;
  cwd: string;
  status: TaskStatus;
  receipt: WorkerReceipt | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
};

const MAX_TASKS = 200;

export class TaskStore {
  private tasks: TaskRecord[] | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'tasks.json');
  }

  private async ensureLoaded(): Promise<TaskRecord[]> {
    if (this.tasks !== null) return this.tasks;
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as unknown;
      this.tasks = Array.isArray(raw) ? raw.filter((item): item is TaskRecord => Boolean(item) && typeof item === 'object' && typeof (item as TaskRecord).task_id === 'string') : [];
    } catch {
      this.tasks = [];
    }
    let changed = false;
    for (const task of this.tasks) {
      if (task.status === 'running') {
        task.status = 'unknown';
        task.error_code = 'RESTARTED';
        task.updated_at = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) await this.persist();
    return this.tasks;
  }

  private async persist(): Promise<void> {
    const tasks = this.tasks ?? [];
    if (tasks.length > MAX_TASKS) {
      const terminal = tasks.filter((task) => !['created', 'running'].includes(task.status));
      const excess = tasks.length - MAX_TASKS;
      const drop = new Set(terminal.slice(0, excess).map((task) => task.task_id));
      this.tasks = tasks.filter((task) => !drop.has(task.task_id));
    }
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp-${randomUUID()}`;
    try {
      await writeFile(temp, `${JSON.stringify(this.tasks ?? [], null, 2)}\n`, 'utf8');
      await rename(temp, this.file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work, work);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async create(input: Omit<TaskRecord, 'task_id' | 'attempt_id' | 'status' | 'receipt' | 'error_code' | 'created_at' | 'updated_at'>): Promise<TaskRecord> {
    return this.serialize(async () => {
      const tasks = await this.ensureLoaded();
      const now = new Date().toISOString();
      const task: TaskRecord = {
        ...input,
        task_id: randomUUID(),
        attempt_id: randomUUID(),
        status: 'created',
        receipt: null,
        error_code: null,
        created_at: now,
        updated_at: now,
      };
      tasks.push(task);
      await this.persist();
      return task;
    });
  }

  async update(taskId: string, patch: Partial<TaskRecord>): Promise<TaskRecord> {
    return this.serialize(async () => {
      const tasks = await this.ensureLoaded();
      const task = tasks.find((item) => item.task_id === taskId);
      if (!task) throw new Error(`任务不存在：${taskId}`);
      Object.assign(task, patch, { updated_at: new Date().toISOString() });
      await this.persist();
      return task;
    });
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    return (await this.ensureLoaded()).find((item) => item.task_id === taskId) ?? null;
  }

  async list(limit = 20): Promise<TaskRecord[]> {
    const tasks = await this.ensureLoaded();
    return [...tasks].sort((left, right) => right.updated_at.localeCompare(left.updated_at)).slice(0, limit);
  }

  async close(): Promise<void> {
    await this.queue;
  }
}
