export const app = {
  getAppPath: () => process.cwd(),
  getVersion: () => "0.16.0",
  isPackaged: false,
};

export const shell = { openExternal: async () => undefined };
