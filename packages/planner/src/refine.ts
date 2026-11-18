// Refine a proposed layout with plain requests ("more compact, show priority first, hide status") by applying
// small deterministic edits to the proposal itself. Pure: no network, no model. The caller validates the result
// with the extension's validator before showing it; anything not understood is reported, never guessed.
import type { Capability, ObservedState } from '../../schemas/src/contracts.ts';
import type { UISurface, UINode } from '../../schemas/src/ui-schema.ts';

export interface RefineResult {
  surface: UISurface;
  /** Plain-language notes of what changed, in order. */
  changes: string[];
  /** Parts of the request that were not understood (nothing was done for them). */
  notUnderstood: string[];
}

const FIELD_COMPONENTS = new Set(['list', 'table', 'attention', 'compare-items']);
const SYNONYMS: Record<string, string> = { priorities: 'priority', importance: 'priority', statuses: 'status', state: 'status', titles: 'title', names: 'title', name: 'title' };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function walk(n: UINode, fn: (n: UINode) => void) { fn(n); (n.children ?? []).forEach((c) => walk(c, fn)); }
function nodes(s: UISurface) { const out: UINode[] = []; walk(s.root, (n) => out.push(n)); return out; }
/** Remove nodes matching `pred` anywhere below root; drop containers left empty. Returns how many were removed. */
function removeWhere(parent: UINode, pred: (n: UINode) => boolean): number {
  let removed = 0;
  if (!parent.children) return 0;
  parent.children = parent.children.filter((c) => {
    if (pred(c)) { removed++; return false; }
    removed += removeWhere(c, pred);
    return !(c.children && c.children.length === 0 && ['card', 'columns'].includes(c.component));
  });
  return removed;
}
/** Insert before the trailing unsupported/origin-link nodes. */
function insertBeforeFooter(root: UINode, node: UINode) {
  const kids = root.children ?? (root.children = []);
  let i = kids.length;
  while (i > 0 && ['origin-link', 'unsupported'].includes(kids[i - 1].component)) i--;
  kids.splice(i, 0, node);
}

export function refineSurface(base: UISurface, request: string, caps: Capability[], state: ObservedState): RefineResult | null {
  const s: UISurface = structuredClone(base);
  const changes: string[] = [];
  const notUnderstood: string[] = [];
  const appCaps = caps.filter((c) => c.appId === state.appId);
  const create = appCaps.find((c) => c.operation.endsWith('.create'));
  const knownFields = new Set([...(state.collectionSchema?.tasks ?? []), ...Object.keys(state.collections.tasks?.[0]?.fields ?? {})].filter((f) => !f.startsWith('_')));
  const fieldOf = (w: string) => { const f = SYNONYMS[w] ?? w; return knownFields.has(f) ? f : null; };
  const fieldNodes = () => nodes(s).filter((n) => FIELD_COMPONENTS.has(n.component));
  const fieldsOf = (n: UINode) => ((n.props?.fields as string[] | undefined) ?? ['title']).slice();
  const setFields = (n: UINode, f: string[]) => { n.props = { ...(n.props ?? {}), fields: f }; };

  const clauses = request.toLowerCase().split(/,|;|\band then\b|\bthen\b|\band\b(?=\s+(?:show|hide|add|remove|make|only|top|just|without|put|move|no)\b)/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    let m: RegExpMatchArray | null;
    if (/\b(remove|hide|without|no|drop)\b.*\b(creat\w*|adding|new tasks?)\b/.test(clause)) {
      const n = removeWhere(s.root, (x) => x.component === 'create-form');
      if (n) { s.bindings.capabilityIds = s.bindings.capabilityIds.filter((id) => id !== create?.id); changes.push('Removed the form for adding tasks'); } else changes.push('There was no form for adding tasks to remove');
    } else if (/\b(add|include|let me|show)\b.*\b(creat\w*|adding|add tasks?|new tasks?)\b/.test(clause)) {
      if (nodes(s).some((x) => x.component === 'create-form')) changes.push('The form for adding tasks is already there');
      else if (!create) notUnderstood.push(clause);
      else {
        insertBeforeFooter(s.root, { component: 'card', props: { title: 'Add a task' }, children: [{ component: 'create-form', capabilityId: create.id, props: { fields: Object.keys(create.argumentSchema) } }] });
        if (!s.bindings.capabilityIds.includes(create.id)) s.bindings.capabilityIds.push(create.id);
        changes.push('Added a form for adding tasks');
      }
    } else if (/\b(remove|hide|without|no)\b.*\b(shortcuts?|keyboard help)\b/.test(clause)) {
      const n = removeWhere(s.root, (x) => x.component === 'shortcut-help');
      fieldNodes().filter((x) => x.component === 'list').forEach((x) => { if (x.props) delete x.props.shortcutKeys; });
      changes.push(n ? 'Removed the keyboard shortcuts' : 'There were no keyboard shortcuts to remove');
    } else if (/\b(shortcuts?|keyboard)\b/.test(clause)) {
      if (!nodes(s).some((x) => x.component === 'shortcut-help')) (s.root.children ?? []).splice(1, 0, { component: 'shortcut-help' });
      fieldNodes().filter((x) => x.component === 'list').forEach((x) => { x.props = { ...(x.props ?? {}), shortcutKeys: true }; });
      changes.push('Added keyboard shortcuts');
    } else if (/\b(less compact|more space|roomier|spacious|less dense|bigger rows)\b/.test(clause)) {
      const lists = fieldNodes().filter((x) => x.component === 'list');
      lists.forEach((x) => { x.props = { ...(x.props ?? {}), compact: false }; });
      if (lists.length) changes.push('Gave the list more space'); else notUnderstood.push(clause);
    } else if (/\b(compact|denser|dense|tighter|smaller)\b/.test(clause)) {
      const lists = fieldNodes().filter((x) => x.component === 'list');
      lists.forEach((x) => { x.props = { ...(x.props ?? {}), compact: true }; });
      if (lists.length) changes.push('Made the list compact'); else notUnderstood.push(clause);
    } else if ((m = clause.match(/\b(?:top|only|just|show)\s+(\d{1,2})\b/))) {
      const k = Number(m[1]);
      const attn = fieldNodes().filter((x) => x.component === 'attention');
      if (attn.length && k >= 1 && k <= 20) { attn.forEach((x) => { x.props = { ...(x.props ?? {}), limit: k }; }); changes.push(`Showing the top ${k}`); }
      else notUnderstood.push(clause);
    } else if ((m = clause.match(/\b(?:hide|remove|without|drop|no)\s+(?:the\s+)?(\w+)/)) && fieldOf(m[1])) {
      const f = fieldOf(m[1])!;
      let did = false, refused = false;
      for (const n of fieldNodes()) {
        const fs = fieldsOf(n);
        if (!fs.includes(f)) continue;
        if (fs.length === 1) { refused = true; continue; }
        setFields(n, fs.filter((x) => x !== f)); did = true;
      }
      changes.push(did ? `Hid ${cap(f)}` : refused ? `Kept ${cap(f)}: it is the only thing shown` : `${cap(f)} was not shown`);
    } else if ((m = clause.match(/\b(?:show|add|include|put|move)\s+(?:the\s+)?(\w+)(?:\s+(?:first|at the start|on top))?/)) && fieldOf(m[1])) {
      const f = fieldOf(m[1])!;
      const first = /\b(first|at the start|on top)\b/.test(clause);
      const targets = fieldNodes().filter((n) => n.component !== 'attention' || f !== 'title');
      if (!targets.length) { notUnderstood.push(clause); continue; }
      for (const n of targets) {
        const fs = fieldsOf(n).filter((x) => x !== f);
        setFields(n, first ? [f, ...fs] : [...fs, f]);
      }
      changes.push(first ? `Showed ${cap(f)} first` : `Showed ${cap(f)}`);
    } else notUnderstood.push(clause);
  }
  if (!changes.length) return null;
  const base0 = base.rationale.replace(/ Refined: .*$/, '');
  s.rationale = `${base0} Refined: ${changes.join('; ')}.`.slice(0, 390);
  return { surface: s, changes, notUnderstood };
}
