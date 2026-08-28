import assert from "node:assert/strict";
import test from "node:test";
import { createShellyRuntime } from "./shelly-test-harness.js";

const scriptName = "mqtt-energy-counter.js";

function createCounterRuntime(options = {}) {
    let power = 0;

    let rpcResults = new Map([
        ["Mqtt.GetConfig", () => [{ topic_prefix: "shellypro3em-test" }, 0, ""]],
        ["Sys.GetConfig", () => [{ device: { name: "Test meter" } }, 0, ""]]
    ]);
    if (options.rpcResults) {
        for (let [method, result] of options.rpcResults) rpcResults.set(method, result);
    }

    let runtime = createShellyRuntime(scriptName, {
        transform: options.transform,
        deviceInfo: { name: "Test meter", mac: "B8:D6:2E:F0:0F:42" },
        rpcResults: rpcResults,
        kvsValues: options.kvsValues,
        kvsSetResults: options.kvsSetResults,
        publishResult: options.publishResult,
        componentStatus: function (topic) {
            if (topic === "em" || topic === "em:0") {
                return { total_act_power: power };
            }
            return null;
        }
    });

    return {
        ...runtime,
        tick: function (time, nextPower) {
            runtime.setNow(time);
            power = nextPower;
            runtime.runTimers(1);
        }
    };
}

test("announces energy sensors under the physical Shelly device identity", function () {
    let runtime = createCounterRuntime();
    let configs = runtime.discoveryPublishes();

    assert.equal(configs.length, 3);
    assert.ok(configs.every(function (publish) { return publish.retain === true; }));
    assert.deepEqual(
        configs.map(function (publish) {
            return JSON.parse(publish.payload).name;
        }).sort(),
        [
            "Test meter Net Metering Export",
            "Test meter Net Metering Import",
            "Test meter Net Metering Power"
        ]
    );

    let importConfig = configs.find(function (publish) {
        return publish.topic.endsWith("-import/config");
    });
    assert.equal(importConfig.topic, "homeassistant/sensor/shellypro3em-test-import/config");
    assert.deepEqual(JSON.parse(importConfig.payload), {
        name: "Test meter Net Metering Import",
        uniq_id: "shellypro3em-test_sald_import",
        stat_t: "shellypro3em-test/energy_counter/consumed",
        unit_of_meas: "kWh",
        dev_cla: "energy",
        stat_cla: "total_increasing",
        avty_t: "shellypro3em-test/online",
        pl_avail: "true",
        pl_not_avail: "false",
        dev: {
            ids: ["b8d62ef00f42"],
            cns: [["mac", "b8d62ef00f42"]],
            name: "Test meter",
            mf: "Shelly",
            mdl: "Shelly Pro 3EM"
        }
    });
});

test("does not integrate the first sample or an interval after invalid power", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source.replace("saveInterval: 900", "saveInterval: 1");
        }
    });

    runtime.tick(1000, 100);
    runtime.tick(2000, 100);
    runtime.tick(3000, NaN);
    runtime.tick(4000, 100);
    runtime.tick(5000, 100);

    assert.equal(runtime.latestKvsValue("EnergyConsumedKWh"), "0.000056");
    assert.equal(runtime.latestKvsValue("EnergyReturnedKWh"), "0.000000");
});

test("uses inverted power for export energy and live power", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source
                .replace("saveInterval: 900", "saveInterval: 1")
                .replace("invertPower: false", "invertPower: true");
        }
    });

    runtime.tick(1000, 100);
    runtime.tick(2000, 100);

    assert.equal(runtime.latestKvsValue("EnergyConsumedKWh"), "0.000000");
    assert.equal(runtime.latestKvsValue("EnergyReturnedKWh"), "0.000028");
    assert.ok(runtime.publishes.some(function (publish) {
        return publish.topic === "shellypro3em-test/energy_counter/power" &&
            publish.payload === "-100.0" && publish.retain === false;
    }));
});

test("persists sub-Wh energy and recovers after a KVS save failure", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source.replace("saveInterval: 900", "saveInterval: 1");
        },
        kvsValues: {
            EnergyConsumedKWh: "1.234567",
            EnergyReturnedKWh: "0"
        },
        kvsSetResults: [{ code: 500, message: "write failed" }]
    });

    runtime.tick(1000, 100);
    runtime.tick(2000, 100);
    runtime.tick(3000, 100);

    assert.equal(runtime.kvsSets.length, 4);
    assert.equal(runtime.latestKvsValue("EnergyConsumedKWh"), "1.234623");
    assert.ok(runtime.logs.some(function (message) {
        return message === "ERROR: KVS.Set failed. Code: 500 | write failed";
    }));
    assert.ok(runtime.logs.includes("Counters saved to KVS."));
});

test("rejects invalid configuration before initializing MQTT", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source.replace("updateInterval: 1000", "updateInterval: 0");
        }
    });

    assert.equal(runtime.kvsSets.length, 0);
    assert.equal(
        runtime.publishes.filter(function (publish) {
            return publish.topic.endsWith("/config");
        }).length,
        0
    );
    assert.ok(runtime.logs.includes("ERROR: Invalid configuration. Script stopped."));
});

test("removes stale power discovery when live power is disabled", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source.replace("publishPower: true", "publishPower: false");
        }
    });

    let configs = runtime.discoveryPublishes();
    assert.equal(
        configs.filter(function (publish) { return publish.payload !== ""; }).length,
        2
    );
    assert.ok(configs.some(function (publish) {
        return publish.topic === "homeassistant/sensor/shellypro3em-test-power/config" &&
            publish.payload === "" && publish.retain === true;
    }));
});

test("reannounces discovery and retained counters after an MQTT reconnect", function () {
    let runtime = createCounterRuntime();
    let discoveryCount = runtime.discoveryPublishes().length;
    let counterCount = runtime.publishes.filter(function (publish) {
        return publish.topic.endsWith("/energy_counter/consumed") ||
            publish.topic.endsWith("/energy_counter/returned");
    }).length;

    runtime.fireDisconnect();
    runtime.setMqttConnected(true);

    assert.equal(runtime.discoveryPublishes().length, discoveryCount + 3);
    assert.equal(
        runtime.publishes.filter(function (publish) {
            return publish.topic.endsWith("/energy_counter/consumed") ||
                publish.topic.endsWith("/energy_counter/returned");
        }).length,
        counterCount + 2
    );
});

test("rejects wildcard characters in the discovery topic prefix", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source.replace('mqttPrefix: "homeassistant"', 'mqttPrefix: "homeassistant/#"');
        }
    });

    assert.ok(runtime.logs.includes(
        "ERROR: CONFIG.mqttPrefix must be a non-empty MQTT topic prefix without wildcards."
    ));
    assert.equal(runtime.discoveryPublishes().length, 0);
});

test("resets invalid persisted counter values before integrating", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source.replace("saveInterval: 900", "saveInterval: 1");
        },
        kvsValues: {
            EnergyConsumedKWh: "not a number",
            EnergyReturnedKWh: "NaN"
        }
    });

    runtime.tick(1000, 100);
    runtime.tick(2000, 100);

    assert.equal(runtime.latestKvsValue("EnergyConsumedKWh"), "0.000028");
    assert.equal(runtime.latestKvsValue("EnergyReturnedKWh"), "0.000000");
});

test("clamps clock jumps to one configured update interval", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source.replace("saveInterval: 900", "saveInterval: 1");
        }
    });

    runtime.tick(1000, 100);
    runtime.tick(9000, 100);

    assert.equal(runtime.latestKvsValue("EnergyConsumedKWh"), "0.000028");
});

test("skips KVS writes when persistence is disabled", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source
                .replace("enablePersistence: true", "enablePersistence: false")
                .replace("saveInterval: 900", "saveInterval: 1");
        }
    });

    runtime.tick(1000, 100);
    runtime.tick(2000, 100);

    assert.equal(runtime.kvsSets.length, 0);
    assert.ok(runtime.logs.includes("Persistence disabled. Counters start at 0."));
});

test("uses the configured display name without changing counter identity", function () {
    let runtime = createCounterRuntime({
        transform: function (source) {
            return source.replace('deviceName: ""', 'deviceName: "Basement meter"');
        }
    });

    let importConfig = runtime.discoveryPublishes().find(function (publish) {
        return publish.topic.endsWith("-import/config");
    });
    let payload = JSON.parse(importConfig.payload);
    assert.equal(payload.name, "Basement meter Net Metering Import");
    assert.equal(payload.uniq_id, "shellypro3em-test_sald_import");
    assert.equal(payload.dev.name, "Basement meter");
});

test("retries retained counter publication after an MQTT publish failure", function () {
    let acceptsPublishes = true;
    let runtime = createCounterRuntime({
        publishResult: function () { return acceptsPublishes; }
    });

    runtime.tick(1000, 3600);
    acceptsPublishes = false;
    runtime.tick(2000, 3600);
    let failedCount = runtime.publishes.filter(function (publish) {
        return publish.topic.endsWith("/energy_counter/consumed") ||
            publish.topic.endsWith("/energy_counter/returned");
    }).length;

    acceptsPublishes = true;
    runtime.tick(3000, 0);

    assert.equal(
        runtime.publishes.filter(function (publish) {
            return publish.topic.endsWith("/energy_counter/consumed") ||
                publish.topic.endsWith("/energy_counter/returned");
        }).length,
        failedCount + 2
    );
});

test("stops initialization when MQTT configuration cannot be read", function () {
    let runtime = createCounterRuntime({
        rpcResults: new Map([
            ["Mqtt.GetConfig", () => [null, 500, "rpc unavailable"]]
        ])
    });

    assert.ok(runtime.logs.includes(
        "ERROR: Mqtt.GetConfig returned null! Code: 500 | rpc unavailable"
    ));
    assert.equal(runtime.discoveryPublishes().length, 0);
    assert.equal(runtime.kvsSets.length, 0);
});

test("falls back to the MQTT topic prefix when the Shelly name is absent", function () {
    let runtime = createCounterRuntime({
        rpcResults: new Map([
            ["Sys.GetConfig", () => [{}, 0, ""]]
        ])
    });

    let importConfig = runtime.discoveryPublishes().find(function (publish) {
        return publish.topic.endsWith("-import/config");
    });
    let payload = JSON.parse(importConfig.payload);
    assert.equal(payload.name, "shellypro3em-test Net Metering Import");
    assert.equal(payload.dev.name, "shellypro3em-test");
});