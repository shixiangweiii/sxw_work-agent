/**
 * 按键组合的解析与拒绝表（ADR-0013）。
 *
 * 【定】这里是按键名的**权威清单**。Swift 助手里有一张按键名 → 虚拟键码的表，
 * 两张表必然重复（语言不同），处置是让 TS 先校验：不在这里的名字根本到不了助手，
 * 助手那边遇到未知名字仍然报错（第二道），而不是猜一个键。
 */

import type { KeyModifier } from "./driver.js";

const MODIFIER_ALIASES: Record<string, KeyModifier> = {
  cmd: "cmd",
  command: "cmd",
  shift: "shift",
  alt: "option",
  option: "option",
  opt: "option",
  ctrl: "control",
  control: "control",
  fn: "fn",
};

const KEY_ALIASES: Record<string, string> = {
  enter: "return",
  return: "return",
  esc: "escape",
  escape: "escape",
  backspace: "delete",
  delete: "delete",
  del: "forwarddelete",
  forwarddelete: "forwarddelete",
  pgup: "pageup",
  pgdn: "pagedown",
};

const NAMED_KEYS = new Set([
  "return", "tab", "space", "escape", "delete", "forwarddelete",
  "up", "down", "left", "right", "home", "end", "pageup", "pagedown",
  "minus", "equal", "leftbracket", "rightbracket", "semicolon", "quote",
  "comma", "period", "slash", "backslash", "grave",
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/**
 * 系统级组合：切换应用、唤起全局搜索、锁屏、注销、强制退出。
 *
 * 【定】它们的作用范围超出白名单里的那个应用 —— 按下去之后，接下来的输入
 * 会落到一个**没有被授权**的地方（Spotlight、应用切换器、登录窗口）。
 * 键盘事件是发给白名单应用进程的，多数系统热键本来就不会被触发；
 * 这里再拒一次，是因为「多数」不是保证。
 */
const DENIED_COMBOS: Array<{ key: string; modifiers: KeyModifier[]; why: string }> = [
  { key: "space", modifiers: ["cmd"], why: "唤起 Spotlight（全局搜索，可启动任意程序）" },
  { key: "space", modifiers: ["control"], why: "切换输入法 / 全局搜索" },
  { key: "tab", modifiers: ["cmd"], why: "切换应用（焦点会离开白名单）" },
  { key: "tab", modifiers: ["cmd", "shift"], why: "切换应用（焦点会离开白名单）" },
  { key: "q", modifiers: ["cmd", "control"], why: "锁屏" },
  { key: "q", modifiers: ["cmd", "shift"], why: "注销" },
  { key: "q", modifiers: ["cmd", "option", "shift"], why: "注销" },
  { key: "escape", modifiers: ["cmd", "option"], why: "强制退出窗口" },
];

export interface ParsedKey {
  key: string;
  modifiers: KeyModifier[];
}

/** 解析 "cmd+shift+s" / "Return" / "ctrl+a"。不合法时返回错误说明。 */
export function parseKeyCombo(raw: string): ParsedKey | { error: string } {
  const parts = raw
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return { error: "按键为空" };
  const modifiers = new Set<KeyModifier>();
  let key: string | undefined;
  for (const p of parts) {
    const mod = MODIFIER_ALIASES[p];
    if (mod) {
      modifiers.add(mod);
      continue;
    }
    if (key !== undefined) return { error: `一次只能按一个非修饰键，收到「${raw}」` };
    const k = KEY_ALIASES[p] ?? p;
    if (/^[a-z0-9]$/.test(k) || NAMED_KEYS.has(k)) {
      key = k;
    } else {
      return {
        error:
          `不认识的按键「${p}」。可用：单个字母或数字、return、tab、space、escape、delete、` +
          `forwarddelete、up/down/left/right、home、end、pageup、pagedown、f1–f12、` +
          `以及标点 minus/equal/comma/period/slash 等；修饰键 cmd/shift/option/ctrl/fn`,
      };
    }
  }
  if (key === undefined) return { error: `只有修饰键没有按键：「${raw}」` };
  const mods = [...modifiers].sort();
  for (const d of DENIED_COMBOS) {
    const dm = [...d.modifiers].sort();
    if (d.key === key && dm.length === mods.length && dm.every((m, i) => m === mods[i])) {
      return { error: `「${raw}」是系统级组合（${d.why}），computer use 不允许按` };
    }
  }
  return { key, modifiers: mods };
}
