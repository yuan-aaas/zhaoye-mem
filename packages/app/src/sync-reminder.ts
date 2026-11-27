import { join } from 'node:path';
import { type ClockPort, SyncReminderStateSchema, ZhaoyeError } from '@zhaoye/contracts';
import { readJson, readText, writeAtomic } from '@zhaoye/storage';

const day = 86_400_000;

function reminderWindow(now: Date, timeZone: string, weekday: number) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const local = (date: Date) => {
    const parts = Object.fromEntries(
      format.formatToParts(date).map(({ type, value }) => [type, value]),
    );
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  };
  const today = local(now);
  const due = today - ((new Date(today).getUTCDay() - weekday + 7) % 7) * day;
  return { due, monday: due - ((weekday + 6) % 7) * day, local };
}

export function createSyncReminder(
  root: string,
  clock: ClockPort,
  assertOwner: () => Promise<void>,
) {
  const file = join(root, 'backup', 'reminder.json');
  let tail: Promise<unknown> = Promise.resolve();
  return function check(input: {
    timeZone: string;
    weekday: number;
    successes: Array<string | undefined>;
    claim?: boolean;
  }) {
    const job = tail.then(async () => {
      if (!input.successes.length) return null;
      if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6)
        throw new ZhaoyeError('INVALID_INPUT', '同步提醒星期应为 0（周日）到 6（周六）');
      const now = clock.now();
      const { due, monday, local } = reminderWindow(now, input.timeZone, input.weekday);
      const key = new Date(due).toISOString().slice(0, 10);
      const schedule = `${input.timeZone}:${input.weekday}`;
      let state =
        (await readText(file)) === null ? undefined : await readJson(file, SyncReminderStateSchema);
      async function save(value: NonNullable<typeof state>) {
        await assertOwner();
        await writeAtomic(file, `${JSON.stringify(value)}\n`);
      }
      if (state?.schedule !== schedule) {
        state = { schedule, enabledAt: now.toISOString() };
        await save(state);
      }
      if (
        state.shown === key ||
        due < local(new Date(state.enabledAt)) ||
        input.successes.every((value) => value && local(new Date(value)) >= monday)
      )
        return null;
      if (input.claim) await save({ ...state, shown: key });
      return key;
    });
    tail = job.catch(() => {});
    return job;
  };
}
