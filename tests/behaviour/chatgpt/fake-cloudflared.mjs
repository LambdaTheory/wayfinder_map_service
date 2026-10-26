#!/usr/bin/env node
// Verification only. Does not read credentials, connect to Cloudflare or forward traffic.
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
const argv = process.argv.slice(2);
const text = readFileSync(argv[argv.indexOf('--config') + 1], 'utf8');
const scalar = raw => raw.startsWith('"') ? JSON.parse(raw) : raw;
const fields = Object.fromEntries(text.split('\n').filter(l => /^(tunnel|credentials-file):/.test(l)).map(l => {
  const [key, raw] = l.split(/:\s+/, 2); return [key, scalar(raw)];
}));
const config = text.startsWith('{') ? JSON.parse(text) : { ...fields, ingress: [...text.matchAll(/^\s+(?:- )?service: (.+)$/gm)].map(m => ({ service: scalar(m[1]) })) };
const statePath = join(dirname(config['credentials-file']), 'fake-connector.json');
const info = () => ({ id: config.tunnel, name: 'opencode', conns: existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : [] });
if (argv.includes('info')) {
  console.log(JSON.stringify(info()));
} else if (argv.includes('run')) {
  if (existsSync(join(dirname(statePath), 'fail-start'))) process.exit(2);
  const id = '22222222-2222-4222-8222-222222222222';
  writeFileSync(statePath, JSON.stringify([{ id, conns: [{ is_pending_reconnect: false }] }]));
  writeFileSync(join(dirname(statePath), 'fake-run.json'), JSON.stringify({ config, pid: process.pid }));
  console.error(`Generated Connector ID: ${id}\nRegistered tunnel connection`);
  const timer = setInterval(() => {}, 1000);
  const stop = () => { clearInterval(timer); rmSync(statePath, { force: true }); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('SIGHUP', stop);
} else process.exit(3);
