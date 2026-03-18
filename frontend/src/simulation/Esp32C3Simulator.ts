/**
 * Esp32C3Simulator — Browser-side ESP32-C3 emulator.
 *
 * Wraps RiscVCore (RV32IMC) with:
 * - ESP32-C3 memory map: Flash IROM/DROM @ 0x42000000/0x3C000000,
 *   DRAM @ 0x3FC80000, IRAM @ 0x4037C000
 * - UART0 MMIO @ 0x60000000 (serial I/O)
 * - GPIO MMIO @ 0x60004000 (pin output via OUT/W1TS/W1TC registers)
 * - 160 MHz clock, requestAnimationFrame execution loop
 * - Same public interface as AVRSimulator / RiscVSimulator
 */

import { RiscVCore } from './RiscVCore';
import type { PinManager } from './PinManager';
import { hexToUint8Array } from '../utils/hexParser';
import { parseMergedFlashImage } from '../utils/esp32ImageParser';

// ── ESP32-C3 Memory Map ──────────────────────────────────────────────────────
const IROM_BASE = 0x42000000;   // Flash instruction region (mapped via MMU)
const DROM_BASE = 0x3C000000;   // Flash data region (read-only alias of same flash)
const DRAM_BASE = 0x3FC80000;   // Data RAM
const IRAM_BASE = 0x4037C000;   // Instruction RAM

const IROM_SIZE = 4 * 1024 * 1024;   // 4 MB flash buffer
const DRAM_SIZE = 384 * 1024;         // 384 KB DRAM
const IRAM_SIZE = 384 * 1024;         // 384 KB IRAM

// ── UART0 @ 0x60000000 ──────────────────────────────────────────────────────
const UART0_BASE   = 0x60000000;
const UART0_SIZE   = 0x400;
const UART0_FIFO   = 0x00;   // write TX byte / read RX byte
const UART0_STATUS = 0x1C;   // TXFIFO_CNT in bits [19:16] (0 = empty = ready)

// ── GPIO @ 0x60004000 ───────────────────────────────────────────────────────
const GPIO_BASE   = 0x60004000;
const GPIO_SIZE   = 0x200;
const GPIO_OUT    = 0x04;   // GPIO_OUT_REG   — output value (read/write)
const GPIO_W1TS   = 0x08;   // GPIO_OUT_W1TS  — set bits (write-only)
const GPIO_W1TC   = 0x0C;   // GPIO_OUT_W1TC  — clear bits (write-only)
const GPIO_IN     = 0x3C;   // GPIO_IN_REG    — input value (read-only)
const GPIO_ENABLE = 0x20;   // GPIO_ENABLE_REG

// ── SYSTIMER @ 0x60023000 ────────────────────────────────────────────────────
// The SYSTIMER runs at 16 MHz (CPU_HZ / 10).  FreeRTOS programs TARGET0 to
// fire every 1 ms (16 000 SYSTIMER ticks = 160 000 CPU cycles) and routes the
// alarm interrupt to CPU interrupt 1 via the interrupt matrix.
const SYSTIMER_BASE = 0x60023000;
const SYSTIMER_SIZE = 0x100;
// Register offsets (ESP32-C3 TRM)
const ST_INT_ENA       = 0x04;  // TARGET0/1/2 enable bits
const ST_INT_RAW       = 0x08;  // raw interrupt status
const ST_INT_CLR       = 0x0C;  // write-1-to-clear
const ST_INT_ST        = 0x10;  // masked status (RAW & ENA)
const ST_UNIT0_OP      = 0x14;  // write bit30 to snapshot counter
const ST_UNIT0_VAL_LO  = 0x54;  // snapshot value low 32 bits
const ST_UNIT0_VAL_HI  = 0x58;  // snapshot value high 32 bits

// ── SPI Flash Controllers ────────────────────────────────────────────────────
// SPI1 @ 0x60002000 — direct flash controller (boot-time flash access)
// SPI0 @ 0x60003000 — cache SPI controller (transparent flash cache)
// SPI_MEM_CMD_REG offset 0x00 bits [17–31] are "write 1 to start, HW clears when done".
const SPI1_BASE  = 0x60002000;
const SPI0_BASE  = 0x60003000;
const SPI_SIZE   = 0x200;
const SPI_CMD    = 0x00;   // SPI_MEM_CMD_REG — command trigger / status

// ── EXTMEM (cache controller) @ 0x600C4000 ──────────────────────────────────
// Manages ICache enable, invalidation, preload, and MMU configuration.
const EXTMEM_BASE = 0x600C4000;
const EXTMEM_SIZE = 0x1000;
// Key register offsets with "done" status bits that must read as 1:
const EXTMEM_ICACHE_SYNC_CTRL   = 0x28;  // bit1=SYNC_DONE
const EXTMEM_ICACHE_PRELOAD_CTRL = 0x34; // bit1=PRELOAD_DONE
const EXTMEM_ICACHE_AUTOLOAD_CTRL = 0x40; // bit3=AUTOLOAD_DONE
const EXTMEM_ICACHE_LOCK_CTRL   = 0x1C;  // bit2=LOCK_DONE

// ── Interrupt Controller (no-op passthrough) @ 0x600C5000 ───────────────────
// FreeRTOS configures source→CPU-int routing here; we handle routing ourselves.
const INTC_BASE = 0x600C5000;
const INTC_SIZE = 0x800;

// ── ESP32-C3 ROM stub @ 0x40000000 ──────────────────────────────────────────
// ROM lives at 0x40000000-0x4001FFFF.  Without a ROM image every ROM call
// fetches 0x0000 → CPU executes reserved C.ADDI4SPN and loops at 0x0.
// Stub: return C.JR ra (0x8082) so any ROM call immediately returns.
//   Little-endian: even byte = 0x82, odd byte = 0x80.
const ROM_BASE  = 0x40000000;
const ROM_SIZE  = 0x60000;   // 0x40000000-0x4005FFFF (first ROM + margin)
const ROM2_BASE = 0x40800000;
const ROM2_SIZE = 0x20000;   // 0x40800000-0x4081FFFF (second ROM region)

// ── Clock ───────────────────────────────────────────────────────────────────
const CPU_HZ = 160_000_000;
const CYCLES_PER_FRAME = Math.round(CPU_HZ / 60);
/** CPU cycles per FreeRTOS tick (1 ms at 160 MHz). */
const CYCLES_PER_TICK  = 160_000;

export class Esp32C3Simulator {
  private core: RiscVCore;
  private flash: Uint8Array;
  private dram: Uint8Array;
  private iram: Uint8Array;
  private running = false;
  private animFrameId = 0;
  private rxFifo: number[] = [];
  private gpioOut = 0;
  private gpioIn  = 0;

  // SYSTIMER emulation state
  private _stIntEna = 0;  // ST_INT_ENA register
  private _stIntRaw = 0;  // ST_INT_RAW register (bit0 = TARGET0 fired)

  /**
   * Shared peripheral register file — echo-back map.
   * Peripheral MMIO writes that aren't handled by specific logic are stored
   * here keyed by word-aligned address so that subsequent reads return the
   * last written value.  This makes common "write → read-back → verify"
   * patterns in the ESP-IDF boot succeed without dedicated stubs.
   */
  private _periRegs = new Map<number, number>();

  // ── Diagnostic state ─────────────────────────────────────────────────────
  private _dbgFrameCount = 0;
  private _dbgTickCount  = 0;
  private _dbgLastMtvec  = 0;
  private _dbgMieEnabled = false;
  /** Track PC at the start of each tick for stuck-loop detection. */
  private _dbgPrevTickPc = -1;
  private _dbgSamePcCount = 0;
  private _dbgStuckDumped = false;

  public pinManager: PinManager;
  public onSerialData: ((ch: string) => void) | null = null;
  public onBaudRateChange: ((baud: number) => void) | null = null;
  public onPinChangeWithTime: ((pin: number, state: boolean, timeMs: number) => void) | null = null;

  constructor(pinManager: PinManager) {
    this.pinManager = pinManager;

    // Flash is the primary (fast-path) memory region
    this.flash = new Uint8Array(IROM_SIZE);
    this.dram  = new Uint8Array(DRAM_SIZE);
    this.iram  = new Uint8Array(IRAM_SIZE);

    this.core = new RiscVCore(this.flash, IROM_BASE);

    // DROM — read-only alias of the same flash buffer at a different virtual address
    const flash = this.flash;
    this.core.addMmio(DROM_BASE, IROM_SIZE,
      (addr) => flash[addr - DROM_BASE] ?? 0,
      () => {},
    );

    // DRAM (384 KB)
    const dram = this.dram;
    this.core.addMmio(DRAM_BASE, DRAM_SIZE,
      (addr) => dram[addr - DRAM_BASE],
      (addr, val) => { dram[addr - DRAM_BASE] = val; },
    );

    // IRAM (384 KB)
    const iram = this.iram;
    this.core.addMmio(IRAM_BASE, IRAM_SIZE,
      (addr) => iram[addr - IRAM_BASE],
      (addr, val) => { iram[addr - IRAM_BASE] = val; },
    );

    // Broad catch-all for all peripheral space must be registered FIRST (largest
    // region) so that narrower, more specific handlers registered afterwards win
    // via mmioFor's "smallest size wins" rule.
    this._registerPeripheralCatchAll();
    this._registerUart0();
    this._registerGpio();
    this._registerSysTimer();
    this._registerIntCtrl();
    this._registerRtcCntl();
    // Timer Groups — stub RTCCALICFG1.cal_done for all known base addresses
    // so rtc_clk_cal_internal() poll loop exits immediately.
    this._registerTimerGroup(0x60026000);  // TIMG0 (ESP-IDF v5 / arduino-esp32 3.x)
    this._registerTimerGroup(0x60027000);  // TIMG1
    this._registerTimerGroup(0x6001F000);  // TIMG0 alternative (older ESP-IDF)
    this._registerTimerGroup(0x60020000);  // TIMG1 alternative
    this._registerSpiFlash(SPI1_BASE);   // SPI1 — direct flash controller
    this._registerSpiFlash(SPI0_BASE);   // SPI0 — cache SPI controller
    this._registerExtMem();
    this._registerRomStub();
    this._registerRomStub2();

    this.core.reset(IROM_BASE);
    // Initialize SP to top of DRAM — MUST be after reset() which zeroes all regs
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;
  }

  // ── MMIO registration ──────────────────────────────────────────────────────

  private _registerUart0(): void {
    this.core.addMmio(UART0_BASE, UART0_SIZE,
      (addr) => {
        const off = addr - UART0_BASE;
        if (off === UART0_FIFO)   return this.rxFifo.length > 0 ? (this.rxFifo.shift()! & 0xFF) : 0;
        if (off === UART0_STATUS) return 0;  // TXFIFO always empty = ready to accept data
        return 0;
      },
      (addr, val) => {
        if (addr - UART0_BASE === UART0_FIFO) {
          this.onSerialData?.(String.fromCharCode(val & 0xFF));
        }
      },
    );
  }

  private _registerGpio(): void {
    this.core.addMmio(GPIO_BASE, GPIO_SIZE,
      (addr) => {
        const off = (addr - GPIO_BASE) & ~3;  // word-align for register lookup
        const byteIdx = (addr - GPIO_BASE) & 3;
        if (off === GPIO_OUT)    return (this.gpioOut >> (byteIdx * 8)) & 0xFF;
        if (off === GPIO_IN)     return (this.gpioIn  >> (byteIdx * 8)) & 0xFF;
        if (off === GPIO_ENABLE) return 0xFF;
        return 0;
      },
      (addr, val) => {
        const off      = (addr - GPIO_BASE) & ~3;
        const byteIdx  = (addr - GPIO_BASE) & 3;
        const shift    = byteIdx * 8;
        const byteMask = 0xFF << shift;
        const prev     = this.gpioOut;

        if (off === GPIO_W1TS) {
          // Set bits — each byte write sets corresponding bits
          this.gpioOut |= (val & 0xFF) << shift;
        } else if (off === GPIO_W1TC) {
          // Clear bits
          this.gpioOut &= ~((val & 0xFF) << shift);
        } else if (off === GPIO_OUT) {
          // Direct write — reconstruct 32-bit value byte by byte
          this.gpioOut = (this.gpioOut & ~byteMask) | ((val & 0xFF) << shift);
        }

        const changed = prev ^ this.gpioOut;
        if (changed) {
          const timeMs = (this.core.cycles / CPU_HZ) * 1000;
          for (let bit = 0; bit < 22; bit++) {   // ESP32-C3 has GPIO0–GPIO21
            if (changed & (1 << bit)) {
              const state = !!(this.gpioOut & (1 << bit));
              console.log(`[ESP32-C3] GPIO${bit} → ${state ? 'HIGH' : 'LOW'} @ ${timeMs.toFixed(1)}ms`);
              this.onPinChangeWithTime?.(bit, state, timeMs);
              this.pinManager.setPinState(bit, state);
            }
          }
        }
      },
    );
  }

  private _registerSysTimer(): void {
    const peri = this._periRegs;
    this.core.addMmio(SYSTIMER_BASE, SYSTIMER_SIZE,
      (addr) => {
        const off      = addr - SYSTIMER_BASE;
        const wordOff  = off & ~3;
        const byteIdx  = off &  3;
        let word = 0;
        let handled = true;
        switch (wordOff) {
          case ST_INT_ENA:      word = this._stIntEna; break;
          case ST_INT_RAW:      word = this._stIntRaw; break;
          case ST_INT_ST:       word = this._stIntRaw & this._stIntEna; break;
          case ST_UNIT0_OP:     word = (1 << 29); break;  // VALID bit always set
          case ST_UNIT0_VAL_LO: word = (this.core.cycles / 10) >>> 0; break;
          case ST_UNIT0_VAL_HI: word = 0; break;
          default:              handled = false; break;
        }
        if (!handled) {
          // Echo last written value for unknown offsets
          const wordAddr = addr & ~3;
          word = peri.get(wordAddr) ?? 0;
        }
        return (word >> (byteIdx * 8)) & 0xFF;
      },
      (addr, val) => {
        const off     = addr - SYSTIMER_BASE;
        const wordOff = off & ~3;
        const shift   = (off & 3) * 8;
        switch (wordOff) {
          case ST_INT_ENA:
            this._stIntEna = (this._stIntEna & ~(0xFF << shift)) | ((val & 0xFF) << shift);
            break;
          case ST_INT_CLR:
            this._stIntRaw &= ~((val & 0xFF) << shift);
            break;
          default: {
            // Echo-back: store the written value
            const wordAddr = addr & ~3;
            const prev = peri.get(wordAddr) ?? 0;
            peri.set(wordAddr, (prev & ~(0xFF << shift)) | ((val & 0xFF) << shift));
            break;
          }
        }
      },
    );
  }

  /** Interrupt-controller MMIO — FreeRTOS writes source→CPU-int routing here.
   *  We handle routing via direct triggerInterrupt() calls; unknown offsets
   *  echo back the last written value so that read-back verification succeeds. */
  private _registerIntCtrl(): void {
    const peri = this._periRegs;
    this.core.addMmio(INTC_BASE, INTC_SIZE,
      (addr) => {
        const wordAddr = addr & ~3;
        const word = peri.get(wordAddr) ?? 0;
        return (word >>> ((addr & 3) * 8)) & 0xFF;
      },
      (addr, val) => {
        const wordAddr = addr & ~3;
        const prev = peri.get(wordAddr) ?? 0;
        const shift = (addr & 3) * 8;
        peri.set(wordAddr, (prev & ~(0xFF << shift)) | ((val & 0xFF) << shift));
      },
    );
  }

  /**
   * ROM stub — makes calls into ESP32-C3 ROM (0x40000000-0x4005FFFF) return
   * immediately.  Without a ROM image the CPU would fetch 0x00 bytes and loop
   * forever at address 0.  We stub every 16-bit slot with C.JR ra (0x8082)
   * so every ROM call acts as a no-op and returns to the call site.
   */
  private _registerRomStub(): void {
    this.core.addMmio(ROM_BASE, ROM_SIZE,
      // C.JR ra = 0x8082, little-endian: even byte=0x82, odd byte=0x80
      (addr) => (addr & 1) === 0 ? 0x82 : 0x80,
      (_addr, _val) => {},
    );
  }

  /** Second ROM region (0x40800000) — same stub. */
  private _registerRomStub2(): void {
    this.core.addMmio(ROM2_BASE, ROM2_SIZE,
      (addr) => (addr & 1) === 0 ? 0x82 : 0x80,
      (_addr, _val) => {},
    );
  }

  /**
   * Timer Group stub (TIMG0 / TIMG1).
   *
   * Critical register: RTCCALICFG1 at offset 0x6C (confirmed from qemu-lcgamboa
   * esp32c3_timg.h — offset 0x48 is TIMG_WDTCONFIG0, not the calibration result).
   *   Bit 31 = TIMG_RTC_CALI_DONE — must read as 1 or rtc_clk_cal_internal()
   *   spins forever waiting for calibration to complete.
   *   Bits [30:7] = cal_value — must be non-zero or the outer retry loop
   *   in esp_rtc_clk_init() keeps calling rtc_clk_cal() forever.
   *
   * Called for all known TIMG0/TIMG1 base addresses across ESP-IDF versions.
   */
  private _registerTimerGroup(base: number): void {
    const seen = new Set<number>();
    const peri = this._periRegs;
    this.core.addMmio(base, 0x100,
      (addr) => {
        const off  = addr - base;
        const wOff = off & ~3;
        if (!seen.has(wOff)) {
          seen.add(wOff);
          console.log(`[TIMG@0x${base.toString(16)}] 1st read wOff=0x${wOff.toString(16)} pc=0x${this.core.pc.toString(16)}`);
        }
        if (wOff === 0x68) {
          // TIMG_RTCCALICFG: bit15=TIMG_RTC_CALI_RDY=1 — calibration instantly done
          const word = (1 << 15); // 0x00008000
          return (word >>> ((off & 3) * 8)) & 0xFF;
        }
        if (wOff === 0x6C) {
          // TIMG_RTCCALICFG1: bits[31:7]=rtc_cali_value — non-zero so outer retry exits
          const word = (1000000 << 7); // 0x07A12000
          return (word >>> ((off & 3) * 8)) & 0xFF;
        }
        // Echo last written value for all other offsets
        const wordAddr = addr & ~3;
        const word = peri.get(wordAddr) ?? 0;
        return (word >>> ((addr & 3) * 8)) & 0xFF;
      },
      (addr, val) => {
        const wordAddr = addr & ~3;
        const prev = peri.get(wordAddr) ?? 0;
        const shift = (addr & 3) * 8;
        peri.set(wordAddr, (prev & ~(0xFF << shift)) | ((val & 0xFF) << shift));
      },
    );
  }

  /**
   * SPI flash controller stub (SPI0 / SPI1).
   *
   * SPI_MEM_CMD_REG (offset 0x00) bits [17–31] are "write 1 to start operation,
   * hardware clears when done".  The firmware polls these bits after triggering
   * flash reads, writes, erases, etc.  We auto‑clear them so every flash
   * operation appears to complete instantly.
   *
   * Other registers use echo‑back so configuration writes can be read back.
   */
  private _registerSpiFlash(base: number): void {
    const peri = this._periRegs;
    this.core.addMmio(base, SPI_SIZE,
      (addr) => {
        const off     = addr - base;
        const wordOff = off & ~3;
        if (wordOff === SPI_CMD) {
          // Always return 0 for CMD register — all operations are "done"
          return 0;
        }
        // Echo last written value for all other offsets
        const wordAddr = addr & ~3;
        const word = peri.get(wordAddr) ?? 0;
        return (word >>> ((addr & 3) * 8)) & 0xFF;
      },
      (addr, val) => {
        const wordAddr = addr & ~3;
        const prev = peri.get(wordAddr) ?? 0;
        const shift = (addr & 3) * 8;
        peri.set(wordAddr, (prev & ~(0xFF << shift)) | ((val & 0xFF) << shift));
      },
    );
  }

  /**
   * EXTMEM cache controller stub (0x600C4000).
   *
   * The ESP-IDF boot enables ICache, then triggers cache invalidation / sync /
   * preload operations and polls "done" bits.  We return all "done" bits as 1
   * so these operations appear to complete instantly.
   */
  private _registerExtMem(): void {
    const peri = this._periRegs;
    this.core.addMmio(EXTMEM_BASE, EXTMEM_SIZE,
      (addr) => {
        const off     = addr - EXTMEM_BASE;
        const wordOff = off & ~3;
        // Return "done" bits for operations that the boot polls:
        let override: number | null = null;
        switch (wordOff) {
          case EXTMEM_ICACHE_SYNC_CTRL:    override = (1 << 1); break; // SYNC_DONE
          case EXTMEM_ICACHE_PRELOAD_CTRL: override = (1 << 1); break; // PRELOAD_DONE
          case EXTMEM_ICACHE_AUTOLOAD_CTRL: override = (1 << 3); break; // AUTOLOAD_DONE
          case EXTMEM_ICACHE_LOCK_CTRL:    override = (1 << 2); break; // LOCK_DONE
        }
        if (override !== null) {
          // Merge override bits with any written value so enable bits are preserved
          const wordAddr = addr & ~3;
          const word = (peri.get(wordAddr) ?? 0) | override;
          return (word >>> ((addr & 3) * 8)) & 0xFF;
        }
        // Echo last written value for all other offsets
        const wordAddr = addr & ~3;
        const word = peri.get(wordAddr) ?? 0;
        return (word >>> ((addr & 3) * 8)) & 0xFF;
      },
      (addr, val) => {
        const wordAddr = addr & ~3;
        const prev = peri.get(wordAddr) ?? 0;
        const shift = (addr & 3) * 8;
        peri.set(wordAddr, (prev & ~(0xFF << shift)) | ((val & 0xFF) << shift));
      },
    );
  }

  /**
   * Broad catch-all for the entire ESP32-C3 peripheral address space
   * (0x60000000–0x6FFFFFFF).
   *
   * Writes are stored in _periRegs so that the firmware's common
   * "write config → read back → verify" pattern works for any peripheral
   * register we haven't stubbed explicitly.  All narrower, more specific
   * handlers (UART0, GPIO, SYSTIMER, INTC, RTC_CNTL …) have smaller MMIO
   * sizes and therefore take priority via mmioFor's "smallest-size-wins" rule.
   */
  private _registerPeripheralCatchAll(): void {
    const peri = this._periRegs;
    this.core.addMmio(0x60000000, 0x10000000,
      (addr) => {
        const wordAddr = addr & ~3;
        const word = peri.get(wordAddr) ?? 0;
        return (word >>> ((addr & 3) * 8)) & 0xFF;
      },
      (addr, val) => {
        const wordAddr = addr & ~3;
        const prev = peri.get(wordAddr) ?? 0;
        const shift = (addr & 3) * 8;
        peri.set(wordAddr, (prev & ~(0xFF << shift)) | ((val & 0xFF) << shift));
      },
    );
  }

  /**
   * RTC_CNTL peripheral stub (0x60008000, 4 KB).
   *
   * Critical register: TIME_UPDATE_REG at offset 0x70 (address 0x60008070).
   *   Bit 30 = TIME_VALID — must read as 1 or the `rtc_clk_cal()` loop in
   *   esp-idf never exits and MIE is never enabled (FreeRTOS scheduler stalls).
   * Also covers the eFUSE block at 0x60008800 (offset 0x800) — returns 0 for
   * all eFuse words (chip-revision 0 / all features disabled = safe defaults).
   */
  private _registerRtcCntl(): void {
    const RTC_BASE = 0x60008000;
    const peri = this._periRegs;
    this.core.addMmio(RTC_BASE, 0x1000,
      (addr) => {
        const off     = addr - RTC_BASE;
        const wordOff = off & ~3;
        // offset 0x70 (RTC_CLK_CONF): TIME_VALID (bit 30) = 1 so rtc_clk_cal() exits.
        // offset 0x38 (RESET_STATE): return 1 = ESP32C3_POWERON_RESET (matches QEMU).
        if (wordOff === 0x70) {
          const word = (1 << 30);
          return (word >>> ((off & 3) * 8)) & 0xFF;
        }
        if (wordOff === 0x38) {
          return off === (wordOff) ? 1 : 0;  // byte 0 = 1, rest = 0
        }
        // Echo last written value for all other offsets
        const wordAddr = addr & ~3;
        const word = peri.get(wordAddr) ?? 0;
        return (word >>> ((addr & 3) * 8)) & 0xFF;
      },
      (addr, val) => {
        const wordAddr = addr & ~3;
        const prev = peri.get(wordAddr) ?? 0;
        const shift = (addr & 3) * 8;
        peri.set(wordAddr, (prev & ~(0xFF << shift)) | ((val & 0xFF) << shift));
      },
    );
  }

  // ── HEX loading ────────────────────────────────────────────────────────────

  /**
   * Load an Intel HEX file. The hex addresses must be relative to IROM_BASE
   * (0x42000000), or zero-based (the parser will treat them as flash offsets).
   */
  loadHex(hexContent: string): void {
    this.flash.fill(0);
    const bytes = hexToUint8Array(hexContent);

    // hexToUint8Array returns bytes indexed from address 0.
    // If the hex records used IROM_BASE-relative addressing, the byte array
    // will start at offset IROM_BASE within a huge buffer — we can't use that.
    // Support both:
    //   a) Small array (< IROM_SIZE) → direct flash offset mapping
    //   b) Large array → slice from IROM_BASE offset if present
    if (bytes.length <= IROM_SIZE) {
      const maxCopy = Math.min(bytes.length, IROM_SIZE);
      this.flash.set(bytes.subarray(0, maxCopy), 0);
    } else {
      // Try to extract data at IROM_BASE offset
      const iromOffset = IROM_BASE;
      if (bytes.length > iromOffset) {
        const maxCopy = Math.min(bytes.length - iromOffset, IROM_SIZE);
        this.flash.set(bytes.subarray(iromOffset, iromOffset + maxCopy), 0);
      }
    }

    this.dram.fill(0);
    this.iram.fill(0);
    this.core.reset(IROM_BASE);
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;
  }

  /**
   * Load a raw binary image into flash at offset 0 (maps to IROM_BASE 0x42000000).
   * Use this with binaries produced by:
   *   riscv32-esp-elf-objcopy -O binary firmware.elf firmware.bin
   */
  loadBin(bin: Uint8Array): void {
    this.flash.fill(0);
    const maxCopy = Math.min(bin.length, IROM_SIZE);
    this.flash.set(bin.subarray(0, maxCopy), 0);
    this.dram.fill(0);
    this.iram.fill(0);
    this.rxFifo  = [];
    this.gpioOut = 0;
    this.gpioIn  = 0;
    this._periRegs.clear();
    this.core.reset(IROM_BASE);
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;
  }

  /**
   * Load a merged ESP32 flash image from the backend (base64-encoded).
   *
   * The backend produces a 4 MB merged image:
   *   0x01000 — bootloader
   *   0x08000 — partition table
   *   0x10000 — application (ESP32 image format with segment headers)
   *
   * Each image segment is loaded at its virtual load address:
   *   IROM (0x42xxxxxx) → flash buffer  (executed code)
   *   DROM (0x3Cxxxxxx) → flash buffer  (read-only data alias)
   *   DRAM (0x3FCxxxxx) → dram buffer   (initialised .data)
   *   IRAM (0x4037xxxx) → iram buffer   (ISR / time-critical code)
   *
   * The CPU resets to the entry point declared in the image header.
   */
  loadFlashImage(base64: string): void {
    // Base64 decode
    const binStr = atob(base64);
    const data = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) data[i] = binStr.charCodeAt(i);

    // Parse ESP32 image format
    const parsed = parseMergedFlashImage(data);

    // Clear all memory regions
    this.flash.fill(0);
    this.dram.fill(0);
    this.iram.fill(0);
    this.rxFifo  = [];
    this.gpioOut = 0;
    this.gpioIn  = 0;
    this._periRegs.clear();

    // Load each segment at its virtual address
    for (const { loadAddr, data: seg } of parsed.segments) {
      const uAddr = loadAddr >>> 0;

      if (uAddr >= IROM_BASE && uAddr + seg.length <= IROM_BASE + IROM_SIZE) {
        this.flash.set(seg, uAddr - IROM_BASE);
      } else if (uAddr >= DROM_BASE && uAddr + seg.length <= DROM_BASE + IROM_SIZE) {
        // DROM is a virtual alias of flash — store at same flash buffer
        this.flash.set(seg, uAddr - DROM_BASE);
      } else if (uAddr >= DRAM_BASE && uAddr + seg.length <= DRAM_BASE + DRAM_SIZE) {
        this.dram.set(seg, uAddr - DRAM_BASE);
      } else if (uAddr >= IRAM_BASE && uAddr + seg.length <= IRAM_BASE + IRAM_SIZE) {
        this.iram.set(seg, uAddr - IRAM_BASE);
      } else {
        console.warn(
          `[Esp32C3Simulator] Segment 0x${uAddr.toString(16)}` +
          ` (${seg.length} B) outside known regions — skipped`
        );
      }
    }

    // Boot CPU at image entry point
    this.core.reset(parsed.entryPoint);
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;

    console.log(
      `[Esp32C3Simulator] Loaded ${parsed.segments.length} segments,` +
      ` entry=0x${parsed.entryPoint.toString(16)}`
    );
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;
    this._dbgFrameCount = 0;
    this._dbgTickCount  = 0;
    this._dbgLastMtvec  = 0;
    this._dbgMieEnabled = false;
    console.log(`[ESP32-C3] Simulation started, entry=0x${this.core.pc.toString(16)}`);
    this.running = true;
    this._loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.animFrameId);
  }

  reset(): void {
    this.stop();
    this.rxFifo         = [];
    this.gpioOut        = 0;
    this.gpioIn         = 0;
    this._stIntEna      = 0;
    this._stIntRaw      = 0;
    this._periRegs.clear();
    this._dbgFrameCount = 0;
    this._dbgTickCount  = 0;
    this._dbgLastMtvec  = 0;
    this._dbgMieEnabled = false;
    this.dram.fill(0);
    this.iram.fill(0);
    this.core.reset(IROM_BASE);
    this.core.regs[2] = (DRAM_BASE + DRAM_SIZE - 16) | 0;
  }

  serialWrite(text: string): void {
    for (let i = 0; i < text.length; i++) {
      this.rxFifo.push(text.charCodeAt(i));
    }
  }

  setPinState(pin: number, state: boolean): void {
    if (state) this.gpioIn |=  (1 << pin);
    else        this.gpioIn &= ~(1 << pin);
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Execution loop ─────────────────────────────────────────────────────────

  private _loop(): void {
    if (!this.running) return;

    this._dbgFrameCount++;

    // ── Per-frame diagnostics (check once, before heavy execution) ─────────
    // Detect mtvec being set — FreeRTOS writes this during startup.
    const mtvec = this.core.mtvecVal;
    if (mtvec !== this._dbgLastMtvec) {
      if (mtvec !== 0) {
        console.log(
          `[ESP32-C3] mtvec set → 0x${mtvec.toString(16)}` +
          ` (mode=${mtvec & 3}) @ frame ${this._dbgFrameCount}`
        );
      }
      this._dbgLastMtvec = mtvec;
    }

    // Detect MIE 0→1 transition — FreeRTOS enables this when scheduler starts.
    const mie = (this.core.mstatusVal & 0x8) !== 0;
    if (mie && !this._dbgMieEnabled) {
      console.log(
        `[ESP32-C3] MIE enabled (interrupts ON) @ frame ${this._dbgFrameCount}` +
        `, pc=0x${this.core.pc.toString(16)}`
      );
      this._dbgMieEnabled = true;
    }

    // Log PC + key state every ~1 second (60 frames).
    if (this._dbgFrameCount % 60 === 0) {
      console.log(
        `[ESP32-C3] frame=${this._dbgFrameCount}` +
        ` pc=0x${this.core.pc.toString(16)}` +
        ` cycles=${this.core.cycles}` +
        ` ticks=${this._dbgTickCount}` +
        ` mtvec=0x${mtvec.toString(16)}` +
        ` MIE=${mie}` +
        ` GPIO=0x${this.gpioOut.toString(16)}`
      );
    }

    // Execute in 1 ms chunks so FreeRTOS tick interrupts fire at ~1 kHz.
    let rem = CYCLES_PER_FRAME;
    while (rem > 0) {
      const n = rem < CYCLES_PER_TICK ? rem : CYCLES_PER_TICK;
      for (let i = 0; i < n; i++) {
        this.core.step();
      }
      rem -= n;

      this._dbgTickCount++;
      // Log every 100 ticks (0.1 s) while still early in boot.
      if (this._dbgTickCount <= 1000 && this._dbgTickCount % 100 === 0) {
        const spc = this.core.pc;
        let instrInfo = '';
        const iramOff = spc - IRAM_BASE;
        const flashOff = spc - IROM_BASE;
        let ib0 = 0, ib1 = 0, ib2 = 0, ib3 = 0;
        if (iramOff >= 0 && iramOff + 4 <= this.iram.length) {
          [ib0, ib1, ib2, ib3] = [this.iram[iramOff], this.iram[iramOff+1], this.iram[iramOff+2], this.iram[iramOff+3]];
        } else if (flashOff >= 0 && flashOff + 4 <= this.flash.length) {
          [ib0, ib1, ib2, ib3] = [this.flash[flashOff], this.flash[flashOff+1], this.flash[flashOff+2], this.flash[flashOff+3]];
        }
        const instr16 = ib0 | (ib1 << 8);
        const instr32 = ((ib0 | (ib1<<8) | (ib2<<16) | (ib3<<24)) >>> 0);
        const isC = (instr16 & 3) !== 3;
        const hex = isC ? instr16.toString(16).padStart(4,'0') : instr32.toString(16).padStart(8,'0');
        if (!isC) {
          const op = instr32 & 0x7F;
          const f3 = (instr32 >> 12) & 7;
          const rs1 = (instr32 >> 15) & 31;
          if (op === 0x73) {
            const csr = (instr32 >> 20) & 0xFFF;
            instrInfo = ` [SYSTEM csr=0x${csr.toString(16)} f3=${f3}]`;
          } else if (op === 0x03) {
            const imm = (instr32 >> 20) << 0 >> 0;
            instrInfo = ` [LOAD x${rs1}+${imm} f3=${f3}]`;
          } else if (op === 0x63) {
            instrInfo = ` [BRANCH f3=${f3}]`;
          } else if (op === 0x23) {
            instrInfo = ` [STORE f3=${f3}]`;
          }
        }
        console.log(
          `[ESP32-C3] tick #${this._dbgTickCount}` +
          ` pc=0x${spc.toString(16)} instr=0x${hex}${instrInfo}` +
          ` MIE=${(this.core.mstatusVal & 0x8) !== 0}`
        );
      }

      // ── Stuck-loop detector ────────────────────────────────────────────
      // If the PC hasn't changed across consecutive ticks (160 000 cycles),
      // the CPU is stuck in a tight spin.  Dump all registers once for
      // post-mortem analysis so we can identify which peripheral or stub
      // needs attention.
      {
        const curPc = this.core.pc;
        if (curPc === this._dbgPrevTickPc) {
          this._dbgSamePcCount++;
          if (this._dbgSamePcCount >= 3 && !this._dbgStuckDumped) {
            this._dbgStuckDumped = true;
            console.warn(
              `[ESP32-C3] ⚠ CPU stuck at pc=0x${curPc.toString(16)} for ${this._dbgSamePcCount} ticks — register dump:`
            );
            const regNames = [
              'zero','ra','sp','gp','tp','t0','t1','t2',
              's0','s1','a0','a1','a2','a3','a4','a5',
              'a6','a7','s2','s3','s4','s5','s6','s7',
              's8','s9','s10','s11','t3','t4','t5','t6',
            ];
            for (let i = 0; i < 32; i++) {
              console.warn(`  x${i.toString().padStart(2)}(${regNames[i].padEnd(4)}) = 0x${(this.core.regs[i] >>> 0).toString(16).padStart(8, '0')}`);
            }
            console.warn(`  mstatus=0x${(this.core.mstatusVal >>> 0).toString(16)} mtvec=0x${(this.core.mtvecVal >>> 0).toString(16)}`);
          }
        } else {
          this._dbgSamePcCount = 0;
          this._dbgStuckDumped = false;
        }
        this._dbgPrevTickPc = curPc;
      }

      // Raise SYSTIMER TARGET0 alarm → CPU interrupt 1 (FreeRTOS tick).
      this._stIntRaw |= 1;
      this.core.triggerInterrupt(0x80000001);
    }

    this.animFrameId = requestAnimationFrame(() => this._loop());
  }
}
