import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

void test('host diagnostics fall back to English for unavailable catalogs and missing keys', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-locale-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const locale = join(root, 'locale'), lib = join(root, 'lib');
  await mkdir(locale); await mkdir(lib);
  await copyFile(new URL('../lib/locale.js', import.meta.url), join(lib, 'locale.mjs'));
  await writeFile(join(locale, 'en.json'), JSON.stringify({ messages: { title: 'Title', detail: 'Missing {id}', 'error.separator': '; ' } }));
  await writeFile(join(locale, 'zh.json'), JSON.stringify({ messages: { title: '标题' } }));
  await writeFile(join(locale, 'fr.json'), 'invalid JSON');
  const { LocalizedError, dictionaries } = await import(pathToFileURL(join(lib, 'locale.mjs')).href) as typeof import('../lib/locale.js');
  assert.deepEqual(Object.keys(dictionaries).sort(), ['en', 'zh']);
  for (const locale of [undefined, 'de', 'fr']) assert.equal(new LocalizedError('title', undefined, { locale }).message, 'Title');
  assert.equal(new LocalizedError([{ key: 'title' }, { key: 'detail', params: { id: 12 } }], undefined, { locale: 'zh-CN' }).message, '标题; Missing 12');
});
