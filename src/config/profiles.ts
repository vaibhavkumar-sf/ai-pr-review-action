import { ReviewCategory, ReviewProfile } from '../types';

export type ProfileMap = Record<ReviewCategory, boolean>;

const strict: ProfileMap = {
  'security': true,
  'code-quality': true,
  'performance': true,
  'type-safety': true,
  'architecture': true,
  'testing': true,
  'api-design': true,
};

const standard: ProfileMap = {
  'security': true,
  'code-quality': true,
  'performance': true,
  'type-safety': true,
  'architecture': true,
  'testing': false,
  'api-design': false,
};

const minimal: ProfileMap = {
  'security': true,
  'code-quality': true,
  'performance': false,
  'type-safety': false,
  'architecture': false,
  'testing': false,
  'api-design': false,
};

export const PROFILES: Record<ReviewProfile, ProfileMap> = {
  strict,
  standard,
  minimal,
};

export function getEnabledAgents(profile: ReviewProfile, overrides?: Partial<ProfileMap>): Set<ReviewCategory> {
  const base = { ...PROFILES[profile] };

  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        base[key as ReviewCategory] = value;
      }
    }
  }

  const enabled = new Set<ReviewCategory>();
  for (const [category, isEnabled] of Object.entries(base)) {
    if (isEnabled) {
      enabled.add(category as ReviewCategory);
    }
  }

  return enabled;
}
