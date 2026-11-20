import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { MessengerError } from "./http.ts";
import { winCursorError, withNativeCleanup } from "./telegram-inbound-win32-ffi.ts";
import { telegramWin32Native, winFile as f } from "./telegram-inbound-win32-native.ts";
import { privateDescriptor, statePath, verifyDescriptor } from "./telegram-inbound-win32-policy.ts";
import { TerminalTelegramCursorError } from "./telegram-inbound.ts";

const directoryAccess = f.control | f.traverse | f.attributes;
const directoryShare = f.shareRead | f.shareWrite;
const existingShare = f.shareRead | f.shareDelete;
const fileAccess = (f.read | f.delete) >>> 0;
const stageAccess = (fileAccess | f.write) >>> 0;
const missing = () => winCursorError("directory is missing; provision the configured state directory first");

const generated = () => `.dori-${randomUUID()}.tmp`;

export const windowsTelegramCursor = (stateDir: string, bot: string) => {
  const path = win32.join(stateDir, "telegram-inbound", `${bot}.json`);
  const native = telegramWin32Native();
  const dirs: bigint[] = [];
  let lease: bigint | undefined;
  let fault: TerminalTelegramCursorError | undefined;
  let closed = false;
  const closeAll = (handles: bigint[]) => {
    let failure: unknown;
    for (const handle of handles.reverse()) {
      try {
        native.close(handle);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) throw failure;
  };
  const close = () => {
    closed = true;
    const handles = dirs.splice(0);
    if (lease !== undefined) handles.push(lease);
    lease = undefined;
    try {
      closeAll(handles);
    } catch (error) {
      if (!fault) throw error;
    }
  };
  const operation = <T>(fn: () => T): T => {
    if (fault) throw fault;
    if (closed) throw winCursorError("store is closed");
    try {
      return fn();
    } catch (error) {
      // A failed save may already have published. Prevent every later poll from loading an unverified cursor.
      const reason = error instanceof MessengerError ? error : winCursorError("native storage operation failed");
      fault = new TerminalTelegramCursorError(reason, error);
      throw fault;
    }
  };

  const bind = () => {
    const { drive, parts } = statePath(stateDir);
    const volume = native.volume(drive);
    const owner = native.user();
    const descriptor = privateDescriptor(owner);
    let canonical = volume.guid;
    const pin = (handle: bigint | undefined, expected: string, volumeRoot = false) => {
      if (handle === undefined) throw missing();
      dirs.push(handle);
      const id = native.inspect(handle, true);
      const name = native.name(handle);
      if (volumeRoot ? name.toLowerCase() !== expected.toLowerCase() : name !== expected)
        throw winCursorError("object name is aliased or redirected");
      return { handle, id, name };
    };
    let parent = pin(
      native.open({ root: 0n, name: volume.device, access: directoryAccess, share: directoryShare, directory: true }),
      canonical,
      true,
    );
    canonical = parent.name;
    native.requireNtfs(parent.handle);
    const volumeId = parent.id.readBigUInt64LE();
    for (const part of parts) {
      canonical += canonical.endsWith("\\") ? part : `\\${part}`;
      parent = pin(
        native.open({
          root: parent.handle,
          name: part,
          access: directoryAccess,
          share: directoryShare,
          directory: true,
        }),
        canonical,
      );
      if (parent.id.readBigUInt64LE() !== volumeId) throw winCursorError("directory changed volume");
    }
    verifyDescriptor(native.descriptor(parent.handle), owner, false);
    canonical += "\\telegram-inbound";
    const directory = pin(
      native.open({
        root: parent.handle,
        name: "telegram-inbound",
        access: directoryAccess,
        share: directoryShare,
        directory: true,
        disposition: f.openOrCreate,
        descriptor,
      }),
      canonical,
    );
    if (directory.id.readBigUInt64LE() !== volumeId) throw winCursorError("private directory changed volume");
    verifyDescriptor(native.descriptor(directory.handle), owner, true);
    return { root: directory.handle, canonical, descriptor, owner, volumeId };
  };
  const backend = (() => {
    try {
      return operation(bind);
    } catch (error) {
      close();
      throw error;
    }
  })();

  const verifyFile = (handle: bigint, name: string) => {
    const id = native.inspect(handle, false);
    if (id.readBigUInt64LE() !== backend.volumeId || native.name(handle) !== `${backend.canonical}\\${name}`)
      throw winCursorError("file is aliased, redirected or outside the private directory");
    verifyDescriptor(native.descriptor(handle), backend.owner, true);
    return id;
  };
  const open = (name: string) => native.open({ root: backend.root, name, access: fileAccess, share: existingShare });
  const withFile = <T>(handle: bigint, action: () => T) => withNativeCleanup(action, () => native.close(handle));
  const cursor = `${bot}.json`;
  const acquire = () => {
    if (lease !== undefined) return;
    const name = `${bot}.lock`;
    const handle = native.open({
      root: backend.root,
      name,
      access: f.read,
      share: 0,
      disposition: f.openOrCreate,
      descriptor: backend.descriptor,
    });
    if (handle === undefined) throw winCursorError("lease is unavailable");
    lease = handle;
    verifyFile(handle, name);
  };

  const publish = (name: string, value: string, probeIds?: Buffer[]) => {
    const expected = probeIds?.at(-1);
    const handles: bigint[] = [];
    let staged: bigint | undefined;
    let renameAttempted = false;
    withNativeCleanup(
      () => {
        const previous = probeIds && !expected ? undefined : open(name);
        if (previous !== undefined) {
          handles.push(previous);
          const id = verifyFile(previous, name);
          if (expected && !id.equals(expected)) throw winCursorError("scratch file identity changed");
        } else if (expected) throw winCursorError("scratch file disappeared");
        const pending = generated();
        staged = native.open({
          root: backend.root,
          name: pending,
          access: stageAccess,
          share: existingShare,
          disposition: f.create,
          descriptor: backend.descriptor,
          writeThrough: true,
        });
        if (staged === undefined) throw winCursorError("temporary file is unavailable");
        handles.push(staged);
        const id = verifyFile(staged, pending);
        native.write(staged, value);
        native.flush(staged);
        // Even an uncertain rename may have published this particular probe object.
        if (probeIds) probeIds.push(id);
        renameAttempted = true;
        native.rename(staged, backend.root, name, previous !== undefined);
        // File flushing covers file metadata, not proven power-loss parity for the NTFS namespace.
        native.flush(staged);
        const final = native.open({
          root: backend.root,
          name,
          access: f.read,
          share: f.shareRead | f.shareWrite | f.shareDelete,
        });
        if (final === undefined) throw winCursorError("published file is missing");
        handles.push(final);
        if (!verifyFile(final, name).equals(id) || (probeIds && native.read(final) !== value))
          throw winCursorError("published file could not be verified");
      },
      () =>
        withNativeCleanup(
          () => {
            // After a rename attempt the staging handle may name the actual cursor. Never remove it here.
            if (staged !== undefined && !renameAttempted) native.remove(staged);
          },
          () => closeAll(handles),
        ),
    );
  };
  const use = <T>(fn: () => T): T =>
    operation(() => {
      acquire();
      return fn();
    });
  return {
    path,
    close,
    checkWritable: () =>
      use(() => {
        const actual = open(cursor);
        if (actual !== undefined) withFile(actual, () => verifyFile(actual, cursor));
        const scratch = generated();
        const ids: Buffer[] = [];
        withNativeCleanup(
          () => {
            publish(scratch, "first", ids);
            publish(scratch, "replace", ids);
          },
          () => {
            if (!ids.length) return;
            const handle = open(scratch);
            if (handle === undefined) return;
            withFile(handle, () => {
              const id = verifyFile(handle, scratch);
              if (!ids.some((created) => created.equals(id))) throw winCursorError("scratch file identity changed");
              native.remove(handle);
            });
          },
        );
      }),
    read: () =>
      use(() => {
        const handle = open(cursor);
        if (handle === undefined) return undefined;
        return withFile(handle, () => {
          verifyFile(handle, cursor);
          return native.read(handle);
        });
      }),
    write: (value: string) => use(() => publish(cursor, value)),
  };
};
