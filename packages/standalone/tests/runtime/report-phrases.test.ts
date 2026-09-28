import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { composeLayers } from '@jungjaehoon/mama-core/runtime/prompt-layers';
import {
  forceFallbackMode,
  resetTokenEstimator,
} from '@jungjaehoon/mama-core/runtime/token-estimator';
import { ownerReportPhraseActionRegistrations } from '../../src/api/owner-report-phrase-actions.js';
import { ownerSystemLayers } from '../../src/runtime/native-session.js';
import { asksForFullReport, createReportPhraseSetting } from '../../src/runtime/report-phrases.js';

const homes: string[] = [];
function phraseFile(): string {
  const home = mkdtempSync(join(tmpdir(), 'report-phrases-'));
  homes.push(home);
  return join(home, 'full-report-phrases.json');
}
afterEach(() => {
  resetTokenEstimator();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('owner report phrases', () => {
  it('matches a registered phrase anywhere in the message, ignoring spaces and case', () => {
    expect(asksForFullReport('Please send the Full  Report now', ['full report'])).toBe(true);
    expect(asksForFullReport('please send the fullreport', ['full report'])).toBe(true);
    expect(asksForFullReport('what changed today?', ['full report'])).toBe(false);
    expect(asksForFullReport('full report', [])).toBe(false);
  });

  it('starts empty, persists the owner list and reads it back after a restart', () => {
    const path = phraseFile();
    const setting = createReportPhraseSetting(path);
    expect(setting.get()).toEqual([]);
    setting.set(['full report', 'status report']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      phrases: ['full report', 'status report'],
    });
    expect(createReportPhraseSetting(path).get()).toEqual(['full report', 'status report']);
  });

  it('refuses a malformed phrase file at startup', () => {
    const path = phraseFile();
    writeFileSync(path, JSON.stringify({ phrases: ['full report', ''] }));
    expect(() => createReportPhraseSetting(path)).toThrow('must hold { "phrases"');
  });
});

describe('owner.report_phrases.set', () => {
  it('changes the list only in an owner message turn and returns the report steps to apply now', () => {
    const setting = createReportPhraseSetting(phraseFile());
    const registration = ownerReportPhraseActionRegistrations({
      ownerPrincipalId: 'owner',
      setting,
      isOwnerMessageTurn: (ref) => ref === 'telegram:1:2',
      fullReportTurn: (ref) => `[owner_full_report] for ${ref}`,
    })[0]!;
    const owner = { principalId: 'owner', agentId: 'agent', scopes: [] };
    for (const context of [
      { access: owner },
      { access: owner, session: { sourceMessageRef: 'source_delta:1' } },
      { access: owner, session: { sourceMessageRef: 'telegram:1:2', replaySourceEndMs: 1 } },
      { access: { ...owner, principalId: 'other' }, session: { sourceMessageRef: 'telegram:1:2' } },
    ])
      expect(() => registration.exec({ add: ['full report'] }, context)).toThrow(
        expect.objectContaining({ name: 'denied' })
      );
    expect(setting.get()).toEqual([]);

    const ownerTurn = { access: owner, session: { sourceMessageRef: 'telegram:1:2' } };
    expect(registration.exec({ add: ['full report', 'status report'] }, ownerTurn)).toEqual({
      phrases: ['full report', 'status report'],
      previous: [],
      reportSteps: '[owner_full_report] for telegram:1:2',
    });
    expect(
      registration.exec({ add: ['full report'], remove: ['status report'] }, ownerTurn)
    ).toMatchObject({ phrases: ['full report'], previous: ['full report', 'status report'] });
    expect(() => registration.exec({ add: [' '] }, ownerTurn)).toThrow(
      expect.objectContaining({ name: 'invalid_input' })
    );
  });
});

describe('owner session system prompt', () => {
  it('keeps the whole owner policy even when the prompt is counted over budget', () => {
    // The byte estimate the tokenizer falls back to counted this prompt at nearly twice its size
    // and cut the owner policy to its first lines.
    forceFallbackMode();
    const standing = `## Owner runtime\n${'- standing rule line for the owner agent\n'.repeat(400)}`;
    // Three-byte characters, as the owner's Korean policy is written.
    const policy = `# Owner policy\n${'- \uC624\uB108 \uADDC\uCE59 line\n'.repeat(160)}- last policy line`;
    const composed = composeLayers(ownerSystemLayers(standing, policy));
    expect(composed).toContain('- last policy line');
    expect(composed).not.toContain('truncated');
  });
});
