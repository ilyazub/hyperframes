import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/project.js", () => ({
  resolveProject: () => ({ name: "demo", dir: "/tmp/demo" }),
}));
vi.mock("../utils/producer.js", () => ({
  loadProducer: async () => ({
    createRenderJob: () => ({}),
    // The engine's BrowserManager announces every launch on console.log.
    executeRenderJob: async () => console.log("[BrowserManager] Browser launched (test)"),
  }),
}));

const { default: benchmarkCommand } = await import("./benchmark.js");

describe("benchmark --json", () => {
  it("prints only the JSON envelope on stdout and moves render logs to stderr", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...parts) => stdout.push(parts.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...parts) => stderr.push(parts.join(" ")));

    await benchmarkCommand.run!({
      args: { _: [], runs: "1", json: true },
      rawArgs: [],
      cmd: benchmarkCommand,
    } as never);

    const envelope = JSON.parse(stdout.join("\n"));
    expect(envelope.results).toHaveLength(5);
    expect(envelope.results[0].failures).toBe(0);
    expect(stderr.join("\n")).toContain("[BrowserManager] Browser launched");
  });
});
