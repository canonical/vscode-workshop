/**
 * Reference SDK catalogue and the pure logic behind the Add New Workshop
 * wizard: base resolution and workshop name rules.
 *
 * This module must stay free of VS Code APIs (see eslint.config.mjs).
 */

export type SdkCategory =
  | 'AI agents'
  | 'Languages & runtimes'
  | 'GPU & hardware'
  | 'AI/ML serving'
  | 'Embedded'
  | 'Robotics'
  | 'Developer tools';

/** Display order of SDK categories in the picker. */
export const SDK_CATEGORY_ORDER: readonly SdkCategory[] = [
  'AI agents',
  'Languages & runtimes',
  'GPU & hardware',
  'AI/ML serving',
  'Embedded',
  'Robotics',
  'Developer tools',
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
  opts: { repo?: string; channel?: string } = {},
): ReferenceSdk {
  return {
    name,
    category,
    summary,
    repoUrl: `https://github.com/canonical/${opts.repo ?? `${name}-sdk`}`,
    recommendedChannel: opts.channel,
  };
}

/**
 * All reference SDKs published by Canonical, as of 2026-09-07 (see
 * https://github.com/canonical/reference-sdks). Ordered by category (see
 * {@link SDK_CATEGORY_ORDER}) and alphabetically within each.
 */
export const REFERENCE_SDKS: readonly ReferenceSdk[] = [
  canonicalSdk('agy', 'AI agents', 'The terminal-first surface to interact with Antigravity agents'),
  canonicalSdk('claude-code', 'AI agents', "Anthropic's agentic coding tool for the terminal"),
  canonicalSdk('codex', 'AI agents', "OpenAI's CLI coding agent"),
  canonicalSdk('copilot', 'AI agents', 'GitHub Copilot for the terminal'),
  canonicalSdk('opencode', 'AI agents', 'Open-source terminal-based AI coding assistant'),
  canonicalSdk('dotnet', 'Languages & runtimes', 'Microsoft .NET SDK', { channel: '10/stable' }),
  canonicalSdk('flutter', 'Languages & runtimes', "Google's cross-platform UI toolkit"),
  canonicalSdk('go', 'Languages & runtimes', 'Go programming language toolchain', { channel: '1.27/stable' }),
  canonicalSdk('gradle', 'Languages & runtimes', 'Gradle build system for Java, Android and Kotlin projects', { channel: '9/stable' }),
  canonicalSdk('maven', 'Languages & runtimes', 'Apache Maven build tool for Java projects', { channel: '3.9/stable' }),
  canonicalSdk('node', 'Languages & runtimes', 'Node.js LTS runtime with Corepack', { channel: '24/stable' }),
  canonicalSdk('openjdk', 'Languages & runtimes', 'Open-source Java Development Kit (JDK)', { channel: '25/stable' }),
  canonicalSdk('rust', 'Languages & runtimes', 'Rust toolchain managed via Rustup'),
  canonicalSdk('uv', 'Languages & runtimes', 'Fast Python package and project manager'),
  canonicalSdk('cuda-toolkit', 'GPU & hardware', 'NVIDIA CUDA Toolkit for GPU parallel computing', { channel: '12.9/stable' }),
  canonicalSdk('openvino', 'GPU & hardware', 'Intel OpenVINO toolkit for AI inference', { channel: '2026/stable' }),
  canonicalSdk('rocm', 'GPU & hardware', 'AMD ROCm open GPU compute platform', { channel: '7.2/stable' }),
  canonicalSdk('comfy-ui', 'AI/ML serving', 'Node-based UI for Stable Diffusion image generation'),
  canonicalSdk('ollama', 'AI/ML serving', 'Local LLM runtime for running open-weight models'),
  canonicalSdk('zephyr', 'Embedded', 'Zephyr RTOS build environment (west, cmake, ninja)', { channel: '4.4/stable' }),
  canonicalSdk('ros2-minimal', 'Robotics', 'ROS 2 robotics development environment', { channel: 'lyrical/stable' }),
  canonicalSdk('direnv', 'Developer tools', 'Automatic per-directory environment variable loader'),
  canonicalSdk('docker-ce', 'Developer tools', 'Docker container runtime and CLI', { repo: 'docker-sdk' }),
  canonicalSdk('github-runner', 'Developer tools', 'Self-hosted GitHub Actions runner'),
  canonicalSdk('jupyter', 'Developer tools', 'Browser-based interactive Python IDE'),
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
