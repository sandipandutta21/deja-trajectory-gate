import { createReadStream, createWriteStream, WriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { CassetteHeader, CassetteFrame, CassetteLine } from "./types.js";

export class CassetteWriter {
    private stream: WriteStream;

    constructor(filePath: string) {
        this.stream = createWriteStream(filePath, { flags: "w", encoding: "utf8" });
    }

    write(line: CassetteLine): void {
        this.stream.write(JSON.stringify(line) + "\n");
    }

    /** Resolves on the stream's `close` event, not the `end()` callback ("finish") -- a
     *  stream whose underlying file never actually opened (e.g. the target directory doesn't
     *  exist) still fires its `end()` callback *before* the resulting `error` event, so
     *  resolving there would silently swallow a real write failure. `error` reliably fires
     *  before `close` (verified directly, not assumed), so listening for both and letting
     *  whichever settles the promise first win is safe here. */
    async close(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.stream.on("error", reject);
            this.stream.on("close", () => resolve());
            this.stream.end();
        });
    }
}

export class CassetteReader {
    constructor(private filePath: string) {}

    async *[Symbol.asyncIterator](): AsyncGenerator<CassetteLine, void, unknown> {
        const fileStream = createReadStream(this.filePath, { encoding: "utf8" });
        const rl = createInterface({
            input: fileStream,
            crlfDelay: Infinity,
        });

        for await (const line of rl) {
            if (!line.trim()) continue;
            yield JSON.parse(line) as CassetteLine;
        }
    }

    async loadAll(): Promise<{ header: CassetteHeader; frames: CassetteFrame[] }> {
        let header: CassetteHeader | undefined;
        const frames: CassetteFrame[] = [];

        for await (const line of this) {
            if (line.type === "header") {
                header = line;
            } else if (line.type === "frame") {
                frames.push(line);
            }
        }

        if (!header) {
            throw new Error(`Invalid cassette: missing header in ${this.filePath}`);
        }

        return { header, frames };
    }
}