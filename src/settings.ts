import type { AppSettings } from "./types";

const SETTINGS_KEY = "xhsocr.settings";

const defaults: AppSettings = {
  apiKey: "",
  model: "gpt-5-mini",
  baseUrl: "https://api.openai.com/v1"
};

export async function loadSettings(): Promise<AppSettings> {
  const value = await GM_getValue<Partial<AppSettings>>(SETTINGS_KEY, {});
  return { ...defaults, ...value };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await GM_setValue(SETTINGS_KEY, settings);
}

export async function clearSettings(): Promise<void> {
  await GM_deleteValue(SETTINGS_KEY);
}
