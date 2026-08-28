# MQTT ENERGY COUNTER

This script calculates balanced imported and exported energy from the `em:0` total active power of a Shelly Pro 3EM. It publishes retained import and export counters to MQTT and registers them as Home Assistant energy sensors through MQTT Discovery.

Optionally, it also publishes the current balanced power. Positive power represents import; negative power represents export.

## Requirements

1. Shelly Pro 3EM with an `em:0` component
2. MQTT configured and enabled on the Shelly device

Home Assistant MQTT Discovery must be enabled to create the entities automatically.

## Installation and Configuration

For installation instructions, see the [Installation](/#installation) section.

Link to the script: [link](./mqtt-energy-counter.js)

**Configuration parameters**

| Variable | Default Value | Description |
| --- | --- | --- |
| `updateInterval` | `1000` | Calculation interval in milliseconds |
| `enablePersistence` | `true` | Saves the counters in Shelly KVS so they survive script restarts |
| `saveInterval` | `900` | Number of calculation cycles between KVS saves |
| `mqttPrefix` | `"homeassistant"` | Home Assistant MQTT Discovery topic prefix |
| `publishPower` | `true` | Publishes the live balanced power sensor |
| `invertPower` | `false` | Reverses the power sign when all current clamps are installed in reverse |
| `deviceName` | `""` | Home Assistant device name; an empty value uses the Shelly device name |

The persisted counters use the KVS keys `EnergyConsumedKWh` and `EnergyReturnedKWh`. Disable persistence to start both counters at zero on every script start.
