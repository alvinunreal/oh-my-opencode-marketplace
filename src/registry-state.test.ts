import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const root = resolve(import.meta.dir, '..');

async function filesUnder(directory: string, prefix = ''): Promise<string[]> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await filesUnder(path, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, relativePath), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('published marketplace state', () => {
  test('contains only the Janitor source bundle', async () => {
    expect(await filesUnder(resolve(root, 'packages'))).toEqual([
      'v3/alvin/janitor/1.0.0/avatar.webp',
      'v3/alvin/janitor/1.0.0/package.json',
    ]);
  });

  test('contains only Janitor generated artifacts and no retirements', async () => {
    expect(await filesUnder(resolve(root, 'dist/v1/artifacts'))).toEqual([]);
    expect(await filesUnder(resolve(root, 'dist/v2/artifacts'))).toEqual([]);
    expect(await filesUnder(resolve(root, 'dist/v3/artifacts'))).toEqual([
      'alvin/janitor/1.0.0.json',
      'alvin/janitor/1.0.0.webp',
    ]);

    const v1Index = await readJson('dist/v1/index.json');
    const v2Index = await readJson('dist/v2/index.json');
    const v3Index = await readJson('dist/v3/index.json');
    expect(v1Index.entries).toEqual([]);
    expect(v2Index.entries).toEqual([]);
    expect(v2Index.retirements).toEqual([]);
    expect(v3Index.entries).toHaveLength(1);
    expect(v3Index.retirements).toEqual([]);
    expect(
      (v3Index.entries as Array<{ id: string }>).map((entry) => entry.id),
    ).toEqual(['alvin/janitor']);
  });

  test('contains exactly the Janitor catalog entry in every catalog output', async () => {
    const expected = [{ id: 'alvin/janitor', state: 'active' }];
    for (const path of ['catalog.json', 'dist/v2/catalog.json', 'dist/v3/catalog.json']) {
      expect((await readJson(path)).agents).toEqual(expected);
    }
  });
});
