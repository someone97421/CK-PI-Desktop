/** Runtime discovery only. Settings continue to persist a numeric CSS weight. */
export type FontWeightRange = { min: number; max: number; default: number };
export type FontFaceMetadata = {
  name: string;
  weight: number;
  style: "normal" | "italic";
  width: number;
  variable: boolean;
  wght?: FontWeightRange;
};
export type FontMetadata = {
  family: string;
  source: "bundled" | "system" | "generic";
  status: "known" | "unavailable";
  faces: FontFaceMetadata[];
};
