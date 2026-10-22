import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { JournalEventSchema, type JournalEvent } from '../contracts/schemas.js';
import { AssistantError } from '../contracts/errors.js';
import { canonicalize, sha256 } from './stable-json.js';

export type JournalRecordInput = { op_id: string; kind: string; payload: unknown };

function signedPart(event: Omit<JournalEvent, 'checksum'>): string {
  return canonicalize({ schema_version: event.schema_version, seq: event.seq, event_id: event.event_id, op_id: event.op_id, kind: event.kind, payload: event.payload });
}

export class Journal {
  private events: JournalEvent[] = [];
  private byOperation = new Map<string, JournalEvent>();
  private poisoned = false;

  constructor(readonly file: string, readonly maxEvents: number, readonly maxBytes: number) {}

  async replay(): Promise<JournalEvent[]> {
    this.events = []; this.byOperation.clear(); this.poisoned = false;
    const content = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    if (content && !content.endsWith('\n')) throw new AssistantError('CORRUPT_DATA', `日志尾部不完整：${path.basename(this.file)}；需备份后维护。`);
    let expectedSeq = 1;
    const lines = content ? content.slice(0, -1).split('\n') : [];
    if (lines.some((line) => line.length === 0)) throw new AssistantError('CORRUPT_DATA', `日志包含空行：${path.basename(this.file)}。`);
    for (const line of lines) {
      let raw: unknown;
      try { raw = JSON.parse(line); } catch { throw new AssistantError('CORRUPT_DATA', `日志包含无效 JSON：${path.basename(this.file)}。`); }
      const parsed = JournalEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.seq !== expectedSeq) throw new AssistantError('CORRUPT_DATA', `日志 schema 或 seq 校验失败：${path.basename(this.file)}。`);
      const { checksum, ...unsigned } = parsed.data;
      if (sha256(signedPart(unsigned)) !== checksum) throw new AssistantError('CORRUPT_DATA', `日志 checksum 校验失败：${path.basename(this.file)}。`);
      const previous = this.byOperation.get(parsed.data.op_id);
      if (previous && (previous.kind !== parsed.data.kind || canonicalize(previous.payload) !== canonicalize(parsed.data.payload))) throw new AssistantError('CORRUPT_DATA', '同一 op_id 在日志中对应不同内容。');
      this.events.push(parsed.data); this.byOperation.set(parsed.data.op_id, parsed.data); expectedSeq += 1;
    }
    return [...this.events];
  }

  all(): JournalEvent[] { return [...this.events]; }
  findOp(opId: string): JournalEvent | undefined { return this.byOperation.get(opId); }

  async append(input: JournalRecordInput): Promise<{ event: JournalEvent; replayed: boolean }> {
    if (this.poisoned) throw new AssistantError('COMMIT_UNKNOWN', undefined, 'after_reconcile');
    const existing = this.byOperation.get(input.op_id);
    if (existing) {
      if (existing.kind !== input.kind || canonicalize(existing.payload) !== canonicalize(input.payload)) throw new AssistantError('CONFLICT', '同一 op_id 不可复用为不同操作。');
      return { event: existing, replayed: true };
    }
    if (this.events.length >= this.maxEvents) throw new AssistantError('BUDGET_EXCEEDED', '日志已达到事件数维护上限。');
    const currentSize = await stat(this.file).then((s) => s.size).catch(() => 0);
    const seq = this.events.length + 1;
    const unsigned = { schema_version: 2 as const, seq, event_id: randomUUID(), op_id: input.op_id, kind: input.kind, payload: input.payload };
    const event: JournalEvent = { ...unsigned, checksum: sha256(signedPart(unsigned)) };
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line) > 64 * 1024 || currentSize + Buffer.byteLength(line) > this.maxBytes) throw new AssistantError('BUDGET_EXCEEDED', '日志已达到单事件或字节容量上限。');
    let handle;
    let writeStarted = false;
    try {
      handle = await open(this.file, 'a', 0o600);
      writeStarted = true;
      await handle.write(line, null, 'utf8');
      await handle.sync();
      await handle.close(); handle = undefined;
    } catch {
      await handle?.close().catch(() => undefined);
      if (!writeStarted) throw new AssistantError('MAINTENANCE_REQUIRED', '日志无法打开写入；提交未开始。');
      this.poisoned = true;
      throw new AssistantError('COMMIT_UNKNOWN', undefined, 'after_reconcile');
    }
    this.events.push(event); this.byOperation.set(event.op_id, event);
    return { event, replayed: false };
  }
}
