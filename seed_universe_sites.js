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
const PUBLIC_DATA_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const PUBLIC_UNIVERSE_SITE_ID_SYSTEM_STRIDE = 1_000;
const PUBLIC_UNIVERSE_SITE_ID_BASES = Object.freeze({
  combat: 5_300_000_000_000,
  combat_anomaly: 5_350_000_000_000,
  data: 5_400_000_000_000,
  drifter_observatory: 5_450_000_000_000,
  drifter_unidentified_wormhole: 5_475_000_000_000,
  drifter_space_sentinel_hive: 5_476_000_000_000,
  drifter_space_barbican_hive: 5_477_000_000_000,
  drifter_space_vidette_hive: 5_478_000_000_000,
  drifter_space_conflux_hive: 5_479_000_000_000,
  drifter_space_redoubt_hive: 5_480_000_000_000,
  drifter_space_reckoning_labyrinth: 5_481_000_000_000,
  drifter_space_reckoning_nexus: 5_482_000_000_000,
  drifter_occupied_tabbetzur_field_rescue: 5_483_000_000_000,
  drifter_occupied_tabbetzur_deathless_research_outpost: 5_484_000_000_000,
  drifter_vigilance_point: 5_485_000_000_000,
  drifter_observatory_infiltration: 5_486_000_000_000,
  drifter_deepflow_rift_pochven: 5_487_000_000_000,
  drifter_deepflow_rift_knownspace: 5_488_000_000_000,
  relic: 5_500_000_000_000,
  ghost: 5_600_000_000_000,
  combat_hacking: 5_700_000_000_000,
  ore: 5_800_000_000_000,
  gas: 5_900_000_000_000,
});
const PUBLIC_MINING_ICE_SITE_ITEM_ID_BASE = 5_100_000_000_000;
const PUBLIC_MINING_GAS_SITE_ITEM_ID_BASE = 5_200_000_000_000;
const PUBLIC_MINING_SITE_ID_SYSTEM_STRIDE = 10_000;
const PUBLIC_MINING_SITE_ID_SITE_STRIDE = 100;
const USE_STANDALONE_OFFLINE_WRITER = true;

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
      path.join(current, "server", "src", "newDatabase", "data", "solarSystems", "data.json"),
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

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    return null;
  }
}

const config =
  optionalRequire(path.join(repoRoot, "server/src/config")) ||
  readJsonFile(path.join(repoRoot, "evejs.config.local.json"), readJsonFile(path.join(repoRoot, "evejs.config.example.json"), {}));
const worldData =
  optionalRequire(path.join(repoRoot, "server/src/space/worldData")) ||
  createFileWorldData();
const dungeonAuthority = optionalRequire(path.join(repoRoot, "server/src/services/dungeon/dungeonAuthority"));
const dungeonRuntime = optionalRequire(path.join(repoRoot, "server/src/services/dungeon/dungeonRuntime"));
const dungeonRuntimeState = optionalRequire(path.join(repoRoot, "server/src/services/dungeon/dungeonRuntimeState"));
const dungeonUniverseRuntime = optionalRequire(path.join(repoRoot, "server/src/services/dungeon/dungeonUniverseRuntime"));
const miningResourceSiteService = optionalRequire(path.join(
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
      dungeonRuntime && typeof dungeonRuntime.reconcileUniverseSeededInstancesOffline === "function"
        ? dungeonRuntime.reconcileUniverseSeededInstancesOffline
        : dungeonRuntime && dungeonRuntime.reconcileUniverseSeededInstances
    );
let publicSpawnProfileSpecCache = null;

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
    dungeonAuthority &&
    dungeonRuntimeState &&
    typeof dungeonAuthority.getTemplateByID === "function" &&
    typeof dungeonRuntimeState.loadState === "function" &&
    typeof dungeonRuntimeState.writeState === "function" &&
    typeof dungeonRuntimeState.normalizeInstanceRecord === "function" &&
    typeof dungeonRuntimeState.isActiveLifecycleState === "function"
  );
}

function canUseNativeUniverseRuntime() {
  return (
    dungeonAuthority &&
    dungeonRuntime &&
    dungeonRuntimeState &&
    dungeonUniverseRuntime &&
    typeof dungeonAuthority.listUniverseSpawnFamilies === "function" &&
    typeof dungeonUniverseRuntime.getUniverseReconcileStatus === "function" &&
    dungeonUniverseRuntime._testing &&
    typeof dungeonUniverseRuntime._testing.normalizeSystemIDs === "function" &&
    typeof dungeonUniverseRuntime.listDesiredUniverseDungeonSiteDefinitions === "function" &&
    typeof dungeonUniverseRuntime.listDesiredGeneratedMiningDefinitions === "function" &&
    typeof reconcileUniverseSeededInstances === "function"
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

function dataRootPath(...segments) {
  return path.join(repoRoot, "server", "src", "newDatabase", "data", ...segments);
}

function readJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return cloneValue(fallback);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.copyFileSync(temporaryPath, filePath);
  fs.unlinkSync(temporaryPath);
}

function writeJsonFileIfChanged(filePath, value) {
  const nextText = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === nextText) {
      return false;
    }
  } catch (error) {
    // Fall through to the normal write path.
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, nextText, "utf8");
  fs.copyFileSync(temporaryPath, filePath);
  fs.unlinkSync(temporaryPath);
  return true;
}

function readDataRows(tableName, primaryKey) {
  const raw = readJsonFile(dataRootPath(tableName, "data.json"), {});
  if (Array.isArray(raw)) {
    return raw;
  }
  if (Array.isArray(raw[primaryKey])) {
    return raw[primaryKey];
  }
  if (Array.isArray(raw.rows)) {
    return raw.rows;
  }
  if (Array.isArray(raw.data)) {
    return raw.data;
  }
  return [];
}

function createFileWorldData() {
  let cache = null;
  function ensureLoaded() {
    if (cache) {
      return cache;
    }
    const solarSystems = readDataRows("solarSystems", "solarSystems")
      .filter((system) => toInt(system && system.solarSystemID, 0) > 0)
      .sort((left, right) => toInt(left.solarSystemID, 0) - toInt(right.solarSystemID, 0));
    const stations = readDataRows("stations", "stations");
    const stationTypes = readDataRows("stationTypes", "stationTypes");
    const stargateTypes = readDataRows("stargateTypes", "stargateTypes");
    const celestials = readDataRows("celestials", "celestials");
    const stargates = readDataRows("stargates", "stargates");
    const asteroidBelts = celestials.filter(
      (celestial) => normalizeText(celestial && celestial.kind, "").toLowerCase() === "asteroidbelt",
    );
    const solarSystemsById = new Map();
    const stationsById = new Map();
    const stationTypesById = new Map();
    const stargateTypesById = new Map();
    const stationsBySystem = new Map();
    const celestialsBySystem = new Map();
    const stargatesById = new Map();
    const stargatesBySystem = new Map();

    for (const system of solarSystems) {
      solarSystemsById.set(toInt(system.solarSystemID, 0), system);
    }
    for (const station of stations) {
      const stationID = toInt(station && station.stationID, 0);
      const systemID = toInt(station && station.solarSystemID, 0);
      if (stationID > 0) {
        stationsById.set(stationID, station);
      }
      if (systemID > 0) {
        if (!stationsBySystem.has(systemID)) {
          stationsBySystem.set(systemID, []);
        }
        stationsBySystem.get(systemID).push(station);
      }
    }
    for (const stationType of stationTypes) {
      stationTypesById.set(toInt(stationType && stationType.stationTypeID, stationType && stationType.typeID), stationType);
    }
    for (const stargateType of stargateTypes) {
      stargateTypesById.set(toInt(stargateType && stargateType.typeID, 0), stargateType);
    }
    for (const celestial of celestials) {
      const systemID = toInt(celestial && celestial.solarSystemID, 0);
      if (systemID > 0) {
        if (!celestialsBySystem.has(systemID)) {
          celestialsBySystem.set(systemID, []);
        }
        celestialsBySystem.get(systemID).push(celestial);
      }
    }
    for (const stargate of stargates) {
      const itemID = toInt(stargate && stargate.itemID, stargate && stargate.stargateID);
      const systemID = toInt(stargate && stargate.solarSystemID, 0);
      if (itemID > 0) {
        stargatesById.set(itemID, stargate);
      }
      if (systemID > 0) {
        if (!stargatesBySystem.has(systemID)) {
          stargatesBySystem.set(systemID, []);
        }
        stargatesBySystem.get(systemID).push(stargate);
      }
    }
    cache = {
      solarSystems,
      stations,
      stationTypes,
      stargateTypes,
      celestials,
      asteroidBelts,
      stargates,
      solarSystemsById,
      stationsById,
      stationTypesById,
      stargateTypesById,
      stationsBySystem,
      celestialsBySystem,
      stargatesById,
      stargatesBySystem,
    };
    return cache;
  }
  return {
    ensureLoaded,
    getSolarSystems() {
      return [...ensureLoaded().solarSystems];
    },
    getSolarSystemByID(solarSystemID) {
      return ensureLoaded().solarSystemsById.get(toInt(solarSystemID, 0)) || null;
    },
    getStationsForSystem(solarSystemID) {
      return [...(ensureLoaded().stationsBySystem.get(toInt(solarSystemID, 0)) || [])];
    },
    getCelestialsForSystem(solarSystemID) {
      return [...(ensureLoaded().celestialsBySystem.get(toInt(solarSystemID, 0)) || [])];
    },
    getStargatesForSystem(solarSystemID) {
      return [...(ensureLoaded().stargatesBySystem.get(toInt(solarSystemID, 0)) || [])];
    },
    getStationByID(stationID) {
      return ensureLoaded().stationsById.get(toInt(stationID, 0)) || null;
    },
    getStationTypeByID(typeID) {
      return ensureLoaded().stationTypesById.get(toInt(typeID, 0)) || null;
    },
    getStargateTypeByID(typeID) {
      return ensureLoaded().stargateTypesById.get(toInt(typeID, 0)) || null;
    },
    getStargateByID(stargateID) {
      return ensureLoaded().stargatesById.get(toInt(stargateID, 0)) || null;
    },
    getStaticSceneForSystem(solarSystemID) {
      return [
        ...this.getStationsForSystem(solarSystemID),
        ...this.getCelestialsForSystem(solarSystemID),
        ...this.getStargatesForSystem(solarSystemID),
      ];
    },
  };
}

function stableHashText(value) {
  const text = String(value == null ? "" : value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getSecurityBand(system) {
  const systemID = toInt(system && system.solarSystemID, 0);
  if (systemID >= 31000000 && systemID <= 31999999) {
    return "wormhole";
  }
  const security = Number(system && system.security);
  if (Number.isFinite(security) && security >= 0.45) {
    return "highsec";
  }
  if (Number.isFinite(security) && security > 0) {
    return "lowsec";
  }
  return "nullsec";
}

function loadPublicSpawnProfileSpec() {
  if (publicSpawnProfileSpecCache) {
    return publicSpawnProfileSpecCache;
  }
  const candidates = [
    path.join(toolRoot, "data", "spec", "dungeonSpawnProfiles.json"),
    path.join(__dirname, "data", "spec", "dungeonSpawnProfiles.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      publicSpawnProfileSpecCache = readJsonFile(candidate, { version: 1, families: {} });
      return publicSpawnProfileSpecCache;
    }
  }
  const targetAuthorityPath = dataRootPath("dungeonAuthority", "data.json");
  if (fs.existsSync(targetAuthorityPath)) {
    const authority = readJsonFile(targetAuthorityPath, {});
    if (
      authority &&
      authority.spawnProfiles &&
      authority.spawnProfiles.families &&
      typeof authority.spawnProfiles.families === "object"
    ) {
      publicSpawnProfileSpecCache = authority.spawnProfiles;
      return publicSpawnProfileSpecCache;
    }
  }
  publicSpawnProfileSpecCache = { version: 1, families: {} };
  return publicSpawnProfileSpecCache;
}

function normalizeIntegerArray(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((entry) => toInt(entry, 0))
    .filter((entry) => entry > 0))]
    .sort((left, right) => left - right);
}

function listPublicUniverseFamilies() {
  return Object.entries(loadPublicSpawnProfileSpec().families || {})
    .filter(([, profile]) => profile && profile.enabled !== false)
    .map(([family]) => family);
}

function buildPublicSystemsByBand() {
  const systems = worldData.getSolarSystems()
    .filter((system) => toInt(system && system.solarSystemID, 0) > 0)
    .sort((left, right) => toInt(left.solarSystemID, 0) - toInt(right.solarSystemID, 0));
  const byBand = {
    highsec: [],
    lowsec: [],
    nullsec: [],
    wormhole: [],
  };
  for (const system of systems) {
    byBand[getSecurityBand(system)].push(system);
  }
  return { systems, byBand };
}

function selectPublicSystemsForBand(family, band, bandProfile, availableSystems) {
  const spec = loadPublicSpawnProfileSpec();
  const profile = spec.families && spec.families[family] || {};
  const scopedSystemIDs = new Set(normalizeIntegerArray([
    ...(Array.isArray(profile.systemIDs) ? profile.systemIDs : []),
    ...(Array.isArray(bandProfile && bandProfile.systemIDs) ? bandProfile.systemIDs : []),
  ]));
  const regionIDs = new Set(normalizeIntegerArray([
    ...(Array.isArray(profile.regionIDs) ? profile.regionIDs : []),
    ...(Array.isArray(bandProfile && bandProfile.regionIDs) ? bandProfile.regionIDs : []),
  ]));
  const constellationIDs = new Set(normalizeIntegerArray([
    ...(Array.isArray(profile.constellationIDs) ? profile.constellationIDs : []),
    ...(Array.isArray(bandProfile && bandProfile.constellationIDs) ? bandProfile.constellationIDs : []),
  ]));
  const wormholeClassIDs = new Set(normalizeIntegerArray([
    ...(Array.isArray(profile.wormholeClassIDs) ? profile.wormholeClassIDs : []),
    ...(Array.isArray(bandProfile && bandProfile.wormholeClassIDs) ? bandProfile.wormholeClassIDs : []),
  ]));
  const excludeSystemIDs = new Set(normalizeIntegerArray([
    ...(Array.isArray(profile.excludeSystemIDs) ? profile.excludeSystemIDs : []),
    ...(Array.isArray(bandProfile && bandProfile.excludeSystemIDs) ? bandProfile.excludeSystemIDs : []),
  ]));
  const excludeRegionIDs = new Set(normalizeIntegerArray([
    ...(Array.isArray(profile.excludeRegionIDs) ? profile.excludeRegionIDs : []),
    ...(Array.isArray(bandProfile && bandProfile.excludeRegionIDs) ? bandProfile.excludeRegionIDs : []),
  ]));
  const excludeConstellationIDs = new Set(normalizeIntegerArray([
    ...(Array.isArray(profile.excludeConstellationIDs) ? profile.excludeConstellationIDs : []),
    ...(Array.isArray(bandProfile && bandProfile.excludeConstellationIDs) ? bandProfile.excludeConstellationIDs : []),
  ]));
  const excludeWormholeClassIDs = new Set(normalizeIntegerArray([
    ...(Array.isArray(profile.excludeWormholeClassIDs) ? profile.excludeWormholeClassIDs : []),
    ...(Array.isArray(bandProfile && bandProfile.excludeWormholeClassIDs) ? bandProfile.excludeWormholeClassIDs : []),
  ]));
  const hasScopedSelectors =
    scopedSystemIDs.size > 0 ||
    regionIDs.size > 0 ||
    constellationIDs.size > 0 ||
    wormholeClassIDs.size > 0;
  const systems = (Array.isArray(availableSystems) ? availableSystems : [])
    .filter((system) => {
      const systemID = toInt(system && system.solarSystemID, 0);
      const regionID = toInt(system && system.regionID, 0);
      const constellationID = toInt(system && system.constellationID, 0);
      const wormholeClassID = toInt(system && system.wormholeClassID, 0);
      if (
        excludeSystemIDs.has(systemID) ||
        excludeRegionIDs.has(regionID) ||
        excludeConstellationIDs.has(constellationID) ||
        excludeWormholeClassIDs.has(wormholeClassID)
      ) {
        return false;
      }
      if (!hasScopedSelectors) {
        return true;
      }
      return (
        scopedSystemIDs.has(systemID) ||
        regionIDs.has(regionID) ||
        constellationIDs.has(constellationID) ||
        wormholeClassIDs.has(wormholeClassID)
      );
    });
  if (systems.length <= 0) {
    return [];
  }
  const explicitTarget = toInt(bandProfile && bandProfile.targetSystems, 0);
  const targetRatio = Number(bandProfile && bandProfile.targetSystemRatio);
  const ratioTarget = Number.isFinite(targetRatio) && targetRatio > 0
    ? Math.max(1, Math.round(systems.length * Math.max(0, Math.min(1, targetRatio))))
    : 0;
  const targetCount = Math.min(
    systems.length,
    explicitTarget > 0 ? explicitTarget : (ratioTarget > 0 ? ratioTarget : systems.length),
  );
  const stride = Math.max(1, toInt(bandProfile && bandProfile.systemStride, 1));
  const selected = [];
  const seen = new Set();
  const rankedSystems = systems
    .map((system) => ({
      system,
      systemID: toInt(system && system.solarSystemID, 0),
      score: stableHashText(`${toInt(system && system.solarSystemID, 0) * 8191}:${family}:${band}`),
    }))
    .sort((left, right) => (left.score - right.score) || (left.systemID - right.systemID));
  for (const entry of rankedSystems) {
    if (selected.length >= targetCount) {
      break;
    }
    if (entry.systemID <= 0 || seen.has(entry.systemID)) {
      continue;
    }
    if (explicitTarget <= 0 && ratioTarget <= 0 && stride > 1) {
      const offset = Math.max(0, toInt(bandProfile && bandProfile.systemOffset, 0)) % stride;
      if ((stableHashText(`${entry.systemID}:${family}`) % stride) !== offset) {
        continue;
      }
    }
    seen.add(entry.systemID);
    selected.push(entry.system);
  }
  for (const system of systems) {
    if (selected.length >= targetCount) {
      break;
    }
    const systemID = toInt(system && system.solarSystemID, 0);
    if (systemID > 0 && !seen.has(systemID)) {
      seen.add(systemID);
      selected.push(system);
    }
  }
  return selected.sort((left, right) => toInt(left.solarSystemID, 0) - toInt(right.solarSystemID, 0));
}

function buildPublicPosition(systemID, slotIndex, family) {
  const seed = stableHashText(`${systemID}:${slotIndex}:${family}`);
  return {
    x: ((seed & 0xffff) - 32768) * 1000,
    y: (((seed >>> 8) & 0xffff) - 32768) * 1000,
    z: (((seed >>> 16) & 0xffff) - 32768) * 1000,
  };
}

function getPublicUniverseSiteProviderID(siteKind) {
  return normalizeText(siteKind, "signature").toLowerCase() === "anomaly"
    ? "sceneAnomalySite"
    : "sceneSignatureSite";
}

function buildPublicUniverseSiteID(family, systemID, slotIndex) {
  const base = PUBLIC_UNIVERSE_SITE_ID_BASES[normalizeText(family, "").toLowerCase()];
  if (!base) {
    return 0;
  }
  return base +
    (toInt(systemID, 0) * PUBLIC_UNIVERSE_SITE_ID_SYSTEM_STRIDE) +
    (Math.max(0, toInt(slotIndex, 0)) + 1);
}

function buildPublicMiningSiteID(family, systemID, siteIndex = 0) {
  const base = normalizeText(family, "").toLowerCase() === "gas"
    ? PUBLIC_MINING_GAS_SITE_ITEM_ID_BASE
    : PUBLIC_MINING_ICE_SITE_ITEM_ID_BASE;
  return base +
    (toInt(systemID, 0) * PUBLIC_MINING_SITE_ID_SYSTEM_STRIDE) +
    (Math.max(0, toInt(siteIndex, 0)) * PUBLIC_MINING_SITE_ID_SITE_STRIDE);
}

function buildPublicMiningChildEntityID(family, systemID, siteIndex, memberIndex) {
  return buildPublicMiningSiteID(family, systemID, siteIndex) +
    Math.max(0, toInt(memberIndex, 0)) +
    1;
}

function buildPublicDefinitionHash(definition) {
  return stableHashText(JSON.stringify({
    solarSystemID: definition.solarSystemID,
    siteKey: definition.siteKey,
    siteID: definition.siteID,
    templateID: definition.templateID,
    siteFamily: definition.siteFamily,
    siteKind: definition.siteKind,
    siteOrigin: definition.siteOrigin,
    slotIndex: definition.metadata && definition.metadata.slotIndex,
    securityBand: definition.metadata && definition.metadata.securityBand,
  })).toString(16).padStart(8, "0");
}

function buildPublicSiteDefinition(family, profile, system, band, slotIndex, nowMs) {
  const systemID = toInt(system && system.solarSystemID, 0);
  const kindFilters =
    profile &&
    profile.templateFilters &&
    Array.isArray(profile.templateFilters.siteKinds)
      ? profile.templateFilters.siteKinds
      : [];
  const siteKind = normalizeText(kindFilters[0], family.includes("anomaly") ? "anomaly" : "signature").toLowerCase();
  const siteOrigin = normalizeText(profile && profile.siteOrigin, "universe_dungeon").toLowerCase();
  const providerID = getPublicUniverseSiteProviderID(siteKind);
  const siteID = buildPublicUniverseSiteID(family, systemID, slotIndex);
  const templateID = `public:${family}:${siteKind}:v1`;
  const siteKey = siteID > 0
    ? `${providerID}:${systemID}:${siteID}`
    : `public:${siteOrigin}:${family}:${systemID}:${slotIndex}`;
  const definition = {
    templateID,
    solarSystemID: systemID,
    siteID,
    siteKey,
    siteFamily: family,
    siteKind,
    siteOrigin,
    lifecycleState: "seeded",
    instanceScope: "shared",
    position: buildPublicPosition(systemID, slotIndex, family),
    runtimeFlags: {
      universeSeeded: true,
      universePersistent: true,
      publicEveJsSeeder: true,
    },
    spawnState: {
      siteID,
      providerID,
      spawnFamilyKey: family,
      securityBand: band,
      slotIndex,
      systemName: normalizeText(system && system.solarSystemName, ""),
    },
    metadata: {
      siteID,
      providerID,
      spawnFamilyKey: family,
      securityBand: band,
      slotIndex,
      label: `${family} ${siteKind}`,
      generatedBy: "elysian-universe-site-seeder",
      publicEveJs: true,
      seededAtMs: nowMs,
    },
  };
  definition.metadata.definitionHash = buildPublicDefinitionHash(definition);
  return definition;
}

function buildPublicBroadDefinitions(nowMs) {
  const spec = loadPublicSpawnProfileSpec();
  const { byBand } = buildPublicSystemsByBand();
  const definitions = [];
  const familySummaries = {};
  for (const [family, profile] of Object.entries(spec.families || {})) {
    if (!profile || profile.enabled === false) {
      continue;
    }
    const beforeCount = definitions.length;
    const touchedSystems = new Set();
    for (const [band, bandProfile] of Object.entries(profile.bands || {})) {
      const slotsPerSystem = Math.max(0, toInt(bandProfile && bandProfile.slotsPerSystem, 0));
      if (slotsPerSystem <= 0) {
        continue;
      }
      const selectedSystems = selectPublicSystemsForBand(
        family,
        band,
        bandProfile,
        byBand[band] || [],
      );
      for (const system of selectedSystems) {
        const systemID = toInt(system && system.solarSystemID, 0);
        touchedSystems.add(systemID);
        for (let slotIndex = 0; slotIndex < slotsPerSystem; slotIndex += 1) {
          definitions.push(buildPublicSiteDefinition(
            family,
            profile,
            system,
            band,
            slotIndex,
            nowMs,
          ));
        }
      }
    }
    familySummaries[family] = {
      desiredSiteCount: definitions.length - beforeCount,
      systemsTouched: touchedSystems.size,
      templateCount: 1,
    };
  }
  return { definitions, families: familySummaries };
}

function buildGeneratedMiningMember(systemID, siteIndex, memberIndex, family, nowMs) {
  const entityID = buildPublicMiningChildEntityID(family, systemID, siteIndex, memberIndex);
  const typeIDs = family === "gas"
    ? [30370, 30371, 30372, 30373]
    : [1230, 1228, 1224, 18, 1226, 20];
  const typeID = typeIDs[(systemID + memberIndex) % typeIDs.length];
  const originalQuantity = 4000 + ((stableHashText(`${systemID}:${memberIndex}`) % 9000) * 10);
  return {
    entityID,
    visualTypeID: typeID,
    beltID: 0,
    fieldStyleID: null,
    siteID: buildPublicMiningSiteID(family, systemID, siteIndex),
    siteIndex,
    family,
    yieldTypeID: typeID,
    yieldKind: family,
    unitVolume: family === "gas" ? 10 : 0.1,
    originalQuantity,
    remainingQuantity: originalQuantity,
    originalRadius: 65 + (memberIndex * 7),
    updatedAtMs: nowMs,
  };
}

function buildPublicGeneratedMiningDefinitions(nowMs) {
  const systems = worldData.getSolarSystems()
    .filter((system) => {
      const systemID = toInt(system && system.solarSystemID, 0);
      if (systemID <= 0) {
        return false;
      }
      try {
        return worldData.getCelestialsForSystem(systemID)
          .some((celestial) => normalizeText(celestial && celestial.kind, "").toLowerCase() === "asteroidbelt");
      } catch (error) {
        return false;
      }
    })
    .sort((left, right) => toInt(left.solarSystemID, 0) - toInt(right.solarSystemID, 0));
  const targetCount = Math.min(138, systems.length);
  const definitions = [];
  const stride = Math.max(1, Math.floor(systems.length / Math.max(1, targetCount)));
  const seen = new Set();
  for (let index = 0; definitions.length < targetCount && index < systems.length * 2; index += 1) {
    const system = systems[(index * stride) % systems.length];
    const systemID = toInt(system && system.solarSystemID, 0);
    if (seen.has(systemID)) {
      continue;
    }
    seen.add(systemID);
    const band = getSecurityBand(system);
    const family = band === "wormhole" ? "gas" : "ice";
    const siteIndex = 0;
    const siteID = buildPublicMiningSiteID(family, systemID, siteIndex);
    const members = [];
    for (let memberIndex = 0; memberIndex < 12; memberIndex += 1) {
      members.push(buildGeneratedMiningMember(systemID, siteIndex, memberIndex, family, nowMs));
    }
    const templateID = `public:generated-mining:${family}:v1`;
    const siteKey = `generatedMining:${systemID}:${siteID}`;
    const definition = {
      templateID,
      solarSystemID: systemID,
      siteID,
      siteKey,
      siteFamily: family,
      siteKind: "anomaly",
      siteOrigin: "generatedmining",
      lifecycleState: "seeded",
      instanceScope: "shared",
      position: buildPublicPosition(systemID, 0, `generatedmining:${family}`),
      runtimeFlags: {
        universeSeeded: true,
        universePersistent: true,
        publicEveJsSeeder: true,
        generatedMining: true,
      },
      spawnState: {
        siteID,
        providerID: "generatedMining",
        spawnFamilyKey: family,
        securityBand: band,
        slotIndex: siteIndex,
        siteIndex,
        members,
        memberCount: members.length,
        activeMemberCount: members.length,
        totalOriginalQuantity: members.reduce((sum, member) => sum + member.originalQuantity, 0),
        totalRemainingQuantity: members.reduce((sum, member) => sum + member.remainingQuantity, 0),
      },
      metadata: {
        siteID,
        providerID: "generatedMining",
        spawnFamilyKey: family,
        securityBand: band,
        slotIndex: siteIndex,
        siteIndex,
        label: `${family === "gas" ? "Gas" : "Ice"} Field ${siteIndex + 1}`,
        generatedBy: "elysian-universe-site-seeder",
        publicEveJs: true,
        seededAtMs: nowMs,
      },
    };
    definition.metadata.definitionHash = buildPublicDefinitionHash(definition);
    definitions.push(definition);
  }
  return definitions;
}

function buildPublicTemplates(definitions) {
  const templatesByID = {};
  for (const definition of definitions) {
    if (!definition || !definition.templateID || templatesByID[definition.templateID]) {
      continue;
    }
    templatesByID[definition.templateID] = {
      templateID: definition.templateID,
      templateName: `${definition.siteFamily} ${definition.siteKind}`,
      siteFamily: definition.siteFamily,
      siteKind: definition.siteKind,
      siteOrigin: definition.siteOrigin,
      source: "elysian-universe-site-seeder",
      generatedForPublicEveJs: true,
      connections: [],
      environmentTemplates: null,
      clientObjectives: null,
      objectiveMetadata: null,
    };
  }
  return templatesByID;
}

function buildPublicInstanceRecord(instanceID, definition, nowMs) {
  return {
    instanceID,
    templateID: definition.templateID,
    solarSystemID: definition.solarSystemID,
    siteKey: definition.siteKey,
    lifecycleState: "seeded",
    lifecycleReason: null,
    instanceScope: "shared",
    siteFamily: definition.siteFamily,
    siteKind: definition.siteKind,
    siteOrigin: definition.siteOrigin,
    source: "elysian-universe-site-seeder",
    sourceDungeonID: null,
    archetypeID: null,
    factionID: null,
    difficulty: null,
    entryObjectTypeID: null,
    dungeonNameID: null,
    position: cloneValue(definition.position),
    ownership: normalizeOwnership(definition.ownership || definition),
    timers: {
      createdAtMs: nowMs,
      activatedAtMs: nowMs,
      expiresAtMs: 0,
      despawnAtMs: 0,
      lastUpdatedAtMs: nowMs,
    },
    roomStatesByKey: {
      "room:entry": {
        roomKey: "room:entry",
        state: "active",
        stage: "entry",
        pocketID: null,
        nodeGraphID: null,
        activatedAtMs: nowMs,
        completedAtMs: 0,
        lastUpdatedAtMs: nowMs,
        spawnedEntityIDs: [],
        counters: {},
        metadata: { seededFromTemplate: true },
      },
    },
    gateStatesByKey: {},
    objectiveState: {
      state: "pending",
      currentNodeID: null,
      currentObjectiveID: null,
      currentObjectiveKey: null,
      currentObjectiveTypeID: null,
      completedObjectiveIDs: [],
      completedNodeIDs: [],
      counters: {},
      metadata: { seededFromTemplate: true },
    },
    hazardState: {},
    environmentState: {
      seededAtMs: nowMs,
      templates: null,
    },
    spawnState: cloneValue(definition.spawnState || {}),
    runtimeFlags: cloneValue(definition.runtimeFlags || {}),
    metadata: cloneValue(definition.metadata || {}),
  };
}

function readPublicRuntimeState() {
  return readJsonFile(dataRootPath("dungeonRuntimeState", "data.json"), {
    version: 1,
    nextInstanceSequence: 1,
    instancesByID: {},
    universeReconcileMeta: {},
  });
}

function buildPublicRuntimeCounts(state = null) {
  const runtimeState = state || readPublicRuntimeState();
  let broadCount = 0;
  let generatedMiningCount = 0;
  const byFamily = {};
  for (const family of listPublicUniverseFamilies()) {
    byFamily[family] = 0;
  }
  for (const instance of Object.values(runtimeState.instancesByID || {})) {
    if (!instance || !(instance.runtimeFlags && instance.runtimeFlags.universeSeeded === true)) {
      continue;
    }
    if (normalizeText(instance.siteOrigin, "").toLowerCase() === "generatedmining") {
      generatedMiningCount += 1;
      continue;
    }
    const family = normalizeText(
      instance.metadata && instance.metadata.spawnFamilyKey,
      instance.siteFamily,
    ).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(byFamily, family)) {
      byFamily[family] = 0;
    }
    byFamily[family] += 1;
    broadCount += 1;
  }
  return { broadCount, generatedMiningCount, byFamily };
}

function buildPublicDescriptor(nowMs) {
  const spec = loadPublicSpawnProfileSpec();
  const systems = worldData.getSolarSystems();
  const source = {
    version: 2,
    specVersion: toInt(spec.version, 1),
    familyNames: Object.keys(spec.families || {}).sort(),
    systemCount: systems.length,
    firstSystemID: systems.length ? toInt(systems[0].solarSystemID, 0) : 0,
    lastSystemID: systems.length ? toInt(systems[systems.length - 1].solarSystemID, 0) : 0,
  };
  return {
    descriptorKey: `public-offline:${stableHashText(JSON.stringify(source)).toString(16)}`,
    broadDescriptorKey: `public-broad:${stableHashText(JSON.stringify(source.familyNames)).toString(16)}`,
    miningDescriptorKey: `public-mining:${stableHashText(String(source.systemCount)).toString(16)}`,
    generatedAtMs: nowMs,
  };
}

function getPublicUniverseReconcileStatus(nowMs) {
  const descriptor = buildPublicDescriptor(nowMs);
  const state = readPublicRuntimeState();
  const meta = state.universeReconcileMeta || {};
  const fullUpToDate =
    normalizeText(meta.descriptorKey, "") === descriptor.descriptorKey &&
    normalizeText(meta.broadDescriptorKey, "") === descriptor.broadDescriptorKey &&
    normalizeText(meta.miningDescriptorKey, "") === descriptor.miningDescriptorKey;
  return {
    fullUpToDate,
    descriptor,
    meta,
  };
}

function applyPublicInstances(definitions, nowMs, onProgress = null) {
  const normalizedDefinitions = Array.isArray(definitions) ? definitions : [];
  const state = readPublicRuntimeState();
  const instancesByID = state.instancesByID || {};
  const existingBySiteKey = new Map();
  const desiredBySiteKey = new Map();
  for (const definition of normalizedDefinitions) {
    desiredBySiteKey.set(definition.siteKey, definition);
  }
  for (const [instanceID, instance] of Object.entries(instancesByID)) {
    if (!instance || !(instance.runtimeFlags && instance.runtimeFlags.universeSeeded === true)) {
      continue;
    }
    existingBySiteKey.set(instance.siteKey, {
      ...instance,
      instanceID: toInt(instance.instanceID, toInt(instanceID, 0)),
    });
  }

  let createdCount = 0;
  let retainedCount = 0;
  let replacedCount = 0;
  let removedCount = 0;
  let nextInstanceSequence = Math.max(1, toInt(state.nextInstanceSequence, 1));
  const total = Math.max(1, existingBySiteKey.size + normalizedDefinitions.length);
  let current = 0;
  let lastPercent = -1;
  function emit(label, extras = {}) {
    if (typeof onProgress !== "function") {
      return;
    }
    const percent = Math.floor((Math.min(total, current) / total) * 100);
    if (percent === lastPercent && current < total) {
      return;
    }
    lastPercent = percent;
    onProgress({
      current: Math.min(total, current),
      total,
      label,
      ...extras,
    });
  }

  for (const [siteKey, instance] of existingBySiteKey.entries()) {
    if (!desiredBySiteKey.has(siteKey)) {
      delete instancesByID[String(instance.instanceID)];
      removedCount += 1;
    }
    current += 1;
    emit("Removing stale public EVE JS universe sites", { removedCount });
  }

  for (const definition of normalizedDefinitions) {
    const existing = existingBySiteKey.get(definition.siteKey) || null;
    const desiredHash = normalizeText(definition.metadata && definition.metadata.definitionHash, "");
    const existingHash = normalizeText(existing && existing.metadata && existing.metadata.definitionHash, "");
    if (existing && existingHash && existingHash === desiredHash) {
      retainedCount += 1;
      current += 1;
      emit("Retaining current public EVE JS universe sites", { retainedCount });
      continue;
    }
    if (existing) {
      delete instancesByID[String(existing.instanceID)];
      replacedCount += 1;
    }
    const instanceID = nextInstanceSequence;
    nextInstanceSequence += 1;
    instancesByID[String(instanceID)] = buildPublicInstanceRecord(instanceID, definition, nowMs);
    createdCount += 1;
    current += 1;
    emit("Writing public EVE JS universe sites", { createdCount, retainedCount, replacedCount });
  }

  const changed = createdCount > 0 || replacedCount > 0 || removedCount > 0;
  state.version = Math.max(1, toInt(state.version, 1));
  state.nextInstanceSequence = nextInstanceSequence;
  state.instancesByID = instancesByID;
  emit("Public EVE JS universe site write complete", {
    createdCount,
    retainedCount,
    replacedCount,
    removedCount,
  });
  return { state, changed, createdCount, retainedCount, replacedCount, removedCount };
}

function applyPublicMiningRows(miningDefinitions, nowMs, onProgress = null) {
  const state = readJsonFile(dataRootPath("miningRuntimeState", "data.json"), { systems: {} });
  const systems = {};
  let createdRows = 0;
  let retainedRows = 0;
  let current = 0;
  const total = Math.max(1, miningDefinitions.length);
  for (const definition of miningDefinitions) {
    const systemID = toInt(definition && definition.solarSystemID, 0);
    if (systemID <= 0) {
      continue;
    }
    const entities = {};
    for (const member of Array.isArray(definition.spawnState && definition.spawnState.members)
      ? definition.spawnState.members
      : []) {
      const entityID = toInt(member && member.entityID, 0);
      if (entityID <= 0) {
        continue;
      }
      const previous = state.systems &&
        state.systems[String(systemID)] &&
        state.systems[String(systemID)].entities &&
        state.systems[String(systemID)].entities[String(entityID)];
      if (previous) {
        retainedRows += 1;
      } else {
        createdRows += 1;
      }
      entities[String(entityID)] = {
        ...cloneValue(member),
        updatedAtMs: nowMs,
      };
    }
    systems[String(systemID)] = {
      entities,
    };
    current += 1;
    if (typeof onProgress === "function") {
      onProgress({
        current,
        total,
        label: "Writing public EVE JS generated mining rows",
        createdRows,
        retainedRows,
      });
    }
  }
  writeJsonFileIfChanged(dataRootPath("miningRuntimeState", "data.json"), { systems });
  return {
    createdRows,
    retainedRows,
    updatedRows: 0,
    removedRows: 0,
    deniedRows: 0,
  };
}

function writePublicAuthority(definitions) {
  const authorityPath = dataRootPath("dungeonAuthority", "data.json");
  if (fs.existsSync(authorityPath)) {
    return null;
  }

  const templatesByID = buildPublicTemplates(definitions);
  writeJsonFileIfChanged(authorityPath, {
    version: 1,
    generatedBy: "elysian-universe-site-seeder",
    generatedFor: "public-evejs",
    generatedAtMs: PUBLIC_DATA_EPOCH_MS,
    templateCount: Object.keys(templatesByID).length,
    templatesByID,
    spawnProfiles: loadPublicSpawnProfileSpec(),
  });
  return templatesByID;
}

function summarizeRuntimeFamilies() {
  if (!canUseNativeUniverseRuntime()) {
    return buildPublicRuntimeCounts();
  }
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
  if (USE_STANDALONE_OFFLINE_WRITER || !canUseNativeUniverseRuntime()) {
    const status = getPublicUniverseReconcileStatus(nowMs);
    const runtimeCounts = buildPublicRuntimeCounts();
    const systems = worldData.getSolarSystems();
    const families = listPublicUniverseFamilies();
    return {
      mode: options.mode,
      writer: "standalone_offline_writer",
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

async function runStandaloneSeed(nowMs) {
  const status = getPublicUniverseReconcileStatus(nowMs);
  const descriptor = status.descriptor;
  if (status.fullUpToDate === true && options.force !== true) {
    const runtimeCounts = buildPublicRuntimeCounts();
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

  const systems = worldData.getSolarSystems();
  const systemIDs = systems
    .map((system) => toInt(system && system.solarSystemID, 0))
    .filter((entry) => entry > 0)
    .sort((left, right) => left - right);
  const families = listPublicUniverseFamilies();
  const startedAtMs = Date.now();
  const deterministicSeedMs = PUBLIC_DATA_EPOCH_MS;

  if (options.forceReseedUniverse === true) {
    printLine("Force reseed requested. Rebuilding the full persistent universe even though the current descriptor may already match.");
  }
  printLine(`Seeding the universe across ${systemIDs.length} systems.`);
  printLine("Using the bundled standalone offline writer for public EVE JS data.");
  emitEvent("status", {
    mode: "seed",
    writer: "standalone_offline_writer",
    repoRoot,
    systemCount: systemIDs.length,
    familyCount: families.length,
    batchSize: options.batchSize,
    forceReseedUniverse: options.forceReseedUniverse === true,
  });

  emitEvent("phase", buildProgressPayload("build_mining", 0, systemIDs.length, {
    label: "Building generated mining definitions",
  }));
  printLine("Phase 1/4: building generated mining definitions...");
  const miningDefinitions = buildPublicGeneratedMiningDefinitions(deterministicSeedMs);
  emitEvent("phase", buildProgressPayload("build_mining", systemIDs.length, systemIDs.length, {
    label: "Building generated mining definitions",
    sitesBuilt: miningDefinitions.length,
  }));
  printLine(`Generated mining definitions built: ${miningDefinitions.length}`);

  printLine("Phase 2/4: building persistent broad-family site definitions...");
  emitEvent("phase", buildProgressPayload("build_broad", 0, Math.max(1, families.length), {
    label: "Building persistent universe site definitions",
    sitesBuilt: 0,
  }));
  const broadResult = buildPublicBroadDefinitions(deterministicSeedMs);
  let familyIndex = 0;
  for (const [family, familySummary] of Object.entries(broadResult.families || {})) {
    familyIndex += 1;
    emitEvent("phase", buildProgressPayload(
      "build_broad",
      familyIndex,
      Math.max(1, families.length),
      {
        label: `Building ${family} family definitions`,
        family,
        familySiteCount: toInt(familySummary && familySummary.desiredSiteCount, 0),
        sitesBuilt: broadResult.definitions.length,
      },
    ));
    printLine(`  ${family}: ${toInt(familySummary && familySummary.desiredSiteCount, 0)} desired sites`);
  }

  const allDefinitions = [...miningDefinitions, ...broadResult.definitions];
  writePublicAuthority(allDefinitions);
  printLine(`Broad persistent definitions built: ${broadResult.definitions.length}`);
  printLine(`Total desired universe sites: ${allDefinitions.length}`);

  printLine("Phase 3/4: applying dungeon runtime instances...");
  let applyInstanceProgressTotal = Math.max(1, allDefinitions.length);
  emitEvent("phase", buildProgressPayload("apply_instances", 0, applyInstanceProgressTotal, {
    label: "Applying dungeon runtime instances",
    desiredSiteCount: allDefinitions.length,
  }));
  const instanceSummary = applyPublicInstances(
    allDefinitions,
    deterministicSeedMs,
    (progress) => {
      applyInstanceProgressTotal = Math.max(
        applyInstanceProgressTotal,
        toInt(progress && progress.total, applyInstanceProgressTotal),
      );
      emitPhaseProgress("apply_instances", progress, {
        label: "Applying dungeon runtime instances",
        desiredSiteCount: allDefinitions.length,
      });
    },
  );
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
  const miningRuntimeProgressTotal = Math.max(1, miningDefinitions.length);
  emitEvent("phase", buildProgressPayload("apply_mining_rows", 0, miningRuntimeProgressTotal, {
    label: "Applying generated mining runtime rows",
    desiredSiteCount: miningDefinitions.length,
  }));
  const miningRuntimeSummary = applyPublicMiningRows(
    miningDefinitions,
    deterministicSeedMs,
    (progress) => {
      emitPhaseProgress("apply_mining_rows", progress, {
        label: "Applying generated mining runtime rows",
        desiredSiteCount: miningDefinitions.length,
      });
    },
  );
  emitEvent("phase", buildProgressPayload("apply_mining_rows", miningRuntimeProgressTotal, miningRuntimeProgressTotal, {
    label: "Applying generated mining runtime rows",
    desiredSiteCount: miningDefinitions.length,
    summary: miningRuntimeSummary,
  }));
  printLine(
    `Mining runtime rows -> created ${miningRuntimeSummary.createdRows}, retained ${miningRuntimeSummary.retainedRows || 0}, removed ${miningRuntimeSummary.removedRows}`,
  );

  const summary = {
    forceReseedUniverse: options.forceReseedUniverse === true,
    writer: "standalone_offline_writer",
    benchmarkTarget: "public-evejs",
    systemCount: systemIDs.length,
    desiredSiteCount: allDefinitions.length,
    createdInstances: instanceSummary.createdCount,
    retainedInstances: instanceSummary.retainedCount,
    replacedInstances: instanceSummary.replacedCount,
    removedInstances: instanceSummary.removedCount,
    miningStateRowsCreated: miningRuntimeSummary.createdRows,
    miningStateRowsRetained: miningRuntimeSummary.retainedRows || 0,
    miningStateRowsRemoved: miningRuntimeSummary.removedRows,
    mining: {
      desiredSiteCount: miningDefinitions.length,
    },
    families: broadResult.families,
    elapsedMs: Date.now() - startedAtMs,
  };

  const nextState = instanceSummary.state || readPublicRuntimeState();
  nextState.universeReconcileMeta = {
    version: 1,
    descriptorKey: descriptor.descriptorKey,
    broadDescriptorKey: descriptor.broadDescriptorKey,
    miningDescriptorKey: descriptor.miningDescriptorKey,
    lastStartedAtMs: startedAtMs,
    lastCompletedAtMs: Date.now(),
    lastScope: "full",
    lastReason: "manual-seeder",
    summary,
  };
  writeJsonFileIfChanged(dataRootPath("dungeonRuntimeState", "data.json"), nextState);

  printLine(
    `Universe seed complete in ${summary.elapsedMs}ms across ${summary.systemCount} systems.`,
    "success",
  );
  emitEvent("summary", { summary });
  emitEvent("complete", { summary });
  return summary;
}

async function runSeed(nowMs) {
  if (USE_STANDALONE_OFFLINE_WRITER || !canUseNativeUniverseRuntime()) {
    return runStandaloneSeed(nowMs);
  }
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
