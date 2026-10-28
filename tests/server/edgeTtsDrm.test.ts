/**
 * `Sec-MS-GEC` 令牌：**逐位对拍本机 `edge_tts/drm.py`**。
 *
 * 期望值不是我用 TS 算出来的，是用本机 python 包生成的（命令与输出见报告）：
 *   python3 -c "from edge_tts.drm import generate_sec_ms_gec_v2; \
 *     print(generate_sec_ms_gec_v2(1767225600.0))"
 *
 * 这组 golden 的意义：令牌是**协议事实**，不是密码学练习。谁把 `drm.py` 里那个改过的
 * SHA-256「优化」回标准 SHA-256，这里立刻红；线上则表现为握手 403。
 */
import { describe, expect, test } from "bun:test";
import {
  DRM_TABLES,
  generateSecMsGec,
  generateSecMsGec as reexportedToken,
  sha256Digest,
  sha256TokenStandard,
  tokenHash,
  tokenPayload,
} from "../../src/server/edgeTtsDrm.ts";

/** 6 个时间戳：边界 0 / 窗口起点前一秒 / 窗口起点 / 同窗口内 +300 / 两个常规时间 */
const GOLDEN: ReadonlyArray<readonly [number, string]> = [
  [0, "52BC7A17B50DFEC9-28C4394775C8751CD2F6859C030C06DB1489ACAB3B3A7651831FC26895177ED6"],
  [1767225599, "51E6B697CEBD13D7-EA2508760AB3BFDB0BBD30F65D80CF299642FA4018B40FB8F58C2946C2B080E7"],
  [1767225600, "723A6EBC411B23BB-214991EA6B1E401F3D777A699DDDEE75E29740EA7A5DCD1007366FA1090DD267"],
  [1767225900, "9CAC84B3EB149BCE-3B9C1E72659FFE57A42F9DC0AE026C5E0006449047F517F0E4C7254B51AF10EF"],
  [1700000000, "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2"],
  [1735689600, "54404AFE67C9B44A-E72E51D8B4F5F75E9A96B7E20D7877227455BC310433BD30C817CD54A1D9313E"],
];

describe("generateSecMsGec：与 drm.py 同输入同输出", () => {
  for (const [stamp, expected] of GOLDEN) {
    test(`unix=${stamp}`, () => {
      expect(generateSecMsGec(stamp)).toBe(expected);
    });
  }

  test("格式固定为 <16 hex>-<64 hex> 且全大写", () => {
    expect(generateSecMsGec(1767225600)).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
  });

  test("同一 5 分钟窗口内令牌相同；跨窗口就变（+300s 一定不同）", () => {
    const base = generateSecMsGec(1767225600);
    expect(generateSecMsGec(1767225600 + 1)).toBe(base);
    expect(generateSecMsGec(1767225600 + 299)).toBe(base);
    expect(generateSecMsGec(1767225600 - 1)).not.toBe(base);
    expect(generateSecMsGec(1767225600 + 300)).not.toBe(base);
  });

  test("默认导出同一个实现（`index.ts` 用的是它）", () => {
    expect(reexportedToken(1700000000)).toBe(GOLDEN[4]![1]);
  });
});

describe("令牌输入串：浮点顺序与 drm.py 一致（1.34e17 已超 2^53，换顺序就错）", () => {
  test("先加纪元差 → 取整 300s → ×1e7 → 拼 TRUSTED_CLIENT_TOKEN", () => {
    expect(tokenPayload(1767225600)).toBe("1341169920000000006A5AA1D4EAFF4E9FB37E23D68491D6F4");
    expect(tokenPayload(0)).toBe("1164447360000000006A5AA1D4EAFF4E9FB37E23D68491D6F4");
  });

  test("非整数秒向下取整到窗口（drm.py 的 `ticks % 300` 语义）", () => {
    expect(tokenPayload(1767225600.9)).toBe(tokenPayload(1767225600));
  });
});

describe("逐字对拍的底层实现（抄错一个常量就是 403）", () => {
  test("常量表来自 drm.py：初始状态 / 工作状态 / 调度表 / 轮常量 / CS64 系数", () => {
    expect(DRM_TABLES.initial).toEqual([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    expect(DRM_TABLES.state[0]).toBe(0xfd9fbea2);
    expect(DRM_TABLES.schedule[0]).toBe(0xeb24bf9e);
    // K[14] 在标准的 `_SHA256_BLOCK_CONSTANTS` 里被换成 0xC9DC06A7（源码的改法）
    expect(DRM_TABLES.round[14]).toBe(0x9bdc06a7);
    expect(DRM_TABLES.adjustment).toBe(0xc9dc06a7);
    expect(DRM_TABLES.sigma0Adjustment).toBe(0x059c0b80);
    expect(DRM_TABLES.sigma1Adjustment).toBe(0x000b92c0);
    expect(DRM_TABLES.cs64Factor).toBe(0x82893933);
    expect(DRM_TABLES.cs64Adjustment0).toBe(0xf2f90b1a);
    expect(DRM_TABLES.cs64Adjustment1).toBe(0x0b1a0000);
    expect(DRM_TABLES.cs64).toHaveLength(14);
    expect(DRM_TABLES.cs64[0]).toEqual([0xe82e91b1, 0xb32700d0]);
    expect(DRM_TABLES.round).toHaveLength(64);
  });

  test("变体 sha256 与 CS64：固定字节串的期望值来自 drm.py", () => {
    const bytes = new TextEncoder().encode("abc1234567890");
    const digest = sha256Digest(bytes);
    // python: _sha256_digest(b"abc1234567890").hex().upper()
    expect(Buffer.from(digest).toString("hex").toUpperCase()).toBe(
      "628C1EFF6487E0D2C944816DBD4093F7EFB0364CB94625CE6C14B1EE76DECCE0",
    );
    // python: struct.pack("<II", *_cs64_digest(b, _sha256_digest(b))).hex().upper()
    const { cs64, sha256 } = tokenHash(bytes);
    expect(cs64).toBe("49541D2DCFA682D3");
    expect(sha256).toBe("628C1EFF6487E0D2C944816DBD4093F7EFB0364CB94625CE6C14B1EE76DECCE0");
    expect(cs64).toHaveLength(16);
  });

  test("少于 7 字节直接拒（源码里的 `Token salt must contain at least seven bytes`）", () => {
    expect(() => sha256Digest(new TextEncoder().encode("short"))).toThrow();
  });
});

describe("与标准 SHA-256 的差异（这是协议事实，不是可优化项）", () => {
  test("同一时间戳：本机 drm.py 的令牌 ≠ 标准 SHA-256 令牌", () => {
    const shipped = generateSecMsGec(1767225600);
    const standard = sha256TokenStandard(1767225600);
    expect(standard).toMatch(/^[0-9A-F]{64}$/);
    expect(shipped).not.toBe(standard);
    // 记录在案：谁把实现「简化」成标准 SHA-256，这两个值就会相等 —— 那时线上是 403
    expect(standard).toBe("42D1947403FD94975436C65DBFCA8003073F9CB5C3F1CE25AF8961A11D7C3DFE");
    expect(shipped.split("-")[1]).toBe(
      "214991EA6B1E401F3D777A699DDDEE75E29740EA7A5DCD1007366FA1090DD267",
    );
  });
});
