import { Stats } from '../schemas/stats';

const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const ONLINE_PEAK_KEY = 'onlinePeak';

const onlineUsers = new Map<string, number>();
const onlineGuests = new Map<string, number>();

let peak: { count: number; at: Date } | null = null;

const prune = (map: Map<string, number>, now: number) => {
  for (const [key, timestamp] of map) {
    if (now - timestamp > ONLINE_WINDOW_MS) {
      map.delete(key);
    }
  }
};

const bumpPeak = async (total: number, now: number) => {
  if (!peak) {
    peak = (await Stats.findOne({ key: ONLINE_PEAK_KEY }).lean()) ?? {
      count: 0,
      at: new Date(now),
    };
  }
  if (total > peak.count) {
    peak = { count: total, at: new Date(now) };
    await Stats.updateOne(
      { key: ONLINE_PEAK_KEY },
      { count: total, at: peak.at },
      { upsert: true },
    );
  }
};

export const touch = (userId: string | null, ip: string) => {
  const now = Date.now();
  prune(onlineUsers, now);
  prune(onlineGuests, now);
  if (userId) {
    onlineUsers.set(userId, now);
  } else {
    onlineGuests.set(ip, now);
  }

  void bumpPeak(onlineUsers.size + onlineGuests.size, now);
};

export const getOnlineStats = async () => {
  const now = Date.now();
  prune(onlineUsers, now);
  prune(onlineGuests, now);

  return {
    users: onlineUsers.size,
    guests: onlineGuests.size,
    peakCount: peak?.count ?? 0,
    peakAt: peak?.at ?? null,
  };
};
