/** MCP stdio. One JSON object per line, which is what Grok's client reads and writes. */

export function encodeMessage(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8")
}

export class LineReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
  }

  /** Every complete line currently buffered, in order. A line that is not JSON is skipped. */
  drain(): unknown[] {
    const messages: unknown[] = []
    for (;;) {
      const nl = this.buffer.indexOf(0x0a)
      if (nl < 0) return messages
      const line = this.buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "")
      this.buffer = this.buffer.subarray(nl + 1)
      if (line.trim() === "") continue
      try {
        messages.push(JSON.parse(line) as unknown)
      } catch {
        /* a line that is not JSON is ignored, the same way the client ignores one */
      }
    }
  }
}
