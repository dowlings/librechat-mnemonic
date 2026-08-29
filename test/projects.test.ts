import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  projectDirName,
  resolveProjectDir,
  resetProjectDirCache,
} from '../src/mnemonic/projects.js';

describe('projectDirName', () => {
  it('keeps a readable name, because mnemonic uses the basename as the project name', () => {
    expect(projectDirName('Home Network', 'abc')).toBe('Home Network');
  });

  it('strips path separators and shell-hostile characters', () => {
    expect(projectDirName('a/b\\c:d*e?f"g<h>i|j', 'abc')).toBe('a b c d e f g h i j');
  });

  it('collapses whitespace and trims leading dots so the directory is never hidden', () => {
    expect(projectDirName('  ...Secret   Project.. ', 'abc')).toBe('Secret Project');
  });

  it('falls back to the project id when the name reduces to nothing', () => {
    expect(projectDirName('///', '507f1f77bcf86cd799439011')).toBe('507f1f77bcf86cd799439011');
    expect(projectDirName('..', 'xyz')).toBe('xyz');
  });

  it('never returns a relative traversal segment', () => {
    expect(projectDirName('..', '..')).toBe('unnamed-project');
    expect(projectDirName('.', '.')).toBe('unnamed-project');
  });

  it('caps the length so the path stays sane', () => {
    expect(projectDirName('x'.repeat(500), 'abc')).toHaveLength(80);
  });
});

describe('resolveProjectDir', () => {
  let root: string;

  beforeEach(async () => {
    resetProjectDirCache();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lcm-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates the directory and a breadcrumb file', async () => {
    const result = await resolveProjectDir('Home Network', 'proj1', {
      projectRoot: root,
      create: true,
    });

    expect(result.usable).toBe(true);
    expect(result.cwd).toBe(path.join(root, 'Home Network'));

    const stat = await fs.stat(result.cwd);
    expect(stat.isDirectory()).toBe(true);

    const marker = JSON.parse(
      await fs.readFile(path.join(result.cwd, '.librechat-project.json'), 'utf8'),
    );
    expect(marker).toEqual({ chatProjectId: 'proj1', name: 'Home Network' });
  });

  it('is idempotent across calls', async () => {
    const first = await resolveProjectDir('Repeat', 'p', { projectRoot: root, create: true });
    const second = await resolveProjectDir('Repeat', 'p', { projectRoot: root, create: true });
    expect(first.cwd).toBe(second.cwd);
    expect(second.usable).toBe(true);
  });

  it('does not create anything when creation is disabled (remote mnemonic)', async () => {
    const result = await resolveProjectDir('Remote Only', 'p', {
      projectRoot: root,
      create: false,
    });
    expect(result.usable).toBe(true);
    await expect(fs.stat(result.cwd)).rejects.toThrow();
  });

  it('refuses to escape the project root', async () => {
    // The sanitiser already removes separators; this asserts the second guard
    // still holds if that ever regresses.
    const result = await resolveProjectDir('..', '..', { projectRoot: root, create: true });
    expect(result.cwd.startsWith(path.resolve(root))).toBe(true);
  });
});
