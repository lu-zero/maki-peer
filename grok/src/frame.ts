/** MCP stdio framing. One JSON body, preceded by a Content-Length header. */

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8")
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8")
  return Buffer.concat([header, body])
}

export class FrameReader {
  private buffer = Buffer.alloc(0)

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
  }

  /** Every complete frame currently buffered, in order. */
  drain(): unknown[] {
    const messages: unknown[] = []
    for (;;) {
      const headerEnd = this.findHeaderEnd()
      if (headerEnd.start < 0) return messages
      const header = this.buffer.subarray(0, headerEnd.start).toString("utf8")
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match || match[1] === undefined) {
        this.buffer = this.buffer.subarray(headerEnd.end)
        continue
      }
      const length = Number(match[1])
      const bodyEnd = headerEnd.end + length
      if (this.buffer.length < bodyEnd) return messages
      const body = this.buffer.subarray(headerEnd.end, bodyEnd).toString("utf8")
      this.buffer = this.buffer.subarray(bodyEnd)
      try {
        messages.push(JSON.parse(body) as unknown)
      } catch {
        /* a torn frame is the parser's problem only when the length lied */
      }
    }
  }

  private findHeaderEnd(): { start: number; end: number } | { start: -1; end: -1 } {
    const crlf = this.buffer.indexOf("\r\n\r\n")
    if (crlf >= 0) return { start: crlf, end: crlf + 4 }
    const lf = this.buffer.indexOf("\n\n")
    if (lf >= 0) return { start: lf, end: lf + 2 }
    return { start: -1, end: -1 }
  }
}
