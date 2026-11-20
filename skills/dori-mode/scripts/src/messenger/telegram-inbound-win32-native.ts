import { MessengerError } from "./http.ts";
import { loadWindowsCursorFfi, requireNative, sidOffset, wide, winCursorError } from "./telegram-inbound-win32-ffi.ts";

export const winFile = {
  read: 0x80000000,
  write: 0x40000000,
  control: 0x20000,
  delete: 0x10000,
  sync: 0x100000,
  traverse: 0x20,
  attributes: 0x80,
  open: 1,
  create: 2,
  openOrCreate: 3,
  shareRead: 1,
  shareWrite: 2,
  shareDelete: 4,
  allAccess: 0x1f01ff,
} as const;

type Open = {
  readonly root: bigint;
  readonly name: string;
  readonly access: number;
  readonly share: number;
  readonly disposition?: number;
  readonly directory?: true;
  readonly descriptor?: Buffer;
  readonly writeThrough?: true;
};

const unsigned = (n: number) => n >>> 0;
const basenameOnly = (name: string) => name.length > 0 && name !== "." && name !== ".." && !/[\\/:]/.test(name);

const loadNative = () => {
  const { ffi, kernel, security, nt } = loadWindowsCursorFfi();
  const info = (handle: bigint, type: number, size: number) => {
    const out = Buffer.alloc(size);
    requireNative(kernel.GetFileInformationByHandleEx(handle, type, out, size) !== 0, "file metadata is unavailable");
    return out;
  };
  const tokenUser = (handle: bigint) => {
    const out = Buffer.from(new ArrayBuffer(128));
    const length = Buffer.alloc(4);
    // Pass the explicit Bun pointer and use that very address to interpret the returned PSID.
    const address = ffi.ptr(out.buffer);
    requireNative(Number.isSafeInteger(address) && address > 0, "TOKEN_USER buffer address is invalid");
    const ok = security.GetTokenInformation(handle, 1, address, out.length, ffi.ptr(length));
    requireNative(ok !== 0, "user SID is unavailable");
    const written = length.readUInt32LE();
    return sid(out.subarray(0, written), sidOffset(out, BigInt(address), written));
  };
  return {
    close: (handle: bigint) => {
      requireNative(kernel.CloseHandle(handle) !== 0, "handle could not be closed");
    },
    user() {
      const result = Buffer.alloc(8);
      requireNative(security.OpenProcessToken(kernel.GetCurrentProcess(), 8, result) !== 0, "token is unavailable");
      const token = result.readBigUInt64LE();
      try {
        const owner = tokenUser(token);
        // The Windows SDK defines GetCurrentThreadEffectiveToken as (HANDLE)(LONG_PTR)-6.
        requireNative(owner.equals(tokenUser(0xfffffffffffffffan)), "effective user SID differs from the process");
        return owner;
      } finally {
        requireNative(kernel.CloseHandle(token) !== 0, "token could not be closed");
      }
    },
    volume(drive: string) {
      const out = Buffer.alloc(32768 * 2);
      requireNative(kernel.GetDriveTypeW(wide(`${drive}\\`)) === 3, "volume must be a local fixed drive");
      requireNative(kernel.QueryDosDeviceW(wide(drive), out, out.length / 2) !== 0, "drive mapping is unavailable");
      const device = out.toString("utf16le").split("\0", 1)[0];
      if (!device || !/^\\Device\\HarddiskVolume[0-9]+$/.test(device)) throw winCursorError("drive is redirected");
      out.fill(0);
      requireNative(
        kernel.GetVolumeNameForVolumeMountPointW(wide(`${drive}\\`), out, out.length / 2) !== 0,
        "volume GUID is unavailable",
      );
      const guid = out.toString("utf16le").split("\0", 1)[0];
      if (!guid || !/^\\\\\?\\Volume\{[0-9a-f-]{36}\}\\$/i.test(guid)) throw winCursorError("volume GUID is invalid");
      return { device: `${device}\\`, guid };
    },
    requireNtfs(handle: bigint) {
      const flags = Buffer.alloc(4);
      const name = Buffer.alloc(128);
      requireNative(
        kernel.GetVolumeInformationByHandleW(handle, null, 0, null, null, flags, name, name.length / 2) !== 0 &&
          name.toString("utf16le").split("\0", 1)[0] === "NTFS" &&
          (flags.readUInt32LE() & 0x80008) === 8,
        "volume lacks writable NTFS with persistent ACLs",
      );
    },
    open(options: Open): bigint | undefined {
      requireNative(options.root === 0n || basenameOnly(options.name), "relative name is invalid");
      const text = wide(options.name);
      const descriptorAt = Math.ceil((64 + text.length) / 8) * 8;
      // One pinned FFI argument owns the object attributes and every buffer they point into.
      const attrs = Buffer.alloc(descriptorAt + (options.descriptor?.length ?? 0));
      const base = BigInt(ffi.ptr(attrs));
      attrs.writeUInt32LE(48); // OBJECT_ATTRIBUTES
      attrs.writeBigUInt64LE(options.root, 8);
      attrs.writeBigUInt64LE(base + 48n, 16);
      attrs.writeUInt32LE(0x1040, 24); // OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE
      attrs.writeUInt16LE(text.length - 2, 48); // UNICODE_STRING
      attrs.writeUInt16LE(text.length, 50);
      attrs.writeBigUInt64LE(base + 64n, 56);
      text.copy(attrs, 64);
      if (options.descriptor) {
        attrs.writeBigUInt64LE(base + BigInt(descriptorAt), 32);
        options.descriptor.copy(attrs, descriptorAt);
      }
      const out = Buffer.alloc(8);
      const iosb = Buffer.alloc(16);
      const disposition = options.disposition ?? winFile.open;
      const flags = 0x20 | (options.directory ? 1 : 0x40) | (options.writeThrough ? 2 : 0);
      const status = nt.NtCreateFile(
        out,
        unsigned(options.access | winFile.sync),
        attrs,
        iosb,
        null,
        0,
        options.share,
        disposition,
        flags,
        null,
        0,
      );
      if (status === 0xc0000034 && disposition === winFile.open) return undefined; // STATUS_OBJECT_NAME_NOT_FOUND
      // STATUS_REPARSE_POINT_ENCOUNTERED from OBJ_DONT_REPARSE.
      if (status === 0xc000050b) throw winCursorError("encountered a reparse point");
      if (status !== 0 || out.readBigUInt64LE() === 0n) throw winCursorError("object could not be opened privately");
      return out.readBigUInt64LE();
    },
    inspect(handle: bigint, directory: boolean) {
      const attrs = info(handle, 9, 8); // FileAttributeTagInfo
      const stat = info(handle, 1, 24); // FileStandardInfo
      requireNative(
        kernel.GetFileType(handle) === 1 &&
          (attrs.readUInt32LE() & 0x400) === 0 &&
          attrs.readUInt32LE(4) === 0 &&
          stat.readUInt8(20) === 0 &&
          Boolean(stat.readUInt8(21)) === directory &&
          (directory || ((attrs.readUInt32LE() & 1) === 0 && stat.readUInt32LE(16) === 1)),
        "object is linked, redirected or not a private regular object",
      );
      if (!directory) {
        const streams = info(handle, 7, 4096); // FILE_STREAM_INFO
        requireNative(
          streams.readUInt32LE() === 0 &&
            streams.readUInt32LE(4) === 14 &&
            streams.toString("utf16le", 24, 38) === "::$DATA",
          "file has unexpected data streams",
        );
      }
      return info(handle, 18, 24); // FILE_ID_INFO: 64-bit volume ID and 128-bit file ID
    },
    name(handle: bigint) {
      const out = Buffer.alloc(32768 * 2);
      const length = kernel.GetFinalPathNameByHandleW(handle, out, out.length / 2, 1); // normalized, volume GUID
      requireNative(length > 0 && length < out.length / 2, "normalized object name is unavailable");
      return out.toString("utf16le", 0, length * 2);
    },
    descriptor(handle: bigint) {
      const out = Buffer.alloc(8);
      requireNative(
        security.GetSecurityInfo(handle, 1, 5, null, null, null, null, out) === 0,
        "owner and DACL are unavailable",
      );
      const pointer = out.readBigUInt64LE();
      if (!pointer) throw winCursorError("owner and DACL are unavailable");
      try {
        const size = security.GetSecurityDescriptorLength(pointer);
        requireNative(size >= 20 && size <= 0x20000, "security descriptor size is invalid");
        return Buffer.from(new Uint8Array(ffi.toArrayBuffer(pointer, 0, size)));
      } finally {
        requireNative(kernel.LocalFree(pointer) === 0n, "descriptor could not be freed");
      }
    },
    read(handle: bigint) {
      const length = info(handle, 1, 24).readBigInt64LE(8);
      requireNative(length >= 0n && length <= 0x7fffffffn, "file size is invalid");
      const out = Buffer.alloc(Number(length));
      const count = Buffer.alloc(4);
      if (out.length)
        requireNative(
          kernel.ReadFile(handle, out, out.length, count, null) !== 0 && count.readUInt32LE() === out.length,
          "file could not be read completely",
        );
      return out.toString("utf8");
    },
    write(handle: bigint, value: string) {
      const data = Buffer.from(value);
      const count = Buffer.alloc(4);
      requireNative(
        kernel.WriteFile(handle, data, data.length, count, null) !== 0 && count.readUInt32LE() === data.length,
        "temporary file could not be written completely",
      );
    },
    flush(handle: bigint) {
      requireNative(kernel.FlushFileBuffers(handle) !== 0, "file could not be flushed");
    },
    rename(handle: bigint, root: bigint, basename: string, replace: boolean) {
      requireNative(basenameOnly(basename), "replacement name is invalid");
      const name = Buffer.from(basename, "utf16le");
      const input = Buffer.alloc(24 + name.length); // sizeof(FILE_RENAME_INFO) plus FileNameLength
      input.writeUInt32LE(replace ? 3 : 0); // REPLACE_IF_EXISTS | POSIX_SEMANTICS
      input.writeBigUInt64LE(root, 8);
      input.writeUInt32LE(name.length, 16);
      name.copy(input, 20);
      requireNative(
        kernel.SetFileInformationByHandle(handle, 22, input, input.length) !== 0,
        "same-directory handle rename failed",
      );
    },
    remove(handle: bigint) {
      const input = Buffer.from([1, 0, 0, 0]);
      requireNative(
        kernel.SetFileInformationByHandle(handle, 4, input, input.length) !== 0,
        "private scratch file could not be removed",
      );
    },
  };
};

export const sid = (bytes: Buffer, offset: number) => {
  requireNative(Number.isSafeInteger(offset) && offset >= 0 && offset + 8 <= bytes.length, "SID offset is invalid");
  const count = bytes.readUInt8(offset + 1);
  const end = offset + 8 + count * 4;
  requireNative(bytes.readUInt8(offset) === 1 && count <= 15 && end <= bytes.length, "SID is invalid");
  return bytes.subarray(offset, end);
};

let loaded: ReturnType<typeof loadNative> | undefined;
export const telegramWin32Native = () => {
  if (process.platform !== "win32" || process.arch !== "x64") throw winCursorError("requires Windows x64");
  try {
    return (loaded ??= loadNative());
  } catch (error) {
    if (error instanceof MessengerError) throw error;
    throw winCursorError("native filesystem bindings are unavailable");
  }
};
