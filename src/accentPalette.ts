import type { Theme } from "./theme";

type HexColor = `#${string}`;

export const ACCENT_PRESETS = {
  default: null,
  blue: "#3261ef",
  green: "#00b7a3",
  yellow: "#ffca38",
  pink: "#f76eaa",
  orange: "#ff795f",
  purple: "#9e54f7",
  black: "#101010",
} as const;

export type AccentPreset = keyof typeof ACCENT_PRESETS;
export type AccentPreference = AccentPreset | HexColor;

export const ACCENT_VARIABLES = [
  "--accent", "--accent-hover", "--accent-solid", "--accent-solid-hover", "--accent-on-solid",
  "--accent-surface", "--accent-border", "--focus-glow", "--selection",
] as const;

type AccentVariables = Record<(typeof ACCENT_VARIABLES)[number], string>;

export function isAccentPreset(value: string): value is AccentPreset {
  return Object.prototype.hasOwnProperty.call(ACCENT_PRESETS, value);
}

export function parseCustomAccent(value: string): HexColor | undefined {
  const rgb = value.trim().replace(/^#/, "").toLowerCase();
  return /^[0-9a-f]{6}$/.test(rgb) ? `#${rgb}` : undefined;
}

export function normalizeAccent(value: string): AccentPreference {
  return isAccentPreset(value) ? value : (parseCustomAccent(value) ?? "default");
}

export function accentSwatch(theme: Theme, preference: AccentPreference): HexColor {
  if (!isAccentPreset(preference)) return preference;
  return ACCENT_PRESETS[preference] ?? (theme === "dark" ? "#a3c1ff" : "#ad4a26");
}

function channels(color: HexColor): number[] {
  return [1, 3, 5].map(start => Number.parseInt(color.slice(start, start + 2), 16));
}

function blend(from: HexColor, toward: HexColor, amount: number): HexColor {
  const target = channels(toward);
  const hex = channels(from)
    .map((channel, index) => Math.round(channel + (target[index] - channel) * amount).toString(16).padStart(2, "0"))
    .join("");
  return `#${hex}`;
}

function luminance(color: HexColor): number {
  const [r, g, b] = channels(color).map(channel => {
    const srgb = channel / 255;
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

function readableColor(color: HexColor, toward: HexColor, ratio: number, ...backgrounds: HexColor[]): HexColor {
  const luminances = backgrounds.map(background => luminance(background) + .05);
  // Move toward black or white in small steps so bright and muted inputs retain their hue.
  for (let step = 0; step < 20; step++) {
    const candidate = blend(color, toward, step / 20);
    const level = luminance(candidate) + .05;
    if (luminances.every(background => Math.max(level, background) / Math.min(level, background) >= ratio)) return candidate;
  }
  return toward;
}

export function accentVariables(theme: Theme, preference: AccentPreference): AccentVariables | undefined {
  if (preference === "default") return undefined;
  const seed = accentSwatch(theme, preference);
  const dark = theme === "dark";
  const base = dark ? "#1b1e24" : "#ffffff";
  const hover = dark ? "#343d4b" : "#eae7e3";
  const toward = dark ? "#ffffff" : "#000000";
  const onSolid = dark ? "#101218" : "#ffffff";
  const tint = readableColor(seed, toward, 3, hover);
  const surface = blend(base, tint, dark ? .18 : .10);
  const accent = readableColor(seed, toward, 4.5, hover, surface);
  const solid = readableColor(seed, toward, 4.5, onSolid);
  return {
    "--accent": accent,
    "--accent-hover": blend(accent, toward, .15),
    "--accent-solid": solid,
    "--accent-solid-hover": blend(solid, toward, .16),
    "--accent-on-solid": onSolid,
    "--accent-surface": surface,
    "--accent-border": readableColor(seed, toward, 3, hover, surface),
    "--focus-glow": `${tint}30`,
    "--selection": blend(base, tint, dark ? .27 : .23),
  };
}
