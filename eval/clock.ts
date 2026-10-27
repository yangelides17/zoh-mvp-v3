/** The eval's clock: starts at a scenario's local time and moves forward as people text. */
export class EvalClock {
  private ms: number;
  constructor(start: Date) {
    this.ms = start.getTime();
  }
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
  /** Moves to an instant; never backwards. */
  set(at: Date): void {
    this.ms = Math.max(this.ms, at.getTime());
  }
}

/** All runs happen on the same ordinary weekday, so results don't drift with the calendar. */
export const EVAL_DAY = "2026-11-02";

/** The instant that is `hhmm` on `day` in time zone `timeZone`. */
export function zonedDate(day: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const wanted = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset even across a DST change.
  let guess = wanted;
  for (let i = 0; i < 2; i++) guess = wanted - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

function offsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** "11:05 pm" in the given zone, for transcripts. */
export function localTime(at: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .format(new Date(at))
    .toLowerCase();
}
