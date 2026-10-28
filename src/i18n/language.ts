import i18n from "i18next";

export type Language = "zh" | "en";

/** 语言偏好：具体语言，或跟随系统（system 为未选择时的默认） */
export type LanguagePreference = Language | "system";

const STORAGE_KEY = "devport.language.v1";

/** 跟随系统：zh 开头用中文，其余英文；无法检测时回落中文。 */
export function detectLanguage(): Language {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.language === "string") {
      return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
    }
  } catch {
    // 忽略检测失败，回落默认
  }
  return "zh";
}

/** 读取持久化的语言偏好；缺省或非法值视为跟随系统。 */
export function loadLanguagePreference(): LanguagePreference {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return raw === "zh" || raw === "en" ? raw : "system";
  } catch {
    return "system";
  }
}

export function saveLanguagePreference(preference: LanguagePreference): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, preference);
  } catch (error) {
    console.warn("Unable to save language", error);
  }
}

/** 解析偏好为实际语言：system 时跟随系统。 */
export function resolveLanguage(preference: LanguagePreference): Language {
  return preference === "system" ? detectLanguage() : preference;
}

/** 初始语言：按持久化偏好解析，未选择过时跟随系统。 */
export function initialLanguage(): Language {
  return resolveLanguage(loadLanguagePreference());
}

/** 切换语言偏好并持久化；system 解析为当前系统语言；同步 <html lang>。 */
export function setLanguage(preference: LanguagePreference): void {
  const language = resolveLanguage(preference);
  void i18n.changeLanguage(language);
  saveLanguagePreference(preference);
  try {
    if (typeof document !== "undefined") document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
  } catch {
    // 非浏览器环境忽略
  }
}
