import assert from "node:assert/strict";
import test from "node:test";
import { createShellyRuntime } from "./shelly-test-harness.js";

const scriptName = "mqtt-periodic-pub.shelly.js";

function createPublisherRuntime(mqttConnected = true) {
    return createShellyRuntime(scriptName, {
        mqttConnected: mqttConnected,
        componentConfig: function (topic) {
            if (topic === "mqtt") return { topic_prefix: "shelly-test" };
            return null;
        },
        componentStatus: function (topic, index) {
            if (topic === "temperature" && index === undefined) return null;
            if (topic === "temperature" && index === 0) return { id: 0, tC: 21.5 };
            return null;
        }
    });
}

test("publishes component instances and finishes the worker cycle", function () {
    let runtime = createPublisherRuntime();

    runtime.runTimers(3, function (timer) { return timer.interval === 500; });

    let publish = runtime.publishes.find(function (value) {
        return value.topic === "shelly-test/status/temperature:0";
    });
    assert.deepEqual(JSON.parse(publish.payload), { id: 0, tC: 21.5 });
    assert.equal(publish.qos, 1);
    assert.equal(publish.retain, false);
    assert.equal(
        runtime.timers().filter(function (timer) { return timer.interval === 500; }).length,
        0
    );
});

test("does not start a publish cycle while MQTT is disconnected", function () {
    let runtime = createPublisherRuntime(false);

    assert.equal(runtime.publishes.length, 0);
    assert.ok(runtime.logs.includes("MQTT not connected, skipping publish"));
    assert.equal(
        runtime.timers().filter(function (timer) { return timer.interval === 500; }).length,
        0
    );
});
