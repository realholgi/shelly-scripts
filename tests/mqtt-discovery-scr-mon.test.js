import assert from "node:assert/strict";
import test from "node:test";
import { createShellyRuntime } from "./shelly-test-harness.js";

const scriptName = "mqtt-discovery-scr-mon.shelly.js";
const mac = "b8d62ef00f42";

function createMonitorRuntime(mqttConnected = true, options = {}) {
    return createShellyRuntime(scriptName, {
        mqttConnected: mqttConnected,
        transform: options.transform,
        deviceInfo: {
            name: "Test Shelly",
            mac: "B8:D6:2E:F0:0F:42",
            app: "Pro 3EM",
            model: "SPEM-003CEBEU",
            ver: "2.0.0",
            gen: 2
        },
        rpcResults: new Map([
            ["Script.List", () => [{
                scripts: [
                    { id: 1, name: "Discovery" },
                    { id: 2, name: "Energy counter" }
                ]
            }, 0, ""]]
        ]),
        componentConfig: function (topic) {
            if (topic === "mqtt") return { topic_prefix: "shelly-test" };
            return null;
        },
        componentStatus: function (topic, id) {
            if (topic === "wifi") return { sta_ip: "192.168.1.42" };
            if (topic === "script" && id === 1) {
                return { running: true, mem_used: 4096, mem_peak: 8192, mem_free: 16384, errors: 0, error_msg: null };
            }
            if (topic === "script" && id === 2) {
                return { running: false, mem_used: 2048, mem_peak: 4096, mem_free: 16000, errors: 1, error_msg: "syntax error" };
            }
            return null;
        }
    });
}

test("publishes script monitor discovery with the physical Shelly identity", function () {
    let runtime = createMonitorRuntime();
    let topic = "homeassistant/sensor/" + mac + "/scripts_monitor/config";
    let payload = runtime.entityPayload(topic);

    assert.equal(payload.uniq_id, mac + "_scripts");
    assert.equal(payload.stat_t, "shelly-test/status/scripts");
    assert.equal(payload.val_tpl, "{{ value_json.running_count }}");
    assert.deepEqual(payload.dev.ids, [mac]);
    assert.equal(payload.dev.cu, "http://192.168.1.42");
});

test("reports script runtime statistics and running count", function () {
    let runtime = createMonitorRuntime();

    runtime.runTimers(1, function (timer) { return timer.interval === 2000; });

    let publish = runtime.publishes.find(function (value) {
        return value.topic === "shelly-test/status/scripts";
    });
    let payload = JSON.parse(publish.payload);
    assert.equal(payload.running_count, 1);
    assert.equal(payload.scripts_mem_free, 16000);
    assert.deepEqual(payload.scripts[0], {
        id: 1,
        name: "Discovery",
        running: true,
        mem_used: 4096,
        mem_peak: 8192,
        errors: 0,
        error_msg: null
    });
    assert.equal(publish.qos, 1);
    assert.equal(publish.retain, false);
});

test("does not publish discovery or script data while MQTT is disconnected", function () {
    let runtime = createMonitorRuntime(false);

    runtime.runTimers(1, function (timer) { return timer.interval === 2000; });

    assert.equal(runtime.publishes.length, 0);
    assert.ok(runtime.logs.includes("MQTT not connected, skipping discovery publish"));
    assert.ok(runtime.logs.includes("MQTT not connected, skipping publish"));
});


test("uses the configured fake MAC and default name for monitor discovery", function () {
    let runtime = createMonitorRuntime(true, {
        transform: function (source) {
            return source
                .replace("device: true", "device: false")
                .replace('fake_macaddress: ""', 'fake_macaddress: "00:11:22:33:44:55"');
        }
    });

    let payload = runtime.entityPayload(
        "homeassistant/sensor/001122334455/scripts_monitor/config"
    );
    assert.equal(payload.uniq_id, "001122334455_scripts");
    assert.equal(payload.dev.name, "001122334455-Pro 3EM");
});