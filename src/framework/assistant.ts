import { z } from 'zod';
import { AssistantError } from '../contracts/errors.js';
import { IdSchema } from '../contracts/schemas.js';
import { AdapterContextSchema, IdentityUpdateRequestSchema, type AdapterContext, type IdentityUpdateRequest, type IdentityPreview, type IdentitySnapshot, type IdentityUpdateReceipt } from '../contracts/identity.js';
import { openRuntime, type Runtime } from '../infrastructure/runtime.js';
import { canonicalize, sha256 } from '../infrastructure/stable-json.js';
import { currentIdentity, previewIdentityPatch, applyIdentityProposal } from '../memory-core/identity.js';
import { MemoryCore, type MemoryInput, type ExplicitContext } from '../memory-core/memory.js';

const queues = new WeakMap<Runtime, Promise<void>>();
const ProjectSchema = IdSchema.nullable();
export type MemoryWriteOptions = { operation_id?: string; project_id?: string | null };

/** Host-independent data service. Adapters own interaction, confirmation and Agent execution. */
export class AssistantFramework {
  private readonly memory: MemoryCore;
  private closed = false;

  constructor(private readonly runtime: Runtime, private readonly ownsRuntime = false) {
    this.memory = new MemoryCore(runtime);
  }

  private run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new AssistantError('MAINTENANCE_REQUIRED', '助手框架已关闭。'));
    const result = (queues.get(this.runtime) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      if (error instanceof z.ZodError) throw new AssistantError('INVALID_INPUT', '接口参数或画像数据不符合约定格式。');
      throw error;
    });
    queues.set(this.runtime, result.then(() => undefined, () => undefined));
    return result;
  }

  readIdentity(): Promise<IdentitySnapshot> { return this.run(() => currentIdentity(this.runtime)); }

  private preview(request: IdentityUpdateRequest, source: AdapterContext): Promise<IdentityPreview> {
    const proposalId = sha256(canonicalize({ adapter_id: source.adapter_id, operation_id: request.operation_id }));
    return previewIdentityPatch(this.runtime, request.patch, { proposal_id: proposalId, expected_revision: request.expected_revision, source });
  }

  previewIdentityUpdate(raw: IdentityUpdateRequest, context: AdapterContext): Promise<IdentityPreview> {
    return this.run(() => this.preview(IdentityUpdateRequestSchema.parse(raw), AdapterContextSchema.parse(context)));
  }

  /** Invoke for an explicit user update request; the framework does not prompt again. */
  updateIdentity(raw: IdentityUpdateRequest, context: AdapterContext): Promise<IdentityUpdateReceipt> {
    return this.run(async () => {
      const request = IdentityUpdateRequestSchema.parse(raw);
      const proposal = await this.preview(request, AdapterContextSchema.parse(context));
      const receipt = await applyIdentityProposal(this.runtime, proposal.proposal_id, request.expected_revision);
      return { proposal_id: proposal.proposal_id, ...receipt };
    });
  }

  /** Commit a previously previewed operation, for adapters with a separate confirmation interaction. */
  commitIdentityUpdate(proposalId: string, expectedRevision: number, context: AdapterContext): Promise<IdentityUpdateReceipt> {
    return this.run(async () => {
      const source = AdapterContextSchema.parse(context);
      IdSchema.parse(proposalId);
      z.number().int().positive().parse(expectedRevision);
      const event = this.runtime.events.findOp(`identity-proposal:${proposalId}`);
      if (!event) throw new AssistantError('NOT_FOUND');
      const proposal = event.payload as { source?: AdapterContext };
      if (proposal.source?.adapter_id !== source.adapter_id) throw new AssistantError('UNAUTHORIZED', '画像提案不属于当前适配器。');
      return { proposal_id: proposalId, ...await applyIdentityProposal(this.runtime, proposalId, expectedRevision) };
    });
  }

  locateMemory(query: string, projectId: string | null = null) {
    return this.run(() => this.memory.locate(z.string().max(300).parse(query), { scopeId: this.runtime.assistantId, projectId: ProjectSchema.parse(projectId) }, projectId ?? undefined));
  }

  /** Newest-first explicit memories, for adapter-rendered index summaries. */
  listMemories(limit = 20, projectId: string | null = null) {
    return this.run(() => this.memory.list(z.number().int().min(1).max(100).parse(limit), { scopeId: this.runtime.assistantId, projectId: ProjectSchema.parse(projectId) }));
  }

  recallMemory(recordId: string, projectId: string | null = null, query = '') {
    return this.run(() => this.memory.recall(IdSchema.parse(recordId), z.string().max(300).parse(query), { scopeId: this.runtime.assistantId, projectId: ProjectSchema.parse(projectId) }));
  }

  private explicitContext(context: AdapterContext, projectId: string | null): ExplicitContext {
    const source = AdapterContextSchema.parse(context);
    return { actor: 'user', requestId: source.request_id, scopeId: this.runtime.assistantId, projectId: ProjectSchema.parse(projectId), explicitSave: true };
  }

  rememberMemory(input: MemoryInput, context: AdapterContext, options: MemoryWriteOptions = {}) {
    return this.run(() => this.memory.remember(input, this.explicitContext(context, options.project_id ?? null), options.operation_id));
  }

  replaceMemory(recordId: string, expectedRevision: number, input: MemoryInput, context: AdapterContext, options: MemoryWriteOptions = {}) {
    return this.run(() => this.memory.replace(IdSchema.parse(recordId), z.number().int().positive().parse(expectedRevision), input, this.explicitContext(context, options.project_id ?? null), options.operation_id));
  }

  archiveMemory(recordId: string, expectedRevision: number, context: AdapterContext, options: MemoryWriteOptions = {}) {
    return this.run(() => this.memory.archive(IdSchema.parse(recordId), z.number().int().positive().parse(expectedRevision), this.explicitContext(context, options.project_id ?? null), options.operation_id));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await queues.get(this.runtime);
    if (this.ownsRuntime) await this.runtime.close();
  }
}

/** Open once per data root and share the service with adapters on the same host. */
export async function openAssistantFramework(root: string): Promise<AssistantFramework> {
  return new AssistantFramework(await openRuntime(root), true);
}

export type AssistantApi = Pick<AssistantFramework,
  'readIdentity' | 'previewIdentityUpdate' | 'updateIdentity' | 'commitIdentityUpdate' |
  'locateMemory' | 'listMemories' | 'recallMemory' | 'rememberMemory' | 'replaceMemory' | 'archiveMemory' | 'close'>;
