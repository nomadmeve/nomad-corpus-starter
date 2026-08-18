import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

async function read(relativePath) {
  return fs.promises.readFile(path.join(repoRoot, relativePath), 'utf8');
}

describe('Docker packaging contract', () => {
  it('uses the tested Node runtime and a non-root application process', async () => {
    const dockerfile = await read('Dockerfile');
    assert.match(dockerfile, /^FROM node:24\.18\.0-bookworm-slim$/m);
    assert.match(dockerfile, /^WORKDIR \/app$/m);
    assert.match(dockerfile, /^COPY --chown=node:node package\.json \.\/$/m);
    assert.match(dockerfile, /^COPY --chown=node:node src \.\/src$/m);
    assert.match(dockerfile, /^USER node$/m);
    assert.match(dockerfile, /^CMD \["node", "src\/server\.js"\]$/m);
  });

  it('declares an in-container healthcheck without adding curl', async () => {
    const dockerfile = await read('Dockerfile');
    assert.match(dockerfile, /^ENV HOST=0\.0\.0\.0 PORT=3040 DAO_CANON_ROOT=\/corpus$/m);
    assert.match(dockerfile, /^EXPOSE 3040$/m);
    assert.ok(dockerfile.includes('HEALTHCHECK'));
    assert.ok(dockerfile.includes("fetch('http://127.0.0.1:3040/health')"));
    assert.ok(!dockerfile.includes('apt-get'));
    assert.ok(!dockerfile.includes('curl'));
  });

  it('publishes only on host loopback and mounts the corpus read-only', async () => {
    const compose = await read('compose.yaml');
    for (const required of [
      '127.0.0.1:3040:3040',
      'HOST: 0.0.0.0',
      'PORT: 3040',
      'DAO_CANON_ROOT: /corpus',
      'target: /corpus',
      'read_only: true',
      'create_host_path: false',
      'restart: unless-stopped',
      'read_only: true',
      'no-new-privileges:true',
      'cap_drop:',
      '- ALL',
      'init: true',
    ]) {
      assert.ok(compose.includes(required), required);
    }
    assert.ok(compose.includes('${DAO_CANON_HOST_ROOT:-/mnt/d/Lab/ScholarLib/Corpus/DaoCanon}'));
    assert.ok(!compose.includes('0.0.0.0:3040:3040'));
  });

  it('keeps repository and evidence files out of the image context', async () => {
    const ignore = await read('.dockerignore');
    for (const entry of ['.git', '.env', 'node_modules', 'docs', 'ops', 'test']) {
      assert.ok(ignore.split(/\r?\n/).includes(entry), entry);
    }
  });

  it('runs a loopback-only Node gate in front of the API for public access', async () => {
    const compose = await read('compose.yaml');
    const gateSection = compose.split('gate:')[1];
    assert.ok(gateSection, 'compose.yaml must define a gate service');
    for (const required of [
      'image: daocanon-api:local',
      'command: ["node", "src/gate.js"]',
      'network_mode: host',
      'HOST: 127.0.0.1',
      'DAO_CANON_GATE_UPSTREAM: http://127.0.0.1:3040',
      'DAO_CANON_GATE_RESEARCH_UPSTREAM: http://127.0.0.1:3060',
      '${DAO_CANON_GATE_TOKEN:',
      'read_only: true',
      'no-new-privileges:true',
      'cap_drop:',
      '- ALL',
      'init: true',
      'restart: unless-stopped',
    ]) {
      assert.ok(gateSection.includes(required), required);
    }
    assert.ok(!gateSection.includes('ports:'), 'host-network gate must not publish a second port');
    assert.ok(!compose.includes('0.0.0.0:3080:3080'));
    assert.ok(!compose.includes('caddy'), 'the gate must not depend on caddy');
    assert.ok(!compose.includes('Caddyfile'), 'the gate must not depend on a Caddyfile');
    assert.ok(!compose.includes('basicauth'), 'the gate must use the single-password login page');
  });

  it('keeps the gate credential out of tracked files', async () => {
    const envExample = await read('.env.example');
    assert.ok(envExample.includes('DAO_CANON_GATE_TOKEN'));
    assert.doesNotMatch(envExample, /pbkdf2\.sha256\.[0-9]+\./,
      '.env.example must not embed a gate token');
    const gateSource = await read('src/gate.js');
    assert.ok(gateSource.includes('verifyPassword'));
    assert.ok(gateSource.includes('pbkdf2Sync'));
    assert.ok(!gateSource.includes('WWW-Authenticate'),
      'the gate must not implement HTTP basic auth challenges');
    assert.ok(!gateSource.includes('Authorization'),
      'the gate must not read Authorization headers');
  });
});
