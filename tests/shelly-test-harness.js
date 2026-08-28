import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));

export function scriptSource(name, transform) {
    let source = readFileSync(
        join(testDirectory, "..", "scripts", name),
        "utf8"
    );
    return transform ? transform(source) : source;
}

export function createShellyRuntime(name, options = {}) {
    let now = 0;
    let timers = new Map();
    let timerId = 0;
    let eventHandler = null;
    let connectHandler = null;
    let disconnectHandler = null;
    let publishes = [];
    let kvsSets = [];
    let logs = [];

    let mqttConnected = options.mqttConnected !== false;
    let rpcResults = options.rpcResults || new Map();
    let kvsValues = options.kvsValues || {};
    let kvsGetErrors = options.kvsGetErrors || new Set();
    let kvsSetResults = options.kvsSetResults ? options.kvsSetResults.slice() : [];

    function callRpc(callback, payload, code, message) {
        if (!callback) return;
        if (code === undefined) callback(payload);
        else callback(payload, code, message);
    }

    function runRpc(method, args, callback) {
        let result = rpcResults.get(method);
        if (result) return callRpc(callback, ...result(args));

        if (method === "KVS.Get") {
            if (kvsGetErrors.has(args.key)) {
                return callRpc(callback, null, 1, "kvs read failed");
            }
            if (Object.prototype.hasOwnProperty.call(kvsValues, args.key)) {
                return callRpc(callback, { value: kvsValues[args.key] }, 0, "");
            }
            return callRpc(callback, null, 404, "not found");
        }

        if (method === "KVS.Set") {
            kvsSets.push(args);
            kvsValues[args.key] = args.value;
            let error = kvsSetResults.length ? kvsSetResults.shift() : null;
            if (error) return callRpc(callback, {}, error.code, error.message);
            return callRpc(callback, {}, 0, "");
        }

        throw new Error("Unexpected RPC: " + method);
    }

    let sandbox = {
        Date: { now: function () { return now; } },
        JSON: JSON,
        Math: Math,
        isNaN: isNaN,
        print: function (message) { logs.push(message); },
        MQTT: {
            isConnected: function () { return mqttConnected; },
            publish: function (topic, payload, qos, retain) {
                publishes.push({ topic: topic, payload: payload, qos: qos, retain: retain });
                return true;
            },
            setConnectHandler: function (handler) { connectHandler = handler; },
            setDisconnectHandler: function (handler) { disconnectHandler = handler; }
        },
        Shelly: {
            getDeviceInfo: function () { return options.deviceInfo; },
            getComponentStatus: function (topic) {
                return options.componentStatus ? options.componentStatus(topic) : null;
            },
            getComponentConfig: function (topic) {
                return options.componentConfig ? options.componentConfig(topic) : null;
            },
            call: runRpc,
            addEventHandler: function (handler) { eventHandler = handler; }
        },
        Timer: {
            set: function (interval, repeat, callback, param) {
                timerId++;
                let handle = { id: timerId, interval: interval, repeat: repeat, callback: callback, param: param, cleared: false };
                timers.set(handle.id, handle);
                return handle;
            },
            clear: function (handle) {
                if (handle) handle.cleared = true;
            }
        }
    };

    vm.runInNewContext(scriptSource(name, options.transform), sandbox, { filename: name });

    function activeTimers() {
        return Array.from(timers.values()).filter(function (timer) {
            return !timer.cleared;
        });
    }

    return {
        logs: logs,
        publishes: publishes,
        kvsSets: kvsSets,
        setNow: function (value) {
            now = value;
        },
        timers: function () {
            return activeTimers();
        },
        setMqttConnected: function (connected) {
            mqttConnected = connected;
            if (connected && connectHandler) connectHandler();
        },
        fireDisconnect: function () {
            mqttConnected = false;
            if (disconnectHandler) disconnectHandler();
        },
        fireConfigChanged: function (name, restartRequired) {
            if (eventHandler) {
                eventHandler({
                    info: { event: "config_changed", restart_required: !!restartRequired },
                    name: name
                });
            }
        },
        runTimers: function (count, predicate) {
            for (let i = 0; i < count; i++) {
                let matching = activeTimers().filter(function (timer) {
                    return !predicate || predicate(timer);
                });
                for (let timer of matching) timer.callback(timer.param);
            }
        },
        latestKvsValue: function (key) {
            for (let index = kvsSets.length - 1; index >= 0; index--) {
                if (kvsSets[index].key === key) return kvsSets[index].value;
            }
            return null;
        },
        discoveryPublishes: function () {
            return publishes.filter(function (publish) {
                return publish.topic.endsWith("/config");
            });
        },
        entityPayload: function (topic) {
            let publish = publishes.find(function (publish) {
                return publish.topic === topic && publish.payload !== "";
            });
            return publish ? JSON.parse(publish.payload) : null;
        }
    };
}