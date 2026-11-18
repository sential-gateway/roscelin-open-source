// DOM-semantic read/write for the reference fixture. Runs inside the content script (isolated world).
// Page content is untrusted: we only read declared semantic attributes and text, and never eval anything.

import type { ObservedState, ActionRequest } from '../../../schemas/src/contracts.ts';
import { APP_ID, CAPS } from './ops.ts';

const MAX_TEXT = 2000;
const clip = (s: string | null | undefined) => (s ?? '').trim().slice(0, MAX_TEXT);

export function findRoot(doc: Document): HTMLElement | null {
  const roots = doc.querySelectorAll<HTMLElement>('main[data-ai-app="reference-tasks"]');
  return roots.length === 1 ? roots[0] : null;
}

export function readState(doc: Document): ObservedState {
  const root = findRoot(doc);
  if (!root) throw new Error('reference app root not found (or ambiguous)');
  const rows = Array.from(root.querySelectorAll<HTMLElement>('li[data-task-id]'));
  const seen = new Set<string>();
  const tasks = rows.flatMap((li) => {
    const id = li.dataset.taskId ?? '';
    if (!id || seen.has(id)) return []; // duplicate ids are ignored, and writes to them refused
    seen.add(id);
    const f = (name: string) => clip(li.querySelector(`[data-field="${name}"]`)?.textContent);
    return [{ objectId: id, revision: Number(li.dataset.revision ?? '0'), fields: { title: f('title'), status: f('status'), priority: f('priority') } }];
  });
  const article = root.querySelector<HTMLElement>('article[data-ai-doc]');
  const paragraphs = article ? Array.from(article.querySelectorAll('p')).map((p, i) => ({ objectId: `p${i}`, revision: Number(article.dataset.revision ?? '0'), fields: { text: clip(p.textContent) } })) : [];
  return {
    appId: APP_ID,
    appName: 'Reference Tasks (fixture)',
    origin: doc.location.origin,
    documentInstanceId: root.dataset.docInstance ?? '',
    documentTitle: clip(root.dataset.docTitle),
    workspaceRevision: Number(root.dataset.workspaceRevision ?? '0'),
    observedAt: Date.now(),
    sourceMethod: 'dom-semantic',
    collections: { tasks, paragraphs },
    collectionSchema: { tasks: ['title', 'status', 'priority'], paragraphs: ['text'] },
    collectionRoles: { tasks: { status: 'status', doneValues: ['done'], rank: 'priority', rankOrder: ['low', 'normal', 'high'] } },
    availableCapabilityIds: [CAPS.list.id, CAPS.docRead.id, CAPS.update.id, CAPS.create.id],
    limitations: [
      'Delete is not exposed (bulk/destructive ops excluded from first slice).',
      'Document text is read-only through this adapter.',
    ],
  };
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  el.focus();
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Drive the app's own controls. Returns dispatched=false when the target cannot be uniquely identified. */
export async function execute(doc: Document, req: ActionRequest): Promise<{ dispatched: boolean; detail?: string }> {
  const root = findRoot(doc);
  if (!root) return { dispatched: false, detail: 'app root missing' };
  if (root.dataset.docInstance !== req.target.documentInstanceId) return { dispatched: false, detail: 'document instance changed' };

  if (req.capabilityId === CAPS.update.id) {
    const id = req.target.objectId ?? '';
    const rows = root.querySelectorAll<HTMLElement>(`li[data-task-id="${CSS.escape(id)}"]`);
    if (rows.length !== 1) return { dispatched: false, detail: `expected 1 row for ${id}, found ${rows.length}` };
    const li = rows[0];
    if (req.expectedRevision !== null && Number(li.dataset.revision) !== req.expectedRevision) return { dispatched: false, detail: 'revision changed before write' };
    li.querySelector<HTMLButtonElement>('button[data-action="edit"]')?.click();
    await tick();
    // The app may re-render; the old node can be detached. Re-resolve by stable id, never reuse stale nodes.
    const again = root.querySelectorAll<HTMLElement>(`li[data-task-id="${CSS.escape(id)}"]`);
    if (again.length !== 1) return { dispatched: false, detail: 'row identity lost after opening editor' };
    const form = again[0].querySelector<HTMLFormElement>('form[data-edit-form]');
    if (!form) return { dispatched: false, detail: 'edit form did not open' };
    for (const [k, v] of Object.entries(req.args)) {
      const el = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${k}"]`);
      if (!el) return { dispatched: false, detail: `field ${k} not found` };
      setValue(el, String(v));
    }
    form.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await tick();
    return { dispatched: true };
  }

  if (req.capabilityId === CAPS.create.id) {
    if (req.expectedRevision !== null && Number(root.dataset.workspaceRevision) !== req.expectedRevision) return { dispatched: false, detail: 'workspace changed before write' };
    const title = root.querySelector<HTMLInputElement>('#new-title');
    const pr = root.querySelector<HTMLSelectElement>('#new-priority');
    const add = root.querySelector<HTMLButtonElement>('#add-task');
    if (!title || !pr || !add) return { dispatched: false, detail: 'create controls not found' };
    setValue(title, String(req.args.title));
    setValue(pr, String(req.args.priority ?? 'normal'));
    add.click();
    await tick();
    return { dispatched: true };
  }
  return { dispatched: false, detail: 'unsupported capability' };
}
