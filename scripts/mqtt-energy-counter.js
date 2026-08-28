/**
 * MQTT Shelly Pro 3EM - Net Metering & Home Assistant Auto-Discovery
 * Version: 5.2.2
 *
 * based on Version: 1.2.0 from https://gist.github.com/mlossin/79e1b29eba6a48466b9078be254a384f
 */

let CONFIG = {
    updateInterval: 1000,         // Calculation / MQTT power cycle in ms (1 second)
    enablePersistence: true,     // true = Save counter states to flash memory
    saveInterval: 900,          // Save to KVS every 900 cycles (~15 min. at 1 s)
    mqttPrefix: "homeassistant", // Standard HA Discovery Prefix

    publishPower: true,          // true = publish live balanced power (W) every cycle
    invertPower: false,          // true = ALL CT clamps mounted reversed -> flip sign
    deviceName: ""               // "" = use device name from Shelly settings
                                 //      (Web-UI -> Settings -> Device Name),
                                 //      or set a fixed name here, e.g.
                                 //      "Shelly Keller" (keep it short, <25 chars)
};

let VERSION = "5.2.2";
let SHELLY_ID = null;
let SHELLY_MAC = null;
let DEVICE_NAME = null;

let energyReturnedWs = 0.0;
let energyConsumedWs = 0.0;
let energyReturnedKWh = 0.0;
let energyConsumedKWh = 0.0;

let saveCounter = 0;
let saveInProgress = false;
let lastPublishedConsumed = "";
let lastPublishedReturned = "";
let countersLoaded = false;
let lastTick = null;

// ─────────────────────────────────────────────
// 1. Helper Functions
// ─────────────────────────────────────────────

function TryAnnounceAndPublish() {
    if (!SHELLY_ID || !DEVICE_NAME || !MQTT.isConnected()) return;
    AnnounceHA();
    if (countersLoaded) PublishCounters(true);
}

function PublishCounters(force) {
    if (!SHELLY_ID || !countersLoaded) return;

    let valC = energyConsumedKWh.toFixed(3);
    let valR = energyReturnedKWh.toFixed(3);

    if (!force && valC === lastPublishedConsumed && valR === lastPublishedReturned) return;

    let okC = MQTT.publish(SHELLY_ID + "/energy_counter/consumed", valC, 0, true);
    let okR = MQTT.publish(SHELLY_ID + "/energy_counter/returned", valR, 0, true);

    if (okC) lastPublishedConsumed = valC;
    if (okR) lastPublishedReturned = valR;
}

function NormalizeMacAddress(address) {
    return String(address).split("-").join("").split(":").join("").toLowerCase();
}

function IsPositiveInteger(value) {
    return typeof value === "number" && isFinite(value) &&
        value > 0 && Math.floor(value) === value;
}

function ValidateConfig() {
    if (!IsPositiveInteger(CONFIG.updateInterval)) {
        print("ERROR: CONFIG.updateInterval must be a positive integer in milliseconds.");
        return false;
    }
    if (!IsPositiveInteger(CONFIG.saveInterval)) {
        print("ERROR: CONFIG.saveInterval must be a positive integer.");
        return false;
    }
    if (typeof CONFIG.mqttPrefix !== "string" || CONFIG.mqttPrefix === "" ||
        CONFIG.mqttPrefix.indexOf("+") !== -1 || CONFIG.mqttPrefix.indexOf("#") !== -1) {
        print("ERROR: CONFIG.mqttPrefix must be a non-empty MQTT topic prefix without wildcards.");
        return false;
    }
    if (typeof CONFIG.enablePersistence !== "boolean" ||
        typeof CONFIG.publishPower !== "boolean" ||
        typeof CONFIG.invertPower !== "boolean" ||
        typeof CONFIG.deviceName !== "string") {
        print("ERROR: Boolean CONFIG values and CONFIG.deviceName must have the documented types.");
        return false;
    }
    return true;
}

// ─────────────────────────────────────────────
// 2. MQTT Event Handlers
// ─────────────────────────────────────────────

MQTT.setConnectHandler(function () {
    print("MQTT connected.");
    TryAnnounceAndPublish();
});

MQTT.setDisconnectHandler(function () {
    // Cannot publish here – connection is already gone.
    // HA uses native Shelly LWT on <topic_prefix>/online for offline detection.
    print("MQTT disconnected.");
});

// ─────────────────────────────────────────────
// 3. Get Device ID / Name and Initialize
// ─────────────────────────────────────────────

function Initialize() {
    Shelly.call("Mqtt.GetConfig", {}, function (res, err_code, err_msg) {
        if (!res) {
            print("ERROR: Mqtt.GetConfig returned null! Code: " + err_code + " | " + err_msg);
            return;
        }

        SHELLY_ID = res.topic_prefix ? res.topic_prefix : null;


        if (!SHELLY_ID) {
            print("ERROR: No MQTT topic_prefix set. Please check MQTT configuration.");
            return;
        }

        let deviceInfo = Shelly.getDeviceInfo();
        SHELLY_MAC = deviceInfo && deviceInfo.mac ? NormalizeMacAddress(deviceInfo.mac) : SHELLY_ID;
        if (SHELLY_MAC === SHELLY_ID) {
            print("WARNING: Device MAC unavailable. Home Assistant device merge may not work.");
        }

        print("Shelly ID: " + SHELLY_ID + " | Script v" + VERSION);

        if (CONFIG.enablePersistence) {
            LoadCounters();
        } else {
            countersLoaded = true;
            print("Persistence disabled. Counters start at 0.");
        }

        // Resolve the display name, then announce.
        // Identity (topics, uniq_id, KVS keys) always stays bound to SHELLY_ID,
        // so the name can be changed later without creating orphaned entities.
        if (CONFIG.deviceName !== "") {
            DEVICE_NAME = CONFIG.deviceName;
            print("Device name (CONFIG): " + DEVICE_NAME);
            TryAnnounceAndPublish();
        } else {
            Shelly.call("Sys.GetConfig", {}, function (sys) {
                DEVICE_NAME = (sys && sys.device && sys.device.name) ? sys.device.name : SHELLY_ID;
                print("Device name (Shelly settings): " + DEVICE_NAME);
                TryAnnounceAndPublish();
            });
        }
    });
}

if (ValidateConfig()) {
    Initialize();
} else {
    print("ERROR: Invalid configuration. Script stopped.");
}

// ─────────────────────────────────────────────
// 4. Home Assistant Auto-Discovery
// ─────────────────────────────────────────────

function AnnounceHA() {
    if (!SHELLY_ID || !DEVICE_NAME) return;

    let haTopic = CONFIG.mqttPrefix + "/sensor/" + SHELLY_ID;
    let avtyTopic = SHELLY_ID + "/online";

    let dev = {
        "ids": [SHELLY_MAC],
        "cns": [["mac", SHELLY_MAC]],
        "name": DEVICE_NAME,
        "mf": "Shelly",
        "mdl": "Shelly Pro 3EM",
        "sw": "Net Metering v" + VERSION
    };

    let okImport = MQTT.publish(
        haTopic + "-import/config",
        JSON.stringify({
            "name": DEVICE_NAME + " Net Metering Import",
            "uniq_id": SHELLY_ID + "_sald_import",
            "stat_t": SHELLY_ID + "/energy_counter/consumed",
            "unit_of_meas": "kWh",
            "dev_cla": "energy",
            "stat_cla": "total_increasing",
            "avty_t": avtyTopic,
            "pl_avail": "true",
            "pl_not_avail": "false",
            "dev": dev
        }),
        0, true
    );

    let okExport = MQTT.publish(
        haTopic + "-export/config",
        JSON.stringify({
            "name": DEVICE_NAME + " Net Metering Export",
            "uniq_id": SHELLY_ID + "_sald_export",
            "stat_t": SHELLY_ID + "/energy_counter/returned",
            "unit_of_meas": "kWh",
            "dev_cla": "energy",
            "stat_cla": "total_increasing",
            "avty_t": avtyTopic,
            "pl_avail": "true",
            "pl_not_avail": "false",
            "dev": dev
        }),
        0, true
    );

    let okPower = true;
    if (CONFIG.publishPower) {
        okPower = MQTT.publish(
            haTopic + "-power/config",
            JSON.stringify({
                "name": DEVICE_NAME + " Net Metering Power",
                "uniq_id": SHELLY_ID + "_sald_power",
                "stat_t": SHELLY_ID + "/energy_counter/power",
                "unit_of_meas": "W",
                "dev_cla": "power",
                "stat_cla": "measurement",
                "avty_t": avtyTopic,
                "pl_avail": "true",
                "pl_not_avail": "false",
                "dev": dev
            }),
            0, true
        );
    } else {
        // Remove a possibly retained power discovery config from earlier runs
        MQTT.publish(haTopic + "-power/config", "", 0, true);
    }

    if (okImport && okExport && okPower) {
        print("HA Auto-Discovery sent.");
    } else {
        print("WARNING: HA Discovery publish failed (MQTT not ready?).");
    }
}

// ─────────────────────────────────────────────
// 5. Load / Save Persistence (KVS)
// ─────────────────────────────────────────────

function LoadCounters() {
    let loadedCount = 0;

    function checkDone() {
        loadedCount++;
        if (loadedCount === 2) {
            countersLoaded = true;
            lastPublishedConsumed = "";
            lastPublishedReturned = "";
            print("Counters ready. Consumed: " + energyConsumedKWh + " kWh | Returned: " + energyReturnedKWh + " kWh");
            if (MQTT.isConnected()) PublishCounters(true);
        }
    }

    Shelly.call("KVS.Get", { "key": "EnergyConsumedKWh" }, function (res, err_code) {
        if (res && res.value !== undefined && res.value !== null) {
            energyConsumedKWh = Number(res.value);
            if (isNaN(energyConsumedKWh)) energyConsumedKWh = 0.0;
            print("Loaded EnergyConsumedKWh: " + energyConsumedKWh);
        } else if (err_code !== 0) {
            print("INFO: EnergyConsumedKWh not in KVS yet (first run?).");
        }
        checkDone();
    });

    Shelly.call("KVS.Get", { "key": "EnergyReturnedKWh" }, function (res, err_code) {
        if (res && res.value !== undefined && res.value !== null) {
            energyReturnedKWh = Number(res.value);
            if (isNaN(energyReturnedKWh)) energyReturnedKWh = 0.0;
            print("Loaded EnergyReturnedKWh: " + energyReturnedKWh);
        } else if (err_code !== 0) {
            print("INFO: EnergyReturnedKWh not in KVS yet (first run?).");
        }
        checkDone();
    });
}

function SaveCounters() {
    if (saveInProgress) return;
    saveInProgress = true;

    let pending = 2;
    let succeeded = true;

    function checkDone(res, err_code, err_msg) {
        if (err_code !== 0) {
            succeeded = false;
            print("ERROR: KVS.Set failed. Code: " + err_code + " | " + err_msg);
        }
        pending--;
        if (pending === 0) {
            saveInProgress = false;
            if (succeeded) print("Counters saved to KVS.");
        }
    }

    // Include the sub-Wh remainder so a restart cannot discard it.
    Shelly.call("KVS.Set", {
        "key": "EnergyConsumedKWh",
        "value": (energyConsumedKWh + energyConsumedWs / 3600000.0).toFixed(6)
    }, checkDone);
    Shelly.call("KVS.Set", {
        "key": "EnergyReturnedKWh",
        "value": (energyReturnedKWh + energyReturnedWs / 3600000.0).toFixed(6)
    }, checkDone);
}

// ─────────────────────────────────────────────
// 6. Main Calculation Loop
// ─────────────────────────────────────────────

Timer.set(CONFIG.updateInterval, true, function () {
    if (!SHELLY_ID || !countersLoaded) return;

    let em = Shelly.getComponentStatus("em", 0);
    if (!em || typeof em.total_act_power !== "number" || isNaN(em.total_act_power)) {
        // Do not apply a later reading to an interval with unknown power.
        lastTick = null;
        return;
    }


    let power = em.total_act_power;
    if (CONFIG.invertPower) power = -power;

    // Live balanced power in W (positive = import, negative = export).
    // Not retained: a stale live value must not survive broker/HA restarts.
    if (CONFIG.publishPower && MQTT.isConnected()) {
        MQTT.publish(SHELLY_ID + "/energy_counter/power", power.toFixed(1), 0, false);
    }

    let now = Date.now();
    if (lastTick === null) {
        lastTick = now;
        return;
    }

    // Integrate over the REAL elapsed time, not the nominal interval.
    let dt = now - lastTick;
    lastTick = now;
    if (dt <= 0 || dt > 5000) dt = CONFIG.updateInterval; // clock jump (NTP) / blocked tick
    let energyStep = power * (dt / 1000.0);

    if (power >= 0) {
        energyConsumedWs += energyStep;
    } else {
        energyReturnedWs += Math.abs(energyStep);
    }

    if (energyConsumedWs >= 3600) {
        let chunkC = Math.floor(energyConsumedWs / 3600);
        energyConsumedKWh += chunkC / 1000.0;
        energyConsumedWs -= chunkC * 3600;
    }
    if (energyReturnedWs >= 3600) {
        let chunkR = Math.floor(energyReturnedWs / 3600);
        energyReturnedKWh += chunkR / 1000.0;
        energyReturnedWs -= chunkR * 3600;
    }

    PublishCounters(false);

    if (CONFIG.enablePersistence) {
        saveCounter++;
        if (saveCounter >= CONFIG.saveInterval) {
            saveCounter = 0;
            SaveCounters();
        }
    }
});