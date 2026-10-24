export type SessionStorageUsage = {
  totalBytes: number;
  temporaryBytes: number;
  retainedBytes: number;
  busy: boolean;
  partial: boolean;
};

export type SessionScratchCleanupResult = {
  freedBytes: number;
  failedEntries: number;
  usage: SessionStorageUsage;
};
