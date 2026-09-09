import fs from "node:fs/promises";
import path from "node:path";

const MIGRATION_ID = "repo-workbench-data-v1";
const SKIPPED_ROOT_ENTRIES = new Set([".api-token", "logs", "migrations"]);

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
}

async function listDirectories(targetPath) {
  if (!await pathExists(targetPath)) return [];
  const entries = await fs.readdir(targetPath, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function timestampToken(now = new Date()) {
  return now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function importedSlug(sourceSlug, token) {
  return `${sourceSlug}-legacy-${token}`;
}

function rewriteStoredPath(value, { legacyDir, sourceSlug, destinationSlug, rootMappings }) {
  if (typeof value !== "string") return value;
  const normalized = value.replaceAll("\\", "/");
  const normalizedLegacyDir = legacyDir.replaceAll("\\", "/").replace(/\/$/, "");
  let relative = normalized;
  if (relative === normalizedLegacyDir) relative = "workbench-data";
  if (relative.startsWith(`${normalizedLegacyDir}/`)) {
    relative = `workbench-data/${relative.slice(normalizedLegacyDir.length + 1)}`;
  }

  const projectPrefixes = [
    `workbench-data/projects/${sourceSlug}`,
    `@data/projects/${sourceSlug}`
  ];
  for (const prefix of projectPrefixes) {
    if (relative === prefix || relative.startsWith(`${prefix}/`)) {
      return `@data/projects/${destinationSlug}${relative.slice(prefix.length)}`;
    }
  }

  const legacyMatch = relative.match(/^workbench-data\/([^/]+)(\/.*)?$/);
  if (!legacyMatch) return value;
  const [, rootEntry, suffix = ""] = legacyMatch;
  const targetPrefix = rootMappings.get(rootEntry) || `@data/${rootEntry}`;
  return `${targetPrefix}${suffix}`;
}

function rewriteStoredPaths(value, context) {
  if (typeof value === "string") return rewriteStoredPath(value, context);
  if (Array.isArray(value)) return value.map((item) => rewriteStoredPaths(item, context));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewriteStoredPaths(item, context)]));
}

async function normaliseImportedDeck(projectDir, { legacyDir, sourceSlug, destinationSlug, rootMappings }) {
  const deckPath = path.join(projectDir, "deck.json");
  const sourceDeck = await readJson(deckPath);
  if (!sourceDeck) return;
  const deck = rewriteStoredPaths(sourceDeck, { legacyDir, sourceSlug, destinationSlug, rootMappings });
  deck.deckId = destinationSlug;
  if (Object.hasOwn(deck, "projectSlug")) deck.projectSlug = destinationSlug;
  deck.project = {
    ...(deck.project || {}),
    slug: destinationSlug,
    id: destinationSlug,
    dir: `@data/projects/${destinationSlug}`
  };
  await fs.writeFile(deckPath, JSON.stringify(deck, null, 2), "utf8");
}

export function legacyDataDirFor(projectRoot) {
  return path.join(projectRoot, "workbench-data");
}

export async function inspectLegacyDataMigration({ projectRoot, dataDir }) {
  const legacyDir = legacyDataDirFor(projectRoot);
  const sameDirectory = path.resolve(legacyDir) === path.resolve(dataDir);
  const markerPath = path.join(dataDir, "migrations", `${MIGRATION_ID}.json`);
  const marker = await readJson(markerPath);
  const legacyExists = !sameDirectory && await pathExists(legacyDir);
  const legacyProjects = legacyExists ? await listDirectories(path.join(legacyDir, "projects")) : [];

  return {
    id: MIGRATION_ID,
    status: sameDirectory ? "not-needed" : marker?.status === "completed" ? "completed" : legacyExists ? "available" : "not-found",
    legacyDir,
    dataDir,
    legacyProjectCount: legacyProjects.length,
    legacyProjects,
    completedAt: marker?.completedAt || null,
    backupPath: marker?.backupPath || null,
    importedProjects: marker?.importedProjects || [],
    skipped: marker?.skipped || []
  };
}

export async function runLegacyDataMigration({ projectRoot, dataDir }) {
  const initial = await inspectLegacyDataMigration({ projectRoot, dataDir });
  if (initial.status !== "available") return { ...initial, alreadyHandled: true };

  const token = timestampToken();
  const backupRoot = path.join(path.dirname(dataDir), "610PPT Migration Backups", `repo-workbench-data-${token}`);
  const markerDir = path.join(dataDir, "migrations");
  const importedProjects = [];
  const skipped = [];
  const rootMappings = new Map();

  // The legacy root is copied before any target write. We never remove or mutate it.
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.cp(initial.legacyDir, path.join(backupRoot, "legacy-workbench-data"), { recursive: true, force: false });
  if (await pathExists(dataDir)) {
    await fs.cp(dataDir, path.join(backupRoot, "canonical-before-migration"), { recursive: true, force: false });
  }

  await fs.mkdir(dataDir, { recursive: true });
  const legacyEntries = await fs.readdir(initial.legacyDir, { withFileTypes: true });
  for (const entry of legacyEntries.filter((item) => item.name !== "projects")) {
    if (SKIPPED_ROOT_ENTRIES.has(entry.name)) {
      skipped.push(entry.name);
      continue;
    }
    const source = path.join(initial.legacyDir, entry.name);
    const target = path.join(dataDir, entry.name);
    if (!await pathExists(target)) {
      await fs.cp(source, target, { recursive: true, force: false });
      rootMappings.set(entry.name, `@data/${entry.name}`);
    } else {
      const fallbackName = `${entry.name}-${token}`;
      const fallback = path.join(dataDir, "legacy-imports", fallbackName);
      await fs.mkdir(path.dirname(fallback), { recursive: true });
      await fs.cp(source, fallback, { recursive: true, force: false });
      rootMappings.set(entry.name, `@data/legacy-imports/${fallbackName}`);
    }
  }

  const projectsEntry = legacyEntries.find((entry) => entry.name === "projects" && entry.isDirectory());
  if (projectsEntry) {
    const sourceProjects = path.join(initial.legacyDir, "projects");
    const targetProjects = path.join(dataDir, "projects");
    await fs.mkdir(targetProjects, { recursive: true });
    for (const slug of await listDirectories(sourceProjects)) {
      const legacyProject = path.join(sourceProjects, slug);
      let destinationSlug = slug;
      let destination = path.join(targetProjects, destinationSlug);
      if (await pathExists(destination)) {
        destinationSlug = importedSlug(slug, token);
        destination = path.join(targetProjects, destinationSlug);
      }
      await fs.cp(legacyProject, destination, { recursive: true, force: false });
      await normaliseImportedDeck(destination, {
        legacyDir: initial.legacyDir,
        sourceSlug: slug,
        destinationSlug,
        rootMappings
      });
      importedProjects.push({ from: slug, to: destinationSlug, conflict: destinationSlug !== slug });
    }
  }

  const marker = {
    id: MIGRATION_ID,
    status: "completed",
    completedAt: new Date().toISOString(),
    legacyDir: initial.legacyDir,
    dataDir,
    backupPath: backupRoot,
    importedProjects,
    skipped
  };
  await fs.mkdir(markerDir, { recursive: true });
  await fs.writeFile(path.join(markerDir, `${MIGRATION_ID}.json`), JSON.stringify(marker, null, 2), "utf8");
  return { ...marker, legacyProjectCount: initial.legacyProjectCount };
}
