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

  it('starts empty, persists the owner list and reads the file each time', () => {
    const path = phraseFile();
    const setting = createReportPhraseSetting(path);
    expect(setting.get()).toEqual([]);
    setting.set(['full report', 'status report']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      phrases: ['full report', 'status report'],
    });
    // An owner's edit of the file applies at once and is not undone by the next change.
    writeFileSync(path, JSON.stringify({ phrases: ['weekly summary'] }));
    expect(setting.get()).toEqual(['weekly summary']);
  });

  it('refuses a malformed phrase file at startup and on a later read', () => {
    const path = phraseFile();
    writeFileSync(path, JSON.stringify({ phrases: ['full report', ''] }));
    expect(() => createReportPhraseSetting(path)).toThrow('must hold { "phrases"');
    writeFileSync(path, JSON.stringify({ phrases: ['full report'] }));
    const setting = createReportPhraseSetting(path);
    writeFileSync(path, '{');
    expect(() => setting.get()).toThrow();
  });
});

describe('owner.report_phrases.set', () => {
  it('changes the list only in an owner message turn and returns the report steps to apply now', () => {
    const phrasePath = phraseFile();
    const setting = createReportPhraseSetting(phrasePath);
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
      registration.exec({ add: ['Full Report'], remove: ['STATUS  report'] }, ownerTurn)
    ).toMatchObject({ phrases: ['full report'], previous: ['full report', 'status report'] });
    expect(() => registration.exec({ add: [' '] }, ownerTurn)).toThrow(
      expect.objectContaining({ name: 'invalid_input' })
    );
    // A report asked for this time only: the steps, and the list untouched.
    const written = readFileSync(phrasePath, 'utf8');
    expect(registration.exec({}, ownerTurn)).toEqual({
      phrases: ['full report'],
      previous: ['full report'],
      reportSteps: '[owner_full_report] for telegram:1:2',
    });
    expect(readFileSync(phrasePath, 'utf8')).toBe(written);
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
