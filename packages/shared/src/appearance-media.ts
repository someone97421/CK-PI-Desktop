export const APPEARANCE_MEDIA_SCHEME = "appearance-media";

export const APPEARANCE_MEDIA_KINDS = ["icon", "home"] as const;
export type AppearanceMediaKind = (typeof APPEARANCE_MEDIA_KINDS)[number];

export type AppearanceMediaMimeType =
  | "image/png"
  | "image/gif"
  | "image/webp"
  | "video/mp4"
  | "video/webm";

export type AppearanceMediaAsset = {
  kind: AppearanceMediaKind;
  mimeType: AppearanceMediaMimeType;
  url: string;
  originalName: string;
};

export type AppearanceMediaState = Record<AppearanceMediaKind, AppearanceMediaAsset | null>;

export type AppearanceMediaSelectionResult = {
  canceled?: boolean;
  state: AppearanceMediaState;
};

/** Portable media payload embedded in a configuration export. */
export type AppearanceMediaExportAsset = {
  mimeType: AppearanceMediaMimeType;
  originalName: string;
  dataBase64: string;
};

export type AppearanceMediaExport = Partial<
  Record<AppearanceMediaKind, AppearanceMediaExportAsset | null>
>;
