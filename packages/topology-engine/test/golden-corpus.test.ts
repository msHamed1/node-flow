import { describe, expect, it } from 'vitest';
import { TopologyEngine } from '../src/index.js';
import { canonicalizeTopology, normalizeCanonicalTopology } from './canonical-topology.js';
import { goldenFixtures } from './golden-fixtures.js';

describe('golden topology compatibility corpus', () => {
  for (const fixture of goldenFixtures()) {
    it(`${fixture.name} [${fixture.covers.join(', ')}]`, () => {
      const engine = new TopologyEngine({ nodeVersion: 'v22.0.0' });
      for (const batch of fixture.batches) {
        engine.registerApplication(batch.serviceName, batch.nodeVersion ?? 'v22.0.0');
        engine.ingest(batch.spans);
      }
      expect(canonicalizeTopology(engine.createSnapshot())).toEqual(
        normalizeCanonicalTopology(fixture.expected),
      );
    });
  }
});
