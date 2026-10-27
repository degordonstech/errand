import { getUserById } from "../db/supabase.js";
import { EMAIL_TOOLS, getTool } from "../tools/index.js";
import { SafetyGate } from "./gate.js";
import { supabaseGateStore } from "./store.js";

export const gate = new SafetyGate({
  store: supabaseGateStore,
  emailTools: EMAIL_TOOLS,
  async execute(action) {
    const tool = getTool(action.tool);
    if (!tool?.sensitive) throw new Error(`no sensitive tool named ${action.tool}`);
    // Stored args are validated again before anything runs.
    const args = tool.schema.parse(action.args);
    const user = await getUserById(action.userId);
    return (await tool.run(args, { user, actionId: action.id })).message;
  },
});
