/**
 * Session links (`pi-desktop://session/<id>`): the one way a conversation is
 * referenced from another one.
 *
 * The link is plain text the user pastes into a Composer draft (or copies from
 * the session row), so referencing a conversation adds no new Composer trigger
 * symbol: `@` stays files and `/` stays commands (see `composer-trigger.ts`).
 * Electron main turns the tokens it finds in a prompt into bounded session
 * references before the turn is dispatched; the renderer only formats and
 * recognizes them.
 */

/** Custom scheme reserved for PI-Desktop links (deep link registration is A). */
export const SESSION_LINK_SCHEME = "pi-desktop";
/** Path segment that marks a session link. */
export const SESSION_LINK_HOST = "session";
/** References one message may carry; the rest stay plain text in the draft. */
export const MAX_SESSION_LINKS_PER_MESSAGE = 4;
/** Session ids are UUIDs; remote ids use `remote:` and never match. */
const SESSION_LINK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * The id must end the token: a trailing `:` or `/` means this is a remote id
 * (`remote:…`) or a deeper path, so nothing is referenced at all.
 */
const SESSION_LINK_PATTERN =
  /pi-desktop:\/\/session\/([A-Za-z0-9_-]{1,64})(?![A-Za-z0-9_:/-])/g;

/** The link a session row copies and a Composer draft accepts. */
export function formatSessionLink(sessionId: string): string {
  return `${SESSION_LINK_SCHEME}://${SESSION_LINK_HOST}/${sessionId}`;
}

/**
 * Every distinct session a draft references, in first-mention order. A trailing
 * `)` or `.` a sentence added is not part of the id: the id character class
 * already stops at those.
 */
export function parseSessionLinks(text: string): string[] {
  if (!text?.includes(`${SESSION_LINK_SCHEME}://`)) return [];
  const found: string[] = [];
  for (const match of text.matchAll(SESSION_LINK_PATTERN)) {
    const id = match[1];
    if (!SESSION_LINK_ID.test(id)) continue;
    if (found.includes(id)) continue;
    found.push(id);
    if (found.length >= MAX_SESSION_LINKS_PER_MESSAGE) break;
  }
  return found;
}

/** Whether one token is a session link, used by renderer mention parsing. */
export function isSessionLinkToken(token: string): boolean {
  return parseSessionLinks(token).length > 0;
}
