/**
 * Hooks up the electrical solver to the main simulator store:
 *   - subscribe to components, wires, pin changes
 *   - on change, build the input and request a solve
 *   - inject node voltages back into ADC channels
 *
 * Called once at app startup (typically from EditorPage or main.tsx).
 * Returns an `unsubscribe()` for cleanup.
 */
import { useSimulatorStore, getBoardSimulator, getBoardPinManager } from '../../store/useSimulatorStore';
import { useElectricalStore } from '../../store/useElectricalStore';
import { buildInputFromStore } from './storeAdapter';
import { setAdcVoltage } from '../parts/partUtils';
import type { PinSourceState } from './types';
import type { BoardKind } from '../../types/board';
import { BOARD_PIN_GROUPS } from './boardPinGroups';

// Which Arduino-style pin name maps to which ADC channel, per board.
// Used to inject SPICE-solved voltages back into the MCU's ADC peripheral.
function adcRange(prefix: string, start: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    pinName: `${prefix}${start + i}`,
    channel: i,
  }));
}

const ADC_6CH = adcRange('A', 0, 6);  // A0..A5
const ADC_8CH = adcRange('A', 0, 8);  // A0..A7
const ADC_16CH = adcRange('A', 0, 16); // A0..A15

const ADC_PIN_MAP: Partial<Record<BoardKind, Array<{ pinName: string; channel: number }>>> = {
  // AVR boards
  'arduino-uno':  ADC_6CH,
  'arduino-nano': ADC_8CH,
  'arduino-mega': ADC_16CH,
  'attiny85':     adcRange('A', 0, 4), // A0..A3 (PB2-PB5)

  // RP2040 boards — 4 ADC channels (GP26-GP29)
  'raspberry-pi-pico': [
    { pinName: 'GP26', channel: 0 }, { pinName: 'GP27', channel: 1 },
    { pinName: 'GP28', channel: 2 }, { pinName: 'GP29', channel: 3 },
  ],
  'pi-pico-w': [
    { pinName: 'GP26', channel: 0 }, { pinName: 'GP27', channel: 1 },
    { pinName: 'GP28', channel: 2 }, { pinName: 'GP29', channel: 3 },
  ],

  // ESP32 variants — most GPIOs can be ADC but the common ones are:
  // ADC1: GPIO 32-39 (channels 0-7), ADC2: GPIO 0,2,4,12-15,25-27
  // Simplified to the 8 most-used pins (GPIO 32-39 = ADC1)
  'esp32':              adcRange('GPIO', 32, 8),
  'esp32-devkit-c-v4':  adcRange('GPIO', 32, 8),
  'esp32-cam':          adcRange('GPIO', 32, 8),
  'wemos-lolin32-lite': adcRange('GPIO', 32, 8),

  // ESP32-S3 — ADC1 channels on GPIO 1-10, ADC2 on GPIO 11-20
  'esp32-s3':           adcRange('GPIO', 1, 10),
  'xiao-esp32-s3':      adcRange('GPIO', 1, 10),
  'arduino-nano-esp32': adcRange('A', 0, 8),

  // ESP32-C3 — ADC1 channels on GPIO 0-4, ADC2 on GPIO 5
  'esp32-c3':                      adcRange('GPIO', 0, 6),
  'xiao-esp32-c3':                 adcRange('GPIO', 0, 6),
  'aitewinrobot-esp32c3-supermini': adcRange('GPIO', 0, 6),
};

/**
 * Convert an ADC pin name + channel to the GPIO pin number that
 * `setAdcVoltage()` (partUtils) expects, per board family.
 *
 *   AVR:   A0→14, A1→15, ... (analog pins start at 14)
 *   RP2040: GP26→26, GP27→27, ... (GPIO number directly)
 *   ESP32:  GPIO32→32, ... or A0→channel-dependent (GPIO number)
 */
function avrPinFromName(_name: string, channel: number): number { return 14 + channel; }
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function gpioPinFromName(name: string, _channel: number): number {
  const m = name.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : -1;
}

const ADC_PIN_TO_GPIO: Partial<Record<BoardKind, (pinName: string, channel: number) => number>> = {
  'arduino-uno':  avrPinFromName,
  'arduino-nano': avrPinFromName,
  'arduino-mega': avrPinFromName,
  'attiny85':     avrPinFromName,

  'raspberry-pi-pico': gpioPinFromName,
  'pi-pico-w':         gpioPinFromName,

  'esp32':              gpioPinFromName,
  'esp32-devkit-c-v4':  gpioPinFromName,
  'esp32-cam':          gpioPinFromName,
  'wemos-lolin32-lite': gpioPinFromName,
  'esp32-s3':           gpioPinFromName,
  'xiao-esp32-s3':      gpioPinFromName,
  'arduino-nano-esp32': avrPinFromName,  // uses A0-A7 naming
  'esp32-c3':                      gpioPinFromName,
  'xiao-esp32-c3':                 gpioPinFromName,
  'aitewinrobot-esp32c3-supermini': gpioPinFromName,
};

/**
 * Convert a board pin name (e.g. "9", "A0", "GP26", "GPIO32") to the
 * Arduino-style pin number that PinManager uses internally.
 * Returns -1 if the name doesn't map to a GPIO pin.
 */
function pinNameToArduinoPin(pinName: string, boardKind: BoardKind): number {
  const group = BOARD_PIN_GROUPS[boardKind] ?? BOARD_PIN_GROUPS.default;
  // Skip power/ground pins — they're handled as canonical nets
  if (group.gnd.includes(pinName) || group.vcc_pins.includes(pinName)) return -1;

  // RP2040: "GP26" → 26
  if (pinName.startsWith('GP')) {
    const n = parseInt(pinName.slice(2), 10);
    return Number.isFinite(n) ? n : -1;
  }
  // ESP32: "GPIO32" → 32
  if (pinName.startsWith('GPIO')) {
    const n = parseInt(pinName.slice(4), 10);
    return Number.isFinite(n) ? n : -1;
  }
  // AVR analog: "A0" → 14, "A1" → 15, ...
  if (/^A\d+$/.test(pinName)) {
    return 14 + parseInt(pinName.slice(1), 10);
  }
  // Bare numeric: "9" → 9, "13" → 13
  if (/^\d+$/.test(pinName)) {
    return parseInt(pinName, 10);
  }
  return -1;
}

/**
 * Collect MCU output pin states from PinManager for pins that participate
 * in the circuit (i.e., are referenced by wires).
 */
function collectPinStates(
  boardId: string,
  boardKind: BoardKind,
  wires: Array<{ start: { componentId: string; pinName: string }; end: { componentId: string; pinName: string } }>,
): Record<string, PinSourceState> {
  const pm = getBoardPinManager(boardId);
  if (!pm) return {};
  const group = BOARD_PIN_GROUPS[boardKind] ?? BOARD_PIN_GROUPS.default;
  const vcc = group.vcc;

  const result: Record<string, PinSourceState> = {};
  // Gather all pin names wired to this board
  const pinNames = new Set<string>();
  for (const w of wires) {
    if (w.start.componentId === boardId) pinNames.add(w.start.pinName);
    if (w.end.componentId === boardId) pinNames.add(w.end.pinName);
  }

  for (const pinName of pinNames) {
    const arduinoPin = pinNameToArduinoPin(pinName, boardKind);
    if (arduinoPin < 0) continue;
    const pwmDuty = pm.getPwmValue(arduinoPin);
    if (pwmDuty > 0) {
      result[pinName] = { type: 'pwm', duty: pwmDuty };
    } else if (pm.getPinState(arduinoPin)) {
      result[pinName] = { type: 'digital', v: vcc };
    }
    // If pin is LOW or unknown, don't add — treated as input/floating by SPICE
  }
  return result;
}

export function wireElectricalSolver(): () => void {

  // Cache the last solve input JSON to skip redundant solves.
  // This is critical: without it, the periodic timer floods the scheduler
  // with identical requests, delaying the result that carries updated
  // pin states (e.g. PWM) until after the simulation stops.
  let lastInputJson = '';

  function maybeSolve() {
    const storeState = useSimulatorStore.getState();
    const snap = {
      components: storeState.components,
      wires: storeState.wires,
      boards: storeState.boards.map((b) => ({
        id: b.id,
        boardKind: b.boardKind,
        pinStates: collectPinStates(b.id, b.boardKind, storeState.wires),
      })),
    };
    const input = buildInputFromStore(snap);

    // Deduplicate: skip if the input hasn't changed since the last solve.
    const inputJson = JSON.stringify(input);
    if (inputJson === lastInputJson) return;
    lastInputJson = inputJson;

    // pinNetMap is now built inside buildNetlist() from the same UF and
    // returned via CircuitScheduler → ElectricalSolveResult → store.
    useElectricalStore.getState().triggerSolve(input);
  }

  function injectVoltagesIntoADC() {
    const { nodeVoltages, pinNetMap } = useElectricalStore.getState();
    const { boards } = useSimulatorStore.getState();
    for (const board of boards) {
      const adcPins = ADC_PIN_MAP[board.boardKind];
      if (!adcPins) continue;
      const sim = getBoardSimulator(board.id);
      if (!sim) continue;
      const vMax = board.boardKind.startsWith('esp32') ? 3.3 : 5.0;
      for (const { pinName, channel } of adcPins) {
        const netName = pinNetMap.get(`${board.id}:${pinName}`);
        if (!netName) continue;
        const v = nodeVoltages[netName];
        if (v == null) continue;
        const clamped = Math.max(0, Math.min(vMax, v));
        const gpioPin = ADC_PIN_TO_GPIO[board.boardKind]?.(pinName, channel);
        if (gpioPin != null) setAdcVoltage(sim, gpioPin, clamped);
      }
    }
  }

  // Re-solve on components / wires changes.
  const unsubSim = useSimulatorStore.subscribe((state, prev) => {
    if (state.components !== prev.components || state.wires !== prev.wires) {
      maybeSolve();
    }
  });

  // On every solve result, re-inject ADC voltages.
  const unsubResult = useElectricalStore.subscribe((state, prev) => {
    if (state.nodeVoltages !== prev.nodeVoltages) {
      injectVoltagesIntoADC();
    }
  });

  // Re-inject whenever boards change (e.g. loadHex recreates AVRADC).
  // loadHex() creates a fresh AVRADC *before* updating the store, so by the
  // time this fires the new ADC already exists and needs the SPICE values.
  const unsubBoards = useSimulatorStore.subscribe((state, prev) => {
    if (state.boards !== prev.boards) {
      const { nodeVoltages } = useElectricalStore.getState();
      if (Object.keys(nodeVoltages).length > 0) {
        injectVoltagesIntoADC();
      }
    }
  });

  // Periodic re-solve while any board is running, so SPICE picks up
  // MCU pin-state changes (e.g. analogWrite → PWM → voltage source).
  let solveInterval: ReturnType<typeof setInterval> | null = null;
  const SOLVE_INTERVAL_MS = 200;

  function updateSolveTimer() {
    const anyRunning = useSimulatorStore.getState().boards.some((b) => b.running);
    if (anyRunning) {
      if (!solveInterval) {
        solveInterval = setInterval(maybeSolve, SOLVE_INTERVAL_MS);
      }
    } else if (solveInterval) {
      clearInterval(solveInterval);
      solveInterval = null;
    }
  }

  const unsubRunning = useSimulatorStore.subscribe((state, prev) => {
    const wasRunning = prev.boards.some((b) => b.running);
    const nowRunning = state.boards.some((b) => b.running);
    if (wasRunning !== nowRunning) updateSolveTimer();
  });

  return () => {
    unsubSim();
    unsubResult();
    unsubBoards();
    unsubRunning();
    if (solveInterval) clearInterval(solveInterval);
  };
}
