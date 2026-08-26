import { describe, expect, it } from "vitest";
import {
  prepareOnDeviceSpeech,
  sanitizeVoiceTranscript,
  speechRecognitionConstructor,
  speechRecognitionError,
  speechRecognitionSupported,
  transcriptsFrom,
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

  it("separates finalized text from the current interim hypothesis", () => {
    const event = {
      resultIndex: 1,
      results: {
        0: result("ignored old result", true),
        1: result("fix the login", true),
        2: result("and add a test", false),
        length: 3,
      },
    } as unknown as MobileSpeechRecognitionResultEvent;

    expect(transcriptsFrom(event)).toEqual({
      final: "fix the login",
      interim: "and add a test",
    });
  });

  it("removes control bytes before a transcript reaches the PTY", () => {
    expect(sanitizeVoiceTranscript("  inspect\nthis\u001b[2J  now\u0000 ")).toBe(
      "inspect this [2J now",
    );
  });

  it("turns browser speech failures into actionable phone guidance", () => {
    expect(speechRecognitionError("not-allowed")).toContain("Allow it");
    expect(speechRecognitionError("audio-capture")).toContain("microphone");
    expect(speechRecognitionError("aborted")).toBe("");
  });
});
