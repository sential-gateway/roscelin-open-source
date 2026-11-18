// Personal interaction profile: explicit preferences only. Never app content, never credentials.

export const PROFILE_VERSION = 1;

export interface Profile {
  profileVersion: number;
  density: 'compact' | 'comfortable';
  textScale: number; // 1.0 – 2.0
  contrast: 'standard' | 'high';
  reducedMotion: boolean;
  keyboardFirst: boolean;
  vocabulary: 'plain' | 'technical';
  pinnedControls: string[]; // node keys, e.g. "create-form:reference-tasks.task.create"
  /** Saved surfaces keyed by appId -> name -> serialized UISurface (layout only, no content). */
  savedWorkspaces: Record<string, Record<string, unknown>>;
  perApp: Record<string, { paused?: boolean; density?: 'compact' | 'comfortable' }>;
}

export function defaultProfile(): Profile {
  return {
    profileVersion: PROFILE_VERSION,
    density: 'comfortable',
    textScale: 1,
    contrast: 'standard',
    reducedMotion: false,
    keyboardFirst: false,
    vocabulary: 'plain',
    pinnedControls: [],
    savedWorkspaces: {},
    perApp: {},
  };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Migrate/sanitize any stored or imported profile into the current version. Unknown keys are dropped. */
export function migrateProfile(input: unknown): Profile {
  const p = defaultProfile();
  if (typeof input !== 'object' || input === null) return p;
  const i = input as Record<string, unknown>;
  // v0 (pre-release) used "fontScale" and "highContrast".
  if (typeof i.fontScale === 'number' && i.textScale === undefined) i.textScale = i.fontScale;
  if (typeof i.highContrast === 'boolean' && i.contrast === undefined) i.contrast = i.highContrast ? 'high' : 'standard';

  if (i.density === 'compact' || i.density === 'comfortable') p.density = i.density;
  if (typeof i.textScale === 'number' && Number.isFinite(i.textScale)) p.textScale = clamp(i.textScale, 1, 2);
  if (i.contrast === 'high' || i.contrast === 'standard') p.contrast = i.contrast;
  if (typeof i.reducedMotion === 'boolean') p.reducedMotion = i.reducedMotion;
  if (typeof i.keyboardFirst === 'boolean') p.keyboardFirst = i.keyboardFirst;
  if (i.vocabulary === 'plain' || i.vocabulary === 'technical') p.vocabulary = i.vocabulary;
  if (Array.isArray(i.pinnedControls)) p.pinnedControls = i.pinnedControls.filter((x): x is string => typeof x === 'string').slice(0, 50);
  if (typeof i.savedWorkspaces === 'object' && i.savedWorkspaces !== null) {
    for (const [app, ws] of Object.entries(i.savedWorkspaces as Record<string, unknown>)) {
      if (typeof ws === 'object' && ws !== null) p.savedWorkspaces[app] = { ...(ws as Record<string, unknown>) };
    }
  }
  if (typeof i.perApp === 'object' && i.perApp !== null) {
    for (const [app, o] of Object.entries(i.perApp as Record<string, unknown>)) {
      if (typeof o !== 'object' || o === null) continue;
      const src = o as Record<string, unknown>;
      p.perApp[app] = {};
      if (typeof src.paused === 'boolean') p.perApp[app].paused = src.paused;
      if (src.density === 'compact' || src.density === 'comfortable') p.perApp[app].density = src.density;
    }
  }
  return p;
}

/** Export only whitelisted preference fields. Saved surfaces are layouts; they hold no app content by construction. */
export function exportProfile(p: Profile): string {
  const clean = migrateProfile(p);
  return JSON.stringify({ ...clean, exportedAt: new Date().toISOString() }, null, 2);
}
