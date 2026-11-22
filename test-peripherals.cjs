const i2c = require('i2c-bus');
const Oled = require('oled-i2c-bus');
const font = require('oled-font-5x7');
const { MFRC522 } = require('node-red-contrib-raspi5-rc522/lib/mfrc522.js');
const { setTimeout: delay } = require('node:timers/promises');

const hex = (byte) => '0x' + byte.toString(16).padStart(2, '0');

async function test(name, run) {
  try {
    await run();
  } catch (error) {
    console.error(name + ' failed - ' + error.message);
    process.exitCode = 1;
  }
}

async function withI2c(run) {
  const bus = i2c.openSync(3);
  try {
    await run(bus);
  } finally {
    bus.closeSync();
  }
}

async function readUid(reader) {
  const uid = [];
  // ISO 14443-A cascade levels for 4-, 7-, and 10-byte UIDs.
  for (const level of [0x93, 0x95, 0x97]) {
    const part = await reader.transceive(Buffer.from([level, 0x20]));
    const bytes = part.data;
    if (bytes.length !== 5 || part.rxLastBits !== 0) return null;
    if ((bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3]) !== bytes[4]) return null;

    const select = Buffer.from([level, 0x70, ...bytes]);
    const crc = await reader.calcCrc(select);
    const response = await reader.transceive(Buffer.concat([select, crc]));
    if (response.data.length !== 3 || response.rxLastBits !== 0) return null;
    const more = (response.data[0] & 0x04) !== 0;
    if (more && bytes[0] !== 0x88) return null;

    uid.push(...bytes.subarray(more ? 1 : 0, 4));
    if (!more) return Buffer.from(uid).toString('hex').toUpperCase();
  }
  return null;
}

async function main() {
  await test('OLED', () => withI2c((bus) => {
    const oled = new Oled(bus, { width: 128, height: 64, address: 0x3c });
    oled.turnOnDisplay();
    oled.clearDisplay(false);
    oled.setCursor(10, 20);
    oled.writeString(font, 2, 'OLED OK', 1, false, true);
    console.log('OLED - look for OLED OK on the display');
  }));

  await test('MPU6050', () => withI2c(async (bus) => {
    const address = 0x68;
    const id = bus.readByteSync(address, 0x75);
    if (id !== 0x68) throw new Error('unexpected WHO_AM_I ' + hex(id));
    bus.writeByteSync(address, 0x6b, 0x00);
    await delay(100);

    console.log('MPU6050 - tilt it while the samples print');
    const data = Buffer.alloc(14);
    for (let sample = 0; sample < 3; sample++) {
      const count = bus.readI2cBlockSync(address, 0x3b, data.length, data);
      if (count !== data.length) throw new Error('short read');
      console.log({
        accelRaw: [0, 2, 4].map((offset) => data.readInt16BE(offset)),
        gyroRaw: [8, 10, 12].map((offset) => data.readInt16BE(offset)),
      });
      if (sample < 2) await delay(1000);
    }
  }));

  await test('RC522', async () => {
    const reader = new MFRC522({ bus: 1, device: 1, speedHz: 500_000 });
    reader.open();
    try {
      const version = await reader.readReg(0x37);
      if (version !== 0x91 && version !== 0x92) {
        throw new Error('unexpected version ' + hex(version));
      }
      console.log('RC522 OK - version ' + hex(version));
      if (!process.argv.includes('--uid')) return;

      await reader.init();
      console.log('Hold one card or key fob flat against the RC522 antenna');
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await reader.requestA()) {
          const uid = await readUid(reader);
          if (uid) {
            console.log('Card UID: ' + uid);
            return;
          }
        }
        await delay(100);
      }
      throw new Error('no card UID read within 30 seconds');
    } finally {
      reader.close();
    }
  });
}

main();
