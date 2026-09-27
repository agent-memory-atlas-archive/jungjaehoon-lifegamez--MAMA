/** Durable messenger turn facts and crash recovery; this module never runs a model. */
import { randomUUID } from 'node:crypto';
import type { SessionStore } from './session-store.js';
import type { NormalizedMessage } from './types.js';
function agentIdForPrincipalClass(principalClass: 'owner' | undefined): string {
  return principalClass === 'owner' ? 'mama-owner' : 'unsigned-local';
}
import type { NativeTurnResultRecord } from '@jungjaehoon/mama-core/runtime/native-input-journal';
import type { CompletedTurn, SharedReplyTurn } from './turn-contract.js';

export interface InlineObservationInput {
  source: string;
  sourceId: string;
  body: string;
  author: string | null;
  observedAt: number;
  metadata: Record<string, unknown>;
  scope: Record<string, unknown>;
}

export interface ConversationObservationPorts {
  recordInlineObservation?: (input: InlineObservationInput) => string;
  readInlineObservationByIdentity?: (input: {
    source: string;
    sourceId: string;
    producerVersionId: string;
  }) => { observationRef: string; body: string } | null;
}

export type ConversationRecord =
  | { resolved: CompletedTurn | SharedReplyTurn }
  | {
      resolved: null;
      sourceObservationRef?: string;
      appendInput(content: string): void;
      stageResponse(body: string): void;
      abandon(): void;
      commitResult(body: string): void;
      commitShared(replySourceMessageRef: string): void;
    };

export function sourceMessageIdentity(message: NormalizedMessage): {
  sourceTurnId: string;
  sourceMessageRef: string;
} {
  const sourceTurnId = message.metadata?.messageId ?? `generated:${randomUUID().replace(/-/g, '')}`;
  return {
    sourceTurnId,
    sourceMessageRef: [message.source, message.channelId, sourceTurnId].filter(Boolean).join(':'),
  };
}

export function openConversationRecord(input: {
  sessionStore: SessionStore;
  sessionId: string;
  message: NormalizedMessage;
  sourceTurnId: string;
  sourceMessageRef: string;
  ownerConsole: boolean;
  recoveryOnly: boolean;
  recoveredNativeResult?: NativeTurnResultRecord;
  startedAt: number;
  observations: ConversationObservationPorts;
}): ConversationRecord {
  const {
    sessionStore,
    sessionId,
    message,
    sourceTurnId,
    sourceMessageRef,
    ownerConsole,
    recoveryOnly,
    recoveredNativeResult,
    startedAt,
    observations,
  } = input;
  const existing = sessionStore.findTurnBySourceMessageRef(sessionId, sourceMessageRef);
  const scope = {
    visibility: 'owner',
    agentId: agentIdForPrincipalClass(message.principal?.class),
    channel: message.channelId,
    principalId: message.principal?.principalId ?? null,
  };
  const inputObservation = (): InlineObservationInput => ({
    source: `owner-message:${message.source}`,
    sourceId: sourceMessageRef,
    body: message.text,
    author: message.userId,
    observedAt: Date.now(),
    metadata: { messageId: sourceTurnId },
    scope,
  });
  const resultObservation = (body: string): InlineObservationInput => ({
    source: `owner-result:${message.source}`,
    sourceId: `${sourceMessageRef}:result`,
    body,
    author: 'mama',
    observedAt: Date.now(),
    metadata: { sourceMessageRef },
    scope,
  });
  const recordResult = (body: string): string | undefined =>
    ownerConsole ? observations.recordInlineObservation?.(resultObservation(body)) : undefined;
  const validateStoredObservation = (storedRef: string, observation: InlineObservationInput) => {
    if (!observations.recordInlineObservation) {
      throw new Error('Stored owner observation cannot be revalidated');
    }
    let returnedRef: string;
    try {
      returnedRef = observations.recordInlineObservation(observation);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.startsWith('Observation replay conflict for ')) {
        throw new Error('Owner message replay conflicts with persisted immutable input', {
          cause: error,
        });
      }
      throw new Error('Owner observation replay validation failed', { cause: error });
    }
    if (returnedRef !== storedRef) {
      throw new Error('Owner message replay conflicts with persisted immutable input');
    }
  };
  const sharedTarget =
    recoveredNativeResult &&
    recoveredNativeResult.primaryStimulusId !== sourceMessageRef &&
    (recoveredNativeResult.primaryKind === 'owner_message' ||
      (existing?.state === 'shared' &&
        existing.sharedReplyRef === recoveredNativeResult.primaryStimulusId))
      ? recoveredNativeResult.primaryStimulusId
      : null;
  const shared = (replySourceMessageRef: string): SharedReplyTurn => ({
    outcome: 'shared_reply',
    response: '',
    sessionId,
    duration: Date.now() - startedAt,
    sourceTurnId,
    sourceMessageRef,
    replySourceMessageRef,
  });
  const completed = (response: string): CompletedTurn => {
    if (sharedTarget || (recoveredNativeResult && response !== recoveredNativeResult.response)) {
      throw new Error('Committed owner response conflicts with native turn result');
    }
    return {
      outcome: 'completed',
      response,
      sessionId,
      duration: Date.now() - startedAt,
      provenance: recoveredNativeResult?.modelRunId
        ? { status: 'available', modelRunId: recoveredNativeResult.modelRunId }
        : {
            status: 'unavailable',
            reason:
              recoveredNativeResult?.modelRunProvenance === 'commit_failed'
                ? 'commit_failed'
                : 'backend_no_run',
          },
      sourceTurnId,
      sourceMessageRef,
    };
  };

  if (existing?.state === 'shared') {
    if (
      !existing.sharedReplyRef ||
      (sharedTarget && existing.sharedReplyRef !== sharedTarget) ||
      (recoveredNativeResult && !sharedTarget)
    ) {
      throw new Error('Shared owner response conflicts with native turn result');
    }
    if (existing.sourceObservationRef) {
      validateStoredObservation(existing.sourceObservationRef, inputObservation());
    }
    return { resolved: shared(existing.sharedReplyRef) };
  }
  if (existing?.state === 'final') {
    if (sharedTarget) throw new Error('Final owner response conflicts with shared native turn');
    if (existing.sourceObservationRef) {
      validateStoredObservation(existing.sourceObservationRef, inputObservation());
    }
    if (existing.resultObservationRef) {
      validateStoredObservation(existing.resultObservationRef, resultObservation(existing.bot));
    }
    return { resolved: completed(existing.bot) };
  }

  const sourceObservationRef =
    existing?.sourceObservationRef ??
    (ownerConsole ? observations.recordInlineObservation?.(inputObservation()) : undefined);
  const recoveredResult =
    !existing?.resultObservationRef && ownerConsole
      ? observations.readInlineObservationByIdentity?.({
          source: `owner-result:${message.source}`,
          sourceId: `${sourceMessageRef}:result`,
          producerVersionId: `${sourceMessageRef}:result`,
        })
      : null;
  if (recoveredResult) {
    validateStoredObservation(sourceObservationRef!, inputObservation());
    validateStoredObservation(
      recoveredResult.observationRef,
      resultObservation(recoveredResult.body)
    );
    if (
      existing &&
      (!sessionStore.flushStreamingResponse(
        sessionId,
        recoveredResult.body,
        recoveredResult.observationRef,
        sourceMessageRef
      ) ||
        !sessionStore.finalizeTurn(
          sessionId,
          sourceMessageRef,
          recoveredResult.body,
          recoveredResult.observationRef
        ))
    ) {
      throw new Error('Unable to recover committed result observation');
    }
    return { resolved: completed(recoveredResult.body) };
  }
  if (existing?.resultObservationRef && existing.bot.trim().length > 0 && ownerConsole) {
    validateStoredObservation(existing.sourceObservationRef!, inputObservation());
    validateStoredObservation(existing.resultObservationRef, resultObservation(existing.bot));
    if (
      !sessionStore.finalizeTurn(
        sessionId,
        sourceMessageRef,
        existing.bot,
        existing.resultObservationRef
      )
    ) {
      throw new Error('Unable to recover final assistant response');
    }
    return { resolved: completed(existing.bot) };
  }
  if (recoveryOnly) {
    if (
      recoveredNativeResult &&
      (recoveredNativeResult.primaryKind === null ||
        recoveredNativeResult.primaryKind === undefined)
    ) {
      throw new Error(
        'Native result primary kind is unknown; reply ownership requires reconciliation'
      );
    }
    if (sharedTarget) {
      if (!ownerConsole || !existing || !sourceObservationRef) {
        throw new Error('Shared native input has no recoverable owner record');
      }
      validateStoredObservation(sourceObservationRef, inputObservation());
      if (!sessionStore.finalizeSharedTurn(sessionId, sourceMessageRef, sharedTarget)) {
        throw new Error('Unable to recover shared native reply');
      }
      return { resolved: shared(sharedTarget) };
    }
    if (recoveredNativeResult) {
      if (!ownerConsole || !existing || !sourceObservationRef) {
        throw new Error('Native result has no recoverable owner input record');
      }
      validateStoredObservation(sourceObservationRef, inputObservation());
      const response = recoveredNativeResult.response;
      const resultObservationRef = recordResult(response);
      if (
        !resultObservationRef ||
        !sessionStore.flushStreamingResponse(
          sessionId,
          response,
          resultObservationRef,
          sourceMessageRef
        ) ||
        !sessionStore.finalizeTurn(sessionId, sourceMessageRef, response, resultObservationRef)
      ) {
        throw new Error('Unable to recover accepted native result');
      }
      return { resolved: completed(response) };
    }
    throw new Error('Native input outcome is unresolved; no committed response was found');
  }
  const stageResponse = (body: string, resultObservationRef?: string): void => {
    if (
      !sessionStore.flushStreamingResponse(sessionId, body, resultObservationRef, sourceMessageRef)
    ) {
      throw new Error('Unable to stage assistant response');
    }
  };
  return {
    resolved: null,
    sourceObservationRef,
    appendInput(content) {
      if (
        !sessionStore.appendMessage(
          sessionId,
          { role: 'user', content, timestamp: Date.now() },
          { sourceMessageRef, sourceObservationRef }
        )
      ) {
        throw new Error('Unable to persist user message');
      }
    },
    stageResponse,
    abandon() {
      if (!sessionStore.discardIncompleteTurn(sessionId, sourceMessageRef)) {
        throw new Error('Unable to discard failed source message');
      }
    },
    commitResult(body) {
      const resultObservationRef = recordResult(body);
      stageResponse(body, resultObservationRef);
      if (!sessionStore.finalizeTurn(sessionId, sourceMessageRef, body, resultObservationRef)) {
        throw new Error('Unable to persist final assistant response');
      }
    },
    commitShared(replySourceMessageRef) {
      if (!ownerConsole || !sourceObservationRef) {
        throw new Error('Shared native reply requires an owner observation');
      }
      if (!sessionStore.finalizeSharedTurn(sessionId, sourceMessageRef, replySourceMessageRef)) {
        throw new Error('Unable to persist shared native reply');
      }
    },
  };
}
