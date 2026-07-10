/**
 * File-matching patterns: what never gets reviewed, what counts as a test
 * file, and which bot comments are always hidden.
 */

/**
 * Built-in exclude globs. User `exclude_patterns` are APPENDED to these,
 * never replacing them — consumers only add project-specific extras.
 */
export const DEFAULT_EXCLUDE_PATTERNS = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/openapi.json',
  '**/migrations/**/*.js',
  '**/migrations/**/*.ts',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.bpmn',
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/coverage/**',
  '**/.angular/**',
  '**/*.generated.ts',
  '**/*.d.ts',
];

/**
 * Bot comments whose body matches one of these phrases are ALWAYS hidden
 * (every occurrence). All other recurring bot comment types keep only the
 * latest occurrence per (bot, heading) — older ones are minimized as OUTDATED.
 */
export const BOT_HIDE_ALL_PATTERNS = [
  'Unit Test Quality Report',
  'Unit Test Quality Analysis Failed',
];

/** Findings in these files are kept in the summary but never posted as inline comments. */
export const TEST_FILE_PATTERNS: RegExp[] = [
  /\.unit\.[tj]s$/,
  /\.spec\.[tj]s$/,
  /\.test\.[tj]s$/,
  /(^|\/)__tests__\/unit\//,
];

export function isTestFile(filename: string): boolean {
  return TEST_FILE_PATTERNS.some(pattern => pattern.test(filename));
}
