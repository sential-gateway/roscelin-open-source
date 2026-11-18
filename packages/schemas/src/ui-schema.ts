// Declarative UI surface description. A planner (model or deterministic) produces this as DATA.
// It is never executed. The trusted renderer maps each component name to packaged code.

export const UI_SCHEMA_VERSION = 1;

export type ComponentName =
  | 'stack'
  | 'columns'
  | 'card'
  | 'heading'
  | 'text'
  | 'provenance'
  | 'list'
  | 'attention'
  | 'guided-task'
  | 'compare-items'
  | 'table'
  | 'filter'
  | 'edit-form'
  | 'create-form'
  | 'compare'
  | 'origin-link'
  | 'unsupported'
  | 'shortcut-help';

export interface UINode {
  component: ComponentName;
  props?: Record<string, string | number | boolean | string[]>;
  /** Name of an ObservedState collection this node reads. */
  bind?: string;
  /** Capability this node may invoke. Must exist in the registry. */
  capabilityId?: string;
  children?: UINode[];
}

export interface UISurface {
  schemaVersion: number;
  surfaceId: string;
  title: string;
  /** Who produced it. Shown to the user. */
  generatedBy: 'deterministic-fallback' | 'model' | 'user-saved';
  /** Plain-language reason this layout was proposed. */
  rationale: string;
  /** Capability/adapter versions this surface was built against (cache binding). */
  bindings: { adapterId: string; adapterVersion: string; capabilityIds: string[] };
  root: UINode;
}

/** Allowed props per component. Anything else is rejected, not ignored. */
export const COMPONENT_PROPS: Record<ComponentName, Record<string, 'string' | 'number' | 'boolean' | 'string[]'>> = {
  stack: { gap: 'string' },
  columns: { count: 'number' },
  card: { title: 'string', pinned: 'boolean' },
  heading: { text: 'string', level: 'number' },
  text: { text: 'string', tone: 'string' },
  provenance: {},
  list: { fields: 'string[]', compact: 'boolean', shortcutKeys: 'boolean' },
  /** Open items ranked by the collection's declared importance, each with a reason; one next action on the top item. limit 0 = all. */
  attention: { fields: 'string[]', limit: 'number' },
  /** One change as numbered steps (choose, change, review and confirm, done); carries an update capability. */
  'guided-task': { fields: 'string[]' },
  /** Pick two items and compare them field by field, differences marked. */
  'compare-items': { fields: 'string[]' },
  table: { fields: 'string[]' },
  filter: { field: 'string', options: 'string[]' },
  'edit-form': { fields: 'string[]', guided: 'boolean' },
  'create-form': { fields: 'string[]' },
  compare: { field: 'string', groups: 'string[]' },
  'origin-link': { label: 'string' },
  unsupported: { operation: 'string', reason: 'string' },
  'shortcut-help': {},
};

export const CONTAINER_COMPONENTS: ComponentName[] = ['stack', 'columns', 'card'];
export const ACTION_COMPONENTS: ComponentName[] = ['edit-form', 'create-form', 'guided-task'];

export const LIMITS = {
  maxDepth: 8,
  maxNodes: 150,
  maxString: 400,
  maxArray: 20,
  maxSerializedBytes: 64 * 1024,
};
