export interface MobileSpeechRecognitionAlternative {
  transcript: string;
}

export interface MobileSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: MobileSpeechRecognitionAlternative;
}

export interface MobileSpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: MobileSpeechRecognitionResult;
}

export interface MobileSpeechRecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: MobileSpeechRecognitionResultList;
}

export interface MobileSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

export interface MobileSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  processLocally?: boolean;
  onstart: (() => void) | null;
  onresult: ((event: MobileSpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: MobileSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface MobileSpeechRecognitionOptions {
  langs: string[];
  processLocally: boolean;
  quality?: "command" | "dictation" | "conversation";
}

export type MobileSpeechRecognitionAvailability =
  | "available"
  | "downloadable"
  | "downloading"
  | "unavailable";

export interface MobileSpeechRecognitionConstructor {
  new (): MobileSpeechRecognition;
  available?(
    options: MobileSpeechRecognitionOptions,
  ): Promise<MobileSpeechRecognitionAvailability>;
  install?(options: MobileSpeechRecognitionOptions): Promise<boolean>;
}

export type OnDeviceSpeechPreparation = "local" | "remote" | "installed";

type SpeechWindow = Window & {
  SpeechRecognition?: MobileSpeechRecognitionConstructor;
  webkitSpeechRecognition?: MobileSpeechRecognitionConstructor;
};

/** The Web Speech API is still vendor-prefixed in several mobile browsers. */
export function speechRecognitionConstructor(
  scope: Window = window,
): MobileSpeechRecognitionConstructor | undefined {
  const speechWindow = scope as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

export function speechRecognitionSupported(scope: Window = window): boolean {
  return speechRecognitionConstructor(scope) !== undefined;
}

/**
 * Prefer Chromium's on-device dictation model. Older browsers, unsupported
 * languages, failed downloads, and policy/API errors safely retain the normal
 * browser recognition service instead of making voice input disappear.
 */
export async function prepareOnDeviceSpeech(
  Recognition: MobileSpeechRecognitionConstructor,
  lang: string,
): Promise<OnDeviceSpeechPreparation> {
  if (!Recognition.available) return "remote";
  const options: MobileSpeechRecognitionOptions = {
    langs: [lang],
    processLocally: true,
    quality: "dictation",
  };
  try {
    const availability = await Recognition.available(options);
    if (availability === "available") return "local";
    if (availability === "unavailable" || !Recognition.install) return "remote";
    // A language-pack download can outlive the transient user activation that
    // opened it. Ask for a second tap after installation so microphone capture
    // always starts from a fresh user gesture.
    return await Recognition.install(options) ? "installed" : "remote";
  } catch {
    return "remote";
  }
}

export function transcriptsFrom(
  event: MobileSpeechRecognitionResultEvent,
): { final: string; interim: string } {
  const final: string[] = [];
  const interim: string[] = [];
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    const text = result?.[0]?.transcript ?? "";
    (result?.isFinal ? final : interim).push(text);
  }
  return { final: final.join(" "), interim: interim.join(" ") };
}

/** Voice text is terminal input, so never forward terminal control bytes. */
export function sanitizeVoiceTranscript(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function speechRecognitionError(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Allow it for this Eldrun Mobile site and try again.";
    case "audio-capture":
      return "No phone microphone is available.";
    case "network":
      return "The phone's speech service is unavailable. Check its connection and try again.";
    case "language-not-supported":
      return "The phone's speech service does not support this language.";
    case "no-speech":
      return "No speech was heard. Tap the microphone and try again.";
    case "aborted":
      return "";
    default:
      return "Voice typing stopped unexpectedly. Try again or use the keyboard microphone.";
  }
}
