#!/usr/bin/env node
// Token burn analysis for issue #212 ("research: root-cause the fast
// session-limit exhaustion on Max 5x").
//
// PRIVACY BOUND: this script reads only the usage-metadata fields named
// below (model, token counts, timestamp, sessionId, cwd, isSidechain,
// requestId, version, and the subagent sidecar's agentType/spawnDepth/
// toolUseId/worktreePath). It never reads, prints, or derives anything from
// message content (text, tool inputs/outputs, thinking blocks). Output is
// aggregate counts, project directory names, model names, and timestamps
// only.
//
// Usage:
//   node docs/research/2026-07-06-token-burn-analyze.mjs [options]
//
// Options:
//   --start <ISO>     window start, inclusive (default 2026-06-22T00:00:00.000Z)
//   --end <ISO>       window end, exclusive   (default 2026-07-06T00:00:00.000Z)
//   --project <substr> only include project directories whose name contains substr
//   --json            emit machine-readable JSON instead of text tables
//
// Zero dependencies: plain Node (fs, path, os, readline), no npm installs.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    start: '2026-06-22T00:00:00.000Z',
    end: '2026-07-06T00:00:00.000Z', // exclusive: covers 06-22..07-05 inclusive
    project: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--start') args.start = argv[++i];
    else if (a === '--end') args.end = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--json') args.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Quota-weighted view: proxy USD-per-million-token prices.
//
// Max plan quota mechanics are not public, so this is a labeled proxy, not a
// measured cost. Prices are historical Anthropic list-price tiers (Opus /
// Sonnet / Haiku), not confirmed 2026 rates for these model names. Fable 5 is
// set to 2x Opus 4.8 per this repo's team-guide "Model policy" section
// ("Fable costs 2x Opus 4.8 per token"). cache_creation = 1.25x input,
// cache_read = 0.1x input, the standard Anthropic prompt-caching multipliers.
// ---------------------------------------------------------------------------

const OPUS_INPUT = 15;
const OPUS_OUTPUT = 75;
const SONNET_INPUT = 3;
const SONNET_OUTPUT = 15;
const HAIKU_INPUT = 0.25;
const HAIKU_OUTPUT = 1.25;

const MODEL_PRICE = {
  'claude-opus-4-8': { input: OPUS_INPUT, output: OPUS_OUTPUT },
  'claude-opus-4-7': { input: OPUS_INPUT, output: OPUS_OUTPUT },
  'claude-fable-5': { input: OPUS_INPUT * 2, output: OPUS_OUTPUT * 2 }, // team-guide Model policy: 2x Opus 4.8
  'claude-sonnet-5': { input: SONNET_INPUT, output: SONNET_OUTPUT },
  'claude-sonnet-4-6': { input: SONNET_INPUT, output: SONNET_OUTPUT },
  'claude-haiku-4-5-20251001': { input: HAIKU_INPUT, output: HAIKU_OUTPUT },
};

function weightFor(model, bucket) {
  const price = MODEL_PRICE[model];
  if (!price) return null; // unknown model: excluded from the weighted view
  if (bucket === 'input') return price.input;
  if (bucket === 'output') return price.output;
  if (bucket === 'cache_creation') return price.input * 1.25;
  if (bucket === 'cache_read') return price.input * 0.1;
  return null;
}

const BUCKETS = ['input', 'output', 'cache_creation', 'cache_read'];

// ---------------------------------------------------------------------------
// Walking transcript directories
// ---------------------------------------------------------------------------

const PROJECT_ROOTS = [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.claude-personal', 'projects'),
];

// Each work unit: { kind: 'lead'|'subagent', project, root, filePath, sizeBytes, agentType }
function discoverFiles(projectFilter) {
  const units = [];
  const inventory = { rootsScanned: [], projectsScanned: 0, mainFiles: 0, subagentFiles: 0, totalBytes: 0 };

  for (const root of PROJECT_ROOTS) {
    if (!fs.existsSync(root)) continue;
    inventory.rootsScanned.push(root);
    const projectDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());

    for (const pd of projectDirs) {
      const project = pd.name;
      if (projectFilter && !project.includes(projectFilter)) continue;
      inventory.projectsScanned++;
      const projectPath = path.join(root, project);
      let entries;
      try {
        entries = fs.readdirSync(projectPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const sessionId = entry.name.slice(0, -'.jsonl'.length);
        const filePath = path.join(projectPath, entry.name);
        const sizeBytes = fs.statSync(filePath).size;
        inventory.mainFiles++;
        inventory.totalBytes += sizeBytes;
        units.push({ kind: 'lead', project, root, filePath, sizeBytes, sessionKey: `${project}/${sessionId}` });

        const subagentsDir = path.join(projectPath, sessionId, 'subagents');
        if (!fs.existsSync(subagentsDir)) continue;
        let subEntries;
        try {
          subEntries = fs.readdirSync(subagentsDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const se of subEntries) {
          if (!se.isFile() || !se.name.endsWith('.jsonl')) continue;
          const agentBase = se.name.slice(0, -'.jsonl'.length);
          const subFilePath = path.join(subagentsDir, se.name);
          const subSize = fs.statSync(subFilePath).size;
          const metaPath = path.join(subagentsDir, `${agentBase}.meta.json`);
          let agentType = null;
          if (fs.existsSync(metaPath)) {
            try {
              const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
              agentType = meta.agentType || null;
            } catch {
              agentType = null;
            }
          }
          inventory.subagentFiles++;
          inventory.totalBytes += subSize;
          units.push({
            kind: 'subagent',
            project,
            root,
            filePath: subFilePath,
            sizeBytes: subSize,
            agentType, // null => old-format file, fall back to isSidechain per line
            sessionKey: `${project}/${sessionId}/subagents/${agentBase}`,
          });
        }
      }
    }
  }
  return { units, inventory };
}

// ---------------------------------------------------------------------------
// Streaming line parser
// ---------------------------------------------------------------------------

async function forEachLine(filePath, onLine) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.length === 0) continue;
    onLine(line);
  }
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

async function analyze(args) {
  const { units, inventory } = discoverFiles(args.project);

  const counters = {
    linesScanned: 0,
    assistantLines: 0,
    syntheticSkipped: 0,
    outOfWindowSkipped: 0,
    malformedLines: 0,
    missingUsage: 0,
    sameFileDuplicates: 0,
    crossFileDuplicates: 0,
    maxRepeatsOfOneMessageId: 0,
    anomalySidechainInMain: 0,
    countedLines: 0,
    ephemeral5mCacheCreation: 0,
    ephemeral1hCacheCreation: 0,
  };

  // dimension: project x model x day x attribution -> bucket sums
  const agg = new Map();
  function bucketKey(project, model, day, attribution) {
    return `${project}${model}${day}${attribution}`;
  }
  function addUsage(project, model, day, attribution, usage) {
    const key = bucketKey(project, model, day, attribution);
    let rec = agg.get(key);
    if (!rec) {
      rec = { project, model, day, attribution, input: 0, output: 0, cache_creation: 0, cache_read: 0, lines: 0 };
      agg.set(key, rec);
    }
    rec.input += usage.input;
    rec.output += usage.output;
    rec.cache_creation += usage.cache_creation;
    rec.cache_read += usage.cache_read;
    rec.lines++;
  }

  // per-session-file peak context + first-request bootstrap cost
  const sessions = new Map(); // sessionKey -> {project, attribution, model, peak, firstTs, firstContext, lastTs}

  const seenMessageIds = new Map(); // messageId -> filePath (first file it was seen in)
  const repeatCounts = new Map(); // messageId -> count seen so far (this run)

  for (const unit of units) {
    let attribution = 'lead';
    if (unit.kind === 'subagent') {
      attribution = unit.agentType || null; // resolved per-line below if null
    }

    await forEachLine(unit.filePath, (line) => {
      counters.linesScanned++;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        counters.malformedLines++;
        return;
      }
      if (obj.type !== 'assistant') return;
      counters.assistantLines++;

      const ts = obj.timestamp;
      if (typeof ts !== 'string' || ts < args.start || ts >= args.end) {
        counters.outOfWindowSkipped++;
        return;
      }

      const model = obj.message && obj.message.model;
      if (model === '<synthetic>') {
        counters.syntheticSkipped++;
        return;
      }
      if (!model) {
        counters.malformedLines++;
        return;
      }

      const msgId = obj.message && obj.message.id;
      if (!msgId) {
        counters.malformedLines++;
        return;
      }

      const usageRaw = obj.message && obj.message.usage;
      if (!usageRaw) {
        counters.missingUsage++;
        return;
      }

      // dedup: count usage once per message.id, first occurrence globally
      const firstFile = seenMessageIds.get(msgId);
      if (firstFile !== undefined) {
        if (firstFile === unit.filePath) counters.sameFileDuplicates++;
        else counters.crossFileDuplicates++;
        const n = (repeatCounts.get(msgId) || 1) + 1;
        repeatCounts.set(msgId, n);
        if (n > counters.maxRepeatsOfOneMessageId) counters.maxRepeatsOfOneMessageId = n;
        return;
      }
      seenMessageIds.set(msgId, unit.filePath);
      repeatCounts.set(msgId, 1);
      counters.countedLines++;

      // resolve subagent attribution per-line for old-format files (no sidecar):
      // fall back to isSidechain, per decision 1's attribution rule
      let lineAttribution = attribution;
      if (unit.kind === 'subagent' && !lineAttribution) {
        lineAttribution = 'unknown-subagent';
      }
      if (unit.kind === 'lead' && obj.isSidechain === true) {
        counters.anomalySidechainInMain++;
      }

      const usage = {
        input: usageRaw.input_tokens || 0,
        output: usageRaw.output_tokens || 0,
        cache_creation: usageRaw.cache_creation_input_tokens || 0,
        cache_read: usageRaw.cache_read_input_tokens || 0,
      };
      const day = ts.slice(0, 10);
      addUsage(unit.project, model, day, lineAttribution, usage);

      const cacheCreationDetail = usageRaw.cache_creation;
      if (cacheCreationDetail) {
        counters.ephemeral5mCacheCreation += cacheCreationDetail.ephemeral_5m_input_tokens || 0;
        counters.ephemeral1hCacheCreation += cacheCreationDetail.ephemeral_1h_input_tokens || 0;
      }

      const sessKey = unit.sessionKey;
      let sess = sessions.get(sessKey);
      const context = usage.input + usage.cache_read + usage.cache_creation;
      if (!sess) {
        sess = {
          project: unit.project,
          attribution: lineAttribution,
          model,
          peak: context,
          firstTs: ts,
          firstContext: context,
          lastTs: ts,
          cacheRead: usage.cache_read,
          cacheCreation: usage.cache_creation,
        };
        sessions.set(sessKey, sess);
      } else {
        sess.cacheRead += usage.cache_read;
        sess.cacheCreation += usage.cache_creation;
        if (context > sess.peak) sess.peak = context;
        if (ts < sess.firstTs) {
          sess.firstTs = ts;
          sess.firstContext = context;
        }
        if (ts > sess.lastTs) sess.lastTs = ts;
      }
    });
  }

  return { inventory, counters, agg, sessions, args };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function buildReport(result) {
  const records = [...result.agg.values()];

  const byProject = new Map();
  const byModel = new Map();
  const byDay = new Map();
  const byAttribution = new Map();

  for (const r of records) {
    for (const [map, key] of [
      [byProject, r.project],
      [byModel, r.model],
      [byDay, r.day],
      [byAttribution, r.attribution],
    ]) {
      let acc = map.get(key);
      if (!acc) {
        acc = { input: 0, output: 0, cache_creation: 0, cache_read: 0, lines: 0 };
        map.set(key, acc);
      }
      acc.input += r.input;
      acc.output += r.output;
      acc.cache_creation += r.cache_creation;
      acc.cache_read += r.cache_read;
      acc.lines += r.lines;
    }
  }

  // quota-weighted totals by model
  const weightedByModel = new Map();
  for (const r of records) {
    let acc = weightedByModel.get(r.model);
    if (!acc) {
      acc = { rawInput: 0, rawOutput: 0, rawCacheCreation: 0, rawCacheRead: 0, weightedUsd: 0, weightKnown: true };
      weightedByModel.set(r.model, acc);
    }
    acc.rawInput += r.input;
    acc.rawOutput += r.output;
    acc.rawCacheCreation += r.cache_creation;
    acc.rawCacheRead += r.cache_read;
    for (const bucket of BUCKETS) {
      const w = weightFor(r.model, bucket);
      if (w == null) {
        acc.weightKnown = false;
        continue;
      }
      acc.weightedUsd += (r[bucket] / 1_000_000) * w;
    }
  }

  const sessionList = [...result.sessions.entries()].map(([key, s]) => {
    const denom = s.cacheRead + s.cacheCreation;
    return { key, ...s, hitRatio: denom > 0 ? s.cacheRead / denom : null };
  });
  const topSessionsByPeak = [...sessionList].sort((a, b) => b.peak - a.peak).slice(0, 15);

  const cacheEfficiencyByProject = new Map();
  for (const [project, acc] of byProject) {
    const denom = acc.cache_read + acc.cache_creation;
    cacheEfficiencyByProject.set(project, denom > 0 ? acc.cache_read / denom : null);
  }

  return {
    byProject,
    byModel,
    byDay,
    byAttribution,
    weightedByModel,
    sessionList,
    topSessionsByPeak,
    cacheEfficiencyByProject,
  };
}

function fmt(n) {
  return Math.round(n).toLocaleString('en-US');
}

function printTable(title, rows, columns) {
  console.log(`\n### ${title}\n`);
  const header = columns.map((c) => c.label).join(' | ');
  console.log(header);
  console.log(columns.map(() => '---').join(' | '));
  for (const row of rows) {
    console.log(columns.map((c) => c.value(row)).join(' | '));
  }
}

function printText(result, report) {
  const { inventory, counters, args } = result;

  console.log('# Token burn analysis');
  console.log(`\nWindow: ${args.start} (inclusive) to ${args.end} (exclusive)`);
  if (args.project) console.log(`Project filter: "${args.project}"`);

  console.log('\n## Data inventory\n');
  console.log(`- roots scanned: ${inventory.rootsScanned.join(', ')}`);
  console.log(`- project directories scanned: ${inventory.projectsScanned}`);
  console.log(`- main (lead) transcript files: ${inventory.mainFiles}`);
  console.log(`- subagent transcript files: ${inventory.subagentFiles}`);
  console.log(`- total bytes scanned: ${fmt(inventory.totalBytes)}`);
  console.log(`- lines scanned (all types): ${fmt(counters.linesScanned)}`);
  console.log(`- assistant-type lines: ${fmt(counters.assistantLines)}`);
  console.log(`- lines outside window: ${fmt(counters.outOfWindowSkipped)}`);
  console.log(`- synthetic (error placeholder) lines skipped: ${fmt(counters.syntheticSkipped)}`);
  console.log(`- malformed/unparseable lines: ${fmt(counters.malformedLines)}`);
  console.log(`- lines with missing usage: ${fmt(counters.missingUsage)}`);
  console.log(`- same-file duplicate lines skipped (streaming repeats): ${fmt(counters.sameFileDuplicates)}`);
  console.log(`- cross-file duplicate lines skipped (resume/fork): ${fmt(counters.crossFileDuplicates)}`);
  console.log(`- max observed repeats of one message.id: ${counters.maxRepeatsOfOneMessageId}`);
  console.log(`- inline isSidechain:true lines found in main (lead) files: ${counters.anomalySidechainInMain}`);
  console.log(`- deduped usage lines counted: ${fmt(counters.countedLines)}`);
  console.log(`- cache_creation on 5-minute TTL: ${fmt(counters.ephemeral5mCacheCreation)}`);
  console.log(`- cache_creation on 1-hour TTL: ${fmt(counters.ephemeral1hCacheCreation)}`);

  printTable(
    'Totals by project',
    [...report.byProject.entries()].sort((a, b) => b[1].input + b[1].cache_creation - (a[1].input + a[1].cache_creation)),
    [
      { label: 'project', value: ([k]) => k },
      { label: 'input', value: ([, v]) => fmt(v.input) },
      { label: 'output', value: ([, v]) => fmt(v.output) },
      { label: 'cache_creation', value: ([, v]) => fmt(v.cache_creation) },
      { label: 'cache_read', value: ([, v]) => fmt(v.cache_read) },
      { label: 'lines', value: ([, v]) => fmt(v.lines) },
    ]
  );

  printTable(
    'Totals by model (raw tokens)',
    [...report.byModel.entries()],
    [
      { label: 'model', value: ([k]) => k },
      { label: 'input', value: ([, v]) => fmt(v.input) },
      { label: 'output', value: ([, v]) => fmt(v.output) },
      { label: 'cache_creation', value: ([, v]) => fmt(v.cache_creation) },
      { label: 'cache_read', value: ([, v]) => fmt(v.cache_read) },
      { label: 'lines', value: ([, v]) => fmt(v.lines) },
    ]
  );

  printTable(
    'Totals by day',
    [...report.byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [
      { label: 'day', value: ([k]) => k },
      { label: 'input', value: ([, v]) => fmt(v.input) },
      { label: 'output', value: ([, v]) => fmt(v.output) },
      { label: 'cache_creation', value: ([, v]) => fmt(v.cache_creation) },
      { label: 'cache_read', value: ([, v]) => fmt(v.cache_read) },
    ]
  );

  printTable(
    'Totals by attribution (lead vs agentType)',
    [...report.byAttribution.entries()].sort((a, b) => b[1].input - a[1].input),
    [
      { label: 'attribution', value: ([k]) => k },
      { label: 'input', value: ([, v]) => fmt(v.input) },
      { label: 'output', value: ([, v]) => fmt(v.output) },
      { label: 'cache_creation', value: ([, v]) => fmt(v.cache_creation) },
      { label: 'cache_read', value: ([, v]) => fmt(v.cache_read) },
      { label: 'lines', value: ([, v]) => fmt(v.lines) },
    ]
  );

  printTable(
    'Cache efficiency by project (cache_read / (cache_read + cache_creation))',
    [...report.cacheEfficiencyByProject.entries()],
    [
      { label: 'project', value: ([k]) => k },
      { label: 'hit ratio', value: ([, v]) => (v == null ? 'n/a' : v.toFixed(3)) },
    ]
  );

  printTable(
    'Quota-weighted view by model (proxy USD, see WEIGHTS comment in script)',
    [...report.weightedByModel.entries()].sort((a, b) => b[1].weightedUsd - a[1].weightedUsd),
    [
      { label: 'model', value: ([k]) => k },
      { label: 'raw input', value: ([, v]) => fmt(v.rawInput) },
      { label: 'raw output', value: ([, v]) => fmt(v.rawOutput) },
      { label: 'weighted (proxy USD)', value: ([, v]) => v.weightedUsd.toFixed(2) },
      { label: 'weight known', value: ([, v]) => v.weightKnown },
    ]
  );

  printTable(
    'Top sessions by peak context (input + cache_read + cache_creation, single line)',
    report.topSessionsByPeak,
    [
      { label: 'session', value: (s) => s.key },
      { label: 'attribution', value: (s) => s.attribution },
      { label: 'model', value: (s) => s.model },
      { label: 'peak context', value: (s) => fmt(s.peak) },
      { label: 'first-request context', value: (s) => fmt(s.firstContext) },
    ]
  );

  console.log('');
}

function toJSON(result, report) {
  return {
    window: { start: result.args.start, end: result.args.end, project: result.args.project },
    inventory: result.inventory,
    counters: result.counters,
    byProject: Object.fromEntries(report.byProject),
    byModel: Object.fromEntries(report.byModel),
    byDay: Object.fromEntries(report.byDay),
    byAttribution: Object.fromEntries(report.byAttribution),
    cacheEfficiencyByProject: Object.fromEntries(report.cacheEfficiencyByProject),
    weightedByModel: Object.fromEntries(report.weightedByModel),
    sessions: report.sessionList,
    topSessionsByPeak: report.topSessionsByPeak,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await analyze(args);
  const report = buildReport(result);
  if (args.json) {
    console.log(JSON.stringify(toJSON(result, report), null, 2));
  } else {
    printText(result, report);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
