import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function writeJson(path, value) {
  const fullPath = resolve(process.cwd(), path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(value, null, 2)}\n`);
  return fullPath;
}

export function writeBase64(path, base64) {
  const fullPath = resolve(process.cwd(), path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, Buffer.from(base64, 'base64'));
  return fullPath;
}

