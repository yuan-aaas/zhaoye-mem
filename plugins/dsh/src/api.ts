export const assistantPreset = 'zhaoye-assistant';
export const standardPreset = 'standard';

export interface SessionEvent {
  seq: number;
  type: string;
  data: {
    turn?: number;
    source?: { kind?: string; rpcId?: string };
    reason?: { kind: string; reason?: { kind: string }; error?: { code?: string } };
  };
}

export interface DshSessionHeader {
  cwd?: string;
  agentPreset?: string;
  origin?: string;
}

export interface DshSession {
  id: string;
  header: DshSessionHeader;
  snapshotEvents(): readonly SessionEvent[];
}

export interface DshAgent {
  ctx: object;
  session: DshSession;
  status: string;
  inbox: {
    nextTurn: readonly InboxItem[];
    nextStep: readonly InboxItem[];
  };
}

export interface InboxItem {
  id: string;
  source: { kind?: string; rpcId?: string };
}

export interface DshApproval {
  request(input: {
    agent: DshAgent;
    toolName: string;
    callId: string;
    reason: string;
    signal: AbortSignal;
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}

export interface DshSessionController {
  create(
    request: {
      sessionId: string;
      agentPreset: string;
    } & ({ cwd: string } | { workspaceId: string }),
  ): Promise<{ sessionId: string }>;
  prompt(
    request: {
      requestId: string;
      sessionId: string;
      mode: 'queue';
      content: [{ type: 'text'; text: string }];
    },
    signal: AbortSignal,
  ): Promise<{ accepted: boolean }>;
  cancel(request: { sessionId: string }): { accepted: boolean };
  updateQueue(request: {
    sessionId: string;
    itemId: string;
    action: { kind: 'remove' };
  }): Promise<{ accepted: boolean }>;
  events(
    request: {
      address: { kind: 'session'; sessionId: string };
      beforeSeq?: number;
      maxMessages: number;
    },
    signal: AbortSignal,
  ): Promise<{ records: Array<{ event: SessionEvent }>; hasMore: boolean }>;
  follow(
    request: {
      address: { kind: 'session'; sessionId: string };
      maxMessages: number;
      activate: false;
    },
    signal: AbortSignal,
  ): AsyncIterable<{ type: 'snapshot'; header: DshSessionHeader } | { type: 'event' }>;
}

export interface DshWorkspaces {
  resolveByPath(path: string): Promise<{ id: string } | undefined>;
}

export interface ToolExecution {
  agent?: DshAgent;
  callId: string;
  signal: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object;
  output: {
    schema: object;
    render(args: unknown, result: object): Array<{ type: 'text'; text: string }>;
  };
  execute(args: unknown, execution: ToolExecution): Promise<object>;
}
