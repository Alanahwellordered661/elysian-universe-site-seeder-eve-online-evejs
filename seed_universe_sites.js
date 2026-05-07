#!/usr/bin/env node

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
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
let buildSolarAuthorityFailureForSystems = null;
try {
  ({ buildSolarAuthorityFailureForSystems } = require(path.join(
    repoRoot,
    "server/src/cluster/solarProcessAuthority",
  )));
} catch (error) {
  buildSolarAuthorityFailureForSystems = null;
}
const reconcileUniverseSeededInstances =
  canUseEmbeddedOfflineReconcile()
    ? reconcileUniverseSeededInstancesFast
    : (
      typeof dungeonRuntime.reconcileUniverseSeededInstancesOffline === "function"
        ? dungeonRuntime.reconcileUniverseSeededInstancesOffline
        : dungeonRuntime.reconcileUniverseSeededInstances
    );

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

function canUseEmbeddedOfflineReconcile() {
  return (
    typeof dungeonAuthority.getTemplateByID === "function" &&
    typeof dungeonRuntimeState.loadState === "function" &&
    typeof dungeonRuntimeState.writeState === "function" &&
    typeof dungeonRuntimeState.normalizeInstanceRecord === "function" &&
    typeof dungeonRuntimeState.isActiveLifecycleState === "function"
  );
}

function normalizeOwnership(options = {}) {
  const sharedWithCharacterIDs = [...new Set((Array.isArray(options.sharedWithCharacterIDs)
    ? options.sharedWithCharacterIDs
    : [])
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0))].sort((left, right) => left - right);
  return {
    visibilityScope: normalizeText(options.visibilityScope, "public").toLowerCase(),
    characterID: Math.max(0, toInt(options.characterID, 0)) || null,
    corporationID: Math.max(0, toInt(options.corporationID, 0)) || null,
    fleetID: Math.max(0, toInt(options.fleetID, 0)) || null,
    missionOwnerCharacterID: Math.max(0, toInt(options.missionOwnerCharacterID, 0)) || null,
    sharedWithCharacterIDs,
    metadata: normalizeObject(options.metadata) ? cloneValue(normalizeObject(options.metadata)) : {},
  };
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value) && value.length >= 3) {
    return {
      x: Number(value[0]) || 0,
      y: Number(value[1]) || 0,
      z: Number(value[2]) || 0,
    };
  }
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    z: Number(value.z) || 0,
  };
}

function normalizeConnections(template) {
  if (Array.isArray(template && template.connections)) {
    return template.connections
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => cloneValue(entry));
  }
  if (template && template.connections && typeof template.connections === "object") {
    return Object.entries(template.connections)
      .filter(([, entry]) => entry && typeof entry === "object")
      .map(([connectionKey, entry]) => ({
        connectionKey,
        ...cloneValue(entry),
      }));
  }
  return [];
}

function listOrderedTemplateRoomKeys(template) {
  const roomKeys = ["room:entry"];
  const environmentTemplates = normalizeObject(template && template.environmentTemplates);
  const roomTemplates = normalizeObject(environmentTemplates.roomTemplates);
  const orderedRoomObjectIDs = Object.keys(roomTemplates)
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0)
    .sort((left, right) => left - right);
  for (const roomObjectID of orderedRoomObjectIDs) {
    roomKeys.push(`room:${roomObjectID}`);
  }
  return roomKeys;
}

function buildDefaultRoomStates(template, nowMs, definition = {}) {
  if (definition.roomStatesByKey && typeof definition.roomStatesByKey === "object") {
    return cloneValue(definition.roomStatesByKey);
  }

  const roomStatesByKey = {
    "room:entry": {
      roomKey: "room:entry",
      state: "active",
      stage: "entry",
      pocketID: null,
      nodeGraphID:
        template &&
        template.clientObjectives &&
        Number(template.clientObjectives.nodeGraphID) > 0
          ? Number(template.clientObjectives.nodeGraphID)
          : null,
      activatedAtMs: nowMs,
      completedAtMs: 0,
      lastUpdatedAtMs: nowMs,
      spawnedEntityIDs: [],
      counters: {},
      metadata: {
        seededFromTemplate: true,
      },
    },
  };

  const environmentTemplates = normalizeObject(template && template.environmentTemplates);
  const roomTemplates = normalizeObject(environmentTemplates.roomTemplates);
  for (const roomObjectID of Object.keys(roomTemplates)) {
    const roomKey = `room:${normalizeText(roomObjectID, "")}`;
    if (roomKey === "room:" || roomStatesByKey[roomKey]) {
      continue;
    }
    roomStatesByKey[roomKey] = {
      roomKey,
      state: "pending",
      stage: "room",
      pocketID: toInt(roomObjectID, 0) || null,
      nodeGraphID: null,
      activatedAtMs: 0,
      completedAtMs: 0,
      lastUpdatedAtMs: nowMs,
      spawnedEntityIDs: [],
      counters: {},
      metadata: {
        seededFromTemplate: true,
      },
    };
  }

  return roomStatesByKey;
}

function buildDefaultGateStates(template, nowMs, definition = {}) {
  if (definition.gateStatesByKey && typeof definition.gateStatesByKey === "object") {
    return cloneValue(definition.gateStatesByKey);
  }

  const connections = normalizeConnections(template);
  const orderedRoomKeys = listOrderedTemplateRoomKeys(template);
  const gateStatesByKey = {};
  connections.forEach((connection, index) => {
    const fromObjectID = toInt(connection && connection.fromObjectID, 0);
    const toObjectID = toInt(connection && connection.toObjectID, 0);
    const explicitDestinationRoomKey = toObjectID > 0 ? `room:${toObjectID}` : null;
    const inferredDestinationRoomKey =
      explicitDestinationRoomKey && orderedRoomKeys.includes(explicitDestinationRoomKey)
        ? explicitDestinationRoomKey
        : (
          orderedRoomKeys.length > 1
            ? orderedRoomKeys[Math.min(index + 1, orderedRoomKeys.length - 1)]
            : "room:entry"
        );
    const gateKey = `gate:${fromObjectID || (index + 1)}`;
    const defaultState = inferredDestinationRoomKey === "room:entry" ? "unlocked" : "locked";
    gateStatesByKey[gateKey] = {
      gateKey,
      state: defaultState,
      usesCount: 0,
      unlockedAtMs: defaultState === "unlocked" ? nowMs : 0,
      lastUsedAtMs: 0,
      destinationRoomKey: inferredDestinationRoomKey || null,
      allowedShipGroupIDs: [],
      allowedShipTypeIDs: [],
      metadata: {
        seededFromTemplate: true,
        connectionIndex: index,
        connectionKey: connection && connection.connectionKey ? connection.connectionKey : null,
        fromObjectID: fromObjectID || null,
        toObjectID: toObjectID || null,
        inferredDestinationRoomKey: inferredDestinationRoomKey || null,
        allowedShipsList: toInt(connection && connection.allowedShipsList, 0) || null,
        allowedRaces: Array.isArray(connection && connection.allowedRaces)
          ? cloneValue(connection.allowedRaces)
          : [],
        rawConnection: cloneValue(connection),
      },
    };
  });

  return gateStatesByKey;
}

function buildDefaultObjectiveState(template, nowMs, definition = {}) {
  if (definition.objectiveState && typeof definition.objectiveState === "object") {
    return cloneValue(definition.objectiveState);
  }

  const clientObjectives = normalizeObject(template && template.clientObjectives);
  const objectiveMetadata = normalizeObject(template && template.objectiveMetadata);
  const objectiveChain = normalizeObject(objectiveMetadata.objectiveChain);
  const seededObjectives = Array.isArray(objectiveChain.objectives)
    ? objectiveChain.objectives
    : [];
  const seededCurrentObjective = seededObjectives.find((objective) => (
    objective && (objective.startActive === 1 || objective.startActive === true)
  )) || seededObjectives[0] || null;
  return {
    state: Object.keys(clientObjectives).length > 0 ? "seeded" : "pending",
    currentNodeID: Number(clientObjectives.nodeGraphID) > 0
      ? Number(clientObjectives.nodeGraphID)
      : null,
    currentObjectiveID: Number(clientObjectives.objectiveChainID) > 0
      ? Number(clientObjectives.objectiveChainID)
      : null,
    currentObjectiveKey:
      seededCurrentObjective && seededCurrentObjective.key
        ? String(seededCurrentObjective.key)
        : null,
    currentObjectiveTypeID:
      seededCurrentObjective && Number(seededCurrentObjective.objectiveType) > 0
        ? Number(seededCurrentObjective.objectiveType)
        : null,
    completedObjectiveIDs: [],
    completedNodeIDs: [],
    counters: {},
    metadata: {
      seededFromTemplate: true,
      objectivesID: toInt(template && template.objectivesID, 0) || null,
      objectiveChainID: Number(clientObjectives.objectiveChainID) > 0
        ? Number(clientObjectives.objectiveChainID)
        : null,
      nodeGraphID: Number(clientObjectives.nodeGraphID) > 0
        ? Number(clientObjectives.nodeGraphID)
        : null,
      blackboardParameters: Array.isArray(clientObjectives.blackboardParameters)
        ? cloneValue(clientObjectives.blackboardParameters)
        : [],
      objectiveSummary: Object.keys(objectiveChain).length > 0
        ? {
          name: normalizeText(objectiveChain.name, "") || null,
          tags: Array.isArray(objectiveChain.tags) ? cloneValue(objectiveChain.tags) : [],
          objectiveKeys: seededObjectives
            .map((objective) => normalizeText(objective && objective.key, ""))
            .filter(Boolean),
        }
        : null,
      objectiveTypeIDs: Array.isArray(objectiveMetadata.objectiveTypeIDs)
        ? cloneValue(objectiveMetadata.objectiveTypeIDs)
        : [],
      nodeTypeIDs: Array.isArray(objectiveMetadata.nodeTypeIDs)
        ? cloneValue(objectiveMetadata.nodeTypeIDs)
        : [],
      seededAtMs: nowMs,
    },
  };
}

function buildDefaultEnvironmentState(template, nowMs, definition = {}) {
  if (definition.environmentState && typeof definition.environmentState === "object") {
    return cloneValue(definition.environmentState);
  }
  const environmentTemplates = normalizeObject(template && template.environmentTemplates);
  return {
    seededAtMs: nowMs,
    templates: Object.keys(environmentTemplates).length > 0
      ? cloneValue(environmentTemplates)
      : null,
  };
}

function buildInstanceRecordFromDefinition(instanceID, template, definition = {}, nowMs = Date.now()) {
  const solarSystemID = Math.max(0, toInt(definition.solarSystemID, 0));
  const createdAtMs = nowMs;
  const activatedAtMs = Math.max(0, toInt(definition.activatedAtMs, createdAtMs));
  const expiresAtMs = Math.max(0, toInt(definition.expiresAtMs, 0));
  const despawnAtMs = Math.max(0, toInt(definition.despawnAtMs, 0));

  return {
    instanceID,
    templateID: template.templateID,
    solarSystemID,
    siteKey: normalizeText(definition.siteKey, "") || null,
    lifecycleState: normalizeText(definition.lifecycleState, "seeded").toLowerCase(),
    lifecycleReason: normalizeText(definition.lifecycleReason, "") || null,
    instanceScope: normalizeText(definition.instanceScope, "shared").toLowerCase(),
    siteFamily: normalizeText(definition.siteFamily, template.siteFamily || "unknown").toLowerCase(),
    siteKind: normalizeText(definition.siteKind, template.siteKind || "unknown").toLowerCase(),
    siteOrigin: normalizeText(definition.siteOrigin, template.siteOrigin || "unknown").toLowerCase(),
    source: normalizeText(template.source, "unknown").toLowerCase(),
    sourceDungeonID: template.sourceDungeonID || null,
    archetypeID: template.archetypeID || null,
    factionID: template.factionID || null,
    difficulty: template.difficulty || null,
    entryObjectTypeID: template.entryObjectTypeID || null,
    dungeonNameID: template.dungeonNameID || null,
    position: normalizePosition(definition.position),
    ownership: normalizeOwnership(definition.ownership || definition),
    timers: {
      createdAtMs,
      activatedAtMs,
      expiresAtMs,
      despawnAtMs,
      lastUpdatedAtMs: nowMs,
    },
    roomStatesByKey: buildDefaultRoomStates(template, nowMs, definition),
    gateStatesByKey: buildDefaultGateStates(template, nowMs, definition),
    objectiveState: buildDefaultObjectiveState(template, nowMs, definition),
    hazardState: definition.hazardState && typeof definition.hazardState === "object"
      ? cloneValue(definition.hazardState)
      : {},
    environmentState: buildDefaultEnvironmentState(template, nowMs, definition),
    spawnState: definition.spawnState && typeof definition.spawnState === "object"
      ? cloneValue(definition.spawnState)
      : {},
    runtimeFlags: definition.runtimeFlags && typeof definition.runtimeFlags === "object"
      ? cloneValue(definition.runtimeFlags)
      : {},
    metadata: definition.metadata && typeof definition.metadata === "object"
      ? cloneValue(definition.metadata)
      : {},
  };
}

function normalizeTextFilterSet(values = []) {
  const entries = Array.isArray(values) ? values : [values];
  const normalized = [...new Set(entries
    .map((entry) => normalizeText(entry, "").toLowerCase())
    .filter(Boolean))];
  return normalized.length > 0 ? new Set(normalized) : null;
}

function definitionsMatchActiveUniverseInstance(instance, definition, template) {
  if (!instance || !definition || !template) {
    return false;
  }
  if (!dungeonRuntimeState.isActiveLifecycleState(instance.lifecycleState)) {
    return false;
  }
  if (normalizeText(instance.templateID, "") !== normalizeText(template.templateID, "")) {
    return false;
  }
  if (normalizeText(instance.siteKey, "") !== normalizeText(definition.siteKey, "")) {
    return false;
  }
  const existingHash = normalizeText(instance.metadata && instance.metadata.definitionHash, "");
  const desiredHash = normalizeText(definition.metadata && definition.metadata.definitionHash, "");
  return !!existingHash && existingHash === desiredHash;
}

function buildDungeonAuthorityFailure(systemIDs) {
  if (typeof buildSolarAuthorityFailureForSystems !== "function") {
    return null;
  }
  const failure = buildSolarAuthorityFailureForSystems(systemIDs, {
    operation: "reconcileUniverseSeededInstances",
  });
  if (!failure) {
    return null;
  }
  return {
    ...failure,
    errorMsg: "SOLAR_DUNGEON_AUTHORITY_DENIED",
    reasonCode: failure.reasonCode || failure.errorMsg || "SOLAR_AUTHORITY_DENIED",
  };
}

function reconcileUniverseSeededInstancesFast(definitions = [], reconcileOptions = {}) {
  const normalizedDefinitions = (Array.isArray(definitions) ? definitions : [])
    .filter((definition) => definition && definition.templateID && definition.siteKey)
    .map((definition) => ({
      ...definition,
      solarSystemID: Math.max(0, toInt(definition.solarSystemID, 0)),
      siteKey: normalizeText(definition.siteKey, ""),
      templateID: normalizeText(definition.templateID, ""),
    }))
    .filter((definition) => definition.solarSystemID > 0 && definition.siteKey && definition.templateID);

  const onProgress =
    typeof reconcileOptions.onProgress === "function"
      ? reconcileOptions.onProgress
      : null;
  let progressCurrent = 0;
  let progressTotal = Math.max(1, normalizedDefinitions.length);
  let progressLastPercent = -1;
  function emitReconcileProgress(label, extras = {}) {
    if (!onProgress) {
      return;
    }
    const boundedCurrent = Math.max(0, Math.min(progressTotal, progressCurrent));
    const percent = Math.floor((boundedCurrent / progressTotal) * 100);
    if (percent === progressLastPercent && boundedCurrent < progressTotal) {
      return;
    }
    progressLastPercent = percent;
    try {
      onProgress({
        current: boundedCurrent,
        total: progressTotal,
        label,
        desiredCount: normalizedDefinitions.length,
        ...extras,
      });
    } catch (error) {
      // Progress callbacks are UI-only; reconciliation must keep going.
    }
  }
  function advanceReconcileProgress(amount, label, extras = {}) {
    progressCurrent += Math.max(0, toInt(amount, 0));
    emitReconcileProgress(label, extras);
  }

  const targetedSystemIDs = new Set(
    (Array.isArray(reconcileOptions.systemIDs)
      ? reconcileOptions.systemIDs
      : normalizedDefinitions.map((definition) => definition.solarSystemID))
      .map((entry) => Math.max(0, toInt(entry, 0)))
      .filter((entry) => entry > 0),
  );
  const authorityFailure = buildDungeonAuthorityFailure([...targetedSystemIDs]);
  if (authorityFailure) {
    return {
      ...authorityFailure,
      desiredCount: normalizedDefinitions.length,
      createdCount: 0,
      retainedCount: 0,
      replacedCount: 0,
      removedCount: 0,
    };
  }

  const siteFamilyFilter = normalizeTextFilterSet(reconcileOptions.siteFamilyFilter || []);
  const spawnFamilyFilter = normalizeTextFilterSet(reconcileOptions.spawnFamilyFilter || []);
  const siteOriginFilter = normalizeTextFilterSet(reconcileOptions.siteOriginFilter || []);
  const desiredBySiteKey = new Map(
    normalizedDefinitions.map((definition) => [definition.siteKey, definition]),
  );
  const templatesByID = new Map();
  for (const definition of normalizedDefinitions) {
    if (!templatesByID.has(definition.templateID)) {
      const template = dungeonAuthority.getTemplateByID(definition.templateID);
      if (!template) {
        throw new Error(`Unknown dungeon template: ${definition.templateID}`);
      }
      templatesByID.set(definition.templateID, template);
    }
  }
  emitReconcileProgress("Preparing dungeon instance reconciliation");

  function isScopedUniverseInstance(instance) {
    if (
      !instance ||
      !(instance.runtimeFlags && instance.runtimeFlags.universeSeeded === true)
    ) {
      return false;
    }
    if (
      siteFamilyFilter &&
      !siteFamilyFilter.has(normalizeText(instance.siteFamily, "").toLowerCase())
    ) {
      return false;
    }
    const instanceSpawnFamilyKey = normalizeText(
      instance &&
      instance.metadata &&
      instance.metadata.spawnFamilyKey,
      normalizeText(
        instance &&
        instance.spawnState &&
        instance.spawnState.spawnFamilyKey,
        instance && instance.siteFamily,
      ),
    ).toLowerCase();
    if (spawnFamilyFilter && !spawnFamilyFilter.has(instanceSpawnFamilyKey)) {
      return false;
    }
    if (
      siteOriginFilter &&
      !siteOriginFilter.has(normalizeText(instance.siteOrigin, "").toLowerCase())
    ) {
      return false;
    }
    return !(
      targetedSystemIDs.size > 0 &&
      !targetedSystemIDs.has(Math.max(0, toInt(instance.solarSystemID, 0)))
    );
  }

  function buildNoopReconcileSummary() {
    const state = dungeonRuntimeState.loadState();
    const existingBySiteKey = new Map();
    for (const [instanceID, rawInstance] of Object.entries(state && state.instancesByID || {})) {
      if (!rawInstance || typeof rawInstance !== "object") {
        continue;
      }
      const instance = rawInstance.instanceID != null
        ? rawInstance
        : {
          ...rawInstance,
          instanceID: toInt(instanceID, 0),
        };
      if (!isScopedUniverseInstance(instance)) {
        continue;
      }
      existingBySiteKey.set(instance.siteKey, instance);
    }

    for (const siteKey of existingBySiteKey.keys()) {
      if (!desiredBySiteKey.has(siteKey)) {
        return null;
      }
    }

    let retainedCount = 0;
    for (const definition of normalizedDefinitions) {
      const template = templatesByID.get(definition.templateID);
      const existing = existingBySiteKey.get(definition.siteKey) || null;
      if (!existing || !definitionsMatchActiveUniverseInstance(existing, definition, template)) {
        return null;
      }
      retainedCount += 1;
    }

    return {
      desiredCount: normalizedDefinitions.length,
      createdCount: 0,
      retainedCount,
      replacedCount: 0,
      removedCount: 0,
    };
  }

  const noopSummary = buildNoopReconcileSummary();
  if (noopSummary) {
    progressCurrent = progressTotal;
    emitReconcileProgress("Dungeon instance reconciliation already current", noopSummary);
    return noopSummary;
  }

  const nowMs = Math.max(0, toInt(reconcileOptions.nowMs, Date.now()));
  let removedBeforeCount = 0;
  let createdCount = 0;
  let retainedCount = 0;
  let replacedCount = 0;
  const table = cloneValue(dungeonRuntimeState.loadState());
  table.instancesByID = table.instancesByID || {};
  const instancesByID = table.instancesByID;
  const instanceEntries = Object.entries(instancesByID);
  progressCurrent = 0;
  progressTotal = Math.max(
    1,
    instanceEntries.length + instanceEntries.length + normalizedDefinitions.length,
  );
  progressLastPercent = -1;
  emitReconcileProgress("Scanning existing dungeon instances", {
    existingCount: instanceEntries.length,
  });

  const existingBySiteKey = new Map();
  let scannedEntries = 0;
  function noteScannedEntry() {
    scannedEntries += 1;
    advanceReconcileProgress(1, "Scanning existing dungeon instances", {
      existingCount: instanceEntries.length,
      scannedEntries,
      candidateCount: existingBySiteKey.size,
    });
  }
  for (const [instanceID, rawInstance] of instanceEntries) {
    const instance = dungeonRuntimeState.normalizeInstanceRecord({
      ...rawInstance,
      instanceID: toInt(rawInstance && rawInstance.instanceID, toInt(instanceID, 0)),
    });
    if (!isScopedUniverseInstance(instance)) {
      noteScannedEntry();
      continue;
    }
    existingBySiteKey.set(instance.siteKey, instance);
    noteScannedEntry();
  }

  for (const [siteKey, instance] of existingBySiteKey.entries()) {
    if (!desiredBySiteKey.has(siteKey)) {
      removedBeforeCount += 1;
      delete instancesByID[String(instance.instanceID)];
    }
    advanceReconcileProgress(1, "Removing stale dungeon instances", {
      candidateCount: existingBySiteKey.size,
      removedCount: removedBeforeCount,
    });
  }
  if (instanceEntries.length > existingBySiteKey.size) {
    advanceReconcileProgress(
      instanceEntries.length - existingBySiteKey.size,
      "Removing stale dungeon instances",
      {
        candidateCount: existingBySiteKey.size,
        removedCount: removedBeforeCount,
      },
    );
  }

  let nextInstanceSequence = Math.max(1, toInt(table.nextInstanceSequence, 1));
  let appliedDefinitions = 0;
  for (const definition of normalizedDefinitions) {
    appliedDefinitions += 1;
    const template = templatesByID.get(definition.templateID);
    const existing = existingBySiteKey.get(definition.siteKey) || null;
    if (existing && definitionsMatchActiveUniverseInstance(existing, definition, template)) {
      retainedCount += 1;
      advanceReconcileProgress(1, "Applying dungeon instance definitions", {
        appliedDefinitions,
        retainedCount,
      });
      continue;
    }
    if (existing) {
      removedBeforeCount += 1;
      delete instancesByID[String(existing.instanceID)];
      replacedCount += 1;
    }
    const nextInstanceID = nextInstanceSequence;
    nextInstanceSequence += 1;
    const created = buildInstanceRecordFromDefinition(
      nextInstanceID,
      template,
      definition,
      nowMs,
    );
    instancesByID[String(nextInstanceID)] = created;
    createdCount += 1;
    advanceReconcileProgress(1, "Applying dungeon instance definitions", {
      appliedDefinitions,
      createdCount,
      retainedCount,
      replacedCount,
    });
  }
  table.nextInstanceSequence = nextInstanceSequence;

  const writeSucceeded = dungeonRuntimeState.writeState(table);
  if (writeSucceeded !== true) {
    throw new Error("Failed to write dungeon runtime state during universe site reconcile.");
  }

  progressCurrent = progressTotal;
  emitReconcileProgress("Dungeon instance reconciliation complete", {
    createdCount,
    retainedCount,
    replacedCount,
    removedCount: Math.max(0, removedBeforeCount - replacedCount),
  });

  return {
    desiredCount: normalizedDefinitions.length,
    createdCount,
    retainedCount,
    replacedCount,
    removedCount: Math.max(0, removedBeforeCount - replacedCount),
  };
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
    for (const instance of dungeonRuntime.listInstancesByLifecycle(lifecycle)) {
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
  const instanceSummary = reconcileUniverseSeededInstances(allDefinitions, {
    systemIDs,
    nowMs,
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
