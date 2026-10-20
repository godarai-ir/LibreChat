import { ErrorTypes } from 'librechat-data-provider';
import type { SafeErrorMetadata } from '../../utils/errors';
import type { ModelErrorTrackerCallback } from './tracker';
import {
  resolveLangChainError,
  getModelStreamFailure,
  resolveModelStreamError,
  getProviderErrorMessage,
} from '../errors';
import { getSafeErrorMetadata, isOwnedAbortError } from '../../utils/errors';
import { traceIdForMessage } from '../../langfuse/trace';
import { createModelErrorTracker } from './tracker';

const UPSTREAM_MODEL_ERROR_CODE = 'UPSTREAM_MODEL_ERROR';
const UPSTREAM_MODEL_ERROR_ORIGIN = 'model_provider';
const UNKNOWN_UPSTREAM_MODEL_ERROR_TYPE = '_OTHER';
const UPSTREAM_MODEL_ERROR_FALLBACK = 'The model provider could not complete this request.';

function safelyResolveLangChainError(error: unknown): string | undefined {
  try {
    return resolveLangChainError(error);
  } catch {
    return undefined;
  }
}

export interface UpstreamModelErrorMetadata extends SafeErrorMetadata {
  readonly errorCode: typeof UPSTREAM_MODEL_ERROR_CODE;
  readonly errorOrigin: typeof UPSTREAM_MODEL_ERROR_ORIGIN;
  readonly errorType: string;
  readonly traceId?: string;
}

export interface TerminalRunErrorLogger {
  error(message: string, metadata: SafeErrorMetadata | UpstreamModelErrorMetadata): void;
}

export interface TerminalRunErrorObserver {
  readonly modelCallback: ModelErrorTrackerCallback;
  readonly log: (error: unknown, signal?: AbortSignal) => void;
  readonly getUserFacingError: (error: unknown, fallback: () => string) => string;
}

/** A run cancellation requires host-owned abort state plus its own reason or an abort shape. */
export function isAgentRunCancellation(error: unknown, signal?: AbortSignal): boolean {
  return isOwnedAbortError(error, signal);
}

/** Preserve rejection status; a successful status can still precede a broken response body. */
function getUpstreamErrorType(error: unknown, status?: number): string {
  if (status != null && status >= 400) {
    return String(status);
  }
  const streamFailure = getModelStreamFailure(error);
  if (streamFailure != null) {
    return `stream_${streamFailure}`;
  }
  return status == null ? UNKNOWN_UPSTREAM_MODEL_ERROR_TYPE : String(status);
}

export function getUpstreamModelErrorMetadata(
  error: unknown,
  responseMessageId?: string,
): UpstreamModelErrorMetadata {
  const safeMetadata = getSafeErrorMetadata(error);
  return {
    ...safeMetadata,
    errorCode: UPSTREAM_MODEL_ERROR_CODE,
    errorOrigin: UPSTREAM_MODEL_ERROR_ORIGIN,
    errorType: getUpstreamErrorType(error, safeMetadata.status),
    ...(typeof responseMessageId === 'string' && responseMessageId !== ''
      ? { traceId: traceIdForMessage(responseMessageId) }
      : {}),
  };
}

function readStringProperty(value: unknown, property: string): string | undefined {
  if (value == null || typeof value !== 'object') {
    return undefined;
  }
  try {
    const read = Reflect.get(value, property);
    return typeof read === 'string' ? read : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The provider's own failure code when the deployment lists it. OpenAI-compatible clients surface
 * the body's `code`/`type` on the error and keep the body under `error`; both are read, so a
 * gateway refusal (for example a 402 naming why) reaches the UI as a stable identifier.
 */
function getAllowedProviderErrorCode(
  error: unknown,
  allowed: ReadonlySet<string>,
): string | undefined {
  if (allowed.size === 0) {
    return undefined;
  }
  let body: unknown;
  try {
    body = error != null && typeof error === 'object' ? Reflect.get(error, 'error') : undefined;
  } catch {
    body = undefined;
  }
  for (const candidate of [error, body]) {
    for (const property of ['code', 'type']) {
      const value = readStringProperty(candidate, property);
      if (value != null && allowed.has(value)) {
        return value;
      }
    }
  }
  return undefined;
}

/** Applies one terminal-run log taxonomy to every agent ingress. */
export function createTerminalRunErrorObserver({
  logger,
  responseMessageId,
  source,
  protectionEnabled,
  maxProviderErrorChars,
  providerErrorCodes,
  genericMessage = `${source} Error:`,
}: {
  logger: TerminalRunErrorLogger;
  responseMessageId?: string;
  source: string;
  /**
   * Whether a content policy inspects this deployment's traffic. A provider error body may echo
   * submitted content, so its text stays out of the failure a reader sees while one is active —
   * the same condition every other user-facing failure text is decided by. Omission fails closed
   * for JavaScript callers and older integrations.
   */
  protectionEnabled?: boolean;
  maxProviderErrorChars?: number;
  /**
   * Provider error codes the UI may be told about (`endpoints.agents.providerErrorCodes`). A listed
   * code is an identifier the deployment chose to expose, not submitted content, so it is forwarded
   * whether or not content protection withholds the provider's text.
   */
  providerErrorCodes?: readonly string[];
  genericMessage?: string;
}): TerminalRunErrorObserver {
  const modelErrorTracker = createModelErrorTracker();
  const allowedProviderErrorCodes = new Set(providerErrorCodes ?? []);
  return Object.freeze({
    modelCallback: modelErrorTracker.callback,
    getUserFacingError(error: unknown, fallback: () => string) {
      const upstreamModelError = modelErrorTracker.getUpstreamModelError(error);
      if (upstreamModelError == null) {
        return fallback();
      }

      const { status } = getSafeErrorMetadata(upstreamModelError);
      const classifiedError =
        safelyResolveLangChainError(error) ??
        safelyResolveLangChainError(upstreamModelError) ??
        (status == null || status < 400
          ? (resolveModelStreamError(upstreamModelError) ?? resolveModelStreamError(error))
          : undefined);
      if (classifiedError != null) {
        return classifiedError;
      }

      /** Unclassified: the provider's own explanation is the only account of what happened, and a
       *  rejection from a gateway or proxy carries it as the whole point of the 400. The status
       *  headlines it either way, so a deployment withholding provider text loses no taxonomy. */
      const providerMessage =
        protectionEnabled !== false
          ? undefined
          : (getProviderErrorMessage(upstreamModelError, maxProviderErrorChars) ??
            getProviderErrorMessage(error, maxProviderErrorChars));
      const code =
        getAllowedProviderErrorCode(upstreamModelError, allowedProviderErrorCodes) ??
        getAllowedProviderErrorCode(error, allowedProviderErrorCodes);
      return `${UPSTREAM_MODEL_ERROR_FALLBACK}\n${JSON.stringify({
        type: ErrorTypes.UPSTREAM_MODEL_ERROR,
        ...(code != null ? { code } : {}),
        ...(status != null ? { status } : {}),
        ...(providerMessage != null ? { message: providerMessage } : {}),
      })}`;
    },
    log(error: unknown, signal?: AbortSignal) {
      if (isAgentRunCancellation(error, signal)) {
        return;
      }

      const upstreamModelError = modelErrorTracker.getUpstreamModelError(error);
      if (upstreamModelError == null) {
        logger.error(genericMessage, getSafeErrorMetadata(error));
        return;
      }

      logger.error(
        `${source} Upstream model error`,
        getUpstreamModelErrorMetadata(upstreamModelError, responseMessageId),
      );
    },
  });
}
