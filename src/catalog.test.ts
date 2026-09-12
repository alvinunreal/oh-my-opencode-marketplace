import { describe, expect, test } from 'bun:test';
import {
  parseRegistryCatalog,
  setCatalogState,
  validateCatalogSourceIds,
} from './catalog';

describe('registry catalog', () => {
  test('requires one sorted lifecycle entry for every source package', () => {
    const catalog = parseRegistryCatalog(
      {
        schemaVersion: 1,
        agents: [
          { id: 'alvin/alpha', state: 'active' },
          { id: 'alvin/bravo', state: 'retired' },
        ],
      },
      'catalog.json',
    );

    validateCatalogSourceIds(catalog, ['alvin/bravo', 'alvin/alpha']);
    expect(setCatalogState(catalog, 'alvin/bravo', 'retired').agents).toEqual([
      { id: 'alvin/alpha', state: 'active' },
      { id: 'alvin/bravo', state: 'retired' },
    ]);
    expect(() => validateCatalogSourceIds(catalog, ['alvin/alpha'])).toThrow(
      'exactly one lifecycle entry',
    );
  });
});
