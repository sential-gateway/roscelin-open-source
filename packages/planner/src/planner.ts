// Capability-grounded UI planner. Produces declarative UISurface data only.
// A model gateway is optional and provider-neutral; output is always schema-validated,
// and a deterministic fallback guarantees working controls when generation fails.

import type { Capability, ObservedState } from '../../schemas/src/contracts.ts';
import type { UISurface, UINode } from '../../schemas/src/ui-schema.ts';
import { UI_SCHEMA_VERSION } from '../../schemas/src/ui-schema.ts';
import { validateSurface, stateFields } from '../../schemas/src/validate.ts';
import type { Profile } from '../../schemas/src/profile.ts';

/** Minimal, content-free context sent to a model: shapes, not values. */
export interface PlannerContext {
  userIntent: string; // the user's own words, kept separate from app content
  profile: Pick<Profile, 'density' | 'keyboardFirst' | 'vocabulary' | 'textScale'>;
  capabilities: { id: string; operation: string; label: string; riskClass: string; args: string[] }[];
  collections: { name: string; fields: string[]; count: number }[];
  adapter: { adapterId: string; adapterVersion: string };
}

export interface ModelGateway {
  name: string;
  /** Returns raw text expected to be a JSON UISurface. Never given secrets or full page content. */
  generate(ctx: PlannerContext, signal: AbortSignal): Promise<string>;
}

export function buildContext(intent: string, profile: Profile, caps: Capability[], state: ObservedState): PlannerContext {
  return {
    userIntent: intent.slice(0, 500),
    profile: { density: profile.density, keyboardFirst: profile.keyboardFirst, vocabulary: profile.vocabulary, textScale: profile.textScale },
    capabilities: caps.map((c) => ({ id: c.id, operation: c.operation, label: c.label, riskClass: c.riskClass, args: Object.keys(c.argumentSchema) })),
    // Field names only; adapter-internal fields (leading underscore) never leave the device.
    collections: Object.entries(state.collections).map(([name, objs]) => ({ name, fields: (state.collectionSchema?.[name] ?? Object.keys(objs[0]?.fields ?? {})).filter((f) => !f.startsWith('_')), count: objs.length })),
    adapter: { adapterId: caps[0]?.adapterId ?? '', adapterVersion: caps[0]?.adapterVersion ?? '' },
  };
}

type Layout = 'compact-list' | 'guided-edit' | 'compare' | 'doc-and-tasks' | 'focus' | 'compare-items';

/** Keyword intent classification. Deterministic; documented as such in the UI. */
export function classifyIntent(intent: string, profile: Pick<Profile, 'keyboardFirst' | 'density'>): Layout {
  const s = intent.toLowerCase();
  if (/\b(compare two|two tasks|these two|difference|differences|versus|vs)\b/.test(s)) return 'compare-items';
  if (/\b(compare|side by side|by status|board|kanban|columns?)\b/.test(s)) return 'compare';
  if (/\b(guide|guided|step|simple|one at a time|walk me|large)\b/.test(s)) return 'guided-edit';
  if (/\b(focus|attention|urgent|priorit\w*|important|next|today|right now)\b/.test(s)) return 'focus';
  if (/\b(doc|document|together|with (its|the) tasks|notes)\b/.test(s)) return 'doc-and-tasks';
  if (/\b(compact|keyboard|shortcut|expert|dense|fast)\b/.test(s) || profile.keyboardFirst || profile.density === 'compact') return 'compact-list';
  return 'doc-and-tasks';
}

export function deterministicSurface(intent: string, profile: Profile, caps: Capability[], state: ObservedState): UISurface {
  const appCaps = caps.filter((c) => c.appId === state.appId);
  const has = (op: string) => appCaps.find((c) => c.operation === op);
  const update = has('task.update');
  const create = has('task.create');
  const layout = classifyIntent(intent, profile);
  // Everything app-specific (status values, editable fields) comes from the capability registry.
  const statuses = update?.argumentSchema.status?.values ?? [];
  const editFields = update ? Object.keys(update.argumentSchema) : [];
  const createFields = create ? Object.keys(create.argumentSchema) : [];
  const listFields = ['title', ...(statuses.length ? ['status'] : []), ...(editFields.includes('priority') ? ['priority'] : [])];
  const hasDoc = (state.collections.paragraphs ?? []).length > 0;
  const statusFilter: UINode | null = statuses.length ? { component: 'filter', bind: 'tasks', props: { field: 'status', options: ['all', ...statuses] } } : null;
  const unsupported: UINode = { component: 'unsupported', props: { operation: 'Delete task', reason: 'Not available through this adapter. Use the original app.' } };
  const createCard: UINode | null = create
    ? { component: 'card', props: { title: 'Add a task', pinned: profile.pinnedControls.includes(`create-form:${create.id}`) }, children: [{ component: 'create-form', capabilityId: create.id, props: { fields: createFields } }] }
    : null;
  const editNode = (guided: boolean): UINode | null =>
    update ? { component: 'edit-form', capabilityId: update.id, bind: 'tasks', props: { fields: editFields, guided } } : null;
  const compact = profile.density === 'compact';

  let children: (UINode | null)[];
  let title: string;
  let rationale: string;
  const ranked = !!state.collectionRoles?.tasks?.rankOrder;
  switch (layout) {
    case 'focus':
      title = 'What needs attention';
      rationale = ranked ? 'You asked what needs attention: open tasks, most important first, with one next step.' : 'You asked what needs attention: the open tasks, with one next step.';
      children = [
        { component: 'attention', bind: 'tasks', props: { fields: ['title'], limit: 0 } },
        update ? { component: 'card', props: { title: 'Change the selected task' }, children: [editNode(false)!] } : null,
      ];
      break;
    case 'compact-list':
      title = 'Compact task list';
      rationale = 'You asked for a dense, keyboard-first view.';
      children = [
        { component: 'shortcut-help' },
        statusFilter,
        { component: 'list', bind: 'tasks', props: { fields: listFields, compact: true, shortcutKeys: true } },
        editNode(false),
        createCard,
      ];
      break;
    case 'guided-edit':
      title = 'Guided task editing';
      rationale = 'You asked for a step-by-step way to change one task at a time.';
      children = [
        update
          ? { component: 'guided-task', bind: 'tasks', capabilityId: update.id, props: { fields: ['title', ...editFields.filter((f) => f !== 'title')] } }
          : { component: 'list', bind: 'tasks', props: { fields: listFields.slice(0, 2), compact: false } },
      ];
      break;
    case 'compare-items':
      title = 'Compare two tasks';
      rationale = 'You asked to compare two tasks: choose two and see them field by field.';
      children = [{ component: 'compare-items', bind: 'tasks', props: { fields: listFields } }];
      break;
    case 'compare':
      title = 'Tasks by status';
      rationale = 'You asked to compare tasks side by side.';
      children = [
        statuses.length ? { component: 'compare', bind: 'tasks', props: { field: 'status', groups: statuses } } : { component: 'table', bind: 'tasks', props: { fields: listFields } },
        editNode(false),
        createCard,
      ];
      break;
    default: {
      title = hasDoc ? 'Document and its tasks' : 'Tasks overview';
      rationale = hasDoc ? 'Shows the document next to its open tasks.' : 'Shows the project tasks with editing and adding together.';
      const tasksCard: UINode = { component: 'card', props: { title: 'Tasks' }, children: [statusFilter, { component: 'list', bind: 'tasks', props: { fields: listFields, compact } }].filter((n): n is UINode => !!n) };
      children = [
        hasDoc
          ? { component: 'columns', props: { count: 2 }, children: [{ component: 'card', props: { title: 'Document' }, children: [{ component: 'list', bind: 'paragraphs', props: { fields: ['text'], compact } }] }, tasksCard] }
          : tasksCard,
        editNode(false),
        createCard,
      ];
    }
  }
  const nodes = children.filter((n): n is UINode => !!n);
  nodes.unshift({ component: 'provenance' });
  nodes.push(unsupported, { component: 'origin-link', props: { label: 'Open in original app' } });

  const used = [update, create].filter((c): c is Capability => !!c).map((c) => c.id);
  return {
    schemaVersion: UI_SCHEMA_VERSION,
    surfaceId: `${layout}-${state.appId}`,
    title,
    generatedBy: 'deterministic-fallback',
    rationale,
    bindings: { adapterId: appCaps[0]?.adapterId ?? '', adapterVersion: appCaps[0]?.adapterVersion ?? '', capabilityIds: used },
    root: { component: 'stack', children: nodes },
  };
}

export interface PlanResult {
  surface: UISurface;
  source: 'model' | 'deterministic-fallback';
  notes: string[];
}

export async function planSurface(
  intent: string,
  profile: Profile,
  caps: Capability[],
  state: ObservedState,
  gateway?: ModelGateway | null,
  timeoutMs = 8000,
  cancel?: AbortSignal,
): Promise<PlanResult> {
  const collections = stateFields(state); // names + declared/observed field names, so field references are checked
  caps = caps.filter((c) => c.appId === state.appId);
  const notes: string[] = [];
  if (gateway) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onCancel = () => ctl.abort();
    if (cancel?.aborted) ctl.abort(); else cancel?.addEventListener('abort', onCancel, { once: true });
    try {
      const raw = await gateway.generate(buildContext(intent, profile, caps, state), ctl.signal);
      const v = validateSurface(raw, caps, collections);
      if (v.ok && v.value) {
        if (v.value.generatedBy !== 'model') v.value.generatedBy = 'model';
        return { surface: v.value, source: 'model', notes };
      }
      notes.push(`Model output rejected: ${v.errors.slice(0, 5).join('; ')}`);
    } catch (e) {
      notes.push(`Model unavailable: ${String((e as Error).message ?? e)}`);
    } finally {
      clearTimeout(timer);
      cancel?.removeEventListener('abort', onCancel);
    }
  } else {
    notes.push('No model gateway configured; using deterministic layout.');
  }
  const surface = deterministicSurface(intent, profile, caps, state);
  const v = validateSurface(surface, caps, collections);
  if (!v.ok) throw new Error(`deterministic surface invalid: ${v.errors.join('; ')}`);
  return { surface, source: 'deterministic-fallback', notes };
}
