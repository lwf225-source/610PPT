export const LAST_PROJECT_STORAGE_KEY = "610ppt:v2:last-project-slug";

export function findRestorableProject(projects = [], slug = "") {
  const normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) return null;
  return projects.find((project) => project?.slug === normalizedSlug) || null;
}

export function findProjectForDeck(projects = [], deck = null) {
  if (!deck) return null;
  const projectSlug = deck.project?.slug || "";
  const bySlug = findRestorableProject(projects, projectSlug);
  if (bySlug) return bySlug;
  const deckId = String(deck.deckId || deck.project?.id || "").trim();
  if (deckId) {
    const byId = projects.find((project) => project?.id === deckId);
    if (byId) return byId;
  }
  const title = String(deck.title || "").trim();
  return title ? projects.find((project) => project?.title === title) || null : null;
}

export function visibleProjectsWithSelection(projects = [], selectedSlug = "", limit = 8) {
  const safeLimit = Math.max(1, Number(limit) || 1);
  if (projects.length <= safeLimit) return projects;
  const visible = projects.slice(0, safeLimit);
  const selected = findRestorableProject(projects, selectedSlug);
  if (!selected || visible.some((project) => project.slug === selected.slug)) return visible;
  return [selected, ...visible.slice(0, safeLimit - 1)];
}
