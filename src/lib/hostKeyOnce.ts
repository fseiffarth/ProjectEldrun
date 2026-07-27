import { unknownHostKeyTarget } from "./hostKey";
import { useHostKeyPromptStore } from "../stores/hostKeyPrompt";

/**
 * `withHostKeyConfirm` for a **retry loop**.
 *
 * The plain wrapper asks once per attempt, which is right for a single connect
 * and wrong the moment the caller retries: the extend-to-remote flow dials the
 * freshly-created remote up to six times, four seconds apart, so an unknown host
 * key would put six identical fingerprint dialogs in front of the user — and a
 * decline on the first would be re-asked five more times, which is not a decline
 * at all.
 *
 * So the decision is taken **once per loop** and then held:
 *  - accepted → the key is in `known_hosts` now, so later attempts simply run;
 *  - declined → later attempts fail with the original error and never re-prompt,
 *    because "no" is an answer and asking again is how a gate gets worn down.
 *
 * Call it once at the top of the loop and use the returned function for every
 * attempt; a new loop makes a new one (a fingerprint decision is per act, not a
 * setting).
 */
export function hostKeyConfirmOnce(): <T>(attempt: () => Promise<T>) => Promise<T> {
  let decided: boolean | null = null;
  return async function run<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (e) {
      const target = unknownHostKeyTarget(e);
      if (!target) throw e;
      if (decided === null) decided = await useHostKeyPromptStore.getState().request(target);
      if (!decided) throw e;
      return attempt();
    }
  };
}
