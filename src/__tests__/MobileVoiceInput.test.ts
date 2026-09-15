import { describe, expect, it } from "vitest";
import { en } from "../lib/i18n";
import {
  prepareOnDeviceSpeech,
  sanitizeVoiceTranscript,
  speechRecognitionConstructor,
  speechRecognitionError,
  speechRecognitionSupported,
  advanceDictation,
  DICTATION_START,
  dictationPreview,
  readDictation,
  settleDictation,
  type MobileSpeechRecognition,
  type MobileSpeechRecognitionConstructor,
  type MobileSpeechRecognitionResultEvent,
} from "../../mobile-web/src/voiceInput";

class FakeRecognition implements MobileSpeechRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart = null;
  onresult = null;
  onerror = null;
  onend = null;
  start() {}
  stop() {}
  abort() {}
}

function result(transcript: string, isFinal: boolean) {
  return { 0: { transcript }, isFinal, length: 1 };
}

describe("Eldrun Mobile voice input", () => {
  it("uses standard or prefixed mobile speech recognition", () => {
    const Constructor = FakeRecognition as MobileSpeechRecognitionConstructor;
    const standard = { SpeechRecognition: Constructor } as unknown as Window;
    const prefixed = { webkitSpeechRecognition: Constructor } as unknown as Window;

    expect(speechRecognitionConstructor(standard)).toBe(Constructor);
    expect(speechRecognitionConstructor(prefixed)).toBe(Constructor);
    expect(speechRecognitionSupported({} as Window)).toBe(false);
  });

  it("prefers an installed on-device dictation model", async () => {
    class LocalRecognition extends FakeRecognition {
      static available = async () => "available" as const;
    }

    await expect(prepareOnDeviceSpeech(LocalRecognition, "de-DE")).resolves.toBe("local");
  });

  it("installs a downloadable on-device language pack before retrying", async () => {
    class DownloadableRecognition extends FakeRecognition {
      static available = async () => "downloadable" as const;
      static install = async () => true;
    }

    await expect(prepareOnDeviceSpeech(DownloadableRecognition, "en-US")).resolves.toBe("installed");
  });

  it("falls back to the browser speech service when local dictation is unavailable", async () => {
    class RemoteRecognition extends FakeRecognition {
      static available = async () => "unavailable" as const;
    }

    await expect(prepareOnDeviceSpeech(RemoteRecognition, "en-US")).resolves.toBe("remote");
  });

  it("reads the whole result list, whatever resultIndex says", () => {
    const event = {
      resultIndex: 1,
      results: {
        0: result("fix the login", true),
        1: result("and add a test", true),
        2: result("please", false),
        length: 3,
      },
    } as unknown as MobileSpeechRecognitionResultEvent;

    expect(readDictation(event)).toEqual({
      heard: ["fix", "the", "login", "and", "add", "a", "test"],
      interim: "please",
    });
  });

  it("collapses a final result that repeats the earlier words as its head", () => {
    const event = {
      resultIndex: 0,
      results: {
        0: result("fix the login", true),
        1: result("Fix the login, and test", true),
        2: result("fix the login and test and", false),
        length: 3,
      },
    } as unknown as MobileSpeechRecognitionResultEvent;

    expect(readDictation(event)).toEqual({ heard: ["Fix", "the", "login,", "and", "test"], interim: "and" });
  });

  it("inserts each heard word once, and none of them again after a send", () => {
    let step = advanceDictation(DICTATION_START, ["fix", "the"]);
    expect(step.insert).toBe("fix the");
    step = advanceDictation(step.progress, ["fix", "the", "login"]);
    expect(step.insert).toBe("login");
    step = advanceDictation(step.progress, ["fix", "the", "login"]);
    expect(step.insert).toBe("");

    const sent = settleDictation(step.progress);
    expect(dictationPreview(sent, "and")).toBe("and");
    step = advanceDictation(sent, ["fix", "the", "login", "and", "test"]);
    expect(step.insert).toBe("and test");
    expect(dictationPreview(step.progress, "")).toBe("and test");
  });

  it("keeps counting through a revised word instead of inserting the sentence again", () => {
    const before = advanceDictation(DICTATION_START, ["why", "is", "this", "other"]).progress;
    const step = advanceDictation(before, ["why", "is", "the", "other", "prompt"]);
    expect(step.insert).toBe("prompt");
  });

  it("takes a result list that starts over as new words", () => {
    const before = advanceDictation(DICTATION_START, ["fix", "the", "login"]).progress;
    const step = advanceDictation(settleDictation(before), ["add", "a", "test"]);
    expect(step.insert).toBe("add a test");
    expect(dictationPreview(step.progress, "")).toBe("add a test");
  });

  it("removes control bytes before a transcript reaches the PTY", () => {
    expect(sanitizeVoiceTranscript("  inspect\nthis\u001b[2J  now\u0000 ")).toBe(
      "inspect this [2J now",
    );
  });

  it("turns browser speech failures into actionable phone guidance", () => {
    expect(speechRecognitionError("not-allowed")).toBe("mobile.voice.errDenied");
    expect(speechRecognitionError("service-not-allowed")).toBe("mobile.voice.errDenied");
    expect(speechRecognitionError("audio-capture")).toBe("mobile.voice.errNoMic");
    expect(speechRecognitionError("something-new")).toBe("mobile.voice.errStopped");
    expect(speechRecognitionError("aborted")).toBeNull();
    for (const error of ["not-allowed", "audio-capture", "network", "language-not-supported", "no-speech", "x"]) {
      const key = speechRecognitionError(error);
      expect(key && en[key]).toBeTruthy();
    }
  });
});
