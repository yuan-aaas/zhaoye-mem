import {
  type BackupObservation,
  BackupObservationSchema,
  type MnemePolicy,
} from '@zhaoye/contracts';

const kinds = new Set([
  'preference',
  'project',
  'decision',
  'history',
  'summary',
  'pattern',
  'rejected_solution',
  'pitfall',
  'constraint',
  'document',
]);

export const MNEME_REQUIRED_COLUMNS = ['id', 'type', 'title', 'content'] as const;

export function requiredMnemeColumns(policy: MnemePolicy): string[] {
  const columns = [...MNEME_REQUIRED_COLUMNS, 'archived', 'forgotten'];
  if (
    policy.agents !== '*' ||
    !policy.includeUnassigned ||
    policy.projects.some((project) => project.agent !== null)
  )
    columns.push('agent_scope');
  if (
    policy.workspaces !== '*' ||
    !policy.includeUnassigned ||
    policy.projects.some((project) => project.workspace !== null)
  )
    columns.push('workspace_scope');
  if (policy.sensitivities !== '*' || !policy.includeUnknownSensitivity)
    columns.push('sensitivity');
  return columns;
}

export const MNEME_METADATA_COLUMNS = [
  'source',
  'tags',
  'importance',
  'created_at',
  'updated_at',
  'occurred_at',
  'archived',
  'forgotten',
  'archived_at',
  'content_hash',
  'agent_scope',
  'workspace_scope',
  'agent_scope_source',
  'workspace_scope_source',
  'scope_decided_at',
  'sensitivity',
  'doc_path',
  'epistemic_status',
  'last_accessed_at',
  'quality_score',
] as const;
export const MNEME_CONVERTER_VERSION = '1';

const validChoice = (value: unknown, allowed: string[] | '*', includeEmpty: boolean) => {
  if (value === null || value === '') return includeEmpty;
  return typeof value === 'string' && (allowed === '*' || allowed.includes(value));
};

export function convertMnemeRow(
  row: Record<string, unknown>,
  policy: MnemePolicy,
): BackupObservation | 'excluded' | 'invalid' {
  const {
    id,
    type,
    title,
    content,
    agent_scope: agent,
    workspace_scope: workspace,
    sensitivity,
  } = row;
  if ([agent, workspace, sensitivity].some((value) => value != null && typeof value !== 'string'))
    return 'invalid';
  if (
    !validChoice(agent ?? null, policy.agents, policy.includeUnassigned) ||
    !validChoice(workspace ?? null, policy.workspaces, policy.includeUnassigned) ||
    !validChoice(sensitivity ?? null, policy.sensitivities, policy.includeUnknownSensitivity)
  )
    return 'excluded';
  if (
    typeof id !== 'string' ||
    typeof type !== 'string' ||
    !type.trim() ||
    typeof title !== 'string' ||
    typeof content !== 'string' ||
    ![0, 1].includes(Number(row.archived)) ||
    ![0, 1].includes(Number(row.forgotten)) ||
    row.archived == null ||
    row.forgotten == null
  )
    return 'invalid';

  const mapped = policy.projects.find(
    (entry) => entry.agent === (agent || null) && entry.workspace === (workspace || null),
  );
  const archived = Number(row.archived) === 1;
  const forgotten = Number(row.forgotten) === 1;
  const updated = typeof row.updated_at === 'string' ? Date.parse(row.updated_at) : Number.NaN;
  const metadata: BackupObservation['metadata'] = { native_kind: type };
  for (const key of MNEME_METADATA_COLUMNS) {
    const value = row[key];
    if (
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      value === null
    )
      metadata[key] = value;
  }
  const parsed = BackupObservationSchema.safeParse({
    nativeId: id,
    content: {
      kind: kinds.has(type) ? type : 'other',
      title,
      body: content.replace(/\r\n?/g, '\n'),
    },
    projectId: mapped?.projectId ?? null,
    searchAllowed: Boolean(mapped) || (!agent && !workspace && policy.includeUnassigned),
    visibility: archived || forgotten ? 'unavailable' : 'visible',
    reason:
      archived && forgotten
        ? 'archived_forgotten'
        : archived
          ? 'archived'
          : forgotten
            ? 'forgotten'
            : null,
    sourceUpdatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null,
    rawRef: id,
    metadata,
  });
  return parsed.success ? parsed.data : 'invalid';
}
