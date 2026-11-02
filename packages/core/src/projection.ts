import type { IdentityDocument } from '@zhaoye/contracts';
export function renderIdentityMarkdown(d: IdentityDocument): string {
  const lines = [
    `<!-- generated from identity.json rev ${d.revision}; do not edit -->`,
    '# 照夜人格记忆',
    '',
    `## 安全内核（rev ${d.safety_kernel.revision}）`,
    ...d.safety_kernel.principles.map((p, i) => `${i + 1}. ${p}`),
    '',
    `## 用户画像（rev ${d.user_profile.revision}）`,
    `称呼：${d.user_profile.display_name ?? '（空）'}`,
  ];
  function entries(items: Array<{ id: string; text: string; confidence: number; source: string }>) {
    return items.length
      ? items.map((e) => `- [${e.id}] ${e.text}（${e.confidence.toFixed(1)}；${e.source}）`)
      : ['（空）'];
  }
  lines.push(
    '### 事实',
    ...entries(d.user_profile.facts),
    '### 偏好',
    ...entries(d.user_profile.preferences),
    '',
    `## 性格画像（rev ${d.character_profile.revision}）`,
    ...entries(d.character_profile.traits),
    '',
    `## 项目状态（rev ${d.project_state.revision}）`,
  );
  if (!d.project_state.projects.length) lines.push('（空）');
  for (const p of d.project_state.projects)
    lines.push(
      `### ${p.name} [${p.project_id}]`,
      p.goal,
      ...p.decisions.map((v) => `- 决策：${v}`),
      ...p.progress.map((v) => `- 进度：${v}`),
      ...p.blockers.map((v) => `- 阻塞：${v}`),
      ...p.next_steps.map((v) => `- 下一步：${v}`),
    );
  lines.push('', `## 连续性摘要（rev ${d.continuity_memory.revision}）`);
  if (!d.continuity_memory.entries.length) lines.push('（空）');
  for (const e of d.continuity_memory.entries)
    lines.push(`- [${e.id}] ${e.occurred_at} ${e.summary}`);
  return `${lines.join('\n')}\n`;
}
