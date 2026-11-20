import type * as BunFfi from "bun:ffi";

import { MessengerError } from "./http.ts";

// Only Windows x64 is admitted. HANDLE and pointer fields are 64 bits, Win32 BOOL/NTSTATUS are 32 bits.
export const winCursorError = (stage: string) =>
  new MessengerError(`Telegram inbound cursor ${stage}; use private state on local writable NTFS`, 0);

export const requireNative = (ok: boolean, stage: string): void => {
  if (!ok) throw winCursorError(stage);
};

/** Release native resources without masking the operation error with a cleanup error. */
export const withNativeCleanup = <T>(action: () => T, cleanup: () => void): T => {
  let result: T;
  try {
    result = action();
  } catch (error) {
    try {
      cleanup();
    } catch {
      throw error; // Preserve the original operation error even when cleanup also fails.
    }
    throw error;
  }
  cleanup();
  return result;
};

export const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");

export const sidOffset = (result: Buffer, address: bigint, written: number) => {
  // Windows x64 TOKEN_USER is a SID_AND_ATTRIBUTES with a leading PSID in a 16-byte header.
  const headerSize = 16;
  requireNative(
    Number.isInteger(written) && written >= headerSize && written <= result.length,
    "TOKEN_USER byte count is invalid",
  );
  const offset = result.readBigUInt64LE() - address;
  requireNative(
    offset >= BigInt(headerSize) && offset <= BigInt(written - 8),
    "TOKEN_USER SID pointer is out of range",
  );
  return Number(offset);
};

export const loadWindowsCursorFfi = () => {
  const ffi: typeof BunFfi = require("bun:ffi");
  // Kernel32 is already loaded into the process. Resolve the other DLLs from its system directory, not PATH/cwd.
  const kernel = ffi.dlopen("kernel32.dll", {
    CloseHandle: { args: ["u64"], returns: "i32" },
    FlushFileBuffers: { args: ["u64"], returns: "i32" },
    GetCurrentProcess: { args: [], returns: "u64" },
    GetDriveTypeW: { args: ["ptr"], returns: "u32" },
    GetFileInformationByHandleEx: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
    GetFileType: { args: ["u64"], returns: "u32" },
    GetFinalPathNameByHandleW: { args: ["u64", "ptr", "u32", "u32"], returns: "u32" },
    GetSystemDirectoryW: { args: ["ptr", "u32"], returns: "u32" },
    GetVolumeInformationByHandleW: {
      args: ["u64", "ptr", "u32", "ptr", "ptr", "ptr", "ptr", "u32"],
      returns: "i32",
    },
    GetVolumeNameForVolumeMountPointW: { args: ["ptr", "ptr", "u32"], returns: "i32" },
    LocalFree: { args: ["u64"], returns: "u64" },
    QueryDosDeviceW: { args: ["ptr", "ptr", "u32"], returns: "u32" },
    ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    SetFileInformationByHandle: { args: ["u64", "u32", "ptr", "u32"], returns: "i32" },
    WriteFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
  }).symbols;
  const path = Buffer.alloc(1024);
  const size = kernel.GetSystemDirectoryW(path, path.length / 2);
  requireNative(size > 0 && size < path.length / 2, "system DLL directory is unavailable");
  const system = path.toString("utf16le", 0, size * 2);
  const security = ffi.dlopen(`${system}\\advapi32.dll`, {
    GetSecurityDescriptorLength: { args: ["u64"], returns: "u32" },
    GetSecurityInfo: { args: ["u64", "u32", "u32", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
    GetTokenInformation: { args: ["u64", "u32", "ptr", "u32", "ptr"], returns: "i32" },
    OpenProcessToken: { args: ["u64", "u32", "ptr"], returns: "i32" },
  }).symbols;
  const nt = ffi.dlopen(`${system}\\ntdll.dll`, {
    NtCreateFile: {
      args: ["ptr", "u32", "ptr", "ptr", "ptr", "u32", "u32", "u32", "u32", "ptr", "u32"],
      returns: "u32",
    },
  }).symbols;

  return { ffi, kernel, security, nt };
};
