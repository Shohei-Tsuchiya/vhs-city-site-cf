#!/usr/bin/env node
/**
 * Pages ビルド時に status Worker URL を js/config.js へ書き出す。
 * STATUS_WORKER_URL 未設定時は相対パス data/status.json（ローカル用）。
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const url = (process.env.STATUS_WORKER_URL || '../data/status.json').replace(/\/$/, '');
const statusUrl = url.endsWith('.json') ? url : `${url}/status.json`;

writeFileSync(
  join(ROOT, 'js', 'config.js'),
  `/** Pages ビルド時に生成。手動編集不要（STATUS_WORKER_URL で上書き） */\nexport const STATUS_URL = ${JSON.stringify(statusUrl)};\n`,
  'utf8'
);

console.log(`Wrote js/config.js STATUS_URL=${statusUrl}`);
