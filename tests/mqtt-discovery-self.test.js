import assert from "node:assert/strict";
import test from "node:test";
import { createShellyRuntime } from "./shelly-test-harness.js";

const scriptName = "mqtt-discovery-self.shelly.js";
const mac = "b8d62ef00f42";
const deviceInfo = {
    name: "Test Shelly",
    mac: "B8:D6:2E:F0:0F:42",
    app: "PM 3",
    model: "SNSPM-001X8",
    ver: "1.1.0",
    gen: 2
};

function createDiscoveryRuntime(componentStatus, options = {}) {
    let rpcResults = new Map([
        ["SensorAddon.GetPeripherals", () => [options.peripherals || {}, 0, ""]]
    ]);
    return createShellyRuntime(scriptName, {
        mqttConnected: false,
        deviceInfo: deviceInfo,
        rpcResults: rpcResults,
        componentStatus: function (topic) {
            let status = componentStatus(topic);
            if (status !== undefined) return status;
            if (topic === "mqtt") return { topic_prefix: "shelly-test" };
            if (topic === "wifi") return { sta_ip: "192.168.1.42" };
            return null;
        },
        componentConfig: function (topic) {
            if (topic === "switch:0") return { name: "Front door" };
            if (topic === "temperature:0") return { tC: { }, tF: { } };
            if (topic === "em:0") {
                return {
                    a_current: { },
                    a_voltage: { },
                    a_act_power: { },
                    a_act_energy: { }
                };
            }
            if (topic === "mqtt") return { topic_prefix: "shelly-test" };
            return null;
        }
    });
}

function runDiscoveryCycle(runtime) {
    runtime.setMqttConnected(true);
    runtime.runTimers(8, function (timer) { return timer.interval === 500; });
}


test("publishes switch and temperature discovery with device identity", function () {
    let runtime = createDiscoveryRuntime(function (topic) {
        if (topic === "switch") return null;
        if (topic === "switch:0") return { output: false };
        if (topic === "temperature") return null;
        if (topic === "temperature:0") return { tC: 21, tF: 69.8 };
        return undefined;
    });

    runDiscoveryCycle(runtime);

    let switchPayload = runtime.entityPayload(
        "homeassistant/switch/" + mac + "/switch0-output/config"
    );
    assert.deepEqual(switchPayload, {
        name: "Front door Switch",
        uniq_id: mac + "_switch0_output",
        stat_t: "shelly-test/status/switch:0",
        avty: {
            t: "shelly-test/online",
            pl_avail: "true",
            pl_not_avail: "false"
        },
        val_tpl: "{{ 'on' if value_json.output else 'off' }}",
        dev_cla: "switch",
        cmd_t: "shelly-test/command/switch:0",
        pl_on: "on",
        pl_off: "off",
        dev: {
            name: "Test Shelly",
            ids: [mac],
            cns: [["mac", mac]],
            mf: "Shelly",
            mdl: "Shelly PM 3",
            mdl_id: "SNSPM-001X8",
            sw: "1.1.0",
            hw: "gen 2",
            cu: "http://192.168.1.42"
        }
    });

    let temperaturePayload = runtime.entityPayload(
        "homeassistant/sensor/" + mac + "/temperature0-tC/config"
    );
    assert.equal(temperaturePayload.name, "Temperature");
    assert.equal(temperaturePayload.unit_of_meas, "°C");
    assert.equal(temperaturePayload.val_tpl, "{{ value_json.tC }}");
});

test("reports energy phases, disables minor entities, and publishes initial data", function () {
    let runtime = createDiscoveryRuntime(function (topic) {
        if (topic === "em") return null;
        if (topic === "em:0") return {
            a_act_power: 6,
            a_voltage: 231,
            a_current: 0.03,
            a_act_energy: { total: 20 }
        };
        return undefined;
    });

    runDiscoveryCycle(runtime);

    let powerPayload = runtime.entityPayload(
        "homeassistant/sensor/" + mac + "/em0-a_act_power/config"
    );
    assert.equal(powerPayload.name, "Active Power A");
    assert.equal(powerPayload.stat_cla, "measurement");

    let energyPayload = runtime.entityPayload(
        "homeassistant/sensor/" + mac + "/em0-a_act_energy/config"
    );
    assert.equal(energyPayload.dev_cla, "energy");
    assert.equal(energyPayload.stat_cla, "total_increasing");
    assert.equal(energyPayload.val_tpl, "{{ value_json.a_act_energy.total }}");

    let voltagePayload = runtime.entityPayload(
        "homeassistant/sensor/" + mac + "/em0-a_voltage/config"
    );
    assert.equal(voltagePayload.en, false);

    let dataPublishes = runtime.publishes.filter(function (publish) {
        return publish.topic === "shelly-test/status/em:0";
    });
    assert.ok(dataPublishes.length >= 1);
    assert.equal(dataPublishes[0].retain, false);
    assert.equal(JSON.parse(dataPublishes[0].payload).a_act_power, 6);
});

test("discovers temperature addon entities and uses configured display precision", function () {
    let runtime = createDiscoveryRuntime(function (topic) {
        if (topic === "temperature:100") return { tC: 22.1 };
        return undefined;
    }, {
        peripherals: {
            addon: {
                "temperature:100": { }
            }
        }
    });

    runDiscoveryCycle(runtime);

    let payload = runtime.entityPayload(
        "homeassistant/sensor/" + mac + "/temperature100-tC/config"
    );
    assert.equal(payload.name, "Addon Temperature 1");
    assert.equal(payload.sug_dsp_prc, 2);
});

test("cancels stale discovery work after MQTT disconnect", function () {
    let runtime = createDiscoveryRuntime(function (topic) {
        if (topic === "switch") return null;
        if (topic === "switch:0") return { output: false };
        if (topic === "switch:1") return { output: false };
        return undefined;
    });

    runtime.setMqttConnected(true);
    runtime.runTimers(1, function (timer) { return timer.interval === 500; });
    let publishedBeforeDisconnect = runtime.discoveryPublishes().length;

    runtime.fireDisconnect();
    let timersAfterDisconnect = runtime.timers();
    assert.equal(
        timersAfterDisconnect.filter(function (timer) {
            return timer.interval === 500;
        }).length,
        0
    );

    runtime.setMqttConnected(true);
    assert.equal(runtime.discoveryPublishes().length, publishedBeforeDisconnect);
});