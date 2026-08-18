import test from 'node:test';
import assert from 'node:assert/strict';

import { createAgentClient } from '../src/web/stageb.js';

test('stageb: enables extended dialogue when the agent health envelope is degraded but available', async () => {
  const client = createAgentClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        schema_version: 'agent.health.v0.1',
        status: 'degraded',
        data: { adapter: { status: 'ok' } },
      }),
    }),
  });

  assert.deepEqual(await client.health(), {
    ok: true,
    data: {
      schema_version: 'agent.health.v0.1',
      status: 'degraded',
      data: { adapter: { status: 'ok' } },
    },
  });
});
