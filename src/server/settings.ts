import { writeSettings } from "../store/settings.ts";
import { refreshLearnerMemory } from "./learner-memory-runtime.ts";

/** Route-facing write seam: resume deferred memory work after model changes. */
export function writeSettingsRecord(raw: unknown) {
  const settings = writeSettings(raw);
  refreshLearnerMemory();
  return settings;
}