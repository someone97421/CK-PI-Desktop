/** 本地媒体只以内容哈希寻址，不允许引用任意绝对路径。 */
export type MediaReference = {
  ref: string;
  mimeType: string;
  size: number;
};

export type MediaReferenceBlock = {
  type: "text";
  text: string;
  mediaRef: MediaReference;
};

export function isMediaReference(value: unknown): value is MediaReference {
  if (!value || typeof value !== "object") return false;
  const ref = value as MediaReference;
  return typeof ref.ref === "string" && /^attachments\/[a-f0-9]{64}$/.test(ref.ref) &&
    typeof ref.mimeType === "string" && /^(image|audio|video)\/[a-z0-9.+-]+$/i.test(ref.mimeType) &&
    Number.isSafeInteger(ref.size) && ref.size >= 0;
}

export function mediaReferenceOf(value: unknown): MediaReference | undefined {
  if (!value || typeof value !== "object") return undefined;
  const ref = (value as { mediaRef?: unknown }).mediaRef;
  return isMediaReference(ref) ? ref : undefined;
}

export function mediaReferenceBlock(mediaRef: MediaReference): MediaReferenceBlock {
  return { type: "text", text: `[媒体 ${mediaRef.mimeType}，${mediaRef.size} 字节，${mediaRef.ref}]`, mediaRef };
}
