import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { SteveConnector } from './steve-connector.js';
import { steveProjectBinding } from './steve-project-binding.js?v=20261008-completion-placement1';

const owner = { userId: 'alice', projectId: 'origin-project' };
const binding = { renderUserId: owner.userId, renderProjectId: owner.projectId, revision: 'revision-origin' };
const response = body => ({ ok: true, status: 200, json: async () => body });

test('busy STEVE accepts an explicitly targeted reply and signs its original request', async () => {
  const sent = [];
  const connector = new SteveConnector({ cryptoApi: webcrypto, schedule: () => 1, cancelSchedule() {},
    secretStore: { read: async () => 'test-secret' },
    fetchFn: async (url, options) => {
      if (url.endsWith('/status')) return response({ capabilities: { projectBinding: true, replyToRequest: true } });
      if (url.endsWith('/project')) return response({ version: 1, binding, busy: true });
      sent.push(JSON.parse(options.body)); return response({ accepted: true });
    } });
  connector.state = 'busy';
  try {
    await connector.submit({ prompt: 'Use the smaller plate', renderUserId: owner.userId,
      renderProjectId: owner.projectId, bindingRevision: binding.revision, replyToRequestId: 'original-request' });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].replyToRequestId, 'original-request');
    assert.equal(sent[0].renderProjectId, 'origin-project');
    connector.state = 'busy';
    await assert.rejects(connector.submit({ prompt: 'New unrelated model', renderUserId: owner.userId,
      renderProjectId: owner.projectId }));
    assert.equal(sent.length, 1);
  } finally { steveProjectBinding.reset(); }
});

test('first explicit send claims an unbound bridge with null revision', async () => {
  const connector = new SteveConnector({ cryptoApi: webcrypto });
  const calls = [];
  connector.project = async packet => {
    calls.push(packet);
    return { version: 1, binding: packet.action === 'bind' ? binding : null, busy: false };
  };
  try {
    steveProjectBinding.reset();
    assert.equal(await connector.prepareSubmission(owner), binding.revision);
    assert.deepEqual(calls[1], { action: 'bind', renderUserId: owner.userId,
      renderProjectId: owner.projectId, expectedRevision: null });
  } finally { steveProjectBinding.reset(); }
});

test('a reply never reclaims an available bridge from another project', async () => {
  const connector = new SteveConnector({ cryptoApi: webcrypto });
  const calls = [];
  connector.project = async packet => {
    calls.push(packet);
    return { version: 1, binding: { ...binding, renderProjectId: 'other-project' }, busy: false, availableForProjectChange: true };
  };
  try {
    steveProjectBinding.reset();
    await assert.rejects(connector.prepareSubmission(owner, undefined, 'original-request'), { code: 'project_mismatch' });
    assert.deepEqual(calls, [{ action: 'get' }]);
  } finally { steveProjectBinding.reset(); }
});
