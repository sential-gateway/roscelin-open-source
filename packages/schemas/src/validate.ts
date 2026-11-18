import type { Capability, ActionRequest, ArgField } from './contracts.ts';
import {
  COMPONENT_PROPS,
  CONTAINER_COMPONENTS,
  ACTION_COMPONENTS,
  LIMITS,
  UI_SCHEMA_VERSION,
} from './ui-schema.ts';
import type { UISurface, UINode, ComponentName } from './ui-schema.ts';

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strings that look like script/markup injection or URLs are rejected in UI props. */
const FORBIDDEN_PATTERNS = [/<\s*script/i, /javascript:/i, /\bon\w+\s*=/i, /data:text\/html/i, /https?:\/\//i, /file:\/\//i];

function checkString(s: string, path: string, errors: string[]) {
  if (s.length > LIMITS.maxString) errors.push(`${path}: string too long`);
  for (const p of FORBIDDEN_PATTERNS) {
    if (p.test(s)) {
      errors.push(`${path}: forbidden content (${p.source})`);
      break;
    }
  }
}

/**
 * Validate a planner-produced surface against the component whitelist and the capability registry.
 * Unknown components, props, capabilities, bindings, URLs, and oversize payloads are rejected.
 */
export function validateSurface(
  input: unknown,
  registry: Capability[],
  collectionsIn: string[] | Record<string, string[] | null>,
): ValidationResult<UISurface> {
  const errors: string[] = [];
  // Names only (legacy) or name -> field names (null = unknown, e.g. an empty collection). Known field names are checked.
  const fieldsOf: Record<string, string[] | null> | null = Array.isArray(collectionsIn) ? null : collectionsIn;
  const collections = Array.isArray(collectionsIn) ? collectionsIn : Object.keys(collectionsIn);
  let serialized: string;
  try {
    serialized = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    return { ok: false, errors: ['unserializable surface'] };
  }
  if (serialized.length > LIMITS.maxSerializedBytes) return { ok: false, errors: ['surface exceeds size limit'] };

  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      return { ok: false, errors: ['malformed JSON'] };
    }
  }
  if (!isObj(data)) return { ok: false, errors: ['surface must be an object'] };

  const allowedTop = new Set(['schemaVersion', 'surfaceId', 'title', 'generatedBy', 'rationale', 'bindings', 'root']);
  for (const k of Object.keys(data)) if (!allowedTop.has(k)) errors.push(`unknown top-level key: ${k}`);
  if (data.schemaVersion !== UI_SCHEMA_VERSION) errors.push('unsupported schemaVersion');
  for (const k of ['surfaceId', 'title', 'rationale'] as const) {
    if (typeof data[k] !== 'string') errors.push(`${k} must be a string`);
    else checkString(data[k] as string, k, errors);
  }
  if (!['deterministic-fallback', 'model', 'user-saved'].includes(data.generatedBy as string)) errors.push('invalid generatedBy');

  const capIds = new Set(registry.map((c) => c.id));
  const b = data.bindings;
  if (!isObj(b) || typeof b.adapterId !== 'string' || typeof b.adapterVersion !== 'string' || !Array.isArray(b.capabilityIds)) {
    errors.push('invalid bindings');
  } else {
    // Surfaces currently target exactly one reviewed adapter version.
    const active = registry[0];
    if (!active || registry.some(c => c.adapterId !== active.adapterId || c.adapterVersion !== active.adapterVersion) || b.adapterId !== active.adapterId || b.adapterVersion !== active.adapterVersion) errors.push('bindings adapter identity/version does not match active registry');
    for (const id of b.capabilityIds) if (!capIds.has(id as string)) errors.push(`bindings references unknown capability: ${String(id)}`);
  }

  let count = 0;
  const walk = (n: unknown, depth: number, path: string) => {
    count++;
    if (count > LIMITS.maxNodes) {
      if (count === LIMITS.maxNodes + 1) errors.push('too many nodes');
      return;
    }
    if (depth > LIMITS.maxDepth) {
      errors.push(`${path}: nesting too deep`);
      return;
    }
    if (!isObj(n)) {
      errors.push(`${path}: node must be an object`);
      return;
    }
    for (const k of Object.keys(n)) {
      if (!['component', 'props', 'bind', 'capabilityId', 'children'].includes(k)) errors.push(`${path}: unknown node key ${k}`);
    }
    const comp = n.component as ComponentName;
    const propSpec = COMPONENT_PROPS[comp];
    if (!propSpec) {
      errors.push(`${path}: unknown component ${String(n.component)}`);
      return;
    }
    if (n.props !== undefined) {
      if (!isObj(n.props)) errors.push(`${path}.props must be an object`);
      else
        for (const [pk, pv] of Object.entries(n.props)) {
          const t = propSpec[pk];
          if (!t) {
            errors.push(`${path}.props.${pk}: not allowed for ${comp}`);
            continue;
          }
          if (t === 'string[]') {
            if (!Array.isArray(pv) || pv.some((x) => typeof x !== 'string')) errors.push(`${path}.props.${pk}: expected string[]`);
            else if (pv.length > LIMITS.maxArray) errors.push(`${path}.props.${pk}: array too long`);
            else pv.forEach((x, i) => checkString(x as string, `${path}.props.${pk}[${i}]`, errors));
          } else if (typeof pv !== t) errors.push(`${path}.props.${pk}: expected ${t}`);
          else if (t === 'string') checkString(pv as string, `${path}.props.${pk}`, errors);
        }
    }
    if (n.bind !== undefined && (typeof n.bind !== 'string' || !collections.includes(n.bind))) {
      errors.push(`${path}: unsupported binding ${String(n.bind)}`);
    }
    if (n.capabilityId !== undefined) {
      if (typeof n.capabilityId !== 'string' || !capIds.has(n.capabilityId)) {
        errors.push(`${path}: unknown capability ${String(n.capabilityId)}`);
      } else if (!ACTION_COMPONENTS.includes(comp)) {
        errors.push(`${path}: ${comp} cannot carry a capability`);
      } else if (isObj(b) && Array.isArray(b.capabilityIds) && !b.capabilityIds.includes(n.capabilityId)) {
        errors.push(`${path}: capability not declared in bindings`);
      }
    }
    if (ACTION_COMPONENTS.includes(comp) && n.capabilityId === undefined) errors.push(`${path}: ${comp} requires capabilityId`);
    if (n.children !== undefined) {
      if (!CONTAINER_COMPONENTS.includes(comp)) errors.push(`${path}: ${comp} cannot have children`);
      else if (!Array.isArray(n.children)) errors.push(`${path}.children must be an array`);
      else n.children.forEach((c, i) => walk(c, depth + 1, `${path}.children[${i}]`));
    }
  };
  walk(data.root, 1, 'root');
  if (!errors.length) semanticChecks(data as unknown as UISurface, registry, fieldsOf, errors);

  return errors.length ? { ok: false, errors } : { ok: true, value: data as unknown as UISurface, errors };
}

export function validateArgs(cap: Capability, args: unknown): ValidationResult<Record<string, string | number | boolean>> {
  const errors: string[] = [];
  if (!isObj(args)) return { ok: false, errors: ['args must be an object'] };
  for (const k of Object.keys(args)) if (!cap.argumentSchema[k]) errors.push(`unexpected arg ${k}`);
  for (const [k, spec] of Object.entries(cap.argumentSchema) as [string, ArgField][]) {
    const v = args[k];
    if (v === undefined) {
      if (spec.required) errors.push(`missing arg ${k}`);
      continue;
    }
    if (spec.type === 'enum') {
      if (typeof v !== 'string' || !spec.values?.includes(v)) errors.push(`${k}: not an allowed value`);
    } else if (typeof v !== spec.type) errors.push(`${k}: expected ${spec.type}`);
    else if (spec.type === 'string') {
      const s = v as string;
      if (spec.maxLength !== undefined && s.length > spec.maxLength) errors.push(`${k}: too long`);
      if (spec.required && s.trim() === '') errors.push(`${k}: empty`);
    } else if (spec.type === 'number') {
      const n = v as number;
      if (!Number.isFinite(n)) errors.push(`${k}: not finite`);
      if (spec.min !== undefined && n < spec.min) errors.push(`${k}: below min`);
      if (spec.max !== undefined && n > spec.max) errors.push(`${k}: above max`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: args as Record<string, string | number | boolean>, errors };
}

export function validateActionRequestShape(r: unknown): ValidationResult<ActionRequest> {
  const errors: string[] = [];
  if (!isObj(r)) return { ok: false, errors: ['request must be an object'] };
  if (typeof r.actionId !== 'string' || !/^[a-zA-Z0-9-]{8,64}$/.test(r.actionId)) errors.push('invalid actionId');
  if (typeof r.capabilityId !== 'string') errors.push('invalid capabilityId');
  const t = r.target;
  if (!isObj(t) || typeof t.appId !== 'string' || typeof t.origin !== 'string' || typeof t.documentInstanceId !== 'string') errors.push('invalid target');
  if (r.expectedRevision !== null && typeof r.expectedRevision !== 'number') errors.push('invalid expectedRevision');
  if (r.approvalToken !== null && typeof r.approvalToken !== 'string') errors.push('invalid approvalToken');
  if (typeof r.createdAt !== 'number' || typeof r.expiresAt !== 'number') errors.push('invalid timestamps');
  if (!isObj(r.args)) errors.push('invalid args');
  return errors.length ? { ok: false, errors } : { ok: true, value: r as unknown as ActionRequest, errors };
}

/**
 * Field names per collection. Adapter-declared fields (`schema`) are authoritative, including for empty
 * collections. Without a declaration: the union of observed object fields (adapter-internal `_` fields excluded);
 * an empty undeclared collection maps to null (unknown) and field checks are skipped for it.
 */
export function collectionFields(collections: Record<string, { fields: Record<string, unknown> }[]>, schema?: Record<string, string[]>): Record<string, string[] | null> {
  const out: Record<string, string[] | null> = {};
  for (const [name, objs] of Object.entries(collections)) {
    if (schema?.[name]) { out[name] = schema[name].filter((f) => !f.startsWith('_')); continue; }
    if (!objs.length) { out[name] = null; continue; }
    const set = new Set<string>();
    for (const o of objs) for (const f of Object.keys(o.fields ?? {})) if (!f.startsWith('_')) set.add(f);
    out[name] = [...set];
  }
  return out;
}

export const TONES = ['plain', 'info', 'warn'];
export const GAPS = ['none', 'small', 'medium', 'large'];
/** Components a person can select an object from (the renderer's selection sources). */
const SELECT_SOURCES: ComponentName[] = ['list', 'compare', 'attention', 'guided-task'];
/** Components that show a collection, which a filter can narrow. */
const VIEW_SOURCES: ComponentName[] = ['list', 'table', 'compare', 'attention', 'guided-task', 'compare-items'];
const ACTION_OPERATION: Partial<Record<ComponentName, string>> = { 'edit-form': 'update', 'create-form': 'create', 'guided-task': 'update' };

/**
 * Meaning-level checks that run after the structural walk passed:
 * - dependencies: an edit-form needs a selectable list/compare on the same collection; a filter needs a view of
 *   its collection; model layouts start with a provenance banner;
 * - action types: edit-form carries an update capability, create-form a create capability (never read/prohibited);
 * - field names: list/table fields and filter/compare field exist in the bound collection (when field names are
 *   known); form fields exist in the capability's arguments;
 * - values: filter options / compare groups are known values of that field ('all' allowed for filters);
 * - ranges and styles: columns.count and heading.level are integers 1-4; text.tone and stack.gap from fixed sets.
 */
function semanticChecks(s: UISurface, registry: Capability[], fieldsOf: Record<string, string[] | null> | null, errors: string[]) {
  const caps = new Map(registry.map((c) => [c.id, c]));
  const knownValues = (field: string): string[] | null => {
    const vals = new Set<string>();
    for (const c of registry) for (const v of c.argumentSchema[field]?.values ?? []) vals.add(v);
    return vals.size ? [...vals] : null;
  };
  const nodes: { n: UINode; path: string }[] = [];
  const collect = (n: UINode, path: string) => { nodes.push({ n, path }); (n.children ?? []).forEach((c, i) => collect(c, `${path}.children[${i}]`)); };
  collect(s.root, 'root');
  const has = (comps: ComponentName[], bind: string | undefined) => nodes.some(({ n }) => comps.includes(n.component) && n.bind === bind);
  const fieldOk = (bind: string | undefined, f: string) => { const known = fieldsOf && bind ? fieldsOf[bind] : null; return !known || known.includes(f); };

  if (s.generatedBy === 'model' && s.root.children?.[0]?.component !== 'provenance') errors.push('root.children[0]: model layouts must start with provenance');

  for (const { n, path } of nodes) {
    const p = (n.props ?? {}) as Record<string, unknown>;
    const want = ACTION_OPERATION[n.component];
    if (want && n.capabilityId) {
      const cap = caps.get(n.capabilityId);
      if (cap && (cap.riskClass === 'read' || cap.riskClass === 'prohibited' || cap.operation.split('.').pop() !== want)) {
        errors.push(`${path}: ${n.component} needs a ${want} capability, not ${cap.operation} (${cap.riskClass})`);
      }
      for (const f of (p.fields as string[] | undefined) ?? []) if (cap && !(f in cap.argumentSchema)) errors.push(`${path}.props.fields: ${f} is not an argument of ${cap.id}`);
    }
    if (n.component === 'edit-form') {
      if (!n.bind) errors.push(`${path}: edit-form needs bind`);
      else if (!has(SELECT_SOURCES, n.bind)) errors.push(`${path}: edit-form needs a list, compare or attention bound to ${n.bind} to choose from`);
    }
    if (n.component === 'filter') {
      if (!n.bind) errors.push(`${path}: filter needs bind`);
      else if (!has(VIEW_SOURCES, n.bind)) errors.push(`${path}: filter needs a list, table or compare bound to ${n.bind}`);
    }
    if ((n.component === 'guided-task' || n.component === 'compare-items') && !n.bind) errors.push(`${path}: ${n.component} needs bind`);
    if (n.component === 'attention') {
      if (!n.bind) errors.push(`${path}: attention needs bind`);
      if (p.limit !== undefined && !(Number.isInteger(p.limit) && (p.limit as number) >= 0 && (p.limit as number) <= 20)) errors.push(`${path}.props.limit: must be an integer 0-20 (0 = all)`);
    }
    if (n.component === 'list' || n.component === 'table' || n.component === 'attention' || n.component === 'compare-items') {
      for (const f of (p.fields as string[] | undefined) ?? []) if (!fieldOk(n.bind, f)) errors.push(`${path}.props.fields: ${f} is not a field of ${n.bind}`);
    }
    if (n.component === 'filter' || n.component === 'compare') {
      const field = p.field as string | undefined;
      const list = (n.component === 'filter' ? p.options : p.groups) as string[] | undefined;
      const key = n.component === 'filter' ? 'options' : 'groups';
      if (field === undefined) errors.push(`${path}: ${n.component} needs props.field`);
      else {
        if (!fieldOk(n.bind, field)) errors.push(`${path}.props.field: ${field} is not a field of ${n.bind}`);
        const known = knownValues(field);
        if (!known && (list ?? []).some((v) => v !== 'all')) errors.push(`${path}.props.${key}: ${field} has no known values to ${n.component === 'filter' ? 'filter' : 'group'} by`);
        for (const v of list ?? []) if (known && !(known.includes(v) || (n.component === 'filter' && v === 'all'))) errors.push(`${path}.props.${key}: ${v} is not a known ${field} value`);
      }
    }
    if (n.component === 'columns' && p.count !== undefined && !(Number.isInteger(p.count) && (p.count as number) >= 1 && (p.count as number) <= 4)) errors.push(`${path}.props.count: must be an integer 1-4`);
    if (n.component === 'heading' && p.level !== undefined && !(Number.isInteger(p.level) && (p.level as number) >= 1 && (p.level as number) <= 4)) errors.push(`${path}.props.level: must be an integer 1-4`);
    if (n.component === 'text' && p.tone !== undefined && !TONES.includes(p.tone as string)) errors.push(`${path}.props.tone: must be one of ${TONES.join(', ')}`);
    if (n.component === 'stack' && p.gap !== undefined && !GAPS.includes(p.gap as string)) errors.push(`${path}.props.gap: must be one of ${GAPS.join(', ')}`);
  }
}

/** Field names for an observed state, preferring the adapter's declared schema. */
export function stateFields(state: { collections: Record<string, { fields: Record<string, unknown> }[]>; collectionSchema?: Record<string, string[]> }) {
  return collectionFields(state.collections, state.collectionSchema);
}
