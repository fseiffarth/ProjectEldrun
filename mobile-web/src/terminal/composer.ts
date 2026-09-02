// One implementation shared with desktop scheduled delivery. Keeping this file
// as the Mobile import seam avoids churn in the terminal screen and its tests.
export {
  AGENT_LINE_RESET,
  PASTE_END,
  PASTE_START,
  agentInputWrites,
  sanitizeAgentMessage,
} from "../../../shared/agentComposer";
