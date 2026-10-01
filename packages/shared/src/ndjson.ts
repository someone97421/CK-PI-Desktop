/** The readable-stream surface needed by the stdio transport (no Node imports). */
interface NdjsonInput {
  setEncoding(encoding: "utf8"): unknown;
  on(event: "data", listener: (chunk: string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  off(event: "data", listener: (chunk: string) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
}

/**
 * Read LF-delimited JSON text, accepting CRLF and a final unterminated frame.
 * Unlike readline, Unicode line/paragraph separators are ordinary payload.
 * The input owns UTF-8 decoding, including characters split across byte chunks.
 */
export type NdjsonLineReader = { close: () => void };

type NdjsonReaderOptions = {
  onError?: (error: Error) => void;
  /** 接收端传入自身字符串容量；不把请求大小预算套用到响应。 */
  maxFrameChars?: number;
};

export function readNdjsonLines(
  input: NdjsonInput,
  onLine: (line: string) => void,
  options: NdjsonReaderOptions = {},
): NdjsonLineReader {
  const maxFrameChars = options.maxFrameChars ?? Number.MAX_SAFE_INTEGER;
  let closed = false;
  let fragments: string[] = [];
  let frameChars = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    fragments = [];
    frameChars = 0;
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", close);
  };
  const fail = (error: unknown) => {
    close();
    const failure = error instanceof Error ? error : new Error(String(error));
    if (options.onError) options.onError(failure);
    else throw failure;
  };
  const append = (text: string): boolean => {
    if (text.length > maxFrameChars - frameChars) {
      fail(new Error(`NDJSON frame exceeds ${maxFrameChars} characters`));
      return false;
    }
    if (text.length) fragments.push(text);
    frameChars += text.length;
    return true;
  };
  const emit = (tail: string) => {
    if (!append(tail)) return;
    // 先移交并清空缓冲；拼接失败也不能污染后续帧或重复累积同一批内容。
    const parts = fragments;
    fragments = [];
    frameChars = 0;
    let line: string;
    try {
      line = parts.join("");
    } catch (error) {
      fail(error);
      return;
    }
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };
  const onData = (chunk: string) => {
    let start = 0;
    while (!closed) {
      const end = chunk.indexOf("\n", start);
      if (end === -1) {
        if (start < chunk.length) append(chunk.slice(start));
        return;
      }
      emit(chunk.slice(start, end));
      start = end + 1;
    }
  };
  const onEnd = () => {
    try {
      if (!closed && fragments.length > 0) emit("");
    } finally {
      close();
    }
  };
  input.setEncoding("utf8");
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", close);
  return { close };
}
