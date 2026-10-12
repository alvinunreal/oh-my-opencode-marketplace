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
  test('contains only the published v3 source bundles', async () => {
    expect(await filesUnder(resolve(root, 'packages'))).toEqual([
      'v3/alvin/documenter/1.0.0/avatar.webp',
      'v3/alvin/documenter/1.0.0/package.json',
      'v3/alvin/janitor/1.0.1/avatar.webp',
      'v3/alvin/janitor/1.0.1/package.json',
      'v3/alvin/paladin/1.0.1/avatar.webp',
      'v3/alvin/paladin/1.0.1/package.json',
      'v3/capybearista/arbiter/1.0.0/avatar.webp',
      'v3/capybearista/arbiter/1.0.0/package.json',
      'v3/capybearista/arbiter/1.1.0/avatar.webp',
      'v3/capybearista/arbiter/1.1.0/package.json',
      'v3/capybearista/chronicler/1.0.0/avatar.webp',
      'v3/capybearista/chronicler/1.0.0/package.json',
      'v3/capybearista/chronicler/1.1.0/avatar.webp',
      'v3/capybearista/chronicler/1.1.0/package.json',
      'v3/capybearista/hunter/1.0.0/avatar.webp',
      'v3/capybearista/hunter/1.0.0/package.json',
      'v3/capybearista/hunter/1.1.0/avatar.webp',
      'v3/capybearista/hunter/1.1.0/package.json',
      'v3/capybearista/proctor/1.0.0/avatar.webp',
      'v3/capybearista/proctor/1.0.0/package.json',
      'v3/capybearista/proctor/1.1.0/avatar.webp',
      'v3/capybearista/proctor/1.1.0/package.json',
    ]);
  });

  test('links each capybearista agent manifest to the publisher', async () => {
    for (const agent of ['arbiter', 'chronicler', 'hunter', 'proctor']) {
      const bundle = await readJson(
        `packages/v3/capybearista/${agent}/1.0.0/package.json`,
      );
      const manifest = bundle.manifest as {
        id: string;
        author: { url: string };
      };
      expect(manifest.id).toBe(`capybearista/${agent}`);
      expect(manifest.author.url).toBe('https://github.com/capyBearista');
    }
  });

  test('uses role-first prompts without embedded attribution or agent branding', async () => {
    for (const agent of ['arbiter', 'chronicler', 'hunter', 'proctor']) {
      const bundle = await readJson(
        `packages/v3/capybearista/${agent}/1.1.0/package.json`,
      );
      const manifest = bundle.manifest as { version: string; prompt: string };
      expect(manifest.version).toBe('1.1.0');
      expect(manifest.prompt.startsWith('# ')).toBe(true);
      expect(manifest.prompt).not.toMatch(/\b(?:Arbiter|Hunter|Proctor|Chronicler)\b/);
      expect(manifest.prompt).not.toContain('## Upstream attribution and license');
      expect(manifest.prompt).not.toContain('Copyright (c) 2025-2026 Cole Medin');
    }
  });

  test('preserves Chronicler metadata and restores structured documentation workflows', async () => {
    const previous = (
      await readJson('packages/v3/capybearista/chronicler/1.0.0/package.json')
    ).manifest as Record<string, unknown>;
    const current = (
      await readJson('packages/v3/capybearista/chronicler/1.1.0/package.json')
    ).manifest as Record<string, unknown>;
    expect({ ...current, version: previous.version, prompt: previous.prompt }).toEqual(
      previous,
    );
    const prompt = current.prompt as string;
    expect(prompt).toContain('<documentation-handoff kind="information-gap">');
    expect(prompt).toContain('kind="input-gap"');
    expect(prompt).toContain('<summary>');
    expect(prompt).toContain('<changes>');
    expect(prompt).toContain('<verification>');
    expect(prompt).toContain('Perform an Internal Writing-Quality Review');
    expect(current.skills).toEqual([]);
  });

  test('contains only v3 generated artifacts and no retirements', async () => {
    expect(await filesUnder(resolve(root, 'dist/v1/artifacts'))).toEqual([]);
    expect(await filesUnder(resolve(root, 'dist/v2/artifacts'))).toEqual([]);
    expect(await filesUnder(resolve(root, 'dist/v3/artifacts'))).toEqual([
      'alvin/documenter/1.0.0.json',
      'alvin/documenter/1.0.0.webp',
      'alvin/janitor/1.0.1.json',
      'alvin/janitor/1.0.1.webp',
      'alvin/paladin/1.0.1.json',
      'alvin/paladin/1.0.1.webp',
      'capybearista/arbiter/1.0.0.json',
      'capybearista/arbiter/1.0.0.webp',
      'capybearista/arbiter/1.1.0.json',
      'capybearista/arbiter/1.1.0.webp',
      'capybearista/chronicler/1.0.0.json',
      'capybearista/chronicler/1.0.0.webp',
      'capybearista/chronicler/1.1.0.json',
      'capybearista/chronicler/1.1.0.webp',
      'capybearista/hunter/1.0.0.json',
      'capybearista/hunter/1.0.0.webp',
      'capybearista/hunter/1.1.0.json',
      'capybearista/hunter/1.1.0.webp',
      'capybearista/proctor/1.0.0.json',
      'capybearista/proctor/1.0.0.webp',
      'capybearista/proctor/1.1.0.json',
      'capybearista/proctor/1.1.0.webp',
    ]);

    const v1Index = await readJson('dist/v1/index.json');
    const v2Index = await readJson('dist/v2/index.json');
    const v3Index = await readJson('dist/v3/index.json');
    expect(v1Index.entries).toEqual([]);
    expect(v2Index.entries).toEqual([]);
    expect(v2Index.retirements).toEqual([]);
    expect(v3Index.entries).toHaveLength(11);
    expect(v3Index.retirements).toEqual([]);
    expect(
      (v3Index.entries as Array<{ id: string }>).map((entry) => entry.id),
    ).toEqual([
      'alvin/documenter',
      'alvin/janitor',
      'alvin/paladin',
      'capybearista/arbiter',
      'capybearista/arbiter',
      'capybearista/chronicler',
      'capybearista/chronicler',
      'capybearista/hunter',
      'capybearista/hunter',
      'capybearista/proctor',
      'capybearista/proctor',
    ]);
  });

  test('contains exactly the published catalog entries in every output', async () => {
    const expected = [
      { id: 'alvin/documenter', state: 'active' },
      { id: 'alvin/janitor', state: 'active' },
      { id: 'alvin/paladin', state: 'active' },
      { id: 'capybearista/arbiter', state: 'active' },
      { id: 'capybearista/chronicler', state: 'active' },
      { id: 'capybearista/hunter', state: 'active' },
      { id: 'capybearista/proctor', state: 'active' },
    ];
    for (const path of ['catalog.json', 'dist/v2/catalog.json', 'dist/v3/catalog.json']) {
      expect((await readJson(path)).agents).toEqual(expected);
    }
  });
});
