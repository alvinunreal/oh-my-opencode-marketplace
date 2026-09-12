import { describe, expect, test } from 'bun:test';
import {
  parseRegistryCatalog,
  validateCatalogSourceIds,
} from './catalog';

describe('registry catalog', () => {
  test('requires one sorted active entry for every source package', () => {
    const catalog = parseRegistryCatalog(
      {
        schemaVersion: 1,
        agents: [
          { id: 'alvin/alpha', state: 'active' },
          { id: 'alvin/bravo', state: 'active' },
        ],
      },
      'catalog.json',
    );

    validateCatalogSourceIds(catalog, ['alvin/bravo', 'alvin/alpha']);
    expect(() => validateCatalogSourceIds(catalog, ['alvin/alpha'])).toThrow(
      'exactly one entry',
    );
    expect(() =>
      parseRegistryCatalog(
        {
          schemaVersion: 1,
          agents: [{ id: 'alvin/bravo', state: 'inactive' }],
        },
        'catalog.json',
      ),
    ).toThrow('Invalid registry catalog entry');
  });
});
