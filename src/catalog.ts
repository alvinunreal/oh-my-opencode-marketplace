import { readFile } from 'node:fs/promises';

export interface RegistryCatalogAgent {
  readonly id: string;
  readonly state: 'active';
}

export interface RegistryCatalog {
  readonly schemaVersion: 1;
  readonly agents: readonly RegistryCatalogAgent[];
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseRegistryCatalog(value: unknown, path: string): RegistryCatalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.agents)) {
    fail(`Invalid registry catalog ${path}`);
  }

  const agents: RegistryCatalogAgent[] = [];
  let previousId: string | undefined;
  for (const [position, entry] of value.agents.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== 'string' ||
      entry.state !== 'active'
    ) {
      fail(`Invalid registry catalog entry ${position} in ${path}`);
    }
    if (previousId !== undefined && compareIds(previousId, entry.id) >= 0) {
      fail(`Registry catalog entries must be sorted and unique in ${path}`);
    }
    previousId = entry.id;
    agents.push({ id: entry.id, state: 'active' });
  }

  return { schemaVersion: 1, agents };
}

export function canonicalizeRegistryCatalog(catalog: RegistryCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

export async function readRegistryCatalog(path: string): Promise<RegistryCatalog> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Invalid JSON in ${path}: ${detail}`);
  }
  return parseRegistryCatalog(value, path);
}

export function validateCatalogSourceIds(
  catalog: RegistryCatalog,
  sourceIds: Iterable<string>,
): void {
  const expected = [...new Set(sourceIds)].sort(compareIds);
  const actual = catalog.agents.map((agent) => agent.id);
  if (
    expected.length !== actual.length ||
    expected.some((id, index) => id !== actual[index])
  ) {
    fail('Registry catalog must contain exactly one entry per source package ID');
  }
}

export function validateCatalogContainsSourceIds(
  catalog: RegistryCatalog,
  sourceIds: Iterable<string>,
): void {
  const actual = new Set(catalog.agents.map((agent) => agent.id));
  for (const id of new Set(sourceIds)) {
    if (!actual.has(id)) {
      fail(`Registry catalog is missing entry for source package ${id}`);
    }
  }
}
