import assert from "node:assert/strict";
import test from "node:test";
import { createShellyRuntime } from "./shelly-test-harness.js";

const scriptName = "mqtt-discovery-ble.shelly.js";
const sensorMac = "aabbccddeeff";

function createBleRuntime(options = {}) {
    let scanCallback = null;
    let BLE = {
        Scanner: {
            INFINITE_SCAN: -1,
            SCAN_RESULT: 1,
            isRunning: function () { return false; },
            Start: function () { return {}; },
            Subscribe: function (callback) { scanCallback = callback; }
        }
    };
    let runtime = createShellyRuntime(scriptName, {
        deviceInfo: {
            id: "shellypro3em-test",
            name: "Test Shelly",
            mac: "B8:D6:2E:F0:0F:42"
        },
        globals: { BLE: BLE },
        rpcResults: new Map([
            ["KVS.Get", () => [{
                value: JSON.stringify({
                    "AA:BB:CC:DD:EE:FF": ["Shelly", "DW BLU"]
                })
            }, 0, ""]]
        ]),
        componentConfig: function (topic) {
            if (topic === "ble") return { enable: options.bleEnabled !== false };
            return null;
        }
    });

    return {
        ...runtime,
        isScannerSubscribed: function () {
            return scanCallback !== null;
        },
        report: function (address, advData) {
            scanCallback(BLE.Scanner.SCAN_RESULT, {
                addr: address,
                rssi: -65,
                advData: advData || [10, 0x16, 0xd2, 0xfc, 0, 0x02, 0xc4, 0x09, 0x01, 100]
            });
        }
    };
}

test("discovers and publishes allowed BTHome BLE sensors", function () {
    let runtime = createBleRuntime();

    runtime.report("AA:BB:CC:DD:EE:FF");

    let discovery = runtime.entityPayload(
        "homeassistant/sensor/" + sensorMac + "/temperature/config"
    );
    assert.ok(discovery, JSON.stringify(runtime.publishes));
    assert.equal(discovery.dev_cla, "temperature");
    assert.equal(discovery.device.name, sensorMac + "-DW BLU");
    assert.deepEqual(discovery.device.via_device, "b8d62ef00f42");

    let dataPublish = runtime.publishes.find(function (publish) {
        return publish.topic === "blegateway/" + sensorMac + "/data";
    });
    assert.deepEqual(JSON.parse(dataPublish.payload), {
        temperature: 25,
        battery: 100,
        rssi: -65,
        src: "shellypro3em-test (Test Shelly)"
    });
    assert.equal(dataPublish.retain, false);
});

test("ignores BLE advertisements from unallowed devices", function () {
    let runtime = createBleRuntime();

    runtime.report("11:22:33:44:55:66");

    assert.equal(runtime.publishes.length, 0);
    assert.ok(runtime.logs.some(function (message) {
        return message.includes("Ignored MAC: 112233445566");
    }));
});

test("publishes data repeatedly without duplicating BLE discovery entries", function () {
    let runtime = createBleRuntime();

    runtime.report("AA:BB:CC:DD:EE:FF");
    runtime.report("AA:BB:CC:DD:EE:FF");

    assert.equal(
        runtime.publishes.filter(function (publish) {
            return publish.topic === "homeassistant/sensor/" + sensorMac + "/temperature/config";
        }).length,
        1
    );
    assert.equal(
        runtime.publishes.filter(function (publish) {
            return publish.topic === "blegateway/" + sensorMac + "/data";
        }).length,
        2
    );
});

test("does not start or subscribe a scanner while BLE is disabled", function () {
    let runtime = createBleRuntime({ bleEnabled: false });

    assert.equal(runtime.isScannerSubscribed(), false);
    assert.ok(runtime.logs.includes(
        "Error: The Bluetooth is not enabled, please enable it from settings"
    ));
});

test("ignores encrypted BTHome advertisements", function () {
    let runtime = createBleRuntime();

    runtime.report("AA:BB:CC:DD:EE:FF", [10, 0x16, 0xd2, 0xfc, 1, 0x02, 0xc4, 0x09, 0x01, 100]);

    assert.equal(runtime.publishes.length, 0);
});
