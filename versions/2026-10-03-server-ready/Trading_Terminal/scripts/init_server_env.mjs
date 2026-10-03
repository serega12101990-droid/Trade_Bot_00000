import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const template = await readFile('.env.server.example', 'utf8');
await writeFile('.env.server', template
  .replace('replace_with_20_or_more_random_characters', randomBytes(24).toString('hex'))
  .replace('replace_with_32_or_more_different_random_characters', randomBytes(32).toString('hex')),
  { flag: 'wx', mode: 0o600 });
console.log('Created .env.server. Store it privately; credentials were not printed. Automation remains disabled.');
