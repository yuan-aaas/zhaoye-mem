import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offerProfileSetup, runProfileSetup } from '../src/adapters/profile-setup.js';
import { currentIdentity, previewIdentityPatch, applyIdentityProposal } from '../src/memory-core/identity.js';
import { HabitsSchema, IdentityProfileSchema } from '../src/contracts/schemas.js';
import { withRuntime } from './helpers.js';

function conversation(answers: string[]) {
  let cursor = 0;
  const output: string[] = [];
  return {
    output,
    io: {
      question: async (_prompt: string) => {
        assert.ok(cursor < answers.length, 'unexpected extra question');
        return answers[cursor++]!;
      },
      write: (text: string) => { output.push(text); },
    },
  };
}

test('empty profile gets one optional invitation, persisted across journal replay', async () => {
  await withRuntime(async (runtime) => {
    const before = await currentIdentity(runtime);
    const output: string[] = [];
    await offerProfileSetup(runtime, (text) => { output.push(text); });
    await runtime.events.replay();
    await offerProfileSetup(runtime, (text) => { output.push(text); });
    assert.equal(output.length, 1);
    assert.match(output[0]!, /\/profile/);
    assert.equal((await currentIdentity(runtime)).identity_hash, before.identity_hash);
  });
});

test('existing user profile is not invited to fill again', async () => {
  await withRuntime(async (runtime) => {
    const proposal = await previewIdentityPatch(runtime, { user_profile: { display_name: '用户', facts: [] } });
    await applyIdentityProposal(runtime, proposal.proposal_id, proposal.expected_revision);
    await offerProfileSetup(runtime, () => { assert.fail('existing profile should not prompt'); });
    assert.equal(runtime.events.all().some((event) => event.kind === 'identity.setup-offered'), false);
  });
});

test('blank answers and cancelled preview keep the current identity and create no proposals', async () => {
  await withRuntime(async (runtime) => {
    const before = await currentIdentity(runtime);
    await runProfileSetup(runtime, conversation(Array<string>(8).fill('')).io);
    await runProfileSetup(runtime, conversation(['1', '', '昵称', '', '', '', '', '', '取消']).io);
    assert.equal((await currentIdentity(runtime)).identity_hash, before.identity_hash);
    assert.equal(runtime.events.all().length, 0);
  });
});

test('explicit save applies a template and only entered facts via an identity proposal', async () => {
  await withRuntime(async (runtime) => {
    const { io, output } = conversation(['2', '小助', '阿林', '', '学习写作', '', '', '1,3', '保存']);
    await runProfileSetup(runtime, io);
    const after = await currentIdentity(runtime);
    assert.equal(after.revision, 2);
    assert.match(after.kernel, /私人助理/);
    assert.match(after.kernel, /小助/);
    assert.match(after.kernel, /只使用当前允许的能力/);
    assert.deepEqual(IdentityProfileSchema.parse(after.user_profile), { display_name: '阿林', facts: [{ key: 'long_term_goals', value: '学习写作' }] });
    assert.deepEqual(HabitsSchema.parse(after.habits), { templates: ['lead-first', 'show-evidence'] });
    assert.deepEqual(runtime.events.all().map((event) => event.kind), ['identity.proposal', 'identity.applied']);
    assert.ok(output.some((text) => text.includes('画像预览')));
    assert.equal(runtime.content.all().length, 0);
  });
});

test('later filling preserves existing facts and leaving habits blank retains current habits', async () => {
  await withRuntime(async (runtime) => {
    const proposal = await previewIdentityPatch(runtime, { user_profile: { display_name: '阿林', facts: [{ key: 'timezone', value: 'Asia/Shanghai' }, { key: 'role', value: '旧角色' }] } });
    await applyIdentityProposal(runtime, proposal.proposal_id, proposal.expected_revision);
    const before = await currentIdentity(runtime);
    await runProfileSetup(runtime, conversation(['', '', '', '新角色', '', '', '', '', '保存']).io);
    const after = await currentIdentity(runtime);
    assert.equal(after.kernel, before.kernel);
    assert.deepEqual(after.habits, before.habits);
    assert.deepEqual(IdentityProfileSchema.parse(after.user_profile), { display_name: '阿林', facts: [{ key: 'timezone', value: 'Asia/Shanghai' }, { key: 'role', value: '新角色' }] });
  });
});

test('identity budget overflow refuses saving before a proposal is created', async () => {
  await withRuntime(async (runtime) => {
    const before = await currentIdentity(runtime);
    const proposal = await previewIdentityPatch(runtime, { user_profile: { display_name: null, facts: Array.from({ length: 4 }, (_, index) => ({ key: `existing_${index}`, value: '长'.repeat(250) })) } });
    await applyIdentityProposal(runtime, proposal.proposal_id, proposal.expected_revision);
    const count = runtime.events.all().length;
    await assert.rejects(() => runProfileSetup(runtime, conversation(['3', '', '', '', '目'.repeat(300), '偏'.repeat(300), '', '']).io), /BUDGET|固定画像/);
    assert.equal(runtime.events.all().length, count);
    assert.equal((await currentIdentity(runtime)).revision, before.revision + 1);
  });
});

test('template-only setup leaves user facts empty, and early cancellation writes nothing', async () => {
  await withRuntime(async (runtime) => {
    await assert.rejects(() => runProfileSetup(runtime, conversation(['/cancel']).io), /已取消填写/);
    assert.equal(runtime.events.all().length, 0);
    await runProfileSetup(runtime, conversation(['3', '', '', '', '', '', '', '', '保存']).io);
    const identity = await currentIdentity(runtime);
    assert.match(identity.kernel, /长期伙伴/);
    assert.deepEqual(identity.user_profile, { display_name: null, facts: [] });
  });
});
