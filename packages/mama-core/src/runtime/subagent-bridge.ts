import type { HostToolBridge } from './drivers/types.js';

/** What the host is asked for when a native harness identifies a child. */
export interface SubagentBridgeRequest {
  /** The PARENT's session key; a child never owns a session of its own. */
  sessionKey: string;
  parentThreadId: string;
  agentThreadId: string;
  agentPath: string;
}

/**
 * One child's own authority: its tools and the release that closes its run.
 *
 * The native transport chooses the terminal observation: Codex's child event or
 * the enclosing Claude turn's settlement after its socket calls drain. `unknown`
 * means completion was not confirmed and must not be recorded as success.
 */
export interface SubagentBridge {
  bridge: HostToolBridge;
  release: (outcome: {
    status: 'completed' | 'failed' | 'interrupted' | 'unknown';
    error?: string;
  }) => Promise<void>;
}
