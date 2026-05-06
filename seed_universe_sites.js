#!/usr/bin/env node

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

const ACTIVE_RUNTIME_LIFECYCLES = ["seeded", "active", "paused"];
const SECURITY_BAND_ORDER = {
  highsec: 0,
  lowsec: 1,
  nullsec: 2,
  wormhole: 3,
};

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(":");
}

function parseArgs(argv) {
  const options = {
    mode: "inspect",
    force: false,
    forceReseedUniverse: false,
    forceLive: false,
    progressJson: false,
    batchSize: 192,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--seed":
        options.mode = "seed";
        break;
      case "--inspect":
        options.mode = "inspect";
        break;
      case "--force":
        options.force = true;
        break;
      case "--force-reseed-universe":
        options.mode = "seed";
        options.force = true;
        options.forceReseedUniverse = true;
        break;
      case "--force-live":
        options.forceLive = true;
        break;
      case "--progress-json":
        options.progressJson = true;
        break;
      case "--batch-size":
        options.batchSize = Math.max(16, toInt(argv[index + 1], options.batchSize));
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function findRepoRoot(startDirectory) {
  if (!startDirectory) {
    return null;
  }
  let current = path.resolve(startDirectory);
  while (true) {
    const requiredPaths = [
      path.join(current, "server", "src", "newDatabase", "data"),
      path.join(current, "server", "src", "newDatabase", "data", "dungeonAuthority", "data.json"),
      path.join(current, "server", "src", "newDatabase", "data", "dungeonRuntimeState", "data.json"),
      path.join(current, "server", "src", "newDatabase", "data", "miningRuntimeState", "data.json"),
    ];
    if (requiredPaths.every((entry) => fs.existsSync(entry))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

const options = parseArgs(process.argv.slice(2));
const toolRoot = process.env.UNIVERSE_SEEDER_TOOL_ROOT || __dirname;
const repoRoot =
  findRepoRoot(process.env.EVEJS_REPO_ROOT) ||
  findRepoRoot(__dirname) ||
  findRepoRoot(process.cwd());

function emitEvent(type, payload = {}) {
  if (!options.progressJson) {
    return;
  }
  process.stdout.write(`SEEDER_EVENT ${JSON.stringify({ type, ...payload })}\n`);
}

function printLine(message, level = "info") {
  const line = `[${formatTimestamp()}] ${message}`;
  process.stdout.write(`${line}\n`);
  emitEvent("log", {
    level,
    message,
    timestamp: new Date().toISOString(),
  });
}

function exitWithError(message, code = 1) {
  printLine(message, "error");
  emitEvent("error", {
    message,
    exitCode: code,
  });
  process.exit(code);
}

if (!repoRoot) {
  exitWithError(
    "Universe Site Seeder could not find the EvEJS repo root. Put this tool anywhere inside an EvEJS checkout that contains server/src/newDatabase/data.",
    2,
  );
}

process.chdir(repoRoot);

const config = require(path.join(repoRoot, "server/src/config"));
const worldData = require(path.join(repoRoot, "server/src/space/worldData"));
const dungeonAuthority = require(path.join(repoRoot, "server/src/services/dungeon/dungeonAuthority"));
const dungeonRuntime = require(path.join(repoRoot, "server/src/services/dungeon/dungeonRuntime"));
const dungeonRuntimeState = require(path.join(repoRoot, "server/src/services/dungeon/dungeonRuntimeState"));
const dungeonUniverseRuntime = require(path.join(repoRoot, "server/src/services/dungeon/dungeonUniverseRuntime"));
const miningResourceSiteService = require(path.join(
  repoRoot,
  "server/src/services/mining/miningResourceSiteService",
));

function detectServerActive(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: toInt(port, 0) });
    let resolved = false;

    const finish = (value) => {
      if (resolved) {
        return;
      }
      resolved = true;
      try {
        socket.destroy();
      } catch (error) {
        // ignore cleanup failures
      }
      resolve(value);
    };

    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

function buildSystemBatches(systemIDs, batchSize) {
  const ids = Array.isArray(systemIDs) ? systemIDs : [];
  const size = Math.max(16, toInt(batchSize, 192));
  const batches = [];
  for (let offset = 0; offset < ids.length; offset += size) {
    batches.push(ids.slice(offset, offset + size));
  }
  return batches;
}

function buildSystemBatchIndex(systemBatches) {
  const indexBySystemID = new Map();
  (Array.isArray(systemBatches) ? systemBatches : []).forEach((batch, batchIndex) => {
    for (const systemID of Array.isArray(batch) ? batch : []) {
      indexBySystemID.set(toInt(systemID, 0), batchIndex);
    }
  });
  return indexBySystemID;
}

function getDefinitionSecurityBand(definition) {
  return normalizeText(
    definition && definition.metadata && definition.metadata.securityBand,
    normalizeText(definition && definition.spawnState && definition.spawnState.securityBand, ""),
  ).toLowerCase();
}

function getDefinitionSlotIndex(definition) {
  return Math.max(
    0,
    toInt(
      definition && definition.metadata && definition.metadata.slotIndex,
      definition && definition.spawnState && definition.spawnState.slotIndex,
    ),
  );
}

function compareBroadDefinitionOrder(left, right, systemBatchIndexByID) {
  const leftSystemID = toInt(left && left.solarSystemID, 0);
  const rightSystemID = toInt(right && right.solarSystemID, 0);
  const leftBatch = systemBatchIndexByID.has(leftSystemID)
    ? systemBatchIndexByID.get(leftSystemID)
    : Number.MAX_SAFE_INTEGER;
  const rightBatch = systemBatchIndexByID.has(rightSystemID)
    ? systemBatchIndexByID.get(rightSystemID)
    : Number.MAX_SAFE_INTEGER;
  if (leftBatch !== rightBatch) {
    return leftBatch - rightBatch;
  }

  const leftBand = SECURITY_BAND_ORDER[getDefinitionSecurityBand(left)] ?? Number.MAX_SAFE_INTEGER;
  const rightBand = SECURITY_BAND_ORDER[getDefinitionSecurityBand(right)] ?? Number.MAX_SAFE_INTEGER;
  if (leftBand !== rightBand) {
    return leftBand - rightBand;
  }

  if (leftSystemID !== rightSystemID) {
    return leftSystemID - rightSystemID;
  }

  const leftSlot = getDefinitionSlotIndex(left);
  const rightSlot = getDefinitionSlotIndex(right);
  if (leftSlot !== rightSlot) {
    return leftSlot - rightSlot;
  }

  return normalizeText(left && left.siteKey, "").localeCompare(
    normalizeText(right && right.siteKey, ""),
  );
}

function summarizeRuntimeFamilies() {
  const families = dungeonAuthority.listUniverseSpawnFamilies();
  const counts = {};
  for (const family of families) {
    counts[family] = 0;
  }
  let broadCount = 0;
  let generatedMiningCount = 0;

  for (const lifecycle of ACTIVE_RUNTIME_LIFECYCLES) {
    for (const instance of dungeonRuntime.listInstancesByLifecycle(lifecycle, { full: true })) {
      if (
        !instance ||
        (instance.runtimeFlags && instance.runtimeFlags.shadowProviderSite === true)
      ) {
        continue;
      }
      const siteOrigin = normalizeText(instance.siteOrigin, "").toLowerCase();
      if (siteOrigin === "generatedmining") {
        generatedMiningCount += 1;
        continue;
      }
      const spawnFamily = normalizeText(
        instance && instance.metadata && instance.metadata.spawnFamilyKey,
        normalizeText(instance && instance.spawnState && instance.spawnState.spawnFamilyKey, instance && instance.siteFamily),
      ).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(counts, spawnFamily)) {
        counts[spawnFamily] += 1;
        broadCount += 1;
      }
    }
  }

  return {
    broadCount,
    generatedMiningCount,
    byFamily: counts,
  };
}

function buildInspectSummary(nowMs) {
  const status = dungeonUniverseRuntime.getUniverseReconcileStatus(nowMs);
  const runtimeCounts = summarizeRuntimeFamilies();
  const systems = worldData.getSolarSystems();
  const families = dungeonAuthority.listUniverseSpawnFamilies();
  return {
    mode: options.mode,
    repoRoot,
    cpuCores: Math.max(1, toInt(os.cpus().length, 1)),
    batchSize: options.batchSize,
    serverPort: toInt(config.serverPort, 0),
    systemCount: systems.length,
    universeFamilies: families,
    runtimeCounts,
    status,
  };
}

function printInspectSummary(summary) {
  const statusLabel = summary.status.fullUpToDate === true ? "current" : "stale";
  printLine(`Repo root: ${summary.repoRoot}`);
  printLine(`Universe status: ${statusLabel}`);
  printLine(
    `Systems: ${summary.systemCount} | families: ${summary.universeFamilies.length} | CPU cores: ${summary.cpuCores}`,
  );
  printLine(
    `Runtime counts -> broad: ${summary.runtimeCounts.broadCount}, generated mining: ${summary.runtimeCounts.generatedMiningCount}`,
  );
}

function mergeFamilySummaries(target, patch) {
  const output = target || {};
  for (const [family, familySummary] of Object.entries(patch || {})) {
    if (!output[family]) {
      output[family] = {
        desiredSiteCount: 0,
        systemsTouched: 0,
        templateCount: 0,
      };
    }
    output[family].desiredSiteCount += toInt(familySummary && familySummary.desiredSiteCount, 0);
    output[family].systemsTouched += toInt(familySummary && familySummary.systemsTouched, 0);
    output[family].templateCount = Math.max(
      output[family].templateCount,
      toInt(familySummary && familySummary.templateCount, 0),
    );
  }
  return output;
}

function buildProgressPayload(phase, current, total, extras = {}) {
  const normalizedTotal = Math.max(1, toInt(total, 1));
  const normalizedCurrent = Math.max(0, Math.min(normalizedTotal, toInt(current, 0)));
  return {
    phase,
    current: normalizedCurrent,
    total: normalizedTotal,
    ratio: normalizedCurrent / normalizedTotal,
    ...extras,
  };
}

function emitPhaseProgress(phase, progress = {}, defaults = {}) {
  const {
    current,
    total,
    phase: _ignoredPhase,
    ratio: _ignoredRatio,
    ...extras
  } = progress || {};
  emitEvent("phase", buildProgressPayload(
    phase,
    current,
    total,
    {
      ...defaults,
      ...extras,
      label: normalizeText(extras.label, defaults.label || phase),
    },
  ));
}

async function runSeed(nowMs) {
  const status = dungeonUniverseRuntime.getUniverseReconcileStatus(nowMs);
  const descriptor = dungeonUniverseRuntime._testing.buildUniverseDescriptor(nowMs);
  if (status.fullUpToDate === true && options.force !== true) {
    const runtimeCounts = summarizeRuntimeFamilies();
    const summary = {
      skipped: true,
      reason: "already_current",
      desiredSiteCount: 0,
      mining: { desiredSiteCount: 0 },
      families: {},
      createdInstances: 0,
      retainedInstances: 0,
      replacedInstances: 0,
      removedInstances: 0,
      miningStateRowsCreated: 0,
      miningStateRowsRemoved: 0,
      runtimeCounts,
    };
    printLine("Universe site state is already current. Nothing to seed.");
    emitEvent("summary", { summary });
    emitEvent("complete", { summary });
    return summary;
  }

  const systemIDs = dungeonUniverseRuntime._testing.normalizeSystemIDs();
  const batchSize = Math.max(16, toInt(options.batchSize, 192));
  const systemBatches = buildSystemBatches(systemIDs, batchSize);
  const systemBatchIndexByID = buildSystemBatchIndex(systemBatches);
  const families = dungeonAuthority.listUniverseSpawnFamilies();
  const startedAtMs = Date.now();
  const shadowCleanup = dungeonRuntime.purgeShadowProviderInstances({
    providerID: "generatedmining",
  });

  if (shadowCleanup.removedCount > 0) {
    printLine(
      `Purged ${shadowCleanup.removedCount} persisted generated-mining shadow adapter instance` +
      `${shadowCleanup.removedCount === 1 ? "" : "s"} before reseed cleanup.`,
    );
  }

  if (options.forceReseedUniverse === true) {
    printLine("Force reseed requested. Rebuilding the full persistent universe even though the current descriptor may already match.");
  }
  printLine(`Seeding the universe across ${systemIDs.length} systems.`);
  printLine(`Using bundled seeder assets with repo-native authority from server/src/newDatabase/data.`);
  emitEvent("status", {
    mode: "seed",
    repoRoot,
    systemCount: systemIDs.length,
    familyCount: families.length,
    batchSize,
    forceReseedUniverse: options.forceReseedUniverse === true,
  });

  const miningDefinitions = [];
  const allDefinitions = [];
  emitEvent("phase", buildProgressPayload("build_mining", 0, systemIDs.length, {
    label: "Building generated mining definitions",
  }));
  printLine("Phase 1/4: building generated mining definitions...");
  let miningSystemsProcessed = 0;
  for (const batchSystemIDs of systemBatches) {
    const batchDefinitions = dungeonUniverseRuntime.listDesiredGeneratedMiningDefinitions(batchSystemIDs, nowMs);
    miningDefinitions.push(...batchDefinitions);
    allDefinitions.push(...batchDefinitions);
    miningSystemsProcessed += batchSystemIDs.length;
    emitEvent("phase", buildProgressPayload(
      "build_mining",
      miningSystemsProcessed,
      systemIDs.length,
      {
        label: "Building generated mining definitions",
        sitesBuilt: miningDefinitions.length,
      },
    ));
  }
  printLine(`Generated mining definitions built: ${miningDefinitions.length}`);

  let broadDefinitionCount = 0;
  const familySummaries = {};
  const broadTotalWorkUnits = Math.max(1, families.length);
  const familyWorkItems = families.map((family) => ({
    family,
    queryOptions: { families: [family] },
  }));
  printLine("Phase 2/4: building persistent broad-family site definitions...");
  emitEvent("phase", buildProgressPayload("build_broad", 0, broadTotalWorkUnits, {
    label: "Building persistent universe site definitions",
    sitesBuilt: broadDefinitionCount,
  }));

  familyWorkItems.forEach(({ family, queryOptions }, familyIndex) => {
    const familyResult = dungeonUniverseRuntime.listDesiredUniverseDungeonSiteDefinitions(
      systemIDs,
      nowMs,
      queryOptions,
    );
    const familyDefinitions = (Array.isArray(familyResult.definitions)
      ? familyResult.definitions
      : [])
      .sort((left, right) => compareBroadDefinitionOrder(
        left,
        right,
        systemBatchIndexByID,
      ));
    allDefinitions.push(...familyDefinitions);
    const familyDefinitionCount = familyDefinitions.length;
    broadDefinitionCount += familyDefinitionCount;
    mergeFamilySummaries(familySummaries, familyResult.families);
    emitEvent("phase", buildProgressPayload(
      "build_broad",
      familyIndex + 1,
      broadTotalWorkUnits,
      {
        label: `Building ${family} family definitions`,
        family,
        familySiteCount: familyDefinitionCount,
        sitesBuilt: broadDefinitionCount,
      },
    ));
    printLine(`  ${family}: ${familyDefinitionCount} desired sites`);
  });

  printLine(`Broad persistent definitions built: ${broadDefinitionCount}`);
  printLine(`Total desired universe sites: ${allDefinitions.length}`);

  printLine("Phase 3/4: applying dungeon runtime instances...");
  let applyInstanceProgressTotal = Math.max(1, allDefinitions.length);
  emitEvent("phase", buildProgressPayload("apply_instances", 0, applyInstanceProgressTotal, {
    label: "Applying dungeon runtime instances",
    desiredSiteCount: allDefinitions.length,
  }));
  const instanceSummary = dungeonRuntime.reconcileUniverseSeededInstances(allDefinitions, {
    systemIDs,
    nowMs,
    skipNoopReconcileWrite: status.fullUpToDate === true,
    onProgress(progress) {
      applyInstanceProgressTotal = Math.max(
        applyInstanceProgressTotal,
        toInt(progress && progress.total, applyInstanceProgressTotal),
      );
      emitPhaseProgress("apply_instances", progress, {
        label: "Applying dungeon runtime instances",
        desiredSiteCount: allDefinitions.length,
      });
    },
  });
  emitEvent("phase", buildProgressPayload("apply_instances", applyInstanceProgressTotal, applyInstanceProgressTotal, {
    label: "Applying dungeon runtime instances",
    desiredSiteCount: allDefinitions.length,
    summary: instanceSummary,
  }));
  printLine(
    `Dungeon instances -> created ${instanceSummary.createdCount}, retained ${instanceSummary.retainedCount}, ` +
    `replaced ${instanceSummary.replacedCount}, removed ${instanceSummary.removedCount}`,
  );

  printLine("Phase 4/4: applying generated mining child-state rows...");
  const miningRuntimeProgressTotal = Math.max(1, miningDefinitions.length + systemIDs.length);
  emitEvent("phase", buildProgressPayload("apply_mining_rows", 0, miningRuntimeProgressTotal, {
    label: "Applying generated mining runtime rows",
    desiredSiteCount: miningDefinitions.length,
  }));
  const miningRuntimeSummary = dungeonUniverseRuntime._testing.reconcileGeneratedMiningRuntimeState(
    miningDefinitions,
    systemIDs,
    nowMs,
    {
      onProgress(progress) {
        emitPhaseProgress("apply_mining_rows", progress, {
          label: "Applying generated mining runtime rows",
          desiredSiteCount: miningDefinitions.length,
        });
      },
    },
  );
  emitEvent("phase", buildProgressPayload("apply_mining_rows", miningRuntimeProgressTotal, miningRuntimeProgressTotal, {
    label: "Applying generated mining runtime rows",
    desiredSiteCount: miningDefinitions.length,
    summary: miningRuntimeSummary,
  }));
  printLine(
    `Mining runtime rows -> created ${miningRuntimeSummary.createdRows}, removed ${miningRuntimeSummary.removedRows}`,
  );

  const summary = {
    forceReseedUniverse: options.forceReseedUniverse === true,
    systemCount: systemIDs.length,
    desiredSiteCount: allDefinitions.length,
    createdInstances: instanceSummary.createdCount,
    retainedInstances: instanceSummary.retainedCount,
    replacedInstances: instanceSummary.replacedCount,
    removedInstances: instanceSummary.removedCount,
    miningStateRowsCreated: miningRuntimeSummary.createdRows,
    miningStateRowsRemoved: miningRuntimeSummary.removedRows,
    mining: {
      desiredSiteCount: miningDefinitions.length,
    },
    families: familySummaries,
    elapsedMs: Date.now() - startedAtMs,
  };

  dungeonRuntimeState.writeUniverseReconcileMeta({
    version: 1,
    descriptorKey: descriptor.descriptorKey,
    broadDescriptorKey: descriptor.broadDescriptorKey,
    miningDescriptorKey: descriptor.miningDescriptorKey,
    lastStartedAtMs: startedAtMs,
    lastCompletedAtMs: Date.now(),
    lastScope: "full",
    lastReason: "manual-seeder",
    summary,
  }, {
    flushDelayMs: 1,
  });

  printLine(
    `Universe seed complete in ${summary.elapsedMs}ms across ${summary.systemCount} systems.`,
    "success",
  );
  emitEvent("summary", { summary });
  emitEvent("complete", { summary });
  return summary;
}

async function main() {
  emitEvent("repo", {
    repoRoot,
    dataRoot: path.join(repoRoot, "server", "src", "newDatabase", "data"),
    toolRoot,
  });

  const active = options.forceLive !== true
    ? await detectServerActive(config.serverPort)
    : false;
  if (active) {
    exitWithError(
      `The game server appears to be running on port ${config.serverPort}. Stop it before seeding, or rerun with --force-live if you really want to bypass this guard.`,
      3,
    );
  }

  const nowMs = Date.now();
  const inspectSummary = buildInspectSummary(nowMs);
  emitEvent("inspect", inspectSummary);
  printInspectSummary(inspectSummary);

  if (options.mode === "inspect") {
    emitEvent("complete", { summary: inspectSummary });
    return;
  }

  await runSeed(nowMs);
}

main().catch((error) => {
  exitWithError(error && error.stack ? error.stack : error.message);
});
