/**
 * Real-time pacing of owner audio on the WebRTC Opus track. The session hands over PCM at real time on average, padding
 * silence (zero samples) whenever it falls behind, but in bursts: the wake preroll, and whatever piled up during an
 * event-loop stall. The pacer releases one 20 ms frame per 20 ms of track time and keeps the latency it adds bounded:
 * - a late timer releases at most three overdue frames together;
 * - beyond 100 ms of backlog, padding frames are dropped from the stream and voiced frames go out 15% fast, so a
 *   backlog shrinks instead of accumulating stall after stall;
 * - after more than 40 ms without a frame, track time resumes from the last frame by the wall clock, so the RTP
 *   timestamp after a gap reflects it while frames fed in 40 ms batches stay contiguous.
 */

/** 20 ms of 48 kHz mono PCM16: one Opus frame. */
export const FRAME_BYTES = 1920;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = 960;
const MAX_BURST_MS = 40;
const BACKLOG_FRAMES = 5;
const CATCH_UP = 1.15;
/** More pending audio than this means the pacing upstream broke. */
const MAX_PENDING_BYTES = 250 * FRAME_BYTES;

export class TrackPacer {
  private pending: Buffer[] = [];
  private bytes = 0;
  /** When the next frame is due, in the caller's clock. */
  private next = Number.NEGATIVE_INFINITY;
  /** Track time in frames since the first frame; drives the RTP timestamp. */
  private slot = 0;
  /** Wall time up to which the frames sent so far cover the track; a later restart after an empty queue is a gap. */
  private coveredUntil = Number.NEGATIVE_INFINITY;
  private starved = false;

  /** False when the backlog would exceed 5 s. */
  push(pcm48: Buffer): boolean {
    if (this.bytes + pcm48.length > MAX_PENDING_BYTES) return false;
    if (pcm48.length) this.pending.push(pcm48);
    this.bytes += pcm48.length;
    return true;
  }

  backlogMs(): number {
    return (this.bytes / FRAME_BYTES) * FRAME_MS;
  }

  /** The frames due at `now`, each with its RTP timestamp. */
  take(now: number): { frame: Buffer; timestamp: number }[] {
    const out: { frame: Buffer; timestamp: number }[] = [];
    if (this.bytes < FRAME_BYTES) {
      this.starved = true;
      return out;
    }
    // Only a real gap advances track time past the frames sent: the queue ran empty for longer than the session's
    // feeding jitter. A late timer with audio still queued is not a gap.
    // Before the first frame there is no track time to resume from.
    if (this.starved && Number.isFinite(this.coveredUntil) && now - this.coveredUntil > MAX_BURST_MS)
      this.slot += Math.floor((now - this.coveredUntil) / FRAME_MS);
    this.starved = false;
    this.next = Math.max(this.next, now - MAX_BURST_MS);
    while (this.next <= now && this.bytes >= FRAME_BYTES) {
      let frame = this.shift();
      while (this.behind() && frame.every((byte) => byte === 0)) frame = this.shift();
      out.push({ frame, timestamp: (this.slot * SAMPLES_PER_FRAME) >>> 0 });
      this.slot++;
      this.coveredUntil = Math.max(this.coveredUntil, now) + FRAME_MS;
      this.next += this.behind() ? FRAME_MS / CATCH_UP : FRAME_MS;
    }
    return out;
  }

  private behind(): boolean {
    return this.bytes > BACKLOG_FRAMES * FRAME_BYTES;
  }

  private shift(): Buffer {
    const frame = Buffer.concat(this.pending, FRAME_BYTES);
    let left = FRAME_BYTES;
    while (left > 0) {
      const head = this.pending[0]!;
      if (head.length > left) {
        this.pending[0] = head.subarray(left);
        left = 0;
      } else {
        this.pending.shift();
        left -= head.length;
      }
    }
    this.bytes -= FRAME_BYTES;
    return frame;
  }
}
