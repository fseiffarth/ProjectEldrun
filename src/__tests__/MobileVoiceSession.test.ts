import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MobileSpeechRecognition,
  MobileSpeechRecognitionConstructor,
  MobileSpeechRecognitionErrorEvent,
  MobileSpeechRecognitionResultEvent,
} from "../../mobile-web/src/voiceInput";
import { startDictation, type DictationSessionHandlers } from "../../mobile-web/src/voiceSession";

class FakeRecognition implements MobileSpeechRecognition {
  static instances: FakeRecognition[] = [];
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  starts = 0;
  onstart: (() => void) | null = null;
  onresult: ((event: MobileSpeechRecognitionResultEvent) => void) | null = null;
  onerror: ((event: MobileSpeechRecognitionErrorEvent) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { FakeRecognition.instances.push(this); }
  start() { this.starts += 1; this.onstart?.(); }
  stop() { this.onend?.(); }
  abort() { this.onend?.(); }
  fail(error: string) { this.onerror?.({ error } as MobileSpeechRecognitionErrorEvent); }
}

function session() {
  const handlers = {
    onStart: vi.fn(),
    onResult: vi.fn(),
    onRestart: vi.fn(),
    onError: vi.fn(),
    onLevel: vi.fn(),
    onEnd: vi.fn(),
  } satisfies DictationSessionHandlers;
  const running = startDictation(FakeRecognition as MobileSpeechRecognitionConstructor, { lang: "en-GB", local: false }, handlers);
  return { handlers, running, speech: FakeRecognition.instances[FakeRecognition.instances.length - 1] };
}

describe("Eldrun Mobile dictation session", () => {
  beforeEach(() => {
    FakeRecognition.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, "wakeLock");
  });

  it("keeps listening when the browser ends its recognizer after a pause", () => {
    const { handlers, speech } = session();
    vi.advanceTimersByTime(8_000);
    speech.fail("no-speech");
    speech.onend?.();

    // The phone's recognizer gave up on the silence; the dictation did not.
    expect(handlers.onEnd).not.toHaveBeenCalled();
    expect(handlers.onError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(speech.starts).toBe(2);
    expect(handlers.onRestart).toHaveBeenCalledTimes(1);
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
  });

  it("ends on the user's stop, also between two recognizers", () => {
    const { handlers, running, speech } = session();
    vi.advanceTimersByTime(8_000);
    speech.onend?.();
    running.stop();
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(speech.starts).toBe(1);
  });

  it("does not restart past an error no restart can fix", () => {
    const { handlers, speech } = session();
    speech.fail("not-allowed");
    speech.onend?.();
    expect(handlers.onError).toHaveBeenCalledWith("mobile.voice.errDenied");
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    expect(speech.starts).toBe(1);
  });

  it("gives up on a recognizer that ends the moment it starts, instead of looping", () => {
    const { handlers, speech } = session();
    for (let round = 0; round < 3; round += 1) {
      speech.onend?.();
      // Just the restart delay: the next end follows its start at once.
      vi.advanceTimersByTime(250 * (round + 2));
    }
    expect(handlers.onError).toHaveBeenCalledWith("mobile.voice.errStopped");
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
    expect(speech.starts).toBe(3);
  });

  it("stops after two minutes in which nothing was heard", () => {
    const { handlers } = session();
    vi.advanceTimersByTime(120_000);
    expect(handlers.onError).toHaveBeenCalledWith("mobile.voice.errNoSpeech");
    expect(handlers.onEnd).toHaveBeenCalledTimes(1);
  });

  it("is silent after an abort", () => {
    const { handlers, running, speech } = session();
    running.abort();
    speech.onend?.();
    vi.advanceTimersByTime(5_000);
    expect(handlers.onEnd).not.toHaveBeenCalled();
    expect(speech.starts).toBe(1);
  });

  it("holds the screen awake for as long as it listens", async () => {
    const release = vi.fn(() => Promise.resolve());
    const request = vi.fn(() => Promise.resolve({ release }));
    Object.defineProperty(navigator, "wakeLock", { configurable: true, value: { request } });
    const { running } = session();
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith("screen");
    running.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
