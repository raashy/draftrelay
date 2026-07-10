import { describe, expect, it } from "vitest";

import { browserCommands, clipboardCommands } from "./platform.js";

describe("cross-platform commands", () => {
  it("passes clipboard content through stdin instead of a shell", () => {
    const content = "$(touch /tmp/nope) ' quoted";
    expect(clipboardCommands(content, { platform: "darwin" })[0]).toMatchObject({
      command: "pbcopy",
      args: [],
      input: content
    });
    const windows = clipboardCommands(content, { platform: "win32" })[0];
    expect(windows?.input).toBe(content);
    expect(windows?.args).not.toContain(content);
  });

  it("prefers Wayland but retains X11 fallbacks", () => {
    expect(
      clipboardCommands("hello", { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } }).map(
        (command) => command.command
      )
    ).toEqual(["wl-copy", "xclip", "xsel"]);
  });

  it("does not interpolate browser URLs into shell commands", () => {
    const url = "http://127.0.0.1:3939/?item=safe";
    expect(browserCommands(url, { platform: "linux" })[0]).toEqual({
      command: "xdg-open",
      args: [url]
    });
    const windows = browserCommands(url, { platform: "win32" })[0];
    expect(windows?.input).toBe(url);
    expect(windows?.args).not.toContain(url);
  });
});
