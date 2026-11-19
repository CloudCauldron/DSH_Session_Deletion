import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(join(locale, 'es.json'), '{"messages":{"invalid":12}}');
  await writeFile(join(locale, 'de.json'), '{"messages":{"title":"Titel"}}');
  await mkdir(join(locale, 'ja.json')); // Cannot be read as a catalog on either supported OS.
  if (process.platform === 'linux') await writeFile(join(locale, 'en.JSON'), '{"messages":{"title":"shadow"}}');
  const moduleUrl = pathToFileURL(join(lib, 'locale.mjs')).href;
  const { LocalizedError, dictionaries } = await import(moduleUrl) as typeof import('../lib/locale.js');
  assert.deepEqual(Object.keys(dictionaries).sort(), ['de', 'en', 'zh']);
  for (const locale of [undefined, 'pt', 'fr']) assert.equal(new LocalizedError('title', undefined, { locale }).message, 'Title');
  assert.equal(new LocalizedError('title', undefined, { locale: 'de' }).message, 'Titel');
  assert.equal(new LocalizedError([{ key: 'title' }, { key: 'detail', params: { id: 12 } }], undefined, { locale: 'zh-CN' }).message, '标题; Missing 12');
  if (process.platform === 'linux' && process.getuid?.() !== 0) {
    await chmod(locale, 0o100);
    try {
      const { dictionaries } = await import(moduleUrl + '?unlisted');
      assert.deepEqual(Object.keys(dictionaries), ['en']);
    } finally { await chmod(locale, 0o700); }
  }
  await rm(join(locale, 'en.json'));
  await assert.rejects(import(moduleUrl + '?missing'), { code: 'ENOENT' });
  await writeFile(join(locale, 'en.json'), '{"messages":[]}');
  await assert.rejects(import(moduleUrl + '?invalid'), /Invalid locale dictionary: en.json/);
});
