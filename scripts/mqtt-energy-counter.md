# MQTT ENERGY COUNTER

This script calculates balanced imported and exported energy from the `em:0` total active power of a Shelly Pro 3EM. It publishes retained import and export counters to MQTT and registers them as Home Assistant energy sensors through MQTT Discovery.

Optionally, it also publishes the current balanced power. Positive power represents import; negative power represents export.

## Requirements

1. Shelly Pro 3EM with an `em:0` component
2. MQTT configured and enabled on the Shelly device

Home Assistant MQTT Discovery must be enabled to create the entities automatically.

## Home Assistant device association

When used with `mqtt-discovery-self.shelly.js` on the same Shelly, the scripts use the physical MAC address as their MQTT Discovery device identifier. Home Assistant therefore groups their entities under one device.

After updating this script, restart it or reconnect MQTT so it republishes discovery. If `mqtt-discovery-self.shelly.js` uses `fake_macaddress` for testing, leave it empty on production devices; otherwise its discovery identifier will intentionally differ.

## Installation and Configuration

For installation instructions, see the [Installation](/#installation) section.

Link to the script: [link](./mqtt-energy-counter.js)

**Configuration parameters**

| Variable | Default Value | Description |
| --- | --- | --- |
| `updateInterval` | `1000` | Calculation interval in milliseconds |
| `enablePersistence` | `true` | Saves the counters in Shelly KVS so they survive script restarts; each checkpoint includes sub-Wh energy |
| `saveInterval` | `900` | Number of calculation cycles between KVS saves |
| `mqttPrefix` | `"homeassistant"` | Home Assistant MQTT Discovery topic prefix |
| `publishPower` | `true` | Publishes the live balanced power sensor |
| `invertPower` | `false` | Reverses the power sign when all current clamps are installed in reverse |
| `deviceName` | `""` | Home Assistant device name; an empty value uses the Shelly device name |

The persisted counters use the KVS keys `EnergyConsumedKWh` and `EnergyReturnedKWh`. Disable persistence to start both counters at zero on every script start.

## Precision and persistence

The Home Assistant energy counters publish in 1 Wh (`0.001 kWh`) increments. KVS checkpoints retain the complete counter value to `0.001 Wh` precision, including the sub-Wh remainder accumulated since the previous whole-Wh increment. A sudden power loss can still lose energy measured after the last checkpoint.
