/**
 * Saved workflow pipelines — a local, privacy-preserving macro store.
 *
 * Only the pipeline definition (steps, merge flag, name) is persisted. Files,
 * passwords and document contents are never written here.
 */
const STORAGE_KEY = "paperly.workflows.v1";
const VERSION = 1;

export interface SavedWorkflow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  merge: boolean;
  /** Serialised workflow steps; the tool validates them when loading. */
  steps: unknown[];
}

interface Envelope {
  version: number;
  workflows: SavedWorkflow[];
}

function canStore(): boolean {
  try {
    return typeof window !== "undefined" && typeof localStorage !== "undefined";
  } catch {
    return false;
  }
}

function uid(): string {
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function listWorkflows(): SavedWorkflow[] {
  if (!canStore()) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<Envelope>;
    if (parsed?.version !== VERSION || !Array.isArray(parsed.workflows)) return [];
    return parsed.workflows
      .filter((entry): entry is SavedWorkflow => Boolean(entry && typeof entry === "object" && typeof entry.id === "string" && Array.isArray(entry.steps)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function write(workflows: SavedWorkflow[]): boolean {
  if (!canStore()) return false;
  try {
    const envelope: Envelope = { version: VERSION, workflows };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
    window.dispatchEvent(new CustomEvent("paperly:workflows"));
    return true;
  } catch {
    return false;
  }
}

export interface SaveWorkflowInput {
  name: string;
  merge: boolean;
  steps: unknown[];
  /** Update an existing pipeline instead of creating a new one. */
  id?: string;
}

export function saveWorkflow(input: SaveWorkflowInput): SavedWorkflow | null {
  const workflows = listWorkflows();
  const now = Date.now();
  const cleanName = input.name.trim().slice(0, 80) || "Untitled workflow";
  const existingIndex = input.id ? workflows.findIndex((entry) => entry.id === input.id) : -1;
  if (existingIndex >= 0) {
    const updated: SavedWorkflow = {
      ...workflows[existingIndex],
      name: cleanName,
      merge: input.merge,
      steps: input.steps,
      updatedAt: now,
    };
    const next = [...workflows];
    next[existingIndex] = updated;
    return write(next) ? updated : null;
  }
  const created: SavedWorkflow = {
    id: uid(),
    name: cleanName,
    createdAt: now,
    updatedAt: now,
    merge: input.merge,
    steps: input.steps,
  };
  return write([created, ...workflows]) ? created : null;
}

export function deleteWorkflow(id: string): void {
  write(listWorkflows().filter((entry) => entry.id !== id));
}

export function clearWorkflows(): void {
  write([]);
}
