import { describe, expect, it, vi } from "vitest";
import { startForegroundActivity } from "./useAchievements";

function harness(visible = true, focused = true) {
  const documentEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const doc = Object.assign(documentEvents, {
    visibilityState: visible ? "visible" : "hidden",
    hasFocus: () => focused,
  });
  let interval: (() => void) | undefined;
  const win = Object.assign(windowEvents, {
    setInterval: vi.fn((callback: () => void) => {
      interval = callback;
      return 1;
    }),
    clearInterval: vi.fn(),
  });
  const visit = vi
    .fn()
    .mockResolvedValue({ serverTimeUtc: "2026-09-10T16:00:00.000Z" });
  const refresh = vi.fn();
  const onForeground = vi.fn();
  const stop = startForegroundActivity({
    visit,
    refresh,
    onForeground,
    document: doc as unknown as Document,
    window: win,
  });
  return {
    doc,
    win,
    visit,
    refresh,
    onForeground,
    stop,
    tick: () => interval?.(),
    focus: (next: boolean) => {
      focused = next;
      win.dispatchEvent(new Event(next ? "focus" : "blur"));
    },
  };
}

describe("achievement foreground activity", () => {
  it("records first opening and foreground minute checks without passing a client date", async () => {
    const app = harness();
    expect(app.visit).toHaveBeenCalledExactlyOnceWith();
    await vi.waitFor(() => expect(app.refresh).toHaveBeenCalledOnce());
    app.tick();
    expect(app.visit).toHaveBeenCalledTimes(2);
    expect(app.win.setInterval).toHaveBeenCalledWith(
      expect.any(Function),
      60_000,
    );
    app.stop();
  });

  it("does not record a hidden or unfocused page and resumes on foreground return", async () => {
    const app = harness(false, false);
    app.tick();
    expect(app.visit).not.toHaveBeenCalled();
    app.doc.visibilityState = "visible";
    app.doc.dispatchEvent(new Event("visibilitychange"));
    expect(app.visit).not.toHaveBeenCalled();
    app.focus(true);
    expect(app.visit).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(app.refresh).toHaveBeenCalledOnce());
    app.focus(false);
    app.tick();
    expect(app.visit).toHaveBeenCalledOnce();
    app.stop();
  });

  it("coalesces simultaneous focus events and removes listeners on unmount", () => {
    const app = harness();
    app.focus(true);
    app.doc.dispatchEvent(new Event("visibilitychange"));
    app.tick();
    expect(app.visit).toHaveBeenCalledOnce();
    app.stop();
    app.focus(true);
    app.win.dispatchEvent(new Event("online"));
    expect(app.visit).toHaveBeenCalledOnce();
    expect(app.win.clearInterval).toHaveBeenCalledWith(1);
  });

  it("retries a failed visit after reconnecting without treating the background as use", async () => {
    const app = harness(false, false);
    app.visit.mockRejectedValueOnce(new Error("offline"));
    app.doc.visibilityState = "visible";
    app.focus(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    app.win.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(app.refresh).toHaveBeenCalledOnce());
    expect(app.visit).toHaveBeenCalledTimes(2);
    app.stop();
  });
});
