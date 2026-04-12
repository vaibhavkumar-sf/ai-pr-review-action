import * as core from '@actions/core';

let debugEnabled = false;

export function setDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

export function debug(message: string, ...args: unknown[]): void {
  if (!debugEnabled) return;
  const formatted = args.length ? `${message} ${JSON.stringify(args)}` : message;
  core.debug(formatted);
}

export function info(message: string): void {
  core.info(message);
}

export function warning(message: string): void {
  core.warning(message);
}

export function error(message: string | Error): void {
  core.error(message);
}

export function group(name: string, fn: () => Promise<void>): Promise<void> {
  return core.group(name, fn);
}

export function startGroup(name: string): void {
  core.startGroup(name);
}

export function endGroup(): void {
  core.endGroup();
}

export const logger = {
  debug,
  info,
  warning,
  error,
  group,
  startGroup,
  endGroup,
  setDebug,
};
