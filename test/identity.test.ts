import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentIdentity, previewIdentityPatch, applyIdentityProposal } from '../src/memory-core/identity.js';
import { withRuntime } from './helpers.js';

test('identity update uses an independent proposal and complete revision snapshot', async () => {
  await withRuntime(async (runtime) => {
    const before = await currentIdentity(runtime);
    const proposal = await previewIdentityPatch(runtime, { user_profile: { display_name: null, facts: [{ key: 'answer_style', value: '先给结论' }] } });
    const updated = await applyIdentityProposal(runtime, proposal.proposal_id, proposal.expected_revision);
    assert.equal(updated.revision, 2);
    const after = await currentIdentity(runtime);
    assert.equal(after.revision, 2);
    assert.notEqual(after.identity_hash, before.identity_hash);
    assert.equal((after.user_profile as { facts: Array<{ key: string }> }).facts[0]!.key, 'answer_style');
  });
});

test('failed Windows pointer replacement keeps the old current snapshot and retry can finish', async () => {
  await withRuntime(async (runtime) => {
    const before = await currentIdentity(runtime);
    const proposal = await previewIdentityPatch(runtime, { user_profile: { display_name: null, facts: [{ key: 'timezone', value: 'Asia/Shanghai' }] } });
    await assert.rejects(() => applyIdentityProposal(runtime, proposal.proposal_id, proposal.expected_revision, { beforePointerReplace: async () => { throw new Error('injected replacement failure'); } }));
    const afterFailure = await currentIdentity(runtime);
    assert.equal(afterFailure.revision, before.revision);
    assert.equal(afterFailure.identity_hash, before.identity_hash);
    const updated = await applyIdentityProposal(runtime, proposal.proposal_id, proposal.expected_revision);
    assert.equal(updated.revision, before.revision + 1);
  });
});

test('partial snapshot write is staged and does not replace the active identity', async () => {
  await withRuntime(async (runtime) => {
    const before = await currentIdentity(runtime);
    const proposal = await previewIdentityPatch(runtime, { habits: { templates: ['lead-first', 'concise'] } });
    await assert.rejects(() => applyIdentityProposal(runtime, proposal.proposal_id, proposal.expected_revision, { afterFileWrite: async (name) => { if (name === 'user-profile.json') throw new Error('injected stage failure'); } }));
    const afterFailure = await currentIdentity(runtime);
    assert.equal(afterFailure.identity_hash, before.identity_hash);
    assert.equal(afterFailure.revision, before.revision);
    const result = await applyIdentityProposal(runtime, proposal.proposal_id, proposal.expected_revision);
    assert.equal(result.revision, 2);
  });
});
