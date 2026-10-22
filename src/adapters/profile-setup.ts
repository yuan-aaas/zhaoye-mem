import { randomUUID } from 'node:crypto';
import { HabitsSchema, IdentityProfileSchema } from '../contracts/schemas.js';
import { AssistantError } from '../contracts/errors.js';
import type { Runtime } from '../infrastructure/runtime.js';
import { AssistantFramework } from '../framework/assistant.js';
import { resolveIdentityPatch, type IdentityPatch } from '../contracts/identity.js';
import { defaultLeadKernel, identityTemplates, profileQuestions } from '../memory-core/identity-templates.js';

export type ProfileSetupIO = { question(prompt: string): Promise<string>; write(text: string): void };

const habitLabels = {
  'lead-first': '先给结论', concise: '简洁表达', 'show-evidence': '提供证据', 'ask-when-unclear': '不清楚时询问',
} as const;

export async function offerProfileSetup(runtime: Runtime, write: ProfileSetupIO['write']): Promise<void> {
  const identity = await new AssistantFramework(runtime).readIdentity();
  const profile = IdentityProfileSchema.parse(identity.user_profile);
  if (profile.display_name?.trim() || profile.facts.length > 0 || runtime.events.all().some((event) => event.kind === 'identity.setup-offered')) return;
  write('你的初始画像还是空白。可以输入 /profile，从工作搭档、私人助理、长期伙伴模板开始填写；也可以直接聊天，之后随时补充。所有项目都可留空，预览后输入“保存”才会生效。\n');
  await runtime.events.append({ op_id: 'identity-setup-offered', kind: 'identity.setup-offered', payload: { offered_at: new Date().toISOString() } });
}

export async function runProfileSetup(runtime: Runtime, io: ProfileSetupIO): Promise<void> {
  const framework = new AssistantFramework(runtime);
  const identity = await framework.readIdentity();
  const profile = IdentityProfileSchema.parse(identity.user_profile);
  const habits = HabitsSchema.parse(identity.habits);
  const patch: IdentityPatch = {};
  const ask = async (prompt: string): Promise<string> => {
    const answer = (await io.question(prompt)).trim();
    if (answer === '/cancel' || answer === '/quit' || answer === '/exit') throw new AssistantError('INVALID_INPUT', '已取消填写，画像未更改。');
    return answer;
  };
  const askLimited = async (prompt: string, limit: number): Promise<string> => {
    while (true) {
      const answer = await ask(prompt);
      if (answer.length <= limit) return answer;
      io.write(`内容过长，请缩短到 ${limit} 字以内。\n`);
    }
  };
  io.write('初始画像填写：回车保留当前值或留空，/cancel 取消。模板只设定助手的协作方式；个人信息由你填写。\n');
  identityTemplates.forEach((template, index) => io.write(`${index + 1}. ${template.label}：${template.description}\n`));
  let templateChoice: string;
  while (true) {
    templateChoice = await ask('助手模板 [1-3，回车保留当前设定]> ');
    if (templateChoice === '' || /^[1-3]$/.test(templateChoice)) break;
    io.write('请选择 1、2、3，或直接回车。\n');
  }
  const template = templateChoice ? identityTemplates[Number(templateChoice) - 1]! : undefined;
  if (template) patch.kernel = `${defaultLeadKernel}\n协作风格：${template.style}\n`;
  const assistantName = await askLimited('助手称呼 [可选]> ', 80);
  if (assistantName) patch.kernel = `${patch.kernel ?? identity.kernel}\n用户为你指定的称呼：${assistantName}\n`;
  const displayName = await askLimited(`希望如何称呼你 [当前：${profile.display_name ?? '未填写'}]> `, 80);
  const facts = profile.facts.map((fact) => ({ ...fact }));
  for (const field of profileQuestions) {
    const existing = facts.find((fact) => fact.key === field.key);
    const value = await askLimited(`${field.label} [当前：${existing?.value ?? '未填写'}]> `, 300);
    if (!value) continue;
    if (existing) existing.value = value;
    else facts.push({ key: field.key, value });
  }
  const nextProfile = IdentityProfileSchema.parse({ display_name: displayName || profile.display_name, facts });
  if (JSON.stringify(nextProfile) !== JSON.stringify(profile)) patch.user_profile = nextProfile;
  const habitIds = Object.keys(habitLabels) as Array<keyof typeof habitLabels>;
  io.write(`协作习惯：${habitIds.map((id, index) => `${index + 1} ${habitLabels[id]}`).join('；')}。\n`);
  while (true) {
    const selection = await ask('启用的习惯 [输入编号，如 1,2,3,4；0 全部关闭；回车保留当前]> ');
    if (!selection) break;
    if (selection === '0') { patch.habits = { templates: [] }; break; }
    const choices = selection.split(/[,，\s]+/).filter(Boolean);
    if (choices.length > 0 && choices.every((choice) => /^[1-4]$/.test(choice))) {
      patch.habits = { templates: [...new Set(choices.map((choice) => habitIds[Number(choice) - 1]!))] };
      break;
    }
    io.write('请输入 1-4 的编号、0，或直接回车。\n');
  }
  if (patch.kernel === identity.kernel) delete patch.kernel;
  if (patch.habits && JSON.stringify(patch.habits) === JSON.stringify(habits)) delete patch.habits;
  if (Object.keys(patch).length === 0) { io.write('未填写新的内容，画像保持当前设定。之后可随时输入 /profile。\n'); return; }
  const kernel = patch.kernel ?? identity.kernel;
  const nextHabits = patch.habits ?? habits;
  resolveIdentityPatch(identity, patch);
  io.write(`\n画像预览：\n助手设定${template ? `（${template.label}）` : ''}：\n${kernel}\n用户称呼：${nextProfile.display_name ?? '未填写'}\n`);
  for (const fact of nextProfile.facts) io.write(`${profileQuestions.find((field) => field.key === fact.key)?.label ?? fact.key}：${fact.value}\n`);
  io.write(`协作习惯：${nextHabits.templates.map((id) => habitLabels[id]).join('、') || '无'}\n`);
  if (await ask('输入“保存”应用以上画像，其他输入取消> ') !== '保存') { io.write('已取消保存，画像未更改。\n'); return; }
  const applied = await framework.updateIdentity({ operation_id: randomUUID(), expected_revision: identity.revision, patch }, { adapter_id: 'cli', request_id: randomUUID() });
  io.write(`画像已保存，版本 ${applied.revision}。之后可输入 /profile 补充或调整。\n`);
}
