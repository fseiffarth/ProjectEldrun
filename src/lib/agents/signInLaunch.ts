/**
 * How a sign-in tab starts each agent CLI: its own login command, in the flow
 * a phone can finish without a mouse — a device code where the CLI offers
 * one, else a code the page shows and the session takes back. The phone opens
 * such a tab from its ＋ sheet or from an agent tab that needs a login
 * (`POST /api/v1/tabs/{id}/sign-in`), and its sign-in sheet reads the link off
 * the screen (`mobile-web/src/terminal/signIn.ts`).
 *
 * The login lands in the tab's agent home and `services::agent_auth` shares it
 * with every scope, so one sign-in tab signs the CLI in everywhere.
 *
 * Checked 2026-09-27 against the installed `--help`: Claude 2.1.283
 * (`auth login --claudeai|--console`), Copilot 1.0.88 (`login
 * --device-code`). From the vendors' docs, not run here: Codex `login
 * --device-auth` (the account may first need device-code sign-in allowed in
 * ChatGPT's security settings — hence the browser way as the alternate),
 * Cursor `login` with `NO_OPEN_BROWSER`, OpenCode `auth login`, Amp `login`,
 * Gemini's `NO_BROWSER` code flow. A CLI missing here has no login command:
 * it signs in when it starts, so its sign-in tab is a plain launch that stays
 * a session afterwards.
 */

export interface SignInWay {
  args: string[];
  env?: Record<string, string>;
}

export interface SignInLaunch extends SignInWay {
  /** The command ends once the login does; the tab is only for signing in.
   *  False: a plain launch, which goes on as a session. */
  exits: boolean;
  /** The CLI's other way in, and what the phone calls it. */
  alternate?: SignInWay & { kind: "console" | "browser" };
}

const SIGN_IN_LAUNCHES: Readonly<Record<string, SignInLaunch>> = {
  claude: {
    args: ["auth", "login", "--claudeai"],
    exits: true,
    alternate: { kind: "console", args: ["auth", "login", "--console"] },
  },
  codex: {
    args: ["login", "--device-auth"],
    exits: true,
    alternate: { kind: "browser", args: ["login"] },
  },
  copilot: { args: ["login", "--device-code"], exits: true },
  "cursor-agent": { args: ["login"], env: { NO_OPEN_BROWSER: "1" }, exits: true },
  opencode: { args: ["auth", "login"], exits: true },
  amp: { args: ["login"], exits: true },
  gemini: { args: [], env: { NO_BROWSER: "true" }, exits: false },
};

const PLAIN_LAUNCH: SignInLaunch = { args: [], exits: false };

/** The sign-in launch of a built-in agent command; `alternate` picks its
 *  other way in, and falls back to the default where it has none. */
export function signInLaunch(cmd: string, alternate = false): SignInLaunch {
  const launch = Object.prototype.hasOwnProperty.call(SIGN_IN_LAUNCHES, cmd)
    ? SIGN_IN_LAUNCHES[cmd]
    : PLAIN_LAUNCH;
  if (alternate && launch.alternate) {
    const { kind: _kind, ...way } = launch.alternate;
    return { ...way, exits: launch.exits };
  }
  return launch;
}

/** The id `services::agent_auth` keeps a command's login under — the agent
 *  registry's id, which differs from the binary for a few CLIs. */
const LOGIN_IDS: Readonly<Record<string, string>> = {
  agy: "antigravity",
  cn: "continue",
  "kiro-cli": "kiro",
  sweagent: "swe-agent",
  mini: "mini-swe-agent",
};

export function loginIdForCmd(cmd: string): string {
  return Object.prototype.hasOwnProperty.call(LOGIN_IDS, cmd) ? LOGIN_IDS[cmd] : cmd;
}
