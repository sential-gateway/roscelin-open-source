// Trusted renderer: maps validated UISurface component names to packaged DOM code.
// Never uses innerHTML. All app-derived text goes through textContent.
// Approval UI is NOT rendered here; it lives in the extension shell (sidepanel.ts).

import type { Capability, ObservedState, ObservedObject, CollectionRoles } from '../../schemas/src/contracts.ts';
import type { UISurface, UINode } from '../../schemas/src/ui-schema.ts';
import type { Profile } from '../../schemas/src/profile.ts';

export interface UIState {
  selectedId: string | null;
  filters: Record<string, string>;
  draft: Record<string, string> | null;
  draftForId: string | null;
  draftRevision: number | null;
  createDraft: Record<string, string>;
  /** Object whose last change was verified by reading the app again (shown with a Confirmed mark). */
  verifiedId?: string | null;
  /** Up to two objects chosen for a field-by-field comparison. */
  compareIds?: string[];
}

export interface RenderCtx {
  state: ObservedState;
  profile: Profile;
  ui: UIState;
  caps: Map<string, Capability>;
  busy: boolean;
  on: {
    select(id: string): void;
    setFilter(field: string, value: string): void;
    draftChange(field: string, value: string): void;
    createChange(field: string, value: string): void;
    save(capabilityId: string, objectId: string, args: Record<string, string>, expectedRevision: number): void;
    create(capabilityId: string, args: Record<string, string>): void;
    openOriginal(link?: string): void;
    togglePin(key: string): void;
    /** Add or remove an object from the two-item comparison (keeps the last two). */
    toggleCompare?(id: string): void;
    rerender(): void;
  };
}

type Kids = (Node | string | null | undefined | false)[];
function h(tag: string, attrs: Record<string, string | boolean | number | undefined> = {}, ...kids: Kids): HTMLElement {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids) if (k !== null && k !== undefined && k !== false) e.append(typeof k === 'string' ? document.createTextNode(k) : k);
  return e;
}

const LABELS: Record<string, Record<string, string>> = {
  plain: { title: 'Task', status: 'Status', priority: 'Priority', text: 'Text' },
  technical: { title: 'title', status: 'status', priority: 'priority', text: 'text' },
};
const label = (ctx: RenderCtx, f: string) => LABELS[ctx.profile.vocabulary]?.[f] ?? f;


/**
 * Fields + review button for changing one object, shared by edit-form and guided-task. Keeps the draft when the
 * object changed in the original app and blocks saving until it is reloaded (the broker refuses anyway).
 */
function editFormBody(ctx: RenderCtx, cap: Capability, fields: string[], obj: ObservedObject, key: string, path: string, submitLabel: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  const changedUnder = ctx.ui.draftForId === obj.objectId && ctx.ui.draftRevision !== null && ctx.ui.draftRevision !== obj.revision;
  if (changedUnder) out.push(h('p', { class: 'ai-text tone-warn', role: 'alert' }, `This task changed in the original app (rev ${ctx.ui.draftRevision} → ${obj.revision}). Your draft was kept; saving will be refused until you reload it.`));
  const form = h('form', { class: 'ai-form' }) as HTMLFormElement;
  for (const f of fields) {
    const spec = cap.argumentSchema[f];
    const id = `fld-${path}-${f}`;
    const cur = ctx.ui.draft?.[f] ?? String(obj.fields[f] ?? '');
    let input: HTMLElement;
    if (spec.type === 'enum') {
      input = h('select', { id, name: f, 'data-key': `${key}:${f}` }, ...(spec.values ?? []).map((v) => h('option', { value: v, selected: v === cur }, v)));
    } else {
      input = h('input', { id, name: f, value: cur, maxlength: spec.maxLength, 'data-key': `${key}:${f}`, autocomplete: 'off' });
    }
    input.addEventListener('input', (e) => ctx.on.draftChange(f, (e.target as HTMLInputElement).value));
    input.addEventListener('change', (e) => ctx.on.draftChange(f, (e.target as HTMLInputElement).value));
    form.append(h('label', { for: id }, label(ctx, f)), input);
  }
  const actions = h('div', { class: 'ai-row' });
  actions.append(h('button', { type: 'submit', class: 'primary', 'data-key': `${key}:review`, disabled: ctx.busy || changedUnder }, submitLabel));
  if (changedUnder) {
    const reload = h('button', { type: 'button' }, 'Reload from app');
    reload.addEventListener('click', () => ctx.on.select(obj.objectId));
    actions.append(reload);
  }
  form.append(actions);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const args: Record<string, string> = {};
    for (const f of fields) {
      const v = ctx.ui.draft?.[f];
      if (v !== undefined && v !== String(obj.fields[f] ?? '')) args[f] = v;
    }
    if (!Object.keys(args).length) return;
    ctx.on.save(cap.id, obj.objectId, args, ctx.ui.draftRevision ?? obj.revision);
  });
  out.push(form);
  return out;
}

/** Which guided step is current: 1 choose, 2 change (review happens in the review dialog), 4 done after read-back. */
export function guidedStep(ui: Pick<UIState, 'verifiedId' | 'draft'>, obj: ObservedObject | undefined): 1 | 2 | 4 {
  if (!obj) return 1;
  if (ui.verifiedId === obj.objectId && ui.draft === null) return 4;
  return 2;
}

/** Field-by-field comparison rows for two objects. */
export function compareRows(a: ObservedObject, b: ObservedObject, fields: string[]) {
  return fields.map((field) => {
    const av = String(a.fields[field] ?? ''), bv = String(b.fields[field] ?? '');
    return { field, a: av, b: bv, differs: av !== bv };
  });
}

/**
 * Pure ranking for the attention component: drop items whose status is a declared done value, then order by the
 * declared rank (most important first; unknown or unset values last; ties keep app order). Without roles: app order.
 */
export function rankAttention(items: ObservedObject[], roles?: CollectionRoles) {
  const open = roles?.status && roles.doneValues ? items.filter((o) => !roles.doneValues!.includes(String(o.fields[roles.status!]))) : items;
  const order = roles?.rank && roles.rankOrder ? roles.rankOrder : null;
  const rankOf = (o: ObservedObject) => (order ? order.indexOf(String(o.fields[roles!.rank!])) : -1);
  const ranked = order ? open.map((o, i) => ({ o, i })).sort((a, b) => rankOf(b.o) - rankOf(a.o) || a.i - b.i).map((x) => x.o) : open;
  return { open, ranked, order, rankOf };
}

function collection(ctx: RenderCtx, name: string | undefined): ObservedObject[] {
  if (!name) return [];
  const items = ctx.state.collections[name] ?? [];
  return items.filter((o) => Object.entries(ctx.ui.filters).every(([f, v]) => v === 'all' || !(f in o.fields) || String(o.fields[f]) === v));
}

function ago(ts: number) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  return m === 1 ? '1 minute ago' : `${m} minutes ago`;
}
const METHOD: Record<string, string> = { api: 'through its API', 'dom-semantic': 'from the open page', fixture: 'from test data' };
function hostOf(origin: string) { try { return new URL(origin).host; } catch { return origin; } }

function renderNode(n: UINode, ctx: RenderCtx, path: string): HTMLElement | null {
  const p = n.props ?? {};
  const key = `${n.component}:${n.capabilityId ?? n.bind ?? ''}:${path}`;
  switch (n.component) {
    case 'stack':
      return h('div', { class: 'ai-stack', 'data-key': key }, ...(n.children ?? []).map((c, i) => renderNode(c, ctx, `${path}.${i}`)));
    case 'columns':
      return h('div', { class: 'ai-columns', style: `--cols:${Math.min(4, Math.max(1, Number(p.count ?? 2)))}` }, ...(n.children ?? []).map((c, i) => renderNode(c, ctx, `${path}.${i}`)));
    case 'card': {
      const pinKey = (n.children ?? []).map((c) => `${c.component}:${c.capabilityId ?? ''}`).join('|');
      const pinned = ctx.profile.pinnedControls.includes(pinKey);
      const pin = h('button', { class: 'ai-pin', type: 'button', 'aria-pressed': String(pinned), title: pinned ? 'Unpin' : 'Pin' }, pinned ? 'Pinned' : 'Pin');
      pin.addEventListener('click', () => ctx.on.togglePin(pinKey));
      return h('section', { class: `ai-card${pinned ? ' pinned' : ''}`, 'aria-label': String(p.title ?? '') },
        h('header', {}, h('h3', {}, String(p.title ?? '')), pin),
        ...(n.children ?? []).map((c, i) => renderNode(c, ctx, `${path}.${i}`)));
    }
    case 'heading':
      return h(`h${Math.min(4, Math.max(2, Number(p.level ?? 2)))}`, {}, String(p.text ?? ''));
    case 'text':
      return h('p', { class: `ai-text tone-${String(p.tone ?? 'plain')}` }, String(p.text ?? ''));
    case 'provenance': {
      const s = ctx.state;
      return h('div', { class: 'ai-provenance', role: 'note', 'data-revision': String(s.workspaceRevision) },
        h('strong', {}, s.documentTitle || 'Untitled'), ` in ${s.appName}`,
        h('br'), `Read ${ago(s.observedAt)} from ${hostOf(s.origin)} ${METHOD[s.sourceMethod] ?? `(${s.sourceMethod})`}`);
    }
    case 'filter': {
      const field = String(p.field ?? 'status');
      const opts = (p.options as string[]) ?? ['all'];
      const cur = ctx.ui.filters[field] ?? 'all';
      const group = h('div', { class: 'ai-segmented', role: 'radiogroup', 'aria-label': `Filter by ${label(ctx, field)}` });
      opts.forEach((o) => {
        const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(o === cur), tabindex: o === cur || (!opts.includes(cur) && o === opts[0]) ? 0 : -1, 'data-key': `${key}:${o}` }, o);
        b.addEventListener('click', () => ctx.on.setFilter(field, o));
        b.addEventListener('keydown',e=>{
          if(!['ArrowRight','ArrowDown','ArrowLeft','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();
          const index=opts.indexOf(o),delta=['ArrowRight','ArrowDown'].includes(e.key)?1:-1;
          const next=e.key==='Home'?0:e.key==='End'?opts.length-1:(index+delta+opts.length)%opts.length;
          (group.children[next] as HTMLElement).focus();ctx.on.setFilter(field,opts[next]);
        });
        group.append(b);
      });
      return group;
    }
    case 'list': {
      const fields = (p.fields as string[]) ?? ['title'];
      const items = collection(ctx, n.bind);
      const selectable = n.bind === 'tasks';
      const ul = h('ul', { class: `ai-list${p.compact ? ' compact' : ''}`, role: selectable ? 'listbox' : 'list', 'aria-label': n.bind ?? 'list' });
      if (!items.length) ul.append(h('li', { class: 'ai-empty' }, `No ${n.bind ?? 'items'} yet.`));
      items.forEach((o, idx) => {
        const sel = ctx.ui.selectedId === o.objectId;
        const cells: HTMLElement[] = fields.map((f) => h('span', { class: `f f-${f}` }, String(o.fields[f] ?? '')));
        const verified = ctx.ui.verifiedId === o.objectId;
        if (verified) cells.push(h('span', { class: 'f-verified', title: `Confirmed by reading ${ctx.state.appName} again` }, 'Confirmed'));
        if (selectable) {
          const li = h('li', { role: 'option', class: verified ? 'is-verified' : undefined, 'aria-selected': String(sel), tabindex: sel || (!items.some(item => item.objectId === ctx.ui.selectedId) && idx === 0) ? '0' : '-1', 'data-key': `obj:${o.objectId}`, 'data-id': o.objectId }, ...cells);
          li.addEventListener('click', () => ctx.on.select(o.objectId));
          li.addEventListener('keydown', (e) => {
            const k = (e as KeyboardEvent).key;
            if (k === 'Enter' || k === ' ') { e.preventDefault(); ctx.on.select(o.objectId); }
            if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); (li.nextElementSibling as HTMLElement | null)?.focus(); }
            if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); (li.previousElementSibling as HTMLElement | null)?.focus(); }
          });
          li.addEventListener('keydown',e=>{if(e.key==='Home'||e.key==='End'){e.preventDefault();((e.key==='Home'?ul.firstElementChild:ul.lastElementChild) as HTMLElement)?.focus();}});
          ul.append(li);
        } else ul.append(h('li', {}, ...cells));
      });
      return ul;
    }
    case 'attention': {
      // Open items ranked by the adapter's declared importance (collectionRoles), each with the reason it is
      // here, and one clear next action on the top item. Without declared roles: open items in their app order.
      const roles = ctx.state.collectionRoles?.[n.bind ?? ''];
      const fields = (p.fields as string[]) ?? ['title'];
      const noun = n.bind ?? 'items';
      const one = noun.replace(/s$/, '');
      const { open, ranked, order, rankOf } = rankAttention(collection(ctx, n.bind), roles);
      const limit = Number(p.limit ?? 0);
      const shown = limit > 0 ? ranked.slice(0, limit) : ranked;
      const reason = (o: ObservedObject) => {
        if (!order || !roles?.rank) return 'Open';
        const v = String(o.fields[roles.rank] ?? '');
        const name = label(ctx, roles.rank);
        return !v || v === 'unset' || rankOf(o) < 0 ? `No ${name.toLowerCase()} set` : `${name}: ${v}`;
      };
      const section = h('section', { class: 'ai-attention', 'aria-label': 'Needs your attention' });
      section.append(h('p', { class: 'ai-attention-summary' }, !open.length
        ? `Nothing needs your attention: every ${one} is done.`
        : `${open.length} open ${open.length === 1 ? one : noun}${order ? ', most important first' : ''}${shown.length < open.length ? ` (showing ${shown.length})` : ''}.`));
      if (!shown.length) return section;
      const top = shown[0];
      const startBtn = h('button', { type: 'button', class: 'primary', 'data-key': `${key}:start` }, `Work on this ${one}`);
      startBtn.addEventListener('click', () => ctx.on.select(top.objectId));
      section.append(h('div', { class: `ai-attention-top${ctx.ui.selectedId === top.objectId ? ' is-selected' : ''}`, 'data-top-id': top.objectId },
        h('p', { class: 'ai-attention-label' }, 'Start here'),
        h('h3', {}, String(top.fields.title ?? top.objectId)),
        h('p', { class: 'ai-meta' }, reason(top)),
        startBtn));
      const rest = shown.slice(1);
      if (rest.length) {
        const ul = h('ul', { class: 'ai-list ai-attention-rest', role: 'listbox', 'aria-label': `Other open ${noun}, most important first` });
        rest.forEach((o, idx) => {
          const sel = ctx.ui.selectedId === o.objectId;
          const verified = ctx.ui.verifiedId === o.objectId;
          const cells: HTMLElement[] = fields.map((f) => h('span', { class: `f f-${f}` }, String(o.fields[f] ?? '')));
          cells.push(h('span', { class: 'f-reason' }, reason(o)));
          if (verified) cells.push(h('span', { class: 'f-verified', title: `Confirmed by reading ${ctx.state.appName} again` }, 'Confirmed'));
          const li = h('li', { role: 'option', class: verified ? 'is-verified' : undefined, 'aria-selected': String(sel), tabindex: sel || (!rest.some((x) => x.objectId === ctx.ui.selectedId) && idx === 0) ? '0' : '-1', 'data-key': `obj:${o.objectId}`, 'data-id': o.objectId }, ...cells);
          li.addEventListener('click', () => ctx.on.select(o.objectId));
          li.addEventListener('keydown', (e) => {
            const k = e.key;
            if (k === 'Enter' || k === ' ') { e.preventDefault(); ctx.on.select(o.objectId); }
            if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); (li.nextElementSibling as HTMLElement | null)?.focus(); }
            if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); (li.previousElementSibling as HTMLElement | null)?.focus(); }
            if (k === 'Home' || k === 'End') { e.preventDefault(); ((k === 'Home' ? ul.firstElementChild : ul.lastElementChild) as HTMLElement | null)?.focus(); }
          });
          ul.append(li);
        });
        section.append(h('p', { class: 'ai-attention-next' }, 'Then'), ul);
      }
      return section;
    }
    case 'guided-task': {
      // One change as numbered steps; only the current step is open. Review and confirm happen in the review dialog.
      const cap = ctx.caps.get(n.capabilityId ?? '');
      if (!cap) return null;
      const fields = ((p.fields as string[]) ?? []).filter((f) => f in cap.argumentSchema);
      const one = (n.bind ?? 'items').replace(/s$/, '');
      const items = collection(ctx, n.bind);
      const obj = (ctx.state.collections[n.bind ?? 'tasks'] ?? []).find((o) => o.objectId === ctx.ui.selectedId);
      const step = guidedStep(ctx.ui, obj);
      const title = obj ? String(obj.fields.title ?? obj.objectId) : '';
      const stepItem = (num: number, name: string, state: 'done' | 'current' | 'upcoming', ...content: (HTMLElement | null)[]) =>
        h('li', { class: `ai-step is-${state}`, 'aria-current': state === 'current' ? 'step' : undefined },
          h('h3', { class: 'ai-step-title', ...(state === 'current' ? { tabindex: '-1', 'data-autofocus': true, 'data-key': `${key}:step${num}` } : {}) },
            h('span', { class: 'ai-step-num', 'aria-hidden': 'true' }, state === 'done' ? '✓' : String(num)),
            h('span', {}, `Step ${num} of 4: ${name}`), state === 'done' ? h('span', { class: 'ai-sr' }, ' (done)') : null),
          ...content);
      const ol = h('ol', { class: 'ai-steps', 'aria-label': `Change one ${one}, step by step` });
      if (step === 1) {
        const ul = h('ul', { class: 'ai-list', role: 'listbox', 'aria-label': `Choose a ${one}` });
        if (!items.length) ul.append(h('li', { class: 'ai-empty' }, `No ${n.bind ?? 'items'} yet.`));
        items.forEach((o, idx) => {
          const li = h('li', { role: 'option', 'aria-selected': 'false', tabindex: idx === 0 ? '0' : '-1', 'data-key': `obj:${o.objectId}`, 'data-id': o.objectId },
            h('span', { class: 'f f-title' }, String(o.fields.title ?? '')), ...fields.filter((f) => f !== 'title').map((f) => h('span', { class: `f f-${f}` }, String(o.fields[f] ?? ''))));
          li.addEventListener('click', () => ctx.on.select(o.objectId));
          li.addEventListener('keydown', (e) => {
            const k = e.key;
            if (k === 'Enter' || k === ' ') { e.preventDefault(); ctx.on.select(o.objectId); }
            if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); (li.nextElementSibling as HTMLElement | null)?.focus(); }
            if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); (li.previousElementSibling as HTMLElement | null)?.focus(); }
            if (k === 'Home' || k === 'End') { e.preventDefault(); ((k === 'Home' ? ul.firstElementChild : ul.lastElementChild) as HTMLElement | null)?.focus(); }
          });
          ul.append(li);
        });
        ol.append(stepItem(1, `choose a ${one}`, 'current', ul));
      } else {
        const back = h('button', { type: 'button', 'data-key': `${key}:back` }, `Choose a different ${one}`);
        back.addEventListener('click', () => ctx.on.select(''));
        ol.append(stepItem(1, `choose a ${one}`, 'done', h('p', { class: 'ai-meta' }, `Chosen: “${title}”`), step === 2 ? back : null));
      }
      if (step === 2 && obj) ol.append(stepItem(2, 'change it', 'current', ...editFormBody(ctx, cap, fields, obj, key, path, 'Next: review the change')));
      else ol.append(stepItem(2, 'change it', step === 4 ? 'done' : 'upcoming', h('p', { class: 'ai-meta' }, step === 4 ? 'Changed.' : `After you choose a ${one}.`)));
      ol.append(stepItem(3, 'review and confirm', step === 4 ? 'done' : 'upcoming',
        h('p', { class: 'ai-meta' }, step === 4 ? 'Approved by you.' : 'You see exactly what will change, then confirm it. Nothing is saved before that.')));
      if (step === 4) {
        const again = h('button', { type: 'button', class: 'primary', 'data-key': `${key}:again` }, `Change another ${one}`);
        again.addEventListener('click', () => ctx.on.select(''));
        ol.append(stepItem(4, 'done', 'current', h('p', {}, `Confirmed in ${ctx.state.appName}: “${title}” has your change.`), again));
      } else ol.append(stepItem(4, 'done', 'upcoming'));
      return h('section', { class: 'ai-card ai-guided', 'aria-label': `Change one ${one}, step by step` }, ol);
    }
    case 'compare-items': {
      // Pick two objects; see them field by field with differences marked (marked in text, not only colour).
      const fields = (p.fields as string[]) ?? ['title'];
      const noun = n.bind ?? 'items';
      const items = collection(ctx, n.bind);
      const chosen = (ctx.ui.compareIds ?? []).map((id) => items.find((o) => o.objectId === id)).filter((o): o is ObservedObject => !!o);
      const section = h('section', { class: 'ai-compare-items', 'aria-label': `Compare two ${noun}` });
      section.append(h('p', { class: 'ai-compare-summary', role: 'status' }, chosen.length < 2
        ? `Choose two ${noun} to compare (${chosen.length} of 2 chosen).`
        : `Comparing “${String(chosen[0].fields.title ?? '')}” and “${String(chosen[1].fields.title ?? '')}”.`));
      const ul = h('ul', { class: 'ai-list ai-pick', 'aria-label': `${noun} to compare` });
      items.forEach((o) => {
        const on = chosen.some((c) => c.objectId === o.objectId);
        const b = h('button', { type: 'button', class: 'ai-pick-btn', 'aria-pressed': String(on), 'data-key': `pick:${o.objectId}`, 'data-id': o.objectId }, String(o.fields.title ?? o.objectId));
        b.addEventListener('click', () => ctx.on.toggleCompare?.(o.objectId));
        ul.append(h('li', {}, b));
      });
      section.append(ul);
      if (chosen.length === 2) {
        const rows = compareRows(chosen[0], chosen[1], fields);
        const table = h('table', { class: 'ai-table ai-compare-table' },
          h('caption', {}, `${rows.filter((r) => r.differs).length} of ${rows.length} fields differ`),
          h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Field'), h('th', { scope: 'col' }, String(chosen[0].fields.title ?? 'First')), h('th', { scope: 'col' }, String(chosen[1].fields.title ?? 'Second')))),
          h('tbody', {}, ...rows.map((r) => h('tr', { class: r.differs ? 'differs' : undefined },
            h('th', { scope: 'row' }, label(ctx, r.field), r.differs ? h('span', { class: 'ai-differs' }, ' differs') : null),
            h('td', {}, r.a), h('td', {}, r.b)))));
        section.append(table);
      }
      return section;
    }
    case 'table': {
      const fields = (p.fields as string[]) ?? ['title'];
      const items = collection(ctx, n.bind);
      return h('table', { class: 'ai-table' },
        h('thead', {}, h('tr', {}, ...fields.map((f) => h('th', { scope: 'col' }, label(ctx, f))))),
        h('tbody', {}, ...items.map((o) => h('tr', {}, ...fields.map((f) => h('td', {}, String(o.fields[f] ?? '')))))));
    }
    case 'compare': {
      const field = String(p.field ?? 'status');
      const groups = (p.groups as string[]) ?? [];
      const items = collection(ctx, n.bind);
      return h('div', { class: 'ai-columns', style: `--cols:${groups.length || 1}` }, ...groups.map((g) => {
        const inG = items.filter((o) => String(o.fields[field]) === g);
        const ul = h('ul', { class: 'ai-list compact', role: 'listbox', 'aria-label': `${g} (${inG.length})` });
        inG.forEach((o) => {
          const li = h('li', { role: 'option', tabindex: '0', 'aria-selected': String(ctx.ui.selectedId === o.objectId), 'data-key': `obj:${o.objectId}` }, String(o.fields.title ?? ''));
          li.addEventListener('click', () => ctx.on.select(o.objectId));
          li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.on.select(o.objectId); } if(e.key==='ArrowDown'){e.preventDefault();(li.nextElementSibling as HTMLElement)?.focus();} if(e.key==='ArrowUp'){e.preventDefault();(li.previousElementSibling as HTMLElement)?.focus();} });
          ul.append(li);
        });
        return h('section', { class: 'ai-card' }, h('header', {}, h('h3', {}, `${g} (${inG.length})`)), ul);
      }));
    }
    case 'edit-form': {
      const cap = ctx.caps.get(n.capabilityId ?? '');
      if (!cap) return null;
      const fields = ((p.fields as string[]) ?? []).filter((f) => f in cap.argumentSchema);
      const obj = (ctx.state.collections[n.bind ?? 'tasks'] ?? []).find((o) => o.objectId === ctx.ui.selectedId);
      const wrap = h('section', { class: 'ai-card ai-edit', 'aria-label': cap.label }, h('header', {}, h('h3', {}, p.guided ? 'Step 2: change the task' : cap.label)));
      if (!obj) {
        wrap.append(h('p', { class: 'ai-text tone-info' }, p.guided ? 'Step 1: choose a task from the list.' : 'Select a task to edit it here.'));
        return wrap;
      }
      wrap.append(h('p', { class: 'ai-meta' }, `Editing “${String(obj.fields.title)}”`), ...editFormBody(ctx, cap, fields, obj, key, path, 'Review change…'));
      if (obj.link) {
        const b = h('button', { type: 'button', class: 'ai-origin' }, 'Open this task in the original app ↗');
        b.addEventListener('click', () => ctx.on.openOriginal(obj.link));
        wrap.append(b);
      }
      return wrap;
    }
    case 'create-form': {
      const cap = ctx.caps.get(n.capabilityId ?? '');
      if (!cap) return null;
      const fields = ((p.fields as string[]) ?? []).filter((f) => f in cap.argumentSchema);
      const form = h('form', { class: 'ai-form', 'aria-label': cap.label }) as HTMLFormElement;
      for (const f of fields) {
        const spec = cap.argumentSchema[f];
        const id = `new-${path}-${f}`;
        const cur = ctx.ui.createDraft[f] ?? spec.default ?? (spec.type === 'enum' ? spec.values?.[0] ?? '' : '');
        const input = spec.type === 'enum'
          ? h('select', { id, name: f, 'data-key': `${key}:${f}` }, ...(spec.values ?? []).map((v) => h('option', { value: v, selected: v === cur }, v)))
          : h('input', { id, name: f, value: cur, maxlength: spec.maxLength, required: !!spec.required, 'data-key': `${key}:${f}`, autocomplete: 'off' });
        input.addEventListener('input', (e) => ctx.on.createChange(f, (e.target as HTMLInputElement).value));
        input.addEventListener('change', (e) => ctx.on.createChange(f, (e.target as HTMLInputElement).value));
        form.append(h('label', { for: id }, label(ctx, f)), input);
      }
      form.append(h('div', { class: 'ai-row' }, h('button', { type: 'submit', class: 'primary', 'data-key': `${key}:create-review`, disabled: ctx.busy }, 'Review…')));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const args: Record<string, string> = {};
        for (const f of fields) {
          const spec = cap.argumentSchema[f];
          const v = ctx.ui.createDraft[f] ?? spec.default ?? (spec.type === 'enum' ? spec.values?.[0] ?? '' : '');
          if (v !== '') args[f] = v;
        }
        ctx.on.create(cap.id, args);
      });
      return form;
    }
    case 'origin-link': {
      const b = h('button', { type: 'button', class: 'ai-origin' }, `${String(p.label ?? 'Open original')} ↗`);
      b.addEventListener('click', () => ctx.on.openOriginal());
      return b;
    }
    case 'unsupported':
      return h('p', { class: 'ai-unsupported' }, h('strong', {}, `${String(p.operation ?? 'This action')}: unavailable. `), String(p.reason ?? ''));
    case 'shortcut-help':
      return h('p', { class: 'ai-meta' }, 'Keyboard: ↑ ↓ or j k to move, Enter to select, e to edit a field, n for a new task, / to filter, Esc to cancel.');
    default:
      return null;
  }
}

/** Render, then restore focus to the element with the same data-key so live updates never steal focus. */
export function renderSurface(container: HTMLElement, surface: UISurface, ctx: RenderCtx) {
  const active = document.activeElement as HTMLElement | null;
  const focusKey = active && container.contains(active) ? active.getAttribute('data-key') : null;
  const selStart = active instanceof HTMLInputElement ? active.selectionStart : null;
  const root = renderNode(surface.root, ctx, `${container.id || 'workspace'}-0`);
  container.replaceChildren(...(root ? [root] : []));
  const restored = focusKey ? container.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`) : null;
  if (focusKey && !restored) container.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  if (focusKey) {
    const next = restored;
    if (next) {
      next.focus({ preventScroll: true });
      if (next instanceof HTMLInputElement && selStart !== null) next.setSelectionRange(selStart, selStart);
    }
  }
}

/** One-line summary of components, used for layout-change previews. */
export function outline(surface: UISurface): string[] {
  const out: string[] = [];
  const walk = (n: UINode, d: number) => {
    if (!['stack'].includes(n.component)) out.push(`${'  '.repeat(Math.max(0, d - 1))}${n.component}${n.props?.title ? ` "${String(n.props.title)}"` : ''}${n.bind ? ` ← ${n.bind}` : ''}${n.capabilityId ? ` ⇒ ${n.capabilityId.split('.').slice(-2).join('.')}` : ''}`);
    (n.children ?? []).forEach((c) => walk(c, d + 1));
  };
  walk(surface.root, 0);
  return out;
}
