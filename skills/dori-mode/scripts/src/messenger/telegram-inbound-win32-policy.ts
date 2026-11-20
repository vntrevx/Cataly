import { winCursorError } from "./telegram-inbound-win32-ffi.ts";
import { sid, winFile as f } from "./telegram-inbound-win32-native.ts";

const protectedDacl = 0x1000;
const selfRelative = 0x8000;
const daclPresent = 4;
const systemSid = Buffer.from("010100000000000512000000", "hex");
const adminsSid = Buffer.from("01020000000000052000000020020000", "hex");
const badDirectory = () => winCursorError("directory must be private and owned by this user");

export const statePath = (input: string) => {
  const drive = input.slice(0, 2);
  const parts = input.slice(3).split("\\");
  const invalidPart = (part: string) =>
    !part ||
    part.length > 255 ||
    /[<>:"/|?*]/.test(part) ||
    Array.from(part).some((char) => char.charCodeAt(0) < 0x20) ||
    /[ .]$/.test(part) ||
    /^(?:CON|CONIN\$|CONOUT\$|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:[ .]|$)/i.test(part);
  if (!/^[a-z]:$/i.test(drive) || input[2] !== "\\" || parts.some(invalidPart)) {
    throw winCursorError("requires a canonical absolute drive path for state");
  }
  return { drive, parts };
};

// SECURITY_DESCRIPTOR_RELATIVE with an owner SID and one non-inheriting ACCESS_ALLOWED_ACE (FILE_ALL_ACCESS).
export const privateDescriptor = (owner: Buffer) => {
  const dacl = 20 + owner.length;
  const out = Buffer.alloc(dacl + 16 + owner.length);
  out.writeUInt8(1, 0);
  out.writeUInt16LE(selfRelative | protectedDacl | daclPresent, 2);
  out.writeUInt32LE(20, 4);
  out.writeUInt32LE(dacl, 16);
  owner.copy(out, 20);
  out.writeUInt8(2, dacl); // ACL_REVISION
  out.writeUInt16LE(16 + owner.length, dacl + 2);
  out.writeUInt16LE(1, dacl + 4);
  out.writeUInt16LE(8 + owner.length, dacl + 10);
  out.writeUInt32LE(f.allAccess, dacl + 12);
  owner.copy(out, dacl + 16);
  return out;
};

export const verifyDescriptor = (sd: Buffer, owner: Buffer, exact: boolean) => {
  const control = sd.readUInt16LE(2);
  const ownerAt = sd.readUInt32LE(4);
  const dacl = sd.readUInt32LE(16);
  if (
    sd.readUInt8() !== 1 ||
    (control & (selfRelative | daclPresent)) !== (selfRelative | daclPresent) ||
    ownerAt < 20 ||
    !sid(sd, ownerAt).equals(owner) ||
    dacl < 20 ||
    dacl + 8 > sd.length ||
    (exact && (control & protectedDacl) === 0)
  )
    throw badDirectory();
  const revision = sd.readUInt8(dacl);
  const count = sd.readUInt16LE(dacl + 4);
  const end = dacl + sd.readUInt16LE(dacl + 2);
  if ((revision !== 2 && revision !== 4) || end < dacl + 8 || end > sd.length || count === 0 || (exact && count !== 1))
    throw badDirectory();
  let offset = dacl + 8;
  for (let i = 0; i < count; i++) {
    if (offset + 16 > end || sd.readUInt8(offset) !== 0) throw badDirectory(); // ACCESS_ALLOWED_ACE only
    const next = offset + sd.readUInt16LE(offset + 2);
    if (next < offset + 16 || next > end) throw badDirectory();
    const trustee = sid(sd.subarray(0, next), offset + 8);
    if (
      offset + 8 + trustee.length !== next ||
      (exact && (sd.readUInt8(offset + 1) !== 0 || sd.readUInt32LE(offset + 4) !== f.allAccess))
    )
      throw badDirectory();
    if (!trustee.equals(owner) && (exact || (!trustee.equals(systemSid) && !trustee.equals(adminsSid))))
      throw badDirectory();
    offset = next;
  }
};
