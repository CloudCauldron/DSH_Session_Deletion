import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection';
import { readDictionaries, registerCatalogs } from '../src/locale/catalogs.ts';

void test('catalogs load on first request, retry after failure, and cache per registration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalogs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = pathToFileURL(root + '/');
  const en = { title: 'Title' }, fr = { title: 'Titre' };
  const request = new Request('http://localhost/api/example/locales');
  function mount() {
    let route!: ConnectionFetchRoute;
    registerCatalogs({ register(entry) { route = entry; return async () => {}; } }, 'example', directory);
    assert.equal(route.path, new URL(request.url).pathname);
    assert.deepEqual(route.methods, ['GET']);
    return () => route.fetch(request);
  }
  const get = mount();
  assert.equal((await get()).status, 500);
  const save = (name: string, messages: unknown) => writeFile(join(root, name), JSON.stringify({ messages }));
  await save('en.json', []);
  assert.equal((await get()).status, 500);
  await save('en.json', en);
  await save('fr-CA.json', fr);
  await save('_private.json', {});
  await save('es.json', { title: 12 });
  await writeFile(join(root, 'zh.json'), 'invalid JSON');
  await mkdir(join(root, 'ja.json'));
  if (process.platform === 'linux') await save('en.JSON', { title: 'shadow' });
  const expected = { ok: true, dictionaries: { en, 'fr-ca': fr } };
  assert.deepEqual(await (await get()).json(), expected);
  await save('de.json', {});
  assert.deepEqual(await (await get()).json(), expected);
  assert.deepEqual(await (await mount()()).json(), { ok: true, dictionaries: { ...expected.dictionaries, de: {} } });
  if (process.platform === 'linux' && process.getuid?.() !== 0) {
    await chmod(root, 0o100);
    try { assert.deepEqual(readDictionaries(directory), { en }); }
    finally { await chmod(root, 0o700); }
  }
});

void test('English errors preserve ordered messages, native causes and literal diagnostics', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-locale-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lib = join(root, 'lib/locale'), catalogs = join(root, 'locale');
  await mkdir(lib, { recursive: true });
  await mkdir(catalogs);
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const name of ['errors.js', 'shared.js']) {
    await copyFile(new URL('../lib/locale/' + name, import.meta.url), join(lib, name));
  }
  const { LocalizedError, LocalizedAggregateError, describeFailure } = await import(pathToFileURL(join(lib, 'errors.js')).href) as typeof import('../src/locale/errors.ts');
  assert.equal(new LocalizedError('detail').message, 'detail');
  await writeFile(join(catalogs, 'en.json'), JSON.stringify({ messages: { title: 'Failed', detail: 'Missing {id}' } }));
  const native = new Error('original\n<&>');
  const inner = new LocalizedError('detail', { id: 12 });
  const cleanup = new SuppressedError(native, inner);
  const aggregate = new LocalizedAggregateError([cleanup], 'title', undefined, { cause: native });
  assert.deepEqual(aggregate.errors, [cleanup]);
  assert.equal(aggregate.cause, native);
  assert.deepEqual(describeFailure(aggregate), { error: 'Failed; Missing 12; ' + native.message,
    messages: [{ key: 'title' }, { key: 'detail', params: { id: 12 } }], diagnostic: native.message });
  assert.deepEqual(describeFailure(new AggregateError([inner, native], 'native group')).messages, inner.messages);
  assert.equal(new LocalizedError('title', undefined, { fallback: 'CLI text' }).message, 'CLI text');
});

void test('shipped English and Chinese catalogs have matching keys and placeholders', () => {
  const { en, zh } = readDictionaries();
  assert.ok(en && zh);
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const placeholders = (value: string) => (value.match(/\{\w+\}/g) ?? []).sort();
  for (const [key, template] of Object.entries(en)) {
    assert.deepEqual(placeholders(zh[key]!), placeholders(template), key);
  }
});
