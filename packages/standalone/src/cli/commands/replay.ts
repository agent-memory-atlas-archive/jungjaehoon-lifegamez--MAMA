import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { bootDaemon, type DaemonBootOptions, type DaemonReplayContext } from './daemon.js';
import { setLiveConnectorPollCursors } from '../../runtime/connectors.js';
import { createOwnerPolicyProvider } from '../../runtime/owner-policy.js';
import { readImportManifest } from '../../replay/import-manifest.js';
import { ReplayFeeder, type ReplayFeederResult } from '../../replay/replay-feeder.js';
import { createReplaySourceCatalog } from '../../replay/replay-source-catalog.js';

export interface ReplayCommandOptions {
  daemon?: Omit<DaemonBootOptions, 'mode' | 'replay'>;
  manifestPath?: string;
  cursorPath?: string;
  ledgerPath?: string;
  runId?: string;
}

function requireMailbox(context: DaemonReplayContext) {
  const mailbox = context.owner.runtime.mailbox;
  if (!mailbox) throw new Error('Replay owner runtime did not open its mailbox');
  return mailbox;
}

/** Run the owner-only replay and fence the unchanged live connector set at T. */
export async function runReplay(options: ReplayCommandOptions = {}): Promise<ReplayFeederResult> {
  let result: ReplayFeederResult | undefined;
  const daemon = await bootDaemon({
    ...(options.daemon ?? {}),
    mode: 'replay',
    replay: async (context) => {
      const manifestPath =
        options.manifestPath ?? join(context.paths.runtimeRoot, 'september-import-manifest.json');
      const cursorPath =
        options.cursorPath ?? join(context.paths.runtimeRoot, 'september-replay-cursor.json');
      const ledgerPath =
        options.ledgerPath ?? join(context.paths.runtimeRoot, 'september-replay-ledger.jsonl');
      const manifest = readImportManifest(manifestPath);
      const catalog = createReplaySourceCatalog(
        context.owner.database.adapter,
        manifest.fromMs,
        manifest.untilMs,
        { rawRoot: context.paths.connectorsRoot }
      );
      const feeder = new ReplayFeeder({
        catalog,
        intake: context.owner.intake,
        mailbox: requireMailbox(context),
        principalId: 'owner',
        runId: options.runId ?? randomUUID(),
        policyFingerprint: createOwnerPolicyProvider(context.paths.mamaRoot)().fingerprint,
        fromMs: manifest.fromMs,
        untilMs: manifest.untilMs,
        cursorPath,
        ledgerPath,
        setReplaySourceEndMs: context.owner.setReplaySourceEndMs,
      });
      const preflight = feeder.preflight();
      context.logger.info(
        `replay preflight windows=${String(preflight.windows.length)} deltas=${String(preflight.deltas.length)}`
      );
      result = await feeder.run();
      if (result.nextWindowStartMs !== manifest.untilMs) {
        throw new Error('Replay feeder stopped before the import fence');
      }
      setLiveConnectorPollCursors({
        configPath: context.paths.connectorsConfigPath,
        statePath: context.paths.connectorsRoot,
        fenceMs: manifest.untilMs,
      });
      context.logger.info(
        `replay complete windows=${String(result.windows)} deltas=${String(result.deltas)} settled=${String(result.settled)} fence=${new Date(manifest.untilMs).toISOString()}`
      );
    },
  });
  await daemon.stop();
  if (!result) throw new Error('Replay feeder returned no result');
  return result;
}
