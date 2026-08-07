#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const STATUS_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'status.json');

if (!existsSync(STATUS_PATH)) {
  writeFileSync(
    STATUS_PATH,
    `${JSON.stringify({ updatedAt: new Date().toISOString(), live: [], upcoming: [] }, null, 2)}\n`,
    'utf8'
  );
  console.log('Created empty status.json');
  process.exit(0);
}

const status = JSON.parse(readFileSync(STATUS_PATH, 'utf8'));
const ageMs = Date.now() - new Date(status.updatedAt || 0).getTime();
const count = (status.live?.length || 0) + (status.upcoming?.length || 0);
console.log(
  `status.json ready (age: ${Math.round(ageMs / 60000)} min, streams: ${count})`
);
