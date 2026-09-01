/**
 * Reference SDK catalogue and the pure logic behind the Add New Workshop
 * wizard: base resolution and workshop name rules.
 *
 * This module must stay free of VS Code APIs (see eslint.config.mjs).
 */

export type SdkCategory =
  | 'AI/ML'
  | 'AI agents'
  | 'Toolchains'
  | 'Developer tools'
  | 'IDEs';

/** Display order of SDK categories in the picker. */
export const SDK_CATEGORY_ORDER: readonly SdkCategory[] = [
  'AI/ML',
  'AI agents',
  'Toolchains',
  'Developer tools',
  'IDEs',
];

export interface ReferenceSdk {
  name: string;
  category: SdkCategory;
  /** Store summary, shown as the row description. */
  summary: string;
  /** Project page opened by the row's ⓘ button; absent when none is known. */
  repoUrl?: string;
  /** Snap channel to pass to `workshop init`; omitted means latest/stable. */
  recommendedChannel?: string;
}

function canonicalSdk(
  name: string,
  category: SdkCategory,
  summary: string,
  repo = `${name}-sdk`,
): ReferenceSdk {
  return { name, category, summary, repoUrl: `https://github.com/canonical/${repo}` };
}

/**
 * All reference SDKs published by Canonical, as of 2026-08-28. Ordered by
 * category (see {@link SDK_CATEGORY_ORDER}) and alphabetically within each.
 */
export const REFERENCE_SDKS: readonly ReferenceSdk[] = [
  canonicalSdk('ollama', 'AI/ML', 'Get up and running with large language models'),
  canonicalSdk('openvino', 'AI/ML', "Intel's OpenVINO Toolkit"),
  canonicalSdk('rocm', 'AI/ML', 'AMD ROCm runtime (apt)'),
  canonicalSdk('claude-code', 'AI agents', 'Claude Code CLI'),
  canonicalSdk('codex', 'AI agents', 'OpenAI Codex CLI agent'),
  canonicalSdk('copilot', 'AI agents', 'GitHub Copilot CLI - AI-powered coding assistant for the terminal'),
  canonicalSdk('opencode', 'AI agents', 'The OpenCode SDK.'),
  canonicalSdk('flutter', 'Toolchains', "Google's UI toolkit for multi-platform apps"),
  canonicalSdk('go', 'Toolchains', 'The Go programming language'),
  canonicalSdk('node', 'Toolchains', 'Node.js'),
  canonicalSdk('rust', 'Toolchains', 'The Rust toolchain installer'),
  { name: 'uv', category: 'Toolchains', summary: 'An extremely fast Python package and project manager' },
  canonicalSdk('direnv', 'Developer tools', 'Load .envrc-driven environment variables in workshop sessions'),
  canonicalSdk('docker-ce', 'Developer tools', 'Docker container runtime', 'docker-sdk'),
  canonicalSdk('github-runner', 'Developer tools', 'Run GitHub Actions inside a local workshop'),
  canonicalSdk('jupyter', 'IDEs', 'JupyterLab IDE'),
  canonicalSdk('vscode-remote', 'IDEs', 'VS Code Remote Development plugin support'),
];

/** Bases Workshop supports, newest first. */
export const SUPPORTED_BASES: readonly string[] = [
  'ubuntu@26.04',
  'ubuntu@24.04',
  'ubuntu@22.04',
  'ubuntu@20.04',
];

export const DEFAULT_BASE = 'ubuntu@26.04';

/** The base to pre-highlight: the default when offered, else the newest. */
export function preferredBase(bases: readonly string[]): string | undefined {
  return bases.includes(DEFAULT_BASE) ? DEFAULT_BASE : bases[0];
}

export const MAX_NAME_LENGTH = 40;
export const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export const NAME_EMPTY_MESSAGE = 'Enter a workshop name.';
export const NAME_PATTERN_MESSAGE =
  'Must start with a letter and contain only lowercase letters, digits, and hyphens joining them.';
export const NAME_TOO_LONG_MESSAGE = `Name is too long (max ${MAX_NAME_LENGTH}).`;

/**
 * Validate a workshop name using Workshop's rules. Surrounding whitespace is
 * ignored. Returns the message to show, or undefined when the name is valid.
 */
export function validateWorkshopName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.length === 0) {
    return NAME_EMPTY_MESSAGE;
  }
  if (!NAME_PATTERN.test(name)) {
    return NAME_PATTERN_MESSAGE;
  }
  if (name.length > MAX_NAME_LENGTH) {
    return NAME_TOO_LONG_MESSAGE;
  }
  return undefined;
}

/** The first of `dev`, `dev1`, `dev2`, … not present in `existing`. */
export function firstFreeName(existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has('dev')) {
    return 'dev';
  }
  for (let i = 1; ; i++) {
    const candidate = `dev${i}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
