import { createContext, useContext } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';

/**
 * Everything the message list reads from the app: viewer preferences, and render slots for the
 * pieces of a row that have not moved into this package yet. Members are hooks or slots, called
 * unconditionally, and a host stays the same object for the life of the tree it wraps.
 *
 * It is an interface so an app can declare members of rows it has not handed to this package
 * yet, by augmenting `@librechat/chat/react`.
 */
export interface MessagesHost {
  /** The viewer's clock preference as `hour12`; `undefined` follows the locale's convention. */
  useHour12: () => boolean | undefined;
  /** The locale dates are written in, calendar included (e.g. `fa-IR-u-ca-persian`);
   *  `undefined` follows the interface language. */
  useDateLocale: () => string | undefined;
  /** Maps a raw model id to the label the model picker shows; unknown ids come back unchanged. */
  useModelLabel: () => (model?: string | null) => string | undefined;
  /** Renders the files attached to a user message, above its text. */
  renderFiles: (message: TMessage) => ReactNode;
}

const identityLabel = (model?: string | null): string | undefined => model ?? undefined;

/** The host rows read outside any provider before an app registers one: locale clock, no slots. */
const fallbackHost: MessagesHost = {
  useHour12: () => undefined,
  useDateLocale: () => undefined,
  useModelLabel: () => identityLabel,
  renderFiles: () => null,
};

const MessagesHostContext = createContext<MessagesHost | null>(null);

let defaultHost: MessagesHost = fallbackHost;

/**
 * Registers the host that rows rendered outside any `MessagesHostProvider` read. An app registers
 * its own once, when the module that builds it loads; a provider always wins over it.
 */
export function setDefaultMessagesHost(host: MessagesHost): void {
  defaultHost = host;
}

/** Supplies the host the message list reads from. */
export function MessagesHostProvider({
  host,
  children,
}: {
  host: MessagesHost;
  children: ReactNode;
}): ReactNode {
  return <MessagesHostContext.Provider value={host}>{children}</MessagesHostContext.Provider>;
}

/** The host of the nearest provider, else the registered default, else the fallback. */
export function useMessagesHost(): MessagesHost {
  return useContext(MessagesHostContext) ?? defaultHost;
}
