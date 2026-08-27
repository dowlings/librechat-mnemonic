#!/usr/bin/env node
/**
 * Vault analysis dashboard — scans all notes and produces a categorized summary
 * to help decide what to consolidate, delete, or keep.
 *
 * Usage:
 *   node vault-analysis.mjs /vault/notes
 *   node vault-analysis.mjs /vault/notes --json > report.json
 *   node vault-analysis.mjs /vault/notes --cluster=github-app   # show one cluster
 *   node vault-analysis.mjs /vault/notes --cleanup               # only cleanup candidates
 *
 * No dependencies — uses a minimal frontmatter parser.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const cleanupOnly = args.includes('--cleanup');
const clusterFilter = args.find((a) => a.startsWith('--cluster='))?.split('=')[1];
const notesDir = args.find((a) => !a.startsWith('--'));

if (!notesDir) {
  console.error('Usage: node vault-analysis.mjs <notes-dir> [--json] [--cluster=name] [--cleanup]');
  process.exit(1);
}

// ── Frontmatter parser (no dependencies) ──────────────────────────────────────

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) return null;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return null;
  const fmText = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();

  const data = {};
  let lines = fmText.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = /^(\w+):\s*(.*)/.exec(line);
    if (!match) { i++; continue; }
    const [, key, value] = match;

    // Handle block scalars (>, |, and chomp variants)
    if (value.match(/^[>|][-+]?\s*$/)) {
      const contentLines = [];
      i++;
      while (i < lines.length && lines[i].match(/^\s+/)) {
        contentLines.push(lines[i].replace(/^\s+/, ''));
        i++;
      }
      data[key] = contentLines.join(' ').trim();
      continue;
    }

    // Handle arrays
    if (value === '' && lines[i + 1]?.match(/^\s+-\s/)) {
      const arr = [];
      i++;
      while (i < lines.length && lines[i].match(/^\s+-\s/)) {
        arr.push(lines[i].replace(/^\s+-\s*/, '').trim());
        i++;
      }
      data[key] = arr;
      continue;
    }

    // Handle quoted strings
    if (value.startsWith("'") && value.endsWith("'")) {
      data[key] = value.slice(1, -1);
    } else if (value.startsWith('"') && value.endsWith('"')) {
      data[key] = value.slice(1, -1);
    } else {
      data[key] = value.trim();
    }
    i++;
  }

  return { data, body, raw };
}

// ── Topic clustering ─────────────────────────────────────────────────────────

const TOPIC_PATTERNS = [
  { name: 'github-app', pattern: /github.?app|coding.?agent|token.?broker|installation.?id/i },
  { name: 'github-reader-mcp', pattern: /github.?reader|reader.?mcp/i },
  { name: 'agent-coding-pr-system', pattern: /agent.?coding|pr.?system|pr.?creation|push.?model|draft.?pr/i },
  { name: 'ai-orchestrator', pattern: /ai.?orchestrat|trusted.?broker|sandbox.?orchestrat|orchestrator.?sandbox/i },
  { name: 'librechat-config', pattern: /librechat\.?yaml|librechat.?config|librechat.?endpoint|librechat.?mcp/i },
  { name: 'librechat-mnemonic-arch', pattern: /librechat.?mnemonic.*(?:arch|design|overview|scope|proxy)/i },
  { name: 'langfuse', pattern: /langfuse/i },
  { name: 'mnemonic-vault', pattern: /mnemonic.?vault|vault.?cleanup|vault.?audit|mnemonic.?note/i },
  { name: 'mnemonic-mcp', pattern: /mnemonic.*mcp|mcp.*mnemonic|recall|remember|consolidate/i },
  { name: 'librechat-summarization', pattern: /summariz|context.?prun|token.?ratio/i },
  { name: 'librechat-tokenconfig', pattern: /tokenconfig|token.?config|token.?map/i },
  { name: 'librechat-ollama', pattern: /ollama|ollamaclient|ollama.?cloud/i },
  { name: 'nas-docker', pattern: /nas.?docker|nas.?deploy|systemd|docker.?compose/i },
  { name: 'tailscale', pattern: /tailscale|jellyfin|subnet.?route|netfilter/i },
  { name: 'rpir-workflow', pattern: /rpir|workflow.?design|research.?plan.?implement.?review/i },
  { name: 'user-environment', pattern: /user.?environment|user.?infrastructure|nas.?environment/i },
  { name: 'claude-actions', pattern: /claude.*(?:action|workflow|github)|github.*claude/i },
  { name: 'docker-images', pattern: /dockerfile|docker.?image|container.?image|base.?image/i },
  { name: 'git-commit-signing', pattern: /commit.?sign|ssh.?sign|signed.?commit|createcommitonbranch/i },
  { name: 'issue-tracking', pattern: /issue.?#?\d+|github.?issue|issue.?tracking/i },
  { name: 'mcp-tooling', pattern: /mcp.*(?:tool|server|transport|stdio|streamable)/i },
  { name: 'playwright', pattern: /playwright|csp.?sandbox|wait.?for.?timeout/i },
  { name: 'preferences', pattern: /preference|prompt.?generation|hierarchical.?cach/i },
  { name: '1password', pattern: /1password|op.?cli|service.?account/i },
  { name: 'ollama-models', pattern: /gemma|glm-5|qwen|gpt-oss|nemotron|kimi|minimax|deepseek|mistral/i },
  { name: 'disk-partition', pattern: /disk|partition|nvme|btrfs|ext4|nixos/i },
  { name: 'cowork-tooling', pattern: /cowork|cowork.?tooling/i },
  { name: 'librechat-skills', pattern: /skill.?file|skill.?creation|skill.?directory/i },
  { name: 'project-scoping', pattern: /project.?scop|project.?resolut|project.?vault|project.?pref/i },
  { name: 'embedding', pattern: /embedding|chunk|vector|similarity|cosine/i },
  { name: 'latency-performance', pattern: /latency|performance|serializ.?queue|timeout|circuit.?break/i },
  { name: 'parallel-mcp-bug', pattern: /parallel.?mcp|response.?loop|tool.?call.?schema|ollama.?bug/i },
];

function classifyNote(title, tags) {
  const text = `${title} ${tags.join(' ')}`;
  for (const { name, pattern } of TOPIC_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return 'other';
}

// ── Duplicate detection ─────────────────────────────────────────────────────

function normalizeTitle(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function titleSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.length / union.size;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const files = await readdir(notesDir);
  const mdFiles = files.filter((f) => f.endsWith('.md')).sort();

  const notes = [];
  const errors = [];

  for (const file of mdFiles) {
    try {
      const raw = await readFile(join(notesDir, file), 'utf-8');
      const parsed = parseFrontmatter(raw);
      if (!parsed) {
        errors.push({ file, error: 'no frontmatter' });
        continue;
      }
      const { data, body } = parsed;
      const id = file.replace(/\.md$/, '');
      notes.push({
        id,
        file,
        title: data.title || id,
        tags: Array.isArray(data.tags) ? data.tags : [],
        lifecycle: data.lifecycle || 'permanent',
        role: data.role || null,
        project: data.project || null,
        createdAt: data.createdAt || '',
        bodyLength: body.length,
        bodyPreview: body.slice(0, 200).replace(/\n/g, ' '),
      });
    } catch (err) {
      errors.push({ file, error: err.message });
    }
  }

  // ── Analysis ──────────────────────────────────────────────────────────────

  const stats = {
    total: notes.length,
    byLifecycle: {},
    byRole: {},
    byProject: {},
    byTopic: {},
    missingRole: 0,
    missingProject: 0,
    temporary: 0,
    autoExtracted: 0,
    blockScalarTitles: 0,
  };

  for (const note of notes) {
    stats.byLifecycle[note.lifecycle] = (stats.byLifecycle[note.lifecycle] || 0) + 1;
    if (note.role) {
      stats.byRole[note.role] = (stats.byRole[note.role] || 0) + 1;
    } else {
      stats.missingRole++;
    }
    if (note.project) {
      stats.byProject[note.project] = (stats.byProject[note.project] || 0) + 1;
    } else {
      stats.missingProject++;
    }
    if (note.lifecycle === 'temporary') stats.temporary++;
    if (note.tags.includes('auto-extracted')) stats.autoExtracted++;
    if (note.title.match(/^[>|][-+]?$/)) stats.blockScalarTitles++;

    note.topic = classifyNote(note.title, note.tags);
    stats.byTopic[note.topic] = (stats.byTopic[note.topic] || 0) + 1;
  }

  // Topic clusters
  const clusters = {};
  for (const note of notes) {
    if (!clusters[note.topic]) clusters[note.topic] = [];
    clusters[note.topic].push(note);
  }

  // Exact duplicates (by normalized title)
  const titleGroups = {};
  for (const note of notes) {
    const norm = normalizeTitle(note.title);
    if (!titleGroups[norm]) titleGroups[norm] = [];
    titleGroups[norm].push(note);
  }
  const exactDupGroups = Object.values(titleGroups).filter((g) => g.length > 1);

  // Near-duplicate groups (by title similarity > 0.5, same topic)
  const nearDupGroups = [];
  const seen = new Set();
  for (let i = 0; i < notes.length; i++) {
    if (seen.has(notes[i].id)) continue;
    const group = [notes[i]];
    for (let j = i + 1; j < notes.length; j++) {
      if (seen.has(notes[j].id)) continue;
      if (notes[i].topic === notes[j].topic && titleSimilarity(notes[i].title, notes[j].title) > 0.5) {
        group.push(notes[j]);
        seen.add(notes[j].id);
      }
    }
    if (group.length > 1) {
      nearDupGroups.push(group);
      seen.add(notes[i].id);
    }
  }

  // Cleanup candidates
  const cleanup = {
    temporary: notes.filter((n) => n.lifecycle === 'temporary'),
    autoExtracted: notes.filter((n) => n.tags.includes('auto-extracted')),
    superseded: notes.filter((n) =>
      n.title.match(/supers|depred|deprecated|replaced|obsolete|old |prior |previous /i) ||
      n.tags.includes('superseded')
    ),
    sparseBody: notes.filter((n) => n.bodyLength < 100),
    blockScalar: notes.filter((n) => n.title.match(/^[>|][-+]?$/)),
  };

  // ── JSON output ───────────────────────────────────────────────────────────

  if (jsonMode) {
    console.log(JSON.stringify({
      stats,
      clusters: Object.fromEntries(
        Object.entries(clusters).map(([k, v]) => [k, v.map((n) => ({
          id: n.id, title: n.title, role: n.role, lifecycle: n.lifecycle,
          project: n.project, tags: n.tags, bodyLength: n.bodyLength,
        }))])
      ),
      exactDuplicates: exactDupGroups.map((g) => g.map((n) => ({ id: n.id, title: n.title }))),
      nearDuplicates: nearDupGroups.map((g) => g.map((n) => ({ id: n.id, title: n.title, topic: n.topic }))),
      cleanupCandidates: {
        temporary: cleanup.temporary.map((n) => ({ id: n.id, title: n.title, topic: n.topic })),
        superseded: cleanup.superseded.map((n) => ({ id: n.id, title: n.title })),
        sparseBody: cleanup.sparseBody.map((n) => ({ id: n.id, title: n.title, bodyLength: n.bodyLength })),
        blockScalar: cleanup.blockScalar.map((n) => ({ id: n.id, title: n.title })),
      },
      errors,
    }, null, 2));
    return;
  }

  // ── Cluster filter mode ──────────────────────────────────────────────────

  if (clusterFilter) {
    const cluster = clusters[clusterFilter];
    if (!cluster) {
      console.log(`No cluster named "${clusterFilter}".`);
      console.log(`Available: ${Object.keys(clusters).sort().join(', ')}`);
      return;
    }
    console.log(`── Cluster: ${clusterFilter} (${cluster.length} notes) ${'─'.repeat(Math.max(0, 50 - clusterFilter.length))}`);
    console.log('');
    for (const note of cluster) {
      console.log(`  [${note.lifecycle.padEnd(9)}] [${(note.role || '?').padEnd(8)}] [${(note.project || 'global').slice(0, 20).padEnd(20)}] ${note.title}`);
      console.log(`    id: ${note.id}`);
      if (note.tags.length > 0) console.log(`    tags: ${note.tags.join(', ')}`);
      console.log(`    body: ${note.bodyLength} chars`);
      console.log('');
    }
    return;
  }

  // ── Cleanup-only mode ────────────────────────────────────────────────────

  if (cleanupOnly) {
    console.log('═'.repeat(70));
    console.log('  CLEANUP CANDIDATES');
    console.log('═'.repeat(70));
    console.log('');

    console.log(`── Temporary notes (${cleanup.temporary.length}) ──────────────────────────────────`);
    for (const note of cleanup.temporary) {
      console.log(`  ${note.id}`);
      console.log(`    title: ${note.title}`);
      console.log(`    topic: ${note.topic}  role: ${note.role || '?'}  project: ${note.project || 'global'}`);
      console.log('');
    }

    console.log(`── Superseded/deprecated (${cleanup.superseded.length}) ────────────────────────────`);
    for (const note of cleanup.superseded) {
      console.log(`  ${note.id}  "${note.title}"`);
    }
    console.log('');

    console.log(`── Sparse body <100 chars (${cleanup.sparseBody.length}) ──────────────────────────`);
    for (const note of cleanup.sparseBody) {
      console.log(`  ${note.id}  (${note.bodyLength} chars)  "${note.title}"`);
    }
    console.log('');

    if (cleanup.blockScalar.length > 0) {
      console.log(`── Block-scalar titles (>${cleanup.blockScalar.length}) ──────────────────────────────`);
      for (const note of cleanup.blockScalar) {
        console.log(`  ${note.id}  "${note.title}"`);
      }
      console.log('');
    }

    console.log(`── Exact duplicate groups (${exactDupGroups.length}) ────────────────────────────────`);
    for (const group of exactDupGroups) {
      console.log(`  ⚠ ${group.length} notes:`);
      for (const note of group) {
        console.log(`    ${note.id}  [${note.lifecycle}]  "${note.title}"`);
      }
      console.log('');
    }

    console.log(`── Near-duplicate groups (${nearDupGroups.length}, showing top 30) ──────────────────`);
    const sorted = nearDupGroups.sort((a, b) => b.length - a.length).slice(0, 30);
    for (let i = 0; i < sorted.length; i++) {
      const group = sorted[i];
      console.log(`  Group ${i + 1}: ${group.length} notes [${group[0].topic}]`);
      for (const note of group) {
        console.log(`    ${note.id}  [${note.lifecycle.padEnd(9)}] [${(note.role || '?').padEnd(8)}]  "${note.title}"`);
      }
      console.log('');
    }
    if (nearDupGroups.length > 30) {
      console.log(`  ... and ${nearDupGroups.length - 30} more groups`);
    }
    return;
  }

  // ── Full text dashboard ─────────────────────────────────────────────────

  console.log('═'.repeat(70));
  console.log('  MNEMONIC VAULT ANALYSIS');
  console.log('═'.repeat(70));
  console.log(`  Total notes: ${stats.total}`);
  console.log(`  Errors: ${errors.length}`);
  console.log('');

  console.log('── Summary ──────────────────────────────────────────────────────');
  console.log(`  Permanent: ${stats.byLifecycle.permanent || 0}   Temporary: ${stats.temporary}`);
  console.log(`  Auto-extracted: ${stats.autoExtracted}   Missing role: ${stats.missingRole}   Missing project: ${stats.missingProject}`);
  if (stats.blockScalarTitles > 0) console.log(`  ⚠ Block-scalar titles (>- bug): ${stats.blockScalarTitles}`);
  console.log('');

  console.log('── By Role ─────────────────────────────────────────────────────');
  for (const [role, count] of Object.entries(stats.byRole).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${role.padEnd(12)} ${count}`);
  }
  console.log(`  ${'(none)'.padEnd(12)} ${stats.missingRole}`);
  console.log('');

  console.log('── By Project ─────────────────────────────────────────────────');
  for (const [project, count] of Object.entries(stats.byProject).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${project.slice(0, 40).padEnd(40)} ${count}`);
  }
  console.log(`  ${'(none/global)'.padEnd(40)} ${stats.missingProject}`);
  console.log('');

  console.log('── Topic Clusters (by count) ────────────────────────────────────');
  const sortedTopics = Object.entries(stats.byTopic).sort((a, b) => b[1] - a[1]);
  for (const [topic, count] of sortedTopics) {
    const pct = Math.round((count / stats.total) * 100);
    const bar = '█'.repeat(Math.round(pct / 2));
    console.log(`  ${topic.padEnd(25)} ${String(count).padStart(4)}  ${pct.toString().padStart(3)}% ${bar}`);
  }
  console.log('');

  // Exact duplicates
  if (exactDupGroups.length > 0) {
    console.log(`── Exact Duplicates (${exactDupGroups.length} groups) ──────────────────────────────`);
    for (const group of exactDupGroups) {
      console.log(`  ⚠ ${group.length} notes with same title:`);
      for (const note of group) {
        console.log(`    ${note.id}  [${note.lifecycle}] [${note.role || '?'}]  "${note.title}"`);
      }
      console.log('');
    }
  }

  // Near-duplicate groups (top 15)
  if (nearDupGroups.length > 0) {
    console.log(`── Near-Duplicate Groups (${nearDupGroups.length} total, showing top 15) ──────────`);
    const sorted = nearDupGroups.sort((a, b) => b.length - a.length).slice(0, 15);
    for (let i = 0; i < sorted.length; i++) {
      const group = sorted[i];
      console.log(`  Group ${i + 1}: ${group.length} notes [${group[0].topic}]`);
      for (const note of group) {
        console.log(`    ${note.id}  [${note.lifecycle.padEnd(9)}] [${(note.role || '?').padEnd(8)}]  "${note.title}"`);
      }
      console.log('');
    }
    if (nearDupGroups.length > 15) {
      console.log(`  ... and ${nearDupGroups.length - 15} more groups (use --cleanup to see all)`);
    }
    console.log('');
  }

  // Cleanup candidates summary
  console.log('── Cleanup Candidates ──────────────────────────────────────────');
  console.log(`  Temporary notes:           ${cleanup.temporary.length}`);
  console.log(`  Superseded/deprecated:     ${cleanup.superseded.length}`);
  console.log(`  Sparse body (<100 chars):   ${cleanup.sparseBody.length}`);
  console.log(`  Block-scalar titles:       ${cleanup.blockScalar.length}`);
  console.log(`  Exact duplicate groups:     ${exactDupGroups.length}`);
  console.log(`  Near-duplicate groups:     ${nearDupGroups.length}`);
  console.log('');

  // Recommendations
  console.log('═'.repeat(70));
  console.log('  RECOMMENDED ACTIONS');
  console.log('═'.repeat(70));
  console.log(`  1. Delete ${cleanup.temporary.length} temporary notes (review first)`);
  console.log(`  2. Delete ${cleanup.superseded.length} superseded/deprecated notes`);
  console.log(`  3. Delete ${cleanup.sparseBody.length} notes with sparse body (<100 chars)`);
  if (cleanup.blockScalar.length > 0) {
    console.log(`  4. Repair ${cleanup.blockScalar.length} block-scalar titles (run repair-titles.mjs)`);
  }
  console.log(`  5. Consolidate ${exactDupGroups.length} exact duplicate groups`);
  console.log(`  6. Consolidate ${nearDupGroups.length} near-duplicate groups`);
  console.log(`  7. Add role to ${stats.missingRole} notes missing role metadata`);
  console.log('');
  console.log('  Run with --json for full machine-readable report');
  console.log('  Run with --cluster=<name> to see notes in a specific cluster');
  console.log('  Run with --cleanup to see all cleanup candidates in detail');
  console.log('  Available clusters: ' + Object.keys(clusters).sort().join(', '));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});