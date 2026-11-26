const disabledSessions = new Set<string>();

export function sessionSubagentsEnabled(sessionId: string): boolean {
  return !disabledSessions.has(sessionId);
}

export function setSessionSubagentsEnabled(sessionId: string, enabled: boolean): void {
  if (enabled) disabledSessions.delete(sessionId);
  else disabledSessions.add(sessionId);
}
