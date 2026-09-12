import { readFile, writeFile } from 'node:fs/promises';

export const CATALOG_STATES = ['active', 'retired'] as const;

export type CatalogState = (typeof CATALOG_STATES)[number];

export interface RegistryCatalogAgent {
  readonly id: string;
  readonly state: CatalogState;
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
      !CATALOG_STATES.includes(entry.state as CatalogState)
    ) {
      fail(`Invalid registry catalog entry ${position} in ${path}`);
    }
    if (previousId !== undefined && compareIds(previousId, entry.id) >= 0) {
      fail(`Registry catalog entries must be sorted and unique in ${path}`);
    }
    previousId = entry.id;
    agents.push({ id: entry.id, state: entry.state as CatalogState });
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

export async function writeRegistryCatalog(
  path: string,
  catalog: RegistryCatalog,
): Promise<void> {
  await writeFile(path, canonicalizeRegistryCatalog(catalog), 'utf8');
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
    fail('Registry catalog must contain exactly one lifecycle entry per source package ID');
  }
}

export function retiredCatalogIds(catalog: RegistryCatalog): ReadonlySet<string> {
  return new Set(
    catalog.agents
      .filter((agent) => agent.state === 'retired')
      .map((agent) => agent.id),
  );
}

export function setCatalogState(
  catalog: RegistryCatalog,
  id: string,
  state: CatalogState,
): RegistryCatalog {
  let found = false;
  const agents = catalog.agents.map((agent) => {
    if (agent.id !== id) return agent;
    found = true;
    return { ...agent, state };
  });
  if (!found) fail(`Unknown registry catalog package: ${id}`);
  return { schemaVersion: 1, agents };
}
