import fs from 'node:fs/promises';
import path from 'node:path';

import { logger } from '../logger.js';

/**
 * Mapping a LibreChat project onto a mnemonic project.
 *
 * mnemonic derives project identity from a working directory. Its detection
 * order is: git remote of the enclosing repo, then the git root folder name,
 * then the plain basename (the branch this relies on) of the
 * directory. See `detectDefaultProject` in mnemonic's src/project.ts.
 *
 * So a LibreChat project called "Home Network" becomes the directory
 * `<projectRoot>/Home Network`, which mnemonic resolves to
 * `{ id: "home-network", name: "Home Network", source: "folder" }`.
 *
 * Two constraints follow, both verified against mnemonic 0.42:
 *
 * - The directory must exist. mnemonic's `findGitRoot` calls `simpleGit(cwd)`
 *   outside its error guard, so a missing path fails the whole tool call with
 *   "Cannot use simple-git on a directory that does not exist".
 * - The directory must exist on the filesystem of whichever process runs
 *   mnemonic. That is automatic when we spawn it, and the operator's problem
 *   when MNEMONIC_MODE=remote.
 *
 * The directory must NOT be inside a git repository, or mnemonic will attribute
 * memories to that repo instead. Keep MNEMONIC_PROJECT_ROOT outside any clone.
 */

/**
 * Control characters, path separators, and anything else hostile in a filename.
 * Matching control characters is the point, so the rule is disabled here rather
 * than worked around.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/**
 * Turn a LibreChat project name into a safe single path segment while keeping
 * it human-readable, because mnemonic uses the basename as the project's
 * display name.
 */
export function projectDirName(name: string, fallbackId: string): string {
  // The fallback goes through the same cleaner, so a hostile project id cannot
  // reach the filesystem by a route the project name cannot.
  return clean(name) || clean(fallbackId) || 'unnamed-project';
}

function clean(value: string): string {
  return (
    (value ?? '')
      .replace(UNSAFE, ' ')
      .replace(/\s+/g, ' ')
      // Leading dots would hide the directory or, worse, name it "." or "..".
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 80)
      .trim()
  );
}

export interface ProjectDirOptions {
  projectRoot: string;
  create: boolean;
}

export interface ResolvedProjectDir {
  /** Absolute path passed to mnemonic as `cwd`. */
  cwd: string;
  /** Directory basename, which becomes the mnemonic project name. */
  dirName: string;
  /** False when the directory could not be created; callers should fall back to global. */
  usable: boolean;
}

const ensured = new Set<string>();

/**
 * Resolve (and, in spawn mode, create) the directory that represents a
 * LibreChat project inside mnemonic.
 */
export async function resolveProjectDir(
  projectName: string,
  projectId: string,
  options: ProjectDirOptions,
): Promise<ResolvedProjectDir> {
  const dirName = projectDirName(projectName, projectId);
  const cwd = path.join(path.resolve(options.projectRoot), dirName);

  // Defensive: a crafted project name must not escape the root.
  const root = path.resolve(options.projectRoot);
  if (cwd !== root && !cwd.startsWith(root + path.sep)) {
    logger.error({ projectName, cwd }, 'refusing project directory outside the project root');
    return { cwd, dirName, usable: false };
  }

  if (!options.create) {
    return { cwd, dirName, usable: true };
  }

  if (ensured.has(cwd)) {
    return { cwd, dirName, usable: true };
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    // A breadcrumb so an operator looking at the volume can tell what these are.
    const marker = path.join(cwd, '.librechat-project.json');
    try {
      await fs.writeFile(
        marker,
        JSON.stringify({ chatProjectId: projectId, name: projectName }, null, 2) + '\n',
        { flag: 'wx' },
      );
    } catch {
      // Already there. Fine.
    }
    ensured.add(cwd);
    return { cwd, dirName, usable: true };
  } catch (error) {
    logger.error({ err: error, cwd }, 'could not create project directory');
    return { cwd, dirName, usable: false };
  }
}

/** Test seam. */
export function resetProjectDirCache(): void {
  ensured.clear();
}
