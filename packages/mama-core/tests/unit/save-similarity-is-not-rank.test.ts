/**
 * A save's related decisions carry rank, and must not call it similarity.
 *
 * The retrieval score is normalized Reciprocal Rank Fusion with RRF_K = 60,
 * divided by the top hit. That makes the second result 61/62 = 0.9839 and the
 * third 61/63 = 0.9683 whatever they contain -- the numbers describe position,
 * not likeness. While they were mirrored into `similarity`, every save with a
 * second result warned "High similarity (98%)" against something unrelated,
 * which teaches the reader to ignore the duplicate check entirely.
 */
import { describe, expect, it } from 'vitest';

import { initTestDB, cleanupTestDB } from '../helpers/test-utils.js';

const RRF_K = 60;

describe('the number a save reports about related decisions', () => {
  it('is rank-shaped, which is why it cannot be read as likeness', () => {
    // What normalized RRF produces for the top three, by construction.
    const normalized = [1, 2, 3].map((rank) => 1 / (RRF_K + rank) / (1 / (RRF_K + 1)));
    expect(normalized[0]).toBe(1);
    expect(normalized[1]).toBeCloseTo(0.9838709677419353, 15);
    expect(normalized[2]).toBeCloseTo(0.968253968253968, 15);
    // Unrelated content ranked second still scores 0.98. That is the defect the
    // field name invited, and the reason similarity is now reported as absent.
  });

  it('reports related decisions without a similarity, and with the rank score named as one', async () => {
    const api = (await import('../../src/mama-api.js')).default;
    const path = await initTestDB('save-similarity-is-not-rank');
    try {
      await api.save({
        type: 'user_decision',
        topic: 'first_unrelated_topic',
        decision: 'the weather turned cold',
        reasoning: 'nothing to do with the next one',
      });
      const second = (await api.save({
        type: 'user_decision',
        topic: 'second_unrelated_topic',
        decision: 'the build pipeline moved to a new runner',
        reasoning: 'also nothing to do with the first',
      })) as {
        similar_decisions?: { similarity: number | null; retrieval_score: number | null }[];
        warning?: string;
      };

      for (const related of second.similar_decisions ?? []) {
        expect(related.similarity).toBeNull();
      }
      // And no save claims a percentage it did not measure.
      expect(second.warning).toBeUndefined();
    } finally {
      await cleanupTestDB(path);
    }
  });
});
