import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const scriptSource = readFileSync(
    join(testDirectory, "..", "scripts", "mqtt-energy-counter.js"),
    "utf8"
);

function withSaveEveryCycle() {
    return scriptSource.replace("saveInterval: 900", "saveInterval: 1");
}

function createRuntime(source = scriptSource, options = {}) {
    let now = 0;
    let power = 0;
    let timerCallback = null;
    let mqttConfigCalls = 0;
    let setResults = options.setResults ? options.setResults.slice() : [];
    let storedValues = options.storedValues || {};
    let logs = [];
    let publishes = [];
    let kvsSets = [];

    let sandbox = {
        Date: { now: function () { return now; } },
        JSON: JSON,
        Math: Math,
        isNaN: isNaN,
        print: function (message) { logs.push(message); },
        MQTT: {
            isConnected: function () { return true; },
            publish: function (topic, payload, qos, retain) {
                publishes.push({ topic: topic, payload: payload, qos: qos, retain: retain });
                return true;
            },
            setConnectHandler: function () {},
            setDisconnectHandler: function () {}
        },
        Shelly: {
            getComponentStatus: function () {
                return { total_act_power: power };
            },
            call: function (method, args, callback) {
                if (method === "Mqtt.GetConfig") {
                    mqttConfigCalls++;
                    callback({ topic_prefix: "shellypro3em-test" }, 0, "");
                } else if (method === "Sys.GetConfig") {
                    callback({ device: { name: "Test meter" } }, 0, "");
                } else if (method === "KVS.Get") {
                    if (Object.prototype.hasOwnProperty.call(storedValues, args.key)) {
                        callback({ value: storedValues[args.key] }, 0, "");
                    } else {
                        callback(null, 404, "missing");
                    }
                } else if (method === "KVS.Set") {
                    kvsSets.push(args);
                    let result = setResults.length ? setResults.shift() : { code: 0, message: "" };
                    callback({}, result.code, result.message);
                } else {
                    throw new Error("Unexpected RPC: " + method);
                }
            }
        },
        Timer: {
            set: function (interval, repeat, callback) {
                timerCallback = callback;
            }
        }
    };

    vm.runInNewContext(source, sandbox, { filename: "mqtt-energy-counter.js" });

    return {
        logs: logs,
        publishes: publishes,
        kvsSets: kvsSets,
        mqttConfigCalls: function () { return mqttConfigCalls; },
        tick: function (time, nextPower) {
            now = time;
            power = nextPower;
            timerCallback();
        },
        latestKvsValue: function (key) {
            for (let index = kvsSets.length - 1; index >= 0; index--) {
                if (kvsSets[index].key === key) return kvsSets[index].value;
            }
            return null;
        }
    };
}

test("announces energy and power sensors with Home Assistant discovery", function () {
    let runtime = createRuntime();
    let configs = runtime.publishes.filter(function (publish) {
        return publish.topic.endsWith("/config");
    });

    assert.equal(configs.length, 3);
    assert.ok(configs.every(function (publish) { return publish.retain === true; }));

    let importConfig = configs.find(function (publish) {
        return publish.topic.endsWith("-import/config");
    });
    assert.equal(importConfig.topic, "homeassistant/sensor/shellypro3em-test-import/config");
    assert.deepEqual(JSON.parse(importConfig.payload), {
        name: "Test meter Saldierend Import",
        uniq_id: "shellypro3em-test_sald_import",
        stat_t: "shellypro3em-test/energy_counter/consumed",
        unit_of_meas: "kWh",
        dev_cla: "energy",
        stat_cla: "total_increasing",
        avty_t: "shellypro3em-test/online",
        pl_avail: "true",
        pl_not_avail: "false",
        dev: {
            ids: ["shellypro3em-test"],
            name: "Test meter",
            mf: "Shelly",
            mdl: "Shelly Pro 3EM",
            sw: "Saldierung v1.2.0"
        }
    });
});

test("does not integrate the first sample or an interval after invalid power", function () {
    let runtime = createRuntime(withSaveEveryCycle());

    runtime.tick(1000, 100);
    runtime.tick(2000, 100);
    runtime.tick(3000, NaN);
    runtime.tick(4000, 100);
    runtime.tick(5000, 100);

    assert.equal(runtime.latestKvsValue("EnergyConsumedKWh"), "0.000056");
    assert.equal(runtime.latestKvsValue("EnergyReturnedKWh"), "0.000000");
});

test("uses inverted power for export energy and live power", function () {
    let runtime = createRuntime(withSaveEveryCycle().replace("invertPower: false", "invertPower: true"));

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
    let runtime = createRuntime(withSaveEveryCycle(), {
        storedValues: { EnergyConsumedKWh: "1.234567", EnergyReturnedKWh: "0" },
        setResults: [{ code: 500, message: "write failed" }, { code: 0, message: "" }]
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
    let runtime = createRuntime(scriptSource.replace("updateInterval: 1000", "updateInterval: 0"));

    assert.equal(runtime.mqttConfigCalls(), 0);
    assert.ok(runtime.logs.includes("ERROR: Invalid configuration. Script stopped."));
});
